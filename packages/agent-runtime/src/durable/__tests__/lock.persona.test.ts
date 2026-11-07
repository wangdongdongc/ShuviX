/**
 * 锁 · 系统提示词冻结（2026-11-06，用户裁决「历史状态不变」；`prompt/persona.ts`、`prompt/sections.ts` 开头）：
 * 根 agent 的系统提示词在这段对话第一次上锁时渲染一次 —— 人设、`personaKey`（只用来提醒）与其余段落
 * （`AgentStateDoc.sections`）写进上锁的那个提交；之后重启后空闲清了锁、芯片上的 X、回退到后面的消息再上锁，
 * 都原样沿用，不调变量表、请求时不调段落的 seam（只在重新上锁时为比对调一次）。来源变了只在提醒里报
 * （`systemPromptStatus`），用户点重建（`rebuildSystemPrompt`）之后下一次上锁才重新渲染。
 *
 *   FRZ-1  第一次上锁：人设、摘要、恰是选中的那几段写进上锁的提交；seam 各调一次、不是比对；第一次请求逐字节
 *   FRZ-2  同一把锁里来源全变了 → 请求逐字节相同、没有新的 pi.system、不调 seam
 *   FRZ-3  空闲重启 + 来源 / 环境 / 正文 / 工作目录 / 指令文件清单都变了 → 逐字节相同、变量表不调、seam 只为比对
 *          调（存着的清单、此刻的工作目录）、日志「reusing the frozen system prompt」、文档深相等（旧摘要）
 *   FRZ-4  芯片上的 X（destroyAgent()）之后发送：同 FRZ-3；删锁的提交不碰 agent-state
 *   FRZ-5  回退到后面的用户消息 → F 带着回退点的段落、沿用；回退到第一条 → 全新渲染
 *   FRZ-6  清空（存储删掉）→ 全新渲染
 *   FRZ-7  旧文档（有人设、没摘要、没段落）→ 人设沿用、变量表不调、摘要 = 此刻的、段落按此刻的来源渲染（不是比对）；
 *          提醒 {frozen:true, stale:[]}
 *   FRZ-8  旧文档、摘要与此刻不同 → 沿用、摘要留着；提醒 [persona]
 *   FRZ-9  冻结时没开自动脱敏、重启后开了 → 段落集合也冻结着：placeholders 照旧缺席、请求不变；提醒 [placeholders]。
 *          反过来（冻结时开着、后来关了）→ 那一段照旧在；提醒 [placeholders]
 *   FRZ-10 档案去掉指令文件 / 项目感知 / knowledge → 请求逐字节相同、提醒含 persona；反过来档案加了指令文件 →
 *          请求不变、提醒 [persona, project_instructions{CLAUDE.md}]；重建之后那个文件进了提示词
 *   FRZ-11 chat → work（档案名变了，D3）：人设沿用；提醒 [persona]；文档的档案名写成此刻的
 *   FRZ-12 重新上锁时恰调一次 noteSectionsCurrent、只给一致的那几段、固定次序；第一次上锁不调；全变了不调
 *   FRZ-13 重新上锁比对时某段的 seam 抛错 → 照样上锁、发冻结的文本、记一条按段的警告、那一段不转告
 *   FRZ-14 第一次冻结时某段的 seam 抛错（D1）→ 照样上锁、那一段不进 sections、记进 unfrozenSections、记一条警告，
 *          那一段照旧选中、现解析；之后每次上锁再试：seam 好了 → 冻结进 sections、清单清空、请求与现解析时逐字节相同；
 *          还是抛 → 留在清单里（再记一条警告）、照旧选中、请求里那一段还在
 *   FRZ-15 [WB] 创建在新加的每个 await 上被取消（读文档、读对话上下文、渲染段落、比对段落）→ cancelled、没锁、文档原样
 *   RBD-12 普通的销毁（destroyAgent、回退到后面）从不碰 persona / personaKey / sections
 *   RBD-11 [WB] 带 forgetPrompt 的销毁合流进一次还在停 run 的普通销毁：两边落定之后冻结的提示词不在
 *   RBD-13 [WB] 重建进行时一次显式的 createAgent：落定之后不会是「有锁、提示词没删」
 *   FRZ-18 另一条会话（子会话就是一条会话）各冻结各的：一条的重建不碰另一条
 */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc } from '../docs'
import { AgentCreationError, type AgentLock } from '../lock'
import { fenceInstructionFile, fenceKnowledgeBases, fenceProjectPrompt } from '../prompt/fences'
import { scenarioToolHost } from './support/agentConfig'
import { recordPublications } from './support/commits'
import { answer, callTool } from './support/faux'
import {
  BODY,
  changeAllSources,
  driftEnvironment,
  envScenario,
  keyOf,
  PERSONA_1,
  promptOf,
  RENDER_CALLS_A,
  REUSED_LOG,
  SECTIONS_A,
  send,
  stateOf,
  userEntryIds
} from './support/frozen'
import { registerHostCleanup } from './support/host'
import { sourceHost } from './support/prompt'
import { redactionHost } from './support/redaction'
import { forkedId } from './support/rollback'
import { storedLock } from './support/scenario'
import { holdTool } from './support/tools'
import { systemDeltas } from './support/transcript'
import { deferred, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000
describe('lock · frozen system prompt', () => {
  it(
    'FRZ-1 the first lock writes the persona, the key and exactly the selected sections in the lock commit; each seam once, not a comparison; the first request byte for byte',
    async () => {
      const { t, vars, config, sources } = await envScenario()
      const session = await t.open()
      const recorder = recordPublications(session.harness)
      await send(t, session, 'u1')
      recorder.stop()

      expect(await stateOf(session)).toEqual({
        kind: 'root',
        profileName: 'work',
        rootSessionId: 's1',
        persona: PERSONA_1,
        instructionFiles: ['AGENTS.md'],
        personaKey: keyOf(config),
        sections: SECTIONS_A
      })
      // 人设、摘要、段落都在上锁的那一个提交里（与锁、pi.agent 一起）
      const frozenIn = recorder.touching('shuvix.agent-state#1')
      expect(frozenIn).toHaveLength(1)
      expect(frozenIn[0]!.docs).toEqual(
        expect.arrayContaining(['shuvix.session-state', 'pi.agent#1'])
      )
      expect(sources.calls).toEqual(RENDER_CALLS_A)
      expect(sources.notes).toEqual([])
      expect(vars.state.calls).toBe(1)
      expect(t.kit.requests[0]!.systemPrompt).toBe(promptOf(PERSONA_1, SECTIONS_A))
      expect(t.infos.some((line) => line.includes(REUSED_LOG))).toBe(false)
    },
    TIMEOUT
  )

  it(
    'FRZ-2 every source changes under the same lock: the requests are identical, no new pi.system, no seam is called',
    async () => {
      const { t, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      const first = t.kit.requests[0]!.systemPrompt
      changeAllSources(sources)
      sources.values.files['CLAUDE.md'] = 'Another file.'
      await send(t, session, 'u2')
      await send(t, session, 'u3')
      expect(t.kit.requests[1]!.systemPrompt).toBe(first)
      expect(t.kit.requests[2]!.systemPrompt).toBe(first)
      expect(sources.calls).toEqual(RENDER_CALLS_A)
      expect(await systemDeltas(await session.currentConversation())).toHaveLength(1)
    },
    TIMEOUT
  )

  it(
    'FRZ-3 idle restart with the sources, the environment, the profile body, the working directory and the instruction-file list all changed: byte-identical, promptVars not asked, the seams only for the comparison, the reuse logged, the document deep-equal',
    async () => {
      const { t, vars, config, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      const first = t.kit.requests[0]!.systemPrompt
      const stored = await stateOf(session)

      driftEnvironment(vars, '2026-11-06')
      changeAllSources(sources)
      config.profile = {
        ...config.profile,
        systemPrompt: `${BODY} Changed.`,
        instructionFiles: ['CLAUDE.md', 'AGENTS.md']
      }
      config.cwd = '/work/other'
      sources.calls.length = 0

      const t2 = await t.restart()
      const reopened = await t2.open()
      expect(reopened.lock).toBeUndefined()
      await send(t2, reopened, 'u2')
      expect(reopened.lock).toBeDefined()
      expect(t2.kit.requests[0]!.systemPrompt).toBe(first)
      expect(vars.state.calls).toBe(1)
      // 比对：存着的清单（AGENTS.md）、此刻的工作目录；请求时一次都不读
      expect(sources.calls).toEqual([
        'instructions:s1:/work/other:AGENTS.md',
        'project:s1',
        'knowledge:s1'
      ])
      expect(sources.notes).toEqual([])
      expect(await stateOf(reopened)).toEqual(stored)
      expect(t2.infos.some((line) => line.includes(REUSED_LOG))).toBe(true)
    },
    TIMEOUT
  )

  it(
    'FRZ-4 the chip X (destroyAgent()) and a send: same as a restart; the unlock commit does not touch agent-state',
    async () => {
      const { t, vars, config, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      const first = t.kit.requests[0]!.systemPrompt
      const stored = await stateOf(session)

      driftEnvironment(vars, '2026-11-06')
      changeAllSources(sources)
      config.profile = { ...config.profile, systemPrompt: `${BODY} Changed.` }
      sources.calls.length = 0
      const recorder = recordPublications(session.harness)
      await session.destroyAgent()
      recorder.stop()
      const unlock = recorder.touching('shuvix.session-state')
      expect(unlock).toHaveLength(1)
      expect(unlock[0]!.docs).not.toContain('shuvix.agent-state#1')
      expect(recorder.touching('shuvix.agent-state#1')).toEqual([])
      expect(await stateOf(session)).toEqual(stored)

      await send(t, session, 'u2')
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(first)
      expect(vars.state.calls).toBe(1)
      expect(sources.calls).toEqual(RENDER_CALLS_A)
      expect(await stateOf(session)).toEqual(stored)
      expect(t.infos.some((line) => line.includes(REUSED_LOG))).toBe(true)
    },
    TIMEOUT
  )

  it(
    'FRZ-5 a rollback to a later user message: F carries the sections as of the fork point and reuses them; a rollback to the first message renders afresh',
    async () => {
      const { t, vars, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      await send(t, session, 'u2')
      const first = t.kit.requests[0]!.systemPrompt
      const root = await stateOf(session)

      driftEnvironment(vars, '2026-11-06')
      changeAllSources(sources)
      sources.calls.length = 0
      const F = forkedId(await session.rollbackTo((await userEntryIds(session))[1]!))
      expect(await stateOf(session, F)).toEqual(root)
      await send(t, session, 'again')
      expect(session.lock?.conversationId).toBe(F)
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(first)
      expect(vars.state.calls).toBe(1)
      expect(sources.calls).toEqual(RENDER_CALLS_A)
      expect(await stateOf(session, F)).toEqual(root)

      // 回退到第一条消息之前：没有前缀，新对话 —— 没有冻结的提示词，按此刻的来源渲染
      sources.calls.length = 0
      const F2 = forkedId(await session.rollbackTo((await userEntryIds(session))[0]!))
      expect(await stateOf(session, F2)).not.toHaveProperty('persona')
      expect(await stateOf(session, F2)).not.toHaveProperty('sections')
      await send(t, session, 'fresh')
      expect(vars.state.calls).toBe(2)
      const fresh = await stateOf(session, F2)
      expect(fresh?.persona).toContain('Today is 2026-11-06')
      expect(fresh?.sections).toEqual({
        project_instructions: fenceInstructionFile('AGENTS.md', 'Use npm.'),
        project_prompt: fenceProjectPrompt('Acme billing, v2.'),
        knowledge_bases: fenceKnowledgeBases('Bases: recipes.')
      })
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(promptOf(fresh!.persona!, fresh!.sections!))
      expect(sources.notes).toEqual([])
    },
    TIMEOUT
  )

  it(
    'FRZ-6 a clear (the storage deleted) starts afresh: rendered from the sources of that moment',
    async () => {
      const { t, vars, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      driftEnvironment(vars, '2026-11-07')
      changeAllSources(sources)
      await t.host.delete('s1')
      const cleared = await t.open()
      await send(t, cleared, 'after clear')
      expect(vars.state.calls).toBe(2)
      expect(t.kit.requests.at(-1)!.systemPrompt).toContain('Today is 2026-11-07')
      expect(t.kit.requests.at(-1)!.systemPrompt).toContain('Acme billing, v2.')
      expect((await stateOf(cleared))?.sections?.project_prompt).toBe(
        fenceProjectPrompt('Acme billing, v2.')
      )
    },
    TIMEOUT
  )

  it(
    'FRZ-7 a document from before (persona, no key, no sections): the persona is reused without asking promptVars, the key becomes the current one, the sections are rendered from the current sources (not a comparison); the status is frozen with nothing stale',
    async () => {
      const { t, vars, config, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      await session.harness.commit(async (tx) => {
        const state = await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)
        delete state.personaKey
        delete state.sections
      }, BG)

      driftEnvironment(vars, '2026-11-06')
      sources.values.projectPrompt = 'Acme billing, v2.'
      sources.calls.length = 0
      const t2 = await t.restart()
      const reopened = await t2.open()
      await send(t2, reopened, 'u2')
      expect(vars.state.calls).toBe(1)
      const after = await stateOf(reopened)
      expect(after?.persona).toBe(PERSONA_1)
      expect(after?.personaKey).toBe(keyOf(config))
      const sections = { ...SECTIONS_A, project_prompt: fenceProjectPrompt('Acme billing, v2.') }
      expect(after?.sections).toEqual(sections)
      expect(t2.kit.requests[0]!.systemPrompt).toBe(promptOf(PERSONA_1, sections))
      expect(sources.calls).toEqual(RENDER_CALLS_A)
      // 渲染不是比对：不转告
      expect(sources.notes).toEqual([])
      expect(await reopened.systemPromptStatus()).toEqual({ frozen: true, stale: [] })
    },
    TIMEOUT
  )

  it(
    'FRZ-8 a document from before whose key differs from the current one: reused, the old key kept, the status reports the persona',
    async () => {
      const { t, vars } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      const first = t.kit.requests[0]!.systemPrompt
      await session.harness.commit(async (tx) => {
        const state = await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)
        state.personaKey = 'v1:from-before'
        delete state.sections
      }, BG)
      await session.destroyAgent()
      await send(t, session, 'u2')
      expect(vars.state.calls).toBe(1)
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(first)
      expect((await stateOf(session))?.personaKey).toBe('v1:from-before')
      expect((await stateOf(session))?.sections).toEqual(SECTIONS_A)
      expect(await session.systemPromptStatus()).toEqual({
        frozen: true,
        stale: [{ key: 'persona' }]
      })
    },
    TIMEOUT
  )

  it(
    'FRZ-9 the set of sections is frozen too: redaction turned on after the freeze leaves placeholders absent (the status reports it); turned off after a freeze with it, the section stays (reported too)',
    async () => {
      const { t } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      const first = t.kit.requests[0]!.systemPrompt

      const t2 = await t.restart({ redaction: redactionHost })
      const reopened = await t2.open()
      await send(t2, reopened, 'u2')
      expect(t2.kit.requests[0]!.systemPrompt).toBe(first)
      expect(t2.kit.requests[0]!.systemPrompt).not.toContain('<placeholders>')
      expect((await stateOf(reopened))?.sections).toEqual(SECTIONS_A)
      expect(reopened.lock?.extensions).not.toContain('shuvix.prompt.placeholders')
      expect(await reopened.systemPromptStatus()).toEqual({
        frozen: true,
        stale: [{ key: 'placeholders' }]
      })

      // 反过来：冻结时开着
      const on = await envScenario({ host: { redaction: redactionHost } })
      const s = await on.t.open()
      await send(on.t, s, 'u1')
      const withNote = on.t.kit.requests[0]!.systemPrompt
      expect(withNote).toContain('<placeholders>')
      const off = await on.t.restart({ redaction: undefined })
      const s2 = await off.open()
      await send(off, s2, 'u2')
      expect(off.kit.requests[0]!.systemPrompt).toBe(withNote)
      expect(await s2.systemPromptStatus()).toEqual({
        frozen: true,
        stale: [{ key: 'placeholders' }]
      })
    },
    TIMEOUT
  )

  it(
    'FRZ-10 the profile drops instruction files, project awareness and knowledge after the freeze: byte-identical; the status reports the persona and the three sections it would no longer select',
    async () => {
      const { t, config } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      const first = t.kit.requests[0]!.systemPrompt

      config.profile = {
        ...config.profile,
        instructionFiles: [],
        projectAwareness: false,
        tools: config.profile.tools.filter((name) => name !== 'knowledge')
      }
      const t2 = await t.restart()
      const reopened = await t2.open()
      await send(t2, reopened, 'u2')
      expect(t2.kit.requests[0]!.systemPrompt).toBe(first)
      expect((await stateOf(reopened))?.sections).toEqual(SECTIONS_A)
      // 档案不再选的三段也报（重建之后它们就没了），外加人设
      expect(await reopened.systemPromptStatus()).toEqual({
        frozen: true,
        stale: [
          { key: 'persona' },
          { key: 'project_instructions' },
          { key: 'project_prompt' },
          { key: 'knowledge_bases' }
        ]
      })
    },
    TIMEOUT
  )

  it(
    'FRZ-10 the profile adds instruction files after the freeze: the prompt is unchanged, the status reports [persona, project_instructions(CLAUDE.md)]; after a rebuild the file is in the prompt',
    async () => {
      const sources = sourceHost({ files: { 'CLAUDE.md': 'Be brief.' } })
      const { t, config } = await envScenario({
        sources,
        edit: (c) => {
          c.profile = { ...c.profile, instructionFiles: [] }
        }
      })
      const session = await t.open()
      await send(t, session, 'u1')
      const first = t.kit.requests[0]!.systemPrompt
      expect(first).not.toContain('<project_instructions')
      expect(Object.keys((await stateOf(session))?.sections ?? {})).toEqual([
        'project_prompt',
        'knowledge_bases'
      ])

      config.profile = { ...config.profile, instructionFiles: ['AGENTS.md', 'CLAUDE.md'] }
      await session.destroyAgent()
      await send(t, session, 'u2')
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(first)
      expect(session.lock?.extensions).not.toContain('shuvix.prompt.instructions')
      expect(await session.systemPromptStatus()).toEqual({
        frozen: true,
        stale: [{ key: 'persona' }, { key: 'project_instructions', file: 'CLAUDE.md' }]
      })

      expect(await session.rebuildSystemPrompt()).toEqual({ success: true })
      await send(t, session, 'u3')
      expect(t.kit.requests.at(-1)!.systemPrompt).toContain(
        fenceInstructionFile('CLAUDE.md', 'Be brief.')
      )
      expect(await session.systemPromptStatus()).toEqual({ frozen: true, stale: [] })
    },
    TIMEOUT
  )

  it(
    'FRZ-11 chat → work (another profile name, D3): the persona text is reused; the status reports the persona; the document takes the current profile name',
    async () => {
      const { t, vars, config } = await envScenario({
        edit: (c) => {
          c.profile = { ...c.profile, name: 'chat' }
        }
      })
      const session = await t.open()
      await send(t, session, 'u1')
      const first = t.kit.requests[0]!.systemPrompt
      expect((await stateOf(session))?.profileName).toBe('chat')

      config.profile = { ...config.profile, name: 'work' }
      await session.destroyAgent()
      await send(t, session, 'u2')
      expect(vars.state.calls).toBe(1)
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(first)
      expect((await stateOf(session))?.persona).toBe(PERSONA_1)
      expect((await stateOf(session))?.profileName).toBe('work')
      expect(await session.systemPromptStatus()).toEqual({
        frozen: true,
        stale: [{ key: 'persona' }]
      })
    },
    TIMEOUT
  )

  it(
    'FRZ-12 a re-lock of a frozen conversation tells the host once which sections are current (exactly the equal ones, fixed order); a first lock does not; nothing when every section changed',
    async () => {
      const { t, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      expect(sources.notes).toEqual([])

      sources.values.projectPrompt = 'Acme billing, v2.'
      await session.destroyAgent()
      await send(t, session, 'u2')
      expect(sources.notes).toEqual([['s1', ['project_instructions', 'knowledge_bases']]])

      changeAllSources(sources)
      await session.destroyAgent()
      await send(t, session, 'u3')
      expect(sources.notes).toHaveLength(1)
    },
    TIMEOUT
  )

  it(
    'FRZ-13 a seam that throws while comparing at a re-lock: the lock is still created, the frozen text is sent, one warning for that section, and it is not reported as current',
    async () => {
      const { t, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      const first = t.kit.requests[0]!.systemPrompt

      sources.fail.add('project')
      await session.destroyAgent()
      await send(t, session, 'u2')
      expect(session.lock).toBeDefined()
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(first)
      const warnings = t.warnings.filter((line) =>
        line.includes('reading the source of system prompt section project_prompt failed')
      )
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('project exploded')
      expect(sources.notes).toEqual([['s1', ['project_instructions', 'knowledge_bases']]])
    },
    TIMEOUT
  )

  it(
    'FRZ-14 a seam that throws at the first freeze (D1): createAgent still succeeds, that key is not in sections, one warning; the section stays live in that lock',
    async () => {
      const { t, sources } = await envScenario()
      sources.fail.add('project')
      const session = await t.open()
      await session.createAgent()
      expect(session.lock).toBeDefined()
      expect((await stateOf(session))?.sections).toEqual({
        project_instructions: SECTIONS_A.project_instructions,
        knowledge_bases: SECTIONS_A.knowledge_bases
      })
      const warnings = t.warnings.filter((line) =>
        line.includes(
          'rendering system prompt section project_prompt failed; it is not frozen this time'
        )
      )
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('project exploded')
      expect((await stateOf(session))?.unfrozenSections).toEqual(['project_prompt'])
      expect(session.lock?.extensions).toContain('shuvix.prompt.project-prompt')

      // 照旧现解析：seam 好了，下一次请求就有这一段
      sources.fail.delete('project')
      sources.calls.length = 0
      await send(t, session, 'u1')
      expect(t.kit.requests[0]!.systemPrompt).toBe(promptOf(PERSONA_1, SECTIONS_A))
      expect(sources.calls).toEqual(['project:s1'])
    },
    TIMEOUT
  )

  it(
    'FRZ-14 the seam recovers, then a restart: the re-lock renders the pending section and stores it, the list is emptied, the request is byte-identical to the live one',
    async () => {
      const { t, sources } = await envScenario()
      sources.fail.add('project')
      const session = await t.open()
      await session.createAgent()
      sources.fail.delete('project')
      await send(t, session, 'u1')
      const live = t.kit.requests[0]!.systemPrompt
      expect(live).toBe(promptOf(PERSONA_1, SECTIONS_A))

      sources.calls.length = 0
      const t2 = await t.restart()
      const reopened = await t2.open()
      await send(t2, reopened, 'u2')
      expect(t2.kit.requests[0]!.systemPrompt).toBe(live)
      const after = await stateOf(reopened)
      expect(after?.sections).toEqual(SECTIONS_A)
      expect(after).not.toHaveProperty('unfrozenSections')
      expect(reopened.lock?.extensions).toContain('shuvix.prompt.project-prompt')
      // 冻结了的两段比对、待冻结的那一段渲染：各一次
      expect([...sources.calls].sort()).toEqual([...RENDER_CALLS_A].sort())
      expect(sources.notes).toEqual([['s1', ['project_instructions', 'knowledge_bases']]])
      // 冻结之后请求时不再调它
      sources.calls.length = 0
      await send(t2, reopened, 'u3')
      expect(sources.calls).toEqual([])
      expect(await reopened.systemPromptStatus()).toEqual({ frozen: true, stale: [] })
    },
    TIMEOUT
  )

  it(
    'FRZ-14 still failing at the next lock: the key stays pending (another warning), the section stays selected and shown',
    async () => {
      const { t, sources } = await envScenario()
      sources.fail.add('project')
      const session = await t.open()
      await session.createAgent()
      sources.fail.delete('project')
      await send(t, session, 'u1')
      const live = t.kit.requests[0]!.systemPrompt

      sources.fail.add('project')
      await session.destroyAgent()
      await send(t, session, 'u2')
      const freezeWarnings = t.warnings.filter((line) =>
        line.includes(
          'rendering system prompt section project_prompt failed; it is not frozen this time'
        )
      )
      expect(freezeWarnings).toHaveLength(2)
      const after = await stateOf(session)
      expect(after?.unfrozenSections).toEqual(['project_prompt'])
      expect(after?.sections).not.toHaveProperty('project_prompt')
      expect(session.lock?.extensions).toContain('shuvix.prompt.project-prompt')
      // 现解析抛错 → durable 留着已显示的那一段：请求照旧带着它
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(live)
    },
    TIMEOUT
  )

  it.each(['snapshot', 'conversation'] as const)(
    'FRZ-15 [WB] creation cancelled while it awaits the stored AgentStateDoc / the conversation context (%s): no lock, the document unchanged',
    async (method) => {
      const { t, config } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      await session.destroyAgent()
      const before = await stateOf(session)
      // 换个工作目录：真建成的话会多一次比对
      config.cwd = '/work/other'

      const harness = session.harness as unknown as Record<string, (...args: unknown[]) => unknown>
      const original = harness[method]!.bind(session.harness)
      let fired = false
      const spy = vi.spyOn(harness, method).mockImplementation(async (...args: unknown[]) => {
        const result = await original(...args)
        const isTarget =
          method === 'snapshot' ? args[0] === AgentStateDoc : args[0] === ROOT_CONVERSATION_ID
        if (isTarget && !fired) {
          fired = true
          // 取消这次创建（销毁在没锁时只取消在途的创建）
          void session.destroyAgent()
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        return result
      })
      try {
        await expect(session.createAgent()).rejects.toSatisfy(
          (error) => error instanceof AgentCreationError && error.code === 'cancelled'
        )
      } finally {
        spy.mockRestore()
      }
      expect(fired).toBe(true)
      expect(session.lock).toBeUndefined()
      expect(await storedLock(session)).toBeUndefined()
      expect(await stateOf(session)).toEqual(before)
    },
    TIMEOUT
  )

  it.each(['the first render', 'the comparison at a re-lock'] as const)(
    'FRZ-15 [WB] creation cancelled inside a section seam during %s: cancelled, no lock, the document unchanged',
    async (when) => {
      const { t, sources } = await envScenario()
      const session = await t.open()
      if (when === 'the comparison at a re-lock') {
        await send(t, session, 'u1')
        await session.destroyAgent()
      }
      const before = await stateOf(session)
      let fired = false
      sources.onCall = async (seam) => {
        if (seam !== 'project' || fired) return
        fired = true
        void session.destroyAgent()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      await expect(session.createAgent()).rejects.toSatisfy(
        (error) => error instanceof AgentCreationError && error.code === 'cancelled'
      )
      expect(fired).toBe(true)
      expect(session.lock).toBeUndefined()
      expect(await storedLock(session)).toBeUndefined()
      expect(await stateOf(session)).toEqual(before)
    },
    TIMEOUT
  )
  it(
    'FRZ-18 another session (a sub-session is one) freezes on its own; a rebuild of one leaves the other alone',
    async () => {
      const { t, sources } = await envScenario()
      const s1 = await t.open('s1')
      await send(t, s1, 'u1')
      sources.values.projectPrompt = 'Acme billing, v2.'
      const s2 = await t.open('s2')
      await send(t, s2, 'v1')
      expect((await stateOf(s1))?.sections?.project_prompt).toBe(SECTIONS_A.project_prompt)
      expect((await stateOf(s2))?.sections?.project_prompt).toBe(
        fenceProjectPrompt('Acme billing, v2.')
      )
      expect((await stateOf(s2))?.rootSessionId).toBe('s2')
      const s1Before = await stateOf(s1)

      expect(await s2.rebuildSystemPrompt()).toEqual({ success: true })
      expect(await stateOf(s1)).toEqual(s1Before)
      expect(s1.lock).toBeDefined()
      expect(await s1.systemPromptStatus()).toEqual({
        frozen: true,
        stale: [{ key: 'project_prompt' }]
      })
    },
    TIMEOUT
  )
})

describe('lock · frozen system prompt and destroys', () => {
  it(
    'RBD-12 plain destroys never touch persona, personaKey or sections: destroyAgent() and a rollback to a later point',
    async () => {
      const { t, vars, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      await send(t, session, 'u2')
      const stored = await stateOf(session)

      driftEnvironment(vars, '2026-11-06')
      changeAllSources(sources)
      await session.destroyAgent()
      expect(await stateOf(session)).toEqual(stored)
      await send(t, session, 'u3')
      expect(await stateOf(session)).toEqual(stored)

      // 回退：销毁当前对话的 agent（不碰它的文档），F 拿 fork 点时的那份
      const F = forkedId(await session.rollbackTo((await userEntryIds(session))[2]!))
      expect(await stateOf(session, ROOT_CONVERSATION_ID)).toEqual(stored)
      expect(await stateOf(session, F)).toEqual(stored)
      expect(vars.state.calls).toBe(1)
    },
    TIMEOUT
  )

  it(
    'RBD-11 [WB] a forgetPrompt destroy joining a plain destroy that is still stopping a run: after both settle the frozen prompt is gone',
    async () => {
      const gate = deferred()
      const running = deferred()
      // 对中止充耳不闻：普通销毁停在「让会话停下」里，直到闸门放行
      const hold = holdTool('hold', gate.promise, {
        onRun: () => running.resolve(),
        signalAware: false
      })
      const { t } = await envScenario({
        host: { toolHost: scenarioToolHost({ agentTools: [hold] }) }
      })
      const session = await t.open()
      t.kit.queue(callTool('hold'), answer('not reached'))
      const sending = session.submitUser('go')
      await running.promise
      expect((await stateOf(session))?.sections).toBeDefined()

      const lock = (session as unknown as { agentLock: AgentLock }).agentLock
      const recorder = recordPublications(session.harness)
      const plain = session.destroyAgent()
      await waitFor(() => t.broadcastsOf('agent_closing').length === 1, 3000, 'closing')
      const rebuild = lock.destroy(undefined, { forgetPrompt: true })
      gate.resolve()
      await withTimeout(Promise.all([plain, rebuild]), 5000, 'both destroys')
      recorder.stop()
      await sending
      expect(session.lock).toBeUndefined()
      const after = await stateOf(session)
      expect(after).not.toHaveProperty('persona')
      expect(after).not.toHaveProperty('personaKey')
      expect(after).not.toHaveProperty('sections')
      // 身份字段留着
      expect(after).toMatchObject({ kind: 'root', profileName: 'work', rootSessionId: 's1' })
      // 删锁的那个提交没碰 agent-state（普通销毁）；之后补了一个只删冻结的提示词的提交
      const unlock = recorder.touching('shuvix.session-state')
      expect(unlock).toHaveLength(1)
      expect(unlock[0]!.docs).not.toContain('shuvix.agent-state#1')
      expect(recorder.touching('shuvix.agent-state#1')).toHaveLength(1)
    },
    TIMEOUT
  )

  it.each(['at once', 'once the rebuild is waiting for it'] as const)(
    'RBD-13 [WB] an explicit createAgent in flight while a rebuild runs (the creation goes on %s): the end state is never a lock over a prompt that was not forgotten',
    async (when) => {
      const { t, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      await session.destroyAgent()
      changeAllSources(sources)

      // 创建停在比对的 seam 里，重建这时进来
      const gate = deferred()
      let hit = false
      sources.onCall = async (seam) => {
        if (seam !== 'project' || hit) return
        hit = true
        await gate.promise
      }
      const creating = session.createAgent().then(
        () => 'created' as const,
        (error: unknown) =>
          error instanceof AgentCreationError && error.code === 'cancelled'
            ? ('cancelled' as const)
            : Promise.reject(error)
      )
      await waitFor(() => hit, 3000, 'creation in the seam')
      const rebuilding = session.rebuildSystemPrompt()
      if (when === 'once the rebuild is waiting for it') {
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      gate.resolve()
      const [created, rebuilt] = await withTimeout(
        Promise.all([creating, rebuilding]),
        5000,
        'create + rebuild'
      )
      expect(rebuilt).toEqual({ success: true })
      // 创建先落定 → 重建把它连锁带提示词一起删；重建先取消了它 → 被取消。哪一种都行，落定的状态是同一个
      expect(['created', 'cancelled']).toContain(created)
      expect(session.lock).toBeUndefined()
      expect(await storedLock(session)).toBeUndefined()
      const after = await stateOf(session)
      expect(after).not.toHaveProperty('persona')
      expect(after).not.toHaveProperty('sections')

      // 下一次发送按此刻的来源渲染
      sources.onCall = undefined
      await send(t, session, 'u2')
      expect(t.kit.requests.at(-1)!.systemPrompt).toContain('Acme billing, v2.')
    },
    TIMEOUT
  )
})
