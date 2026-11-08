/**
 * Gate attribution — which heavy/trivial condition fires on each turn, with the
 * raw signal values. A development tool, not part of the runtime.
 *
 * Why this exists: in a Harness session the last user message often carries
 * framework-injected text (task-state cards, retrieved context, runtime
 * context), so `userChars` overstates the size of the human ask compared to the
 * raw client message a gateway sees. The numbers below decide where the
 * `heavyUserChars` gate actually belongs for this workload.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import {
  DEFAULT_THRESHOLDS,
  estimateMessageTokens,
  messageTextChars,
  countRole,
  lastUserMessageIndex,
} from '../dist/effort-bands.js'

/** Threshold presets: upstream defaults, or the deployed calibrated set. */
const PRESETS = {
  upstream: DEFAULT_THRESHOLDS,
  installed: { ...DEFAULT_THRESHOLDS, heavyToolResults: 200, heavyCtxTokens: 250_000, heavyUserChars: 15_000 },
}
const presetArg = process.argv.indexOf('--preset')
const thresholds = presetArg !== -1 ? (PRESETS[process.argv[presetArg + 1]] ?? DEFAULT_THRESHOLDS) : DEFAULT_THRESHOLDS
const files = presetArg !== -1 ? process.argv.slice(presetArg + 2) : process.argv.slice(2)
if (presetArg !== -1 && PRESETS[process.argv[presetArg + 1]] === undefined) {
  console.error(`unknown preset "${process.argv[presetArg + 1]}" (upstream | installed)`)
  process.exit(2)
}

for (const file of files) {
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
  console.log(`\n=== ${(file.split(/[\\/]/).slice(-2, -1)[0] ?? '').slice(0, 22)} ===`)
  console.log('turn   userChars   ctxTokens   toolRes   fired heavy gates            injected share of user msg')
  for (const turn of turns) {
    const opening = turn.messages.find(message => message.role === 'user')
    const window = opening === undefined ? [...prefix] : [...prefix, opening]
    const boundary = lastUserMessageIndex(window)
    const userChars = boundary >= 0 ? messageTextChars(window[boundary].content) : 0
    const ctxTokens = estimateMessageTokens(window)
    const toolResults = boundary >= 0 ? countRole(window, 'tool', 0, boundary) : 0
    const fired = []
    if (ctxTokens >= thresholds.heavyCtxTokens) fired.push('ctx')
    if (toolResults >= thresholds.heavyToolResults) fired.push('tools')
    if (userChars >= thresholds.heavyUserChars) fired.push('userChars')
    // How much of the "user message" is framework injection rather than the human ask:
    // injected blocks carry a scope/marker line, and the human text is usually the
    // first block. Ratio = 1 - (first text block / total).
    const blocks = Array.isArray(opening?.content) ? opening.content.filter(block => block?.type === 'text') : []
    const first = blocks.length > 0 ? (blocks[0].text ?? '').length : userChars
    const injected = userChars === 0 ? 0 : Math.round((1 - first / userChars) * 100)
    console.log(
      `${String(turn.turn).padStart(4)} ${String(userChars).padStart(10)} ${String(ctxTokens).padStart(11)} ` +
      `${String(toolResults).padStart(9)}   ${(fired.join(',') || '-').padEnd(25)} ${String(injected).padStart(4)}%`,
    )
    for (const message of turn.messages) prefix.push(message)
  }
}
