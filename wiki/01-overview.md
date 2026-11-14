# 01 · 项目定位与整体架构

## 1. 这个项目是什么

`adaptive-effort-scheduler` 是 [DeepSeek Harness（DSH）](https://…) 的一个**本地插件**。
DSH 是一个 agent 宿主框架（cordis 插件体系），模型请求带 `reasoningEffort`（推理强度）参数时，
不同轮次的请求形态差异很大：一句"继续"和一段 5000 字的粘贴显然不该用同一档思考强度。

本插件做的事：**在每轮用户消息被 agent 认领（claim）的瞬间，根据该轮请求的"形状"
一次性选定 low/medium/high 三档之一，写入模型选择，并在本轮内绝不再改。**

判定函数不是本仓库发明的——它 1:1 移植自 OmniRoute 网关的
`open-sse/services/adaptiveEffort.ts`（其上游是 Hermes `agent/reasoning_effort.py`）。
网关版在 HTTP 转发层逐请求判定；本插件把同一逻辑搬到 DSH 的插件事件缝上，剥离了
HTTP 转发、鉴权、模型路由、负载均衡与 Reasoning Replay Cache，只保留参数决策。

### 为什么"每轮固定"是核心需求

推理强度变化 = 上游提示词缓存前缀失效。如果轮内（工具循环中途）改档，
同一个用户轮次的多次请求会各自付出一次冷前缀写入。因此本插件的所有设计都围绕
"**轮首一次写入，轮内冻结**"展开。

## 2. 宿主环境与插件形态

```
┌─────────────────────────── DSH 宿主进程 ────────────────────────────┐
│  cordis 插件容器                                                     │
│  ┌──────────────────┐   ┌───────────────────┐   ┌───────────────┐  │
│  │ agent / agent-loop│   │ llm（路由与适配器） │   │ session 持久化│  │
│  └─────┬────────────┘   └─────────┬─────────┘   └──────┬────────┘  │
│        │ 事件                          │ ctx.llm            │ 事件     │
│        ▼                              ▼                    ▼         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  adaptive-effort-scheduler（本插件，inject: ['llm']）        │    │
│  │                                                             │    │
│  │  事件监听 ──▶ 纯函数决策 ──▶ agent.model.select() 一次性写入  │    │
│  │  能力探测 ──▶ ctx.llm.resolveModelInfo()（异步、去重、缓存）   │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                        ▲ globalThis[Symbol.for(...)]                │
│  其它插件（上下文治理/摘要/标题/评审）读取 pin 注册表区分机器/人工档位 │
└─────────────────────────────────────────────────────────────────────┘
```

- 插件入口：`apply(ctx, config?)`，`name = 'adaptive-effort-scheduler'`，`inject = ['llm']`。
- 与宿主的全部耦合是：**7 类事件** + `ctx.llm.resolveModelInfo()` + `agent.model.select()`。
  类型引用（`Context` / `Agent` / `ModelSelection` / `PreStepDecision`）全部是
  `import type`，编译后擦除，因此产物零运行时依赖。
- 对其它插件暴露的唯一接口是进程内 pin 注册表（`Symbol.for` 键，见 §5）。

## 3. 事件流与生命周期

插件监听的全部事件及其用途：

| 事件 | 触发时机 | 插件动作 |
|---|---|---|
| `agent/created` | Agent 创建 | 预热当前路由的能力探测 |
| `agent/inbox/inserted` | 提示词落进收件箱（早于驱动唤醒） | 同上（更早的预热点） |
| `agent/inbox/claimed` | `inbox.claim()` 内同步触发 | **钉档点**：判定 + 写入（见下） |
| `agent/pre-step` | 第一步被提出 | 封口：`slot.opened = true`，本轮不再判 |
| `agent/disposed` | Agent 销毁 | 清理槽位；最后一个同会话 Agent 销毁时清 pin 注册表 |
| `llm/models-updated` / `llm/adapters-updated` | profile 改动 | 清空能力缓存并对活着的 Agent 重探 |
| `session/event`（`request/header`、`model/selection` 两个子类型） | 会话日志事件 | 预热路由 / 检测人工接管 |

### 一次轮次的完整时序

```
agent/created ──┐
inbox/inserted ─┼─▶ primeRoute() 异步探测（三缝去重，探测中不重复发）
request/header ─┘
      │
      ▼
agent/inbox/claimed(turn N)          ◀── 钉档点
  ├─ 会话已 claim？记入 claimedSessions（此后带 effort 的选择才算人工）
  ├─ 会话已被人工接管？→ 直接返回
  ├─ slot.turn ≠ N？→ 重置槽位（新轮次，disabled 粘滞除外）
  ├─ slot.opened（轮内后续 claim）？→ 保持钉档，返回
  ├─ slot.claimed.push(消息)；拼窗口 = deriveMessages() + claimed
  ├─ resolveBand(窗口, thresholds, floor) → band
  ├─ clampBand(band, 路由声明 ∩ allowedEfforts) → effort
  ├─ publishPin()（可选）→ 进程内注册表
  ├─ 免写检查：当前 selection 已带该 effort（同路由）则跳过
  └─ agent.model.select({provider, model, reasoningEffort})  ← selfEcho 防回声
      │
      ▼
agent/pre-step(turn N, step 1)       ◀── 封口：slot.opened = true
      │
      ▼  本轮内所有后续 claim（转向注入/定时投递）都不再改变档位
```

### 开局批（opening batch）的细节

`inbox.claim()` 会**先**发出排队的 next-step 遗留消息、**最后**才发本轮真正的提问。
因此同一轮的 claim 事件可能成批出现，插件在批内**逐条重算**（有意为之）：
最后一条 claim（真正的 ask）的判定值胜出。宿主对"相同值的选择写入"是 no-op，
所以批内重算只有在 band 真变化时才多一次实际写入；两次写入都发生在首个请求派发之前，
无额外缓存代价。

## 4. 核心设计决策

### 4.1 为什么钉在 `agent/inbox/claimed` 这条缝上

源码头注释（`src/index.ts:9-21`）逐一核对过当时的 Harness 源码：

| 候选缝 | 为什么不行 |
|---|---|
| `agent/request` | 已 `@deprecated`，文档明确不能改 provider/model/effort |
| `llm/stream` | agent-loop 请求在瀑布里是深度冻结的（只读） |
| `agent/pre-step` | 晚一拍：loop 在瀑布前已捕获本步 selection，`select()` 会落到**下一步**＝轮内变化 |
| **`agent/inbox/claimed`** | 在 `inbox.claim()` 内**同步**触发，早于 loop 捕获，是最后一个能影响本轮请求的时点 ✔ |

### 4.2 无状态 per-turn pin

三个承重信号（`userChars` / `estCtxTokens` / `toolResults`）只读"最后一条 user 消息及其之前"；
唯一向后看的 `turnDepth` 只能**否决 low**。所以工具循环中途追加的 assistant/tool 内容
在数学上不可能改变档位——pin 是判定函数本身的性质，不是外挂状态。
（接线里 `turnDepth` 实际恒为 1：钉档时窗口最后一条就是本轮 user 消息；保留它是为了对上游保真、可独立测试。）

### 4.3 人工接管让位（respectExplicitSelection）

上游优先级规则 #1："显式 reasoning 字段永远赢"。落地为三级判别，对应三个真实缺陷的修复史：

1. **自己写的回声不算**：插件写入期间设置 `selfEcho`，同值事件跳过；异步派发的宿主上，
   与活跃 pin 相等的 selection 也视为回声。（代价：用户恰好手选了当前钉住档位时无法区分，不算接管。）
2. **会话自己的初始/恢复选择不算**（1.6.5）：会话在**本进程内首次 claim 之前**到达的带 effort
   selection 是 Harness 写的初始（创建）或恢复（resume）值——首见值记为基线，重复同值仍是继承，
   只有 claim 前出现**不同**值才算人工。
   旧实现把它们当接管导致整段会话静默。
3. **与当前 selection 三值全同的写入不算**（1.6.6）：resume / options replay 会重新施加会话
   存储的选择，这类写入落在轮边界、claim 之后；只有**值发生变化**才算接管，否则每次 resume 都会静默整段会话。

接管记录按 **session**（而非 Agent）保存，因此对之后重建/恢复出的 Agent 同样生效，
直到 DSH 重启、插件重载，或配置 `respectExplicitSelection: false`。

### 4.4 档位钳制（宁可不钉，也不报错）

只写路由**声明**的档位（`ctx.llm.resolveModelInfo().reasoning.efforts`）。
路由未声明 `reasoningEfforts` → 完全不动作（避免 `UNSUPPORTED_REASONING_EFFORT`）。
决策档位高于路由上限先**降档**；下限以下都不存在才**升档**。
配置项 `allowedEfforts` 再与路由声明取交集——用于"所有模型路线（含摘要路线）共同支持"的硬上限。

### 4.5 能力只能异步读 → 三个预热缝 + 一个毫秒级残余竞态

`resolveModelInfo` 是异步的，插件在 `agent/created`、`agent/inbox/inserted`、`request/header`
三个时点预热（探测去重）。残余竞态只有一个：Agent 刚创建、探针未返回时提示词就到点——
该轮走 adapter 默认档位并打一条 debug 日志
`adaptive-effort: turn N unpinned, capabilities of <route> not resolved yet`（可 grep 计数）。

## 5. 与其它插件的边界（auxiliary 面）

钉档只作用于 **agent-loop 的模型选择**。折叠摘要（`compaction`）、会话标题（`session-title`）、
自动评审（`auto-review`）这类辅助调用不带 `purpose` 的路径，**永远不会被本插件调度**。

唯一的泄漏点是**别人的策略**：上下文治理类插件会把
`session.requestHeader()?.config.reasoningEffort`（＝本插件钉下的值）复制进自己的摘要调用。
为此插件把每次钉档发布到进程内注册表（`Symbol.for('@local/adaptive-effort-scheduler.pins')`，
容量 256 条 LRU），第三方据此区分机器钉档与人工选择；`publishPins: false` 可关闭。

```js
import { pinRegistry, isAuxiliaryRequest } from '@local/adaptive-effort-scheduler/auxiliary'
const pin = pinRegistry().get(String(session.id))
if (!isAuxiliaryRequest(options) || pin === undefined || pin.overridden === true) { /* 沿用 */ }
```

## 6. 数据与状态清单

全部运行时状态都在 `apply()` 闭包或 `globalThis` 注册表里，无持久化：

| 状态 | 位置 | 生命周期 |
|---|---|---|
| `capabilities: Map<route, efforts[]>` | 闭包 | profile 更新事件时清空重探 |
| `probing` / `probeFailures` | 闭包 | 探测去重 / 失败路由每路由警告一次 |
| `slots: Map<Agent, PinSlot>` | 闭包 | `agent/disposed` 时删除 |
| `explicitSessions: Map<sessionId>` | 闭包 | 进程内；上限 1024 条 LRU |
| `claimedSessions` / `preClaimSelections` | 闭包 | 进程内；上限 1024 条 LRU |
| `selfEcho` | 闭包变量 | 一次 `select()` 调用期间 |
| pin 注册表 | `globalThis[Symbol.for(...)]` | 最后一个同会话 Agent dispose 时清；上限 256 条 LRU |

## 7. 已知边界（README「已知行为/已知边界」的浓缩）

- 不区分主代理/子代理，子代理同样按轮钉档；共享同一 session 的多个 Agent 在注册表里互相覆盖，
  仅最后一个存活 Agent dispose 时清除记录。
- 折叠后下一轮可能降档（历史变小 → `estCtxTokens` 回落），代价是一次上游前缀失效；轮内绝不变。
- 中文口径：`estimateTokens` 的"4 字符 ≈ 1 token"对中文低估 2–3 倍，而 `userChars` 对中文偏高——
  两个门偏差方向相反，本部署阈值按真实中文会话标定，重标时混入英文会漂移。
- DSH 的 user 消息常含框架注入文本（任务状态卡/检索上下文），
  `heavyUserChars` 因此从上游 4000 抬到 15000。
