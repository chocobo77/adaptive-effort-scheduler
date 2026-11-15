/**
 * Auxiliary-request criterion and the public pin registry.
 *
 * Why this module exists: the scheduler pins the effort of the CONVERSATION
 * route, by changing one Agent's model selection. Auxiliary calls (session
 * title, fold summary, auto-review) never pass through that seam, so they are
 * never scheduled. But sibling plugins commonly mirror the session's effective
 * effort into their own auxiliary calls — they read
 * `session.requestHeader()?.config.reasoningEffort`, which is exactly the value
 * this scheduler pinned. That is where the pin can leak, and it is a policy
 * choice, not a bug. This module gives both sides the vocabulary to decide it:
 * a criterion for "auxiliary", and a registry that says "this effort was
 * machine-pinned for the conversation, not chosen by the user".
 *
 * Criterion (from the Harness types, not a guess): `GenerateOptions.purpose` is
 * an open registry — `LlmRequestPurposeMap` is declared by each producer package
 * and ordinary conversation requests leave it absent. So `purpose` present means
 * the request is auxiliary by construction. The orthogonal identity test the core
 * exposes is `isAgentLoopRequest()` (a process-local mark on the loop-assembled
 * envelope); this module stays dependency-free and does not duplicate it.
 *
 * @module adaptive-effort-scheduler/auxiliary
 */

/** Purposes declared by producer packages shipped with the Harness. */
export const KNOWN_AUXILIARY_PURPOSES: readonly string[] = Object.freeze([
  'compaction', // packages/compaction/compaction-basic/src/types.ts
  'session-title', // packages/session/session-title-llm/src/index.ts
  'auto-review', // packages/experimental/auto-review/src/index.ts
])

/** The minimal shape of an outgoing model request this module inspects. */
export interface PurposeBearingRequest {
  readonly purpose?: unknown
  readonly provider?: unknown
  readonly model?: unknown
}

/**
 * Whether one outgoing request is auxiliary rather than conversation traffic.
 * @param request - the request envelope (may be undefined).
 * @returns true when the producer tagged a purpose.
 */
export function isAuxiliaryRequest(request: PurposeBearingRequest | undefined): boolean {
  return typeof request?.purpose === 'string' && request.purpose.length > 0
}

/**
 * The purpose tag, when present.
 * @param request - the request envelope.
 * @returns the declared purpose, or undefined for conversation traffic.
 */
export function auxiliaryPurpose(request: PurposeBearingRequest | undefined): string | undefined {
  return typeof request?.purpose === 'string' && request.purpose.length > 0 ? request.purpose : undefined
}

/** Registry key on `globalThis`; any same-process plugin can read the pins. */
export const PIN_REGISTRY_KEY: symbol = Symbol.for('@local/adaptive-effort-scheduler.pins')

/** One pinned turn, visible to other plugins. */
export interface PinRecord {
  /** Route the pin applies to. */
  readonly provider: string
  readonly model: string
  /** Pinned effort id as the route advertises it. */
  readonly effort: string
  /** Band the thresholds resolved before the route clamp. */
  readonly band: string
  /** Turn this pin belongs to. */
  readonly turn: number
  /** Wall-clock milliseconds of the pin, for staleness checks. */
  readonly pinnedAt: number
  /**
   * True when a hand-picked effort replaced this pin mid-turn, so the pin no
   * longer describes what the Session is running. The scheduler is still active:
   * it re-pins at the next turn boundary.
   */
  overridden?: true
}

/**
 * The process-wide pin registry, created on first use.
 * @returns a `sessionId -> PinRecord` map shared across plugins.
 */
export function pinRegistry(): Map<string, PinRecord> {
  const container = globalThis as Record<PropertyKey, unknown>
  const existing = container[PIN_REGISTRY_KEY]
  if (existing instanceof Map) return existing as Map<string, PinRecord>
  const registry = new Map<string, PinRecord>()
  container[PIN_REGISTRY_KEY] = registry
  return registry
}

/** Sessions whose pin stays readable before the oldest is evicted. */
export const PIN_REGISTRY_LIMIT = 256

/**
 * Record one pin, keeping the registry bounded. Insertion order is recency, so
 * the oldest entry goes when the limit is passed; re-pinning a session keeps its
 * place.
 * @param registry - the shared registry.
 * @param sessionId - the session the pin belongs to.
 * @param record - the pin to publish.
 */
export function publishPin(registry: Map<string, PinRecord>, sessionId: string, record: PinRecord): void {
  registry.delete(sessionId)
  registry.set(sessionId, record)
  while (registry.size > PIN_REGISTRY_LIMIT) {
    const oldest = registry.keys().next()
    if (oldest.done === true) break
    registry.delete(oldest.value)
  }
}
