# Quota Desk Data Access API v1

`/api/v1/*` is a read-only JSON interface provided by the desktop app for **local or LAN agents/scripts**, used to answer analytical questions like "analyze my current usage", "how did I use it today", "token consumption over a recent period". It shares the same port and token system as the remote viewing web page (the old `/api/*` contract remains unchanged and is dedicated to the remote page / Android App; v1 is a separate contract).

- All endpoints are **GET only**; the interface never exposes credentials, conversation content, or absolute paths.
- On the same machine, an agent can obtain a token directly from the loopback address without a pairing code (see below); LAN / other machines need to use a pairing code to pair as a "device".

## Enabling and Authentication

The API is provided by the "Remote Viewing" service. Enable and set the port in the desktop app's **Settings → Remote Viewing** (default `43187`).

```bash
# 1. Obtain a local token from the same machine (loopback, no pairing code required; valid until process restart)
TOKEN=$(curl -s -X POST http://127.0.0.1:43187/api/pair \
  -H 'Content-Type: application/json' -d '{"localPreview":true}' | sed -E 's/.*"token":"([^"]+)".*/\1/')

# 2. Carry the token to access any v1 endpoint
curl -s -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:43187/api/v1/meta'
```

For access from other devices, use the pairing key shown in the desktop settings `POST /api/pair` (see the remote viewing section in the README). There are two token scopes: `local` (obtained from the loopback local preview) and `device` (a paired device). The only difference in data visibility between the two: **the directory names of `breakdown?by=project` are shown only to `local`**; `device` sees only hash keys.

## Unified Time Parameters

The following data endpoints share the same set of time parameters, with the priority **`date` > `from`/`to` > `last` > endpoint default**; passing multiple simultaneously will only take the one with the highest priority, and the effective interval is echoed in `query`; no error is reported.

| Parameter | Form | Semantics |
| --- | --- | --- |
| `date` | `2026-10-14` | A single natural day (local timezone midnight to next-day midnight) |
| `from` / `to` | `2026-10-01T09:30:00Z` or `2026-10-14T09:00` or `2026-10-14` | Left-closed, right-open interval; if `to` is omitted, it means up to the current moment; a `to` without `from` is invalid. A `to` given as a pure date includes that entire day |
| `last` | `12h` / `30d` | Relative to the current moment, supporting only hours/days |
| `tz` | `Asia/Shanghai` | Optional; defaults to the host timezone; affects the interpretation of `date` and timestamps without offsets; the actual timezone used is echoed |

Constraints: the interval can be a maximum of **400 days** (exceeding returns `400`); `granularity=hour` with an interval exceeding 7 days (or when the source is an official channel) is automatically downgraded to `day` and an explanation is written into `coverage.issues`. When `date` is used, "today" is the local date — when the agent is unaware of the local date, it should first query `now` from `/api/v1/meta`.

## Response Envelope and Errors

Every data endpoint response contains:

```json
{
  "query":     { "date": "2026-10-14", "timezone": "Asia/Shanghai", "from": "…", "to": "…", "kind": "date" },
  "generatedAt": "2026-10-14T09:30:12.000Z",
  "coverage":  { "complete": true, "issues": [] },
  "…data body…"
}
```

`coverage.complete=false` indicates that there is earlier data outside the interval (the interval only covers part of the history) or the data has partial gaps; `issues` is a human-readable explanation array. Error responses are unified as `{"error": code, "message": "…", "param": "…"(optional)}`:

| Status | error | Scenario |
| --- | --- | --- |
| 400 | `invalid_param` | Invalid parameter value (with `param` indicating the parameter name) |
| 401 / 421 | `unauthorized` / `host_not_allowed` | Missing/invalid token, Host not in the whitelist |
| 404 | `account_not_found` / `not_found` | Account does not exist / unknown endpoint |
| 405 | `method_not_supported` | Non-GET requests |
| 409 | `usage_not_connected` | Official usage not connected (DeepSeek / Z.ai / Codex / MiniMax support it) |
| 502 | `cli_usage_unavailable` / `usage_unavailable` | Local usage service abnormal / official usage query failed |

## Endpoint List

### Dictionary Layer (enumerating valid filter values)

**`GET /api/v1/meta`** — No parameters.Returns `version`, `timezone`, `now` (server current time), `freshness.quota` (lastSync/pollMinutes), `freshness.cliUsage.lastScanAt`, `endpoints` (endpoint catalog). **It is recommended that agents call this first with each new session** to calibrate time and data freshness.

**`GET /api/v1/accounts`** — No parameters.Account array: `id, name, providerId, providerName, status, authStatus, disabled, tags, windowKeys, wasteWindows, usageSupported, usageStatus, lastChecked`. The `account` parameter values for all endpoints come from here.

**`GET /api/v1/agents`** — No parameters.Local CLI array: `key, displayName, status, records, files, warning, lastScannedAt, typicalProvider`. `typicalProvider` is a heuristic "vendor typically corresponding to this CLI" (`zcode→zai`, `codex→codex`…; `null` when it cannot be determined), used only to help you associate the account side with the local usage side. The `agent` parameter values come from here.

### Quota Layer

**`GET /api/v1/quota/snapshot`**

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `account` | No | All accounts | Filter a single account |

Returns the current values of all windows for each account: `windows[]` with `key` (such as `five_hour`/`weekly`/`balance`), `unit`, `remaining`, `used`, `total`, `amount`, `limitAmount`, `resetAt`, `available`. Sorting, "which one expires first", and other decisions are made by the agent itself.

**`GET /api/v1/quota/history`**

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `account` | **Yes** | — | Account id |
| `window` | No | All windows for that account | Filter a single window key |
| Time parameters | No | `last=7d` | Local actual retention is 7–90 days |
| `points` | No | 400 (10–800) | Sampling cap; when exceeded, equal-distance sampling is performed and marked with `sampled: true` |

Each point has shape `{ at, windows: { [key]: { remaining, amount, limit, unit, resetAt } } }`.

### Usage Layer (`source=local` local CLI / `source=provider` official per-day)

The three endpoints share the same set of filter parameters:

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `source` | No | `local` | `provider` must include `account`, and that account must have official usage connected |
| `account` | Required for provider / prohibited for local | — | Official usage is queried per account; local usage has no account dimension |
| `agent` | No | All | Comma-separated multiple values; only local (`zcode,kimi,…`) |
| `model` | No | All | Comma-separated; local is canonicalized for matching (case-insensitive, prefixes stripped); the literal value `unknown` represents models with no model name |
| `project` | No | All | Project hash keys (see breakdown), comma-separated; `unknown` represents events without a project |
| Time parameters | No | `last=7d` | See unified time parameters |
| `refresh` | No | `false` | provider only: bypass the 2-minute cache and force a re-fetch |

**`GET /api/v1/usage/series`** also has `granularity=day`(default)`|hour`(local only).Returns `buckets[]`: local has shape `{ t, startMs, tokens:{total,input,output,cacheRead,cacheWrite,extra}, requests, sessions }`; provider has shape `{ t(=date), tokens:{total}, cost, currency, requests }`.Buckets are capped at 480; when exceeded, equal-distance sampling is performed and marked with `sampled`/`originalBuckets`.

**`GET /api/v1/usage/summary`** returns `range` (totals for the interval, `activeDays`, `peak`, `currentStreakDays`/`longestStreakDays`, `cacheReuseRatio = cacheRead / (input + cacheRead + cacheWrite)`) and `allTime` (cumulative values under the same filter conditions).**The two are named separately; never mix them up.**

**`GET /api/v1/usage/breakdown`** also has:

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `by` | No | `model` | `model` / `agent` / `project`; the latter two are local only |
| `top` | No | 15 (1–100) | Beyond this they merge into one `other` row (at this point `sessions`/`requests` are the sum of each row and may double count) |

Each row has shape `{ key, displayName, agents[], tokens{…}, requests, sessions, share(0–1 interval share), firstAt, lastAt }`. `by=project`'s `key` is the hash of the working directory (stable and comparable, but not reversible); **`displayName` (directory name) is returned only for local tokens**. "Which model was used today/over a recent period" is `by=model` + time parameters.

### Waste Layer

**`GET /api/v1/waste`**

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `window` | No | All waste windows | Only `weekly` / `monthly` are allowed |
| `account` | No | Aggregate view | Passing it returns that account's cycle-by-cycle details |
| Time parameters | No | `last=31d` | Filtered by cycle end time `end` |

Measurement (consistent with the desktop waste view): each cycle counts its own total quota as 1 share, `totalWasteShares = Σ remaining/100`; **only cycles with `reliable=true` and `kind=natural` are counted toward the average** (`averageRemaining`, unit %), cycles ending early / being unreliable are only included in the cycle count. When `account` is passed, each account also includes a `cycles[]` detail row (`counted` marking whether it is counted in statistics).

## Common Q&A Call Chains

```bash
# "Analyze current usage"
GET /api/v1/quota/snapshot
GET /api/v1/usage/summary?last=1d

# "Analyze today's usage" (hourly rhythm + composition + 7-day baseline)
GET /api/v1/usage/series?granularity=hour&date=<today>&tz=<tz>
GET /api/v1/usage/breakdown?by=model&date=<today>&tz=<tz>
GET /api/v1/usage/summary?last=7d

# "Token consumption over the last 30 days" (trend + composition)
GET /api/v1/usage/summary?last=30d
GET /api/v1/usage/series?last=30d
GET /api/v1/usage/breakdown?by=agent&last=30d
GET /api/v1/usage/breakdown?by=project&last=30d
```

## 配套 CLI

仓库提供零依赖的查询 CLI `cli/quate-desk.mjs`(Node 18+),子命令与本接口一一对应,底层就是对 `/api/v1/*` 的 HTTP 调用,输出 JSON。给 agent 用时配合 `skills/quate-desk/SKILL.md`(教会 agent 何时调哪个命令、口径与坑)。

```bash
node cli/quate-desk.mjs meta                       # 每次会话先调:校准时间与新鲜度
node cli/quate-desk.mjs snapshot
node cli/quate-desk.mjs breakdown --by project --last 30d
node cli/quate-desk.mjs raw '/api/v1/usage/series?granularity=hour&last=12h'
```

CLI 会自动从回环地址免配对换取只读令牌(仅进程内使用、不落盘),端口从应用数据目录的 `remote-access.json` 发现(可用 `--url` / 环境变量 `QUATEDESK_URL` 覆盖,`--token` / `QUATEDESK_TOKEN` 可显式指定令牌)。完整命令与参数说明见 `node cli/quate-desk.mjs --help`。

## Semantics and Caveats

- **Token composition**: `total` is the authoritative total (when the vendor provides it); `input+output+cacheRead+cacheWrite` are the classified parts; the difference goes into `extra`; `total ≥ classified sum` may hold. `reasoning` is a subset of output and is not exposed separately in v1.
- **Sessions**: number of distinct sessions deduplicated per bucket/interval; local usage HMACs session keys.
- **Two-axis queries** (e.g., "per day × per model"): v1 does not provide them; combine them yourself via `series?model=X` called multiple times or `breakdown?date=` day by day.
- **provider data boundaries**: DeepSeek/Z.ai/Codex/MiniMax only; the official side is day-by-day and vendor timezones may be inconsistent with the query timezone (see `coverage.issues`); Z.ai model detail only covers the last 60 days; requests with `refresh=1` will be slower.
- **Local usage is only for this machine**, does not represent account usage on other devices; when `agents[].status` is not `ready`, that channel's data may be incomplete.
- **Hour buckets** are fixed-width by local wall-clock; DST transition days are shifted, for display/analysis purposes only.
- The quota history endpoint returns empty beyond the actual retention days; local usage covers approximately the last year (depending on CLI local files).
