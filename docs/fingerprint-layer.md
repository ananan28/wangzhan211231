# JS 指纹层：开关、比对与回滚

本文件描述 `vendor/aliasmode/fingerprint-extension.ts` 这一层的行为边界、怎么做一次受控比对、
拿什么信号验收、以及怎么退回去。内核（上游 AliasMode Chromium + `--fingerprint-*`）负责的面
不在这里重复。

## 这一层是什么

- 每次启动为一个档案在 `<userDataDir>/nanfu-fingerprint/` 写一个 MV3 助手扩展：
  `manifest.json`、`config.json`（配置原文）、`content.js`（内联了配置的脚本）、`stamp`（版本 + 内容哈希）。
- `content_scripts` 是 `world: "MAIN"`、`run_at: "document_start"`、`all_frames: true`，
  所以在页面第一段脚本之前、每一个 frame 里生效。
- 只有 Chromium 155 运行时（`profile.chromiumRuntime`）会加载它；Firefox 档案没有这一层。
- 写盘失败不阻塞启动；`stamp` 不变时复用上一次写好的目录，`FINGERPRINT_EXTENSION_REVISION`
  变化或内容变化时整目录重写。

## 五项表面：谁在回答

| 表面 | 谁回答 | 本层做什么 |
| --- | --- | --- |
| `navigator.webdriver` | 内核。补丁 0003 从 `--enable-automation`、`--headless`、`--remote-debugging-pipe`、`--remote-debugging-port=0` 上都摘掉了 `AutomationControlled`；只有客户端显式 `Emulation.setAutomationOverride` 才会为真 | 不做。JS 再置 false 只会把客户端的显式请求也一起盖掉 |
| `navigator.hardwareConcurrency` | 内核。`--fingerprint-hardware-concurrency`（启动器已按宿主核数截断），未声明时由种子推导 | 只加一个上限：不报出档案声明的更大值，也绝不抬高内核给的小值 |
| WebRTC host / mDNS 候选 | 主要是内核。代理档案固定 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`；补丁 0073/0074 在已知代理出口 IP 时（Windows）把候选文本改写成出口 IP | 代理档案里补一层：丢掉仍是私网/回环/link-local/`.local` 的 `typ host` 候选；`srflx`/`relay`/`prflx` 一律保留 |
| `navigator.plugins` / `navigator.mimeTypes` | 没人。它们跟着构建里带不带 PDF 查看器；没有查看器的构建会给出空列表 | 列表为空时补成桌面 Chrome 的 PDF 三件套（`PDF Viewer` / `Chrome PDF Viewer` / `Chromium PDF Viewer`，2 个 PDF MIME）；非空时原样返回内核的对象 |
| `Date.prototype.getTimezoneOffset` + `Intl.DateTimeFormat` | 内核。补丁 0011 在 ICU 启动时把默认时区设成档案的时区，所有进程一致 | 不做。JS 只能改其中几处（`Date#toString`、`toLocaleString`、worker 仍说宿主时区），比宿主时区本身更像信号 |

不在五项里、但本层已有的行为（亚像素 rects、WebGPU、`deviceMemory`、设备 id、语音、字体枚举）
保持原样：每一块都先读内核的活值，读不到才补。

## 开关

```bash
# bash
NANFU_FINGERPRINT_JS=1 bun cli.ts start

# PowerShell
$env:NANFU_FINGERPRINT_JS="1"; bun cli.ts start

# cmd
set NANFU_FINGERPRINT_JS=1 && bun cli.ts start
```

开关在启动器进程里读一次（模块加载时求值），所以必须设在**拉起浏览器的那个进程**上；改完要重启管理器。
只有值恰好是 `1` 才开启，未设置、空串、`0`、`true` 都关闭。

## 一次受控比对

准备：固定同一个档案（同 `id`），记下它的 `fingerprintSeed`、`platformOs`、`locale`、`timezone`、
`hardware.cores`、`proxy`。每一组之间都要彻底退出浏览器（冷启动），不要只看一次数据。
探针页是 `docs/fingerprint-probe.html`（由内核窗口产出，本层只引用路径）；页面把读数以 JSON 展示/导出。

1. **A 组 · 关闭开关**：不设变量启动管理器，打开该档案，访问 `docs/fingerprint-probe.html`，存下 JSON 为 `a-off.json`。
2. **B 组 · 打开开关**：`NANFU_FINGERPRINT_JS=1` 重启管理器，同一档案再冷启动一次，存 `b-on.json`。
3. **C 组 · 打开开关、同档案第二次**：保持开关，再冷启动一次，存 `c-on.json`。
4. **D 组 · 打开开关、另一个档案**：换一个 `fingerprintSeed`（最好连 proxy 也换）的档案，存 `d-on.json`。

四组用同一台机器、同一个探针页版本。A 与 B 的差异即“开关带来的差异”；B 与 C 的差异即“稳定性”；
B 与 D 的差异即“档案间是否互不相同”。

## 验收标准

**一、同一档案两次启动一致（B = C）**
逐字段相等；比较时忽略采样时刻、计时类字段。`plugins`/`mimeTypes` 的名字、顺序、`enabledPlugin` 关系、
候选集合（类型 + 地址 + 端口）都要一致。两次不一致就是本层不稳定，不能默认开启。

**二、不同档案互不相同（B ≠ D）**
至少 `seed` 派生的那些面不同：`deviceMemory`、设备 id 与 groupId、语音列表、候选地址/端口、
`clientRects` 的亚像素偏移。相同的只应是与机器/工程有关的常量（PDF 三件套名称、平台字面量）。

**三、与内核声明的值不矛盾**
- `navigator.webdriver === false`。
- `hardwareConcurrency` 等于内核给的值；档案声明了 `cores` 时不得大于它，也不得大于
  `--fingerprint-hardware-concurrency`（启动器已按宿主核数截断）。
- 代理档案：候选里没有“`typ host` 且地址是私网/回环/link-local/`.local`”的项，且至少还有一条 `srflx` 或 `relay`；
  非代理档案不做这条检查。
- `Intl.DateTimeFormat().resolvedOptions().timeZone === profile.timezone`，且
  `Date.prototype.getTimezoneOffset()` 与同一时刻用 `Intl` 推出来的偏移相同。
- `navigator.plugins` 非空。内核本来就报 3 个或 5 个 PDF 插件时，A/B 应完全相同（说明补丁没插手）；
  只有 A 组为空、B 组为三件套才算补丁生效。

任何“B 组比 A 组更自相矛盾”的项都要先停下：那说明本层在内核已覆盖的面上又答了一遍。

## 回滚

去掉环境变量即可，不需要改档案、不需要迁移数据：

```bash
unset NANFU_FINGERPRINT_JS    # 或删掉该变量的设置，然后重启管理器
```

- 启动器不再写、也不再 `--load-extension` 这个目录：`buildArgs` 只在 `FINGERPRINT_EXTENSION` 为真且
  目录里有 `manifest.json` 时才加载它。
- 磁盘上已经写好的 `<userDataDir>/nanfu-fingerprint/` 会留在原处，不会被加载；重新开启时按
  `stamp` 复用或整目录重写，不会和新版本混用。
- 回滚后 A 组与回滚前 A 组应完全一致；如果不是，问题不在本层。

## 尚未验证

- 本层没有在 CI 或真机上启动过浏览器（CI 只跑 `fingerprint-extension.test.ts` 与 typecheck），
  上面三条验收要靠人在受控机器上按步骤做一次。
- WebRTC 只覆盖 `onicecandidate`、`addEventListener('icecandidate')` 与三个 `localDescription` 取值点；
  `RTCPeerConnection.getStats()` 里的 candidate-pair 本地地址没有处理。
- 时区完全依赖内核 ICU：如果一个时区名被内核拒绝（非法名字），探针会显示宿主时区，这属于档案数据问题，
  本层不会去“修”。
- `plugins` 补丁只在引擎返回空列表时生效；当前上游构建大概率非空，所以它在多数机器上是惰性的。
- 代理出口 IP 改写（补丁 0073/0074）只在 Windows 且解析到出口 IP 时发生；其他组合下由本层的候选过滤兜底，
  但本层不重写地址，也不保证候选里一定还有公网地址。
