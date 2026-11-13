# 04 · 配置系统与部署形态

## 1. 两份配置文件，两种形态

| 文件 | 何时生效 | 加载方式 |
|---|---|---|
| `cordis.yml` | **开发期直挂**：`dsh apply` 直接从本目录加载 `./dist/index.js`，改完 `apply`（插件重启）即生效，免打包 | `- id: adaptive-effort-scheduler` + `name: ./dist/index.js` + 行内 `config` |
| `cordis.patch.yml` | **安装 bundle**：`dsh plugin --profile <p> add <目录或 tgz>` 时由 `package.json` 的 `dsh.bundle.patch` 指定，作为 profile 的补丁层插入 | `- insert: [...]` + `name: '@local/adaptive-effort-scheduler'`（子路径经 node_modules exports 解析，不能用相对路径） |

两份文件的 `config` 内容**语义相同**，当前都携带同一套本部署标定值。
注意 `session-audit.mjs` 的阈值默认从**已安装 bundle 的 patch 文件**读取
（`--config-file` 可改指），保证审计不会悄悄量错配置。

## 2. 当前安装值 vs 上游默认值

代码内默认（`DEFAULT_THRESHOLDS`）永远是上游原值；部署差异只体现在配置文件里：

| 键 | 上游默认 | 本部署安装值 | 为什么 |
|---|---|---|---|
| `trivialUserChars` | 160 | **160** | low 门保持上游 |
| `trivialCtxTokens` | 4000 | **4000** | 同上 |
| `heavyCtxTokens` | 60000 | **250000** | 上下文是累计量：一段正常会话能过 180k，60000 是单向闩锁（第 2–3 轮起永久 high） |
| `heavyToolResults` | 6 | **200** | 工具结果也是累计量，正常会话能到 400+；6 在第 2–3 轮就锁死 high |
| `heavyUserChars` | 4000 | **15000** | DSH 的 user 消息被框架注入污染（任务状态卡/检索上下文，实测占 98–100%），4000 会把长会话里的短追问误判 heavy |
| `contextFloorTokens` | 0 | **0** | 上游在网关里统计整个请求体（含 system prompt + 工具 schema，本部署约 12k tokens）；Harness 会话日志把这两样放在消息列表之外。250k 的 heavy 门下它暂不起决定作用，保持上游口径待重标 |

行为开关（两份文件一致）：

```yaml
respectExplicitSelection: true   # 人工选档后该会话永久让位
publishPins: true                # 发布钉档到进程内注册表
logDecisions: debug              # 标定期抬到 info
# allowedEfforts: [low, medium]  # 「选项 2」：彻底退役 high（见下）
```

## 3. 标定记录（数据 → 决策的依据链）

### 2026-11-04：8 段真实会话 / 50 轮（`calibration-replay.mjs` 离线回放）

| 配置 | low | medium | high | 切换 | 成本 |
|---|---|---|---|---|---|
| 上游原值（6 / 60000 / 4000） | 6% | 10% | **84%** | 5 | 139 |
| 只抬 tool/context（40 / 150k） | 6% | 14% | 80% | 8 | 137 |
| **tool 200 / ctx 250k / ask 15k ← 当前安装值** | 6% | **42%** | 52% | 6 | 123 |
| 同上 + `allowedEfforts: [low, medium]` | 6% | 94% | 0% | 3 | **97** |

成本口径：low=1 / medium=2 / high=3 求和；"切换"＝档位变化次数，每次＝上游一次前缀失效。

### 2026-11-08：Linux 侧复检（16 段 / 48 有效轮）——无需重标

| 配置 | low | medium | high | 切换 | 成本 |
|---|---|---|---|---|---|
| 上游原值 | 23% | 8% | **69%** | 5 | 118 |
| 当前安装值（past200） | 23% | 50% | 27% | 5 | 98 |
| + `allowedEfforts: [low, medium]` | 23% | 77% | 0% | 4 | 85 |

要点：`userChars` 门在 48 轮中**单独**触发 high 的次数为 0（≥8k 字符的轮注入率 94–98%，
且 tools/ctx 门同轮已触发）——该门在本负载只作冗余确认，暂不动。

### 2026-11-10：运行审计（`session-audit.mjs`，20 段 / 88 轮，安装窗内 42 轮）

- 实际分布 **low 14% / medium 55% / high 31%**；42 轮仅 4 次 `request/header reason=change`（＝4 次前缀失效）。
- 轮内改档 1 次且证明来自外部（侧栏 UI），非本插件。
- **查出 1.6.5 修的缺陷**：harness 创建/恢复会话时落的带 effort 的 `model/selection` 被旧实现当人工接管
  → 20 段里 4 段几乎全程静默。

## 4. 口径差异备忘（重标前必读）

1. **token 估算偏小**：上游统计整个请求体，这里只有消息列表；`contextFloorTokens` 是补偿旋钮（候选配置
   `past200Floor12k` 已支持离线比较）。
2. **语言偏差方向相反**：4 chars/token 对中文低估 2–3 倍；`userChars`（字符数）对中文偏高。
   重标混入英文会话时 `heavyUserChars` 与 `heavyCtxTokens` 要分开看。
3. **注入污染**：user 消息里的框架注入文本让 `userChars` 系统性偏大；`gate-attribution.mjs`
   输出"注入占比"列帮助观察。
4. **累计量**：`toolResults` / `estCtxTokens` 只增不减（折叠也不重置 tool 计数），阈值本质是
   "会话进行到什么程度"的信号，不是"这一轮有多难"。

## 5. `allowedEfforts` 什么时候该开

- **跨路线摘要**：若折叠摘要走另一条模型路线（`BasicCompactionConfig.summarization` 或 `AgentOptions`），
  而那条链会复制会话档位——本插件只按对话路线钳制。把 `allowedEfforts` 设为所有路线共同支持的集合，
  能力错配即不可能发生。
- **KV 减负（选项 2）**：`[low, medium]` 让 high 彻底退役，同批 50 轮成本 −30%、写入仅 3 次。

## 6. 安装与更新

```bash
# 打包并安装
./pack.sh                                     # 产出 release/local-adaptive-effort-scheduler-<ver>.tgz
dsh plugin --profile <profile> add <本目录>    # 或指向 tgz；或在插件管理器 install_bundle
# 装后必须重启 DSH（旧进程仍跑旧代码——见 06 案例研究中真实代价）

# 开发期免打包直挂：把 cordis.yml 放进 profile 后 dsh apply
```

`pack` 会校验 tarball 只含 `files` 清单（dist/cordis 两份/README/LICENSE/locale/icon），
并写 `release/SHA256SUMS.txt`。
