/**
 * 人设冻结（P1-08）：创建 agent 时现算一次变量表、渲染档案正文（`renderProfileSystemPrompt` 同一口径），
 * 写进对话文档 `AgentStateDoc`；此后 persona 段落只读文档 —— 重启不重算、fork 拿 fork 点时的那份。
 *
 * 系统提示词冻结（2026-11-06，「历史状态不变」）：根 agent 冻结时记 `personaKey`（只用来提醒），重新上锁时
 * 存着的人设原样沿用 —— 不看摘要、不看档案名，只看种类：
 *   PKY-1  personaKeyOf 一个参数，同一输入同一摘要，以 `v1:` 开头
 *   PKY-2  种类 / 档案名 / 正文 / 增删非 mcp: 工具 / 工作目录 / 指令文件内容与次序各自得到不同的摘要
 *   PKY-3  会话 id、增删 mcp:、非 mcp: 换序、instructionFiles undefined 与 []、displayName / description → 同一摘要
 *   PKY-4  重复的工具名只算一次（集合，D9）
 *   PKY-5  reusableFrozenPrompt 只在三种情形拒绝：没存、没人设、种类不同（档案名、摘要不同照样沿用，D3）
 *   PKY-6  存着的摘要原样留着；没有摘要 → 记下这次的摘要
 *   PKY-7  人设原样（'' 也算）、指令文件是存着那份的副本（没有 → []）、身份按这次的输入
 *   PKY-8  forgetFrozenPrompt 只删人设、摘要、段落
 *   PKY-9  freezeSections 存副本、整份替换、null 照存
 *   PKY-10 freezePersona 给了摘要就写、没给就删
 */
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai'
import { ROOT_CONVERSATION_ID, SystemEntry } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { renderProfileSystemPrompt } from '../../agentProfile/promptVars'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc } from '../docs'
import {
  computeFrozenAgentPrompt,
  forgetFrozenPrompt,
  freezePersona,
  freezeSections,
  frozenPersonaOf,
  personaKeyOf,
  renderPersona,
  reusableFrozenPrompt,
  type PersonaInput
} from '../prompt/persona'
import type { AgentStateRecord } from '../docs'
import { createPromptExtensions, PROMPT_EXTENSION } from '../prompt/sections'
import { answer, stalled } from './support/faux'
import { makeHost, registerHostCleanup } from './support/host'
import { frozenPrompt, lockPrompt } from './support/prompt'
import { allEntries } from './support/transcript'

registerHostCleanup()

const INPUT: PersonaInput = {
  kind: 'root',
  sessionId: 's1',
  rootSessionId: 's1',
  cwd: '/work/acme',
  toolNames: ['read', 'knowledge'],
  profile: {
    name: 'work',
    systemPrompt: '  Hello {{shuvix:name}}\n\n\n\n{{shuvix:empty}}\n\n\nBye  ',
    instructionFiles: ['AGENTS.md', 'CLAUDE.md']
  }
}

describe('persona rendering and freezing', () => {
  it('P-01 renders with the old createAgent rule: substitute, collapse 3+ newlines, trim', () => {
    const vars = { name: 'X', empty: '' }
    expect(renderPersona(INPUT.profile, vars)).toBe('Hello X\n\nBye')
    expect(renderPersona(INPUT.profile, vars)).toBe(renderProfileSystemPrompt(INPUT.profile, vars))
  })

  it('P-02 computeFrozenAgentPrompt asks promptVars once with the agent context and packages the identity', async () => {
    const contexts: unknown[] = []
    const frozen = await computeFrozenAgentPrompt(
      {
        promptVars: async (ctx) => {
          contexts.push(ctx)
          return { name: 'X', empty: '' }
        }
      },
      INPUT
    )
    // rootSessionId 随 ctx 交给宿主（ENV-12）：派生 agent 的 sessionId 是 agentId，宿主要按它查根会话
    expect(contexts).toEqual([
      {
        sessionId: 's1',
        rootSessionId: 's1',
        kind: 'root',
        cwd: '/work/acme',
        toolNames: ['read', 'knowledge']
      }
    ])
    expect(frozen).toEqual({
      kind: 'root',
      profileName: 'work',
      rootSessionId: 's1',
      persona: 'Hello X\n\nBye',
      instructionFiles: ['AGENTS.md', 'CLAUDE.md']
    })
    // 冻结的是副本：档案对象之后被改不影响
    expect(frozen.instructionFiles).not.toBe(INPUT.profile.instructionFiles)
  })

  it('ENV-12 a spawned input forwards rootSessionId too: sessionId = agentId, cwd "", rootSessionId = the root session', async () => {
    const contexts: unknown[] = []
    await computeFrozenAgentPrompt(
      {
        promptVars: (ctx) => {
          contexts.push(ctx)
          return { name: 'X', empty: '' }
        }
      },
      { ...INPUT, kind: 'spawned', sessionId: 'agent-1', rootSessionId: 's1', cwd: '' }
    )
    expect(contexts).toEqual([
      {
        sessionId: 'agent-1',
        rootSessionId: 's1',
        kind: 'spawned',
        cwd: '',
        toolNames: ['read', 'knowledge']
      }
    ])
  })

  it('P-03 an unknown placeholder is kept verbatim and warned about once, at the freeze only', async () => {
    const warnings: string[] = []
    const logger = { info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} }
    const frozen = await computeFrozenAgentPrompt(
      { promptVars: () => ({ name: 'X', empty: '' }), logger },
      { ...INPUT, profile: { ...INPUT.profile, systemPrompt: 'Hi {{shuvix:nope}}.' } }
    )
    expect(frozen.persona).toBe('Hi {{shuvix:nope}}.')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('{{shuvix:nope}}')

    const t = await makeHost()
    const prompt = createPromptExtensions({})
    const session = await t.open()
    await lockPrompt(await session.currentConversation(), t.kit, frozen, [
      prompt.get(PROMPT_EXTENSION.persona)
    ])
    t.kit.queue(answer('a1'), answer('a2'))
    await session.submitUser('u1')
    await session.submitUser('u2')
    expect(warnings).toHaveLength(1)
    expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).toBe('Hi {{shuvix:nope}}.')
  })

  it('P-04 freezePersona writes the identity fields and keeps the rest of the agent state', async () => {
    const t = await makeHost()
    const session = await t.open()
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)).lastAnnouncedDate = '2026-10-01'
    }, BG)
    await session.harness.commit(
      (tx) =>
        freezePersona(
          tx,
          ROOT_CONVERSATION_ID,
          frozenPrompt({ persona: 'P1', rootSessionId: 'root-1', instructionFiles: ['A.md'] })
        ),
      BG
    )
    expect(await session.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)).toEqual({
      kind: 'root',
      profileName: 'work',
      rootSessionId: 'root-1',
      persona: 'P1',
      instructionFiles: ['A.md'],
      lastAnnouncedDate: '2026-10-01'
    })
    expect(await frozenPersonaOf(session.harness, ROOT_CONVERSATION_ID, BG)).toBe('P1')
  })

  it('P-05 survives a restart with interrupted work on SQLite (option A keeps the lock): same prompt, no re-render, no new pi.system', async () => {
    let promptVarsCalls = 0
    const host = {
      promptVars: () => {
        promptVarsCalls++
        return { name: 'X', empty: '' }
      }
    }
    const t = await makeHost()
    const prompt = createPromptExtensions({})
    const session = await t.open()
    const frozen = await computeFrozenAgentPrompt(host, INPUT)
    await lockPrompt(await session.currentConversation(), t.kit, frozen, [
      prompt.get(PROMPT_EXTENSION.persona)
    ])
    const stall = stalled()
    t.kit.queue(stall.step)
    void session.submitUser('u1')
    await stall.reached

    const t2 = await t.restart()
    const reopened = await t2.open()
    expect(reopened.isInterrupted()).toBe(true)
    await reopened
      .currentConversation()
      .then((conversation) => conversation.configure({ model: t2.kit.model }, BG))
    t2.kit.queue(answer('a2'))
    expect(await reopened.continue()).toEqual({})
    expect(promptVarsCalls).toBe(1)
    expect(getCurrentSystemPrompt(t2.kit.requests[0]!.messages)).toBe('Hello X\n\nBye')
    const systems = (await allEntries(await reopened.currentConversation())).filter((entry) =>
      SystemEntry.is(entry)
    )
    expect(systems).toHaveLength(1)
  })

  it('P-06 a fork keeps the persona as of the fork point; a later re-freeze on the parent does not reach it', async () => {
    const t = await makeHost()
    const prompt = createPromptExtensions({})
    const session = await t.open()
    const root = await session.currentConversation()
    await lockPrompt(root, t.kit, frozenPrompt({ persona: 'P1' }), [
      prompt.get(PROMPT_EXTENSION.persona)
    ])
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    const assistant = (await allEntries(root)).find((entry) => entry.kind === 'pi.assistant')!
    await root.commit((tx) => freezePersona(tx, root.id, frozenPrompt({ persona: 'P2' })), BG)
    const fork = await root.fork(assistant.id, { ownership: { kind: 'ownerless' } }, BG)
    expect(await frozenPersonaOf(session.harness, fork.id, BG)).toBe('P1')
    expect(await frozenPersonaOf(session.harness, root.id, BG)).toBe('P2')
    t.kit.queue(answer('a2'))
    await (await fork.submit({ type: 'input', content: 'on the fork' }, BG)).wait(BG)
    expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).toBe('P1')
    // fork 从 fork 点继承了已显示的人设：内容没变，不发新的 pi.system
    const forkSystems = (await allEntries(fork)).filter((entry) => SystemEntry.is(entry))
    expect(forkSystems).toHaveLength(1)
  })
})

/** 这份输入的一个改动版本（档案字段并进 profile） */
function variant(
  overrides: Partial<Omit<PersonaInput, 'profile'>> & {
    profile?: Partial<PersonaInput['profile']> & { displayName?: string; description?: string }
  }
): PersonaInput {
  const { profile, ...rest } = overrides
  return { ...INPUT, ...rest, profile: { ...INPUT.profile, ...profile } }
}

/** INPUT 冻结后存下的那份记录（可改） */
function storedFor(input: PersonaInput, key: string): AgentStateRecord {
  return {
    kind: input.kind,
    profileName: input.profile.name,
    rootSessionId: 'source-session',
    persona: 'Frozen text',
    instructionFiles: ['AGENTS.md'],
    personaKey: key,
    sections: { project_prompt: '<project_prompt>\nX\n</project_prompt>' }
  }
}

describe('frozen system prompt: persona key and reuse (2026-11-06)', () => {
  it('PKY-1 personaKeyOf takes one argument, is stable for the same input and starts with v1:', () => {
    const base = personaKeyOf(INPUT)
    expect(base).toMatch(/^v1:/)
    expect(personaKeyOf(INPUT)).toBe(base)
    expect(personaKeyOf(variant({}))).toBe(base)
    expect(personaKeyOf.length).toBe(1)
  })

  it('PKY-2 each intentional input gives its own key: kind, profile name, body, a non-mcp tool added or removed, cwd, the instruction-file content and order', () => {
    const base = personaKeyOf(INPUT)
    const changed: [string, string][] = [
      ['kind', personaKeyOf(variant({ kind: 'spawned' }))],
      ['profile.name', personaKeyOf(variant({ profile: { name: 'chat' } }))],
      ['profile.systemPrompt', personaKeyOf(variant({ profile: { systemPrompt: 'Other body' } }))],
      ['tool added', personaKeyOf(variant({ toolNames: ['read', 'knowledge', 'write'] }))],
      ['tool removed', personaKeyOf(variant({ toolNames: ['read'] }))],
      ['cwd', personaKeyOf(variant({ cwd: '/work/other' }))],
      [
        'instructionFiles content',
        personaKeyOf(variant({ profile: { instructionFiles: ['AGENTS.md'] } }))
      ],
      [
        'instructionFiles order',
        personaKeyOf(variant({ profile: { instructionFiles: ['CLAUDE.md', 'AGENTS.md'] } }))
      ]
    ]
    for (const [field, key] of changed) {
      expect(key, field).toMatch(/^v1:/)
      expect(key, field).not.toBe(base)
    }
    // 两两不同
    expect(new Set(changed.map(([, key]) => key)).size).toBe(changed.length)
  })

  it('PKY-3 the same key for: other session ids, mcp: names added or removed, non-mcp names reordered, instructionFiles undefined vs [], displayName / description', () => {
    const base = personaKeyOf(INPUT)
    expect(personaKeyOf(variant({ sessionId: 'fork-1', rootSessionId: 'fork-1' }))).toBe(base)
    expect(personaKeyOf(variant({ toolNames: ['read', 'mcp:ctx', 'knowledge'] }))).toBe(base)
    expect(
      personaKeyOf(variant({ toolNames: ['mcp:browser', 'read', 'knowledge', 'mcp:ssh'] }))
    ).toBe(base)
    // 非 mcp: 名单按集合算（D9）：换序不变
    expect(personaKeyOf(variant({ toolNames: ['knowledge', 'read'] }))).toBe(base)
    expect(personaKeyOf(variant({ profile: { instructionFiles: undefined } }))).toBe(
      personaKeyOf(variant({ profile: { instructionFiles: [] } }))
    )
    expect(
      personaKeyOf(variant({ profile: { displayName: 'Another name', description: 'Another' } }))
    ).toBe(base)
  })

  it('PKY-4 duplicate tool names count once (a true set)', () => {
    expect(personaKeyOf(variant({ toolNames: ['read', 'read'] }))).toBe(
      personaKeyOf(variant({ toolNames: ['read'] }))
    )
    expect(personaKeyOf(variant({ toolNames: ['read', 'knowledge', 'read', 'knowledge'] }))).toBe(
      personaKeyOf(INPUT)
    )
  })

  it('PKY-5 reusableFrozenPrompt refuses only: nothing stored, no persona, another kind (another profile name or key still reuses, D3)', () => {
    const key = personaKeyOf(INPUT)
    const stored = storedFor(INPUT, key)
    const { persona: _persona, ...noPersona } = stored
    const refused: [string, AgentStateRecord | undefined][] = [
      ['nothing stored', undefined],
      ['no persona', noPersona],
      ['another kind', { ...stored, kind: 'spawned' }]
    ]
    for (const [name, record] of refused) {
      expect(reusableFrozenPrompt(record, INPUT, key), name).toBeUndefined()
    }
    const { personaKey: _key, ...noKey } = stored
    const reused: [string, AgentStateRecord][] = [
      ['as stored', stored],
      ['no personaKey', noKey],
      ['another key', { ...stored, personaKey: 'v1:other' }],
      ['another profile', { ...stored, profileName: 'chat' }],
      ['no sections', { ...stored, sections: undefined }]
    ]
    for (const [name, record] of reused) {
      expect(reusableFrozenPrompt(record, INPUT, key), name).toBeDefined()
    }
  })

  it('PKY-6 the stored key is kept as it is; a record without one gets the current key', () => {
    const current = personaKeyOf(INPUT)
    const stored = storedFor(INPUT, 'v1:from-before')
    expect(reusableFrozenPrompt(stored, INPUT, current)?.personaKey).toBe('v1:from-before')
    const { personaKey: _key, ...noKey } = stored
    expect(reusableFrozenPrompt(noKey, INPUT, current)?.personaKey).toBe(current)
  })

  it('PKY-7 reuse hands back the persona verbatim (an empty one counts), a copy of the stored instruction files ([] if absent) and the identity of this input', () => {
    const input = variant({
      sessionId: 'fork-1',
      rootSessionId: 'fork-1',
      profile: { name: 'chat' }
    })
    const key = personaKeyOf(input)
    const stored = storedFor(INPUT, key)
    const reused = reusableFrozenPrompt(stored, input, key)
    expect(reused).toEqual({
      kind: 'root',
      profileName: 'chat',
      rootSessionId: 'fork-1',
      persona: 'Frozen text',
      instructionFiles: ['AGENTS.md'],
      personaKey: key
    })
    // 指令文件是存着的那份（不是这次档案的 AGENTS.md, CLAUDE.md），而且是副本
    expect(reused!.instructionFiles).not.toBe(stored.instructionFiles)
    expect(reusableFrozenPrompt({ ...stored, persona: '' }, input, key)?.persona).toBe('')
    const { instructionFiles: _files, ...noFiles } = stored
    expect(reusableFrozenPrompt(noFiles, input, key)?.instructionFiles).toEqual([])
  })

  it('PKY-8 forgetFrozenPrompt deletes persona, personaKey and sections only', async () => {
    const t = await makeHost()
    const session = await t.open()
    const read = (): Promise<AgentStateRecord | undefined> =>
      session.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)).lastAnnouncedDate = '2026-11-05'
      await freezePersona(
        tx,
        ROOT_CONVERSATION_ID,
        frozenPrompt({ persona: 'P1', instructionFiles: ['A.md'], personaKey: 'v1:a' })
      )
      await freezeSections(tx, ROOT_CONVERSATION_ID, { project_prompt: 'X', bot_profile: null })
    }, BG)
    await session.harness.commit((tx) => forgetFrozenPrompt(tx, ROOT_CONVERSATION_ID), BG)
    expect(await read()).toEqual({
      kind: 'root',
      profileName: 'work',
      rootSessionId: 's1',
      instructionFiles: ['A.md'],
      lastAnnouncedDate: '2026-11-05'
    })
  })

  it('PKY-9 freezeSections stores a copy, replaces the map wholesale and keeps null entries', async () => {
    const t = await makeHost()
    const session = await t.open()
    const read = (): Promise<AgentStateRecord | undefined> =>
      session.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)
    const given: Record<string, string | null> = { project_prompt: 'X', knowledge_bases: null }
    await session.harness.commit((tx) => freezeSections(tx, ROOT_CONVERSATION_ID, given), BG)
    given.project_prompt = 'changed after the freeze'
    expect((await read())?.sections).toEqual({ project_prompt: 'X', knowledge_bases: null })
    await session.harness.commit(
      (tx) => freezeSections(tx, ROOT_CONVERSATION_ID, { bot_profile: 'B' }),
      BG
    )
    expect((await read())?.sections).toEqual({ bot_profile: 'B' })
  })

  it('PKY-10 freezePersona with a key stores it, without one deletes a stored one', async () => {
    const t = await makeHost()
    const session = await t.open()
    const read = (): Promise<AgentStateRecord | undefined> =>
      session.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)
    await session.harness.commit(
      (tx) =>
        freezePersona(
          tx,
          ROOT_CONVERSATION_ID,
          frozenPrompt({ persona: 'P1', personaKey: 'v1:a' })
        ),
      BG
    )
    expect((await read())?.personaKey).toBe('v1:a')
    await session.harness.commit(
      (tx) => freezePersona(tx, ROOT_CONVERSATION_ID, frozenPrompt({ persona: 'P2' })),
      BG
    )
    expect(await read()).not.toHaveProperty('personaKey')
    expect((await read())?.persona).toBe('P2')
  })
})
