# 南孚浏览器 Chromium 迁移

## 当前状态

本分支仅记录迁移需求；尚未导入 Chromium 源码、实现功能、完成构建或生成安装包。Firefox 现有代码保留在 feature/tab-fingerprint 和 release/nanfu-baseline。

## 目标

- 使用 Chromium / Blink 内核，Windows x64 优先，保留 Chrome 扩展支持。
- 浏览器内置多账号隔离、树形标签页、验证码辅助入口和右键整页翻译。
- 标签页绑定独立指纹，刷新轮换为每标签页开关，默认关闭；IP 轮换由插件负责。
- 对会话恢复、拖动、跨窗口、Worker、代理和扩展组合进行实际测试。

## 技术与构建限制

- Firefox Multi-Account Containers 依赖 Firefox 容器能力，Chromium 没有可直接使用的同等 API；需设计隔离架构和验证数据、网络及 Worker 边界。
- Tree Style Tab 依赖 Firefox 扩展接口；需适配或重新实现树形界面。
- Buster 有 Chromium 版本；集成前核查许可证、依赖、更新方式、权限及可用性。
- Chromium 不自动包含 Google Chrome 专有服务；翻译功能需确认翻译引擎及服务。
- 构建需要适用的 Windows 构建机、足够磁盘和联网；来源、版本、许可和依赖须固定并保留。

## 验收

安装并启动；多账号存储隔离；树形标签页及恢复；右键实际网页翻译；验证码辅助；每标签页指纹及开关；代理插件与扩展兼容；退出重启恢复；分发安装包及完整可复现源码。所有项目均尚未验证。
