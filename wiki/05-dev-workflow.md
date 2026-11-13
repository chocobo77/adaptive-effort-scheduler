# 05 · 构建、测试、打包与工具链（项目运行方式）

## 1. 零安装依赖的构建体系（scripts/build.mjs）

本目录**不 `npm install`**。`npm run build` / `npm run typecheck` 都先跑 `scripts/build.mjs`：
它把 TypeScript 和 `@deepseek-ai/*` 类型包从别处**借来**，以目录级软链垫进本目录的
`node_modules/`（gitignored 垫片），然后原生调 tsc。tsc、vitest、编辑器全部走原生模块解析，
tsconfig 无需 paths 映射。

### 类型来源探测顺序

```
$DSH_NODE_MODULES   直接给一个 node_modules 目录
$DSH_HOME           给 DSH checkout，取其 node_modules
./node_modules      本目录已有完整垫片或真实安装（以 @types/node 存在为准；真实安装优先）
历史 Windows 路径   D:/Program files/deepseek-harness（自动翻译到 /media 下所有挂载点）
兄弟项目            上下两级目录里各兄弟项目的 node_modules
```

checkout 优先于兄弟项目（npm 发布的类型面可能落后）。`$DSH_TSC` 可显式指定 tsc.js。

### 垫片规则

- 只增不删不覆盖：已有解析正确的链接跳过，真实 `npm install` 的结果永远胜出。
- 两种 deps root 布局都认：published（`@deepseek-ai/*` 是真包）与 checkout（workspace 链接 +
  `vendor/cordis`、`vendor/cosmokit` 需要别名）。
- Windows 用 junction；`@types` 逐项链接（pnpm 布局下整目录 junction 会断内层相对链接）。
- Linux 上 vitest 候选先用"一条断言的探针用例"验证可运行（跨 OS 安装的 native binding 会挂），
  可用才链接进 `.bin`。

### 两个 tsc 目标

| 脚本 | tsconfig | 产物 |
|---|---|---|
| `npm run typecheck` | `tsconfig.typecheck.json`（`noEmit`、全严格 + `exactOptionalPropertyTypes` 等） | 无 |
| `npm run build` | `tsconfig.build.json`（在其上开 emit、`declaration`、`rewriteRelativeImportExtensions`） | `dist/*.js` + `*.d.ts` |

## 2. 测试

```bash
npm test    # vitest run --config vitest.config.ts（include tests/**/*.test.ts，pool: forks）
```

三套测试的职责见 [02-modules §4](./02-modules.md#4-测试套件职责)。
测试直接跑 TS 源码（宿主引用 type-only，编译期擦除），因此任何 vitest 安装都能承载。

## 3. 打包

```bash
pack.cmd                                # Windows（= powershell -File pack.ps1）
./pack.sh                               # bash 复刻
# 选项：--out-dir DIR（默认 release）/ --skip-tests / --keep-out-dir
```

流程：Node ≥ 22.19 检查 → build.mjs 构建 → vitest → `npm pack` → 校验 tarball 只含运行文件 →
写 `release/SHA256SUMS.txt`。当前产物：`local-adaptive-effort-scheduler-1.6.6.tgz`。

`package.json` 要点：

- `peerDependencies`: `@deepseek-ai/cordis` / `@deepseek-ai/dsh-agent`（`workspace:~`，类型面声明）
- `exports`: `.`（插件入口）/ `./effort-bands` / `./auxiliary`（第三方子路径）/ `./locale/*.json` / `./icon`
- `dsh.bundle.patch: ./cordis.patch.yml`（安装时的补丁层）
- `engines.node >= 22.19.0`（zstd 解压等运行时面）

## 4. 离线标定工具（scripts/，不打包）

三个脚本共用同一口径重建"插件在 claim 时刻看到的窗口"：
**派生历史（之前所有轮）+ 该轮开场 user 消息**。日志格式：`session.v4.jsonl.zstd`
（zstd 压缩的 JSONL 事件流，事件带 `seq`/`time`/`type`/`data`）。

### calibration-replay.mjs — 候选配置对比

```bash
node scripts/calibration-replay.mjs --config upstream,past200,past200Plus2 --file-list logs.txt
node scripts/calibration-replay.mjs [候选名...] <session.v4.jsonl.zstd ...>
```

内置候选（节选）：`upstream` / `option1(40,150k)` / `past100` / `past200`（＝当前安装值）/
`past200Plus2`（+allowedEfforts）/ `past200Floor12k`（+contextFloorTokens）。逐会话与总计输出
档位分布、writes（＝前缀失效次数）、cost（low=1/medium=2/high=3）。

### gate-attribution.mjs — 逐轮归因

```bash
node scripts/gate-attribution.mjs [--preset installed|upstream] "<会话目录>/session.v4.jsonl.zstd" ...
```

每轮输出 userChars / ctxTokens / toolRes / 触发的 heavy 门（ctx,tools,userChars）/
**user 消息注入占比**（首 text 块之外的占比估算）。回答"该把哪个门抬到哪"。

### session-audit.mjs — 运行审计（对账）

```bash
node scripts/session-audit.mjs --since <ISO> "<会话目录>\session.v4.jsonl.zstd" ...
# 可选 --dist <effort-bands.js 路径>（默认取已安装 bundle 的）
# 可选 --config-file <cordis.patch.yml 路径>（默认取已安装 bundle 的）
```

逐会话输出：轮数/步数/工具结果/折叠次数 | **schedulerWrites**（轮边界、effort-only、未换路由的
selection 写入）| **midTurn**（轮内档位集合 >1 的轮数）| **chgs**（`reason=change` 的 header 数＝
前缀失效）| 重算 band 分布 | 实际使用档位分布 | **agreed**（实际＝重算 band 的轮数）。

`--since` 用来只统计安装之后发生的轮（长寿命会话跨安装窗口时必需）。

### session-timeline.mjs — 时间线转储

```bash
node scripts/session-timeline.mjs "<会话目录>/session.v4.jsonl.zstd"
```

只打生命周期/selection/header 事件（turn 起止、model/selection、request/header 及其
effort/reason、compaction、user/message 字符数）。人眼看事件序列的第一工具。

## 5. 安装与日常运行

```bash
# ① 正式安装（profile 补丁层，配置来自 cordis.patch.yml）
dsh plugin --profile <profile> add <本目录或 release/*.tgz>
# 重启 DSH 生效 —— 旧进程不会热加载新代码

# ② 开发直挂（配置来自 cordis.yml，指向 ./dist/index.js）
#    把 cordis.yml 内容放进 profile 后 dsh apply；改代码 → npm run build → 再 apply（插件重启）

# ③ 标定期：把 logDecisions 抬到 info，钉档/漏钉行进常规日志
adaptive-effort: turn N pinned <effort> (band <band>, M messages, route <provider/model>)
adaptive-effort: turn N unpinned, capabilities of <route> not resolved yet
```

卸载/禁用：插件管理器操作，或从 profile 移除该行后重启。

## 6. 依赖关系总览

### 运行时（dist 产物）

```
dist/index.js ──相对 import──▶ dist/effort-bands.js
             └─相对 import──▶ dist/auxiliary.js
（无任何包名 import；宿主类型在编译期擦除）
```

### 开发/工具链

| 依赖 | 来源 | 用途 |
|---|---|---|
| typescript | 借自 DSH checkout / 兄弟项目（垫片） | tsc 编译与类型检查 |
| `@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent` 类型 | 同上 | `import type` 面唯一来源 |
| vitest | 同上（Linux 上探针验证后链接） | 测试 |
| node:fs / node:zlib / node:child_process 等 | Node 内置 | 构建脚本与审计工具（zstd 解压需 Node ≥ 22.15 的 `zlib.zstdDecompressSync`） |
| npm pack | 自带 | 打包 tgz |

### 上游血统

```
Hermes agent/reasoning_effort.py（三档确定性门）
  └─▶ OmniRoute open-sse/services/adaptiveEffort.ts（网关逐请求判定）
        ├─ specificityRules.estimateTokens / estimateMessageTokens   → effort-bands.ts 同名函数
        └─ resolveAdaptiveEffort（:33-37 阈值 / :94-105 判定）         → resolveBand()
              └─▶ 本插件（DSH 事件缝上的 per-turn pin 版）
```
