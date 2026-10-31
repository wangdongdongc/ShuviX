/**
 * Tool-name repair — the pure helpers `withNetwork` uses to rename a tool call whose name matches
 * an offered tool only up to letter case.
 *
 * What is pinned:
 *  1. **The offered set is pi's own.** `getCurrentTools(normalizeContext(context).messages)`:
 *     `context.tools` and transcript system messages (`toolsAdded` / `toolsRemoved`) both count.
 *  2. **Only an unambiguous case fold is repaired.** An exact name, an unknown name, a near miss
 *     (underscore, trailing space) and a fold onto two tools all stay as written.
 *  3. **Nothing is mutated; nothing changes identity without a reason.** A message or event that
 *     needs no repair comes back as the same object; one that does is a copy whose untouched
 *     blocks keep their references.
 */
import { describe, expect, it } from 'vitest'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Tool,
  ToolCall
} from '@earendil-works/pi-ai'
import {
  repairEventToolNames,
  repairToolCallNames,
  toolNameResolverFor,
  type ToolNameResolver
} from '../toolNameRepair'

// ─────────────────────────── fakes ───────────────────────────

function T(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} } as unknown as Tool['parameters']
  }
}

function tc(name: string, extra: Partial<ToolCall> = {}): ToolCall {
  return { type: 'toolCall', id: 'c1', name, arguments: { x: 1 }, ...extra }
}

function msg(
  content: AssistantMessage['content'],
  extra: Partial<AssistantMessage> = {}
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test-api',
    provider: 'p1',
    model: 'm1',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'toolUse',
    timestamp: 1,
    ...extra
  }
}

function system(extra: { toolsAdded?: Tool[]; toolsRemoved?: Array<{ name: string }> }): Message {
  return { role: 'system', content: 'p', timestamp: 0, ...extra }
}

/** The resolver for `tools`, asserted to exist. */
function resolverOf(context: Context): ToolNameResolver {
  const resolve = toolNameResolverFor(context)
  if (!resolve) throw new Error('expected a resolver')
  return resolve
}

const POWERSHELL = (): ToolNameResolver => resolverOf({ tools: [T('powershell')], messages: [] })

function partialOf(event: AssistantMessageEvent): AssistantMessage {
  if (event.type === 'done') return event.message
  if (event.type === 'error') return event.error
  return event.partial
}

function nameAt(message: AssistantMessage, index: number): string | undefined {
  const block = message.content[index]
  return block?.type === 'toolCall' ? block.name : undefined
}

// ─────────────────────────── toolNameResolverFor ───────────────────────────

describe('toolNameResolverFor', () => {
  it('R1 no tools at all → undefined', () => {
    expect(toolNameResolverFor({ messages: [] })).toBeUndefined()
  })

  it('R2 an empty tools list → undefined', () => {
    expect(toolNameResolverFor({ tools: [], messages: [] })).toBeUndefined()
  })

  it('R3 a case-only mismatch folds to the offered tool', () => {
    const resolve = resolverOf({ tools: [T('powershell'), T('read')], messages: [] })
    expect(resolve('powerShell')).toBe('powershell')
    expect(resolve('POWERSHELL')).toBe('powershell')
    expect(resolve('Read')).toBe('read')
  })

  it('R4 exact names, unknown names and near misses are returned as written', () => {
    const resolve = resolverOf({ tools: [T('powershell'), T('read')], messages: [] })
    expect(resolve('powershell')).toBe('powershell')
    expect(resolve('bash')).toBe('bash')
    expect(resolve('power_shell')).toBe('power_shell')
    expect(resolve('powershell ')).toBe('powershell ')
  })

  it('R5 tools declared only in a transcript system message count', () => {
    const resolve = toolNameResolverFor({ messages: [system({ toolsAdded: [T('powershell')] })] })
    expect(resolve).toBeDefined()
    expect(resolve!('PowerShell')).toBe('powershell')
  })

  it('R6 a tool removed later in the transcript, nothing left → undefined', () => {
    const context: Context = {
      tools: [T('powershell')],
      messages: [system({ toolsRemoved: [{ name: 'powershell' }] })]
    }
    expect(toolNameResolverFor(context)).toBeUndefined()
  })

  it('R7 a tool added later folds alongside context.tools, with its own spelling', () => {
    const resolve = resolverOf({
      tools: [T('read')],
      messages: [system({ toolsAdded: [T('Grep')] })]
    })
    expect(resolve('grep')).toBe('Grep')
    expect(resolve('READ')).toBe('read')
  })

  it('R8 two tools differing only in case: a fold is ambiguous and left alone', () => {
    const resolve = resolverOf({ tools: [T('Foo'), T('foo')], messages: [] })
    expect(resolve('FOO')).toBe('FOO')
    expect(resolve('fOo')).toBe('fOo')
    expect(resolve('Foo')).toBe('Foo')
    expect(resolve('foo')).toBe('foo')
  })

  it('R9 ambiguity is per name: another tool still folds', () => {
    const resolve = resolverOf({ tools: [T('Foo'), T('foo'), T('bar')], messages: [] })
    expect(resolve('BAR')).toBe('bar')
    expect(resolve('FOO')).toBe('FOO')
  })

  it('R10 a context it cannot read → undefined, no throw', () => {
    expect(toolNameResolverFor({} as Context)).toBeUndefined()
    expect(
      toolNameResolverFor({ messages: undefined, tools: [T('x')] } as unknown as Context)
    ).toBeUndefined()
  })

  it('R11 MCP-style names fold as a whole', () => {
    const resolve = resolverOf({ tools: [T('mcp__browser__click')], messages: [] })
    expect(resolve('MCP__Browser__Click')).toBe('mcp__browser__click')
  })

  it('R12 a tool without a string name is skipped; only nameless tools → undefined', () => {
    for (const odd of [{ description: 'x' }, { name: 42, description: 'x' }]) {
      const resolve = resolverOf({ tools: [odd as never, T('powershell')], messages: [] })
      expect(resolve('powerShell')).toBe('powershell')
      expect(toolNameResolverFor({ tools: [odd as never], messages: [] })).toBeUndefined()
    }
  })
})

// ─────────────────────────── repairToolCallNames ───────────────────────────

describe('repairToolCallNames', () => {
  function m1(): { original: AssistantMessage; repaired: AssistantMessage } {
    const original = msg(
      [
        { type: 'text', text: 'hi' },
        tc('powerShell', { thoughtSignature: 'sig', namespace: 'ns' })
      ],
      { responseId: 'r-1', stopReason: 'toolUse' }
    )
    return { original, repaired: repairToolCallNames(original, POWERSHELL()) }
  }

  it('M1 a copy with the call renamed; every other field and block kept', () => {
    const { original, repaired } = m1()

    expect(repaired).not.toBe(original)
    expect(repaired.content[1]).toEqual({
      type: 'toolCall',
      id: 'c1',
      name: 'powershell',
      arguments: { x: 1 },
      thoughtSignature: 'sig',
      namespace: 'ns'
    })
    expect(repaired.content[0]).toBe(original.content[0])
    expect({ ...repaired, content: undefined }).toEqual({ ...original, content: undefined })
  })

  it('M2 the input message is not mutated', () => {
    const { original } = m1()
    expect(nameAt(original, 1)).toBe('powerShell')
    expect(original.content).toHaveLength(2)
  })

  it('M3 nothing to repair (exact or unknown names) → the same object', () => {
    const exact = msg([{ type: 'text', text: 'hi' }, tc('powershell')])
    const unknown = msg([tc('unknownTool')])
    expect(repairToolCallNames(exact, POWERSHELL())).toBe(exact)
    expect(repairToolCallNames(unknown, POWERSHELL())).toBe(unknown)
  })

  it('M4 no tool calls → the same object', () => {
    const message = msg([
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'hmm' }
    ])
    expect(repairToolCallNames(message, POWERSHELL())).toBe(message)
  })

  it('M5 only the call that needs it is replaced', () => {
    const resolve = resolverOf({ tools: [T('read'), T('powershell')], messages: [] })
    const original = msg([tc('read'), tc('PowerShell', { id: 'c2' })])

    const repaired = repairToolCallNames(original, resolve)

    expect(repaired.content[0]).toBe(original.content[0])
    expect(nameAt(repaired, 1)).toBe('powershell')
  })

  it('M6 a partial tool call without a usable name → no throw, the same object', () => {
    const blocks = [
      { type: 'toolCall', id: 'c1', arguments: {} },
      { type: 'toolCall', id: 'c1', name: undefined, arguments: {} },
      { type: 'toolCall', id: 'c1', name: 42, arguments: {} }
    ]
    for (const block of blocks) {
      const message = msg([block as unknown as ToolCall])
      expect(repairToolCallNames(message, POWERSHELL())).toBe(message)
    }
  })

  it('M7 empty content → the same object', () => {
    const message = msg([])
    expect(repairToolCallNames(message, POWERSHELL())).toBe(message)
  })
})

// ─────────────────────────── repairEventToolNames ───────────────────────────

describe('repairEventToolNames', () => {
  it.each(['toolcall_start', 'toolcall_delta'] as const)(
    'E1 %s: the partial is repaired; contentIndex and delta kept',
    (type) => {
      const partial = msg([tc('powerShell')])
      const event = (
        type === 'toolcall_start'
          ? { type, contentIndex: 0, partial }
          : { type, contentIndex: 0, delta: '{"x":', partial }
      ) as AssistantMessageEvent

      const repaired = repairEventToolNames(event, POWERSHELL())

      expect(repaired).not.toBe(event)
      expect(repaired).toEqual({ ...event, partial: msg([tc('powershell')]) })
      expect(nameAt(partial, 0)).toBe('powerShell')
    }
  )

  it.each([
    { type: 'text_delta', contentIndex: 1, delta: 'x' },
    { type: 'thinking_end', contentIndex: 1, content: 'thought' },
    { type: 'start' }
  ])('E2 $type: an earlier tool call in the partial is repaired', (fields) => {
    const event = {
      ...fields,
      partial: msg([tc('powerShell'), { type: 'text', text: 'x' }])
    } as AssistantMessageEvent

    const repaired = repairEventToolNames(event, POWERSHELL())

    expect(repaired).not.toBe(event)
    expect(nameAt(partialOf(repaired), 0)).toBe('powershell')
    expect({ ...repaired, partial: undefined }).toEqual({ ...event, partial: undefined })
  })

  it('E3 toolcall_end: the toolCall and the partial are both repaired', () => {
    const call = tc('powerShell')
    const event: AssistantMessageEvent = {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: call,
      partial: msg([call])
    }

    const repaired = repairEventToolNames(event, POWERSHELL())

    if (repaired.type !== 'toolcall_end') throw new Error('expected toolcall_end')
    expect(repaired.toolCall).toEqual(tc('powershell'))
    expect(nameAt(repaired.partial, 0)).toBe('powershell')
    expect(repaired.contentIndex).toBe(0)
    expect(call.name).toBe('powerShell')
  })

  it('E4 toolcall_end: only the side that needs it is replaced', () => {
    const resolve = resolverOf({ tools: [T('read'), T('powershell')], messages: [] })

    const textPartial = msg([{ type: 'text', text: 'x' }])
    const onlyCall = repairEventToolNames(
      { type: 'toolcall_end', contentIndex: 1, toolCall: tc('powerShell'), partial: textPartial },
      resolve
    )
    if (onlyCall.type !== 'toolcall_end') throw new Error('expected toolcall_end')
    expect(onlyCall.toolCall.name).toBe('powershell')
    expect(onlyCall.partial).toBe(textPartial)

    const exactCall = tc('read', { id: 'c2' })
    const onlyPartial = repairEventToolNames(
      {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: exactCall,
        partial: msg([tc('powerShell'), exactCall])
      },
      resolve
    )
    if (onlyPartial.type !== 'toolcall_end') throw new Error('expected toolcall_end')
    expect(onlyPartial.toolCall).toBe(exactCall)
    expect(nameAt(onlyPartial.partial, 0)).toBe('powershell')
  })

  it('E5 done: the message is repaired, the reason kept', () => {
    const event: AssistantMessageEvent = {
      type: 'done',
      reason: 'toolUse',
      message: msg([tc('powerShell')])
    }

    const repaired = repairEventToolNames(event, POWERSHELL())

    if (repaired.type !== 'done') throw new Error('expected done')
    expect(repaired.reason).toBe('toolUse')
    expect(nameAt(repaired.message, 0)).toBe('powershell')
  })

  it('E6 error: the error message is repaired, the reason kept', () => {
    const event: AssistantMessageEvent = {
      type: 'error',
      reason: 'aborted',
      error: msg([tc('powerShell')], { stopReason: 'aborted', errorMessage: 'Aborted.' })
    }

    const repaired = repairEventToolNames(event, POWERSHELL())

    if (repaired.type !== 'error') throw new Error('expected error')
    expect(repaired.reason).toBe('aborted')
    expect(nameAt(repaired.error, 0)).toBe('powershell')
    expect(repaired.error.errorMessage).toBe('Aborted.')
  })

  it('E7 nothing to repair → the same event, for every event shape', () => {
    const clean = msg([tc('powershell'), { type: 'text', text: 'x' }])
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: clean },
      { type: 'text_delta', contentIndex: 1, delta: 'x', partial: clean },
      { type: 'toolcall_start', contentIndex: 0, partial: clean },
      { type: 'toolcall_end', contentIndex: 0, toolCall: tc('powershell'), partial: clean },
      { type: 'done', reason: 'toolUse', message: clean },
      { type: 'error', reason: 'error', error: msg([tc('bash')], { stopReason: 'error' }) }
    ]
    for (const event of events) expect(repairEventToolNames(event, POWERSHELL())).toBe(event)
  })

  it('E8 an event type pi might add later, without a partial → the same object', () => {
    const event = { type: 'usage_update', usage: { input: 1 } } as unknown as AssistantMessageEvent
    expect(repairEventToolNames(event, POWERSHELL())).toBe(event)
  })
})
