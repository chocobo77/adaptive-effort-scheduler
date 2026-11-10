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
两个门的偏差方向相反。本部署的阈值是按真实中文会话实测标定的，偏差已被吸收；但若重标时
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

## 标定记录（2026-11-04：8 段真实会话 / 50 轮离线回放）

代码里的默认值仍是上游原值；**安装配置里用的是按本部署标定过的值**。用
[scripts/calibration-replay.mjs](./scripts/calibration-replay.mjs) 按插件 claim 时刻的同一口径
（历史 + 该轮开场 user 消息）重放持久化会话日志，统计档位分布、**切换次数**（每次切换 = 上游一次
前缀失效）与思考成本（low=1 / medium=2 / high=3）：

| 配置 | low | medium | high | 切换 | 成本 |
|---|---|---|---|---|---|
| 上游原值（`6 / 60000 / 4000`） | 6% | 10% | **84%** | 5 | 139 |
| 只抬 tool/context（40 / 150k） | 6% | 14% | 80% | 8 | 137 |
| **tool 200 / ctx 250k / ask 15k ← 当前安装值** | 6% | **42%** | 52% | 6 | 123 |
| 同上 + `allowedEfforts: [low, medium]`（选项 2） | 6% | 94% | 0% | 3 | **97** |

归因（[scripts/gate-attribution.mjs](./scripts/gate-attribution.mjs)）解释为什么必须这样抬：

- 工具结果是**累计**计数，一段正常工作会话能到 400+，`heavyToolResults: 6` 在第 2–3 轮就永久锁死 `high`；
- 上下文 token 同样累计，正常会话内越过 180k，`60000` 也是单向闩锁；
- `userChars` 在 DSH 里被注入文本污染：实测某些轮的"用户消息"有 **98–100%** 是框架注入（任务状态卡、
  检索上下文），真实追问只有 2 字符——`4000` 会把长会话里的短问题误判为 heavy，抬到 `15000` 才只抓大段粘贴。

**复检记录（2026-11-08：Linux 侧 16 段真实会话 / 48 有效轮，5 段为空会话）**。安装配置不变，结论：**无需重标**。

| 配置 | low | medium | high | 切换 | 成本 |
|---|---|---|---|---|---|
| 上游原值 | 23% | 8% | **69%** | 5 | 118 |
| 当前安装值（past200） | 23% | 50% | 27% | 5 | 98 |
| 加 `allowedEfforts: [low, medium]` | 23% | 77% | 0% | 4 | 85 |

- 上游原值仍在此部署形成 `high` 单相闩锁（69%），当前安装值分布健康：`high` 全部由 `tools`（累计 200+）
  或 `ctx`（250k+）在真实长会话的后半程触发，属预期 heavy。
- **`userChars` 门 48 轮中单独触发 `high` 的次数为 0**：≥8k 字符的轮次注入率 94–98%，且 tools/ctx
  门同轮已触发——该门在本负载下只作冗余确认，无误判也无独有贡献；暂不动它，等它单独触发时再议。
- 真实日志形状核对：user/assistant/tool 的 `content` 均为块数组，`reasoning` 块如预期被估算忽略，
  最大会话 2091 条消息，每 claim O(n) 无压力。
- 活体证据：安装后的会话日志出现「先无 effort 的路由选择 → 同路由带 effort 的选择」序列，
  与插件的 claim 写入模式一致，调度在 Linux 侧实际生效。
- `gate-attribution.mjs` 新增 `--preset installed|upstream`，归因可按已装阈值重放。

重测（脚本是开发工具，不参与打包）：

```
node scripts/gate-attribution.mjs [--preset installed|upstream] "<会话目录>/session.v4.jsonl.zstd" ...
node scripts/calibration-replay.mjs --config upstream,past200,past200Plus2 --file-list logs.txt
```

## 运行审计（2026-11-10：20 段真实会话 / 88 轮，安装窗内 42 轮）

用 [scripts/session-audit.mjs](./scripts/session-audit.mjs) 把持久化日志与插件决策逐轮对账
（`--since <ISO>` 只统计安装后的轮），结论：

- 档位分布 **low 14% / medium 55% / high 31%**（标定前同一批是 6/42/52，上游阈值是 6/10/84）；
  18 次轮首写入，42 轮里只有 **4 次** `request/header reason=change`（= 4 次前缀失效）。
- **轮内改档 1 次**，且经事件序列证明不是本插件写的（该步内没有 claim、`slot.opened` 已置位；
  同期工具调用只有 `memory_expand`/`glob`）——来自外部（侧栏 UI 的 `model.select`）。
- **查出的缺陷（1.6.5 修）**：harness 在创建/恢复会话时会落一条带 effort 的 `model/selection`，
  旧实现把它当人工接管，于是整段会话静默。20 段里 4 段有这种"首轮之前的 effort"，
  其中 3 段因此几乎没钉过档（例如一段 12 轮会话全程 medium，而重算 band 有 9 轮是 high）。
  修法：只有在该会话本进程内 claim 过之后的 effort 写入才算接管（claim 之前的第二条不同值仍算）。
- 开场批量投递会让 band 随批次内后到的消息变化，于是同一开局批出现两次写入（如 `low`→`medium`）；
  两次都在首个请求派发之前，没有额外缓存代价，最终值即整批判定值。

复跑（阈值从**已安装 bundle 的 `cordis.patch.yml` 读取**，改了配置不会悄悄量错；`--config-file` 可指别处）：

```
node scripts/session-audit.mjs --since 2026-11-08T17:20:00+08:00 "<会话目录>\session.v4.jsonl.zstd" ...
node scripts/session-timeline.mjs "<会话目录>\session.v4.jsonl.zstd"   # 只看生命周期/selection/header
```

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
   写入视为 resume 重新施加旧值，不算接管（1.6.6）——真实日志里这类写入就落在轮边界、claim 之后，
   若把它当接管，每次 resume 都会静默整段会话。此前把它当接管会静默整段会话——实测 20 段真实会话里 4 段带这种
   "首轮之前的 effort"（见下节）。
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
- **标定状态（2026-11-04 后）**：`heavyCtxTokens` / `heavyToolResults` / `heavyUserChars` 已按
  本部署 8 段会话 / 50 轮重标（见上文标定记录）；`contextFloorTokens: 0` 仍保持上游口径——
  当前 250k 的 heavy 门下它不起决定作用，等跨语言或更长上下文的会话采到数据后再重标
  （`calibration-replay.mjs` 的候选配置已支持 `tokens` 字段，如 `past200Floor12k`）。

## 待标定数据（装上去之后收集）

把 `logDecisions: info` 写进配置，钉档与漏钉的行就会稳定出现在 info 级：

- `adaptive-effort: turn N pinned <effort> (band <band>, <M> messages, route <provider/model>)`
- `adaptive-effort: turn N unpinned, capabilities of <route> not resolved yet`

需要的是每轮的 `estCtxTokens`（会话长度）与工具结果条数分布，用来重标
`contextFloorTokens` 与 `heavyCtxTokens`。`calibration-replay.mjs` 的候选配置支持 `tokens`
字段（即 `contextFloorTokens`，如 `past200Floor12k`），回放时把它加进每轮的 token 估算，
可离线比较该参数的影响。

MIT
