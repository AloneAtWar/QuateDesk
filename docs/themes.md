# 主题与自定义主题

实现：`src/themes/`；设计来源：`docs/designs/themes-2026-10-17/round-06-current-ui/`。

## 使用

桌面进入「设置 → 外观 → 主题」。21 款内置主题包括现有默认亮暗和此前的 19 款设计主题。点击主题先预览，点击「应用主题」保存；取消、关闭设置或离开当前设置分类恢复原主题。账号布局、同心圆、所有额度周期、刷新队列及操作顺序由现有组件控制。

「固定主题」使用一个主题；「跟随系统」分别选择系统亮色和暗色时使用的主题。缺失、已删除或明暗不兼容的主题回退到默认亮色／暗色。旧 `theme: light/dark` 配置自动迁移，数据备份继续包含外观配置与自定义主题。

桌面浮窗、浮窗预览与主窗口使用同一个已应用的主题，包含背景、边框、芯片、字体及状态。浮窗大小和长度仍由原来的设置控制，主题不能改变自动轮换与内容收起顺序。

手机／浏览器顶部的调色板按钮打开「当前设备主题」。该网页选择保存在当前站点的浏览器存储中，不修改电脑主题。Android 原生设备列表另有跟随系统／亮色／暗色，进入网页后只调整系统栏图标，返回设备列表恢复原生外观；不在两层之间同步偏好。

## 自定义

从任一内置主题点击「复制并自定义」，可修改名称、材质、数字字体、颜色、圆环和卡片圆角。该主题继承基础主题的完整组件风格；默认两款适合从零开始。主题支持导入、编辑、删除和导出。导入后先预览，应用后才保存；错误文件不会替换当前主题。

`.qdtheme` 是 UTF-8 JSON 单文件，也接受 `.json`。最多保存 50 个自定义主题，每个文件不超过 500 KB。当前版本支持参数主题，不包含任意 CSS、脚本、外部字体或图片资源。字体使用系统已有字体；不需要另外维护桌面、浮窗和网页三份 CSS。

```json
{
  "schemaVersion": 2,
  "id": "custom-my-map",
  "name": "我的地图",
  "version": "1.0.0",
  "author": "作者",
  "extends": "contour",
  "mode": "light",
  "tokens": {
    "bg": "#f6eed9",
    "surface": "#fff9e8",
    "ink": "#183b32",
    "green": "#327968",
    "widget-bg": "#e4d9ba",
    "widget-chip-value": "#214e42",
    "ring-0": "#327968"
  },
  "shape": { "cardRadius": 12, "controlRadius": 5, "tagRadius": 3, "borderWidth": 1 },
  "typography": { "body": "Segoe UI,Microsoft YaHei,sans-serif", "numeric": "Consolas,monospace" },
  "material": { "preset": "paper", "shadowPreset": "soft" }
}
```

`extends` 必须是内置主题 ID，`mode` 与其明暗一致。`tokens` 省略的字段继承基础主题。颜色接受 `#RGB` 或 `#RRGGBB`，可带或不带 `--` 前缀。

| 目标 | 可覆盖的颜色参数 |
| --- | --- |
| 窗口／表面 | bg、bg-grad、surface、surface-2、surface-3、control、control-2、titlebar-bg、drawer-bg |
| 文字／边框 | ink、ink-soft、muted、faint、line、line-strong、line-inner、focus-border |
| 强调／告警 | green、green-deep、green-bg、coral、coral-deep、coral-bg、warn-border |
| 同心圆 | ring-track、ring-0、ring-1、ring-2、ring-3 |
| 浮窗 | widget-bg、widget-row、widget-row-border、widget-text、widget-chip、widget-chip-label、widget-chip-value、widget-chip-sub、widget-tag-bg、widget-tag-text、widget-live、widget-live-label |

材质支持 inherit、solid、paper、grid、glass、scanline；阴影支持 none、soft、offset-paper。形状圆角为 0–32px，描边为 0–3px；字体可指定 body、heading、numeric。旧设计稿中 `colors`、`charts.rings`、`widget.background/text` 也可导入，并转换为对应参数。

## 维护与验证

运行 `node scripts/prepare-themes.mjs` 从已确认的设计稿生成运行时内置主题。它保留主题的视觉样式，移除选择列数的规则，并降低样式作用域的优先级，让真实手机布局继续生效。默认主题变量来自当前 `src/styles.css`。生成的运行时文件独立于设计文档，打包不携带设计 HTML。

`tests/themes.test.js` 覆盖旧配置迁移、系统主题选择、主题丢失回退、全部内置主题的 Electron／渲染器底色一致性、自定义主题往返及非法输入。浏览器走查记录在 `docs/testing/themes-2026-10-23/`。
