# Changelog

Quota Desk 的版本更新记录。

## [0.3.1] - 2026-08-22

### 新增

- 新增 Grok、MiniMax Coding Plan、Claude Code、OpenAI Codex、Gemini CLI 的内置额度适配。
- 支持读取 Grok、Claude、Codex、Gemini 本机 CLI 的登录状态查询订阅额度，不需要在 Quota Desk 中重复填写凭据。
- 支持从本机 `~/.cc-switch/cc-switch.db` 导入 cc-switch 账号，可选择可识别的服务商，重复 API Key 自动去重，扫描过程中凭据只保留在主进程。
- 新增 New API 站点一键模板，包含接口地址、`accessToken` 和 `userId` 变量。
- 补齐内置服务商的官网入口和 Logo。
- 桌面浮窗支持 80%–300% 等比缩放，预览与实际缩放比例一致。

### 改进

- 优化服务商凭据过期或缺失时的错误提示，提供刷新或重新登录指引。
- 空状态页面增加直接导入 cc-switch 的入口，首次配置更顺畅。
- 更新弹窗将 Release HTML 说明转换为纯文本，并过滤自动生成的对比链接尾部。
- 增加 Grok 计费解析、cc-switch 凭据提取与服务商匹配、MiniMax 额度解析测试。
- 重写 README，补充产品定位、支持范围、安装说明，以及固定展示的亮色 / 暗色截图对照。

### 修复

- 修复开发模式下将 CommonJS 模板当作 ES Module 导入导致的白屏。
- 修复历史配置中的服务商 Logo 引用，并自动迁移到内置 Logo。
