# 06 · 案例研究：session-9df5ae49-fb47-46cf-90f3-5dad609e4b85

用仓库自带工具对一段真实会话做逐轮对账，回答"插件装上之后到底起了什么作用"。
分析时间：2026-11-13；插件版本 1.6.6（2026-11-10 23:52 安装于 profile `web`）。

会话位置：`C:\Users\Administrator\.dsh\sessions\--D-Program~0020files-deepseek-harness--\session-9df5ae49-…\session.v4.jsonl.zstd`
（工作目录为 deepseek-harness checkout，即 DSH 开发自用会话）

## 1. 总账

```
node scripts/session-audit.mjs <session.v4.jsonl.zstd>
```

```
session                 turns  steps toolRes  compr | writes  midTurn  chgs | band: L/M/H        used: L/M/H(def)   agreed
session-9df5ae49-…        35    663    830     20 |      2       0     1 | 0/2/33           0/26/1(0)          3/27
```

| 指标 | 值 | 解读 |
|---|---|---|
| 轮次 / 步数 / 工具结果 | 35 / 663 / 830 | 典型重度工具会话 |
| 重算 band（安装阈值口径） | low 0 / med 2 / **high 33** | 该会话从第 3 轮起就稳定越过 heavy 门（累计型信号只增不减） |
| 实际使用档位 | med 26 / high 1 / default 0 | 与 band 严重背离 → 存在静默窗口 |
| 轮内改档（midTurn） | **0** | 凡被钉住的轮，档位全程保持 ✔ |
| `reason=change`（前缀失效） | 1 | 唯一一次与人工改档同刻，**无插件引起的前缀失效** |
| agreed（实际＝重算 band） | 3/27 | 其中 2 轮是 band 恰为 medium 的巧合匹配，真正由插件定档的只有 1 轮 |

## 2. 三段式时间线

会话内共 3 条 `model/selection` 事件，全部同一路由 `strata/iq3_s`：

| seq | 本地时间 | effort | 位置 | 归属判定 |
|---|---|---|---|---|
| 3 | 11-12 14:10 | medium | turn/start **之前** | Harness 写的会话初始 selection（1.6.5 定义的"pre-claim"值） |
| 2583 | 11-13 09:37 | **high** | turn 16 边界，与 turn/start、user/message 同秒 | **插件写入**：band=high，轮边界、effort-only、未换路由，与 claim 时刻写入的指纹完全一致；随后 header `effort=high reason=resume` |
| 2811 | 11-13 10:32 | medium | turn 17 边界 | **人工接管**：band 仍为 high 且路由上一轮刚证明可用 high，插件不可能写 medium |

逐轮明细（节选，完整 35 轮见审计）：

```
turn   band    used        selection 写入
  1-2  medium  medium      -            ← band 与默认巧合一致
 3-15  high    medium      -            ← 【静默窗口 A】插件零写入
 16    high    high        high@2583    ← 【唯一受控轮】钉 high，整轮保持，0 次轮内改档
 17    high    medium      medium@2811  ← 人工接管（用户手选 medium）
18-35  high    medium      -            ← 【静默窗口 B】插件按设计永久让位
```

归因（`gate-attribution.mjs --preset installed`，节选）：heavy 门由 **tools 累计门**从第 3 轮
（205 个工具结果）起持续触发；`userChars` 门仅在 6/14/17 轮叠加触发，且这几轮注入占比
98–99%（框架注入撑大的"用户消息"）；ctx 门全程未单独触发（182k–206k < 250k）。
即本会话的 high 判定全部来自累计工具量，属该阈值设计下的预期 heavy。

turn 15 结束于 11-13 00:48，turn 16 开始于 09:37，中间约 9 小时空档 + 首个 header
`reason=resume` —— **DSH 宿主进程在夜间重启过，会话随后 resume**。这是窗口 A/B 分界的物理原因。

## 3. 两处静默的成因

### 窗口 A（turns 3–15，11-12 白天）：旧代码仍在跑（1.6.5 已修的缺陷的现实代价）

- 1.6.6 bundle 于 11-10 23:52 装进 profile，但**装后需重启 DSH**；该会话 11-12 14:10 开始时，
  宿主进程大概率仍运行着 ≤1.6.4 的旧代码。
- 旧版把 seq 3 这条 pre-claim `effort=medium` 当成人工接管 → `explicitSessions` 命中 → 整段静默。
  症状与 1.6.5 commit message 描述完全一致（"12 轮会话全程 medium，而重算 band 有 9 轮是 high"）。
- 夜间宿主重启后，1.6.6 生效；`explicitSessions` 是进程内状态，随之清零 → turn 16 立刻恢复钉档。
- **验证闭环**：若窗口 A 是其它原因（如路由能力未解析），插件会打 unpinned 日志而不是完全静默；
  且 turn 16 同会话同路由即刻钉档成功，排除路由侧解释。

### 窗口 B（turns 17–35，11-13 白天）：人工接管，按设计让位

- turn 17 的 medium 写入不可能是插件的（band=high、路由可用 high、上一轮刚用过 high）。
- 该写入符合 1.6.5/1.6.6 全部三个"不算接管"的例外吗？逐一对照：
  回声（≠，值从 high 变 medium）✘；pre-claim（✘，会话早已 claim）；
  三值全同 re-assertion（✘，effort 值变了）——即**值发生变化的选择**，按设计判为人工接管。
- 后续 18 轮插件零写入、全程 medium，`respectExplicitSelection: true` 的预期行为。
- 代价：18 轮 band=high 的重活跑在 medium 上（推理强度低于重算建议——省了钱，但可能损失质量）。

## 4. 结论：这个会话里插件的效果

1. **机制层面全部正确**：唯一受控轮（16）精确落在 band 上（high）并整轮保持；整段 663 步的会话
   轮内改档为 0，没有制造任何一次前缀失效；人工接管后让位干净、无反复。
2. **覆盖率层面几乎为零**：35 轮里插件实际控制 1 轮（2.9%）。33 轮 band=high 的轮里 32 轮跑在 medium。
   该会话的档位实际由「会话初始默认 medium + 一次人工手选 medium」决定，调度器未参与。
3. **两处静默一旧一新**：窗口 A 是**已修复缺陷的存量代价**（装了新包没重启宿主），属于运维问题，
   重启后自愈，且 1.6.6 之后新建会话不会再有这类 seq-3 误判；窗口 B 是**设计内行为**
   （显式人工选择优先级最高），无 bug，但如果用户期望"手选只管一轮"，需要把
   `respectExplicitSelection` 关掉或改造为 per-turn。
4. **对重标的意义**：本会话是"重度工具、高注入、长时"负载的典型样本（830 工具结果、20 次折叠、
   band 从第 3 轮起锁 high）。它提示安装阈值下这类会话的稳态就是 high——若这种负载上高频出现
   人工降档到 medium 的行为，说明 250k/200 的 heavy 门对本部署仍偏松，可考虑
   `allowedEfforts: [low, medium]`（选项 2，实测成本 −30%）或继续上抬累计门。

## 5. 复现命令

```bash
cd D:/code/DSH/adaptive-effort-scheduler
S="C:/Users/Administrator/.dsh/sessions/--D-Program~0020files-deepseek-harness--/session-9df5ae49-fb47-46cf-90f3-5dad609e4b85/session.v4.jsonl.zstd"
node scripts/session-audit.mjs "$S"                       # 总账（band vs used vs writes）
node scripts/session-timeline.mjs "$S"                    # 事件时间线（selection/header/turn）
node scripts/gate-attribution.mjs --preset installed "$S" # 逐轮哪个 heavy 门触发 + 注入占比
```
