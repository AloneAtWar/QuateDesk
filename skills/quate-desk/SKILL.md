---
name: quate-desk
description: 查询本机 Quota Desk(Coding Plan 额度监控桌面应用)的数据:各账号当前额度与重置时间、额度趋势、本机 CLI 用量(按天/按小时序列、按模型/CLI/项目分组)、官方逐日用量与周期浪费。当用户问到「额度还剩多少、哪个号快重置、分析一下用量、今天用了多少、最近 token 消耗、哪个模型/项目烧得多、额度浪费」等问题时使用。
---

# Quota Desk 数据查询

## 这个工具是什么

`cli/quate-desk.mjs` 是零依赖的只读查询 CLI(Node 18+),底层通过 HTTP 调用本机 Quota Desk 应用的 `/api/v1/*` 接口,**所有输出都是 JSON**,直接读取后自行分析、叙述,不要原样倾倒给用户。

```bash
node cli/quate-desk.mjs <命令> [--参数 值]
```

完整契约(参数语义、字段定义、注意事项)在 `docs/api-v1.md`,本 skill 只保留 agent 工作所需的最小集。

## 前置条件与故障排查

- 桌面应用 Quota Desk 必须**正在运行**,且已在「设置 → 远程查看」启用访问服务(默认端口 43187)。
- CLI 在本机运行会自动免配对换取只读令牌,无需任何凭据。
- 连接被拒(`无法连接 Quota Desk`)→ 应用未运行或未启用远程查看:告知用户如何开启,不要反复重试。
- 换令牌 403 → CLI 与应用不在同一台机器:改用 `--url` 指向远程地址并配合 `--token`(桌面设置里配对获得)。

## 每次会话的第一步

```bash
node cli/quate-desk.mjs meta
```

拿到 `now`(服务器当前时间,用来确定「今天」的本地日期)、`timezone`、`freshness`(额度 lastSync / 本机用量 lastScanAt)。**回答涉及"今天/现在"的问题前必须先调它**;`freshness` 落后很多时要在结论里注明数据截至时间。

## 命令速查

| 命令 | 用途 | 关键参数 |
| --- | --- | --- |
| `accounts` / `agents` | 枚举 `--account` / `--agent` 的合法取值 | — |
| `snapshot` | 当前额度(账号 × 窗口:剩余/百分比/重置时间) | `--account` |
| `history <account>` | 额度趋势序列 | `--window`、时间参数、`--points` |
| `series` | 用量时间序列 | `--granularity hour\|day`、`--source local\|provider`、`--agent/--model/--project`、时间参数 |
| `summary` | 区间汇总(峰值/连续天数/缓存复用率) | 同 series |
| `breakdown` | 分组排行(模型/CLI/项目) | `--by model\|agent\|project`、`--top N`、同 series |
| `waste` | 周期浪费(每周期按自身总额度记 1 份) | `--window weekly\|monthly`、`--account` |
| `raw '<path>'` | 逃生口:直接请求任意 v1 路径 | 路径含查询串 |

**时间参数**(三选一,优先级 `--date` > `--from/--to` > `--last`,默认各端点 `last=7d`、waste `last=31d`):
`--date 2026-10-14`(单个自然日)/ `--from <ISO> --to <ISO>`(右开,`--to` 缺省为现在)/ `--last 30d|12h`;`--tz` 缺省为宿主机时区。

## 常见问题的调用配方

**「分析一下目前的用量情况 / 额度还剩多少」**
```bash
node cli/quate-desk.mjs snapshot
node cli/quate-desk.mjs summary --last 1d
```
重点看:各窗口 `remaining`/`resetAt`(即将重置且剩余多的=浪费风险)、异常账号(`status: warning`)、今日消耗基线。

**「分析今天的使用情况」**(日期从 meta.now 取本地日期,替换 `<date>)
```bash
node cli/quate-desk.mjs series --granularity hour --date <date>   # 日内节奏
node cli/quate-desk.mjs breakdown --by model --date <date>        # 模型构成
node cli/quate-desk.mjs summary --last 7d                          # 近 7 天基线,自己算对比
```

**「最近一段时间的 token 消耗」**
```bash
node cli/quate-desk.mjs summary --last 30d
node cli/quate-desk.mjs series --last 30d
node cli/quate-desk.mjs breakdown --by agent --last 30d
node cli/quate-desk.mjs breakdown --by project --last 30d          # 项目=key 哈希,displayName 是目录名
```

**「哪个额度要浪费了」**
```bash
node cli/quate-desk.mjs snapshot        # 找 resetAt 临近且 remaining 高的窗口
node cli/quate-desk.mjs waste           # 历史浪费:averageRemaining 只统计可靠周期
```

**多值过滤**用逗号:`--agent zcode,claude`;`source=provider` 时必须给 `--account`(从 `accounts` 里取,且该账号 `usageSupported: true`)。

## 口径与坑(结论出错的高发点)

- `summary` 的 `range.*` 是区间值、`allTime.*` 是全量累计,**不要混用**;算环比/占比自己做(接口不代劳)。
- tokens 字段:`total` 为权威总量,`input+output+cacheRead+cacheWrite` 是分类部分,差额在 `extra`;`total ≥ 分类之和` 属正常。
- `--granularity hour` 仅本机数据、区间 ≤7 天(超限自动降级为 day,`coverage.issues` 会说明);官方渠道(`--source provider`)只有按天,且厂商日界时区可能不同。
- `coverage.complete=false` 表示区间只覆盖了部分历史;`coverage.issues` 里常有「Z.ai 模型明细仅近 60 天」这类口径说明,读一下再下结论。
- 本机用量(`source=local`)**只代表这台机器**,不是账号全端用量;`agents` 里 `status` 非 `ready` 的渠道数据可能不全。
- `breakdown` 超出 `--top` 的行合并为 `other`(此时 `sessions`/`requests` 是各行之和,可能重复计数)。
- `waste` 的份额单位是「周期总额度的倍数」(remaining/100),不是钱也不是 token。

## 输出处理建议

- CLI 输出已做体量控制(top-N、序列采样 `sampled: true`),但长序列仍可能很长:优先读 `summary`/`range` 块和 `rows` 前几行,不要把整段 JSON 复述给用户。
- 引用数字时标注区间与数据截至时间(来自 `query` 回显与 `generatedAt`/`freshness`)。
