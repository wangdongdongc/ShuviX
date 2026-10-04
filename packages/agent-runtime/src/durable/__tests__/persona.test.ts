/**
 * 人设冻结（P1-08）：创建 agent 时现算一次变量表、渲染档案正文（`renderProfileSystemPrompt` 同一口径），
 * 写进对话文档 `AgentStateDoc`；此后 persona 段落只读文档 —— 重启不重算、fork 拿 fork 点时的那份。
 */
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai'
import { ROOT_CONVERSATION_ID, SystemEntry } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { renderProfileSystemPrompt } from '../../agentProfile/promptVars'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc } from '../docs'
import {
  computeFrozenAgentPrompt,
  freezePersona,
  frozenPersonaOf,
  renderPersona,
  type PersonaInput
} from '../prompt/persona'
import { createPromptExtensions, PROMPT_EXTENSION } from '../prompt/sections'
import { answer } from './support/faux'
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
    expect(contexts).toEqual([
      { sessionId: 's1', kind: 'root', cwd: '/work/acme', toolNames: ['read', 'knowledge'] }
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
    for (const extension of prompt.all) t.registry.install(extension)
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

  it('P-05 survives a restart on SQLite: same prompt, no re-render, no new pi.system', async () => {
    let promptVarsCalls = 0
    const host = {
      promptVars: () => {
        promptVarsCalls++
        return { name: 'X', empty: '' }
      }
    }
    const t = await makeHost()
    const prompt = createPromptExtensions({})
    for (const extension of prompt.all) t.registry.install(extension)
    const session = await t.open()
    const frozen = await computeFrozenAgentPrompt(host, INPUT)
    await lockPrompt(await session.currentConversation(), t.kit, frozen, [
      prompt.get(PROMPT_EXTENSION.persona)
    ])
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')

    const t2 = await t.restart()
    const prompt2 = createPromptExtensions({})
    for (const extension of prompt2.all) t2.registry.install(extension)
    const reopened = await t2.open()
    await reopened
      .currentConversation()
      .then((conversation) => conversation.configure({ model: t2.kit.model }, BG))
    t2.kit.queue(answer('a2'))
    expect(await reopened.submitUser('u2')).toEqual({})
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
    for (const extension of prompt.all) t.registry.install(extension)
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
