/**
 * The pure half of the scheduler: request-shape signals -> effort band.
 *
 * Ported 1:1 from OmniRoute `open-sse/services/adaptiveEffort.ts`
 * (`resolveAdaptiveEffort`, thresholds at :33-37, decision at :94-105, token
 * estimate in `open-sse/services/specificityRules.ts`). Nothing here imports a
 * host package, so the band is unit-testable without a Harness checkout.
 *
 * Signals (every one of them is a count over messages that already exist; no
 * regex heuristics, no model call):
 *
 *   userChars        text characters of the LAST user message
 *   estCtxTokens     Σ ceil(chars/4) over that message and everything BEFORE it
 *   toolResults      role=='tool' messages strictly BEFORE that message
 *   turnDepth        assistant messages carrying a tool call AFTER it, + 1
 *
 * Mapping onto low | medium | high:
 *   trivial  userChars <= trivialUserChars AND estCtxTokens <= trivialCtxTokens
 *            AND toolResults === 0 AND turnDepth <= 1                     -> low
 *   heavy    estCtxTokens >= heavyCtxTokens OR toolResults >= heavyToolResults
 *            OR userChars >= heavyUserChars                               -> high
 *   otherwise                                                             -> medium
 *   no messages at all                                                    -> medium
 *
 * The STATELESS PER-TURN PIN lives inside this function: the three load-bearing
 * signals are read only from the last user message and everything before it, and
 * the one signal that looks after it (`turnDepth`) can only veto `low`. So
 * assistant turns and tool results appended mid-loop never move the band, and
 * every request of one user turn resolves to the same value with no stored state.
 *
 * @module adaptive-effort-scheduler/effort-bands
 */

/** The three bands the scheduler pins, in escalation order. */
export type EffortBand = 'low' | 'medium' | 'high'

/** Band ladder used by the route clamp. */
export const BAND_LADDER: readonly EffortBand[] = Object.freeze(['low', 'medium', 'high'])

/** Tunable copies of the OmniRoute constants; defaults are the upstream values. */
export interface BandThresholds {
  /** At most this many user-message characters still counts as a trivial ask. */
  readonly trivialUserChars: number
  /** At most this many estimated context tokens still counts as a small window. */
  readonly trivialCtxTokens: number
  /** At least this many estimated context tokens is heavy work. */
  readonly heavyCtxTokens: number
  /** At least this many prior tool results is heavy work. */
  readonly heavyToolResults: number
  /** At least this many user-message characters is heavy work. */
  readonly heavyUserChars: number
}

/** OmniRoute `adaptiveEffort.ts:33-37`, verbatim. */
export const DEFAULT_THRESHOLDS: BandThresholds = Object.freeze({
  trivialUserChars: 160,
  trivialCtxTokens: 4000,
  heavyCtxTokens: 60000,
  heavyToolResults: 6,
  heavyUserChars: 4000,
})

/** A message shaped like the model-visible ones: role plus text-bearing content. */
export interface ShapedMessage {
  readonly role?: unknown
  readonly content?: unknown
}

/**
 * Harness-only calibration for `estCtxTokens`. Upstream counted the whole request
 * body, which in a gateway includes the system prompt and the tool schemas; a
 * Harness session log keeps those outside the message list, so the same threshold
 * is measured against a systematically smaller number here. `tokens` adds a
 * calibrated constant for that invisible part (0 keeps the upstream reading exact).
 */
export interface BandEstimateFloor {
  readonly tokens?: number
}

/**
 * The counted text of one message's content: the whole string, or each `text`
 * block of an array. Images, files, reasoning and tool-call blocks are not
 * counted, exactly as upstream counts only `part.text`.
 */
function* countedText(content: unknown): Generator<string> {
  if (typeof content === 'string') {
    yield content
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block !== null && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      yield (block as { text: string }).text
    }
  }
}

/**
 * Counted text length of one message: string content counts whole, array
 * content counts each `text` block.
 * @param content - the message's `content` value.
 * @returns the counted character length.
 */
export function messageTextChars(content: unknown): number {
  let sum = 0
  for (const text of countedText(content)) sum += text.length
  return sum
}

/** `specificityRules.estimateTokens`: four characters per token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * `specificityRules.estimateMessageTokens`, including its per-part rounding:
 * each message's string content, or each of its text parts, is estimated
 * separately and summed.
 * @param messages - messages to estimate over.
 * @returns the estimated token total.
 */
export function estimateMessageTokens(messages: readonly ShapedMessage[]): number {
  let sum = 0
  for (const message of messages) {
    for (const text of countedText(message?.content)) sum += estimateTokens(text)
  }
  return sum
}

/** `lastUserMessageIndex`: index of the last `user` message, -1 when there is none. */
export function lastUserMessageIndex(messages: readonly ShapedMessage[]): number {
  let last = -1
  for (let index = 0; index < messages.length; index += 1) if (messages[index]?.role === 'user') last = index
  return last
}

/** `countRole`: messages with this role inside [from, to). */
export function countRole(messages: readonly ShapedMessage[], role: string, from: number, to: number): number {
  let count = 0
  for (let index = from; index < to; index += 1) if (messages[index]?.role === role) count += 1
  return count
}

/**
 * `toolLoopDepthAfter`: assistant turns carrying a tool call after the turn
 * boundary. Upstream reads the OpenAI `tool_calls` field; in Harness a tool call
 * is a `tool-call` content block on an assistant message.
 */
export function toolLoopDepthAfter(messages: readonly ShapedMessage[], boundary: number): number {
  let count = 0
  for (let index = boundary + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    if (message.content.some(block => block !== null && typeof block === 'object'
      && (block as { type?: unknown }).type === 'tool-call')) count += 1
  }
  return count
}

/**
 * The extracted resolver, 1:1 with `resolveAdaptiveEffort`.
 * @param messages - the visible conversation in request order.
 * @param thresholds - band thresholds; defaults are the upstream constants.
 * @param floor - Harness-only adjustment, see `BandEstimateFloor`.
 * @returns the resolved band.
 */
export function resolveBand(
  messages: readonly ShapedMessage[] | undefined | null,
  thresholds: BandThresholds = DEFAULT_THRESHOLDS,
  floor: BandEstimateFloor = {},
): EffortBand {
  const msgs = Array.isArray(messages) ? messages : []
  // No signals at all -> balanced band, never cheap-by-default.
  if (msgs.length === 0) return 'medium'
  const boundary = lastUserMessageIndex(msgs)
  const upToTurn = boundary >= 0 ? msgs.slice(0, boundary + 1) : msgs
  const userChars = boundary >= 0 ? messageTextChars(msgs[boundary].content) : 0
  const estCtxTokens = estimateMessageTokens(upToTurn) + (floor.tokens ?? 0)
  const toolResults = boundary >= 0 ? countRole(msgs, 'tool', 0, boundary) : 0
  const turnDepth = boundary >= 0 ? toolLoopDepthAfter(msgs, boundary) + 1 : 1

  const trivial = userChars <= thresholds.trivialUserChars
    && estCtxTokens <= thresholds.trivialCtxTokens
    && toolResults === 0
    && turnDepth <= 1
  if (trivial) return 'low'
  const heavy = estCtxTokens >= thresholds.heavyCtxTokens
    || toolResults >= thresholds.heavyToolResults
    || userChars >= thresholds.heavyUserChars
  if (heavy) return 'high'
  return 'medium'
}

/**
 * Clamp a band to the efforts one route actually advertises, de-escalating
 * first. Harness rejects an unadvertised effort at request time
 * (`UNSUPPORTED_REASONING_EFFORT`), so guessing is never worth one failed turn.
 * @param band - the decided band.
 * @param allowed - effort ids the route declares, in escalation order.
 * @param ladder - the band order to walk; defaults to low/medium/high.
 * @returns an effort to pin, or undefined to leave the adapter default alone.
 */
export function clampBand(
  band: EffortBand,
  allowed: readonly string[],
  ladder: readonly string[] = BAND_LADDER,
): string | undefined {
  const index = ladder.indexOf(band)
  for (let step = index; step >= 0; step -= 1) if (allowed.includes(ladder[step])) return ladder[step]
  for (let step = index + 1; step < ladder.length; step += 1) if (allowed.includes(ladder[step])) return ladder[step]
  return undefined
}
