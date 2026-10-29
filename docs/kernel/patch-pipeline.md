# 内核补丁流水线：从想法到出货

> 本文只描述**已经存在**的链路（`kernel/apply-patches.sh` + `.github/workflows/kernel-patches.yml`）。
> CI 只证明补丁对钉住版本“能 apply / 能 reverse”，**不编译、不证明行为正确**。

## 0. 一句话原则

**钉死一个上游 tag，在其上维护一条有序补丁序列；每次升级都是一次显式 rebase，而不是“跟着分支走”。**

- 版本锚点：`kernel/pinned.json` → `refs/tags/155.0.8059.85` / `0e66b94549a8bd85f03fbdf189b752d6e7b63c32`
- 补丁目录：`kernel/patches/`
- 应用顺序：文件名数字前缀
- 验证：`.github/workflows/kernel-patches.yml`（仅 `workflow_dispatch`）

## 1. 为什么不能在滑动分支上做

不能拿 `main`/`refs/heads/main` 这类会移动的分支当补丁基底：

| 约束 | 数字 | 后果 |
| --- | --- | --- |
| Chromium 全量检出 | 约 100GB（`--no-history` 仍约 25GB） | 托管 runner 装不下；本地磁盘和网络成本高 |
| 全量构建 | Windows 冷构建 4–8 小时，增量 10–40 分钟 | 每次上游提交都重建不可接受 |
| 上下文稳定性 | 上游每天数百次提交 | 滑动分支上补丁上下文天天漂移，`git apply` 随时失效 |
| 可复现性 | 同一 tag + 同一序列 → 同一树 | 滑动分支无法回答“这个包到底是哪个提交加哪些补丁” |
| 审计 | 每个补丁独立可读 | 滑动分支上 rebase 会把多个补丁搅在一起 |

因此：

- **基底永远是 tag**，不是分支；
- 上游吸收或升级时，**新建一次 rebase 提交**，更新 `pinned.json`，重放补丁，重跑 CI；
- 不在旧 patch 上“套”新上游，也不为了通过而扩大上下文。

## 2. 命名与目录

```
kernel/
  pinned.json
  apply-patches.sh
  patches/
    0001-add-webgl-vendor-renderer-switches.patch
    0002-add-client-rects-jitter-seed.patch
    0003-tls-enable-server-handshake-padding.patch
```

- 文件名：`NNNN-<动词>-<主题>.patch`，四位数字、小写 kebab-case，**一个补丁只做一件事**。
- 编号即顺序；补丁内路径相对 Chromium 源码根（`a/`、`b/`）。
- 补丁必须由 `git diff` 从真实文件生成，带完整 `diff --git` 头；不接受手写 hunk。
- 新命令行开关统一放 `third_party/blink/public/common/switches.{h,cc}`，由
  `RenderProcessHostImpl::PropagateBrowserCommandLineToRenderer()` 的 `kSwitchNames`
  转发到 renderer；未传开关时行为必须与上游完全一致。
- 跨进程（browser/gpu/network）的开关要单独说明传播路径，不能假设 renderer 能看到。

## 3. 每个补丁声明适用上游版本

补丁头（`diff --git` 之前）至少写：

```
Applies-To: refs/tags/155.0.8059.85
Depends-On: 0002-add-client-rects-jitter-seed.patch   # 可选，仅在同文件/同符号依赖时写
Subject: [PATCH] <一句话说明改了什么、为什么>
```

- `Applies-To` 必须与 `pinned.json.chromium.source_ref` 一致；不一致的补丁不得进序列。
- `index <old>..<new>` 行保留，便于审查 blob 是否来自该 tag。
- 0001/0002 是上一轮产物，没有 `Applies-To` 头；它们的适用版本由 `pinned.json` 统一声明。**新补丁必须带头。**
- 0003 起，`Subject` 里写清“改哪个子系统、对齐什么行为”。

## 4. series 顺序

- 顺序 = 文件名字典序（`patches/*.patch` 自然排序），CI 和应用脚本都按此执行。
- `pinned.json.patch_series.order` 必须与目录内容**逐项一致**；加/删补丁时同步更新。
- 应用：正序 `--check` → `apply`；回滚：逆序 `--reverse --check` → `--reverse`。
- 两个补丁改同一文件的同一区域时，后一个必须在前一个之后；在 `Depends-On` 里写明。
- 不允许“为了排序而重命名历史补丁”；顺序变化必须作为独立提交，并重跑全序列。

## 5. 从想法到出货

| 步骤 | 动作 | 产物 / 门禁 |
| --- | --- | --- |
| 1 提案 | 写清要改的检测面、预期值、是否与上游重复 | issue/PR 描述 |
| 2 查重 | 在 `vendor/aliasmode-chromium/patches/series` 找同目标补丁 | 避免重复造轮子 |
| 3 钉版本 | 确认 `pinned.json` 的 tag 仍解析到记录的 commit | CI `Resolve pinned revision` |
| 4 取最小树 | 只取补丁要改的文件（`?format=TEXT`），**不拉全仓** | 临时目录 |
| 5 写补丁 | 从真实文件 `git diff` 生成；带 `Applies-To` / `Subject` | `NNNN-*.patch` |
| 6 本地自检 | `git apply --check`，再逆序 `--reverse --check` | 全绿 |
| 7 CI | 派发 `kernel-patches`，只校验 apply/reverse | run 绿 |
| 8 审查 | 过第 6 节清单 | 至少一人 |
| 9 构建 | 自建构建机编译、签名、打包（见 `kernel/README.md`「自建构建机要求」） | 安装包 |
| 10 回归 | 用 `docs/fingerprint-probe.html` 做前后对比；重点看稳定性与一致性 | 报告 |
| 11 出货 | 版本号、SHA256、补丁序列、pin 一起发布 | release notes（人工） |

> 第 9 步之前，任何补丁都只能叫“上下文正确”，不能叫“生效”。

## 6. 审查清单

每个补丁合并前逐项确认：

1. `Applies-To` 与 `pinned.json` 一致；`index` 行来自该 tag。
2. 只改必要文件；没有顺手重构、格式化、无关 include。
3. 未传开关时行为与上游**逐字节**一致（默认关闭 / 默认值不变）。
4. 新开关命名不与上游 `--fingerprint-*` 冲突；接线路径（browser → renderer/gpu/network）写清。
5. 同一值在所有查询点一致（例如 WebGL1/2、`UNMASKED_*`、worker、iframe）。
6. 不引入构建期代码生成、不新增第三方依赖、不改 GN 目标（除非必要且已说明）。
7. 不包含密钥、代理凭据、真实 IP、个人路径。
8. 正序 apply + 逆序 reverse 全绿；CI run 链接贴进 PR。
9. 同步更新 `pinned.json.patch_series.order`、`kernel/README.md`、`docs/kernel/patch-inventory.md`。
10. 写明回滚方式与已知副作用。

## 7. 上游吸收后如何下线

当上游（AliasMode 或 Chromium）自己实现了同一行为：

1. 在补丁头加 `Superseded-By: <上游补丁名或 commit>`，保留一个版本周期便于对照。
2. 单独提交从 `patches/` 删除，并同步 `pinned.json.patch_series.order`。
3. 重跑 `kernel-patches`（确认剩余序列仍 apply/reverse）。
4. 在 `docs/kernel/patch-inventory.md` 把对应行改为“上游已吸收”，更新证据。
5. 不保留“僵尸补丁”；历史由 git 保存，不靠目录里留旧文件。

## 8. Rebase 到新上游版本

1. 在 `chromium.googlesource.com` 确认新 tag 存在，记录 commit，更新
   `pinned.json` 的 `version` / `source_ref` / `source_commit` / `verified_at`。
2. 只取补丁涉及的文件，建最小树；**不拉全仓**。
3. 逐条重放改动，而不是硬套旧 patch；上下文漂移时手工移植，再用 `git diff` 重新生成最小 hunk。
4. 本地 `kernel/apply-patches.sh <src>` + 逆序 `--reverse --check` 全绿。
5. 派发 CI；绿后在自建构建机做一次真机构建与指纹回归。
6. 在 `patch-inventory.md` 记录“旧版本 → 新版本”的差异与新证据。

## 9. 失败与回滚

- **apply 失败**：不扩大上下文硬套；回到真实文件重新生成 hunk。
- **reverse 失败**：说明补丁之间有隐式依赖，补 `Depends-On` 或拆补丁。
- **构建失败**：先核对 include、命名空间、Blink WTF 类型转换；不要靠改 CI 绕过。
- **行为回归**：保留补丁但默认关闭，或整条回退；在 inventory 记录回退原因。
- **线上回滚**：发行包按 `pinned.json` 的 tag + 序列重建；不依赖“当时的分支状态”。

## 10. 边界

- CI runner 只有 20 分钟预算、装不下 Chromium，**只做 apply/reverse**。
- 真机构建、签名、公证、回归都在自建构建机完成；要求见 `kernel/README.md`。
- 本流水线不发布 Release、不改仓库权限、不改 workflow。
