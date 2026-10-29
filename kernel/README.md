# 南孚内核补丁序列

> **当前状态：尚未产出可分发内核。** 仓库里没有 Chromium 源码，也没有构建产物；
> 本目录只有补丁、版本锚点和一条可被 CI 真实执行的“可应用/可回滚”校验链路。
> 线上发行仍使用上游 AliasMode 定制 Chromium（Windows `155.0.8059.85-aliasmode.4`，
> macOS/Linux `155.0.8059.31`），只消费其 `--fingerprint-*` 开关。

本目录解决的是“我们自己的内核补丁能力”：先把补丁序列、版本 pin、rebase 和验证
流程固定下来，再在这些补丁真正编译进内核后，才有资格谈超越上游。

## 目录

```
kernel/
  README.md                 本文件
  pinned.json               目标 Chromium tag / commit（已核实存在）
  apply-patches.sh          对给定源码根按序 check + apply
  patches/
    0001-add-webgl-vendor-renderer-switches.patch
    0002-add-client-rects-jitter-seed.patch
```

## 补丁序列怎么组织

- 文件名 `NNNN-<动词>-<主题>.patch`，编号即应用顺序；一个补丁只做一件事。
- 补丁必须由 `git diff` 从该版本真实文件生成，带完整 `diff --git a/... b/...`
  头，路径相对 Chromium 源码根；不接受手写 hunk。
- 新命令行开关统一放在 `third_party/blink/public/common/switches.{h,cc}`，
  由 `RenderProcessHostImpl::PropagateBrowserCommandLineToRenderer()` 的
  `kSwitchNames` 转发到 renderer；消费端在 Blink 内读
  `base::CommandLine::ForCurrentProcess()`，未传开关时行为与上游完全一致。
- 当前序列：
  - **0001** `--fingerprint-webgl-vendor=<str>` /
    `--fingerprint-webgl-renderer=<str>`：覆盖 WebGL1/2
    `getParameter(GL_VENDOR/GL_RENDERER)` 与 `WEBGL_debug_renderer_info`
    的 `UNMASKED_*` 返回值。四个查询点共用同一开关值，避免自相矛盾。
  - **0002** `--fingerprint-client-rects-jitter=<px>` +
    `--fingerprint-seed=<uint32>`：给 `Element::getClientRects()` /
    `getBoundingClientRect()` 加确定性亚像素偏移。同一元素在同一文档内稳定，
    幅度上限 ±0.5px（开关值再大也会被截断），默认关闭。
- 补丁不改上游已有开关语义，不引入构建期代码生成，便于 rebase 和审计。

## 对新内核版本 rebase

1. 在 `chromium.googlesource.com` 确认目标 tag（`refs/tags/<version>`）存在，
   记录对应 commit，更新 `pinned.json` 的 `version` / `source_ref` /
   `source_commit` / `verified_at`。
2. 按补丁中 `+++ b/` 列出的路径，从
   `https://chromium.googlesource.com/chromium/src/+/<ref>/<path>?format=TEXT`
   取新版本真实文件（base64），在临时目录建最小树；**不要**拉全仓。
3. 逐条重放改动而不是硬套旧 patch；上下文漂移时手工移植，再用 `git diff`
   重新生成最小 hunk。不要为了让旧 patch 通过而扩大上下文。
4. 本地跑 `kernel/apply-patches.sh <src>`，再按逆序做
   `git apply --reverse --check`（必须配合真实 reverse，见下），全绿后提交。
5. CI 绿只代表“能干净应用/回滚”，不代表“能编译”。首次真机构建时优先核对
   include、命名空间、Blink WTF 类型转换。

## 验证

- 本地：
  ```bash
  kernel/apply-patches.sh /path/to/chromium/src
  ```
  脚本对每个补丁先 `git apply --check` 再 `git apply`，任一失败立即非零退出。
- CI：`.github/workflows/kernel-patches.yml`，仅 `workflow_dispatch`，只存在于
  本功能分支：
  - 校验 `pinned.json` 的 tag 仍解析到记录的 commit；
  - 只从 googlesource 拉取补丁涉及的 5 个文件（不拉全仓）；
  - 按序 `--check` + apply；
  - 按逆序 `--reverse --check` 并真实回滚，证明可逆；
  - 打印每个补丁的 `git apply --stat`。
- 边界：托管 runner 装不下 Chromium，CI 不做完整构建；**补丁未经编译验证**，
  目前只证明对 `155.0.8059.85` 的真实文件上下文正确。

## 自建构建机要求

要真正编译并出货，最低配置如下（托管 runner 凑不出来）：

- **磁盘 1TB NVMe**：全量检出 30–50GB，`out/Default` 加 PDB/调试信息 60–120GB，缓存 50–100GB。
- **内存 64GB**：32GB 在链接阶段会吃紧。
- **CPU 16–32 线程**：Windows 冷构建约 4–8 小时，增量 10–40 分钟；Linux 略快。
- **签名**：Windows 需要 Authenticode（EV 证书或 Azure Trusted Signing）；macOS 需要 Developer ID + notarization（Apple 账号）；Linux 无强制签名。
- **缓存**：sccache/ccache 50–100GB 或 reclient，命中后增量可到分钟级。
- **托管 runner 装不下**：磁盘、内存、时长都不够；GitHub 托管 runner 只能做补丁上下文校验（`kernel-patches.yml`），不能编译。

下面的经验值表用于估算，不是承诺。

## 构建需要什么（经验值，非承诺）

| 项目 | 评估 |
| --- | --- |
| 源码 checkout | 30–50GB；`--no-history` 约 25GB |
| 构建输出 | `out/Default` + PDB/调试信息 60–120GB |
| 磁盘建议 | 最低 500GB NVMe，推荐 1TB |
| 内存 | 32GB 勉强（链接阶段吃紧），推荐 64GB |
| CPU / 时长 | 16–32 线程，Windows 冷构建约 4–8 小时，增量 10–40 分钟；Linux 略快 |
| 签名 | Windows：Authenticode（EV 证书或 Azure Trusted Signing）；macOS：Developer ID + notarization（需 Apple 账号）；Linux 无强制签名 |
| 缓存 | sccache/ccache 50–100GB 或 reclient 远程缓存；命中后增量可到分钟级 |
| 自托管 runner | 32C/64G/1TB NVMe，持久化 ccache + 预热 checkout；只跑受控分支，不对 fork PR 开放 |

结论：完整 Chromium 构建**可行但成本高**，必须自托管；GitHub 托管 runner
只能做补丁上下文校验（本流水线即如此）。

## 切换到自研内核时必须做的指纹回归

1. WebGL：`VENDOR` / `RENDERER`、`UNMASKED_*`、WebGL2、OffscreenCanvas，
   以及不同 profile 的开关隔离。
2. ClientRects：`getBoundingClientRect()` 与 `getClientRects()[0]` 一致性、
   滚动/缩放后的稳定性、点击命中是否仍正常。
3. Canvas 2D / WebGL `readPixels` 噪声与种子在重启后的稳定性。
4. WebGPU adapter info（**尚未打补丁**）。
5. 字体白名单与字体度量（**尚未打补丁**）。
6. TLS/JA3、HTTP/2 指纹（**尚未打补丁**）。
7. UA-CH、时区/语言、屏幕、WebRTC、AudioContext。
8. 与上游 `--fingerprint-*` 同时开启时的优先级（当前策略：未设置即完全回退上游）。
9. 逐 profile 种子不串号；同一 profile 重启后稳定。
10. 反检测基线站点（browserleaks、creepjs 等）升级前后 A/B 对比。

## 已知限制

- 只覆盖 WebGL 字符串与 ClientRects 抖动，离“完整超越比特”还很远。
- 未处理 GPU/浏览器进程侧的一致性泄漏（ANGLE、GL 实现信息可能从其他路径暴露）。
- 尚未编译验证；补丁的 include 与类型转换需在首次真机构建时确认。
- 没有自动化指纹回归套件；上面的清单目前是人工验收项。
