/**
 * Fidelity of the ported band decision against OmniRoute's own test vectors
 * (`tests/unit/adaptive-effort.test.ts` upstream), plus Harness-shaped content
 * blocks and the route clamp.
 */
import { describe, expect, it } from 'vitest'

import { clampBand, DEFAULT_THRESHOLDS, resolveBand } from '../src/effort-bands.ts'

type Msg = { role: string; content: unknown }
const msg = (role: string, content: unknown): Msg => ({ role, content })
const text = (role: string, value: string): Msg => ({ role, content: [{ type: 'text', text: value }] })

describe('resolveBand — upstream vectors', () => {
  it('resolves a trivial ask to low', () => {
    expect(resolveBand([msg('user', 'list the files')])).toBe('low')
  })

  it('resolves a heavy user message to high (4009 chars >= 4000)', () => {
    expect(resolveBand([
      msg('user', 'long enough'),
      msg('assistant', 'x'.repeat(40)),
      msg('user', 'continue ' + 'deep work '.repeat(400)),
    ])).toBe('high')
  })

  it('keeps a trivial ask inside a big prior context at medium', () => {
    expect(resolveBand([
      msg('user', 'first ask that is long enough to not be trivial itself ' + 'pad '.repeat(60)),
      msg('assistant', 'answer ' + 'y'.repeat(30000)),
      msg('user', 'short follow-up'),
    ])).toBe('medium')
  })

  it('resolves empty input to the safe default', () => {
    for (const value of [[], undefined, null]) expect(resolveBand(value)).toBe('medium')
  })

  it('holds the stateless per-turn pin across a mid-loop tool burst', () => {
    const userTurn = [msg('user', 'fix the failing test')]
    const turnStart = resolveBand(userTurn)
    const midLoop = resolveBand([
      ...userTurn,
      msg('assistant', 'checking'),
      msg('tool', 'z'.repeat(5000)),
      msg('assistant', 'checking more'),
      msg('tool', 'z'.repeat(5000)),
    ])
    expect(midLoop).toBe(turnStart)
  })
})

describe('resolveBand — Harness content shapes', () => {
  it('matches the string-shaped result for block-shaped content', () => {
    expect(resolveBand([text('user', 'hi there')])).toBe('low')
  })

  it('escalates once six tool results precede the new user message', () => {
    const loop = Array.from({ length: 6 }, () => [msg('assistant', 'calling'), msg('tool', 'output')]).flat()
    expect(resolveBand([msg('user', 'start'), ...loop, msg('user', 'and now?')])).toBe('high')
  })

  it('lets tool-loop depth veto `low` without reaching `high`', () => {
    expect(resolveBand([
      text('user', 'read it'),
      { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'a'.repeat(1200) }] },
      text('user', 'and now?'),
    ])).toBe('medium')
  })

  it('ignores reasoning and image blocks when estimating', () => {
    const noisy = [
      { role: 'assistant', content: [{ type: 'reasoning', text: 'r'.repeat(4000) }, { type: 'image', attachment: {} }] },
      text('user', 'short follow-up'),
    ]
    expect(resolveBand(noisy)).toBe('low')
  })
})

describe('clampBand', () => {
  it('de-escalates when the route declares fewer levels', () => {
    expect(clampBand('high', ['off', 'minimal', 'low'])).toBe('low')
  })

  it('escalates when nothing at or below the band exists', () => {
    expect(clampBand('low', ['medium', 'high'])).toBe('medium')
  })

  it('keeps an exact match on a full ladder', () => {
    expect(clampBand('high', ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).toBe('high')
  })

  it('leaves the adapter default when the route offers nothing steerable', () => {
    expect(clampBand('medium', [])).toBeUndefined()
  })
})

describe('threshold overrides', () => {
  it('honours a narrowed heavy band', () => {
    const messages = [text('user', 'x'.repeat(500))]
    expect(resolveBand(messages, DEFAULT_THRESHOLDS)).toBe('medium')
    expect(resolveBand(messages, { ...DEFAULT_THRESHOLDS, heavyUserChars: 400 })).toBe('high')
  })
})
