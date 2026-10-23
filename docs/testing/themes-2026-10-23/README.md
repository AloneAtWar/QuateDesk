# 主题系统验证 · 2026-10-23

交付版本：`0.6.16-test (themes-2026-10-23)`，Windows 便携测试构建，独立 `Quota Desk Test` 数据目录，禁用正式更新通道。

## 自动检查

- `node --test tests/themes.test.js tests/browser-demo.test.js tests/import-export.test.cjs`：21 项通过。覆盖外观迁移、系统亮暗组合、主题回退、自定义主题继承与 JSON 往返、输入校验，以及原有演示和备份流程。
- `node --check electron/main.cjs`、`node --check electron/themes.cjs`、`git diff --check`：通过。
- `npm run dist:test -- --config.extraMetadata.qdTestBuildLabel=themes-2026-10-23`：生产构建和 Windows portable 打包通过。Vite 提示主 JS 包大于 500 KB，gzip 约 172 KB。
- Android `gradlew.bat :app:assembleDebug`：通过。没有进行手机安装或真机视觉验收。

## 浏览器走查

使用真实 React 页面和现有 demo 数据，分别在 1200×844 与 390×844 检查全部 21 款内置主题（42 次）：桌面四列、手机两列、账号数量及额度窗口数量不变、圆环保持正圆，卡片内容没有横向裁切。记录见 `final-layout-results.json`。

航站时刻的翻牌装饰让 `documentElement.scrollWidth` 比视口多 2px（390 时读数为 392），但 body 宽为 390，没有未被裁剪的越界元素，也没有可横向滚动的页面。检查保留了原始指标；这项为装饰造成的误报，不通过给 body 增加 overflow 来掩盖，以免破坏现有粘性顶栏和底部队列。

实际操作通过：

- 预览 → 取消、预览 → 应用、关闭设置时撤销未保存的预览。
- 内置主题复制后，原有字体、圆角及圆环颜色不变；编辑并取消不改写已保存的自定义主题。
- 参数主题导入 → 应用 → 刷新恢复；导出文件再导入保持同一 ID，不重复创建。
- 非法颜色／资源注入文件被拒绝，当前主题不变。
- 系统亮暗切换分别使用「等高线」与「街区信号」。
- 桌面模拟磁盘写入失败：原设置仍为等高线，航站时刻停留在预览，错误可见，草稿保留，可取消或重试。
- 网页模拟浏览器存储写入失败：旧存储不变，预览与重试入口保留。
- 旧 Android 的 `__qdSetTheme` 兼容调用不会改写网页自己的主题选择。

截图使用匿名演示账号，不包含实际桌面账号数据：`desktop-contour.png`、`desktop-street.png`、`desktop-theme-library.png`、`mobile-street.png`。`custom-map.qdtheme` 可用于手动导入验证。

## 实际 Electron 窗口

运行 `node scripts/check-theme-windows.cjs 9339`，连接显式启动的本地测试构建。确认版本带 `-test` 后，通过设置页选择等高线，验证保存、浮窗主题及重新加载。浮窗实测为 284×47，使用等高线的 `#e9eadb` 背景。结束时恢复测试前的外观与浮窗可见性，并打开外观设置。结果见 `native-results.json`；未输出或截图实际账号数据。

本轮为实现与自行走查，未做独立视觉评审。Android 修改在独立仓库的 `codex/theme-system` 分支，网页主题资源仍只维护在桌面仓库。
