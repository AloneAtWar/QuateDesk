# 概念图生成记录

生成方式：Codex 内置 `imagegen`，以现有 `usage-dark.png`、`overview-dark.png` 为视觉参考。图片用于产品方案展示，不是最终实现截图。

## aggregate-dashboard.png

```text
Use case: ui-mockup
Asset type: high-fidelity desktop application feature mockup for a Chinese Electron app proposal
Primary request: create a new “本机用量” aggregate dashboard screen for the existing Quota Desk desktop app, visually matching the two reference screenshots exactly in density, rounded cards, typography scale, dark navy green background, thin teal borders, cyan and mint accents, and compact 520×470 desktop window proportions.
Scene/backdrop: a single flat front-facing app screenshot, no device frame, no perspective, no surrounding desk.
Composition/framing: preserve the reference title bar with “Quota Desk” at top left and compact utility icons at top right. The new local usage chart icon is active in the title bar. Main content is one rounded bordered panel with a header “本机 CLI 用量” and small subtitle “从本地会话日志汇总 · 刚刚更新”. On the upper right of the panel use a compact segmented control with exact Chinese labels “全部”, “ZCode”, “Kimi”, “Claude”, “Codex”; “全部” active.
Content: first row has four small summary cards with exact labels and believable values: “累计 Token 46.93 亿”, “今日 Token 2.08 亿”, “缓存复用 71%”, “活跃会话 128”. Below, title “近 30 天用量趋势” and small range pills “7天 30天 90天 全部” with “30天” active. Show a clean stacked vertical bar chart across 30 days using four restrained series colors: violet for ZCode, cyan for Kimi, coral for Claude, mint for Codex. Add a tiny legend with those four names. At the bottom add a slim selected-day detail card showing “09/22 合计 6416.32 万” plus four concise platform values. Add a compact “数据来源 4/4 正常” status at lower right.
Style/medium: polished native desktop SaaS UI screenshot, precise vector-like interface rendering, same component language as references.
Color palette: near-black green #0d1717, surfaces #142121 and #1a2929, borders #294040, cyan #55cbd3, mint #65dfa7, violet #9177e8, coral #e88268, off-white text.
Text (verbatim): “Quota Desk”, “本机 CLI 用量”, “从本地会话日志汇总 · 刚刚更新”, “全部”, “ZCode”, “Kimi”, “Claude”, “Codex”, “累计 Token”, “46.93 亿”, “今日 Token”, “2.08 亿”, “缓存复用”, “71%”, “活跃会话”, “128”, “近 30 天用量趋势”, “7天”, “30天”, “90天”, “全部”, “09/22 合计”, “6416.32 万”, “数据来源 4/4 正常”.
Constraints: match the reference app’s compact spacing and border radii; all text should be sharp simplified Chinese; coherent information hierarchy; accessible contrast; no browser chrome.
Avoid: gradients, glassmorphism, neon glow, oversized headings, marketing illustration, fake device frame, perspective, extra navigation sidebar, white background, illegible or invented text, watermark.
```

## kimi-detail.png

```text
Use case: ui-mockup
Asset type: high-fidelity desktop application feature mockup for a Chinese Electron app proposal
Primary request: create the single-platform detail state of the Quota Desk “本机 CLI 用量” dashboard, matching both reference images exactly. Show Kimi Code selected so the design demonstrates an individual platform result.
Scene/backdrop: one flat front-facing app screenshot, no device frame, no perspective.
Composition/framing: preserve the compact Quota Desk top title bar. Main rounded panel header says “本机 CLI 用量” with small subtitle “Kimi Code · 本地会话记录”. At upper right use the same segmented control with exact labels “全部”, “ZCode”, “Kimi”, “Claude”, “Codex”; “Kimi” active. Below it add four compact metric cards: “累计 Token 12.84 亿”, “新输入 1.92 亿”, “缓存读取 9.76 亿”, “输出 1.16 亿”. Add a small badge “缓存复用 76%”.
Main chart: title “Kimi Code · 近 30 天”, range pills “7天 30天 90天 全部” with “30天” active. Show a tidy stacked bar chart across 30 days with categories in restrained colors: fresh input dark cyan, cache read bright cyan, cache write violet, output mint. Legend exact labels “新输入”, “缓存读取”, “缓存写入”, “输出”.
Lower section: one selected-day bordered detail card with “09/22 Token 1689.43 万”, followed by “会话 7”, “模型 kimi-for-coding”, and a small source row “~/.kimi-code · usage.record · 已同步”. Include one small link-style button “查看数据来源”.
Style/medium: polished native desktop SaaS UI screenshot, precise vector-like interface rendering, same dark theme and density as Quota Desk references.
Color palette: near-black green #0d1717, surfaces #142121 and #1a2929, borders #294040, cyan #55cbd3, mint #65dfa7, violet #9177e8, off-white text.
Text (verbatim): “Quota Desk”, “本机 CLI 用量”, “Kimi Code · 本地会话记录”, “全部”, “ZCode”, “Kimi”, “Claude”, “Codex”, “累计 Token”, “12.84 亿”, “新输入”, “1.92 亿”, “缓存读取”, “9.76 亿”, “输出”, “1.16 亿”, “缓存复用 76%”, “Kimi Code · 近 30 天”, “7天”, “30天”, “90天”, “全部”, “缓存写入”, “09/22 Token”, “1689.43 万”, “会话 7”, “模型 kimi-for-coding”, “~/.kimi-code · usage.record · 已同步”, “查看数据来源”.
Constraints: compact 520×470 style desktop layout; sharp simplified Chinese; clear selected state; accessible contrast; coherent spacing; no sidebar.
Avoid: gradients, glassmorphism, neon glow, oversized headings, marketing illustration, fake device frame, perspective, white background, illegible or invented text, watermark.
```

## aggregate-heatmap-v2.png（上一版）

```text
Use case: high-fidelity desktop application UI mockup for a Chinese product design and engineering proposal.

Create a revised “本机 CLI 用量” screen for the existing Quota Desk desktop app. Match the supplied usage screen and first aggregate concept in dark navy-green colors, typography, borders, spacing, rounded cards and compact 520×470 logical window proportions. Keep the global title bar and show the fourth usage-chart icon active.

Replace the daily stacked bar chart and fixed provider tabs with: a compact collapsed multi-select button “全部渠道 4/4” with four colored dots and chevron; four summary cards “累计 Token 46.93 亿”, “今日 Token 2.08 亿”, “缓存复用 71%”, “活跃会话 128”; a two-option switch “热力图 / 模型拆分” with heatmap active; and a GitHub-style one-year daily calendar heatmap titled “近 1 年使用热力图”, labeled by months and weekdays.

At the bottom, show the selected date “09/22 合计 6416.32 万”, the top model chips “GLM-5.3 31%”, “kimi-for-coding 26%”, “Claude Sonnet 24%”, “GPT-5.6 19%”, a link “全部 12 个模型”, and source health “4/4 正常”. The screen must stay dense and readable with no sidebar, no fixed platform tabs, no daily bar chart, no browser chrome and no device frame.
```

## model-breakdown-v2.png（上一版）

```text
Use case: high-fidelity desktop application UI mockup for a Chinese product design and engineering proposal.

Create a second screen for the same Quota Desk desktop app, matching the existing dark UI and local CLI heatmap concept exactly in visual language, density, colors, typography, rounded panels, title bar, and compact 520×470 logical window proportions. This is the “本机 CLI 用量” global page with the fourth chart icon active and no sidebar.

Show a collapsed multi-select source filter “全部渠道 4/4”, four metric cards “区间 Token 8.42 亿”, “模型 12”, “缓存复用 71%”, “活跃会话 128”, and a “热力图 / 模型拆分” switch with model breakdown active. Add range pills “7天 / 30天 / 90天 / 1年” with 30 days active.

The main card is “模型用量排行”, subtitle “按所选渠道与时间范围汇总”. Show four ranked model rows: GLM-5.3 / ZCode / 2.61 亿 / 31%; kimi-for-coding / Kimi Code / 2.19 亿 / 26%; Claude Sonnet 4.5 / Claude Code / 2.02 亿 / 24%; GPT-5.6 / Codex / 1.60 亿 / 19%. Each row includes a horizontal stacked rail for “新输入”, “缓存读取”, “缓存写入”, “输出”. Add the four-part legend, “查看全部 12 个模型”, and “模型名称按渠道隔离统计”. Keep provider identity visually separate from Token component colors. No fixed provider tabs, no daily bar chart, no extra navigation rail, no browser chrome and no device frame.
```

## aggregate-heatmap-v4.png（上一版）

```text
Create the clean final heatmap companion screen for the Quota Desk model breakdown screen. Move “全部渠道” and “热力图 / 模型拆分” into the upper-right of the page header, using the same alignment and sizing as the model view. Remove the former toolbar row and move the four cards upward. Preserve “累计消耗 Token / 峰值消耗 Token / 当前连续 / 最长连续”, the yearly heatmap, selected-day Token total and fixed-height horizontal model scroller. Do not show dots, “4/4” or any view-all action. Fill the canvas with the application window and show no annotations or outer margins.
```

## model-breakdown-v4.png（上一版）

```text
Edit the Quota Desk model breakdown screen so its header controls use exactly the same placement as the revised heatmap screen. Put “全部渠道” and “热力图 / 模型拆分” in one compact line on the upper-right side of the page header, with “模型拆分” active. Remove the separate toolbar row and move “模型用量拆分” upward. Do not show any summary cards. Preserve the 7天 / 30天 / 90天 / 1年 selector, fixed-height vertically scrolling model table, token-composition rails, internal overlay scrollbar and bottom legend. Do not show dots, “4/4” or any “查看全部” button.
```

## aggregate-heatmap-v5.png（上一版）

```text
Reverse the two upper-right header controls: show “热力图 / 模型拆分” first with heatmap active, then “全部渠道” at the far right. In the selected-day model section, add an enabled “合并同名模型” switch shared with the model view. Demonstrate merged model cards with combined Token totals and contributing CLI names, while preserving the fixed-height horizontal scroller, four heatmap metrics and yearly calendar. Do not show dots, “4/4” or a view-all action.
```

## model-breakdown-v5.png（上一版）

```text
Match the revised header order: “热力图 / 模型拆分” first with model breakdown active, then “全部渠道” at the far right. Add an enabled “合并同名模型” switch next to the time-range selector. Demonstrate merged cross-CLI model rows with summed Token totals and contributing CLI names. Preserve the fixed-height vertically scrolling model table and Token-composition rails. Do not show summary cards or a view-all action.
```

## aggregate-heatmap-v6.png（当前方案）

```text
Add a fourth top-level “本机用量” bar-chart icon to the existing global view group, immediately after the period-detail clock and before settings, and show it active. Preserve the page header order `[热力图 / 模型拆分] [全部渠道]`, the four heatmap metrics, yearly heatmap, selected-day merge toggle and horizontal model scroller.
```

## model-breakdown-v6.png（当前方案）

```text
Add and activate the fourth top-level “本机用量” bar-chart icon in the app title bar. In the model section toolbar, move the enabled “合并同名模型” switch to the left of the period selector, making the exact order `[合并同名模型] [7天 / 30天 / 90天 / 1年]`. Preserve merged rows, fixed vertical scrolling and the page-header order `[热力图 / 模型拆分] [全部渠道]`.
```
