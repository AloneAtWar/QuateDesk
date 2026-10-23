# 直接选择主题

2026-10-23，测试构建：`0.6.16-test (themes-direct)`。

- 删除应用方式、主题分类和预览确认操作；点击即切换并保存。
- 原生测试版连续选择街区信号、等高线；确认配置保存、渲染器重载后保留，以及实际浮窗主题同步。结果见 `direct-selection-results.json`。
- 浏览器演示中验证复制主题、名称、材质、数字字体和圆角的自动保存，以及导入文件后直接应用。
- 远程网页验证选择后写入当前站点存储、重载后保留；模拟存储失败时保留原主题、显示错误，恢复存储后重试成功。
- 桌面与远程网页截图分别为 `direct-selection-desktop.png`、`direct-selection-remote.png`；两张均为桌面浏览器视口。本轮未重新验证 Android 原生界面。
- `node --test tests/themes.test.js`：6 项通过；`npm run build` 和 Windows portable 测试包构建通过。

本轮验证后恢复测试版原有外观与浮窗开关，并打开外观设置。
