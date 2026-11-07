/**
 * 系统提示词的段落扩展：选择矩阵、文本规则（修剪 / 跳过 / 围栏），以及经真实 durable 请求看到的行为。
 *
 * PS-11..26 走的是**没有冻结段落**的那条路（`AgentStateDoc.sections` 不存在：2026-11-06 之前的旧对话、派生
 * agent）—— `lockPrompt` 只冻结人设：活段落每次请求现解析、变了才发 `pi.system` 增量、未选中的段落不调 seam、
 * seam 抛错保留上次的文本。
 *
 * 冻结的段落（2026-11-06，「历史状态不变」，见末尾的 describe）：
 *   SEC-1  sectionKeyOf：六个扩展名 → 段落 key，别的名字抛错
 *   SEC-2  renderSections：只渲染要的那几段、跳过人设、缺席 → null、脱敏说明只在宿主做脱敏时有；段落次序与
 *          chat-protocol 的 SYSTEM_PROMPT_SECTION_ORDER 一致
 *   SEC-2b 某段的 seam 抛错 → 那一段不进结果、onError(key, error)，其余照常；没给 onError 静默跳过
 *   SEC-4  bot seam 只在 compare 时收到 { compare: true }
 *   SEC-5  文档里冻结了段落 → 请求 = 人设 + 存着的文本，请求时不调 seam；来源变了也没有 pi.system 增量
 *   SEC-6  存着的 null 照样缺席，seam 不调
 *   SEC-7  [WB] 有 sections 却缺某个选中的 key → 那一段照旧现解析
 *   SEC-8  noteSectionsCurrent：[] 不转告；宿主没实现不抛；否则原样转告一次
 * （SEC-3 —— 每份黄金 fixture 的 renderSections 与 fixture 的段落逐字相同 —— 在 promptSections.golden.test.ts）
 */
import { getCurrentSystemPrompt, Type } from '@earendil-works/pi-ai'
import {
  defineTool,
  SystemEntry,
  type Conversation,
  type EntryRecord
} from '@earendil-works/pi-durable'
import { SYSTEM_PROMPT_SECTION_ORDER } from '@shuvix/chat-protocol/systemPromptStatus'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { fenceInstructionFile, fenceKnowledgeBases, fenceProjectPrompt } from '../prompt/fences'
import { computeFrozenAgentPrompt, freezePersona, freezeSections } from '../prompt/persona'
import {
  botSectionText,
  createPromptExtensions,
  fencedSectionText,
  instructionSectionText,
  PROMPT_EXTENSION,
  PROMPT_EXTENSION_ORDER,
  PROMPT_SECTION_KEY,
  promptExtensionsFor,
  sectionKeyOf,
  type PromptSelectionSpec
} from '../prompt/sections'
import type { PromptHost } from '../seams'
import { answer, callTool } from './support/faux'
import { makeHost, registerHostCleanup, type TestHost } from './support/host'
import { frozenPrompt, lockPrompt, markLocked, systemMessages } from './support/prompt'
import { toolsExtension } from './support/tools'
import { allEntries } from './support/transcript'

registerHostCleanup()

const P = PROMPT_EXTENSION
const K = PROMPT_SECTION_KEY

function spec(overrides: {
  kind?: 'root' | 'spawned'
  name?: string
  instructionFiles?: readonly string[]
  projectAwareness?: boolean
  toolNames?: readonly string[]
}): PromptSelectionSpec {
  return {
    kind: overrides.kind ?? 'root',
    profile: {
      name: overrides.name ?? 'work',
      instructionFiles: overrides.instructionFiles ?? [],
      projectAwareness: overrides.projectAwareness ?? false
    },
    toolNames: overrides.toolNames ?? []
  }
}

describe('selection matrix (promptExtensionsFor)', () => {
  it('PS-01 persona is always selected, alone when nothing else applies', () => {
    expect(promptExtensionsFor(spec({}))).toEqual([P.persona])
    expect(promptExtensionsFor(spec({ kind: 'spawned' }))).toEqual([P.persona])
  })

  it('PS-02 instructions iff the profile declares instruction files', () => {
    expect(promptExtensionsFor(spec({ instructionFiles: ['AGENTS.md'] }))).toEqual([
      P.persona,
      P.instructions
    ])
    expect(promptExtensionsFor(spec({ instructionFiles: [] }))).not.toContain(P.instructions)
    const undeclared: PromptSelectionSpec = {
      kind: 'root',
      profile: { name: 'work' },
      toolNames: []
    }
    expect(promptExtensionsFor(undeclared)).toEqual([P.persona])
  })

  it('PS-03 project awareness selects the project prompt', () => {
    expect(promptExtensionsFor(spec({ projectAwareness: true }))).toEqual([
      P.persona,
      P.projectPrompt
    ])
  })

  it('PS-04 knowledge iff the tool list carries `knowledge`, independent of project awareness', () => {
    expect(promptExtensionsFor(spec({ toolNames: ['read', 'knowledge'] }))).toEqual([
      P.persona,
      P.knowledge
    ])
    expect(
      promptExtensionsFor(spec({ projectAwareness: true, toolNames: ['read', 'bash'] }))
    ).not.toContain(P.knowledge)
    expect(promptExtensionsFor(spec({ toolNames: ['mcp:knowledge', 'knowledges'] }))).toEqual([
      P.persona
    ])
  })

  it('PS-05 bot iff a root agent on the bot profile', () => {
    expect(promptExtensionsFor(spec({ name: 'bot' }))).toEqual([P.persona, P.bot])
    expect(promptExtensionsFor(spec({ name: 'bot', kind: 'spawned' }))).not.toContain(P.bot)
    expect(promptExtensionsFor(spec({ name: 'work' }))).not.toContain(P.bot)
  })

  it('PS-06 everything selected comes out in the fixed order', () => {
    const all = promptExtensionsFor({
      ...spec({
        name: 'bot',
        instructionFiles: ['CLAUDE.md'],
        projectAwareness: true,
        toolNames: ['knowledge']
      }),
      placeholders: true
    })
    expect(all).toEqual([...PROMPT_EXTENSION_ORDER])
    expect(PROMPT_EXTENSION_ORDER).toEqual([
      'shuvix.prompt.persona',
      'shuvix.prompt.placeholders',
      'shuvix.prompt.instructions',
      'shuvix.prompt.project-prompt',
      'shuvix.prompt.knowledge',
      'shuvix.prompt.bot'
    ])
  })

  it('PS-07 the extension set: six extensions with one untagged section each, select() = names', () => {
    const prompt = createPromptExtensions({})
    expect(prompt.all.map((extension) => extension.name)).toEqual([...PROMPT_EXTENSION_ORDER])
    for (const extension of prompt.all) {
      expect(extension.sections).toHaveLength(1)
      expect(extension.sections![0]!.tag).toBe(false)
      expect(extension.tools ?? []).toEqual([])
    }
    expect(prompt.all.map((extension) => extension.sections![0]!.key)).toEqual([
      'persona',
      'placeholders',
      'project_instructions',
      'project_prompt',
      'knowledge_bases',
      'bot_profile'
    ])
    const s = spec({ projectAwareness: true, toolNames: ['knowledge'] })
    expect(prompt.select(s).map((extension) => extension.name)).toEqual(promptExtensionsFor(s))
    expect(prompt.get(P.knowledge)).toBe(prompt.all[4])
    // 自动脱敏那一段只在宿主做脱敏时选中
    expect(prompt.select(s).map((extension) => extension.name)).not.toContain(P.placeholders)
    expect(
      createPromptExtensions({}, { placeholders: true })
        .select(s)
        .map((extension) => extension.name)
    ).toEqual([P.persona, P.placeholders, P.projectPrompt, P.knowledge])
  })
})

describe('text rules', () => {
  it('PS-08 instruction content is trimmed inside the fence; empty / whitespace / null → absent', () => {
    expect(instructionSectionText({ filename: 'AGENTS.md', content: '\n  # A\n\nx\n\n' })).toBe(
      fenceInstructionFile('AGENTS.md', '# A\n\nx')
    )
    expect(instructionSectionText({ filename: 'AGENTS.md', content: ' \n\t ' })).toBeUndefined()
    expect(instructionSectionText({ filename: 'AGENTS.md', content: '' })).toBeUndefined()
    expect(instructionSectionText(null)).toBeUndefined()
    expect(instructionSectionText(undefined)).toBeUndefined()
  })

  it('PS-09 single-text sections trim and fence; whitespace / null / undefined → absent', () => {
    expect(fencedSectionText('  hello\n', fenceProjectPrompt)).toBe(
      '<project_prompt>\nhello\n</project_prompt>'
    )
    expect(fencedSectionText('\n\t\n', fenceKnowledgeBases)).toBeUndefined()
    expect(fencedSectionText(null, fenceProjectPrompt)).toBeUndefined()
    expect(fencedSectionText(undefined, fenceProjectPrompt)).toBeUndefined()
  })

  it('PS-10 bot blocks: each trimmed, blank ones skipped, joined by a blank line', () => {
    expect(botSectionText('  <bot_profile>x</bot_profile>\n')).toBe('<bot_profile>x</bot_profile>')
    expect(botSectionText([' a ', '  \n ', 'b'])).toBe('a\n\nb')
    expect(botSectionText(['  ', ''])).toBeUndefined()
    expect(botSectionText('')).toBeUndefined()
    expect(botSectionText(null)).toBeUndefined()
    expect(botSectionText(undefined)).toBeUndefined()
  })
})

// ─────────────────────────── 经真实请求 ───────────────────────────

interface LiveHost {
  host: PromptHost
  values: {
    instruction: { filename: string; content: string } | null
    projectPrompt: string | null
    knowledge: string | null
    bot: string | null
  }
  calls: string[]
  fail: Set<string>
}

/** 内容可变、记录调用、可按名抛错的宿主 */
function liveHost(): LiveHost {
  const values: LiveHost['values'] = {
    instruction: { filename: 'AGENTS.md', content: 'Use pnpm.' },
    projectPrompt: 'Acme billing.',
    knowledge: 'Bases: notes.',
    bot: 'You are Aria.\n\n<bot_profile name="aria" file="/b/aria.md">\nlikes tea\n</bot_profile>'
  }
  const calls: string[] = []
  const fail = new Set<string>()
  const seam =
    <T>(name: string, value: () => T) =>
    (sessionId: string): T => {
      calls.push(`${name}:${sessionId}`)
      if (fail.has(name)) throw new Error(`${name} exploded`)
      return value()
    }
  const host: PromptHost = {
    resolveInstruction: (sessionId, cwd, candidates) => {
      calls.push(`instruction:${sessionId}:${cwd}:${candidates.join(',')}`)
      if (fail.has('instruction')) throw new Error('instruction exploded')
      return values.instruction
    },
    resolveProjectPrompt: seam('projectPrompt', () => values.projectPrompt),
    resolveKnowledgeBases: seam('knowledge', () => values.knowledge),
    resolveBotContext: seam('bot', () => values.bot)
  }
  return { host, values, calls, fail }
}

const BOT_SPEC = spec({
  name: 'bot',
  instructionFiles: ['AGENTS.md', 'CLAUDE.md'],
  projectAwareness: true,
  toolNames: ['knowledge']
})

async function setup(
  selection: PromptSelectionSpec = BOT_SPEC,
  options: { persona?: string; cwd?: string } = {}
): Promise<{
  t: TestHost
  live: LiveHost
  session: DurableSession
  conversation: Conversation
}> {
  const live = liveHost()
  const t = await makeHost({ promptHost: live.host })
  const prompt = createPromptExtensions(live.host)
  const session = await t.open()
  const conversation = await session.currentConversation()
  await lockPrompt(
    conversation,
    t.kit,
    frozenPrompt({
      persona: options.persona ?? '## Persona\n\nDate: 2026-10-04',
      instructionFiles: [...(selection.profile.instructionFiles ?? [])],
      profileName: selection.profile.name,
      kind: selection.kind
    }),
    prompt.select(selection),
    options.cwd ?? '/work/acme'
  )
  return { t, live, session, conversation }
}

async function systemEntries(conversation: Conversation): Promise<EntryRecord[]> {
  return (await allEntries(conversation)).filter((entry) => SystemEntry.is(entry))
}

function sectionsOf(entry: EntryRecord): Record<string, string | null> | undefined {
  const message = entry.model?.[0]
  return message?.role === 'system' ? message.sections : undefined
}

async function turn(t: TestHost, session: DurableSession, text: string): Promise<void> {
  t.kit.queue(answer(`re:${text}`))
  expect(await session.submitUser(text)).toEqual({})
}

describe('sections through a real durable request', () => {
  it('PS-11 first request: one pi.system baseline with every selected section in order, seams called with the frozen root session id and the agent cwd', async () => {
    const { t, live, session, conversation } = await setup()
    await turn(t, session, 'u1')
    const entries = await systemEntries(conversation)
    expect(entries).toHaveLength(1)
    expect(Object.keys(sectionsOf(entries[0]!) ?? {})).toEqual([
      K.persona,
      K.instructions,
      K.projectPrompt,
      K.knowledge,
      K.bot
    ])
    expect(getCurrentSystemPrompt(t.kit.requests[0]!.messages)).toBe(
      [
        '## Persona\n\nDate: 2026-10-04',
        fenceInstructionFile('AGENTS.md', 'Use pnpm.'),
        fenceProjectPrompt('Acme billing.'),
        fenceKnowledgeBases('Bases: notes.'),
        live.values.bot
      ].join('\n\n')
    )
    expect(live.calls).toEqual([
      'instruction:s1:/work/acme:AGENTS.md,CLAUDE.md',
      'projectPrompt:s1',
      'knowledge:s1',
      'bot:s1'
    ])
  })

  it('PS-12 nothing changed → the next request writes no pi.system entry; the seams are still consulted', async () => {
    const { t, live, session, conversation } = await setup()
    await turn(t, session, 'u1')
    live.calls.length = 0
    await turn(t, session, 'u2')
    expect(await systemEntries(conversation)).toHaveLength(1)
    expect(live.calls).toHaveLength(4)
    expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).toBe(
      getCurrentSystemPrompt(t.kit.requests[0]!.messages)
    )
  })

  it('PS-13 a live change produces a pi.system delta carrying only that section', async () => {
    const { t, live, session, conversation } = await setup()
    await turn(t, session, 'u1')
    live.values.projectPrompt = 'Acme billing, v2.'
    await turn(t, session, 'u2')
    const entries = await systemEntries(conversation)
    expect(entries).toHaveLength(2)
    expect(sectionsOf(entries[1]!)).toEqual({
      [K.projectPrompt]: fenceProjectPrompt('Acme billing, v2.')
    })
    expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).toContain(
      '<project_prompt>\nAcme billing, v2.\n</project_prompt>'
    )
  })

  it('PS-14 a live section that disappears is removed by a null patch; reappearing re-adds it in order', async () => {
    const { t, live, session, conversation } = await setup()
    await turn(t, session, 'u1')
    live.values.knowledge = '   '
    await turn(t, session, 'u2')
    let entries = await systemEntries(conversation)
    expect(sectionsOf(entries[1]!)).toEqual({ [K.knowledge]: null })
    expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).not.toContain('<knowledge_bases>')
    live.values.knowledge = 'Bases: notes, recipes.'
    await turn(t, session, 'u3')
    entries = await systemEntries(conversation)
    const prompt = getCurrentSystemPrompt(t.kit.requests[2]!.messages)
    expect(prompt.indexOf('<knowledge_bases>')).toBeGreaterThan(prompt.indexOf('<project_prompt>'))
    expect(prompt.indexOf('<knowledge_bases>')).toBeLessThan(prompt.indexOf('<bot_profile'))
    expect(prompt).toContain('Bases: notes, recipes.')
  })

  it('PS-15 the bot section is live: a memory edit applies on the next request', async () => {
    const { t, live, session, conversation } = await setup()
    await turn(t, session, 'u1')
    live.values.bot =
      'You are Aria.\n\n<bot_profile name="aria" file="/b/aria.md">\nlikes coffee now\n</bot_profile>'
    await turn(t, session, 'u2')
    const entries = await systemEntries(conversation)
    expect(sectionsOf(entries[1]!)).toEqual({ [K.bot]: live.values.bot })
  })

  it('PS-16 the persona is frozen: a later promptVars change does not reach the prompt (and promptVars is never consulted while rendering)', async () => {
    const live = liveHost()
    const t = await makeHost({ promptHost: live.host })
    const prompt = createPromptExtensions(live.host)
    let date = '2026-10-04'
    let promptVarsCalls = 0
    const personaHost = {
      promptVars: () => {
        promptVarsCalls++
        return { date }
      }
    }
    const profile = {
      name: 'work',
      systemPrompt: 'Today: {{shuvix:date}}.\n\n\n\nBe brief.',
      instructionFiles: [] as string[]
    }
    const frozen = await computeFrozenAgentPrompt(personaHost, {
      kind: 'root',
      sessionId: 's1',
      rootSessionId: 's1',
      cwd: '/w',
      toolNames: [],
      profile
    })
    expect(frozen.persona).toBe('Today: 2026-10-04.\n\nBe brief.')
    const session = await t.open()
    const conversation = await session.currentConversation()
    await lockPrompt(conversation, t.kit, frozen, prompt.select(spec({ projectAwareness: true })))
    await turn(t, session, 'u1')
    date = '2026-10-05'
    live.values.projectPrompt = 'Acme billing, v2.'
    await turn(t, session, 'u2')
    expect(promptVarsCalls).toBe(1)
    const second = getCurrentSystemPrompt(t.kit.requests[1]!.messages)
    expect(second.startsWith('Today: 2026-10-04.\n\nBe brief.\n\n')).toBe(true)
    const entries = await systemEntries(conversation)
    expect(entries).toHaveLength(2)
    expect(sectionsOf(entries[1]!)).toEqual({
      [K.projectPrompt]: fenceProjectPrompt('Acme billing, v2.')
    })
  })

  it('PS-17 a persona written again into the frozen document (only a rebuild does this now) is sent as a delta on the next request', async () => {
    const { t, session, conversation } = await setup()
    await turn(t, session, 'u1')
    await conversation.commit(
      (tx) =>
        freezePersona(
          tx,
          conversation.id,
          frozenPrompt({
            persona: '## Persona\n\nDate: 2026-10-06',
            profileName: 'bot',
            instructionFiles: ['AGENTS.md', 'CLAUDE.md']
          })
        ),
      BG
    )
    await turn(t, session, 'u2')
    const entries = await systemEntries(conversation)
    expect(sectionsOf(entries[1]!)).toEqual({ [K.persona]: '## Persona\n\nDate: 2026-10-06' })
  })

  it('PS-18 unselected extensions never consult their seams (selection is the gate)', async () => {
    const { t, live, session } = await setup(spec({ name: 'work' }))
    await turn(t, session, 'u1')
    expect(live.calls).toEqual([])
    expect(getCurrentSystemPrompt(t.kit.requests[0]!.messages)).toBe(
      '## Persona\n\nDate: 2026-10-04'
    )
  })

  it('PS-19 a seam that throws keeps the section it showed before and is reported; the request still goes out', async () => {
    const { t, live, session, conversation } = await setup()
    await turn(t, session, 'u1')
    live.fail.add('projectPrompt')
    live.values.projectPrompt = 'changed but unreachable'
    await turn(t, session, 'u2')
    expect(await systemEntries(conversation)).toHaveLength(1)
    expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).toContain(
      fenceProjectPrompt('Acme billing.')
    )
    expect(t.warnings.some((warning) => warning.includes('projectPrompt exploded'))).toBe(true)
  })

  it('PS-20 a seam that throws on the very first request leaves the section out', async () => {
    const live = liveHost()
    live.fail.add('knowledge')
    const t = await makeHost({ promptHost: live.host })
    const prompt = createPromptExtensions(live.host)
    const session = await t.open()
    const conversation = await session.currentConversation()
    await lockPrompt(
      conversation,
      t.kit,
      frozenPrompt({ instructionFiles: [] }),
      prompt.select(spec({ toolNames: ['knowledge'] }))
    )
    await turn(t, session, 'u1')
    expect(getCurrentSystemPrompt(t.kit.requests[0]!.messages)).toBe(
      '## Persona\n\nYou are a test agent.'
    )
    expect(t.warnings.some((warning) => warning.includes('knowledge exploded'))).toBe(true)
  })

  it('PS-21 a host without seams: only the persona renders even when everything is selected', async () => {
    const t = await makeHost()
    const prompt = createPromptExtensions({})
    const session = await t.open()
    const conversation = await session.currentConversation()
    await lockPrompt(conversation, t.kit, frozenPrompt(), prompt.all)
    await turn(t, session, 'u1')
    expect(getCurrentSystemPrompt(t.kit.requests[0]!.messages)).toBe(
      '## Persona\n\nYou are a test agent.'
    )
    expect(t.warnings).toEqual([])
  })

  it('PS-22 an empty frozen persona is omitted (no leading blank line); an unfrozen one is reported', async () => {
    const empty = await setup(spec({ projectAwareness: true }), { persona: '' })
    await turn(empty.t, empty.session, 'u1')
    expect(getCurrentSystemPrompt(empty.t.kit.requests[0]!.messages)).toBe(
      fenceProjectPrompt('Acme billing.')
    )
    expect(empty.t.warnings).toEqual([])

    const live = liveHost()
    const t = await makeHost({ promptHost: live.host })
    const prompt = createPromptExtensions(live.host)
    const session = await t.open()
    const conversation = await session.currentConversation()
    await conversation.configure(
      { model: t.kit.model, extensions: prompt.select(spec({ projectAwareness: true })) },
      BG
    )
    await markLocked(conversation, t.kit)
    await turn(t, session, 'u1')
    // 没冻结：人设报告，活段落没有根会话 id 可解析 —— 静默缺席，不调 seam
    expect(getCurrentSystemPrompt(t.kit.requests[0]!.messages)).toBe('')
    expect(live.calls).toEqual([])
    expect(t.warnings.some((warning) => warning.includes('no frozen persona'))).toBe(true)
  })

  it('PS-23 the instructions section reads the frozen file list and passes an empty cwd when the agent has none', async () => {
    const live = liveHost()
    const t = await makeHost({ promptHost: live.host })
    const prompt = createPromptExtensions(live.host)
    const session = await t.open()
    const conversation = await session.currentConversation()
    await conversation.commit(
      (tx) =>
        freezePersona(
          tx,
          conversation.id,
          frozenPrompt({ rootSessionId: 'root-of-s1', instructionFiles: ['CLAUDE.md'] })
        ),
      BG
    )
    await conversation.configure(
      {
        model: t.kit.model,
        extensions: prompt.select(spec({ instructionFiles: ['CLAUDE.md'] }))
      },
      BG
    )
    await markLocked(conversation, t.kit)
    await turn(t, session, 'u1')
    expect(live.calls).toEqual(['instruction:root-of-s1::CLAUDE.md'])
    const state = await session.harness.snapshot(AgentStateDoc, conversation.id, BG)
    expect(state).toMatchObject({ rootSessionId: 'root-of-s1', instructionFiles: ['CLAUDE.md'] })
  })

  it('PS-25 seams are consulted before every request of a run; a change between tool rounds lands as a mid-run delta', async () => {
    const live = liveHost()
    const flip = defineTool({
      name: 'flip',
      description: 'changes the instruction file',
      parameters: Type.Object({}),
      execute: async () => {
        live.values.instruction = { filename: 'AGENTS.md', content: 'Use npm.' }
        return { output: [{ type: 'text', text: 'flipped' }] }
      }
    })
    const t = await makeHost({ promptHost: live.host })
    const prompt = createPromptExtensions(live.host)
    const tools = toolsExtension([flip])
    const session = await t.open()
    t.registryOf('s1')!.install(tools)
    const conversation = await session.currentConversation()
    await lockPrompt(conversation, t.kit, frozenPrompt(), [
      ...prompt.select(spec({ instructionFiles: ['AGENTS.md'] })),
      tools
    ])
    t.kit.queue(callTool('flip'), answer('done'))
    expect(await session.submitUser('go')).toEqual({})
    expect(live.calls.filter((call) => call.startsWith('instruction:'))).toHaveLength(2)
    const kinds = (await allEntries(conversation)).map((entry) => entry.kind)
    expect(kinds).toEqual([
      'pi.user',
      'pi.system',
      'pi.assistant',
      'pi.tool-result',
      'pi.system',
      'pi.assistant'
    ])
    const entries = await systemEntries(conversation)
    expect(sectionsOf(entries[1]!)).toEqual({
      [K.instructions]: fenceInstructionFile('AGENTS.md', 'Use npm.')
    })
    expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).toContain('Use npm.')
  })

  it('PS-26 two sessions (each with its own registry, K1) share one prompt host: each resolves against its own frozen root session id', async () => {
    const calls: string[] = []
    const promptHost = {
      resolveProjectPrompt: (sessionId: string) => {
        calls.push(sessionId)
        return `Project of ${sessionId}.`
      }
    }
    const t = await makeHost({ promptHost })
    const prompt = createPromptExtensions(promptHost)
    for (const id of ['s1', 's2']) {
      const session = await t.open(id)
      const conversation = await session.currentConversation()
      await lockPrompt(
        conversation,
        t.kit,
        frozenPrompt({ rootSessionId: id, instructionFiles: [] }),
        prompt.select(spec({ projectAwareness: true }))
      )
      await turn(t, session, `hi from ${id}`)
    }
    expect(calls).toEqual(['s1', 's2'])
    expect(getCurrentSystemPrompt(t.kit.requests[0]!.messages)).toContain('Project of s1.')
    expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).toContain('Project of s2.')
    expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).not.toContain('s1')
  })

  it('PS-24 the request carries exactly one leading system message whose content is empty (sections only)', async () => {
    const { t, session } = await setup()
    await turn(t, session, 'u1')
    const system = systemMessages(t.kit.requests[0]!.messages)
    expect(system).toHaveLength(1)
    expect(system[0]!.content).toBe('')
  })
})

// ─────────────────────────── 冻结的段落（2026-11-06） ───────────────────────────

/** 冻结进当前对话的段落（不经锁：段落用例自己写文档） */
async function freezeInto(
  conversation: Conversation,
  sections: Record<string, string | null>
): Promise<void> {
  await conversation.commit((tx) => freezeSections(tx, conversation.id, sections), BG)
}

describe('frozen sections (AgentStateDoc.sections)', () => {
  it('SEC-1 sectionKeyOf maps the six extension names to their section keys and throws for anything else', () => {
    expect(PROMPT_EXTENSION_ORDER.map(sectionKeyOf)).toEqual([
      'persona',
      'placeholders',
      'project_instructions',
      'project_prompt',
      'knowledge_bases',
      'bot_profile'
    ])
    for (const id of Object.keys(P) as (keyof typeof P)[]) {
      expect(sectionKeyOf(P[id])).toBe(K[id])
    }
    expect(() => sectionKeyOf('shuvix.builtin' as never)).toThrow(/Not a prompt extension/)
    expect(() => sectionKeyOf('persona' as never)).toThrow(/Not a prompt extension/)
  })

  it('SEC-2 renderSections renders only the requested names, skips the persona, gives null for an absent section, and the placeholders note only with the host option; the order matches SYSTEM_PROMPT_SECTION_ORDER', async () => {
    expect(PROMPT_EXTENSION_ORDER.map(sectionKeyOf)).toEqual([...SYSTEM_PROMPT_SECTION_ORDER])
    const live = liveHost()
    const prompt = createPromptExtensions(live.host)
    const input = { rootSessionId: 's9', cwd: '/w', instructionFiles: ['AGENTS.md'] }

    expect(await prompt.renderSections({ ...input, names: [P.persona, P.projectPrompt] })).toEqual({
      [K.projectPrompt]: fenceProjectPrompt('Acme billing.')
    })
    expect(live.calls).toEqual(['projectPrompt:s9'])

    live.calls.length = 0
    live.values.knowledge = '   '
    const all = await prompt.renderSections({ ...input, names: PROMPT_EXTENSION_ORDER })
    expect(all).toEqual({
      [K.placeholders]: null,
      [K.instructions]: fenceInstructionFile('AGENTS.md', 'Use pnpm.'),
      [K.projectPrompt]: fenceProjectPrompt('Acme billing.'),
      [K.knowledge]: null,
      [K.bot]: live.values.bot
    })
    expect(Object.keys(all)).not.toContain(K.persona)
    expect(live.calls).toEqual([
      'instruction:s9:/w:AGENTS.md',
      'projectPrompt:s9',
      'knowledge:s9',
      'bot:s9'
    ])

    // 没有指令文件清单 → 缺席，不调 seam
    live.calls.length = 0
    expect(
      await prompt.renderSections({ ...input, instructionFiles: [], names: [P.instructions] })
    ).toEqual({ [K.instructions]: null })
    expect(live.calls).toEqual([])

    // 宿主做自动脱敏：说明文本固定
    const withPlaceholders = createPromptExtensions(live.host, { placeholders: true })
    const placeholders = await withPlaceholders.renderSections({
      ...input,
      names: [P.placeholders]
    })
    expect(placeholders[K.placeholders]).toMatch(/^<placeholders>\n[\s\S]+\n<\/placeholders>$/)
  })

  it('SEC-2b a throwing seam leaves its key out and is reported through onError(key, error); the other sections still render; without onError it is skipped silently', async () => {
    const live = liveHost()
    live.fail.add('knowledge')
    const prompt = createPromptExtensions(live.host)
    const errors: [string, unknown][] = []
    const out = await prompt.renderSections({
      names: [P.projectPrompt, P.knowledge, P.bot],
      rootSessionId: 's1',
      cwd: '',
      instructionFiles: [],
      onError: (key, error) => errors.push([key, error])
    })
    expect(out).toEqual({
      [K.projectPrompt]: fenceProjectPrompt('Acme billing.'),
      [K.bot]: live.values.bot
    })
    expect(Object.prototype.hasOwnProperty.call(out, K.knowledge)).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]![0]).toBe(K.knowledge)
    expect((errors[0]![1] as Error).message).toBe('knowledge exploded')

    const silent = await prompt.renderSections({
      names: [P.knowledge, P.projectPrompt],
      rootSessionId: 's1',
      cwd: '',
      instructionFiles: []
    })
    expect(silent).toEqual({ [K.projectPrompt]: fenceProjectPrompt('Acme billing.') })
  })

  it('SEC-4 the bot seam gets { compare: true } only when the render is a comparison', async () => {
    const seen: unknown[][] = []
    const prompt = createPromptExtensions({
      resolveBotContext: (...args: unknown[]) => {
        seen.push(args)
        return 'You are Aria.'
      }
    })
    const base = { names: [P.bot], rootSessionId: 's1', cwd: '', instructionFiles: [] }
    await prompt.renderSections(base)
    await prompt.renderSections({ ...base, compare: false })
    await prompt.renderSections({ ...base, compare: true })
    expect(seen).toEqual([
      ['s1', undefined],
      ['s1', undefined],
      ['s1', { compare: true }]
    ])
  })

  it('SEC-5 a frozen document: the request is the persona plus the stored texts, no seam is called while requesting, and a source change sends no pi.system delta', async () => {
    const { t, live, session, conversation } = await setup()
    await freezeInto(conversation, {
      [K.instructions]: fenceInstructionFile('AGENTS.md', 'Frozen rule.'),
      [K.projectPrompt]: fenceProjectPrompt('Frozen project.'),
      [K.knowledge]: fenceKnowledgeBases('Frozen bases.'),
      [K.bot]: 'Frozen bot.'
    })
    await turn(t, session, 'u1')
    const first = getCurrentSystemPrompt(t.kit.requests[0]!.messages)
    expect(first).toBe(
      [
        '## Persona\n\nDate: 2026-10-04',
        fenceInstructionFile('AGENTS.md', 'Frozen rule.'),
        fenceProjectPrompt('Frozen project.'),
        fenceKnowledgeBases('Frozen bases.'),
        'Frozen bot.'
      ].join('\n\n')
    )
    expect(live.calls).toEqual([])

    live.values.projectPrompt = 'Changed project.'
    live.values.instruction = { filename: 'CLAUDE.md', content: 'Changed rule.' }
    live.values.bot = 'Changed bot.'
    await turn(t, session, 'u2')
    expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).toBe(first)
    expect(live.calls).toEqual([])
    expect(await systemEntries(conversation)).toHaveLength(1)
  })

  it('SEC-6 a stored null stays absent and its seam is never called', async () => {
    const { t, live, session, conversation } = await setup(
      spec({ projectAwareness: true, toolNames: ['knowledge'] })
    )
    await freezeInto(conversation, {
      [K.projectPrompt]: null,
      [K.knowledge]: fenceKnowledgeBases('KB.')
    })
    await turn(t, session, 'u1')
    expect(getCurrentSystemPrompt(t.kit.requests[0]!.messages)).toBe(
      ['## Persona\n\nDate: 2026-10-04', fenceKnowledgeBases('KB.')].join('\n\n')
    )
    expect(live.calls).toEqual([])
  })

  it('SEC-7 [WB] sections present but without a selected key: that section resolves live (the other ones stay frozen)', async () => {
    const { t, live, session, conversation } = await setup(
      spec({ projectAwareness: true, toolNames: ['knowledge'] })
    )
    await freezeInto(conversation, { [K.knowledge]: fenceKnowledgeBases('Frozen KB.') })
    await turn(t, session, 'u1')
    expect(getCurrentSystemPrompt(t.kit.requests[0]!.messages)).toBe(
      [
        '## Persona\n\nDate: 2026-10-04',
        fenceProjectPrompt('Acme billing.'),
        fenceKnowledgeBases('Frozen KB.')
      ].join('\n\n')
    )
    expect(live.calls).toEqual(['projectPrompt:s1'])
    live.values.projectPrompt = 'Acme billing, v2.'
    await turn(t, session, 'u2')
    const entries = await systemEntries(conversation)
    expect(sectionsOf(entries[1]!)).toEqual({
      [K.projectPrompt]: fenceProjectPrompt('Acme billing, v2.')
    })
  })

  it('SEC-8 noteSectionsCurrent: an empty list is not forwarded; a host without the method does not throw; otherwise forwarded once, verbatim', () => {
    const notes: [string, readonly string[]][] = []
    const prompt = createPromptExtensions({
      noteSectionsCurrent: (sessionId, keys) => notes.push([sessionId, keys])
    })
    prompt.noteSectionsCurrent('s1', [])
    expect(notes).toEqual([])
    const keys = [K.projectPrompt, K.bot]
    prompt.noteSectionsCurrent('s1', keys)
    expect(notes).toEqual([['s1', keys]])
    expect(notes[0]![1]).toBe(keys)
    expect(() => createPromptExtensions({}).noteSectionsCurrent('s1', [K.bot])).not.toThrow()
  })
})
