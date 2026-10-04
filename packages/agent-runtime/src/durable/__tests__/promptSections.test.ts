/**
 * 系统提示词的六个段落扩展：选择矩阵、文本规则（修剪 / 跳过 / 围栏），以及经真实 durable 请求看到的
 * 行为 —— 人设冻结、活段落变了才发 `pi.system` 增量、未选中的段落不调 seam、seam 抛错保留上次的文本。
 */
import { getCurrentSystemPrompt, Type } from '@earendil-works/pi-ai'
import {
  defineTool,
  SystemEntry,
  type Conversation,
  type EntryRecord
} from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import {
  fenceInstructionFile,
  fenceKnowledgeBases,
  fenceProjectMemory,
  fenceProjectPrompt
} from '../prompt/fences'
import { computeFrozenAgentPrompt, freezePersona } from '../prompt/persona'
import {
  botSectionText,
  createPromptExtensions,
  fencedSectionText,
  instructionSectionText,
  PROMPT_EXTENSION,
  PROMPT_EXTENSION_ORDER,
  PROMPT_SECTION_KEY,
  promptExtensionsFor,
  type PromptSelectionSpec
} from '../prompt/sections'
import type { PromptHost } from '../seams'
import { answer, callTool } from './support/faux'
import { makeHost, registerHostCleanup, type TestHost } from './support/host'
import { frozenPrompt, lockPrompt, systemMessages } from './support/prompt'
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

  it('PS-03 project prompt and memory travel together on project awareness', () => {
    expect(promptExtensionsFor(spec({ projectAwareness: true }))).toEqual([
      P.persona,
      P.projectPrompt,
      P.memory
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
    const all = promptExtensionsFor(
      spec({
        name: 'bot',
        instructionFiles: ['CLAUDE.md'],
        projectAwareness: true,
        toolNames: ['knowledge']
      })
    )
    expect(all).toEqual([...PROMPT_EXTENSION_ORDER])
    expect(PROMPT_EXTENSION_ORDER).toEqual([
      'shuvix.prompt.persona',
      'shuvix.prompt.instructions',
      'shuvix.prompt.project-prompt',
      'shuvix.prompt.knowledge',
      'shuvix.prompt.memory',
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
      'project_instructions',
      'project_prompt',
      'knowledge_bases',
      'project_memory',
      'bot_profile'
    ])
    const s = spec({ projectAwareness: true, toolNames: ['knowledge'] })
    expect(prompt.select(s).map((extension) => extension.name)).toEqual(promptExtensionsFor(s))
    expect(prompt.get(P.memory)).toBe(prompt.all[4])
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
    expect(fencedSectionText(null, fenceProjectMemory)).toBeUndefined()
    expect(fencedSectionText(undefined, fenceProjectMemory)).toBeUndefined()
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
    memory: string | null
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
    memory: 'Never deploy on Fridays.',
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
    resolveProjectMemory: seam('memory', () => values.memory),
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
  const t = await makeHost()
  const live = liveHost()
  const prompt = createPromptExtensions(live.host)
  for (const extension of prompt.all) t.registry.install(extension)
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
      K.memory,
      K.bot
    ])
    expect(getCurrentSystemPrompt(t.kit.requests[0]!.messages)).toBe(
      [
        '## Persona\n\nDate: 2026-10-04',
        fenceInstructionFile('AGENTS.md', 'Use pnpm.'),
        fenceProjectPrompt('Acme billing.'),
        fenceKnowledgeBases('Bases: notes.'),
        fenceProjectMemory('Never deploy on Fridays.'),
        live.values.bot
      ].join('\n\n')
    )
    expect(live.calls).toEqual([
      'instruction:s1:/work/acme:AGENTS.md,CLAUDE.md',
      'projectPrompt:s1',
      'knowledge:s1',
      'memory:s1',
      'bot:s1'
    ])
  })

  it('PS-12 nothing changed → the next request writes no pi.system entry; the seams are still consulted', async () => {
    const { t, live, session, conversation } = await setup()
    await turn(t, session, 'u1')
    live.calls.length = 0
    await turn(t, session, 'u2')
    expect(await systemEntries(conversation)).toHaveLength(1)
    expect(live.calls).toHaveLength(5)
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
    expect(prompt.indexOf('<knowledge_bases>')).toBeLessThan(prompt.indexOf('<project_memory>'))
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
    const t = await makeHost()
    const live = liveHost()
    const prompt = createPromptExtensions(live.host)
    for (const extension of prompt.all) t.registry.install(extension)
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
    live.values.memory = 'Fridays are fine now.'
    await turn(t, session, 'u2')
    expect(promptVarsCalls).toBe(1)
    const second = getCurrentSystemPrompt(t.kit.requests[1]!.messages)
    expect(second.startsWith('Today: 2026-10-04.\n\nBe brief.\n\n')).toBe(true)
    const entries = await systemEntries(conversation)
    expect(entries).toHaveLength(2)
    expect(sectionsOf(entries[1]!)).toEqual({
      [K.memory]: fenceProjectMemory('Fridays are fine now.')
    })
  })

  it('PS-17 re-freezing the persona (agent destroyed and created again) sends it as a delta on the next request', async () => {
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
    live.fail.add('memory')
    live.values.memory = 'changed but unreachable'
    await turn(t, session, 'u2')
    expect(await systemEntries(conversation)).toHaveLength(1)
    expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).toContain(
      fenceProjectMemory('Never deploy on Fridays.')
    )
    expect(t.warnings.some((warning) => warning.includes('memory exploded'))).toBe(true)
  })

  it('PS-20 a seam that throws on the very first request leaves the section out', async () => {
    const t = await makeHost()
    const live = liveHost()
    live.fail.add('knowledge')
    const prompt = createPromptExtensions(live.host)
    for (const extension of prompt.all) t.registry.install(extension)
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
    for (const extension of prompt.all) t.registry.install(extension)
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
      [fenceProjectPrompt('Acme billing.'), fenceProjectMemory('Never deploy on Fridays.')].join(
        '\n\n'
      )
    )
    expect(empty.t.warnings).toEqual([])

    const t = await makeHost()
    const live = liveHost()
    const prompt = createPromptExtensions(live.host)
    for (const extension of prompt.all) t.registry.install(extension)
    const session = await t.open()
    const conversation = await session.currentConversation()
    await conversation.configure(
      { model: t.kit.model, extensions: prompt.select(spec({ projectAwareness: true })) },
      BG
    )
    await turn(t, session, 'u1')
    // 没冻结：人设报告，活段落没有根会话 id 可解析 —— 静默缺席，不调 seam
    expect(getCurrentSystemPrompt(t.kit.requests[0]!.messages)).toBe('')
    expect(live.calls).toEqual([])
    expect(t.warnings.some((warning) => warning.includes('no frozen persona'))).toBe(true)
  })

  it('PS-23 the instructions section reads the frozen file list and passes an empty cwd when the agent has none', async () => {
    const t = await makeHost()
    const live = liveHost()
    const prompt = createPromptExtensions(live.host)
    for (const extension of prompt.all) t.registry.install(extension)
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
        return { content: [{ type: 'text', text: 'flipped' }] }
      }
    })
    const t = await makeHost()
    const prompt = createPromptExtensions(live.host)
    for (const extension of prompt.all) t.registry.install(extension)
    const tools = toolsExtension([flip])
    t.registry.install(tools)
    const session = await t.open()
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

  it('PS-26 two sessions share one registry: each resolves against its own frozen root session id', async () => {
    const t = await makeHost()
    const calls: string[] = []
    const prompt = createPromptExtensions({
      resolveProjectPrompt: (sessionId) => {
        calls.push(sessionId)
        return `Project of ${sessionId}.`
      }
    })
    for (const extension of prompt.all) t.registry.install(extension)
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
