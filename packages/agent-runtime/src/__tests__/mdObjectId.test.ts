/**
 * `shuvix-id` 的读取（mdObjectId.ts `readObjectIdField`）与四个解析器的往返 —— 契约见
 * chat-protocol mdMeta.ts、docs/md-metadata-design.md。
 *
 *   OI-1…4  readObjectIdField：没写 → undefined 且不告警；合法 → 归一后的 id；写坏 → undefined +
 *           恰一条软提示（不说 rejected —— 写坏的 id 不连累文件）；不传 warn 不抛
 *   OI-5…7  四类文件 × setShuvixIdLine：插一行之后解析出这个 id，其余字段与插之前逐字段相同；
 *           CRLF / BOM 变体一样；大写 UUID 读成小写
 *   OI-8    三个序列化器（agent / bot / policy）与行写入器给出同一份文本 —— 「新建」与「覆盖副本」
 *           两条路写出的 id 行长得一样
 *   OI-9    三族内置 md 一网打尽：每一份都写着合法的内置 id，kind 与所在族一致、名字与 spec 一致，
 *           三语共用一个 id、族与族之间互不相撞（退役策略的测试夹具不在随包文件里，不计）
 */
import { describe, it, expect, vi } from 'vitest'
import {
  builtinObjectId,
  parseObjectId,
  setShuvixIdLine,
  type MdObjectKind
} from '@shuvix/chat-protocol/mdMeta'
import { BUILTIN_PROFILE_SPECS } from '../subagent/builtinAgents'
import { createInlineMdReader } from '../subagent/builtinAgents/inlineSources'
import { BUILTIN_HOOK_SPECS } from '../hook/builtinHooks'
import { createInlineHookMdReader } from '../hook/builtinHooks/inlineSources'
import { BUILTIN_POLICY_SPECS } from '../security/builtinPolicies'
import { createInlinePolicyMdReader } from '../security/builtinPolicies/inlineSources'
import { readObjectIdField } from '../mdObjectId'
import {
  parseAgentDefinitionFile,
  serializeAgentDefinitionFile,
  type ParsedAgentFile
} from '../agentProfile/definitionFile'
import { parseBotDefinitionFile, serializeBotDefinitionFile } from '../bot/botFile'
import { parseHookDefinitionFile } from '../hook/hookFile'
import { parsePolicyDefinitionFile, serializePolicyDefinitionFile } from '../security/policyFile'
import type { ParsedPolicyFile } from '../security/types'

const U = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'

describe('OI-1…4 readObjectIdField', () => {
  it('OI-1 没写这个键 → undefined，不告警', () => {
    const warn = vi.fn()
    expect(readObjectIdField({ name: 'a1' }, "agent 'a1'", warn)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('OI-2 合法：大写 UUID 归一为小写；内置形态原样；不告警', () => {
    const warn = vi.fn()
    expect(readObjectIdField({ 'shuvix-id': U.toUpperCase() }, "agent 'a1'", warn)).toBe(U)
    expect(readObjectIdField({ 'shuvix-id': 'agent:builtin:explore' }, "agent 'a1'", warn)).toBe(
      'agent:builtin:explore'
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it.each<[string, unknown]>([
    ['nope', 'nope'],
    ['空串', ''],
    ['null（空值）', null],
    ['数字', 123],
    ['数组', []],
    ['映射', {}]
  ])('OI-3 写坏（%s）→ undefined + 恰一条软提示，主语在前，不说 rejected', (_label, value) => {
    const warn = vi.fn()
    expect(readObjectIdField({ 'shuvix-id': value }, "agent 'a1'", warn)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0][0])
    expect(msg.startsWith("agent 'a1': 'shuvix-id' is not a valid object id")).toBe(true)
    expect(msg).not.toContain('rejected')
  })

  it('OI-4 不传 warn：写坏也不抛', () => {
    expect(() => readObjectIdField({ 'shuvix-id': 'nope' }, "agent 'a1'")).not.toThrow()
    expect(readObjectIdField({ 'shuvix-id': 'nope' }, "agent 'a1'")).toBeUndefined()
  })
})

type Parsed = { objectId?: string } & Record<string, unknown>

interface KindFixture {
  kind: MdObjectKind
  name: string
  text: string
  parse: (text: string, warn?: (msg: string) => void) => Parsed | null
}

/** 四类文件的最小合法夹具（name 与默认名不同，免得「读到的是默认名」蒙混过关） */
const FIXTURES: KindFixture[] = [
  {
    kind: 'agent',
    name: 'a1',
    text: '---\nshuvix: agent v1\nname: a1\n---\n\nBody.\n',
    parse: (t, w) => parseAgentDefinitionFile(t, 'fallback', w) as Parsed | null
  },
  {
    kind: 'bot',
    name: 'b1',
    text: '---\nshuvix: bot v2\nname: b1\n---\n\nBody.\n',
    parse: (t, w) => parseBotDefinitionFile(t, 'fallback', w) as Parsed | null
  },
  {
    kind: 'hook',
    name: 'h1',
    text: [
      '---',
      'shuvix: hook v1',
      'name: h1',
      'shuvix-hook-agent: titler',
      'shuvix-hook-on: [{trigger: session.turn-completed}]',
      '---',
      '',
      'Do it.',
      ''
    ].join('\n'),
    parse: (t, w) => parseHookDefinitionFile(t, 'fallback', w) as Parsed | null
  },
  {
    kind: 'policy',
    name: 'p1',
    text: [
      '---',
      'shuvix: policy v1',
      'name: p1',
      'shuvix-policy-rules:',
      '  - effect: ask',
      '    subject.kind: [agent]',
      '---',
      '',
      'Rationale.',
      ''
    ].join('\n'),
    parse: (t, w) => parsePolicyDefinitionFile(t, 'fallback', w) as Parsed | null
  }
]

/** 解析且断言零告警、非 null */
function parseClean(fx: KindFixture, text: string): Parsed {
  const warns: string[] = []
  const parsed = fx.parse(text, (m) => warns.push(m))
  expect(parsed, `${fx.kind} 解析失败：${warns.join(' | ')}`).not.toBeNull()
  expect(warns, fx.kind).toEqual([])
  return parsed!
}

/** 去掉 objectId 之后的字段 */
const rest = ({ objectId: _objectId, ...fields }: Parsed): Record<string, unknown> => fields

describe('OI-5…7 四类文件 × setShuvixIdLine 往返', () => {
  it.each(FIXTURES)(
    'OI-5 $kind：插一行之后读出这个 id，其余字段与插之前相同（UUID 与本类内置 id）',
    (fx) => {
      const before = parseClean(fx, fx.text)
      expect('objectId' in before).toBe(false)
      for (const id of [U, builtinObjectId(fx.kind, fx.name)]) {
        const after = parseClean(fx, setShuvixIdLine(fx.text, id)!)
        expect(after.objectId, id).toBe(id)
        expect(rest(after), id).toEqual(before)
      }
    }
  )

  it.each(FIXTURES)('OI-6 $kind：CRLF 与带 BOM 的变体同样读得出', (fx) => {
    for (const [label, text] of [
      ['CRLF', fx.text.replace(/\n/g, '\r\n')],
      ['BOM', `\uFEFF${fx.text}`]
    ] as const) {
      const before = parseClean(fx, text)
      const stamped = setShuvixIdLine(text, U)
      expect(stamped, label).not.toBeNull()
      const after = parseClean(fx, stamped!)
      expect(after.objectId, label).toBe(U)
      expect(rest(after), label).toEqual(before)
    }
  })

  it.each(FIXTURES)('OI-7 $kind：大写 UUID → 读成小写', (fx) => {
    expect(parseClean(fx, setShuvixIdLine(fx.text, U.toUpperCase())!).objectId).toBe(U)
  })
})

describe('OI-8 序列化器与行写入器写出同一份文本', () => {
  const agent: ParsedAgentFile = {
    name: 'a1',
    displayName: 'Agent One',
    description: 'does things',
    systemPrompt: 'Body.',
    tools: ['read', 'grep'],
    model: 'openai/gpt-5',
    thinkingLevel: 'low',
    instructionFiles: ['AGENTS.md'],
    projectAwareness: true
  }
  const bot = { name: 'b1', displayName: 'Bot One', description: 'd', body: 'Persona.' }
  const policy: ParsedPolicyFile = {
    name: 'p1',
    displayName: 'Policy One',
    description: 'd',
    rules: [{ effect: 'ask', conditions: { 'subject.kind': ['agent'] } }],
    body: 'Rationale.'
  }

  const cases: Array<[MdObjectKind, (objectId: string | undefined) => string]> = [
    ['agent', (objectId) => serializeAgentDefinitionFile({ ...agent, objectId })],
    ['bot', (objectId) => serializeBotDefinitionFile({ ...bot, objectId })],
    ['policy', (objectId) => serializePolicyDefinitionFile({ ...policy, objectId })]
  ]

  it.each(cases)(
    'OI-8 %s：serialize({objectId}) === setShuvixIdLine(serialize(无 id), id)',
    (kind, ser) => {
      for (const id of [U, builtinObjectId(kind, `${kind[0]}1`)]) {
        expect(ser(id), id).toBe(setShuvixIdLine(ser(undefined), id))
      }
    }
  )
})

describe('OI-9 三族内置 md 的对象 id 总览', () => {
  it('OI-9 每份 × 每门语言都有合法的内置 id，kind = 所在族、name = spec 名；三语同 id，全体两两不同', () => {
    const LANGS = ['en', 'zh', 'ja'] as const
    const fileOf = (name: string, lang: string): string =>
      lang === 'en' ? `${name}.md` : `${name}.${lang}.md`
    const families: Array<
      [MdObjectKind, readonly { name: string }[], (f: string) => string | null]
    > = [
      ['agent', BUILTIN_PROFILE_SPECS, createInlineMdReader()],
      ['hook', BUILTIN_HOOK_SPECS, createInlineHookMdReader()],
      ['policy', BUILTIN_POLICY_SPECS, createInlinePolicyMdReader()]
    ]

    let files = 0
    const ids = new Set<string>()
    for (const [kind, specs, readMd] of families) {
      for (const { name } of specs) {
        for (const lang of LANGS) {
          const what = `${kind} ${name}.${lang}`
          const raw = readMd(fileOf(name, lang))
          expect(raw, what).not.toBeNull()
          files++
          const values = [...raw!.matchAll(/^shuvix-id: (.+)$/gm)].map((m) => m[1])
          expect(values, what).toHaveLength(1)
          const parsed = parseObjectId(values[0])
          expect(parsed, what).toEqual({
            id: builtinObjectId(kind, name),
            form: 'builtin',
            kind,
            name
          })
          ids.add(parsed!.id)
        }
      }
    }
    const specCount = families.reduce((n, [, specs]) => n + specs.length, 0)
    expect(files).toBe(specCount * LANGS.length)
    expect(ids.size).toBe(specCount)
    // 今天的盘点：十二份 agent + 两份 hook + 两份策略 —— 名单变了就该有人看一眼这里
    expect([files, ids.size]).toEqual([48, 16])
  })
})
