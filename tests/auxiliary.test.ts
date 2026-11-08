/**
 * Auxiliary-request criterion, and the pin registry other plugins read before
 * mirroring a session's effective effort into their own auxiliary calls.
 */
import { describe, expect, it } from 'vitest'

import { apply } from '../src/index.ts'
import { auxiliaryPurpose, isAuxiliaryRequest, KNOWN_AUXILIARY_PURPOSES, PIN_REGISTRY_LIMIT, pinRegistry, publishPin } from '../src/auxiliary.ts'

describe('auxiliary criterion', () => {
  it('treats a tagged purpose as auxiliary, whatever the tag', () => {
    for (const purpose of [...KNOWN_AUXILIARY_PURPOSES, 'custom-producer']) {
      expect(isAuxiliaryRequest({ purpose })).toBe(true)
      expect(auxiliaryPurpose({ purpose })).toBe(purpose)
    }
  })

  it('treats an absent or empty purpose as ordinary conversation traffic', () => {
    for (const request of [undefined, {}, { purpose: '' }, { purpose: undefined, provider: 'p', model: 'm' }]) {
      expect(isAuxiliaryRequest(request)).toBe(false)
      expect(auxiliaryPurpose(request)).toBeUndefined()
    }
  })
})

describe('pin registry', () => {
  function harness(sessionId: string) {
    const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>()
    const ctx = {
      llm: { resolveModelInfo: async () => ({ reasoning: { efforts: ['low', 'medium', 'high'].map(id => ({ id, name: id })) } }) },
      logger: { debug: () => undefined, warn: () => undefined },
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        listeners.set(event, [...(listeners.get(event) ?? []), handler])
      },
      fire: (event: string, ...args: unknown[]) => {
        for (const handler of listeners.get(event) ?? []) handler(...args)
      },
    }
    const written: string[] = []
    const session = {
      id: sessionId,
      deriveMessages: () => [],
      requestHeader: () => undefined,
    }
    const agent = {
      session,
      model: {
        current: () => ({ provider: 'strata', model: 'qwen3.8-flash-next' }),
        select: (selection: { reasoningEffort?: string }) => { written.push(selection.reasoningEffort ?? 'default') },
      },
    }
    return { ctx, agent, written }
  }

  it('publishes the pinned effort for the session', async () => {
    const h = harness('session-publish')
    apply(h.ctx as never)
    h.ctx.fire('agent/created', { agent: h.agent as never })
    await new Promise(resolve => setImmediate(resolve))
    h.ctx.fire('agent/inbox/claimed', {
      agent: h.agent as never, turn: 1, message: { role: 'user', content: 'hi, what is 2+2?' },
    })
    expect(h.written).toEqual(['low'])
    expect(pinRegistry().get('session-publish')).toMatchObject({ effort: 'low', band: 'low', turn: 1 })
  })

  it('marks the record overridden when a human takes over', async () => {
    const h = harness('session-overridden')
    apply(h.ctx as never)
    h.ctx.fire('agent/created', { agent: h.agent as never })
    await new Promise(resolve => setImmediate(resolve))
    h.ctx.fire('agent/inbox/claimed', {
      agent: h.agent as never, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    h.ctx.fire('session/event', h.agent.session, {
      type: 'model/selection',
      data: { provider: 'strata', model: 'qwen3.8-flash-next', reasoningEffort: 'high' },
    })
    expect(pinRegistry().get('session-overridden')?.overridden).toBe(true)
  })

  it('stays silent when publishing is turned off', async () => {
    const h = harness('session-quiet')
    apply(h.ctx as never, { publishPins: false })
    h.ctx.fire('agent/created', { agent: h.agent as never })
    await new Promise(resolve => setImmediate(resolve))
    h.ctx.fire('agent/inbox/claimed', {
      agent: h.agent as never, turn: 1, message: { role: 'user', content: 'hi' },
    })
    expect(h.written).toEqual(['low'])
    expect(pinRegistry().has('session-quiet')).toBe(false)
  })

  it('drops the record when the Agent is disposed', async () => {
    const h = harness('session-disposed')
    apply(h.ctx as never)
    h.ctx.fire('agent/created', { agent: h.agent as never })
    await new Promise(resolve => setImmediate(resolve))
    h.ctx.fire('agent/inbox/claimed', {
      agent: h.agent as never, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(pinRegistry().has('session-disposed')).toBe(true)
    h.ctx.fire('agent/disposed', { agent: h.agent as never })
    expect(pinRegistry().has('session-disposed')).toBe(false)
  })

  it('keeps the record while a sibling Agent shares the session', async () => {
    // Two Agents pin the same session id (e.g. a subagent); disposing one must
    // not take the survivor's record away.
    const h = harness('session-shared')
    apply(h.ctx as never)
    const sibling = {
      session: { id: 'session-shared', deriveMessages: () => [], requestHeader: () => undefined },
      model: {
        current: () => ({ provider: 'strata', model: 'qwen3.8-flash-next' }),
        select: () => undefined,
      },
    }
    h.ctx.fire('agent/created', { agent: h.agent as never })
    h.ctx.fire('agent/created', { agent: sibling as never })
    await new Promise(resolve => setImmediate(resolve))
    h.ctx.fire('agent/inbox/claimed', {
      agent: h.agent as never, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    h.ctx.fire('agent/inbox/claimed', {
      agent: sibling as never, turn: 1, message: { role: 'user', content: 'hi there' },
    })
    expect(pinRegistry().has('session-shared')).toBe(true)
    h.ctx.fire('agent/disposed', { agent: h.agent as never })
    expect(pinRegistry().has('session-shared')).toBe(true)
    h.ctx.fire('agent/disposed', { agent: sibling as never })
    expect(pinRegistry().has('session-shared')).toBe(false)
  })

  it('keeps the shared registry bounded', () => {
    const registry = pinRegistry()
    for (let index = 0; index < PIN_REGISTRY_LIMIT + 40; index += 1) {
      publishPin(registry, `bulk-${index}`, {
        provider: 'p', model: 'm', effort: 'low', band: 'low', turn: 1, pinnedAt: index,
      })
    }
    expect(registry.size).toBe(PIN_REGISTRY_LIMIT)
    expect(registry.has('bulk-0')).toBe(false)
    for (let index = 0; index < PIN_REGISTRY_LIMIT + 40; index += 1) registry.delete(`bulk-${index}`)
  })
})
