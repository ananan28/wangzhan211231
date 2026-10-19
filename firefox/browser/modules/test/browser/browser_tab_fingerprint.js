/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

add_task(async function tab_fingerprint_keys_and_reload_toggle() {
  const { SessionStore } = ChromeUtils.importESModule(
    "resource:///modules/sessionstore/SessionStore.sys.mjs"
  );
  const nativeKeys = new Map();
  const rfp = Cc["@mozilla.org/rfp-service;1"].getService(Ci.nsIRFPService);
  const observe = subject => {
    const channel = subject.QueryInterface(Ci.nsIChannel);
    if (channel.loadInfo.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT ||
        channel.URI.host !== "example.com") {
      return;
    }
    const bc = channel.loadInfo.browsingContext;
    if (bc) {
      nativeKeys.set(bc.top.id, Array.from(rfp.testGenerateRandomKey(channel)).join(","));
    }
  };
  Services.obs.addObserver(observe, "http-on-modify-request");
  registerCleanupFunction(() => Services.obs.removeObserver(observe, "http-on-modify-request"));
  const url = "https://example.com/";
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  registerCleanupFunction(() => {
    BrowserTestUtils.removeTab(a);
    BrowserTestUtils.removeTab(b);
  });
  const key = "tab-fingerprint-v1";
  const read = tab => JSON.parse(SessionStore.getCustomTabValue(tab, key));
  const original = read(a);
  const other = read(b);
  const aNative = nativeKeys.get(a.linkedBrowser.browsingContext.id);
  const bNative = nativeKeys.get(b.linkedBrowser.browsingContext.id);
  ok(aNative && bNative, "Native RFP generated document keys for both tabs");
  isnot(aNative, bNative, "Native HMAC keys differ even in the same cookie container");
  const actual = await SpecialPowers.spawn(a.linkedBrowser, [], () => ({
    language: content.navigator.language,
    timezone: content.Intl.DateTimeFormat().resolvedOptions().timeZone,
    width: content.screen.width,
    height: content.screen.height,
  }));
  is(actual.language, original.language, "Native language override reaches content");
  is(actual.timezone, original.timezone, "Native timezone override reaches content");
  is(actual.width, original.width, "Native screen width override reaches content");
  is(actual.height, original.height, "Native screen height override reaches content");
  ok(!original.rotateOnReload, "Refresh rotation defaults to off");
  isnot(original.seed, other.seed, "Different tabs get different seeds");
  is(a.linkedBrowser.browsingContext.fingerprintSeed, original.seed,
    "Native browsing context receives the persisted tab key");
  await BrowserTestUtils.reloadTab(a);
  is(read(a).seed, original.seed, "Ordinary reload retains a fixed fingerprint");
  is(nativeKeys.get(a.linkedBrowser.browsingContext.id), aNative,
    "Fixed native HMAC survives a reload");

  // Exercise the same command used by the checkbox, rather than changing
  // SessionStore behind the controller's in-memory state.
  const menu = document.getElementById("tabContextMenu");
  const item = document.getElementById("tab-fingerprint-rotate");
  ok(item, "Per-tab toggle is present");
  TabContextMenu.contextTab = a;
  item.dispatchEvent(new Event("command"));
  ok(read(a).rotateOnReload, "Command enables rotation for this tab");
  gBrowser.selectedTab = a;
  const reloaded = BrowserTestUtils.browserLoaded(a.linkedBrowser);
  BrowserCommands.reload();
  await reloaded;
  isnot(read(a).seed, original.seed, "Enabled reload rotates this tab's key");
  isnot(nativeKeys.get(a.linkedBrowser.browsingContext.id), aNative,
    "Enabled reload changes the native RFP HMAC key");
  is(read(b).seed, other.seed, "Other tab key stays unchanged");
  const beforeScriptReload = read(a).seed;
  const scriptReloaded = BrowserTestUtils.browserLoaded(a.linkedBrowser);
  await SpecialPowers.spawn(a.linkedBrowser, [], () => content.location.reload());
  await scriptReloaded;
  isnot(read(a).seed, beforeScriptReload, "Page-script reload rotates via the parent hook");

  item.dispatchEvent(new Event("command"));
  const frozen = read(a).seed;
  await BrowserTestUtils.reloadTab(a);
  is(read(a).seed, frozen, "Disabling rotation freezes the current key");
  ok(menu.contains(item), "Toggle stays in the tab context menu");
});

add_task(async function shared_worker_partition_uses_document_key() {
  const url = "https://example.com/";
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  try {
    const connect = tab => SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const worker = new content.SharedWorker(
        "https://example.com/browser/browser/modules/test/browser/tab_fingerprint_shared_worker.js",
        "tab-fingerprint-isolation"
      );
      content.fingerprintTestWorkers ??= [];
      content.fingerprintTestWorkers.push(worker);
      return new Promise((resolve, reject) => {
        worker.onerror = () => reject(new Error("SharedWorker failed to load"));
        worker.port.onmessage = event => resolve(event.data);
      });
    });
    const first = await connect(a);
    is(await connect(a), first, "Same document still shares its named worker");
    isnot(await connect(b), first,
      "Different tab document keys cannot attach to the same shared worker");
  } finally {
    BrowserTestUtils.removeTab(a);
    BrowserTestUtils.removeTab(b);
  }
});
