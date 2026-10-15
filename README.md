# Firefox 标签页指纹改造

完整 Firefox 源码已导入：[`import/firefox-release-7e92a9e429da`](https://github.com/ananan28/wangzhan211231/tree/import/firefox-release-7e92a9e429da/firefox)。上游固定提交为 `7e92a9e429dab30b7166890a7e778e3d1dd4cbeb`，许可证与第三方声明保留在源码中。

## 当前开发代码

- [指纹功能源码分支](https://github.com/ananan28/wangzhan211231/tree/feature/tab-fingerprint)
- [代码改动与验证：PR #1](https://github.com/ananan28/wangzhan211231/pull/1)
- [已实现范围与尚未解决的限制](https://github.com/ananan28/wangzhan211231/blob/feature/tab-fingerprint/TAB_FINGERPRINT_STATUS.md)
- [构建任务](https://github.com/ananan28/wangzhan211231/actions)

源码已加入标签页配置保存、默认关闭的刷新轮换开关，以及原生 Canvas/WebGL 随机化密钥接入；不是可用成品。状态逻辑的六项测试本地通过，原生编译、浏览器运行测试和插件兼容性仍待验证。当前没有 Windows/macOS 安装包。

IP 轮换由用户选择的插件管理。Firefox Multi-Account Containers 用于账号容器隔离，Tree Style Tab 用于标签页管理，Buster 用于验证码辅助；此项目未修改这些扩展，也未实现验证码处理。

## 说明

默认分支保存项目入口与构建说明，完整源码和开发改动在上面的分支中。请勿把之前未改动的基线任务当成指纹版本，也不要将真实代理密码或密钥提交到公开仓库。
