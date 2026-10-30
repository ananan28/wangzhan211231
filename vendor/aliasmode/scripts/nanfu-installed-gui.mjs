import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const reportDir = process.env.NANFU_GUI_REPORT_DIR;
if (!reportDir) throw new Error("NANFU_GUI_REPORT_DIR is required");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Installed acceptance may restart only its GitHub Actions fixture");
await mkdir(reportDir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "nanfu-extension-fixture-"));
const extensionName = "Nanfu synthetic offline MV3";
const profileName = "Nanfu GUI acceptance";
const wasmBytes = 26 * 1024 * 1024;
const modelBytes = 89 * 1024 * 1024;
const report = { stages: [], consoleErrors: [], pageErrors: [], modelInferenceTested: false };
let manager;
let page;
const openProfiles = new Map();
let profileId;
let origin;
const fixtureUserId = "11111111-1111-4111-8111-111111111111";
const fixtureOrgId = "22222222-2222-4222-8222-222222222222";
const fixtureEmail = "gui-fixture@nanfu.local";
const fixturePassword = "Fixture123";
const fixtureAccess = "synthetic-installed-access-token";
const fixtureRefresh = "synthetic-installed-refresh-token";
const fixtureUser = { id: fixtureUserId, email: fixtureEmail, email_confirmed_at: "2026-10-30T00:00:00Z" };

async function restartAgainstFixture() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $env:NANFU_GUI_REPORT_DIR 'tauri.pid'
$appPid = [int](Get-Content -LiteralPath $pidFile)
$appPath = Join-Path $env:NANFU_INSTALL_ROOT 'aliasmode.exe'
$app = Get-Process -Id $appPid -ErrorAction Stop
if ([IO.Path]::GetFullPath($app.Path) -ne [IO.Path]::GetFullPath($appPath)) { throw 'Refusing to stop an unrelated process' }
& taskkill.exe /PID $appPid /T /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the initial acceptance process tree' }
if (-not $app.WaitForExit(15000)) { throw 'Initial acceptance desktop did not exit' }
$restarted = Start-Process -FilePath $appPath -PassThru -RedirectStandardOutput (Join-Path $env:NANFU_GUI_REPORT_DIR 'fixture-tauri-stdout.log') -RedirectStandardError (Join-Path $env:NANFU_GUI_REPORT_DIR 'fixture-tauri-stderr.log')
$restarted.Id | Set-Content -LiteralPath $pidFile
`;
  await promisify(execFile)("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { timeout: 45000, windowsHide: true, env: {
    ...process.env, NANFU_SUPABASE_URL: origin, NANFU_SUPABASE_KEY: "sb_publishable_synthetic_installed_fixture_12345",
  } });
}

async function connectDesktop(label) {
  const browser = await waitFor(async () => {
    try { return await chromium.connectOverCDP(process.env.NANFU_INSTALLED_CDP ?? "http://127.0.0.1:9223", { timeout: 3000 }); }
    catch { return null; }
  }, label);
  const shell = await waitFor(() => browser.contexts().flatMap(context => context.pages()).find(item => /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url())), `${label} page`);
  shell.setDefaultTimeout(60000);
  shell.on("pageerror", error => report.pageErrors.push(error.message));
  shell.on("console", message => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
  shell.on("dialog", dialog => dialog.accept());
  return { browser, page: shell };
}

/** Walk the mandatory sign-in gate with the synthetic account this run serves. */
async function signInThroughGate() {
  await page.locator("#nanfu-gate-title").waitFor();
  await page.getByLabel("登录名或邮箱").fill("合成验收账号");
  await page.getByLabel("密码").fill(fixturePassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".sidenav").waitFor();
}

async function waitFor(check, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
}

async function verifyNativeWindowLifecycle() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NanfuWindow {
  private delegate bool EnumCallback(IntPtr handle, IntPtr unused);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr unused);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint owner);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  public static IntPtr Find(uint processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((handle, unused) => {
      uint owner;
      GetWindowThreadProcessId(handle, out owner);
      if (owner != processId || !IsWindowVisible(handle)) return true;
      found = handle;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$appPid = [int](Get-Content -LiteralPath (Join-Path $env:NANFU_GUI_REPORT_DIR 'tauri.pid'))
$appPath = Join-Path $env:NANFU_INSTALL_ROOT 'aliasmode.exe'
$app = Get-Process -Id $appPid -ErrorAction Stop
$sidecars = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $appPid" | Where-Object { $_.Name -like 'aliasmode-sidecar*.exe' })
if ($sidecars.Count -ne 1) { throw 'Expected one installed sidecar before window lifecycle test' }
$sidecarPid = [int]$sidecars[0].ProcessId
$window = [NanfuWindow]::Find([uint32]$appPid)
if ($window -eq [IntPtr]::Zero) { throw 'Installed main window is not visible' }
function Assert-WindowState([bool]$visible) {
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $app.Refresh()
    if ($app.HasExited -or -not (Get-Process -Id $sidecarPid -ErrorAction SilentlyContinue)) {
      throw 'Window action terminated the desktop or sidecar'
    }
    if ([NanfuWindow]::IsWindowVisible($window) -eq $visible -and (-not $visible -or -not [NanfuWindow]::IsIconic($window))) { return }
    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Installed window did not reach visible=$visible"
}
function Restore-ExistingWindow {
  $second = Start-Process -FilePath $appPath -PassThru
  if (-not $second.WaitForExit(15000)) { throw 'Second launch did not return to the existing desktop' }
  if ($second.ExitCode -ne 0) { throw 'Second launch failed to restore the existing desktop' }
  Assert-WindowState $true
}
if (-not [NanfuWindow]::PostMessage($window, 0x0112, [IntPtr]0xF020, [IntPtr]::Zero)) { throw 'Minimize request failed' }
Assert-WindowState $false
Restore-ExistingWindow
if (-not [NanfuWindow]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Close request failed' }
Assert-WindowState $false
Restore-ExistingWindow
@{ minimizedToTray=$true; closedToTray=$true; restoredExistingWindow=$true; sidecarStayedAlive=$true } | ConvertTo-Json -Compress
`;
  const { stdout } = await promisify(execFile)("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { timeout: 90000, windowsHide: true });
  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result, {
    minimizedToTray: true, closedToTray: true, restoredExistingWindow: true, sidecarStayedAlive: true,
  });
  return result;
}

function storedZip(files) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let n = i;
    for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    table[i] = n >>> 0;
  }
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [path, value] of Object.entries(files)) {
    const name = Buffer.from(path);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    central.push(entry);
    chunks.push(local, data);
    offset += local.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

async function stage(name, target = page) {
  report.stages.push(name);
  console.log(`installed GUI: ${name}`);
  await target.screenshot({ path: join(reportDir, `${report.stages.length}-${name}.png`) });
}

async function api(path) {
  return page.evaluate(async path => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Read API failed: ${response.status}`);
    return response.json();
  }, path);
}

async function upload(path) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload ZIP/CRX", exact: true }).click();
  await chooser;
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: 'input[type="file"][accept=".zip,.crx,application/zip,application/x-chrome-extension"]',
    });
    assert.notEqual(nodeId, 0, "Extension file input must exist");
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [path] });
  } finally {
    await cdp.detach();
  }
}

async function openProfile(profile = { id: profileId, name: profileName }, expectExtension = true) {
  await page.getByRole("button", { name: "All profiles", exact: false }).click();
  const opened = page.waitForResponse(response => response.url().endsWith(`/profiles/${profile.id}/open`) && response.request().method() === "POST", { timeout: 240000 });
  await page.getByRole("button", { name: `Open ${profile.name}`, exact: true }).click();
  const response = await opened;
  const result = await response.json();
  assert.equal(response.ok(), true, JSON.stringify(result));
  assert.equal(result.ok, true, JSON.stringify(result));
  openProfiles.set(profile.id, profile);
  const active = await api(`/api/v1/browser/active?user_id=${encodeURIComponent(profile.id)}`);
  assert.equal(active.data.status, "Active");
  assert.ok(active.data.ws?.puppeteer, JSON.stringify(active));
  const browser = await chromium.connectOverCDP(active.data.ws.puppeteer);
  const context = browser.contexts()[0];
  const probe = context.pages().find(item => item.url().startsWith(origin)) ?? await context.newPage();
  await probe.goto(`${origin}/probe`);
  if (expectExtension) {
    const output = probe.locator("#nanfu-extension-proof");
    await output.waitFor({ timeout: 120000 });
    const proof = JSON.parse(await output.textContent());
    assert.deepEqual(proof, { wasmBytes, modelBytes, modelFirst: 90, modelLast: 90, compiled: true, offscreen: true });
    report.resourceProof = proof;
  }
  return probe;
}

async function closeProfile(profile = { id: profileId, name: profileName }) {
  await page.getByRole("button", { name: "All profiles", exact: false }).click();
  const closed = page.waitForResponse(response => response.url().endsWith(`/profiles/${profile.id}/close`) && response.request().method() === "POST", { timeout: 120000 });
  await page.getByRole("button", { name: `Close ${profile.name}`, exact: true }).click();
  const response = await closed;
  const result = await response.json();
  assert.equal(result.ok, true, JSON.stringify(result));
  const active = await api(`/api/v1/browser/active?user_id=${encodeURIComponent(profile.id)}`);
  assert.equal(active.data.status, "Inactive");
  openProfiles.delete(profile.id);
}

async function isolationState(target, value) {
  return target.evaluate(async value => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("nanfu-installed-isolation", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const indexed = await new Promise((resolve, reject) => {
        const transaction = db.transaction("state", "readonly");
        const request = transaction.objectStore("state").get("owner");
        transaction.oncomplete = () => resolve(request.result ?? null);
        transaction.onabort = () => reject(transaction.error);
      });
      const cache = await caches.open("nanfu-installed-isolation");
      const cached = await cache.match("/isolation-owner");
      const previous = {
        local: localStorage.getItem("isolation-owner"),
        cookie: document.cookie.split("; ").find(item => item.startsWith("isolation-owner=")) ?? null,
        indexed,
        cached: cached ? await cached.text() : null,
      };
      if (value !== undefined) {
        localStorage.setItem("isolation-owner", value);
        document.cookie = `isolation-owner=${value}; Path=/; Max-Age=86400; SameSite=Lax`;
        await new Promise((resolve, reject) => {
          const transaction = db.transaction("state", "readwrite");
          transaction.objectStore("state").put(value, "owner");
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
        });
        await cache.put("/isolation-owner", new Response(value));
      }
      return previous;
    } finally {
      db.close();
    }
  }, value);
}

async function identityState(target) {
  const identity = await target.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200; canvas.height = 60;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#12ac84"; ctx.fillRect(3, 2, 194, 54);
    ctx.font = "17px sans-serif"; ctx.fillStyle = "#421ec9";
    ctx.fillText("Nanfu canvas sample 0123456789", 5, 30);
    const headers = await fetch("/headers").then(response => response.json());
    const workerUrl = URL.createObjectURL(new Blob([
      "postMessage({ua:navigator.userAgent,platform:navigator.platform})",
    ], { type: "text/javascript" }));
    const worker = new Worker(workerUrl);
    try {
      const observed = await new Promise((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(new Error(event.message));
      });
      return { canvas: canvas.toDataURL(), ua: navigator.userAgent, platform: navigator.platform, headerUa: headers.ua, worker: observed };
    } finally {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    }
  });
  assert.match(identity.ua, /Chrome\//);
  assert.equal(identity.headerUa, identity.ua);
  assert.deepEqual(identity.worker, { ua: identity.ua, platform: identity.platform });
  return identity;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const json = (value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (url.pathname.startsWith("/auth/v1/") || url.pathname.startsWith("/rest/v1/")) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (url.pathname === "/rest/v1/rpc/nanfu_login_resolve") {
      json(body.p_name === "合成验收账号" ? fixtureEmail : null);
      return;
    }
    if (url.pathname === "/auth/v1/token") {
      const valid = url.searchParams.get("grant_type") === "refresh_token"
        ? body.refresh_token === fixtureRefresh
        : body.email === fixtureEmail && body.password === fixturePassword;
      if (!valid) { json({ message: "Invalid synthetic credentials" }, 400); return; }
      json({ access_token: fixtureAccess, refresh_token: fixtureRefresh, expires_in: 3600, user: fixtureUser });
      return;
    }
    if (request.headers.authorization !== `Bearer ${fixtureAccess}`) { json({}, 401); return; }
    if (url.pathname === "/auth/v1/user") { json(fixtureUser); return; }
    if (url.pathname === "/auth/v1/logout") { response.writeHead(204).end(); return; }
    if (url.pathname === "/rest/v1/rpc/nanfu_org_me") {
      json([{ org_id: fixtureOrgId, identity: "owner", role_name: "所有者", permissions: [], env_quota: 100, used: 0, status: "active", locked: false }]);
      return;
    }
    if (url.pathname === "/rest/v1/rpc/nanfu_org_self_join") { json(fixtureOrgId); return; }
    if (url.pathname === "/rest/v1/nanfu_orgs") { json([{ id: fixtureOrgId, name: "合成验收组织" }]); return; }
    if (url.pathname === "/rest/v1/rpc/nanfu_login_name_me") { json("合成验收账号"); return; }
    if (url.pathname === "/rest/v1/nanfu_environments" && request.method === "GET") { json([]); return; }
    (report.unexpectedFixtureRequests ??= []).push(`${request.method} ${url.pathname}`);
    json({}, 404);
    return;
  }
  if (request.url === "/headers") {
    json({ ua: request.headers["user-agent"] });
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end('<!doctype html><title>Nanfu controlled extension test</title><h1>Offline extension verification</h1><button id="interaction">Click me</button><output id="clicked"></output><script>document.querySelector("button").onclick=()=>document.querySelector("#clicked").textContent="clicked"</script>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;

try {
  const wasm = Buffer.alloc(wasmBytes);
  wasm.set([0, 97, 115, 109, 1, 0, 0, 0, 0]);
  let length = wasmBytes - 13;
  for (let offset = 9; offset < 13; offset++) {
    wasm[offset] = (length & 127) | (offset < 12 ? 128 : 0);
    length >>>= 7;
  }
  const files = {
    "manifest.json": JSON.stringify({
      manifest_version: 3, name: extensionName, version: "1.0.0",
      permissions: ["offscreen"], background: { service_worker: "background.js" },
      content_scripts: [{ matches: ["http://127.0.0.1/probe*"], js: ["content.js"] }],
      content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    }),
    "background.js": `let pending;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== "probe") return;
  (async () => {
    if (!await chrome.offscreen.hasDocument()) {
      pending ??= chrome.offscreen.createDocument({url:"offscreen.html",reasons:["WORKERS"],justification:"Run a local synthetic WASM worker"}).finally(()=>pending=undefined);
      await pending;
    }
    return chrome.runtime.sendMessage({target:"offscreen"});
  })().then(respond, error => respond({error:String(error)}));
  return true;
});`,
    "content.js": `chrome.runtime.sendMessage({target:"probe"}).then(result => {
  const output = document.createElement("pre"); output.id="nanfu-extension-proof";
  output.textContent=JSON.stringify(result); document.body.append(output);
}).catch(error=>{ const output=document.createElement("pre"); output.id="nanfu-extension-proof"; output.textContent=JSON.stringify({error:String(error)}); document.body.append(output); });`,
    "offscreen.html": '<!doctype html><script src="offscreen.js"></script>',
    "offscreen.js": `chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== "offscreen") return;
  (async () => {
    const worker=new Worker("wasm-worker.js");
    try {
      const compiled=new Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data);worker.onerror=event=>reject(new Error(event.message));});
      worker.postMessage("compile");
      const model=new Uint8Array(await (await fetch("model.onnx")).arrayBuffer());
      return {...await compiled, modelBytes:model.length,modelFirst:model[0],modelLast:model[model.length-1],offscreen:true};
    } finally {worker.terminate();}
  })().then(respond,error=>respond({error:String(error)}));
  return true;
});`,
    "wasm-worker.js": `onmessage=async()=>{try{const bytes=await(await fetch("runtime.wasm")).arrayBuffer();await WebAssembly.compile(bytes);postMessage({wasmBytes:bytes.byteLength,compiled:true});}catch(error){postMessage({error:String(error)});}};`,
    "runtime.wasm": wasm,
    "model.onnx": Buffer.alloc(modelBytes, 90),
  };
  const archive = join(root, "synthetic-mv3.zip");
  const zip = storedZip(files);
  report.uploadBytes = zip.length;
  await writeFile(archive, zip);
  const invalid = join(root, "invalid.zip");
  await writeFile(invalid, "synthetic invalid archive");

  ({ browser: manager, page } = await connectDesktop("installed WebView2 CDP"));
  assert.equal(await page.evaluate(() => typeof window.__TAURI_INTERNALS__?.invoke), "function", "Must test the installed Tauri window");
  report.nativeWindowLifecycle = await verifyNativeWindowLifecycle();
  await stage("installed-minimize-close-and-restore");

  // The shipped build points at the real account service, so the desktop app
  // starts on the mandatory sign-in gate with no session. Relaunch it against
  // this run's synthetic account service, then sign in like a user would.
  await restartAgainstFixture();
  manager?.close().catch(() => {});
  ({ browser: manager, page } = await connectDesktop("restarted installed desktop"));
  await signInThroughGate();
  await stage("installed-signin-with-synthetic-account");
  assert.equal(report.unexpectedFixtureRequests, undefined, "Unexpected account-service calls during sign-in");

  await page.evaluate(() => localStorage.setItem("aliasmode.shell.language", "en-US"));
  await page.reload();
  await page.locator(".sidenav").waitFor();
  await stage("tauri-manager-ready");

  await page.locator(".sidebar").getByRole("button", { name: "New Profile", exact: true }).click();
  await page.locator(".modal-backdrop").getByLabel("Name", { exact: true }).fill(profileName);
  await page.getByRole("button", { name: "Create profile", exact: true }).click();
  await page.getByRole("button", { name: `Edit ${profileName}`, exact: true }).waitFor();
  const roster = await api("/ui/api/profiles");
  const profile = roster.profiles.find(item => item.name === profileName);
  assert.ok(profile);
  assert.equal(profile.engine, "chromium");
  profileId = profile.id;
  await stage("profile-created");

  await page.getByRole("button", { name: /^Manage extensions/ }).click();
  await upload(invalid);
  await page.locator(".modal-err").filter({ hasText: "not a valid zip" }).waitFor();
  assert.equal((await api("/ui/api/extensions")).extensions.length, 0);
  await stage("invalid-archive-rejected");
  await upload(archive);
  await page.locator(".extname").filter({ hasText: extensionName }).waitFor({ timeout: 120000 });
  const installed = (await api("/ui/api/extensions")).extensions;
  assert.equal(installed.length, 1);
  const extensionId = installed[0].id;
  await stage("large-extension-uploaded");

  await page.reload();
  await page.getByRole("button", { name: /^Manage extensions/ }).click();
  await page.locator(".extname").filter({ hasText: extensionName }).waitFor();
  await page.getByRole("button", { name: "All profiles", exact: false }).click();
  await page.getByRole("button", { name: `Edit ${profileName}`, exact: true }).click();
  await page.locator(".modal-backdrop").getByLabel(extensionName, { exact: true }).check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.locator(".modal-backdrop").waitFor({ state: "hidden" });
  assert.deepEqual((await api(`/ui/api/profiles/${profileId}`)).profile.extensions, [extensionId]);
  await stage("extension-assigned");

  let probe = await openProfile();
  await probe.locator("#interaction").click();
  assert.equal(await probe.locator("#clicked").textContent(), "clicked");
  await probe.evaluate(() => { localStorage.setItem("nanfu-gui", "persisted"); document.cookie="nanfu-gui=persisted; Path=/; Max-Age=86400"; });
  await stage("offscreen-wasm-model-running", probe);
  await page.getByRole("button", { name: /^Manage extensions/ }).click();
  let deletionRequests = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/ui/api/extensions/delete") deletionRequests++;
  });
  const removalDialog = page.getByRole("dialog", { name: "Remove extension", exact: true });
  const removeButton = page.locator(".extrow").filter({ hasText: extensionName }).getByRole("button", { name: "Remove", exact: true });
  await removeButton.click();
  await removalDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await removalDialog.waitFor({ state: "hidden" });
  assert.equal(deletionRequests, 0, "Cancel must not send a deletion request");
  await removeButton.click();
  await removalDialog.waitFor();
  await page.keyboard.press("Escape");
  await removalDialog.waitFor({ state: "hidden" });
  assert.equal(deletionRequests, 0, "Escape must not send a deletion request");
  assert.equal((await api("/ui/api/extensions")).extensions.length, 1);
  assert.deepEqual((await api(`/ui/api/profiles/${profileId}`)).profile.extensions, [extensionId]);
  await stage("extension-deletion-cancelled-without-mutation");
  await removeButton.click();
  await removalDialog.getByRole("button", { name: "Remove extension", exact: true }).click();
  await page.locator(".modal-err").filter({ hasText: "close them before deleting" }).waitFor();
  assert.equal(deletionRequests, 1);
  assert.equal((await api("/ui/api/extensions")).extensions.length, 1);
  assert.deepEqual((await api(`/ui/api/profiles/${profileId}`)).profile.extensions, [extensionId]);
  await stage("running-extension-deletion-blocked");
  await closeProfile();
  await stage("profile-closed-cleanly");
  probe = await openProfile();
  assert.equal(await probe.evaluate(() => localStorage.getItem("nanfu-gui")), "persisted");
  assert.ok((await probe.evaluate(() => document.cookie)).includes("nanfu-gui=persisted"));
  await stage("extension-and-storage-restored", probe);
  await closeProfile();
  await page.getByRole("button", { name: /^Manage extensions/ }).click();
  await removeButton.click();
  await removalDialog.getByRole("button", { name: "Remove extension", exact: true }).click();
  await page.getByText("No extensions yet", { exact: true }).waitFor();
  assert.equal(deletionRequests, 2);
  assert.equal((await api("/ui/api/extensions")).extensions.length, 0);
  assert.deepEqual((await api(`/ui/api/profiles/${profileId}`)).profile.extensions, []);
  await stage("extension-removed-and-unassigned");

  const otherName = "Nanfu GUI isolated environment";
  await page.getByRole("button", { name: "All profiles", exact: false }).click();
  await page.locator(".sidebar").getByRole("button", { name: "New Profile", exact: true }).click();
  await page.locator(".modal-backdrop").getByLabel("Name", { exact: true }).fill(otherName);
  await page.getByRole("button", { name: "Create profile", exact: true }).click();
  await page.getByRole("button", { name: `Edit ${otherName}`, exact: true }).waitFor();
  const profiles = (await api("/ui/api/profiles")).profiles;
  const other = profiles.find(item => item.name === otherName);
  assert.ok(other);
  const first = (await api(`/ui/api/profiles/${profileId}`)).profile;
  const second = (await api(`/ui/api/profiles/${other.id}`)).profile;
  assert.equal(second.engine, "chromium");
  assert.notEqual(first.fingerprintSeed, second.fingerprintSeed);
  const empty = { local: null, cookie: null, indexed: null, cached: null };
  const stateA = { local: "A", cookie: "isolation-owner=A", indexed: "A", cached: "A" };
  const stateB = { local: "B", cookie: "isolation-owner=B", indexed: "B", cached: "B" };
  const a = await openProfile(first, false);
  assert.deepEqual(await isolationState(a, "A"), empty);
  const identityA = await identityState(a);
  const b = await openProfile(second, false);
  assert.deepEqual(await isolationState(b, "B"), empty);
  const identityB = await identityState(b);
  assert.notEqual(identityA.canvas, identityB.canvas);
  assert.deepEqual(await isolationState(a), stateA);
  assert.deepEqual(await isolationState(b), stateB);
  await stage("installed-environments-isolated");

  await a.evaluate(() => sessionStorage.setItem("isolation-owner", "A-tab"));
  const tab = await a.context().newPage();
  await tab.goto(`${origin}/probe`);
  assert.deepEqual(await isolationState(tab), stateA);
  assert.deepEqual(await identityState(tab), identityA);
  assert.equal(await tab.evaluate(() => sessionStorage.getItem("isolation-owner")), null);
  await tab.close();
  report.isolation = {
    unit: "independent-environment",
    ordinaryTabsShareAccountStorage: true,
    ordinaryTabsShareCanvas: true,
    sameUaAcrossEnvironments: identityA.ua === identityB.ua,
    persistenceVerified: false,
    rebuildableCacheClearedAfterStop: false,
  };
  await stage("ordinary-tab-sharing-boundary-verified");
  await closeProfile(first);
  await closeProfile(second);
  const restoredA = await openProfile(first, false);
  const restoredB = await openProfile(second, false);
  const restartedA = await isolationState(restoredA);
  const restartedB = await isolationState(restoredB);
  // Account state must survive a stop; rebuildable CacheStorage/Service Worker
  // trees are deliberately purged by the manager after a confirmed stop.
  assert.deepEqual(restartedA, { ...stateA, cached: null }, "Account storage must survive restart");
  assert.deepEqual(restartedB, { ...stateB, cached: null }, "Account storage must survive restart");
  assert.deepEqual(await identityState(restoredA), identityA);
  assert.deepEqual(await identityState(restoredB), identityB);
  report.isolation.persistenceVerified = true;
  report.isolation.rebuildableCacheClearedAfterStop = true;
  await closeProfile(first);
  await closeProfile(second);
  await stage("installed-environment-storage-and-identity-restored");

  // Cloning keeps the environment's own data (cookies, storage, extension
  // state) but must produce a new window name and a new fingerprint.
  const rosterBefore = (await api("/ui/api/profiles")).profiles.length;
  const cloneResponse = page.waitForResponse(response => response.url().endsWith("/profiles/clone") && response.request().method() === "POST", { timeout: 120000 });
  await page.getByRole("button", { name: "All profiles", exact: false }).click();
  await page.getByRole("button", { name: `克隆 ${first.name}`, exact: true }).click();
  const cloneJson = await (await cloneResponse).json();
  assert.equal(cloneJson.ok, true, JSON.stringify(cloneJson));
  assert.equal(cloneJson.created.length, 1, JSON.stringify(cloneJson));
  assert.equal((await api("/ui/api/profiles")).profiles.length, rosterBefore + 1);
  const clone = (await api(`/ui/api/profiles/${cloneJson.created[0].id}`)).profile;
  assert.equal(clone.name, `${first.name} 副本`);
  assert.deepEqual(clone.extensions, first.extensions);
  assert.notEqual(clone.fingerprintSeed, first.fingerprintSeed);
  const cloneProbe = await openProfile(clone, clone.extensions.length > 0);
  assert.deepEqual(await isolationState(cloneProbe), { ...stateA, cached: null });
  assert.notEqual((await identityState(cloneProbe)).canvas, identityA.canvas);
  await closeProfile(clone);
  await stage("installed-clone-keeps-data-and-rotates-fingerprint");

  assert.deepEqual(report.pageErrors, []);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.stack ?? String(error);
  if (page) await page.screenshot({ path: join(reportDir, "failure.png") }).catch(() => {});
  throw error;
} finally {
  for (const profile of [...openProfiles.values()]) {
    await closeProfile(profile).catch(error => { (report.cleanupErrors ??= []).push(String(error)); });
  }
  await writeFile(join(reportDir, "gui-result.json"), JSON.stringify(report, null, 2));
  await manager?.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
