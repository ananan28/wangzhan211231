# JS 指纹层（唯一的实现）

本层是一个 MV3 扩展，由启动器在每次启动前写进档案的 user-data 目录，并以
`--load-extension` 加载：

```
<userDataDir>/aliasmode-fingerprint/
  manifest.json   单条 content_script：world=MAIN、run_at=document_start、all_frames
  content.js      plan 内联在脚本头部，不依赖 fetch 或 chrome.runtime
```

实现只有一份：`vendor/aliasmode/fingerprint-extension.ts`，导出
`fingerprintExtensionPlan` / `fingerprintExtensionContent` /
`fingerprintExtensionFiles` / `writeFingerprintExtension` /
`FINGERPRINT_EXTENSION_REVISION` / `fingerprintExtensionEnabled`。没有第二套配置
或第二份脚本。

## 原则：内核优先，JS 只补缺口

内核（`--fingerprint=SEED` 及 `fingerprint.ts` 派生开关）已经拥有身份：canvas、
WebGL、音频、字体、屏幕、UA-CH、语言、时区、核数。本层只在页面脚本能看到、而
内核没有兜住的裂缝上做**条件性**修正；每个块都先读引擎当前回答，条件不成立就
一个字节也不改。因此正确打补丁的内核让整份脚本等效于空操作。

`fingerprintExtensionPlan` 是唯一的逐档案输入，只有三项：
`cores`（仅当档案存了 hardware.cores）、`webrtc`（仅当档案有代理）、
`timezone`（仅当是合法 IANA 名字）。seed 与代理凭据都不进脚本。

## 五项表面的归属

| 表面 | 内核 | JS 层做什么 | 触发条件 |
| --- | --- | --- | --- |
| `navigator.webdriver` | 0003 补丁移除 AutomationControlled | 改成 `false` | 仅当引擎报 `true` |
| `navigator.hardwareConcurrency` | `--fingerprint-hardware-concurrency`，且已按本机核数封顶 | 降到 `cores` | 仅当引擎报得**更多**，永不升 |
| WebRTC 候选 | `disable_non_proxied_udp` 策略；0073/0074 改写候选地址 | 丢弃 `typ host` / `*.local` 候选 | 仅代理档案；srflx/relay/prflx 全留 |
| `navigator.plugins` / `mimeTypes` | 无 | 补桌面 Chrome 的 PDF 三件套 | 仅当列表为空；非空一字不改 |
| 时区 | ICU 补丁 0011 在全部进程生效 | 同步 `getTimezoneOffset` 与 `Intl.DateTimeFormat` | 仅当引擎自身时区与档案不一致 |

## 明确不在 JS 层做的面

canvas / WebGL / audio 噪声、WebGPU `info`/`limits`、`speechSynthesis` 声音列表、
`queryLocalFonts` 字体清单、`navigator.deviceMemory`、`enumerateDevices` 的
deviceId、`getBoundingClientRect` 子像素抖动——这些全部**不做**。原因是同一个：
它们要么已经由内核从 seed 生成（再加一层就是同一档案两个互相矛盾的图像，
反而成为比噪声更强的关联信号），要么只能在 JS 里伪造出可被接口身份检查识破的
普通对象。缺哪一面就该在内核补丁里补，而不是在页面层再造第二个来源。

## 开关

只有 `NANFU_FINGERPRINT_JS=1` 才写、才加载，且只对 `chromiumRuntime` 档案生效。
必须是启动器进程的环境变量；`"1"` 以外的一切值（`""`、`"0"`、`"true"`）都算关闭。

```bash
NANFU_FINGERPRINT_JS=1 bun run vendor/aliasmode/cli.ts   # bash
$env:NANFU_FINGERPRINT_JS="1"; bun run vendor/aliasmode/cli.ts   # PowerShell
set NANFU_FINGERPRINT_JS=1 && bun run vendor/aliasmode/cli.ts    # cmd
```

## 受控比对

探针页路径：`docs/fingerprint-probe.html`（由内核窗口产出，本层不另造探针）。

1. 关闭开关，用档案 P 启动，采集探针输出，记为 A。
2. 设置 `NANFU_FINGERPRINT_JS=1`，同一档案再启动，采集，记为 B。
3. 同一档案第三次启动，采集，记为 C。
4. 换一个档案 Q（不同 seed、不同代理），启动，采集，记为 D。

## 验收标准

1. **同档案稳定**：B 与 C 逐字段一致（脚本是档案的纯函数，没有时钟或主机输入）。
2. **异档案可区分**：B 与 D 在内核声明的字段上不同（那是内核的职责），且本层
   触发的字段按 plan 变化，不会因为换了档案就多出一批值。
3. **不与内核矛盾**：B 里每项都与内核声明一致——UA 与 UA-CH 同版本、屏幕一致、
   语言与时区一致、核数不超过内核值；本层只在 A 里能看到矛盾时才让 B 变化。

任何一条不满足就关掉开关，按下面的“未验证”清单先定位是内核还是本层。

## 回滚

删除 `NANFU_FINGERPRINT_JS` 即回滚：启动器不再写、不再加载，也不会复用上次启动
的进程（personaDigest 里带了修订号）。磁盘上残留的目录不会被读到，因为加载前
要求 `manifest.json` 存在且开关为开。

## 尚未验证 / 残留风险

- 未在真实浏览器里跑过本层；以上行为在 Node 的伪 DOM 中验证，真机仍需用探针页确认。
- `plugins`/`mimeTypes` 是普通对象：`Object.prototype.toString` 与 `instanceof Plugin`
  不能伪装；它只解决“空列表”这一条，对检查接口身份的探针反而更差。
- 时区兜底只覆盖 `getTimezoneOffset` 与 `Intl`；`Date#toString`、`getHours`、
  `toLocaleString` 仍随宿主，因此该块只在核实时区失败时才挂上。
- WebRTC 不重写 `localDescription` 的 SDP 文本，也不覆盖 `getStats()`；内核策略与
  0073/0074 才是权威，且 0073/0074 只在 Windows 且拿到出口 IP 时生效。
- content script 到不了 Worker：Worker 里看到的是内核值。
- manifest 只匹配 `http`/`https`，`file://` 与 `data:` 页面不加载本层。
- 档案里非法的时区名属于数据问题，本层据此不写 shim，也不会去纠正它。
