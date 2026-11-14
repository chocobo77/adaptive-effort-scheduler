/**
 * Session audit — did the scheduler actually pin, and did the pin hold?
 *
 * Reads persisted Harness session logs and reports, per session, the decisions
 * the plugin wrote (`model/selection` at a turn boundary), the effort each
 * request actually carried (`request/header`), and the band the installed
 * decision function computes for the same windows under the installed config.
 * A development tool; not part of the runtime and not packed in the tarball.
 *
 * Usage: node scripts/session-audit.mjs [--dist <path to dist>] <log files...>
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolve the installed bundle from the Harness data directory, so the tool
// travels between machines: $DSH_HOME (default ~/.dsh) + $DSH_PROFILE (web).
const bundleHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const bundleProfile = process.env.DSH_PROFILE ?? 'web'
const bundleDir = join(bundleHome, 'profiles', bundleProfile, 'node_modules', '@local', 'adaptive-effort-scheduler')
const args = process.argv.slice(2)
const distIndex = args.indexOf('--dist')
const dist = distIndex >= 0 ? args[distIndex + 1] : join(bundleDir, 'dist', 'effort-bands.js')
// Optional ISO cutoff: ignore turns that happened before the plugin ran, so a
// corpus of long-lived sessions measures only post-install behavior.
const sinceArg = args.indexOf('--since')
const since = sinceArg >= 0 ? Date.parse(args[sinceArg + 1]) : Number.NEGATIVE_INFINITY
// The config the profile actually runs, read from the installed bundle's patch
// layer so an audit can never silently measure against the wrong thresholds.
const patchIndex = args.indexOf('--config-file')
const patchFile = patchIndex >= 0
  ? args[patchIndex + 1]
  : join(bundleDir, 'cordis.patch.yml')
const skip = new Set()
for (const flagIndex of [distIndex, sinceArg, patchIndex]) {
  if (flagIndex >= 0) skip.add(flagIndex).add(flagIndex + 1)
}
const files = args.filter((_, index) => !skip.has(index))
const { DEFAULT_THRESHOLDS, resolveBand, clampBand } = await import(pathToFileURL(dist).href)

/** Read the scalar threshold keys (and an `allowedEfforts` list) out of a patch file. */
function readPatchConfig(path) {
  const config = { ...DEFAULT_THRESHOLDS, allowedEfforts: undefined, contextFloorTokens: 0 }
  let text = ''
  try { text = fs.readFileSync(path, 'utf8') } catch { return config }
  for (const key of ['trivialUserChars', 'trivialCtxTokens', 'heavyCtxTokens', 'heavyToolResults', 'heavyUserChars', 'contextFloorTokens']) {
    const match = new RegExp(`^\\s*${key}:\\s*([0-9]+)\\s*$`, 'm').exec(text)
    if (match !== null) config[key] = Number(match[1])
  }
  const allowed = /^\s*allowedEfforts:\s*\[([^\]]*)\]\s*$/m.exec(text)
  if (allowed !== null) {
    config.allowedEfforts = allowed[1].split(',').map(value => value.trim()).filter(Boolean)
  }
  return config
}

const CONFIG = readPatchConfig(patchFile)
// An `allowedEfforts` ceiling in the patch is mirrored by the clamp in audit().
const ALLOWED = CONFIG.allowedEfforts
console.log(`config read from ${patchFile}`)
console.log(`  thresholds: ${JSON.stringify(CONFIG, (_, value) => Array.isArray(value) ? value.join('/') : value)}\n`)

const textOf = content => typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('') : ''

function audit(file) {
  const events = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line))
  const turns = []
  let current = null
  const selections = []
  let steps = 0
  let toolResults = 0
  let compactions = 0
  let headerChanges = 0
  for (const event of events) {
    if ((event.time ?? 0) < since) continue
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, seq: event.seq, messages: [], headers: [], selections: [] }
      turns.push(current)
    }
    if (event.type === 'step/start') steps += 1
    if (event.type === 'tool/result') toolResults += 1
    if (event.type === 'compaction/start') compactions += 1
    if (current === null) continue
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
      const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : 'tool'
      current.messages.push({ role, content: event.data?.message?.content ?? event.data?.content ?? event.data?.result })
    }
    if (event.type === 'request/header') {
      const config = event.data?.header?.config ?? {}
      if (event.data?.reason === 'change') headerChanges += 1
      current?.headers.push({ effort: config.reasoningEffort, reason: event.data?.reason, provider: config.provider, model: config.model })
    }
    if (event.type === 'model/selection') {
      const entry = { seq: event.seq, provider: event.data?.provider, model: event.data?.model, effort: event.data?.reasoningEffort }
      current.selections.push(entry)
      selections.push({ ...entry, turn: current.turn })
    }
  }
  // Compute the band the plugin would decide for each turn, from the same view.
  const prefix = []
  for (const turn of turns) {
    const opening = turn.messages.find(message => message.role === 'user')
    const window = opening === undefined ? [...prefix] : [...prefix, opening]
    const band = resolveBand(window, CONFIG, { tokens: CONFIG.contextFloorTokens ?? 0 })
    turn.band = ALLOWED === undefined ? band : clampBand(band, ALLOWED) ?? band
    turn.userChars = opening === undefined ? 0 : textOf(opening.content).length
    turn.toolResultsBefore = prefix.filter(message => message.role === 'tool').length
    turn.route = turn.headers[0] === undefined ? undefined : `${turn.headers[0].provider}/${turn.headers[0].model}`
    for (const message of turn.messages) prefix.push(message)
  }
  // A write counts as scheduler-authored when it lands at the turn boundary
  // (after turn/start, before the turn's first request/header) and is effort-only.
  let schedulerWrites = 0
  for (const turn of turns) {
    for (const selection of turn.selections) {
      const routeChanged = selection.provider !== turn.route?.split('/')[0] || selection.model !== turn.route?.split('/').slice(1).join('/')
      const atBoundary = turn.headers.length === 0 || selection.seq < (turn.headers[0]?.seq ?? Number.POSITIVE_INFINITY)
      if (!routeChanged && atBoundary && selection.effort !== undefined) schedulerWrites += 1
    }
  }
  const midTurn = turns.filter(turn => new Set(turn.headers.map(header => header.effort ?? 'default')).size > 1).length
  const changes = turns
    .map(turn => turn.headers.map(header => header.effort ?? 'default'))
    .filter(list => list.length > 0)
  const agreed = turns.filter(turn => {
    const used = [...new Set(turn.headers.map(header => header.effort ?? 'default'))]
    return used.length === 1 && used[0] === turn.band
  }).length
  const withEvidence = changes.length
  return {
    label: (file.split(/[\\/]/).slice(-2, -1)[0] ?? file).slice(0, 22),
    events: events.length, turns: turns.length, steps, toolResults, compactions,
    selections: selections.length, schedulerWrites, midTurn, headerChanges,
    bandCounts: turns.reduce((all, turn) => ({ ...all, [turn.band]: (all[turn.band] ?? 0) + 1 }), {}),
    usedCounts: turns.reduce((all, turn) => {
      for (const value of new Set(turn.headers.map(header => header.effort ?? 'default'))) all[value] = (all[value] ?? 0) + 1
      return all
    }, {}),
    agreed, withEvidence,
  }
}

const totals = { turns: 0, schedulerWrites: 0, midTurn: 0, headerChanges: 0, agreed: 0, withEvidence: 0, low: 0, medium: 0, high: 0, compactions: 0 }
console.log('session                 turns  steps toolRes  compr | writes  midTurn  chgs | band: L/M/H        used: L/M/H(def)   agreed')
for (const file of files) {
  const report = audit(file)
  const bandText = `${report.bandCounts.low ?? 0}/${report.bandCounts.medium ?? 0}/${report.bandCounts.high ?? 0}`
  const usedText = `${report.usedCounts.low ?? 0}/${report.usedCounts.medium ?? 0}/${report.usedCounts.high ?? 0}(${report.usedCounts.default ?? 0})`
  console.log(
    `${report.label.padEnd(22)} ${String(report.turns).padStart(5)} ${String(report.steps).padStart(6)} ` +
    `${String(report.toolResults).padStart(6)} ${String(report.compactions).padStart(6)} | ` +
    `${String(report.schedulerWrites).padStart(6)} ${String(report.midTurn).padStart(7)} ${String(report.headerChanges).padStart(5)} | ` +
    `${bandText.padEnd(16)} ${usedText.padEnd(18)} ${report.agreed}/${report.withEvidence}`,
  )
  totals.turns += report.turns
  totals.schedulerWrites += report.schedulerWrites
  totals.midTurn += report.midTurn
  totals.headerChanges += report.headerChanges
  totals.agreed += report.agreed
  totals.withEvidence += report.withEvidence
  totals.low += report.bandCounts.low ?? 0
  totals.medium += report.bandCounts.medium ?? 0
  totals.high += report.bandCounts.high ?? 0
  totals.compactions += report.compactions
}
const pct = value => `${Math.round((value / Math.max(totals.turns, 1)) * 100)}%`
console.log(
  `TOTAL                     ${String(totals.turns).padStart(5)}        ${' '.repeat(12)}| ` +
  `${String(totals.schedulerWrites).padStart(6)} ${String(totals.midTurn).padStart(7)} ${String(totals.headerChanges).padStart(5)} | ` +
  `${pct(totals.low)}/${pct(totals.medium)}/${pct(totals.high)} (compaction ${totals.compactions})   agreed ${totals.agreed}/${totals.withEvidence}`,
)
