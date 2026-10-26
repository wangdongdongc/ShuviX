/**
 * 重配的纯规则（`durable/reconfigure.ts`，2026-10-26）：
 *
 *  - `toolChangeSupport` / `supportsMidConvoSystemMessages`（RP-1..6）：只认 pi-ai compat 里写明为 `true` 的位；
 *    native = anthropic-messages 的两位都开，additive = responses 系的 additionalTools / toolSearch，或
 *    completions 的 system + toolAdditions，其余一律 none；
 *  - `mcpServerOfTool`（RP-7）：`mcp__<server>__<tool>` 的服务器名；
 *  - `orderForMinimalDiff`（RP-8..12）：durable `planTools` 重放「留下的（上下文原序）+ 新增的（想要的次序）」
 *    恰好得到它的输出 —— 不会全删全加；
 *  - `composeReconfiguredTools`（RP-13..18）：此刻的工具去掉被取消的服务器 / 换掉的技能工具，追加新的；
 *  - `predictCacheImpact`（PC-1..19）：手搭的 pi-ai 消息，判下一次请求还能不能命中缓存。
 */
import type {
  AssistantMessage,
  Message,
  SystemMessage,
  Tool,
  UserMessage
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  composeReconfiguredTools,
  mcpServerOfTool,
  orderForMinimalDiff,
  predictCacheImpact,
  supportsMidConvoSystemMessages,
  toolChangeSupport,
  type CacheImpact,
  type CacheImpactInput
} from '../reconfigure'

// ─────────────────────────── 夹具 ───────────────────────────

type ModelInfo = Parameters<typeof toolChangeSupport>[0]

function info(api: string, compat?: Record<string, unknown>): ModelInfo {
  return { api, ...(compat === undefined ? {} : { compat }) } as unknown as ModelInfo
}

const PARAMS = { type: 'object', properties: {} } as unknown as Tool['parameters']

function tool(name: string, description = `${name} v1`): Tool {
  return { name, description, parameters: PARAMS }
}

function sys(
  options: {
    added?: readonly Tool[]
    removed?: readonly string[]
    sections?: Record<string, string | null>
  } = {}
): SystemMessage {
  return {
    role: 'system',
    content: '',
    ...(options.sections === undefined ? {} : { sections: options.sections }),
    ...(options.added === undefined ? {} : { toolsAdded: [...options.added] }),
    ...(options.removed === undefined
      ? {}
      : { toolsRemoved: options.removed.map((name) => ({ name })) }),
    timestamp: 0
  }
}

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: 0 }
}

function reply(
  options: {
    provider?: string
    model?: string
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  } = {}
): AssistantMessage {
  const input = options.input ?? 0
  const output = options.output ?? 0
  const cacheRead = options.cacheRead ?? 0
  const cacheWrite = options.cacheWrite ?? 0
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'faux',
    provider: options.provider ?? 'p',
    model: options.model ?? 'm',
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: 0
  } as AssistantMessage
}

const SAME_MODEL = { provider: 'p', modelId: 'm' } as const
const NATIVE = info('anthropic-messages', {
  supportsMidConvoSystemMessages: true,
  supportsMidConvoToolChanges: true
})
const ADDITIVE = info('openai-responses', { supportsAdditionalTools: true })
const ADDITIVE_SYS = info('openai-completions', {
  supportsMidConvoSystemMessages: true,
  supportsMidConvoToolAdditions: true
})
const NONE = info('faux')

/** 上下文：一条带 A、B 的起始 system + 一轮问答 */
function baseContext(extra: readonly Message[] = []): Message[] {
  return [sys({ added: [tool('a'), tool('b')] }), user('hi'), reply(), ...extra]
}

function predict(input: Partial<CacheImpactInput> & Pick<CacheImpactInput, 'tools'>): CacheImpact {
  return predictCacheImpact({
    messages: baseContext(),
    nextModel: SAME_MODEL,
    nextModelInfo: NONE,
    ...input
  })
}

const names = (tools: readonly { name: string }[]): string[] => tools.map((t) => t.name)

// ─────────────────────────── 模型的能力 ───────────────────────────

describe('toolChangeSupport', () => {
  it('RP-1 anthropic-messages is native only with both mid-convo system messages and tool changes; one alone is none', () => {
    expect(toolChangeSupport(NATIVE)).toBe('native')
    expect(
      toolChangeSupport(info('anthropic-messages', { supportsMidConvoSystemMessages: true }))
    ).toBe('none')
    expect(
      toolChangeSupport(info('anthropic-messages', { supportsMidConvoToolChanges: true }))
    ).toBe('none')
    expect(toolChangeSupport(info('anthropic-messages'))).toBe('none')
    // additive 的那几位对 anthropic 没用
    expect(
      toolChangeSupport(
        info('anthropic-messages', { supportsAdditionalTools: true, supportsToolSearch: true })
      )
    ).toBe('none')
  })

  it.each(['openai-responses', 'openai-codex-responses', 'azure-openai-responses'])(
    'RP-2 %s is additive with supportsAdditionalTools or supportsToolSearch; neither (or only the mid-convo flags) is none',
    (api) => {
      expect(toolChangeSupport(info(api, { supportsAdditionalTools: true }))).toBe('additive')
      expect(toolChangeSupport(info(api, { supportsToolSearch: true }))).toBe('additive')
      expect(toolChangeSupport(info(api, {}))).toBe('none')
      expect(toolChangeSupport(info(api))).toBe('none')
      expect(
        toolChangeSupport(
          info(api, {
            supportsMidConvoSystemMessages: true,
            supportsMidConvoToolChanges: true,
            supportsMidConvoToolAdditions: true
          })
        )
      ).toBe('none')
    }
  )

  it('RP-3 openai-completions is additive with mid-convo system messages + tool additions; one alone, or tool changes instead, is none', () => {
    expect(toolChangeSupport(ADDITIVE_SYS)).toBe('additive')
    expect(
      toolChangeSupport(info('openai-completions', { supportsMidConvoSystemMessages: true }))
    ).toBe('none')
    expect(
      toolChangeSupport(info('openai-completions', { supportsMidConvoToolAdditions: true }))
    ).toBe('none')
    expect(
      toolChangeSupport(
        info('openai-completions', {
          supportsMidConvoSystemMessages: true,
          supportsMidConvoToolChanges: true
        })
      )
    ).toBe('none')
    expect(toolChangeSupport(info('openai-completions', { supportsAdditionalTools: true }))).toBe(
      'none'
    )
  })

  it.each(['google-generative-ai', 'mistral-conversations', 'bedrock-converse-stream', 'faux'])(
    'RP-4 %s is none even with every flag on; compat undefined is none',
    (api) => {
      expect(
        toolChangeSupport(
          info(api, {
            supportsMidConvoSystemMessages: true,
            supportsMidConvoToolChanges: true,
            supportsMidConvoToolAdditions: true,
            supportsAdditionalTools: true,
            supportsToolSearch: true
          })
        )
      ).toBe('none')
      expect(toolChangeSupport(info(api))).toBe('none')
    }
  )

  it('RP-5 truthy non-boolean flags do not count', () => {
    expect(
      toolChangeSupport(
        info('anthropic-messages', {
          supportsMidConvoSystemMessages: 'yes',
          supportsMidConvoToolChanges: 1
        })
      )
    ).toBe('none')
    expect(toolChangeSupport(info('openai-responses', { supportsAdditionalTools: 1 }))).toBe('none')
    expect(toolChangeSupport(info('openai-responses', { supportsToolSearch: 'true' }))).toBe('none')
    expect(
      toolChangeSupport(
        info('openai-completions', {
          supportsMidConvoSystemMessages: {},
          supportsMidConvoToolAdditions: true
        })
      )
    ).toBe('none')
  })

  it('RP-6 supportsMidConvoSystemMessages is true only for === true', () => {
    expect(
      supportsMidConvoSystemMessages(info('faux', { supportsMidConvoSystemMessages: true }))
    ).toBe(true)
    expect(
      supportsMidConvoSystemMessages(info('faux', { supportsMidConvoSystemMessages: 1 }))
    ).toBe(false)
    expect(
      supportsMidConvoSystemMessages(info('faux', { supportsMidConvoSystemMessages: 'true' }))
    ).toBe(false)
    expect(supportsMidConvoSystemMessages(info('faux', {}))).toBe(false)
    expect(supportsMidConvoSystemMessages(info('faux'))).toBe(false)
  })
})

describe('mcpServerOfTool', () => {
  it('RP-7 the server of `mcp__<server>__<tool>`; anything else is undefined', () => {
    expect(mcpServerOfTool('mcp__ctx__resolve')).toBe('ctx')
    expect(mcpServerOfTool('mcp__a_b__c')).toBe('a_b')
    // 服务器名不含 `__`：第一个 `__` 就是分隔
    expect(mcpServerOfTool('mcp__a__b__c')).toBe('a')
    expect(mcpServerOfTool('mcp__ctx')).toBeUndefined()
    expect(mcpServerOfTool('mcp____x')).toBeUndefined()
    expect(mcpServerOfTool('skill')).toBeUndefined()
    expect(mcpServerOfTool('MCP__x__y')).toBeUndefined()
    expect(mcpServerOfTool('mcp_x__y')).toBeUndefined()
  })
})

// ─────────────────────────── 工具次序 ───────────────────────────

/**
 * 本地神谕（照 durable planTools）：留下的 = 上下文里声明没变、仍在输出里的（上下文原序），新增的 = 输出里其余的
 * （输出序）；重放 = 留下的 + 新增的。最小差异的次序必须让重放与输出逐项相同。
 */
function replay(offered: readonly Tool[], output: readonly Tool[]): string[] {
  const byName = new Map(output.map((t) => [t.name, t]))
  const kept = offered.filter((t) => {
    const next = byName.get(t.name)
    return next !== undefined && JSON.stringify(next) === JSON.stringify(t)
  })
  const keptNames = new Set(kept.map((t) => t.name))
  return [...names(kept), ...names(output.filter((t) => !keptNames.has(t.name)))]
}

describe('orderForMinimalDiff', () => {
  it('RP-8 nothing offered yet → desired as is (same order, same objects)', () => {
    const desired = [tool('c'), tool('a'), tool('b')]
    const out = orderForMinimalDiff([], desired)
    expect(names(out)).toEqual(['c', 'a', 'b'])
    out.forEach((t, i) => expect(t).toBe(desired[i]))
  })

  it('RP-9 kept tools take the offered order; the rest follow in desired order', () => {
    const offered = [tool('a'), tool('b'), tool('c')]
    const desired = [tool('x'), tool('c'), tool('y'), tool('a'), tool('b')]
    expect(names(orderForMinimalDiff(offered, desired))).toEqual(['a', 'b', 'c', 'x', 'y'])
  })

  it('RP-10 a tool whose declaration changed moves to the tail', () => {
    const offered = [tool('a'), tool('skill', 'skill: pdf'), tool('b')]
    const desired = [tool('a'), tool('skill', 'skill: drawing'), tool('b'), tool('n')]
    expect(names(orderForMinimalDiff(offered, desired))).toEqual(['a', 'b', 'skill', 'n'])
  })

  it('RP-11 offered-but-not-desired tools are dropped; the returned objects are the desired ones', () => {
    const offered = [tool('a'), tool('gone'), tool('b')]
    const desired = [tool('b'), tool('a')]
    const out = orderForMinimalDiff(offered, desired)
    expect(names(out)).toEqual(['a', 'b'])
    expect(out[0]).toBe(desired[1])
    expect(out[1]).toBe(desired[0])
    expect(out.every((t) => !offered.includes(t))).toBe(true)
  })

  it('RP-12 property: replaying "kept in offered order + added in desired order" always equals the output, and the output is a permutation of desired', () => {
    // 线性同余，种子固定：失败可复现
    let seed = 20261026
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const shuffle = <T>(list: T[]): T[] => {
      const copy = [...list]
      for (let i = copy.length - 1; i > 0; i--) {
        const j = rand(i + 1)
        ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
      }
      return copy
    }
    for (let round = 0; round < 300; round++) {
      const offered = shuffle(pool)
        .slice(0, rand(pool.length + 1))
        .map((name) => tool(name, `${name} v${rand(2)}`))
      const desired = shuffle(pool)
        .slice(0, rand(pool.length + 1))
        .map((name) => tool(name, `${name} v${rand(2)}`))
      const out = orderForMinimalDiff(offered, desired)
      expect(replay(offered, out)).toEqual(names(out))
      expect([...names(out)].sort()).toEqual([...names(desired)].sort())
      out.forEach((t) => expect(desired).toContain(t))
    }
  })
})

describe('composeReconfiguredTools', () => {
  type T = { readonly name: string; readonly tag?: string }
  const t = (name: string, tag?: string): T => ({ name, ...(tag === undefined ? {} : { tag }) })
  const CURRENT: T[] = [
    t('bash'),
    t('agent'),
    t('skill', 'old'),
    t('mcp__ctx__resolve'),
    t('mcp__ctx__docs'),
    t('mcp_x__y'),
    t('mcp__xy__t')
  ]

  it('RP-13 skill kept and nothing removed or added → the same tools in the same order', () => {
    const out = composeReconfiguredTools({
      current: CURRENT,
      removedServers: new Set(),
      skill: { change: 'keep' },
      addedMcp: []
    })
    expect(out).toEqual(CURRENT)
    out.forEach((tool, i) => expect(tool).toBe(CURRENT[i]))
  })

  it('RP-14 a removed server drops all of its tools; `mcp_x__y` (single underscore) and other servers are untouched', () => {
    const out = composeReconfiguredTools({
      current: CURRENT,
      removedServers: new Set(['ctx', 'x']),
      skill: { change: 'keep' },
      addedMcp: []
    })
    expect(names(out)).toEqual(['bash', 'agent', 'skill', 'mcp_x__y', 'mcp__xy__t'])
  })

  it('RP-15 a replaced skill tool: the old one is dropped and the new one appended before the added MCP tools', () => {
    const fresh = t('skill', 'new')
    const out = composeReconfiguredTools({
      current: CURRENT,
      removedServers: new Set(),
      skill: { change: 'replace', tool: fresh },
      addedMcp: [{ server: 'new', tools: [t('mcp__new__fresh')] }]
    })
    expect(names(out)).toEqual([
      'bash',
      'agent',
      'mcp__ctx__resolve',
      'mcp__ctx__docs',
      'mcp_x__y',
      'mcp__xy__t',
      'skill',
      'mcp__new__fresh'
    ])
    expect(out[6]).toBe(fresh)
  })

  it('RP-16 replacing the skill tool with undefined removes it', () => {
    const out = composeReconfiguredTools({
      current: CURRENT,
      removedServers: new Set(),
      skill: { change: 'replace', tool: undefined },
      addedMcp: []
    })
    expect(names(out)).not.toContain('skill')
    expect(out).toHaveLength(CURRENT.length - 1)
  })

  it('RP-17 added MCP tools follow the entry order, then the tool order within each entry', () => {
    const out = composeReconfiguredTools({
      current: [t('bash')],
      removedServers: new Set(),
      skill: { change: 'keep' },
      addedMcp: [
        { server: 'zeta', tools: [t('mcp__zeta__b'), t('mcp__zeta__a')] },
        { server: 'alpha', tools: [t('mcp__alpha__x')] }
      ]
    })
    expect(names(out)).toEqual(['bash', 'mcp__zeta__b', 'mcp__zeta__a', 'mcp__alpha__x'])
  })

  it('RP-18 a name collision keeps the first; a server both removed and re-added → old tools dropped, new ones appended', () => {
    const clash = composeReconfiguredTools({
      current: [t('bash', 'builtin'), t('mcp__ctx__resolve', 'old')],
      removedServers: new Set(),
      skill: { change: 'keep' },
      addedMcp: [{ server: 'other', tools: [t('bash', 'dup'), t('mcp__ctx__resolve', 'dup')] }]
    })
    expect(clash).toEqual([t('bash', 'builtin'), t('mcp__ctx__resolve', 'old')])

    const readded = composeReconfiguredTools({
      current: [t('bash'), t('mcp__ctx__resolve', 'old'), t('mcp__ctx__docs', 'old'), t('read')],
      removedServers: new Set(['ctx']),
      skill: { change: 'keep' },
      addedMcp: [{ server: 'ctx', tools: [t('mcp__ctx__resolve', 'new')] }]
    })
    expect(readded).toEqual([t('bash'), t('read'), t('mcp__ctx__resolve', 'new')])
  })
})

// ─────────────────────────── 缓存预判 ───────────────────────────

describe('predictCacheImpact', () => {
  it('PC-1 no assistant reply in the context → none, no reasons, 0 tokens (whatever changes)', () => {
    const impact = predictCacheImpact({
      messages: [sys({ added: [tool('a')] }), user('hi')],
      nextModel: { provider: 'other', modelId: 'x' },
      nextModelInfo: NONE,
      tools: [tool('b')],
      pendingServers: ['srv'],
      sectionsChange: true
    })
    expect(impact).toEqual({ cache: 'none', reasons: [], promptTokens: 0 })
  })

  it('PC-2 same model and equal tools → kept; promptTokens = input + cacheRead + cacheWrite (output excluded)', () => {
    const impact = predictCacheImpact({
      messages: [
        sys({ added: [tool('a'), tool('b')] }),
        user('hi'),
        reply({ input: 1000, cacheRead: 200, cacheWrite: 50, output: 999 })
      ],
      nextModel: SAME_MODEL,
      nextModelInfo: NONE,
      tools: [tool('a'), tool('b')]
    })
    expect(impact).toEqual({ cache: 'kept', reasons: [], promptTokens: 1250 })
  })

  it('PC-3 promptTokens come from the last assistant reply', () => {
    const impact = predictCacheImpact({
      messages: [
        sys({ added: [tool('a')] }),
        user('one'),
        reply({ input: 5, cacheRead: 5 }),
        user('two'),
        reply({ input: 7, cacheRead: 30, cacheWrite: 3 }),
        user('three')
      ],
      nextModel: SAME_MODEL,
      nextModelInfo: NONE,
      tools: [tool('a')]
    })
    expect(impact.promptTokens).toBe(40)
  })

  it('PC-4 a different provider or model id → lost with exactly ["model"], even with tool and section changes', () => {
    for (const nextModel of [
      { provider: 'q', modelId: 'm' },
      { provider: 'p', modelId: 'm2' }
    ]) {
      const impact = predict({
        nextModel,
        nextModelInfo: NONE,
        tools: [tool('a'), tool('c')],
        pendingServers: ['srv'],
        sectionsChange: true
      })
      expect(impact).toEqual({ cache: 'lost', reasons: ['model'], promptTokens: 0 })
    }
  })

  it('PC-5 none support: adding a tool → lost ["tools"]', () => {
    expect(predict({ tools: [tool('a'), tool('b'), tool('c')] })).toMatchObject({
      cache: 'lost',
      reasons: ['tools']
    })
  })

  it('PC-6 none support: removing a tool → lost ["tools"]', () => {
    expect(predict({ tools: [tool('a')] })).toMatchObject({ cache: 'lost', reasons: ['tools'] })
  })

  it('PC-7 model unknown to the catalog + a tool change → ["tools"]; with a section change too → ["tools", "prompt"]', () => {
    expect(predict({ nextModelInfo: undefined, tools: [tool('a')] })).toMatchObject({
      cache: 'lost',
      reasons: ['tools']
    })
    expect(
      predict({ nextModelInfo: undefined, tools: [tool('a')], sectionsChange: true })
    ).toMatchObject({ cache: 'lost', reasons: ['tools', 'prompt'] })
  })

  it('PC-8 native: an addition plus a removal → kept', () => {
    expect(predict({ nextModelInfo: NATIVE, tools: [tool('a'), tool('c')] })).toEqual({
      cache: 'kept',
      reasons: [],
      promptTokens: 0
    })
  })

  it('PC-9 native: a redeclaration → kept', () => {
    expect(predict({ nextModelInfo: NATIVE, tools: [tool('a'), tool('b', 'b v2')] })).toMatchObject(
      { cache: 'kept', reasons: [] }
    )
  })

  it('PC-10 additive: a pure addition on a clean context → kept', () => {
    for (const model of [ADDITIVE, ADDITIVE_SYS]) {
      expect(
        predict({ nextModelInfo: model, tools: [tool('a'), tool('b'), tool('c')] })
      ).toMatchObject({ cache: 'kept', reasons: [] })
    }
  })

  it('PC-11 additive: a removal → lost ["tools"]', () => {
    expect(predict({ nextModelInfo: ADDITIVE, tools: [tool('a')] })).toMatchObject({
      cache: 'lost',
      reasons: ['tools']
    })
  })

  it('PC-12 additive: a redeclaration → lost ["tools"]', () => {
    expect(
      predict({ nextModelInfo: ADDITIVE, tools: [tool('a'), tool('b', 'b v2')] })
    ).toMatchObject({ cache: 'lost', reasons: ['tools'] })
  })

  it('PC-13 additive: a pure addition, but the context already holds a removal → lost', () => {
    const messages = baseContext([sys({ removed: ['b'] }), user('again'), reply()])
    expect(
      predictCacheImpact({
        messages,
        nextModel: SAME_MODEL,
        nextModelInfo: ADDITIVE,
        tools: [tool('a'), tool('c')]
      })
    ).toMatchObject({ cache: 'lost', reasons: ['tools'] })
  })

  it('PC-14 additive: a pure addition, but the context already holds a redeclaration → lost', () => {
    const messages = baseContext([
      sys({ removed: [], added: [tool('b', 'b v2')] }),
      user('again'),
      reply()
    ])
    expect(
      predictCacheImpact({
        messages,
        nextModel: SAME_MODEL,
        nextModelInfo: ADDITIVE,
        tools: [tool('a'), tool('b', 'b v2'), tool('c')]
      })
    ).toMatchObject({ cache: 'lost', reasons: ['tools'] })
  })

  it('PC-15 additive: re-adding a name the context removed earlier → lost', () => {
    const messages = [
      sys({ added: [tool('a'), tool('b')] }),
      user('hi'),
      reply(),
      sys({ removed: ['b'] }),
      user('next'),
      reply()
    ]
    expect(
      predictCacheImpact({
        messages,
        nextModel: SAME_MODEL,
        nextModelInfo: ADDITIVE,
        tools: [tool('a'), tool('b')]
      })
    ).toMatchObject({ cache: 'lost', reasons: ['tools'] })
  })

  it('PC-16 a pending server absent from the context counts as an addition: none → lost, additive (clean) → kept, native → kept', () => {
    const base = { tools: [tool('a'), tool('b')], pendingServers: ['srv'] }
    expect(predict({ ...base, nextModelInfo: NONE })).toMatchObject({
      cache: 'lost',
      reasons: ['tools']
    })
    expect(predict({ ...base, nextModelInfo: ADDITIVE })).toMatchObject({
      cache: 'kept',
      reasons: []
    })
    expect(predict({ ...base, nextModelInfo: NATIVE })).toMatchObject({
      cache: 'kept',
      reasons: []
    })
    // 上下文里有删除：additive 下待接的服务器也打穿
    expect(
      predictCacheImpact({
        messages: baseContext([sys({ removed: ['b'] }), user('again'), reply()]),
        nextModel: SAME_MODEL,
        nextModelInfo: ADDITIVE,
        tools: [tool('a')],
        pendingServers: ['srv']
      })
    ).toMatchObject({ cache: 'lost', reasons: ['tools'] })
  })

  it('PC-17 a pending server whose tools are still in the context (untick then re-tick, not sent yet) → kept, even on none', () => {
    const messages = [
      sys({ added: [tool('a'), tool('mcp__srv__x'), tool('mcp__srv__y')] }),
      user('hi'),
      reply()
    ]
    expect(
      predictCacheImpact({
        messages,
        nextModel: SAME_MODEL,
        nextModelInfo: NONE,
        tools: [tool('a')],
        pendingServers: ['srv']
      })
    ).toEqual({ cache: 'kept', reasons: [], promptTokens: 0 })
  })

  it('PC-18 a pure reorder → kept', () => {
    expect(predict({ tools: [tool('b'), tool('a')] })).toMatchObject({ cache: 'kept', reasons: [] })
  })

  it('PC-19 a section change only: without mid-convo system messages → ["prompt"]; with → kept; native + system + tools + sections → kept', () => {
    expect(predict({ tools: [tool('a'), tool('b')], sectionsChange: true })).toMatchObject({
      cache: 'lost',
      reasons: ['prompt']
    })
    expect(
      predict({
        nextModelInfo: info('faux', { supportsMidConvoSystemMessages: true }),
        tools: [tool('a'), tool('b')],
        sectionsChange: true
      })
    ).toMatchObject({ cache: 'kept', reasons: [] })
    expect(
      predict({
        nextModelInfo: NATIVE,
        tools: [tool('a'), tool('b', 'b v2'), tool('c')],
        sectionsChange: true
      })
    ).toMatchObject({ cache: 'kept', reasons: [] })
    // 没有改动的 sectionsChange: false 与缺省相同
    expect(predict({ tools: [tool('a'), tool('b')], sectionsChange: false })).toMatchObject({
      cache: 'kept'
    })
  })
})
