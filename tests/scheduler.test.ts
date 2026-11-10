/**
 * Wiring test: a fake Context and Agent exercise the per-turn pin end to end —
 * the choice must be written before the loop captures the step selection, hold
 * fixed for every step of that turn, and yield to an explicit user selection.
 */
import { describe, expect, it } from 'vitest'

import { apply } from '../src/index.ts'

type Selection = { provider: string; model: string; reasoningEffort?: string }
type Msg = { role: string; content: unknown }

interface FakeAgent {
  readonly session: {
    id: string
    deriveMessages: () => Msg[]
    requestHeader: () => { config: Selection } | undefined
  }
  readonly model: {
    current: () => Selection | undefined
    select: (selection: Selection) => void
  }
}

interface FakeContext {
  readonly llm: { resolveModelInfo: (provider: string, model: string) => Promise<unknown> }
  readonly logger: {
    debug: (message: string) => void
    info: (message: string) => void
    warn: (message: string) => void
  }
  on: (event: string, handler: (...args: unknown[]) => unknown) => void
  fire: (event: string, ...args: unknown[]) => void
}

function createHarness(declaredEfforts: string[], initial: Selection = { provider: 'strata', model: 'qwen3.8-flash-next' }) {
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const logs = { debug: [] as string[], info: [] as string[], warn: [] as string[] }
  const ctx: FakeContext = {
    llm: { resolveModelInfo: async () => ({ reasoning: { efforts: declaredEfforts.map(id => ({ id, name: id })) } }) },
    logger: {
      debug: (message: string) => { logs.debug.push(message) },
      info: (message: string) => { logs.info.push(message) },
      warn: (message: string) => { logs.warn.push(message) },
    },
    on: (event, handler) => { listeners.set(event, [...(listeners.get(event) ?? []), handler]) },
    fire: (event, ...args) => { for (const handler of listeners.get(event) ?? []) handler(...args) },
  }

  let history: Msg[] = []
  let current: Selection | undefined = initial
  let header: { config: Selection } | undefined
  const written: string[] = []
  const agent: FakeAgent = {
    session: { id: 's1', deriveMessages: () => history, requestHeader: () => header },
    model: {
      current: () => current,
      select: (selection) => { written.push(selection.reasoningEffort ?? 'default'); current = selection },
    },
  }
  return {
    ctx,
    agent,
    written,
    setHistory: (messages: Msg[]) => { history = messages },
    setHeader: (selection: Selection) => { header = { config: selection } },
    setCurrent: (selection: Selection | undefined) => { current = selection },
    logs,
    // A macrotask boundary: every pending microtask (the async capability
    // probe chain) drains before the next statement runs.
    settle: () => new Promise(resolve => setImmediate(resolve)),
  }
}

const cast = (harness: ReturnType<typeof createHarness>) =>
  ({ ctx: harness.ctx as never, agent: harness.agent as never })

describe('per-turn pin', () => {
  it('pins the opening turn, holds it mid-turn, and only then re-resolves', async () => {
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    harness.setHistory([])
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle() // the async capability probe

    // Turn 1: short prompt, no tool history -> low.
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi, what is 2+2?' },
    })
    expect(harness.written).toEqual(['low'])

    // The step is proposed: the opening claim batch closes.
    cast(harness).ctx.fire('agent/pre-step', {
      agent: cast(harness).agent, turn: 1, step: 1, messages: [], signal: undefined,
    }, () => Promise.resolve({ kind: 'enter', messages: [] }))

    // Mid-turn: a huge tool result plus a steering claim must not move the pin.
    harness.setHistory([
      { role: 'user', content: 'hi, what is 2+2?' },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'grep', arguments: '{}' }] },
      { role: 'tool', content: 'z'.repeat(200000) },
    ])
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'also check the other file' },
    })
    expect(harness.written).toEqual(['low'])

    // Turn 2: that traffic now sits BEFORE the new user message -> medium.
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 2, message: { role: 'user', content: 'now summarise it' },
    })
    expect(harness.written).toEqual(['low', 'medium'])
  })

  it('lets the last claim of an opening batch decide the pin', async () => {
    // `inbox.claim` emits queued next-step leftovers before the turn's own
    // prompt, so the batch's last claim is the ask — it must win, even when
    // an earlier claim already pinned a different band.
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    // First claim: a small injected prompt pins `low`.
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi, what is 2+2?' },
    })
    expect(harness.written).toEqual(['low'])
    // Second claim: the real, heavy ask re-resolves and moves the pin.
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'x'.repeat(5000) },
    })
    expect(harness.written).toEqual(['low', 'high'])

    // A mid-turn claim after the first pre-step still holds the pin.
    cast(harness).ctx.fire('agent/pre-step', {
      agent: cast(harness).agent, turn: 1, step: 1, messages: [], signal: undefined,
    }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'also this' },
    })
    expect(harness.written).toEqual(['low', 'high'])

    // The next turn re-resolves normally: six tool round trips now sit BEFORE
    // the new ask, so the heavy tool gate fires — but the route already carries
    // `high`, so the skip-write check saves the selection write.
    harness.setHistory([
      ...msgMany(6),
      { role: 'user', content: 'x'.repeat(5000) },
    ])
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 2, message: { role: 'user', content: 'and now?' },
    })
    expect(harness.written).toEqual(['low', 'high'])
  })

  it('writes nothing when the adapter default already carries the pinned effort', async () => {
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    harness.setHeader({ provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'low' })
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi' },
    })
    expect(harness.written).toEqual([])
  })

  it('writes the pin when a pending selection differs, even if history carried it', async () => {
    // The last request ran at `low`, but another plugin (or a resume) left a
    // pending `high`. Skipping because the header matched would lose the pin.
    const harness = createHarness(['low', 'medium', 'high'], {
      provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'high',
    })
    apply(cast(harness).ctx)
    harness.setHeader({ provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'low' })
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi' },
    })
    expect(harness.written).toEqual(['low'])
  })

  it('does not skip the write when the header effort matched on a different route', async () => {
    // A model-only change left the pending route effort-less while the logged
    // header still carries the old route with the same effort — the new
    // route's default is unknown, so the pin must be written regardless.
    const harness = createHarness(['low', 'medium', 'high'], {
      provider: 'strata', model: 'qwen3.8-flash-next',
    })
    apply(cast(harness).ctx)
    harness.setHeader({ provider: 'strata', model: 'qwen3.8-flash-mini', reasoningEffort: 'low' })
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi' },
    })
    expect(harness.written).toEqual(['low'])
  })

  it('treats a malformed selection effort as a model-only change, not a takeover', async () => {
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(harness.written).toEqual(['low'])
    for (const malformed of ['', 7, null]) {
      cast(harness).ctx.fire('session/event', harness.agent.session, {
        type: 'model/selection',
        data: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: malformed },
      })
    }
    // Scheduling must survive all three: the next turn re-resolves normally.
    harness.setHistory(msgMany(12))
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 2, message: { role: 'user', content: 'and now?' },
    })
    expect(harness.written).toEqual(['low', 'high'])
  })

  it('re-reads route capabilities when the host reports a model update', async () => {
    const declared = ['low', 'medium', 'high']
    const harness = createHarness(declared)
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    harness.setHistory(msgMany(12))
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'first' },
    })
    expect(harness.written).toEqual(['high'])

    // The profile narrows what the route accepts; the cached set must not survive it.
    declared.length = 0
    declared.push('low')
    cast(harness).ctx.fire('llm/models-updated', 'strata')
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 2, message: { role: 'user', content: 'second' },
    })
    expect(harness.written).toEqual(['high', 'low'])
  })

  it('calibrates the token gate for the prompt parts the session log omits', async () => {
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx, { contextFloorTokens: 60000 })
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'short ask' },
    })
    // `toolResults == 0` and a short ask keep it out of `low`; the calibrated
    // floor puts the window over the heavy gate.
    expect(harness.written).toEqual(['high'])
  })

  it('yields permanently to an explicit user effort', async () => {
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(harness.written).toEqual(['low'])

    // The user picks `high` in the UI: a model/selection the scheduler did not write.
    harness.setHeader({ provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'high' })
    cast(harness).ctx.fire('session/event', harness.agent.session, {
      type: 'model/selection',
      data: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'high' },
    })
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 2, message: { role: 'user', content: 'now a big refactor of the parser, with tests, benchmarks and a migration plan' },
    })
    expect(harness.written).toEqual(['low'])
  })

  it('keeps scheduling when a resume re-asserts the current selection', async () => {
    // Resumes re-apply the Session's stored selection after the first claim, at a
    // turn boundary. Identical value means nothing was chosen by hand, so the
    // scheduler must keep working rather than fall silent for the whole Session.
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(harness.written).toEqual(['low'])

    harness.setHeader({ provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'medium' })
    harness.setCurrent({ provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'medium' })
    cast(harness).ctx.fire('session/event', harness.agent.session, {
      type: 'model/selection',
      data: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'medium' },
    })
    harness.setHistory(msgMany(12))
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 2, message: { role: 'user', content: 'and now?' },
    })
    expect(harness.written).toEqual(['low', 'high'])
  })

  it('keeps scheduling when the pre-claim selection is the Sessions own value', async () => {
    // The Harness writes the Session's initial (created) or restored (resumed)
    // selection before anyone prompts. Measured on real sessions, treating that
    // write as a hand-over silenced the scheduler for the whole Session.
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('session/event', harness.agent.session, {
      type: 'model/selection',
      data: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'high' },
    })
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    // A repeat of the same selection (a resume re-applying it) stays inherited.
    cast(harness).ctx.fire('session/event', harness.agent.session, {
      type: 'model/selection',
      data: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'high' },
    })
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(harness.written).toEqual(['low'])
  })

  it('yields when a different selection arrives before the first claim', async () => {
    // No claim yet, but a second, different selection is a hand reaching for the
    // control rather than the Harness restoring its own value.
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('session/event', harness.agent.session, {
      type: 'model/selection',
      data: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'high' },
    })
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('session/event', harness.agent.session, {
      type: 'model/selection',
      data: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'medium' },
    })
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(harness.written).toEqual([])
  })

  it('keeps a session-level explicit choice after the Agent is rebuilt', async () => {
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(harness.written).toEqual(['low'])

    harness.setHeader({ provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'high' })
    cast(harness).ctx.fire('session/event', harness.agent.session, {
      type: 'model/selection',
      data: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'high' },
    })
    cast(harness).ctx.fire('agent/disposed', { agent: cast(harness).agent })

    // A new Agent over the same session (rebuild, resume) must not reschedule.
    const rebuiltWrites: string[] = []
    const rebuilt = {
      session: harness.agent.session,
      model: {
        current: () => ({ provider: 'strata', model: 'qwen3.8-flash-next' }) as Selection | undefined,
        select: (selection: Selection) => { rebuiltWrites.push(selection.reasoningEffort ?? 'default') },
      },
    }
    harness.setHistory([])
    cast(harness).ctx.fire('agent/created', { agent: rebuilt as never })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: rebuilt as never, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(rebuiltWrites).toEqual([])
  })

  it('treats a selection equal to the live pin as its own echo, not a takeover', async () => {
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(harness.written).toEqual(['low'])

    // The write echoes back with the effort the scheduler itself pinned.
    cast(harness).ctx.fire('session/event', harness.agent.session, {
      type: 'model/selection',
      data: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'low' },
    })
    // Scheduling must continue on the next turn.
    harness.setHistory(msgMany(12))
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 2, message: { role: 'user', content: 'and now?' },
    })
    expect(harness.written).toEqual(['low', 'high'])
  })

  it('warns once when the capability probe keeps failing', async () => {
    const harness = createHarness(['low', 'medium', 'high'])
    harness.ctx.llm.resolveModelInfo = async () => { throw new Error('route down') }
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 2, message: { role: 'user', content: 'hi there again' },
    })
    expect(harness.logs.warn.filter(message => message.includes('resolveModelInfo'))).toHaveLength(1)
  })

  it('warns about malformed config values instead of failing silently', () => {
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx, {
      heavyUserChars: -1,
      allowedEfforts: ['low', 7] as unknown as string[],
      logDecisions: 'louder' as never,
    })
    const warnings = harness.logs.warn.join('\n')
    expect(warnings).toMatch(/heavyUserChars = -1/)
    expect(warnings).toMatch(/allowedEfforts contains non-string entries/)
    expect(warnings).toMatch(/logDecisions = louder/)

    const empty = createHarness(['low', 'medium', 'high'])
    apply(cast(empty).ctx, { allowedEfforts: [] })
    expect(empty.logs.warn.join('\n')).toMatch(/allowedEfforts left nothing steerable/)
    // And it stays inert: nothing may be written.
    cast(empty).ctx.fire('agent/inbox/claimed', {
      agent: cast(empty).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(empty.written).toEqual([])
  })

  it('clamps to the levels a local route actually declares', async () => {
    const harness = createHarness(['off', 'minimal', 'low'])
    apply(cast(harness).ctx)
    harness.setHistory([
      msgMany(12),
      { role: 'user', content: 'and now?' },
    ])
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'x'.repeat(5000) },
    })
    // Band would be high (5000 user chars); the route tops out at `low`.
    expect(harness.written).toEqual(['low'])
  })

  it('takes no action for a route that advertises no reasoning control', async () => {
    const harness = createHarness([])
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi' },
    })
    expect(harness.written).toEqual([])
  })

  it('pins the first turn when the prompt arrival warmed the probe', async () => {
    // No `agent/created` here: the earliest warm-up is the prompt landing in the
    // inbox, which happens before the driver wakes to claim it.
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/inbox/inserted', {
      agent: cast(harness).agent, message: { role: 'user', content: 'hi there' },
    })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(harness.written).toEqual(['low'])
  })

  it('probes one route once no matter how many warm-up seams fire', async () => {
    // created + inserted + request/header all fire within the probe's latency;
    // the in-flight dedup must collapse them to a single resolveModelInfo call.
    const harness = createHarness(['low', 'medium', 'high'])
    let probes = 0
    const inner = harness.ctx.llm.resolveModelInfo
    // A plain wrapper (no async/await) so the probe promise keeps its shape.
    harness.ctx.llm.resolveModelInfo = (provider: string, model: string) => {
      probes += 1
      return inner(provider, model)
    }
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    cast(harness).ctx.fire('agent/inbox/inserted', { agent: cast(harness).agent, message: { role: 'user', content: 'hi there' } })
    cast(harness).ctx.fire('session/event', harness.agent.session, {
      type: 'request/header',
      data: { header: { config: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'medium' } }, reason: 'route' },
    })
    await harness.settle()
    expect(probes).toBe(1)
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(harness.written).toEqual(['low'])
  })

  it('survives a request/header event with a missing payload', async () => {
    const harness = createHarness(['low', 'medium', 'high'])
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    expect(() => {
      cast(harness).ctx.fire('session/event', harness.agent.session, { type: 'request/header' })
      cast(harness).ctx.fire('session/event', harness.agent.session, { type: 'request/header', data: {} })
    }).not.toThrow()
    // The scheduler is unaffected: the next turn still pins.
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(harness.written).toEqual(['low'])
  })

  it('pins the first turn of a resumed session from its logged request header', async () => {
    // A resumed Agent has no live selection yet; the Session's own header names
    // the route, so the probe can start before the first claim.
    const harness = createHarness(['low', 'medium', 'high'])
    harness.setCurrent(undefined)
    apply(cast(harness).ctx)
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    // Nothing could be probed without a selection, so turn 1 would be unpinned…
    cast(harness).ctx.fire('session/event', harness.agent.session, {
      type: 'request/header',
      data: {
        header: { config: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'medium' } },
        reason: 'route',
      },
    })
    await harness.settle()
    harness.setCurrent({ provider: 'strata', model: 'qwen3.8-flash-next' })
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(harness.written).toEqual(['low'])
  })

  it('keeps decision lines on debug by default and moves them on request', async () => {
    const quiet = createHarness(['low', 'medium', 'high'])
    apply(cast(quiet).ctx, { logDecisions: 'none' })
    cast(quiet).ctx.fire('agent/inbox/inserted', { agent: cast(quiet).agent, message: { role: 'user', content: 'hi there' } })
    await quiet.settle()
    cast(quiet).ctx.fire('agent/inbox/claimed', { agent: cast(quiet).agent, turn: 1, message: { role: 'user', content: 'hi there' } })
    expect(quiet.written).toEqual(['low'])
    expect(quiet.logs.debug.join(' ') + quiet.logs.info.join(' ')).not.toMatch(/pinned/)

    const loud = createHarness(['low', 'medium', 'high'])
    apply(cast(loud).ctx, { logDecisions: 'info' })
    cast(loud).ctx.fire('agent/inbox/inserted', { agent: cast(loud).agent, message: { role: 'user', content: 'hi there' } })
    await loud.settle()
    cast(loud).ctx.fire('agent/inbox/claimed', { agent: cast(loud).agent, turn: 1, message: { role: 'user', content: 'hi there' } })
    expect(loud.logs.info.join(' ')).toMatch(/turn 1 pinned low \(band low/)
    expect(loud.logs.debug).toEqual([])

    const plain = createHarness(['low', 'medium', 'high'])
    apply(cast(plain).ctx)
    cast(plain).ctx.fire('agent/inbox/inserted', { agent: cast(plain).agent, message: { role: 'user', content: 'hi there' } })
    await plain.settle()
    cast(plain).ctx.fire('agent/inbox/claimed', { agent: cast(plain).agent, turn: 1, message: { role: 'user', content: 'hi there' } })
    expect(plain.logs.debug.join(' ')).toMatch(/turn 1 pinned low/)
  })

  it('honours a configured ceiling shared by every route in the deployment', async () => {
    // The route could think to `xhigh`; the deployment only wants levels that
    // every route — including a separately configured summarization model — takes.
    const harness = createHarness(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    apply(cast(harness).ctx, { allowedEfforts: ['low', 'medium'] })
    harness.setHistory(msgMany(12))
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'x'.repeat(5000) },
    })
    // Band is high (12 tool results, 5000 characters); the ceiling caps it at `medium`.
    expect(harness.written).toEqual(['medium'])
  })

  it('writes nothing when the ceiling shares no level with the route', async () => {
    const harness = createHarness(['off', 'minimal'])
    apply(cast(harness).ctx, { allowedEfforts: ['medium', 'high'] })
    cast(harness).ctx.fire('agent/created', { agent: cast(harness).agent })
    await harness.settle()
    cast(harness).ctx.fire('agent/inbox/claimed', {
      agent: cast(harness).agent, turn: 1, message: { role: 'user', content: 'x'.repeat(5000) },
    })
    expect(harness.written).toEqual([])
  })
})

/** Six assistant/tool round trips, enough to pass the heavy tool-result count. */
function msgMany(rounds: number): Msg[] {
  return Array.from({ length: rounds }, () => [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }] },
    { role: 'tool', content: 'o'.repeat(200) },
  ]).flat()
}
