# 内核补丁现状清单

> 本文件只记录**能举证**的现状。证据等级严格区分「本仓库实测」与「上游文档声明」。
> 没有代码或参数证据的条目，一律不写“已验证”。

## 口径

| 等级 | 定义 |
| --- | --- |
| **已验证** | 本仓库内能指向代码/参数，并且有可复核的实测记录（GitHub Actions run、或仓库内带日期的测量输出）。 |
| **仅报告** | 有开关、补丁或上游带日期的测量，但本仓库没有独立复现。 |
| **未知** | 没有代码/参数证据，或明确未实现、未编译、未测量。 |

- “上游”指仓库内导入的 `vendor/aliasmode-chromium`（AliasMode / Apostate 定制 Chromium，版本见 `kernel/pinned.json`）。
- 线上实际分发的是上游二进制（Windows `155.0.8059.85-aliasmode.4`，macOS/Linux `155.0.8059.31`），不是本仓库构建的产物。
- 本仓库 `kernel/patches/` 只有补丁文本；CI 只证明“能 apply / 能 reverse”，**不编译**。

## A. 本仓库自己的实测（已验证）

| # | 能力 | 证据 | 等级 |
| --- | --- | --- | --- |
| 1 | 每环境独立进程 / Cookie / 本地存储隔离 | `CHROMIUM_MIGRATION.md:17`；CI run 40579090735 | 已验证 |
| 2 | 不同种子 Canvas 输出不同，刷新后稳定 | `CHROMIUM_MIGRATION.md:17`；CI run 40579090735 | 已验证 |
| 3 | 两个 Chromium 环境同时运行并各自隔离 | `CHROMIUM_MIGRATION.md:18-19`；CI run 40579090735 | 已验证 |
| 4 | 固定 HTTP 代理关闭后未观察到测试请求回退直连 | `CHROMIUM_MIGRATION.md:22-24`；CI run 40576175729。**仅覆盖直接启动 Chromium 的路径**，不含 SOCKS/DNS/WebRTC/扩展 | 已验证（范围受限） |
| 5 | Windows 开发安装包可编译、静默安装、启动后 15 秒存活 | `CHROMIUM_MIGRATION.md:33-35`；CI run 40605311426 | 已验证 |
| 6 | 南孚产品名/应用标识/安装目录/阻止上游更新覆盖 | `CHROMIUM_MIGRATION.md:30-34`；CI run 40605311426、40605845335 | 已验证 |
| 7 | 自研补丁 0001 对钉住版本能 apply + reverse | `kernel/patches/0001-*.patch`；CI run 40940653742 | 已验证（仅补丁上下文） |
| 8 | 自研补丁 0002 对钉住版本能 apply + reverse | `kernel/patches/0002-*.patch`；CI run 40940653742 | 已验证（仅补丁上下文） |
| 9 | 自研补丁 0003 对钉住版本能 apply + reverse | `kernel/patches/0003-tls-enable-server-handshake-padding.patch`；CI run 40940653742 | 已验证（仅补丁上下文） |

## B. 上游内核已经提供、我们只消费的能力

| # | 能力 | 开关 / 实现证据 | 等级 | 说明 |
| --- | --- | --- | --- | --- |
| 10 | 整机种子 | `switches.mdx:37-56`，`--fingerprint=SEED`；`verify.mdx:97-98` 示例 seed 42 | 仅报告 | 本仓库只验证了“不同种子 Canvas 不同”，未做全机一致性复核 |
| 11 | 平台 persona | `switches.mdx:58-63`，`--fingerprint-platform` | 仅报告 | 上游示例：Linux 宿主上 Windows persona 读 `Win32`（`verify.mdx:53,63`） |
| 12 | 屏幕几何 | `switches.mdx:155-191`，`--fingerprint-screen-width/height`；`0010-display-screen-geometry-from-profile.patch` | 仅报告 | 本仓库无屏幕一致性实测 |
| 13 | 时区 | `switches.mdx:206-212`，`--fingerprint-timezone`；`0011-base-icu-timezone-from-profile.patch` | 仅报告 | 本仓库无时区实测 |
| 14 | 语言 / Accept-Language | `switches.mdx:197-204`，`--fingerprint-locale`；`0013-accept-languages-from-profile.patch` | 仅报告 | 本仓库无语言实测 |
| 15 | hardwareConcurrency | `switches.mdx:159,175-180`，`--fingerprint-hardware-concurrency` | 仅报告 | **受宿主上限约束**：不得超过宿主逻辑核数 |
| 16 | deviceMemory | `switches.mdx:160,182`，`--fingerprint-device-memory`；`0006-blink-device-memory-from-profile.patch` | 仅报告 | **受宿主上限约束**，且 Chrome 只报 2/4/8/16/32 |
| 17 | storage quota | **没有独立开关**；`0022-quota-incognito-memory-from-profile.patch:3-10,47-52` 把 incognito 配额分母改成 profile 内存 | 仅报告 | 上游没有 `--fingerprint-storage-quota` 这个开关；配额跟随 profile 内存，随机比例保留 |
| 18 | Canvas / WebGL / Audio 读回噪声 | `switches.mdx:238-248`，`--fingerprint-noise`；`0120-opt-in-profile-seeded-readback-noise.patch` | 仅报告 | 上游明确说页面可检测（同文件 248 行），默认关闭 |
| 19 | WebGL vendor/renderer | `switches.mdx:18-19,157-158`，`--fingerprint-gpu-vendor/renderer` | 仅报告 | 字符串与能力簇绑定，跨家族字符串会被拒绝 |
| 20 | WebGL limits / extensions | `0026`、`0028`、`0032`、`0103`、`0104`、`0112`、`0119` 等补丁 | 仅报告 | 能力表来自实测 GPU 家族；Apple silicon 上仍会泄漏宿主值（`known-gaps.mdx:68-72`） |
| 21 | WebGPU adapter | `0068`、`0069`、`0135`、`0136`、`0142`、`0149`、`0155`、`0157` | 仅报告 | Linux headless 下 `requestAdapter()` 返回 `null`（`known-gaps.mdx:82-86`） |
| 22 | WebRTC 候选 IP | `switches.mdx:218-222`，`--fingerprint-webrtc-ip`；`0073`、`0074`、`0164`、`0169` | 仅报告 | UDP 可用时对端仍能从包源地址读到真实地址（`switches.mdx:220`） |
| 23 | WebRTC UDP 走向 | `switches.mdx:224-234`，`--fingerprint-webrtc-udp` | 仅报告 | HTTP/SOCKS4 等代理下无 UDP；需支持 UDP ASSOCIATE 的 SOCKS5 |
| 24 | UA / UA-CH | `detection.mdx:21`；`verify.mdx:49-97,168-180` 给出 UA、`sec-ch-ua*` 示例 | 仅报告 | 上游带日期的示例；本仓库未复核 |
| 25 | AudioContext 指纹 | `switches.mdx:243`；`0130`、`0167` | 仅报告 | 默认 48 kHz；振荡器/压缩器按 profile 微调 |
| 26 | 字体枚举 / 字体过滤 | `0090`、`0099`、`0031`、`0143-0146`、`0150`、`0166` | 仅报告 | 见 D-33：`fonts` 段会被 iphey 判 Unreliable |
| 27 | 自动化痕迹（webdriver/headless/CDP） | `detection.mdx:47-68`；`0003-content-no-automation-controlled-from-switches.patch`、`0087`、`0170` | 仅报告 | `navigator.webdriver` 在常见驱动开关下为 false（上游声明） |
| 28 | 浏览器 chrome 高度 | `known-gaps.mdx:118-122` | 仅报告 | Windows persona 的 `outerHeight-innerHeight` 读 87，真实 Windows 为 133–143，**极易测** |
| 29 | Passkey / 硬件视频编码器 | `known-gaps.mdx:88-98` | 仅报告 | 跟随宿主，未伪装 |

## C. 我们自研补丁的实际覆盖

| # | 补丁 | 改动点 | 运行时效果 | 等级 |
| --- | --- | --- | --- | --- |
| 30 | `0001-add-webgl-vendor-renderer-switches.patch` | `--fingerprint-webgl-vendor/renderer` 覆盖 WebGL1/2 与 `WEBGL_debug_renderer_info` 四个查询点 | **未编译、未实测** | 未知 |
| 31 | `0002-add-client-rects-jitter-seed.patch` | `--fingerprint-client-rects-jitter` + `--fingerprint-seed`，确定性 ±0.5px 抖动 | **未编译、未实测** | 未知 |
| 32 | `0003-tls-enable-server-handshake-padding.patch` | 开启 `kAddTLSServerHandshakePadding` 并请求 4000 字节；目标是让 JA4 对齐 Chrome 155（依据上游 0161 的测量） | **未编译、未实测** | 未知 |

> 001/002/003 的“能 apply / 能 reverse”是已验证的；**补丁编译后的行为**全部是未知。二者不能混为一谈。

## D. 和 BitBrowser 这类产品的差距

> BitBrowser / AdsPower 这类产品的公开卖点是“每环境独立且自洽的指纹（含 TLS、字体、WebGL）”。
> 下表只列**我们能举证的本仓库差距**，不替对端背书其内部实现。

| # | 差距 | 我们的证据 | 等级 |
| --- | --- | --- | --- |
| 33 | **字体面**：任何带 `fonts` 段的 persona 被 iphey 判“Unreliable”，移除 `fonts` 段才清除；字体缺失依赖宿主安装，字形由宿主字体引擎绘制 | `known-gaps.mdx:34-36,161-169` | 仅报告（上游测量） |
| 34 | **渲染真值**：Canvas/WebGL/WebGPU 像素与渲染速度来自宿主 GPU，无法伪装真实硬件；Apple silicon 上 `MAX_UNIFORM_BLOCK_SIZE` 读 16384 而 persona 声称 65536 | `known-gaps.mdx:62-72` | 仅报告（上游测量） |
| 35 | **per-profile TLS/JA3**：没有按 profile 定制 TLS；TLS 栈就是 Chromium 155 自己的，0161 只是打开 Chrome 默认的 server padding，把 JA4 从 `t13d1517h2` 对齐到 `t13d1518h2` | `detection.mdx:92-93`；`0161-tls-ask-for-server-padding-as-chrome-does.patch:1-9` | 未知（我们无此能力） |
| 36 | **每标签页独立指纹**：当前隔离边界是独立进程/环境，不是同一窗口内每标签页独立指纹 | `CHROMIUM_MIGRATION.md:41` | 未知（未实现） |
| 37 | **Worker / Service Worker / IndexedDB / CacheStorage 隔离**：未完整验证 | `CHROMIUM_MIGRATION.md:45` | 未知（未验证） |
| 38 | **行为面**：不伪造鼠标轨迹、打字节奏、滚动；浏览器侧无解 | `detection.mdx:102-106` | 未知（不做） |
| 39 | **移动端 persona**：没有移动端 persona、Intel Mac、32 位 Windows 构建 | `known-gaps.mdx:249-254` | 未知（未做） |

## E. 统计

| 等级 | 条数 | 编号 |
| --- | --- | --- |
| 已验证 | **9** | 1–9 |
| 仅报告 | **22** | 10–29、33、34 |
| 未知 | **8** | 30–32、35–39 |
| 合计 | **39** | 1–39 |

### CI 证据（仅 apply/reverse）

`kernel-patches` run **40940653742**（`qoder/nanfu-kernel-docs-20261030`）：

- 从 `refs/tags/155.0.8059.85` 只取补丁涉及的文件，日志含 `fetched net/base/features.cc (41275 bytes)`；
- `applied 3 patch(es)`；
- `all patches reversed cleanly`；
- `git apply --stat` 显示 0003 改 `net/base/features.cc` 共 9 行（+7/−2）。

这证明 0003 对钉住版本的真实文件可 apply/可回滚；**仍不证明能编译、更不证明行为生效**。

### 一眼结论

- **真正经过本仓库实测的只有 6 类**：环境/存储隔离、种子对 Canvas 的影响、多开隔离、固定代理不回退（范围受限）、Windows 包安装启动、品牌替换。
- **上游 `--fingerprint-*` 族没有一条在本仓库做过完整的全机一致性复核**；只有“seed 影响 Canvas”有实测，其余全是“仅报告”。
- 自研补丁目前只证明了“补丁上下文正确”，**没有任何一条经过编译或真机验证**。
- 最实在的三个差距：**字体（iphey 直接判死）**、**渲染/GPU 真值（宿主决定像素与 limits）**、**TLS 不能按 profile 定制**；另有一个几乎零成本就能测出来的 **chrome 高度 87 vs 133–143**。

## 证据文件索引

- `kernel/pinned.json` — 钉住的 Chromium tag/commit 与补丁顺序
- `kernel/README.md` — 构建/验证边界
- `vendor/aliasmode-chromium/docs/reference/switches.mdx` — 全部开关、默认值、拒绝规则
- `vendor/aliasmode-chromium/docs/guides/verify.mdx` — `what_a_page_sees.py` 的真实输出
- `vendor/aliasmode-chromium/docs/concepts/detection.mdx` — 检测面与自动化痕迹
- `vendor/aliasmode-chromium/docs/known-gaps.mdx` — 带日期的差距测量
- `vendor/aliasmode-chromium/patches/series` — 上游 149 个补丁的应用顺序
- `CHROMIUM_MIGRATION.md` — 本仓库已有的实测与 CI run 链接
