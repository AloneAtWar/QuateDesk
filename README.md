# Quota Desk

一个运行在 Windows 桌面上的 Coding Plan 额度监控小工具：把各家 AI 编程订阅（Kimi、Z.ai、DeepSeek、XiaoMi MiMo、wlbclub 等）的额度集中到一个无边框小窗口里，同时提供一个悬浮桌面小控件随时查看。

## 功能

- **同心圆总览**：每个账号一张卡片，每个额度窗口一个环，内圈是小周期（5 小时）、外圈是大周期（7 天 / 1 个月 / 余额），圆心默认显示最小周期的剩余量，悬停某环可查看该环详情
- **三种视图**：同心圆 / 按账号行 / 按时间周期，随时切换
- **桌面小控件**：置顶悬浮条，支持拖动、双击展开主窗口、滚轮切换账号，账号名过长自动滚动
- **刷新提醒规则**：自定义"刷新前多久 + 剩余至少多少"的规则，命中时标记窗口并发送桌面通知
- **通用厂商适配**：新增厂商支持标准响应映射或高级脚本适配（脚本可声明变量，创建账号时按厂商变量填写）
- **隐私优先**：凭据只保存在本机，使用 Windows DPAPI 加密，额度请求全部从本机直接发出

## 技术栈

- Electron + React + Vite
- 无需安装，绿色便携（portable exe）

## 开发

```bash
npm install
npm test            # 运行轮询器单元测试
npm run desktop     # 构建并以桌面模式启动
npm run package:win # 打包便携版到 outputs/QuotaDesk-win32-x64
```

## 数据位置

- 运行状态与配置：`%APPDATA%\Quota Desk\state.json`
- 凭据（DPAPI 加密）：`%APPDATA%\Quota Desk\credentials.json`

## License

[MIT](LICENSE)
