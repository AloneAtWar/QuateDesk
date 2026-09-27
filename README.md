# Quota Desk

![Quota Desk logo](public/logo.png)

**把多个 Coding Plan 的额度放在一个桌面窗口里，及时发现即将刷新的剩余额度，减少周期性浪费。**

[![最新版本](https://img.shields.io/github/v/release/AloneAtWar/QuateDesk?display_name=tag&style=flat-square)](https://github.com/AloneAtWar/QuateDesk/releases)
[![License](https://img.shields.io/github/license/AloneAtWar/QuateDesk?style=flat-square)](LICENSE)

## 为什么需要 Quota Desk

当你同时订阅 Kimi、Z.ai、Claude、Codex、Gemini 或其他 Coding Plan 时，每个账号通常都有自己的额度周期：5 小时、7 天、1 个月，甚至按模型区分的额度桶。它们的刷新时间由订阅时间和首次使用时间决定，几乎不会完全同步。

这会带来一个很容易忽略的问题：某个周期快结束时，额度还剩很多，但你没有及时看到；周期刷新后，未使用额度被清零。几次周额度没有用满，也会进一步影响月度额度的实际利用率。切换工具可以帮助选择服务商，但它们通常不是为“集中观察额度、提醒即将浪费”设计的。

Quota Desk 专注解决这件事：把多个服务商、多个账号、多个周期集中到一个本地桌面应用里，用统一的视图查看剩余量、刷新倒计时和需要优先使用的账号。

## 核心功能

- **账号总览**：每个账号一张卡片，每个额度窗口用同心圆展示，剩余比例和刷新时间一眼可见。
- **行式明细**：按账号列出所有窗口，方便比较不同服务商的剩余量、已用量和刷新倒计时。
- **周期明细**：按 5 小时、7 天、1 个月等周期分组，并提供重置时间轴，快速找到最近要刷新的额度。
- **桌面浮窗**：像网速浮窗一样常驻桌面顶层，额度信息持续滚动；鼠标滚轮切换账号，双击展开主窗口，支持 80%–300% 等比缩放。
- **防浪费提醒**：自定义“刷新前多少分钟”和“至少剩余多少百分比”，命中时标记窗口并发送桌面通知。
- **亮色 / 暗色主题**：主窗口与桌面浮窗同步切换，下面的截图会固定展示两种主题。
- **多账号聚合**：同一服务商可以添加多个账号、标签和不同额度窗口，统一轮询更新。
- **cc-switch 导入**：扫描本机 cc-switch 数据，导入可识别的账号和 API Key；重复 Key 自动去重。
- **自定义服务商**：支持标准响应映射，也支持带变量的高级脚本；内置 New API 站点模板，填写站点信息即可接入兼容中转站。
- **自动更新与开机自启**：从 GitHub Releases 检查更新，也可以让应用随系统登录启动。
- **手机与其他电脑查看**：桌面端继续采集额度；浏览器通过只读页面查看相同的总览、行式明细、周期明细与额度历史。

## 界面截图

每个视图都同时展示亮色和暗色版本。点击图片可以打开原图查看细节。

### 同心圆账号总览

<table>
  <tr>
    <td align="center"><strong>亮色</strong><br><a href="docs/screenshot/ScreenShot_2026-08-22_205516_430.png"><img src="docs/screenshot/ScreenShot_2026-08-22_205516_430.png" alt="亮色主题的同心圆账号总览" width="100%"></a></td>
    <td align="center"><strong>暗色</strong><br><a href="docs/screenshot/ScreenShot_2026-08-22_205617_590.png"><img src="docs/screenshot/ScreenShot_2026-08-22_205617_590.png" alt="暗色主题的同心圆账号总览" width="100%"></a></td>
  </tr>
</table>

### 行式明细

<table>
  <tr>
    <td align="center"><strong>亮色</strong><br><a href="docs/screenshot/ScreenShot_2026-08-22_205532_899.png"><img src="docs/screenshot/ScreenShot_2026-08-22_205532_899.png" alt="亮色主题的行式明细" width="100%"></a></td>
    <td align="center"><strong>暗色</strong><br><a href="docs/screenshot/ScreenShot_2026-08-22_205624_871.png"><img src="docs/screenshot/ScreenShot_2026-08-22_205624_871.png" alt="暗色主题的行式明细" width="100%"></a></td>
  </tr>
</table>

### 周期明细与重置时间轴

<table>
  <tr>
    <td align="center"><strong>亮色</strong><br><a href="docs/screenshot/ScreenShot_2026-08-22_205544_888.png"><img src="docs/screenshot/ScreenShot_2026-08-22_205544_888.png" alt="亮色主题的周期明细和重置时间轴" width="100%"></a></td>
    <td align="center"><strong>暗色</strong><br><a href="docs/screenshot/ScreenShot_2026-08-22_205632_968.png"><img src="docs/screenshot/ScreenShot_2026-08-22_205632_968.png" alt="暗色主题的周期明细和重置时间轴" width="100%"></a></td>
  </tr>
</table>

### 桌面浮窗

<table>
  <tr>
    <td align="center"><strong>亮色</strong><br><a href="docs/screenshot/ScreenShot_2026-08-22_205602_960.png"><img src="docs/screenshot/ScreenShot_2026-08-22_205602_960.png" alt="亮色主题的桌面浮窗" width="100%"></a></td>
    <td align="center"><strong>暗色</strong><br><a href="docs/screenshot/ScreenShot_2026-08-22_205639_325.png"><img src="docs/screenshot/ScreenShot_2026-08-22_205639_325.png" alt="暗色主题的桌面浮窗" width="100%"></a></td>
  </tr>
</table>

## 支持的服务商与额度来源

| 服务商 | 额度窗口 | 连接方式 |
| --- | --- | --- |
| Kimi for Coding | 5 小时、7 天 | API Token |
| Z.ai / 智谱 | 5 小时、7 天、1 个月 | API Token |
| DeepSeek | 余额 | API Token |
| wlbclub | 1 天、7 天 | API Token |
| Grok / SuperGrok | 自动识别周期窗口 | 读取本机 grok CLI 登录状态 |
| MiniMax Coding Plan | 5 小时、7 天 | API Token |
| Claude Code | 5 小时、7 天 | 读取本机 Claude Code 登录状态 |
| OpenAI Codex | 5 小时、7 天、1 个月 | 读取本机 Codex CLI 的 ChatGPT OAuth 登录状态 |
| Gemini CLI | Gemini Pro、Flash、Flash Lite | 读取本机 Gemini CLI 登录状态 |
| New API 兼容站点 | 按站点接口配置 | 自定义服务商中的 New API 模板 |

Claude、Codex、Gemini 和 Grok 不需要在 Quota Desk 中重复填写 Token，但使用前需要先在对应 CLI 中完成登录。New API 是兼容站点模板，不限定某一个中转站域名。

### CLI 官方订阅的多账号监控

CLI 服务商默认跟随本机 CLI 的当前登录（适合单账号）。要同时监控多个官方账号（例如多个 ChatGPT 账号的 Codex 订阅），在设置 → 账号与凭据点击「导入本机 CLI 登录」，把当前登录保存为独立账号快照（Windows DPAPI 加密）；之后在 CLI 或 cc-switch 里登录 / 切换到另一个账号，再回来导入一次即可，同一登录会按账号指纹自动去重。

快照账号的额度查询不依赖本机当前激活的是哪个 profile——即使 cc-switch 把 `~/.codex/auth.json` 切换成中转配置也不影响；令牌会在临期或失效时用 refresh_token 自动续期并写回加密存储，若该账号恰好是本机当前激活的登录，续期结果还会安全地同步回本机 CLI 的凭据文件。设置抽屉的账号行会用「本机激活」徽标标出当前正在本机使用的账号。

## 快速开始

1. 从 [Releases](https://github.com/AloneAtWar/QuateDesk/releases) 下载对应平台的安装包。
2. 打开 Quota Desk，在设置中添加账号。API 服务商填写 API Token；CLI 服务商先完成对应 CLI 登录，或直接「导入本机 CLI 登录」。
3. 保存后应用会立即测试账号并开始轮询。根据自己的使用习惯设置轮询间隔和提醒规则。
4. 打开桌面浮窗，让额度信息持续显示在桌面上；需要集中查看时切换到总览、行式明细或周期明细。

### 在手机或另一台电脑上查看

1. 在主电脑的 Quota Desk「设置 → 远程查看」开启「启用局域网访问」。服务默认关闭；设置中可更改访问端口，并可关闭只读限制（默认只读）。开启后可在本机浏览器预览，也会列出主电脑的局域网地址。
2. 确保手机或另一台电脑能连接主电脑的局域网地址，然后扫描设置页二维码或复制配对链接。若系统防火墙拦截访问，需要允许设置中指定的端口通过。

手机和另一台电脑使用与桌面端一致的配色和主要视图：账号卡片、三种额度视图，以及账号历史里的趋势、官方用量和周期浪费页签；网页版隐藏设置页，账号管理仍在主电脑完成。趋势和浪费记录读取电脑保存的数据；打开官方用量页签时，电脑只为已连接的账号向厂商查询逐日用量，浏览器不会取得登录凭据。网页每分钟读取一次电脑保存的额度快照，切回页面时也会重新读取。主电脑睡眠、退出 Quota Desk 或离开网络后，远程数据无法更新。

服务开启后监听主电脑的网络接口，以便局域网设备访问；本机预览地址为 `http://127.0.0.1:<端口>/remote.html`。Quota Desk 提供网页当前已有的操作和配对鉴权，不配置 VPN、内网穿透或反向代理。当前网页没有账号或设置的写入功能；关闭只读不会开放网页尚不具备的编辑操作。需要从局域网外访问时，请在你选用的网络工具中将流量转发到本机的 `http://127.0.0.1:<端口>`；相关转发与 HTTPS 由该工具负责。局域网连接使用 HTTP，请只在可信网络中配对使用。配对链接包含访问密钥，请只发给自己的设备；若链接泄露，可在桌面设置中重置密钥。关闭局域网访问会停止本机服务。

### 从 cc-switch 导入

在设置中点击“从 cc-switch 导入账号”。应用会读取本机 `~/.cc-switch/cc-switch.db`，列出可以匹配到 Quota Desk 服务商的账号供选择。导入内容包含 API Key 与 Codex 官方 OAuth 登录（导入为独立账号快照，自动续期），凭据会由 Quota Desk 重新加密保存；重复的 Key / 登录不会重复导入，cc-switch 中无法匹配的自定义服务商需要手动配置。

## 下载与平台

每个版本的 Release 会提供：

- **Windows**：NSIS 安装版和便携版。
- **macOS**：Intel（x64）与 Apple Silicon（arm64）的 DMG / ZIP。
- **Linux**：AppImage。

## 隐私与数据

- Quota Desk 没有云端账号和后端服务，额度请求由本机直接发送到对应服务商接口。
- API Token 和脚本中的敏感变量使用 Electron `safeStorage` 加密后保存在本机；Windows 使用系统 DPAPI。
- 普通配置和加密凭据都保存在应用数据目录下：
  - Windows：`%APPDATA%\Quota Desk\state.json` 和 `%APPDATA%\Quota Desk\credentials.json`
  - macOS：`~/Library/Application Support/Quota Desk/state.json` 和 `~/Library/Application Support/Quota Desk/credentials.json`
  - Linux：`~/.config/Quota Desk/state.json` 和 `~/.config/Quota Desk/credentials.json`

## 开发

```bash
npm install
npm test            # 运行轮询器和额度解析测试
npm run dev         # 启动 Vite 网页开发模式
npm run dev:lan     # 启动可供同一局域网设备访问的网页开发模式
npm run desktop     # 构建并启动 Electron 桌面应用
npm run dist:win    # 构建 Windows 安装版和便携版
npm run dist:mac    # 构建 macOS 安装包
npm run dist:linux  # 构建 Linux AppImage
```

项目使用 Electron、React 和 Vite 构建，额度数据只在本机处理。

## License

[MIT](LICENSE)
