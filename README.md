# adaptive-effort-scheduler

DeepSeek Harness 插件：为一次用户轮次**固定**一档推理强度（`low` / `medium` / `high`），
判定逻辑 1:1 移植自 OmniRoute `open-sse/services/adaptiveEffort.ts`（其上游是 Hermes
`agent/reasoning_effort.py` 的三档确定性门）。网关的 HTTP 转发、鉴权、模型路由、负载
均衡与 Reasoning Replay Cache 全部剥离，只留参数决策。

零依赖（编译产物只有相对 import，无宿主包运行时引用）、零 LLM 调用、零显存开销；
状态只有「每个 Agent 一个轮次槽位」+「按 `provider/model` 缓存的档位目录」。

## 判定信号与阈值

四个纯计数，全部来自已存在的消息（无正则启发式）：

| 信号 | 含义 |
|---|---|
| `userChars` | 最后一条 user 消息的文本字符数 |
| `estCtxTokens` | 该消息**及其之前**所有消息的 Σ ceil(chars/4) |
| `toolResults` | 该消息**严格之前** role==tool 的消息数 |
| `turnDepth` | 该消息**之后**带 `tool-call` 的 assistant 消息数 + 1 |

映射（默认阈值 = 上游常量，可在 `config` 覆盖）：

- `trivial`：`userChars ≤ 160` 且 `estCtxTokens ≤ 4000` 且 `toolResults == 0` 且 `turnDepth ≤ 1` → **low**
- `heavy`：`estCtxTokens ≥ 60000` 或 `toolResults ≥ 6` 或 `userChars ≥ 4000` → **high**
- 其余 → **medium**；无消息 → **medium**（绝不"默认便宜"）

**一处不可回避的口径差异**：上游在网关里统计的是**整个请求体**，其中含 system prompt 与工具 schema；
Harness 的会话日志把这两样放在消息列表之外，所以同一阈值在这里是对一个**系统性偏小**的数在判断
（本部署 system prompt + 工具 schema 约 1.2 万 tokens）。用 `contextFloorTokens` 把这块补进估算：
默认 0 = 严格照搬上游口径；填上该量级后门槛才与上游可比。

另一处要注意的是**语言**：`estimateTokens` 沿用上游的「4 字符 ≈ 1 token」，这对英文成立，
对中文会低估约 2–3 倍（中文约 1.5–2 字/token），而 `userChars`（字符数）对中文反而偏高——
两个门的偏差方向相反。本部署的阈值按本部署的真实会话标定，偏差已被吸收；但若重标时
混入英文会话，两个门的行为会漂移，`heavyUserChars` 与 `heavyCtxTokens` 要分开看。

## 单轮固定（per-turn pin）

- 三个承重信号只读「最后一条 user 消息及其之前」，唯一向后看的 `turnDepth` 只能**否决 low**；
  因此工具循环中途追加的 assistant/tool 内容永远无法改变档位。（钉档点上窗口最后一条就是
  本轮 user 消息，其后暂无内容，`turnDepth` 在接线里实际恒为 1——保留它是为了对上游判定
  函数保真并让纯函数可独立测试；真正起作用的是窗口本身不含轮内内容。）
- 插件在 `agent/inbox/claimed` 写选择（该事件在 `inbox.claim()` 内同步触发，早于 loop 捕获
  本步 selection），并在 `agent/pre-step` 封口：同一轮内后续任何 claim（转向/注入/定时投递）
  都不重算。开局批内逐条重算是有意为之——`inbox.claim` 先发排队的 next-step 遗留、最后才发
  本轮提问，最后一条 claim 才是真正要判定的 ask；而宿主对相同 recorded choice 是 no-op，
  重算只在批内 band 真变化时才多一次写入。
- 仅改 effort 的 `model/selection` 不会插入模型切换提示，历史与提示词缓存前缀保持不变。
- 为什么不用其它落点：`agent/request` 已废弃且文档明确不能改 provider/model/effort；
  `llm/stream` 的 agent-loop 请求是深度冻结的（只读）；`agent/pre-step` 里 `select()` 会落到下一步，即轮内变化。

## 档位钳制

只写入路由**声明**的档位（`ctx.llm.resolveModelInfo().reasoning.efforts`）。本地 Qwen/Strata 的
provider profile 若未声明 `reasoningEfforts`，插件直接不动作（不会抛出 `UNSUPPORTED_REASONING_EFFORT`）。
决策档位高于路由上限时先降档，只有在下限以下都不存在时才升档。

## 辅助用途（auxiliary）怎么判定

钉档只发生在 **agent-loop 的模型选择**上（`agent/inbox/claimed` → `agent.model.select()`），
折叠摘要、会话标题、自动评审这类调用不走这条缝，因此**永远不会被本插件调度**。

判定标准来自 Harness 类型，不是猜的：

- `GenerateOptions.purpose` 是一个**开放注册表**——`LlmRequestPurposeMap` 由各生产者包用
  `declare module '@deepseek-ai/dsh-llm/types'` 增加键，而**普通对话请求不带该字段**。
  所以「purpose 有值 ⇒ 辅助调用」。已随 Harness 发布的键：`compaction`
  （compaction-basic）、`session-title`（session-title-llm）、`auto-review`（experimental）。
- 另一条正交判据是身份：核心用 `markAgentLoopRequest()` / `isAgentLoopRequest()`（进程内标记）
  标识 loop 组装的请求；`llm/stream` 上据此判断"能不能改"。本插件不复制该判断，保持零 import。

泄漏点只有一个，而且是**别人的策略**：上下文治理类插件会把
`session.requestHeader()?.config.reasoningEffort` 复制进自己的摘要调用（本地 provider 常拒绝模型
声明的默认档位，它们借此修复）。那条链读到的正是本插件钉下的值。为此本插件把每次钉档写进进程内注册表：

```js
import { pinRegistry, isAuxiliaryRequest } from '@local/adaptive-effort-scheduler/auxiliary'

const pin = pinRegistry().get(String(session.id))
// 只在没有机器钉档时才沿用会话档位；机器钉档下摘要保持自己的策略
if (!isAuxiliaryRequest(options) || pin === undefined || pin.overridden === true) { /* 沿用 */ }
```

`publishPins: false` 可关闭发布（关闭后第三方只能看到 header 值，无法区分机器/人工）。

## 与上下文治理插件共存（折叠时会不会被打扰）

四个方向逐个核对，结论都是"折叠过程本身零干扰"：

| 方向 | 事实 |
|---|---|
| 我 → 折叠的 surface | 本插件不改消息、不改 `llm/stream`、不做任何 surface 重写；只写一次 `model/selection`（effort-only，不产生模型切换提示） |
| 我 → 折叠时机/档位 | 折叠调用是 `purpose: 'compaction'` 的独立 `ctx.llm.stream`，不经过钉档所在的 agent-loop 选择缝，因此**永远不会被本插件调度** |
| 折叠 → 本轮钉档 | 钉档发生在 `agent/inbox/claimed`，早于它们的工具结果归档与 RAG 注入；且轮内 pin 已封口，它们中途改写 surface 也改不动本轮档位 |
| 折叠 → 下一轮钉档 | 折叠把历史变小后，下一轮可能降档（设计如此），代价是一次上游前缀失效；轮内绝不变 |

唯一确实的耦合是**它们把会话生效档位复制进摘要调用**（读
`session.requestHeader()?.config.reasoningEffort`，见 compaction-basic 的摘要调用不带
`reasoningEffort`）。这一点可保证的是**不会报错**：本插件写入的档位一定在
`ctx.llm.resolveModelInfo()` 声明的集合内。摘要因此与对话同档位，对它们"复用对话前缀"反而有利；
代价是钉到 `low` 时摘要也变便宜。

**唯一需要注意的例外**：若摘要走**另一条模型路线**（`BasicCompactionConfig` 的 summarization 字段
或 `AgentOptions` 指定），那条链仍会复制会话档位，而我的钳制只按**对话路线**的能力。此时用
`allowedEfforts: [low, medium]` 把钉档限制在所有路线共同的集合里，跨路线能力错配就不可能发生。

## 阈值标定

代码里的默认值就是上游常量；**安装配置用的是按本部署标定过的值**。差异来自宿主形态，不是算法：

- `toolResults` 与 `estCtxTokens` 都是**累计**信号。长时间的工具型会话里两者一路上涨，上游的
  `6` / `60000` 于是成了单向闩锁：早期就锁死 `high`，折叠也不会让它回落。安装配置把这两道门抬到
  只在会话后半程才可能触发（`heavyToolResults: 200` / `heavyCtxTokens: 250000`）。
- `userChars` 会被注入文本抬高：任务状态卡、检索上下文可能占满整条 user 消息，真实追问只剩几个字符。
  上游的 `4000` 因此会把长会话里的短追问判成 heavy，抬到 `15000` 后只抓真正的整段粘贴。
- `contextFloorTokens` 保持 `0`（上游口径）。上游把整个请求体计入 token，而 Harness 的会话日志只存
  消息列表——系统提示与工具 schema 不在其中，所以这里的估算系统性偏小，换宿主时需要重新标定这个偏移。

换部署时先量再定：`scripts/calibration-replay.mjs` 按插件 claim 时刻的同一口径离线重放会话日志，
输出档位分布、**切换次数**（每次切换 = 上游一次前缀失效）与思考成本（low=1 / medium=2 / high=3）；
`scripts/gate-attribution.mjs` 逐轮给出三道 heavy 门各自的原始值与触发情况。

```
node scripts/gate-attribution.mjs [--preset installed|upstream] "<会话目录>/session.v4.jsonl.zstd" ...
node scripts/calibration-replay.mjs --config upstream,past200,past200Plus2 --file-list logs.txt
```

装上之后想核对实际行为，用 `scripts/session-audit.mjs`（阈值直接读已安装 bundle 的
`cordis.patch.yml`，配置改了不会量错）与 `scripts/session-timeline.mjs`：前者把持久化日志与插件决策
逐轮对账，后者只列生命周期 / `model/selection` / `request/header` 三类事件。要看每轮的钉档行，
把 `logDecisions: info` 写进配置。

## 配置

见 [cordis.yml](./cordis.yml) 的逐项注释：

- 五个阈值：`trivialUserChars` / `trivialCtxTokens` / `heavyCtxTokens` / `heavyToolResults` / `heavyUserChars`
- `contextFloorTokens`（默认 0）：把会话日志外的 system prompt + 工具 schema 补进 token 估算
- `allowedEfforts`（默认沿用路由声明集合）：可写入档位的硬上限，与路由能力取交集
- `respectExplicitSelection`（默认 true）：UI 手选档位后该 Agent 交给用户
- `publishPins`（默认 true）：把每次钉档发布到进程内注册表，供辅助调用的所有者区分机器/人工

## 开发与验证

```
npm run typecheck   # scripts/build.mjs：找类型来源并垫进本目录 node_modules，再调 tsc
npm run build       # src/ -> dist/
npm test            # vitest：判定保真 + 钉档接线 + 辅助用途/注册表
pack.cmd            # 或 powershell -File pack.ps1：构建+测试+npm pack，校验 tarball 并写 SHA256SUMS
./pack.sh           # 同上，bash 复刻（--out-dir / --skip-tests / --keep-out-dir）
```

本目录无需真实安装依赖：`scripts/build.mjs` 会把 typescript、`@deepseek-ai/*` 类型包等
**链接**进本目录 `node_modules`（gitignored 垫片），tsc、vitest 与编辑器走原生解析。
类型来源按序探测：`$DSH_NODE_MODULES`（直接给 node_modules）→ `$DSH_HOME`（给 DSH
checkout，取其 node_modules）→ 本目录 node_modules → 历史上的 Windows checkout 路径
（自动翻译到 /media 下的挂载点）→ 上下两级目录里的兄弟项目。checkout 优先于兄弟项目：
npm 发布的类型面可能落后于 checkout。`$DSH_TSC` 可显式指定 tsc.js。

安装：`dsh plugin --profile <profile> add <本目录>`，或在插件管理器里 `install_bundle` 指向本目录；
装后需重启 DSH。开发期可直接用 [cordis.yml](./cordis.yml) 挂载 `./dist/index.js`，免打包。

## 已知行为（已确认，别忘了）

1. **手动选择后永久粘滞；但会话自己的档位写入不算手选**。一旦本插件看到一条"不是自己写的"且带
   effort 的 `model/selection`，**该会话**的调度立即停用且不再自动恢复——记录按 session 而非 Agent
   保存，所以对之后重建/恢复出的 Agent 同样生效。直到 DSH 重启、插件重载，或你把
   `respectExplicitSelection: false` 写进配置。这是刻意照搬上游优先级规则 #1（"显式 reasoning 字段
   永远赢"），不是 bug。只换模型不带 effort 时不会停用，只会重探新路线的能力。
   边界（1.6.5 起）：在该会话于本进程内**首次 claim 之前**到达的 effort 写入，视为 harness 自己写的
   初始/恢复值（创建会话或 resume 时它会落一条 selection），不算接管；重复的同值同样不算；只有随后
   出现的**不同**值才算人工接管。同理，与 Agent 当前 selection **三值全同**（provider/model/effort）的
   写入视为 resume 重新施加旧值，不算接管（1.6.6）——这类写入落在轮边界、claim 之后，把它当接管会让
   每次 resume 都静默整段会话。
   一处判别极限：若你恰好手选了**当前钉住的同一档位**，它与插件自己写入的回声无法区分，
   不会被记为接管——到档位随下一轮变化时插件会重新覆盖，届时再选一次即可。
2. **折叠后下一轮可能降档，代价是一次上游前缀失效**。折叠把历史变小 → 下一轮的 `estCtxTokens`
   跨过门槛往回走（例如 `high → medium`），这是"每轮调度"的固有代价。**pre-step 之后绝不改档**：
   开局批（含其内多条 claim 的逐条重算）定下的档位，轮内的转向注入、定时投递、工具结果都不会触发重算。
3. **首个 turn 靠预探覆盖，但有一个毫秒级残余竞态**。能力只能异步读
   （`ctx.llm.resolveModelInfo`），所以插件在最早的三个时点预热：`agent/created`、
   `agent/inbox/inserted`（提示词落到收件箱，早于驱动唤醒）、`request/header`（会话日志里下一步要用的
   路线；恢复的会话在首个 claim 之前就能读到）。残余竞态只有一个：Agent 刚创建、探针还没回来，
   提示词就到点了——这一轮会走 adapter 默认档位，并打一条
   `adaptive-effort: turn N unpinned, capabilities of <route> not resolved yet` 的 debug 日志，
   采数据时可以直接数它。
4. **profile 改了档位声明会被察觉**：`llm/models-updated` / `llm/adapters-updated` 会清空能力缓存并对
   活着的 Agent 重探，旧上限不会比生成它的 profile 活得更久。
5. **路由没声明 `reasoningEfforts` 时完全不动作**（宁可不钉，也不制造 `UNSUPPORTED_REASONING_EFFORT`）。

## 已知边界

- 不区分主代理与子代理（公开 `Agent` 面不暴露父子关系）；子代理同样按轮钉档。共享同一
  session 的多个 Agent 会互相覆盖 registry 里自己的那条记录，进程内注册表只在**最后一个**
  存活 Agent dispose 时才清除。
- 与上下文治理类插件共存时，其摘要/折叠调用会沿用会话当前生效档位——钉到 `low` 时摘要也变便宜；
  跨模型路线做摘要时打开 `allowedEfforts` 消除风险。
- **标定状态**：`heavyCtxTokens` / `heavyToolResults` / `heavyUserChars` 已按本部署重标（见「阈值标定」）；
  `contextFloorTokens: 0` 仍保持上游口径——当前 250k 的 heavy 门下它不起决定作用，等换宿主或更长的
  上下文后再重标（`calibration-replay.mjs` 的候选配置支持 `tokens` 字段，如 `past200Floor12k`）。

## 采数据重标

把 `logDecisions: info` 写进配置，钉档与漏钉的行就会稳定出现在 info 级：

- `adaptive-effort: turn N pinned <effort> (band <band>, <M> messages, route <provider/model>)`
- `adaptive-effort: turn N unpinned, capabilities of <route> not resolved yet`

需要的是每轮的 `estCtxTokens`（会话长度）与工具结果条数分布，用来重标
`contextFloorTokens` 与 `heavyCtxTokens`。`calibration-replay.mjs` 的候选配置支持 `tokens`
字段（即 `contextFloorTokens`，如 `past200Floor12k`），回放时把它加进每轮的 token 估算，
可离线比较该参数的影响。

MIT
