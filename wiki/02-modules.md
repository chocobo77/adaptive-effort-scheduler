# 02 · 模块职责与源码导读

## 1. 目录结构

```
adaptive-effort-scheduler/
├── src/                        # 源码（3 个模块，编译进 dist/）
│   ├── effort-bands.ts         # 纯函数：信号 → 档位（无宿主依赖）
│   ├── auxiliary.ts            # 辅助请求判据 + 进程内 pin 注册表（无宿主依赖）
│   └── index.ts                # 插件接线：事件 → 判定 → 写入（type-only 宿主引用）
├── dist/                       # 构建产物（gitignored，pack 时生成）
├── tests/                      # vitest 三套
│   ├── effort-bands.test.ts    # 判定保真（上游测试向量 1:1）
│   ├── scheduler.test.ts       # 钉档接线端到端（fake Context/Agent）
│   └── auxiliary.test.ts       # 辅助判据 + 注册表
├── scripts/                    # 开发工具（不打包）
│   ├── build.mjs               # 免安装依赖的构建/类型检查入口
│   ├── calibration-replay.mjs  # 离线回放会话日志 → 档位分布/切换/成本
│   ├── gate-attribution.mjs    # 逐轮归因：哪个 heavy 门触发 + 注入占比
│   ├── session-audit.mjs       # 逐轮对账：持久化日志 vs 插件决策
│   └── session-timeline.mjs    # 生命周期/selection/header 时间线转储
├── cordis.yml                  # 开发挂载形态（指向 ./dist/index.js，带标定配置）
├── cordis.patch.yml            # 安装 bundle 补丁层（带标定配置，随包分发）
├── package.json                # exports 三入口：. / ./effort-bands / ./auxiliary
├── pack.sh / pack.ps1 / pack.cmd   # 一键打包（构建+测试+npm pack+校验+SHA256）
├── release/                    # 产出的 tgz 与 SHA256SUMS.txt（gitignored）
├── tsconfig*.json              # 严格模式；build/typecheck 两个目标
├── vitest.config.ts            # forks 池，直接跑 TS 源码
├── locale/{zh,en}.json         # 插件市场元信息（标题/描述）
└── icon.svg
```

## 2. 模块职责与依赖方向

```
            ┌─────────────────────────────┐
            │  src/index.ts（插件接线）     │  ←── 唯一 import 宿主类型的地方（type-only）
            │  事件监听/槽位/接管判别/写入   │
            └──────────┬──────────┬───────┘
              value import     value import
                       ▼          ▼
     ┌─────────────────────┐  ┌──────────────────────┐
     │ src/effort-bands.ts │  │ src/auxiliary.ts      │
     │ 纯判定 + 钳制        │  │ 判据 + pin 注册表      │
     └─────────────────────┘  └──────────────────────┘
            零宿主依赖                  零宿主依赖
```

- 依赖方向单向：`index.ts` → `{effort-bands, auxiliary}`；后两者互相不认识、不 import 任何宿主包。
- `index.ts` 对宿主只有 `import type { Context, Agent, ModelSelection, PreStepDecision }`，
  `verbatimModuleSyntax` 下编译期擦除 → dist 产物只有相对 import。

### 各自为什么存在

| 模块 | 存在理由 |
|---|---|
| `effort-bands.ts` | 把"判定"从"接线"里剥离：不依赖 Harness checkout 就能单测；上游 1:1 移植的对照面也在这里（`DEFAULT_THRESHOLDS` 注明上游行号） |
| `auxiliary.ts` | 给**其它插件**用的公共词汇表：判定"这是辅助调用吗"、读"这个会话的档位是机器钉的还是人选的"。独立成模块是因为第三方只应 import `./auxiliary` 子路径，不拉进接线代码 |
| `index.ts` | 只回答三件事：信号从哪来（事件缝）、选择写到哪（`model.select`）、为什么是这条缝不是别的（头注释） |

## 3. src/index.ts 内部结构（按出现顺序）

| 成员 | 行（约） | 职责 |
|---|---|---|
| `name` / `inject` | 52-53 | 插件标识与依赖声明（`llm` 服务） |
| `SchedulerConfig` | 56-81 | 配置面：5 阈值 + 5 行为开关，全部可选 |
| `ResolvedConfig` / `resolveConfig()` | 84-139 | 配置合并：非法值回退默认并 `warn`（typo 不许静默） |
| `PinSlot` | 142-153 | 每 Agent 的轮次槽位：`turn / claimed[] / opened / pinned / disabled` |
| `EXPLICIT_SESSION_LIMIT` | 161 | 接管记录上限 1024（LRU） |
| `apply(ctx, config?)` | 168-469 | 插件主体，见下 |
| `routeKey()` | 198 | `` `${provider}/${model}` `` 能力缓存键 |
| `logDecision()` | 201-205 | 按 `logDecisions` 配置落 debug/info/静默 |
| `primeRoute()` | 215-235 | 异步能力探测：去重、缓存、失败每路由警告一次 |
| `rememberBounded()` | 238-246 | 上限 LRU 通用写（insertion order = recency） |
| 事件监听 | 254-468 | 见 [01-overview §3](./01-overview.md#3-事件流与生命周期) |

`apply()` 闭包内的全部可变状态见 [01-overview §6](./01-overview.md#6-数据与状态清单)。

### `agent/inbox/claimed` 处理器的判定链（核心路径）

```
canReadCapabilities? ─否→ 返回（启动时已 warn）
记 claimedSessions；explicitSessions 命中? → 返回
slot 轮次重置（disabled 粘滞）
slot.opened 或 disabled? → 返回（轮内冻结）
slot.claimed.push(message)
route = agent.model.current()；undefined → 返回
declared = capabilities[routeKey]；undefined → 记 unpinned 日志 + primeCapabilities + 返回
allowed = declared ∩ allowedEfforts（未配置则 = declared）；空 → 返回
window = deriveMessages() + slot.claimed
band = resolveBand(window, thresholds, {tokens: contextFloorTokens})
effort = clampBand(band, allowed)；undefined → 返回
slot.pinned = effort；publishPin()（可选）
免写检查（同路由已带该 effort，或 pending 为空且 header 同路由同值）→ 跳过
selfEcho 保护下 agent.model.select({provider, model, reasoningEffort})
logDecision("turn N pinned <effort> (band <band>, M messages, route …)")
```

### `session/event` 处理器（接管判别）

```
request/header → primeRoute(header 的 provider/model)      # 恢复会话首轮可钉的关键
model/selection（respectExplicitSelection 时）：
  effort 缺失/非字符串 → 视为只换模型：重探能力，返回
  selfEcho 命中 / 等于某活跃 pin → 自己的回声，返回
  会话从未 claim（claimedSessions 无）→ 首见记基线；同值重复仍是继承；只有不同值才算接管
  与某 Agent 当前 selection 三值全同 → re-assertion（resume 重施），返回
  其余 → 真接管：explicitSessions 记录；所有相关 slot.disabled = true；
          已发布 pin 标 overridden；logDecision("explicit effort wins; scheduler idle")
```

## 4. 测试套件职责

| 套件 | 覆盖 | 代表用例 |
|---|---|---|
| `effort-bands.test.ts` | 上游测试向量 1:1 保真；Harness 块状 content 形状；钳制；阈值覆盖 | "trivial→low"、"6 个工具结果→high"、"mid-loop 工具爆发不改档"、`clampBand('high', ['off','minimal','low']) → 'low'` |
| `scheduler.test.ts` | 用 fake Context/Agent 走完整接线 | "开局钉 low、轮内大注入不动、次轮重算 medium"；"开局批最后一条 claim 胜出"；"免写检查三个分支"；"1.6.5/1.6.6 三个接管边界"；"resume 重施同值不静默"；"profile 更新后重探"；"探针只发一次"；"非法配置 warn 且不动作" |
| `auxiliary.test.ts` | 判据开放性（任意 purpose 字符串）；注册表发布/覆盖标记/关闭发布/dispose 清理/兄弟 Agent 共享/LRU 上限 | — |

测试不 mock 模块，只 fake 宿主面（`ctx.on/fire`、`agent.model.current/select`、`session.deriveMessages/requestHeader`）；
`vitest.config.ts` 注释点明：宿主引用是 type-only，所以任何 vitest 安装都能直接跑 TS 源码。

## 5. 与 scripts/ 工具链的关系

`scripts/*.mjs` 是**开发工具，不参与打包**（`package.json` 的 `files` 不含 scripts/）。
它们 import `dist/effort-bands.js`（回放）或已安装 bundle 的 dist（审计），保证离线复算用的
判定函数与运行时完全同源。详见 [05-dev-workflow.md](./05-dev-workflow.md)。
