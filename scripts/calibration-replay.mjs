/**
 * Offline calibration replay — a development tool, not part of the runtime.
 *
 * Rebuilds each turn's decision window from a persisted Harness session log
 * (`session.v4.jsonl.zstd`) exactly as the plugin sees it at claim time: the
 * derived history (all previous turns) plus that turn's opening user message.
 * Then it replays the band decision under one or more candidate configs and
 * reports, per session:
 *
 *   band distribution        how many turns land on low / medium / high
 *   writes                   band changes the scheduler would have written
 *                            (each one is a config change upstream pays a
 *                            prompt-cache prefix invalidation for)
 *   effortRankSum            a rough cost proxy (low=1, medium=2, high=3)
 *
 * Usage:
 *   node scripts/calibration-replay.mjs [--config name,name] <log files...>
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import { clampBand, DEFAULT_THRESHOLDS, resolveBand } from '../dist/effort-bands.js'

/**
 * Candidate threshold sets under evaluation. `tokens` is the plugin's
 * `contextFloorTokens`: the estimated size of the system prompt + tool schemas
 * the session log omits (0 replays the upstream reading exactly).
 */
const CANDIDATES = {
  // What is installed today: the verbatim upstream constants.
  upstream: { ...DEFAULT_THRESHOLDS, allowed: undefined },
  // Option 1: raise the two cumulative gates so `medium` actually exists in the
  // middle of a long tool-heavy session and `high` only appears late.
  option1: { ...DEFAULT_THRESHOLDS, heavyToolResults: 40, heavyCtxTokens: 150_000, allowed: undefined },
  option1gentler: { ...DEFAULT_THRESHOLDS, heavyToolResults: 60, heavyCtxTokens: 200_000, allowed: undefined },
  // Option 2 on top of option 1: the ceiling removes `high` entirely.
  option1plus2: { ...DEFAULT_THRESHOLDS, heavyToolResults: 40, heavyCtxTokens: 150_000, allowed: ['low', 'medium'] },
  // Option 2 alone, over upstream gates.
  option2only: { ...DEFAULT_THRESHOLDS, allowed: ['low', 'medium'] },
  // Gates pushed past where these sessions saturate, so the ask-size gate is
  // the discriminator instead of the two cumulative latches.
  past100: { ...DEFAULT_THRESHOLDS, heavyToolResults: 100, heavyCtxTokens: 200_000, heavyUserChars: 15_000, allowed: undefined },
  past200: { ...DEFAULT_THRESHOLDS, heavyToolResults: 200, heavyCtxTokens: 250_000, heavyUserChars: 15_000, allowed: undefined },
  past200Ask: { ...DEFAULT_THRESHOLDS, heavyToolResults: 200, heavyCtxTokens: 250_000, heavyUserChars: 8_000, allowed: undefined },
  past200Low: { ...DEFAULT_THRESHOLDS, heavyToolResults: 200, heavyCtxTokens: 250_000, heavyUserChars: 15_000, trivialUserChars: 400, trivialCtxTokens: 12_000, allowed: undefined },
  past200Plus2: { ...DEFAULT_THRESHOLDS, heavyToolResults: 200, heavyCtxTokens: 250_000, heavyUserChars: 15_000, allowed: ['low', 'medium'] },
  // The installed gates with the invisible part of the request priced in
  // (system prompt + tool schemas, measured around 12k tokens here).
  past200Floor12k: { ...DEFAULT_THRESHOLDS, heavyToolResults: 200, heavyCtxTokens: 250_000, heavyUserChars: 15_000, tokens: 12_000, allowed: undefined },
}

/** Rebuild the per-turn decision windows from one session log. */
function readTurns(file) {
  const events = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line))
  const turns = []
  let current = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, messages: [] }
      turns.push(current)
    }
    if (current === null) continue
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
      const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : 'tool'
      current.messages.push({ role, content: event.data?.message?.content ?? event.data?.content ?? event.data?.result })
    }
  }
  const prefix = []
  const windows = []
  for (const turn of turns) {
    const opening = turn.messages.find(message => message.role === 'user')
    windows.push(opening === undefined ? [...prefix] : [...prefix, opening])
    for (const message of turn.messages) prefix.push(message)
  }
  return windows
}

const args = process.argv.slice(2)
const names = args[0] === '--config' ? args[1].split(',') : Object.keys(CANDIDATES)
let files = args[args[0] === '--config' ? 2 : 0] === '--file-list'
  ? fs.readFileSync(args[args[0] === '--config' ? 3 : 1], 'utf8').split(/\r?\n/).filter(Boolean)
  : args.slice(args[0] === '--config' ? 2 : 0)
const RANK = { low: 1, medium: 2, high: 3 }

for (const name of names) {
  const candidate = CANDIDATES[name]
  if (candidate === undefined) {
    console.error(`unknown candidate "${name}"`)
    continue
  }
  let totals = { low: 0, medium: 0, high: 0, writes: 0, turns: 0, cost: 0 }
  console.log(`\n### ${name}  (heavyToolResults=${candidate.heavyToolResults}, heavyCtxTokens=${candidate.heavyCtxTokens}, tokens=${candidate.tokens ?? 0}, allowed=${candidate.allowed?.join('/') ?? 'route'})`)
  for (const file of files) {
    const windows = readTurns(file)
    let previous
    let changes = 0
    const bands = windows.map(window => {
      const band = resolveBand(window, candidate, { tokens: candidate.tokens ?? 0 })
      const pinned = candidate.allowed === undefined ? band : clampBand(band, candidate.allowed) ?? band
      if (previous !== undefined && pinned !== previous) changes += 1
      previous = pinned
      return pinned
    })
    const counts = bands.reduce((all, band) => ({ ...all, [band]: (all[band] ?? 0) + 1 }), {})
    const label = file.split(/[\\/]/).slice(-2, -1)[0]?.slice(0, 18) ?? file
    console.log(
      `  ${label.padEnd(20)} turns=${String(bands.length).padStart(3)}  ` +
      `low=${String(counts.low ?? 0).padStart(3)} med=${String(counts.medium ?? 0).padStart(3)} high=${String(counts.high ?? 0).padStart(3)}  ` +
      `writes=${changes}  cost=${bands.reduce((sum, band) => sum + (RANK[band] ?? 0), 0)}`,
    )
    totals = {
      low: totals.low + (counts.low ?? 0),
      medium: totals.medium + (counts.medium ?? 0),
      high: totals.high + (counts.high ?? 0),
      writes: totals.writes + changes,
      turns: totals.turns + bands.length,
      cost: totals.cost + bands.reduce((sum, band) => sum + (RANK[band] ?? 0), 0),
    }
  }
  const pct = value => `${Math.round((value / Math.max(totals.turns, 1)) * 100)}%`
  console.log(
    `  TOTAL                      turns=${String(totals.turns).padStart(3)}  ` +
    `low=${pct(totals.low)} med=${pct(totals.medium)} high=${pct(totals.high)}  ` +
    `writes=${totals.writes}  cost=${totals.cost}`,
  )
}
