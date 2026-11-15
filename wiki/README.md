# adaptive-effort-scheduler — Code Wiki

DeepSeek Harness（DSH）插件：为一次用户轮次**固定**一档推理强度（`low` / `medium` / `high`）。
判定逻辑 1:1 移植自 OmniRoute `open-sse/services/adaptiveEffort.ts`（上游是 Hermes
`agent/reasoning_effort.py` 的三档确定性门），剥离了网关的转发/鉴权/路由/缓存，只留参数决策。

| 属性 | 值 |
|---|---|
| 包名 | `@local/adaptive-effort-scheduler`（私有，不发布 npm） |
| 版本 | 1.6.6（见 `package.json`） |
| 语言 / 运行时 | TypeScript（ESM，target es2024）/ Node.js ≥ 22.19.0 |
| 运行时依赖 | **零**（宿主包引用全部是 type-only import，编译期擦除） |
| 状态 | 每 Agent 一个轮次槽位 + 按 `provider/model` 缓存的档位目录 + 进程内 pin 注册表 |
| 许可证 | MIT |

## 文档导航

| 文档 | 内容 |
|---|---|
| [01-overview.md](./01-overview.md) | 项目定位、整体架构、事件流与生命周期、核心设计决策（钉档缝的选择、per-turn pin、手选不让位） |
| [02-modules.md](./02-modules.md) | 目录结构、三个源码模块与测试套件的职责划分、模块间依赖关系 |
| [03-api.md](./03-api.md) | 关键类型、常量与函数的逐个说明（含签名、语义、边界条件） |
| [04-config.md](./04-config.md) | 配置系统全解：阈值含义、上游默认值 vs 本部署标定值、cordis.yml / cordis.patch.yml 双形态 |
| [05-dev-workflow.md](./05-dev-workflow.md) | 构建（免安装依赖的垫片机制）、测试、打包、离线标定/对账工具链、安装与运行方式 |

## 一分钟理解这个项目

```
用户消息落进 inbox ──claim──▶ agent/inbox/claimed 事件
                                    │
                                    ▼
              读「派生历史 + 本轮已 claim 的消息」拼出决策窗口
                                    │
                                    ▼
              resolveBand()：四个纯计数信号 → low / medium / high
                                    │
                                    ▼
              clampBand()：按路由声明的档位（+配置上限）钳制
                                    │
                                    ▼
              agent.model.select({ ..., reasoningEffort })   ← 一次性写入
                                    │
                     agent/pre-step 封口：本轮内不再变
```

四个信号全部是**对已存在消息的计数**（无正则启发式、无模型调用）：

| 信号 | 定义 |
|---|---|
| `userChars` | 最后一条 user 消息的文本字符数 |
| `estCtxTokens` | 该消息及其之前所有消息的 Σ ceil(chars/4) |
| `toolResults` | 该消息严格之前 role==tool 的消息数 |
| `turnDepth` | 该消息之后带 tool-call 的 assistant 消息数 + 1 |

三档映射：`trivial`（四条件全满足）→ **low**；`heavy`（三条件任一）→ **high**；其余与空输入 → **medium**（绝不"默认便宜"）。

## 快速上手

```bash
npm run typecheck   # 垫 node_modules 垫片后调 tsc
npm run build       # src/ -> dist/
npm test            # vitest：判定保真 + 钉档接线 + 辅助用途/注册表
./pack.sh           # 或 pack.cmd：构建+测试+npm pack+校验+SHA256SUMS
dsh plugin --profile <profile> add <本目录>   # 安装；装后重启 DSH
```

详细机制见 [05-dev-workflow.md](./05-dev-workflow.md)。
