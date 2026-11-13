# @twinsearth/dsh-fang-contract

**瓮城 dsh-Fang ↔ 房主 dsh-Master 的独立版本化互联契约 SDK（contract 1.x）**

解决两个主插件“各自独立发布、接口演进后仍能互联互通”的底层问题：
不是靠互相 import，而是靠一份**可独立升级/替换的接口包** + 语义化版本协商 + 四级传输兜底。

```text
┌────────────────────┐        contract SDK        ┌────────────────────┐
│  dsh-Fang（瓮城）   │ ◄────────────────────────► │ dsh-Master（房主） │
│  mirror/essence/   │  local → http → file →     │  Router/Worker/    │
│  derived/forker    │  legacy（四级 fallback）    │  PM-PJM/cost       │
└────────────────────┘                            └────────────────────┘
         ▲ 双方都不 import 对方源码；只依赖本 SDK 的稳定接口
```

## 1. 设计目标

1. **独立**：dsh-Fang 与 dsh-Master 各有 package / 版本 / repo / 发布节奏；互不 import 内部代码。
2. **互通**：双方只通过本 SDK 的方法表 + 信封 + 传输层协作。
3. **可演进**：本包自身可独立升级（1.x → 1.y → 2.0），旧方法在 MAJOR 内不删义；
   双方版本不一致时由 `hello` 协商自动裁剪方法集。
4. **保底**：传输层按 `local → http → file → legacy` 降级；任何一层坏掉仍能通。
5. **可替换**：接口架构大改时，升本包 MAJOR + 双写 `method@old`/`method@new`，
   两侧逐步升级依赖；旧版 3.1.x 服务键（`fangForker` 等）作为最后兜底继续可用。

## 2. 版本与兼容承诺

| 变更类型 | 版本 | 规则 |
|---|---|---|
| 新增方法/能力/字段 | MINOR | 旧客户端忽略未知字段；新方法不在旧端方法集内即自动降级 |
| 修 bug、无行为变化 | PATCH | 双方可独立升级 |
| 删除方法、改语义、改信封结构 | MAJOR | 保留上一 MAJOR 方法 ≥1 个 MINOR 周期（双写），提供迁移说明 |

`hello` 返回 `protocol / contractVersion / role / instanceId / methods / capabilities / transports`；
`negotiate()` 输出 `{compatible, version, methods, capabilities, fallback}`：

- 对端 MAJOR 更高 → `remote-too-new` → 自动降级到 legacy 传输；
- 对端 MAJOR 更低 → `remote-too-old` → 自动降级；
- 同 MAJOR → 取双方方法交集 + 公共 minor 裁剪。

## 3. 方法表（1.1）

| 方法 | 用途 | 契约版本 |
|---|---|---|
| `contract.hello` | 版本/角色/能力协商 | 1.0 |
| `contract.health` | 健康检查 | 1.0 |
| `fang.fork.spawn` | 派生分身（等价 DerivedManager.spawn） | 1.0 |
| `fang.fork.stop` | 停止分身 | 1.0 |
| `fang.fork.list` | 分身列表 | 1.0 |
| `fang.decision.create` | 决策中心建票 | 1.0 |
| `fang.decision.resolve` | 决策中心处理票 | 1.0 |
| `fang.session.list` | 会话目录 | 1.0 |
| `fang.orchestrator.status` | 编排器状态 | 1.0 |
| `fang.relay.publish` | **批量投递回流事件**（按 `event.id` 幂等，返回回执与游标） | 1.1 |
| `fang.relay.status` | **读取对端回流状态**（对端自报 peer/cursor/累计计数） | 1.1 |

### 3.1 回流接口（1.1 新增）

房主成本总线产生三类事件（`cost:event` / `cost:degraded` / `cost:substitution`），
需要**单向**投递给瓮城。1.1 之前方法表只有请求-响应式的 fork/decision/session，
缺一个批量、可去重、有回执的入口，因此新增两个方法：

```js
// 请求
{ "method": "fang.relay.publish",
  "params": { "batchId": "b-1", "taskId": "task_1",
              "events": [ { "id": "evt-1", "type": "cost:event", "at": 1730000000000,
                            "payload": { "kind": "ledger", … } } ] } }

// 响应 result
{ "ok": true, "batchId": "b-1", "accepted": 1, "duplicates": 0, "rejected": 0,
  "cursor": 1, "acceptedIds": ["evt-1"], "peer": "dsh-fang-bundle", "at": 1730000000000 }
```

规则（服务端必须遵守，客户端据此对账）：

1. **幂等**：同一个 `event.id` 重复投递只接受一次，其余计入 `duplicates`，**不报错**；
2. **有界**：单批 ≤ `RELAY_LIMITS.maxBatch`（128），单事件 ≤ 32 KB，整批 ≤ 512 KB；
   超限是协议错误（`relay-events-invalid`），**不静默截断**；
3. **不丢账**：非法条目计入 `rejected` 并回到 `fang.relay.status().lastErrors`（有界）；
4. **游标**：`cursor` 单调递增，调用方可据此判断是否漏投；
5. **peer 自报**：`peer` 是接收端自己声明的标识（如 `contract-server` / `dsh-fang-bundle`），
   **不参与鉴权**，只用于房主侧记录“对端是谁”。

服务端（瓮城侧）挂载：

```js
import { createRelayContractServer } from '@twinsearth/dsh-fang-contract'

const { server, store } = createRelayContractServer({
  role: 'mother', instanceId: 'fang-mother-1',
  peerLabel: 'dsh-fang-bundle',      // 自报标识
})
// 与普通服务端一样挂 /fang/api/contract/{hello,invoke,health}
```

客户端（房主侧）：

```js
const receipt = await client.publishRelay({ batchId: 'b-1', events })
const relay = await client.relayStatus()
// relay.result.peer / relay.result.cursor / relay.result.accepted
```

**可用性判定**：1.0 的对端在 `hello` 里不会宣告这两个方法，
`negotiate()` 会按公共 minor 把它们裁掉；调用方看到方法集里没有
`fang.relay.publish` 就应如实报“回流不可用”，**不得**重试成假成功。

### 3.2 兼容矩阵

| 房主 contract | 瓮城 contract | `hello` 协商 | 回流 |
|---|---|---|---|
| 1.1 | 1.1 | `compatible`，方法含 relay | ✅ |
| 1.1 | 1.0 | `compatible`，relay 方法被裁剪 | ❌ 显式不可用 |
| 1.0 | 1.1 | `compatible`，relay 方法被裁剪 | ❌ 老客户端不调用 |
| 1.x | 0.9（legacy） | `fallback: legacy` | ❌ legacy 无此方法 |

信封：

```json
// request
{ "protocol": "fang-master", "protocolVersion": 1, "id": "req_…",
  "method": "fang.fork.spawn", "params": {…},
  "meta": { "at": 0, "deadline": 0, "source": "master", "instanceId": "…", "idempotencyKey": "…" } }

// response
{ "protocol": "fang-master", "protocolVersion": 1, "id": "req_…",
  "ok": true, "result": {…}, "meta": {…} }
```

错误码：`invalid-envelope / unsupported-method / unsupported-version / contract-incompatible /
transport-unavailable / transport-timeout / transport-http-error / remote-error /
all-transports-failed / handler-threw`。

## 4. 传输层与保底顺序

| 优先级 | 传输 | 场景 | 失败后 |
|---|---|---|---|
| 1 | **local** | 同一 Host，DSH 服务 `fangContract` | → http |
| 2 | **http** | 母体/原身 HTTP 契约端点（Bearer token） | → file |
| 3 | **file** | 同一文件系统 outbox/inbox（HTTP 被拦/进程重启窗口） | → legacy |
| 4 | **legacy** | 直接调用 3.1.x 旧服务键（`fangForker` 等） | 明确失败 |

- 传输超时/HTTP 非 2xx/不可用 → 自动下一层；
- **业务错误不降级**（例如 `ticket-invalid`），避免重复副作用；
- `unsupported-method` / `unsupported-version` / `retryable` 错误 → 下一层；
- 每次尝试记录在 `router.attempts()`，状态可观测；
- file fallback：请求写 `requests/<id>.json`，对端写 `responses/<id>.json`，原子 rename + 超时清理。

HTTP 端点（由瓮城/房主插件挂载，路径固定）：

```text
POST /fang/api/contract/hello     → hello payload
POST /fang/api/contract/invoke    → 标准 request envelope → 标准 response envelope
GET  /fang/api/contract/health    → {ok, role, version}
```

## 5. 用法

### 瓮城（服务端）

```js
import { createContractServer, METHODS } from '@twinsearth/dsh-fang-contract'

const server = createContractServer({
  role: 'mother',
  instanceId: 'fang-mother-1',
  handlers: {
    [METHODS.FORK_SPAWN]: async (params) => fangForker.spawn(params),
    [METHODS.DECISION_CREATE]: async (params) => decisionCenter.create(params),
    [METHODS.SESSION_LIST]: async (params) => sessionCatalog.list(params),
  },
})
// 挂到 webServer：/fang/api/contract/{hello,invoke,health}
// 同时 ctx.effect(() => ctx.provide('fangContract', server))
```

### 房主（客户端）

```js
import { createContractClient, METHODS } from '@twinsearth/dsh-fang-contract'

const client = createContractClient({
  ctx, // 有 fangContract 服务则优先 local；无则 legacy
  config: {
    httpBaseUrl: 'http://127.0.0.1:60457', // 母体契约端点
    httpToken: process.env.DSH_MASTER_BRIDGE_TOKEN,
    fileDir: 'D:/ToFuture/contract-outbox', // 可选：文件兜底
  },
})

const hello = await client.hello()
const spawned = await client.spawnFork({ title: 'SuperAgent …', env: {…} })
```

## 6. 接口包升级 / 完全替换流程

1. **升本包版本**并发布（npm `@twinsearth/dsh-fang-contract@x.y.z`）；
2. 任意一侧先升级依赖（`^1` 内自动兼容；`2.0` 需显式迁移）；
3. 升级后的 `hello` 会协商并裁剪方法集；未升级的一侧继续用交集/legacy；
4. **大改接口**：同时提供 `method@1` 与 `method@2`（双写），双方逐侧切换；
5. 观察 `router.attempts()` / `describe()` 的 transport 命中与降级；
6. 旧 MAJOR 至少保留 1 个 MINOR 周期后删除，并升 MAJOR 说明迁移。

## 7. 安全

- HTTP 传输必须 Bearer token（`bridgeToken` / `httpToken`），常量时间比较；
- 信封/hello/状态接口不携带 key、token、SSH 私钥；
- file fallback 目录必须位于受控本机路径，权限由 OS 账户隔离；
- legacy 传输仅调用既有服务键，不扩大权限。

## 8. 与主包版本对应

| 瓮城 dsh-Fang | 房主 dsh-Master | contract |
|---|---|---|
| 3.1.14 | 3.2.2 | 未接入（直连服务键） |
| **3.1.15** | **3.2.3** | **1.0.x**（local/http/file/legacy） |
| 3.2.x | 3.2.x+ | 1.x 向后兼容 |
| 待接 1.1 | **3.3.1**（M5 回流） | **1.1.x**（+ `fang.relay.*`） |
| 4.0 规划 | 4.0 规划 | 2.0（双写迁移） |

## 9. 变更记录

### 1.1.0（2026-11-13）

- 新增回流方法 `fang.relay.publish` / `fang.relay.status` 与能力 `event-relay`；
- 新增 `createRelayStore` / `validateRelayEvents` / `relayHandlers` / `createRelayContractServer`；
- 传输层回灌房主侧已验证的加固：逐调用 `timeoutMs`/`meta` 透传、HTTP 定时器 `unref`、
  file 回执/请求文件的有界重试清理（Windows EPERM）、`httpHeaders` 可选透传；
- 方法版本裁剪规则不变：1.0 对端不会宣告 1.1 方法，`negotiate()` 自动裁剪。

### 1.0.0（2026-11-11）

- 首个版本化契约：方法表、信封、hello 协商、local/http/file/legacy 四级传输。
