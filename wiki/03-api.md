# 03 · 关键类型与函数参考

按模块归类。行号对齐 1.6.6 源码；签名用简化 TypeScript 表示。

---

## effort-bands.ts — 纯判定

### 类型与常量

```ts
type EffortBand = 'low' | 'medium' | 'high'
const BAND_LADDER: readonly EffortBand[]            // 冻结的 ['low','medium','high']

interface BandThresholds {                           // 五个可调阈值
  readonly trivialUserChars: number                  // ≤ 此字符数的提问仍算 trivial（上游 160）
  readonly trivialCtxTokens: number                  // ≤ 此估算 token 数的窗口仍算小（上游 4000）
  readonly heavyCtxTokens: number                    // ≥ 此估算 token 数 = 重活（上游 60000）
  readonly heavyToolResults: number                  // ≥ 此累计工具结果数 = 重活（上游 6）
  readonly heavyUserChars: number                    // ≥ 此提问字符数 = 重活（上游 4000）
}

const DEFAULT_THRESHOLDS: BandThresholds            // 上游常量原值（:55-61）
interface ShapedMessage { readonly role?: unknown; readonly content?: unknown }
interface BandEstimateFloor { readonly tokens?: number }   // contextFloorTokens 的载体
```

### 函数

#### `resolveBand(messages, thresholds?, floor?): EffortBand`（`effort-bands.ts:169`）

判定主函数，与上游 `resolveAdaptiveEffort` 1:1。

- 空数组 / `undefined` / `null` → `'medium'`（**绝不默认便宜**）。
- `boundary = lastUserMessageIndex(msgs)`；窗口取 `[0, boundary]`。
- 四信号：`userChars`（末条 user 的文本字符）、`estCtxTokens`（窗口内 Σ ceil(len/4) + floor）、
  `toolResults`（boundary 之前 role==tool 计数）、`turnDepth`（boundary 之后带 tool-call 的
  assistant 计数 + 1）。
- trivial：`userChars ≤ trivialUserChars && estCtxTokens ≤ trivialCtxTokens && toolResults === 0 && turnDepth ≤ 1` → `low`。
- heavy：`estCtxTokens ≥ heavyCtxTokens || toolResults ≥ heavyToolResults || userChars ≥ heavyUserChars` → `high`。
- 其余 → `medium`。

**无状态 per-turn pin 是函数性质**：三个承重信号只看末条 user 及其之前；`turnDepth` 只参与
trivial 门（只能否决 low）。因此轮内追加的内容不可能移动档位。

#### `clampBand(band, allowed, ladder?): string | undefined`（`effort-bands.ts:205`）

按阶梯钳制到路由声明集合：先从 `band` 向**下**找第一个可用档；下限以下都没有才向上找；
全都没有 → `undefined`（保持 adapter 默认）。例：`clampBand('high', ['off','minimal','low']) → 'low'`；
`clampBand('low', ['medium','high']) → 'medium'`。

#### 计数辅助（各自对应一个上游函数，独立可测）

| 函数 | 上游对应 | 语义 |
|---|---|---|
| `messageTextChars(content): number` | — | 一条消息的计数字符长：字符串整体计，数组只计 `type === 'text'` 块（image/reasoning/tool-call 不计） |
| `estimateTokens(text): number` | `specificityRules.estimateTokens` | `ceil(len/4)`（4 字符≈1 token；对中文低估 2–3 倍） |
| `estimateMessageTokens(messages): number` | `estimateMessageTokens` | 逐 part 估再求和（保留上游 per-part 取整） |
| `lastUserMessageIndex(messages): number` | `lastUserMessageIndex` | 末条 user 下标，无则 −1 |
| `countRole(messages, role, from, to): number` | `countRole` | `[from, to)` 内该 role 计数 |
| `toolLoopDepthAfter(messages, boundary): number` | `toolLoopDepthAfter` | boundary 之后带 `tool-call` 块的 assistant 计数（上游读 OpenAI `tool_calls` 字段，Harness 是 content 块） |

---

## auxiliary.ts — 辅助判据与注册表

### 常量与类型

```ts
const KNOWN_AUXILIARY_PURPOSES = ['compaction', 'session-title', 'auto-review']  // 随 Harness 发布的键
interface PurposeBearingRequest { purpose?: unknown; provider?: unknown; model?: unknown }
const PIN_REGISTRY_KEY: symbol = Symbol.for('@local/adaptive-effort-scheduler.pins')
const PIN_REGISTRY_LIMIT = 256

interface PinRecord {
  provider: string; model: string      // 钉档生效的路由
  effort: string                        // 钉住的档位 id（路由口径）
  band: string                          // 钳制前的判定 band
  turn: number                          // 所属轮次
  pinnedAt: number                      // 毫秒时间戳（供过期判断）
  overridden?: true                     // 人工接管后置位
}
```

### 函数

| 函数 | 语义 |
|---|---|
| `isAuxiliaryRequest(request?): boolean` | `purpose` 为非空字符串 ⇒ 辅助调用。依据是 Harness 类型：`GenerateOptions.purpose` 是开放注册表（`LlmRequestPurposeMap` 由生产者包 declare module 注册），普通对话请求不带该字段 |
| `auxiliaryPurpose(request?): string \| undefined` | purpose 值本身 |
| `pinRegistry(): Map<string, PinRecord>` | 取/建进程级注册表（`globalThis` 上 Symbol.for 键，跨插件共享） |
| `publishPin(registry, sessionId, record): void` | 写入并保持 LRU ≤ 256（重钉刷新位置） |

判据刻意**不复制**核心的 `isAgentLoopRequest()`（进程内标记），保持零 import。

---

## index.ts — 插件接线

### 导出面

```ts
export const name = 'adaptive-effort-scheduler'
export const inject = ['llm']
export function apply(ctx: Context, config?: SchedulerConfig): void
// 再导出：DEFAULT_THRESHOLDS / resolveBand / clampBand / 各类型 /
//         auxiliary 面（pinRegistry、isAuxiliaryRequest、…）
```

### `SchedulerConfig`（全部可选；默认值 = 上游常量）

| 键 | 类型/默认 | 语义 |
|---|---|---|
| `trivialUserChars` | number · 160 | low 门的提问字符上限 |
| `trivialCtxTokens` | number · 4000 | low 门的窗口 token 上限 |
| `heavyCtxTokens` | number · 60000 | high 门的窗口 token 下限 |
| `heavyToolResults` | number · 6 | high 门的累计工具结果下限 |
| `heavyUserChars` | number · 4000 | high 门的提问字符下限 |
| `contextFloorTokens` | number · 0 | 把会话日志外（system prompt + 工具 schema）补进 token 估算；0＝严格上游口径 |
| `allowedEfforts` | string[] · 未设 | 可写档位硬上限（与路由声明取交集） |
| `respectExplicitSelection` | boolean · true | 人工选择后该会话永久让位 |
| `publishPins` | boolean · true | 发布钉档到进程内注册表 |
| `logDecisions` | `'none'\|'debug'\|'info'` · debug | 决策日志级别（标定期抬到 info） |

`resolveConfig()` 对非法值（负数/非有限数/非字符串数组项/未知枚举）回退默认并 `warn`，
`allowedEfforts` 过滤后为空也会 warn（"left nothing steerable"）且插件保持不动作。

### 内部关键结构

```ts
interface PinSlot {
  turn: number                    // 槽位所属轮次
  claimed: ShapedMessage[]        // 本轮已 claim 的消息（提示词尚未进派生历史）
  opened: boolean                 // 首个 pre-step 后置位 → 本轮封口
  pinned: string | undefined      // 本轮钉住的档位（判定未落时 undefined）
  disabled: boolean               // 人工接管粘滞位
}
```

### 免写检查（skip-write，`index.ts:360-365`）

写入前两个跳过条件，都只在**同路由**下成立：

1. `route.reasoningEffort === effort` —— 待用 selection 已带目标档；
2. `route.reasoningEffort === undefined` 且 `requestHeader().config` 与 route 同 provider/model
   且 header 里 `reasoningEffort === effort` —— 上一次请求已经用这个档（adapter 默认恰好等于目标）。

换过模型后（model-only change）新路由默认未知，条件 2 故意不满足 → 必须写。

### 日志行（grep 面）

```
adaptive-effort: turn N pinned <effort> (band <band>, M messages, route <provider/model>)
adaptive-effort: turn N unpinned, capabilities of <route> not resolved yet
adaptive-effort: "<effort>" on session <id> predates its first claim; kept as the Session's own selection, not a hand-over
adaptive-effort: explicit effort "<effort>" wins; scheduler idle for session <id>
adaptive-effort: resolveModelInfo(<route>) failed; turns stay unpinned until it succeeds   （warn，每路由一次）
```

---

## 事件载荷（插件消费的最小面）

| 事件 | 用到的字段 |
|---|---|
| `agent/created`、`agent/inbox/inserted`、`agent/disposed` | `{ agent }`；agent 上的 `session.id`、`model.current()` |
| `agent/inbox/claimed` | `{ agent, message, turn }` |
| `agent/pre-step` | `{ agent, turn }` + `next()`（必须调用并透传） |
| `session/event` | `event.type`；`request/header` 用 `data.header.config.{provider,model}`；`model/selection` 用 `data.{provider,model,reasoningEffort}` |
| `llm/models-updated`、`llm/adapters-updated` | 无载荷（清缓存重探） |
| `ctx.llm.resolveModelInfo(provider, model)` | 返回 `{ reasoning?: { efforts?: { id }[] } }` |
| `agent.model.select({ provider, model, reasoningEffort })` | 唯一的写入口 |
