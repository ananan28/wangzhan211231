# Kernel patch inventory

What our browser actually controls today, where that is proven, and what is
missing against the products we are compared to.

Read this as an evidence table, not a feature list. A row is only as good as
the file it points at.

## How to read the status column

| Status | Means |
| --- | --- |
| **verified (source)** | The behaviour is visible in code we vendor or own: a patch file, a switch table entry, or a line of our manager. I read it at the base commit `b6d79f4`. |
| **verified (source, by absence)** | I searched every entry of the vendored series and the published switch table and found no entry for this surface. Weaker than reading the code that implements it: absence in a 150-file series is strong evidence, not proof, because the binary could carry something the listed series does not. |
| **verified (runtime)** | Measured on a running build with `docs/fingerprint-probe.html`. **There are none yet** — see below. |
| **reported-only** | An upstream document claims it and I did not find code that proves it. Treat as a hypothesis. |
| **unknown** | No evidence either way. |

**Nothing in this document is verified at runtime.** The authoring machine has
no GPU, no Chromium source tree and no built binary, so every `verified (source)`
row is a claim about code, not about what a page saw. Converting them is the
first job of `docs/fingerprint-probe.html`: run it on the shipped 155 build,
store the JSON, and a row moves to `verified (runtime)` only when the probe
output matches the claim.

Evidence shorthand:

- `P:00NN-...` — `vendor/aliasmode-chromium/patches/00NN-....patch`, the actual diff.
- `S:...` — `vendor/aliasmode-chromium/docs/reference/switches.mdx`, the upstream switch table.
- `G:...` — `vendor/aliasmode-chromium/docs/known-gaps.mdx`, upstream's own gap list.
- `M:...` — our manager: `vendor/aliasmode/fingerprint.ts`, `launcher.ts`, `aliasmode-chromium.ts`, `types.ts`.
- `N:...` — our own code: `nanfu_chromium/nanfu_environments.py`.

## What we ship today

- The runtime is **upstream's prebuilt binary**, downloaded on first use and
  pinned by archive and executable SHA-256: `M:aliasmode-chromium.ts:18-27`
  (`155.0.8059.85`, `aliasmode/aliasmode-chromium` release assets).
- **We do not build Chromium.** The only build job is the Tauri manager
  (`.github/workflows/nanfu-chromium-baseline.yml`, `bun run desktop:build:nsis`);
  no job compiles a kernel.
- **We maintain zero kernel patches.** `kernel/patches/` holds two inert headers
  added by this change; there is no behavioural patch yet.
- Our own code in this area is small: environment records, proxy syntax
  validation, batch creation and atomic JSON persistence
  (`N:nanfu_environments.py:16-91`), plus the launch-flag derivation below.
  None of it touches the rendering or JS surfaces.

**Unknown, and it matters:** whether the shipped binary is byte-for-byte what
`vendor/aliasmode-chromium` builds from the tag. We pin the archive and the
executable by SHA-256 (`M:aliasmode-chromium.ts:24-27`), which proves we get the
artifact upstream published, not that the artifact matches the vendored series.
Closing that needs one build of our own on a runner and a hash comparison. Until
then, every `P:00NN` row below describes source we can read, not necessarily the
binary in the field.

## 1. Controls the upstream build gives us

Status is `verified (source)` unless marked otherwise.

### Identity, UA and Client Hints

| Control | What a page sees | Evidence | Status |
| --- | --- | --- | --- |
| Seed / persona | One seed decides every composed value; same seed, same machine | `P:0081`, `P:0084`, `S:--fingerprint` | verified (source) |
| Platform persona | `navigator.platform`, font set, voices, colours follow `windows`/`macos`/`linux` | `P:0009` (platform + whole UA from profile, workers included), `S:--fingerprint-platform` | verified (source) |
| User-Agent string | Taken whole from the profile; consistent across header, `navigator.userAgent`, workers | `P:0009` | verified (source) |
| Headless token | `HeadlessChrome` never appears even under `--headless=new` | `P:0002` | verified (source) |
| UA-CH platform, platformVersion, arch, bitness, model, mobile | One `UserAgentMetadata` feeds every `Sec-CH-*` header and `navigator.userAgentData` | `P:0008` | verified (source) |
| UA-CH brand list | Always contains the `Google Chrome` entry real Chrome sends; stock Chromium omits it | `P:0008` | verified (source) |
| `navigator.webdriver` | `false` even with `--enable-automation`, `--headless`, remote debugging | `P:0003` | verified (source) |
| CDP attach tells | Exception/console stack capture and console serialisation do not change under `Runtime.enable`; the debugging port rejects page-originated requests | `P:0087` | verified (source) |

### Display and hardware

| Control | What a page sees | Evidence | Status |
| --- | --- | --- | --- |
| Screen size | `screen.width/height`, CSS display media features, DPR client hint agree | `P:0010`, `S:--fingerprint-screen-*`, `P:0085` | verified (source) |
| Available area, colour depth, `isExtended` | `availWidth/availHeight`, `colorDepth` (24 or 30 only) | `P:0010`, `P:0016`, `P:0033` | verified (source) |
| Device pixel ratio | From the persona; a forced scale factor overrides it coherently | `P:0010`, `P:0159` | verified (source) |
| `hardwareConcurrency` | Set by switch, clamped to host logical cores | `P:0085`, `S:--fingerprint-hardware-concurrency`, `G:cores-and-memory` | verified (source) |
| `deviceMemory` | Rounded to 2/4/8/16/32, matches the `Device-Memory` header, clamped to host RAM | `P:0006`, `P:0085` | verified (source) |
| CPU performance tier | A CPU tier without the host's real model | `P:0152` | verified (source) |
| Battery | `navigator.getBattery()` values from the profile | `P:0089` | verified (source) |

### GPU, canvas, WebGL, WebGPU

| Control | What a page sees | Evidence | Status |
| --- | --- | --- | --- |
| WebGL vendor/renderer | Unmasked strings from the profile; masked renderer stays `WebKit WebGL` | `P:0007`, `P:0085` (`--fingerprint-gpu-vendor/-renderer`) | verified (source) |
| WebGL limits | Limits served from the profile's capability table, clamped | `P:0026`, `P:0032`, `P:0035`, `P:0036`, `P:0103`, `P:0112` | verified (source) |
| WebGL extensions | Extension list from the profile, constants served consistently | `P:0028`, `P:0104` | verified (source) |
| Shader precision | `getShaderPrecisionFormat` from the profile | `P:0029` | verified (source) |
| WebGPU adapter | Adapter info and limits from the profile, incl. subgroup sizes | `P:0068`, `P:0069`, `P:0135`, `P:0136`, `P:0149`, `P:0155` | verified (source) |
| Canvas/text/audio readback noise | Opt-in (`--fingerprint-noise`): per-profile, banded, self-consistent across `getImageData`/`toDataURL`/`readPixels` | `P:0120`, `P:0165`, `P:0168`, `P:0167`, `S:--fingerprint-noise` | verified (source) |

### Locale, fonts, devices, network

| Control | What a page sees | Evidence | Status |
| --- | --- | --- | --- |
| Timezone | `Intl`, `Date`, resolved zone | `P:0011`, `P:0085`, `S:--fingerprint-timezone` | verified (source) |
| Locale and `navigator.languages` | UI locale, `Intl` formats, `Accept-Language` | `P:0013`, `P:0014`, `P:0111`, `P:0114`, `P:0115`, `P:0148` | verified (source) |
| Fonts | Families the persona has; per-profile scaling; Windows metrics, aliases, fallbacks | `P:0031`, `P:0047`, `P:0090`, `P:0099`, `P:0127`, `P:0128`, `P:0143`, `P:0144`, `P:0146`, `P:0150`, `P:0156`, `P:0166` | verified (source) |
| Speech voices | Voice list from the persona, spoken by a real provider | `P:0037`, `P:0043`, `P:0075`, `P:0125`, `P:0147` | verified (source) |
| Media devices | Device counts and names from the profile, synthesised frames | `P:0020`, `P:0092`, `P:0131`, `P:0132`, `P:0141` | verified (source) |
| WebRTC candidate address | `--fingerprint-webrtc-ip` rewrites the SDP candidate text; UDP through SOCKS5 or fail closed | `P:0073`, `P:0074`, `P:0164`, `P:0169`, `P:0086`, `P:0118`, `S:--fingerprint-webrtc-ip` | verified (source) |
| Bluetooth | Follows the claimed platform | `P:0017`, `P:0025` | verified (source) |
| Keyboard layout | Layout map from the profile | `P:0021`, `P:0133` | verified (source) |
| Storage quota | In incognito, the quota derives from the profile's memory, matching `deviceMemory` | `P:0022` | verified (source) |

## 2. What Nanfu maintains ourselves

| Thing | Where | What it does | Status |
| --- | --- | --- | --- |
| Environment records | `N:nanfu_environments.py:33-91` | name/id/proxy/`proxy_mode=fixed`/`rotate_fingerprint_on_reload`; atomic JSON save; validation on load | verified (source) |
| Proxy syntax validation | `N:nanfu_environments.py:16-30` | http/https/socks4/socks5, port required, **credentials in the URL rejected** | verified (source) |
| Batch creation | `N:nanfu_environments.py:46-50` | 1-1000 environments with a shared proxy | verified (source) |
| Launch flags | `M:fingerprint.ts:212-247` | derives `--fingerprint`, screen w/h, platform, timezone, locale, `--fingerprint-hardware-concurrency`, `--fingerprint-noise` | verified (source) |
| WebRTC flag | `M:launcher.ts:1376-1384`, `M:launcher.ts:1484` | `--force-webrtc-ip-handling-policy` always; `--fingerprint-webrtc-ip` only when Windows **and** proxy **and** build feature on | verified (source) |
| Runtime pin | `M:aliasmode-chromium.ts:18-27` | version + archive/executable SHA-256 | verified (source) |
| Installer branding | `vendor/aliasmode/src-tauri/nanfu.conf.json` | product name, identifier, window title | verified (source) |
| Kernel patches | `kernel/patches/` | two inert headers from this change; **no behavioural patch** | verified (source) |

## 3. Ranked gaps against BitBrowser-class products

Ranked by (a) how easily a page can see it, (b) how often the competing
products advertise a control for it, (c) how much of our own work it is.
Status describes the evidence, not the size of the gap.

| # | Gap | What a page can see | Evidence | Status |
| --- | --- | --- | --- | --- |
| 1 | **WebRTC IP is Windows-only and proxy-only** | Real candidate addresses on macOS/Linux builds, and on Windows when no proxy is set: only host candidates are mDNS-obfuscated, server-reflexive ones still carry the real public address | `M:launcher.ts:1484` gates on `win32 && proxy && chromiumRuntime && ALIASMODE_CHROMIUM_WEBRTC_IP`; `G:webrtc-needs-a-socks5-proxy-with-udp` | verified (source) |
| 2 | **No geolocation control** | `navigator.geolocation` resolves to the host's real position (network/host provider) | No `geo*` entry in the 150-file series listing; no geolocation switch in `S:` | verified (source, by absence) |
| 3 | **Browser chrome height is the host's** | `outerHeight - innerHeight` reads 87 where a real Windows 11 machine read 143 at 100% | `G:browser-chrome-height` ("Not fixed") | reported-only |
| 4 | **No per-field hardware/GPU editing in our UI** | Every profile on a host reports the seed's cores/memory, capped at the host; no UI for GPU vendor/renderer or `deviceMemory` | `M:types.ts:71-74` (`ProfileHardware` has `cores` only); kernel can do it: `P:0085` | verified (source) |
| 5 | **Fonts are limited to the host's installed families** | A Windows persona on a Linux/macOS host lacks Segoe UI and other Windows families; missing families are simply absent | `G:fonts-that-are-not-installed-are-absent` | reported-only |
| 6 | **Readback noise is always on** | Canvas/WebGL/audio pixels are modified for every profile, and the modification is detectable by drawing one image at two scales | `M:fingerprint.ts:245` pushes `--fingerprint-noise` unconditionally; `S:--fingerprint-noise` warns "a page can detect the change … leave it off" | verified (source) |
| 7 | **Storage quota is not controllable in 155** | `navigator.storage.estimate()` follows the profile's memory, but no operator value is delivered | `M:fingerprint.ts:234` computes `--fingerprint-storage-quota` only for the legacy runtime; the flag is absent from `P:0085` (which enumerates "eight switches") and from `S:` | verified (source, by absence) |
| 8 | **Host capture devices leak into the persona** | `enumerateDevices()` lists the host's camera/microphone, and labels become readable after a permission grant | `G:cameras-and-microphones` | reported-only |
| 9 | **Keyboard layout is the US layout of the claimed platform, whatever the language** | `navigator.keyboard.getLayoutMap()` returns a US map for every persona | `G:keyboard-layout-is-us`; the map is profile-driven (`P:0021`, `P:0133`) and a written profile can carry another layout | reported-only |
| 10 | **Cores/memory cannot exceed the host** | A small server forces every persona to the server's core count next to a desktop GPU | `G:cores-and-memory-are-capped` | reported-only |
| 11 | **Kernel branding is not ours** | Human-visible product strings come from upstream's branding patch, not Nanfu | `P:0158` (product/company labels) | verified (source) |
| 12 | **No mobile personas, no Intel Mac, no 32-bit Windows** | Platform mismatch on any device that expects them | `G:not-done-or-not-measured` | reported-only |

### Two contradictions worth fixing before any new patch

1. **`--fingerprint-storage-quota` is dead code in our launch path.** Our manager
   still computes a quota for the legacy runtime (`M:fingerprint.ts:234`), but the
   155 kernel has no such switch: `0085` enumerates the complete per-field set
   and the published switch table has no storage-quota entry. An unknown switch
   is ignored silently, so this is a control we believe we have and do not.
2. **We enable noise for every profile.** Upstream ships it off by default and
   documents that a page can detect it. Turning it on globally trades a real
   detection risk for canvas-hash uniqueness that most profiles do not need.

Also inconsistent, lower stakes: our environment validator refuses proxy
credentials in the URL (`N:nanfu_environments.py:29`) while the kernel supports
them explicitly (`P:0110`), so the capability exists and we cannot reach it.

## 4. How a row moves

`reported-only` → `verified (runtime)` requires three artefacts, kept together:

1. the probe JSON from `docs/fingerprint-probe.html`, run on the shipped build;
2. `--fingerprint-explain` output for the same seed;
3. the binary's version and the series revision it was built from.

A row that the probe contradicts is corrected here, not defended. That is the
only reason this file exists.
