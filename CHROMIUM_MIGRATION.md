# 南孚浏览器 Chromium 迁移

仓库：https://github.com/ananan28/wangzhan211231
开发分支：`feature/chromium-migration`

## 代码范围

- 已导入 AliasMode 桌面管理器和 AliasMode Chromium 补丁，分别位于 `vendor/aliasmode` 与 `vendor/aliasmode-chromium`。
- 管理器基于 Tauri、Bun 和 React；Chromium 运行时使用固定版本下载和校验。
- 本仓库不是完整 Chromium 上游源码 checkout。重建内核仍需按引擎仓库说明获取其固定的上游源码与构建依赖。
- 保留上游许可证、NOTICE 与来源信息。旧 Firefox 工作留在原分支。

## 已实现与已验证

- 管理界面显示南孚名称；可批量创建 1–100 个独立环境。环境不等于单个标签页。
- Windows 开发安装包曾成功构建、静默安装并通过启动存活检查；已安装管理器的 sidecar 曾实际启动 Chromium。
- 真实 Chromium 测试：两个环境 Cookie、本地存储相互隔离；不同种子 Canvas 输出不同；刷新输出稳定；退出重启恢复本地存储和各自 Canvas 输出。
- 同时多开两个 Chromium 环境的隔离测试通过：
  https://github.com/ananan28/wangzhan211231/actions/runs/40579090735
- 批量创建、代理相关定向测试与 TypeScript 类型检查通过：
  https://github.com/ananan28/wangzhan211231/actions/runs/40579090716
- HTTP 代理关闭后未观察到测试页面请求回退到直连：
  https://github.com/ananan28/wangzhan211231/actions/runs/40576175729
  此测试直接启动 Chromium，不证明全部管理器启动路径、SOCKS、DNS、WebRTC 或代理扩展均安全。

## 南孚开发安装包

安装包源码提交：`50d4b89007977d8cf1512435cfba7914a1684bfb`。

- 南孚构建覆盖配置：安装产品名称为“南孚浏览器”，应用标识为 `com.nanfu.browser`。
- 主窗口标题改为“南孚浏览器”。
- 南孚标识的应用阻止上游更新检查和安装，避免被上游安装器覆盖。
- 默认安装到 `%LOCALAPPDATA%\\Nanfu`，界面和快捷方式保留中文名称。已复现上游后台服务在中文安装目录下退出的问题；自定义中文安装目录仍不受本次验证覆盖。
- Windows 新安装包的编译、静默安装及启动后 15 秒进程存活检查通过。
- 构建地址：https://github.com/ananan28/wangzhan211231/actions/runs/40605311426
- 独立路径对照：同一品牌程序安装到英文目录后通过启动检查：https://github.com/ananan28/wangzhan211231/actions/runs/40605845335
- 这些检查证明开发包可以安装并启动，不证明全部浏览器功能、界面交互或扩展组合均已通过。

## 仍未完成

1. 当前隔离边界是独立浏览器环境/进程，不是同一窗口中每个普通标签页独立指纹或数据容器。
2. 每标签页“刷新更换指纹”开关、拖动与恢复绑定尚未实现。
3. 批量创建标签页、原生树形标签页、右键整页翻译尚未完成。
4. Buster、代理轮换扩展和整套 Chrome 扩展兼容性尚未实测；不自动安装或代用户启用验证码辅助。
5. Worker、Service Worker、IndexedDB、CacheStorage、并行窗口和扩展组合隔离尚未完整验证。Canvas 测试不能代表全部指纹面。
6. 安装器仍携带上游 Firefox 运行组件，因为上游管理器启动校验仍依赖它。删掉组件前必须修改准备、编译和启动流程并验证，不能称为纯 Chromium 安装包。
7. 浏览器内核自身图标、名称和全部上游界面尚未完成南孚品牌替换。
8. 暂无南孚签名自动更新服务；开发包未做代码签名，不是最终发行版。
9. 全量上游测试和旧 baseline 构建流程未全部修复。定向测试通过不等于整个仓库所有 CI 通过。
10. 尚无满足全部目标并完成验收的最终安装包。

## 交付标准

Windows 实际安装启动；管理器打开 Chromium；多环境同时运行及重启恢复；按确认的隔离边界实测存储和网络；支持固定代理且不默认自动轮换；扩展组合实测；批量标签页、树形标签页、整页翻译与逐标签页开关完成；提供对应源码版本、安装包及 SHA256。不得以状态测试代替浏览器运行验收。
