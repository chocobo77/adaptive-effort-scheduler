/**
 * Adaptive reasoning-effort scheduler — pins one reasoning effort per user turn.
 *
 * The pure band decision lives in ./effort-bands.ts (ported 1:1 from OmniRoute
 * `open-sse/services/adaptiveEffort.ts`). This module is only the Harness
 * wiring: where the signals come from, where the choice is written, and why that
 * seam and no other.
 *
 * Seam choice (verified against the current Harness sources):
 *  - `agent/request` is `@deprecated` and documented as unable to change
 *    provider, model, or reasoning effort (packages/core/agent/src/runtime-types.ts:362-373).
 *  - The `llm/stream` waterfall hands the agent-loop request deep-frozen:
 *    listeners read it, never rewrite it (see also the `markAgentLoopRequest`
 *    contract used by sibling context-governance plugins).
 *  - `agent/pre-step` is one beat late: the loop captured the step's selection
 *    before the waterfall runs (packages/core/agent-loop/src/agent.ts:287-297),
 *    so a `select()` there lands on the NEXT step — i.e. mid-turn.
 *  - `agent/inbox/claimed` fires synchronously inside `inbox.claim()`, still
 *    before that capture, so it is the last point whose choice reaches this
 *    turn's requests. That is the pin point.
 *
 * Runtime cost: no third-party or host-runtime import (types only), no model
 * call, no persistence. State is one pin slot per Agent plus one capability
 * cache keyed by `provider/model`.
 *
 * @module adaptive-effort-scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection, PreStepDecision } from '@deepseek-ai/dsh-agent'

import {
  clampBand,
  DEFAULT_THRESHOLDS,
  resolveBand,
  type BandThresholds,
  type ShapedMessage,
} from './effort-bands.ts'
import { pinRegistry, publishPin } from './auxiliary.ts'

export { DEFAULT_THRESHOLDS, resolveBand, clampBand } from './effort-bands.ts'
export type { BandThresholds, EffortBand } from './effort-bands.ts'
export {
  auxiliaryPurpose,
  isAuxiliaryRequest,
  KNOWN_AUXILIARY_PURPOSES,
  PIN_REGISTRY_KEY,
  pinRegistry,
  type PinRecord,
} from './auxiliary.ts'

export const name = 'adaptive-effort-scheduler'
export const inject = ['llm']

/** Optional per-row `config` overrides; every field falls back to the upstream constant. */
export interface SchedulerConfig extends Partial<BandThresholds> {
  /** Stop scheduling an Agent as soon as its user picks an effort by hand. */
  readonly respectExplicitSelection?: boolean
  /** Publish each pin to the shared registry so auxiliary-call owners can tell a machine pin from a user choice. */
  readonly publishPins?: boolean
  /**
   * Hard ceiling on what this scheduler may write, intersected with what the
   * route declares. Set it to the levels every route in the deployment shares
   * when auxiliary callers (a separately configured summarization model) reuse
   * the session's effective effort: a level only the conversation route supports
   * would then never reach a route that rejects it.
   */
  readonly allowedEfforts?: readonly string[]
  /**
   * Calibration for the token gate: Harness keeps the system prompt and tool
   * schemas outside the session log, so the upstream `estCtxTokens` signal is
   * systematically smaller here. Set this to the typical size of that invisible
   * part (0 keeps the upstream reading exact).
   */
  readonly contextFloorTokens?: number
  /**
   * Where the decision lines go: `debug` (default), `info` (raise it for a
   * calibration run), or `none`.
   */
  readonly logDecisions?: 'none' | 'debug' | 'info'
}

/** Materialized policy for one activation. */
interface ResolvedConfig {
  readonly thresholds: BandThresholds
  readonly respectExplicitSelection: boolean
  readonly publishPins: boolean
  readonly allowedEfforts: readonly string[] | undefined
  readonly contextFloorTokens: number
  /** Where decision lines go. Raise to `info` for a calibration run; `none` silences them. */
  readonly logDecisions: 'none' | 'debug' | 'info'
}

/**
 * Merge the row config over the upstream defaults, reporting ignored values.
 * @param config - the plugin row's `config`, if any.
 * @param warn - sink for malformed-config lines (a typoed key must not fail silently).
 * @returns the policy this activation uses.
 */
function resolveConfig(config: SchedulerConfig | undefined, warn: (message: string) => void): ResolvedConfig {
  const source = config !== null && typeof config === 'object' ? config : {}
  const positive = (value: unknown, fallback: number, label: string): number => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    if (value !== undefined) {
      warn(`adaptive-effort: config ${label} = ${String(value)} is not a finite non-negative number; using ${fallback}`)
    }
    return fallback
  }
  let allowedEfforts: readonly string[] | undefined
  if (Array.isArray(source.allowedEfforts)) {
    allowedEfforts = source.allowedEfforts.filter(id => typeof id === 'string' && id.length > 0)
    if (allowedEfforts.length !== source.allowedEfforts.length) {
      warn('adaptive-effort: config allowedEfforts contains non-string entries; they were dropped')
    }
    if (allowedEfforts.length === 0) {
      warn('adaptive-effort: config allowedEfforts left nothing steerable; every turn stays on the adapter default')
    }
  }
  const logDecisions = source.logDecisions === 'none' || source.logDecisions === 'info'
    ? source.logDecisions
    : 'debug'
  if (source.logDecisions !== undefined && source.logDecisions !== logDecisions) {
    warn(`adaptive-effort: config logDecisions = ${String(source.logDecisions)} is not none|info|debug; using debug`)
  }
  return {
    thresholds: {
      trivialUserChars: positive(source.trivialUserChars, DEFAULT_THRESHOLDS.trivialUserChars, 'trivialUserChars'),
      trivialCtxTokens: positive(source.trivialCtxTokens, DEFAULT_THRESHOLDS.trivialCtxTokens, 'trivialCtxTokens'),
      heavyCtxTokens: positive(source.heavyCtxTokens, DEFAULT_THRESHOLDS.heavyCtxTokens, 'heavyCtxTokens'),
      heavyToolResults: positive(source.heavyToolResults, DEFAULT_THRESHOLDS.heavyToolResults, 'heavyToolResults'),
      heavyUserChars: positive(source.heavyUserChars, DEFAULT_THRESHOLDS.heavyUserChars, 'heavyUserChars'),
    },
    respectExplicitSelection: source.respectExplicitSelection !== false,
    publishPins: source.publishPins !== false,
    allowedEfforts,
    contextFloorTokens: positive(source.contextFloorTokens, 0, 'contextFloorTokens'),
    logDecisions,
  }
}

/** Per-Agent pin state for the turn currently open. */
interface PinSlot {
  /** Turn this slot belongs to. */
  turn: number
  /** Messages claimed for this turn (the prompt is not in the derived history yet). */
  claimed: ShapedMessage[]
  /** Whether the turn's opening claim batch has been closed by its first step. */
  opened: boolean
  /** Effort this turn pinned, or undefined while unresolved. */
  pinned: string | undefined
  /** Sticky: the user took control of the effort, so this Agent is left alone. */
  disabled: boolean
}

/**
 * Mount the scheduler.
 * @param ctx - the plugin context.
 * @param config - the plugin row's `config`, if declared.
 */
/** Sessions whose explicit-effort record survives before the oldest is evicted. */
const EXPLICIT_SESSION_LIMIT = 1024

/**
 * Mount the scheduler.
 * @param ctx - the plugin context.
 * @param config - the plugin row's `config`, if declared.
 */
export function apply(ctx: Context, config?: SchedulerConfig): void {
  const policy = resolveConfig(config, message => ctx.logger.warn(message))
  /** `provider/model` -> effort ids the route advertises. Filled off the decision path. */
  const capabilities = new Map<string, readonly string[]>()
  /** Routes whose probe is still in flight; dedups the three warm-up seams. */
  const probing = new Set<string>()
  /** Routes whose last probe failed; each warns once until a probe succeeds. */
  const probeFailures = new Set<string>()
  /** Agent -> its pin slot. Dropped on `agent/disposed`, so it never outlives an Agent. */
  const slots = new Map<Agent, PinSlot>()
  /**
   * Sessions where the user picked the effort by hand. Keyed by session, not
   * Agent, so the choice also covers Agents created after it (rebuild, resume).
   * Only a selection that arrives after this Session claimed its first prompt in
   * this process counts — see `claimedSessions`.
   */
  const explicitSessions = new Map<string, true>()
  /**
   * Sessions that have claimed a prompt in this process. Before that point a
   * `model/selection` carrying an effort is the Harness writing the Session's
   * initial (created) or restored (resumed) selection, not a hand-over: measured
   * on 20 real sessions, 4 of them carried such a pre-claim effort, and treating
   * it as an explicit choice silenced the scheduler for the whole Session.
   */
  const claimedSessions = new Map<string, true>()
  /** The pre-claim selection first seen per session, to spot a later differing one. */
  const preClaimSelections = new Map<string, string>()
  /** While set, a `model/selection` carrying this effort is our own write's echo. */
  let selfEcho: string | undefined

  const routeKey = (route: ModelSelection): string => `${route.provider}/${route.model}`

  /** One decision line, at the configured level, so a calibration run can grep it. */
  function logDecision(message: string): void {
    if (policy.logDecisions === 'none') return
    if (policy.logDecisions === 'info') ctx.logger.info(message)
    else ctx.logger.debug(message)
  }

  // Fail loudly instead of silently never pinning: an older host without this
  // capability read cannot be steered safely.
  const canReadCapabilities = typeof ctx.llm?.resolveModelInfo === 'function'
  if (!canReadCapabilities) {
    ctx.logger.warn('adaptive-effort: the host exposes no llm.resolveModelInfo; the scheduler stays inactive')
  }

  /** Resolve what one route advertises. Async, deduped, cached; the pin path only reads it. */
  function primeRoute(provider: string, model: string): void {
    if (!canReadCapabilities) return
    const key = `${provider}/${model}`
    if (capabilities.has(key) || probing.has(key)) return
    probing.add(key)
    void ctx.llm.resolveModelInfo(provider, model).then(
      info => {
        probing.delete(key)
        capabilities.set(key, (info.reasoning?.efforts ?? []).map(effort => effort.id))
        probeFailures.delete(key)
      },
      () => {
        probing.delete(key)
        // A persistently failing probe would otherwise surface only as the
        // per-turn "unpinned" debug line; say so once, loudly.
        if (probeFailures.has(key)) return
        probeFailures.add(key)
        ctx.logger.warn(`adaptive-effort: resolveModelInfo(${key}) failed; turns stay unpinned until it succeeds`)
      },
    )
  }

  /** Record a key in a bounded store (insertion order is recency), keeping memory flat. */
  function rememberBounded<V>(store: Map<string, V>, key: string, value: V): void {
    store.delete(key)
    store.set(key, value)
    while (store.size > EXPLICIT_SESSION_LIMIT) {
      const oldest = store.keys().next()
      if (oldest.done === true) break
      store.delete(oldest.value)
    }
  }

  function primeCapabilities(agent: Agent): void {
    const route = agent.model.current()
    if (route === undefined) return
    primeRoute(route.provider, route.model)
  }

  ctx.on('agent/created', ({ agent }) => { primeCapabilities(agent) })
  // Earliest possible warm-up: the prompt lands in the inbox before the driver
  // wakes, so the lookup usually settles before the claim that needs it.
  ctx.on('agent/inbox/inserted', ({ agent }) => { primeCapabilities(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    slots.delete(agent)
    // Only the last live Agent of a session takes the published pin with it;
    // a sibling sharing the session (e.g. a subagent) would otherwise lose
    // the record its own last pin overwrote. Agents that never claimed keep
    // no slot and therefore no pin of their own, so they are not consulted.
    const sessionId = String(agent.session.id)
    for (const other of slots.keys()) {
      if (String(other.session.id) === sessionId) return
    }
    pinRegistry().delete(sessionId)
  })

  // A profile edit changes what a route advertises; drop the cache and re-read
  // the live Agents so a ceiling never outlives the profile it was read from.
  ctx.on('llm/models-updated', () => {
    capabilities.clear()
    for (const agent of slots.keys()) primeCapabilities(agent)
  })
  ctx.on('llm/adapters-updated', () => {
    capabilities.clear()
    for (const agent of slots.keys()) primeCapabilities(agent)
  })

  // The pin point. See the module header for why this seam and not `agent/request`
  // or `agent/pre-step`.
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (!canReadCapabilities) return
    // From the first claim on, this Session is live in this process: an effort
    // bearing `model/selection` arriving later is a human act, not the Harness
    // writing the Session's own initial/restored selection.
    rememberBounded(claimedSessions, String(agent.session.id), true)
    // A session where the user took over the effort is left alone for good,
    // whatever Agent currently drives it.
    if (explicitSessions.has(String(agent.session.id))) return
    const slot = slots.get(agent) ?? { turn, claimed: [], opened: false, pinned: undefined, disabled: false }
    if (slot.turn !== turn) {
      // New turn: fresh signals. `disabled` is deliberately sticky.
      slot.turn = turn
      slot.claimed = []
      slot.opened = false
      slot.pinned = undefined
    }
    slots.set(agent, slot)
    // A claim inside an already-open turn (steering, injected input, a scheduled
    // delivery): the pin holds. Re-resolving here would change the reasoning
    // config between requests of one turn and pay a cold prompt-cache prefix write.
    if (slot.opened || slot.disabled) return
    // The opening batch re-resolves on every claim, deliberately. `inbox.claim`
    // emits the queued next-step leftovers BEFORE the turn's own prompt, so the
    // first claim can be an injection rather than the ask; the turn message is
    // always the batch's last claim, and the last resolution therefore decides.
    // Re-resolving is cheap: an equal recorded choice is a host-side no-op, so
    // only a real mid-batch band change costs an extra selection write.
    slot.claimed.push(message as ShapedMessage)

    const route = agent.model.current()
    if (route === undefined) return
    const declared = capabilities.get(routeKey(route))
    if (declared === undefined) {
      // Route capabilities are only readable asynchronously, so a brand-new
      // Agent whose first prompt lands within the lookup's latency runs this
      // turn on the adapter default. Logged so a calibration run can count it.
      logDecision(`adaptive-effort: turn ${turn} unpinned, capabilities of ${routeKey(route)} not resolved yet`)
      primeCapabilities(agent)
      return
    }
    // Route capability first, then the configured ceiling: never write an id the
    // route rejects, and never write one another route would reject when an
    // auxiliary caller mirrors this session's effort.
    const allowed = policy.allowedEfforts === undefined
      ? declared
      : declared.filter(id => policy.allowedEfforts?.includes(id) === true)
    if (allowed.length === 0) return // nothing steerable left: leave the adapter default alone

    // Derived history (previous turns, including their tool traffic) plus this
    // turn's claimed prompt. Mid-loop tool results and the appended runtime
    // context are deliberately absent: that is the pin.
    const messages: readonly ShapedMessage[] = [...agent.session.deriveMessages(), ...slot.claimed]
    const band = resolveBand(messages, policy.thresholds, { tokens: policy.contextFloorTokens })
    const effort = clampBand(band, allowed)
    if (effort === undefined) return
    slot.pinned = effort
    // Publish for other plugins: an auxiliary-call owner (fold summary, session
    // title, auto-review) can look this session up and tell that the effective
    // effort is a machine pin for the conversation, not a user choice, before it
    // mirrors that value into its own request.
    if (policy.publishPins) {
      publishPin(pinRegistry(), String(agent.session.id), {
        provider: route.provider,
        model: route.model,
        effort,
        band,
        turn,
        pinnedAt: Date.now(),
      })
    }
    // What matters is the selection this turn's next request will use. Skipping
    // is only safe when that selection already carries the target, or when it is
    // unset and the last request's value (the adapter default) already matches —
    // and only on the SAME route: after a model-only change the pending route's
    // default is unknown, so a matching effort on the old route must not skip.
    if (route.reasoningEffort === effort) return
    const header = agent.session.requestHeader()?.config
    if (route.reasoningEffort === undefined
      && header?.provider === route.provider
      && header?.model === route.model
      && header?.reasoningEffort === effort) return
    // An effort-only selection appends no model-switch notice — the loop adds one
    // only when provider or model changes — so history and its cache prefix hold.
    selfEcho = effort
    try {
      agent.model.select({
        provider: route.provider,
        model: route.model,
        reasoningEffort: effort as NonNullable<ModelSelection['reasoningEffort']>,
      })
    } finally {
      selfEcho = undefined
    }
    logDecision(
      `adaptive-effort: turn ${turn} pinned ${effort} (band ${band}, ${messages.length} messages, route ${routeKey(route)})`,
    )
  })

  // Once the first step of the turn is proposed, the opening claim batch is
  // closed: every later claim in this turn keeps the pinned effort.
  ctx.on('agent/pre-step', ({ agent, turn }, next): Promise<PreStepDecision> => {
    const slot = slots.get(agent)
    if (slot !== undefined && slot.turn === turn) slot.opened = true
    return next()
  })

  // Two log-only Session events carry route information worth acting on:
  //  - `request/header` (appended inside the step, before dispatch) reveals the
  //    exact route the loop is about to use, including a route another plugin
  //    chose, and on a resumed Session it is available long before the first
  //    claim — that is what lets a restored session pin on its first turn.
  //  - `model/selection` written by a human outranks the scheduler — recorded
  //    per session, so it holds for Agents built later over the same session.
  //    A selection that arrives before the Session's first claim in this process
  //    is the Harness's own initial/restored value and does not count.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'request/header') {
      const config = event.data?.header?.config
      if (typeof config?.provider === 'string' && typeof config.model === 'string') {
        primeRoute(config.provider, config.model)
      }
      return
    }
    if (event.type !== 'model/selection' || !policy.respectExplicitSelection) return
    const raw = event.data?.reasoningEffort
    // Only a real effort id counts as a human choice; anything else (absent,
    // empty, malformed) is a model-only change or noise.
    const chosen = typeof raw === 'string' && raw.length > 0 ? raw : undefined
    if (chosen === undefined) {
      // Model-only change: the effort stays schedulable, the new route does not.
      for (const [agent, slot] of slots) {
        if (agent.session !== session || slot.disabled) continue
        primeCapabilities(agent)
      }
      return
    }
    // The scheduler's own writes can echo back through this event: skip while
    // the write is in flight, and treat a selection equal to a live pin as an
    // echo too (the fallback for hosts that dispatch the event asynchronously).
    // One caveat, deliberate: a user who happens to pick the currently pinned
    // effort is indistinguishable from that echo and is not recorded.
    if (selfEcho === chosen) return
    for (const [agent, slot] of slots) {
      if (agent.session === session && slot.pinned === chosen) return
    }
    const sessionId = String(session.id)
    const provider = typeof event.data?.provider === 'string' ? event.data.provider : undefined
    const model = typeof event.data?.model === 'string' ? event.data.model : undefined
    if (provider !== undefined && model !== undefined) primeRoute(provider, model)
    if (!claimedSessions.has(sessionId)) {
      // Before this Session claims anything in this process, an effort-bearing
      // selection is the Harness writing its initial (created) or restored
      // (resumed) selection. Treat that — and a repeat of it — as inherited; only
      // a *different* pre-claim selection means a human reached for the control.
      const seen = `${provider ?? '?'}/${model ?? '?'}=${chosen}`
      const baseline = preClaimSelections.get(sessionId)
      if (baseline === undefined || baseline === seen) {
        rememberBounded(preClaimSelections, sessionId, seen)
        logDecision(`adaptive-effort: "${chosen}" on session ${sessionId} predates its first claim; kept as the Session's own selection, not a hand-over`)
        return
      }
    }
    // A selection identical to what the Agent already carries is a re-assertion
    // (a resume or an options replay re-applying the Session's stored choice) —
    // the observed seams put those right at turn boundaries, after a claim. A
    // hand-over changes the value, so only a change counts; honoring an
    // unchanged one would silence the Session on every resume.
    for (const agent of slots.keys()) {
      if (agent.session !== session) continue
      const now = agent.model.current()
      if (now === undefined) continue
      if ((provider ?? now.provider) !== now.provider) continue
      if ((model ?? now.model) !== now.model) continue
      if ((now.reasoningEffort ?? undefined) === chosen) return
    }
    rememberBounded(explicitSessions, sessionId, true)
    for (const [agent, slot] of slots) {
      if (agent.session !== session || slot.disabled) continue
      slot.disabled = true
      const published = policy.publishPins ? pinRegistry().get(sessionId) : undefined
      if (published !== undefined && published.effort === slot.pinned) published.overridden = true
    }
    logDecision(`adaptive-effort: explicit effort "${chosen}" wins; scheduler idle for session ${sessionId}`)
  })
}
