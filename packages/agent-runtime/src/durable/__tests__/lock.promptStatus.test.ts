/**
 * 锁 · 冻结的系统提示词与此刻的来源比一比（`DurableSession.systemPromptStatus` → `AgentLock.promptStatus`，
 * 2026-11-06）：只读 —— 不建锁、不调变量表、不连 MCP、不解析工具、不写；人设按摘要比（环境值不算），其余段落按
 * 此刻的来源现渲染一遍（compare）、与冻结的文本逐字比；一致的转告宿主（`noteSectionsCurrent`）。
 *
 *   STS-1  从没上过锁 / 没文档 → {frozen:false, stale:[]}；不读配置、不调 seam、不发布
 *   STS-2  旧文档（有人设、没段落）→ frozen:false
 *   STS-3  刚上锁、什么都没变 → {frozen:true, stale:[]}；转告全部冻结的段落
 *   STS-4  恰一段变了（各一）：项目提示词 / 知识库 / bot / 指令文件内容（{key, file:'AGENTS.md'}）/ 脱敏说明（文本→null）
 *   STS-5  人设：正文 / 工作目录 / 指令文件清单 / 非 mcp: 工具集合 / 档案名 → [{key:'persona'}]；变量表的值、mcp: 勾选、
 *          技能货架、工具换序 → 不算
 *   STS-6  null→文本、文本→null 都算变了
 *   STS-7  指令文件归属：AGENTS.md 删了 CLAUDE.md 胜出 → file CLAUDE.md；此刻缺席 → 冻结时的文件名；冻结时缺席、
 *          此刻有 → 此刻的文件名
 *   STS-8  六段全变 → 固定次序
 *   STS-9  只读（有锁、没锁都是）：没有发布、不建锁、不调变量表、不解析工具；bot seam 收到 {compare:true}
 *   STS-10 只转告一致的；全变了不转告；每问一次转告一次
 *   STS-11 改了又改回来 → []
 *   STS-12 重建之后 frozen:false，直到下一次上锁 → frozen:true []
 *   STS-13 读当前对话（回退之后是 F）；全新的 F → frozen:false
 *   STS-14 [WB] 有段落没摘要 → 人设从不算变
 *   STS-15 跑着的时候问也照答
 *   STS-16 某段的 seam 抛错 → 那一段不算（不报、不转告）、照样答、记一条警告；会话关了 → SessionClosedError
 *   STS-17 档案此刻会选、却没冻结进来的段落（D2）：此刻有内容 → 报；此刻缺席 → 不报
 *   STS-18 上次没冻结成的段落（unfrozenSections，seam 出错）：不比对、不算新加 —— 不报、不转告
 *   STS-19 冻结里有、档案此刻不会再选的段落 → 报（{key}）：关了项目感知 → project_prompt；去掉指令文件 →
 *          persona + project_instructions
 *   BOT-1  bot：第一次上锁 resolveBotContext(s1, undefined) 一次；空闲重启、正文没变 → 只有 {compare:true} 的调用，
 *          转告里有 bot_profile
 *   BOT-2  重新上锁之前 bot 正文变了 → 转告里没有 bot_profile，提醒报它
 */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { SystemPromptStatus } from '@shuvix/chat-protocol/systemPromptStatus'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc } from '../docs'
import { SessionClosedError, type DurableSession } from '../durableSession'
import type { AgentConfig } from '../seams'
import { scenarioToolHost } from './support/agentConfig'
import { recordPublications } from './support/commits'
import { answer, callTool } from './support/faux'
import {
  BODY,
  changeAllSources,
  driftEnvironment,
  envScenario,
  send,
  stateOf,
  userEntryIds,
  type FrozenScenario
} from './support/frozen'
import { registerHostCleanup, type TestHost } from './support/host'
import { sourceHost, type SourceHost } from './support/prompt'
import { redactionHost } from './support/redaction'
import { forkedId } from './support/rollback'
import { holdTool } from './support/tools'
import { deferred, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000
const NONE: SystemPromptStatus = { frozen: false, stale: [] }
const CURRENT: SystemPromptStatus = { frozen: true, stale: [] }

const BOT_TEXT =
  'You are Aria.\n\n<bot_profile name="aria" file="/b/aria.md">\nlikes tea\n</bot_profile>'

/** bot 档案上的根 agent（四段 + bot 都选） */
function botScenario(sources: SourceHost = sourceHost({ bot: BOT_TEXT })): Promise<FrozenScenario> {
  return envScenario({
    sources,
    edit: (config) => {
      config.profile = { ...config.profile, name: 'bot' }
    }
  })
}

/** 发一次、冻结下来，交回会话 */
async function frozenSession(scenario: FrozenScenario): Promise<DurableSession> {
  const session = await scenario.t.open()
  await send(scenario.t, session, 'u1')
  return session
}

/** 改了配置之后：锁照旧（读状态不建锁），只问一次 */
async function statusOf(session: DurableSession): Promise<SystemPromptStatus> {
  return withTimeout(session.systemPromptStatus(), 5000, 'systemPromptStatus')
}

/** 宿主侧（配置读取、工具解析、MCP）此刻的调用次数 */
function hostCounts(t: TestHost): number[] {
  return [
    t.toolHost.resolveCalls.length,
    t.toolHost.builtinCalls.length,
    t.toolHost.rebuildCalls.length,
    t.toolHost.reconfigureCalls.length
  ]
}

describe('lock · systemPromptStatus', () => {
  it('STS-1 never locked: {frozen:false, stale:[]}; no config read, no seam called, nothing published', async () => {
    const { t, vars, sources } = await envScenario()
    const session = await t.open()
    const recorder = recordPublications(session.harness)
    expect(await statusOf(session)).toEqual(NONE)
    recorder.stop()
    expect(recorder.publications).toEqual([])
    expect(t.configCalls).toEqual([])
    expect(sources.calls).toEqual([])
    expect(sources.notes).toEqual([])
    expect(vars.state.calls).toBe(0)
    expect(session.lock).toBeUndefined()
  })

  it('STS-2 a document from before (a persona but no sections) counts as not frozen', async () => {
    const scenario = await envScenario()
    const session = await frozenSession(scenario)
    await session.harness.commit(async (tx) => {
      delete (await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)).sections
    }, BG)
    scenario.sources.calls.length = 0
    expect(await statusOf(session)).toEqual(NONE)
    expect(scenario.sources.calls).toEqual([])
  })

  it('STS-3 right after the lock with nothing changed: frozen, nothing stale; every frozen section is reported current', async () => {
    const scenario = await envScenario()
    const session = await frozenSession(scenario)
    expect(await statusOf(session)).toEqual(CURRENT)
    expect(scenario.sources.notes).toEqual([
      ['s1', ['project_instructions', 'project_prompt', 'knowledge_bases']]
    ])
  })

  it.each([
    [
      'project_prompt',
      (s: FrozenScenario) => {
        s.sources.values.projectPrompt = 'Acme billing, v2.'
      },
      { key: 'project_prompt' }
    ],
    [
      'knowledge_bases',
      (s: FrozenScenario) => {
        s.sources.values.knowledge = 'Bases: recipes.'
      },
      { key: 'knowledge_bases' }
    ],
    [
      'project_instructions (content)',
      (s: FrozenScenario) => {
        s.sources.values.files = { 'AGENTS.md': 'Use npm.' }
      },
      { key: 'project_instructions', file: 'AGENTS.md' }
    ]
  ] as const)(
    'STS-4 exactly one section changed: %s',
    async (_name, change, expected) => {
      const scenario = await envScenario()
      const session = await frozenSession(scenario)
      change(scenario)
      expect(await statusOf(session)).toEqual({ frozen: true, stale: [expected] })
    },
    TIMEOUT
  )

  it(
    'STS-4 exactly one section changed: bot_profile',
    async () => {
      const scenario = await botScenario()
      const session = await frozenSession(scenario)
      expect(await statusOf(session)).toEqual(CURRENT)
      scenario.sources.values.bot = BOT_TEXT.replace('likes tea', 'likes coffee now')
      expect(await statusOf(session)).toEqual({ frozen: true, stale: [{ key: 'bot_profile' }] })
    },
    TIMEOUT
  )

  it(
    'STS-4 exactly one section changed: placeholders (frozen with redaction, read by a host without it: text → null)',
    async () => {
      const scenario = await envScenario({ host: { redaction: redactionHost } })
      const session = await frozenSession(scenario)
      expect((await stateOf(session))?.sections?.placeholders).toMatch(/^<placeholders>/)
      expect(await statusOf(session)).toEqual(CURRENT)
      const t2 = await scenario.t.restart({ redaction: undefined })
      const reopened = await t2.open()
      expect(await statusOf(reopened)).toEqual({ frozen: true, stale: [{ key: 'placeholders' }] })
    },
    TIMEOUT
  )

  it.each([
    [
      'the profile body',
      (config: AgentConfig) => {
        config.profile = { ...config.profile, systemPrompt: `${BODY} Changed.` }
      }
    ],
    [
      'the working directory',
      (config: AgentConfig) => {
        config.cwd = '/work/other'
      }
    ],
    [
      'the instruction-file list',
      (config: AgentConfig) => {
        config.profile = { ...config.profile, instructionFiles: ['AGENTS.md', 'CLAUDE.md'] }
      }
    ],
    [
      'the non-mcp tool set',
      (config: AgentConfig) => {
        config.profile = {
          ...config.profile,
          tools: config.profile.tools.filter((name) => name !== 'grep')
        }
      }
    ],
    [
      'the profile name',
      (config: AgentConfig) => {
        config.profile = { ...config.profile, name: 'chat' }
      }
    ]
  ] as const)(
    'STS-5 %s changed: [persona]',
    async (_name, change) => {
      const scenario = await envScenario()
      const session = await frozenSession(scenario)
      change(scenario.config)
      expect(await statusOf(session)).toEqual({ frozen: true, stale: [{ key: 'persona' }] })
    },
    TIMEOUT
  )

  it(
    'STS-5 not the persona: the promptVars values, mcp: ticks, the skill shelf, a tool reorder',
    async () => {
      const scenario = await envScenario()
      const session = await frozenSession(scenario)
      driftEnvironment(scenario.vars, '2026-11-09')
      scenario.config.toolOverlay = ['mcp:ctx', 'mcp:ssh']
      scenario.t.toolHost.options.skills = ['pdf']
      scenario.config.profile = {
        ...scenario.config.profile,
        tools: [...scenario.config.profile.tools].reverse()
      }
      expect(await statusOf(session)).toEqual(CURRENT)
      expect(scenario.vars.state.calls).toBe(1)
    },
    TIMEOUT
  )

  it(
    'STS-6 null → text and text → null both count as changed',
    async () => {
      const scenario = await envScenario({ sources: sourceHost({ projectPrompt: null }) })
      const session = await frozenSession(scenario)
      expect((await stateOf(session))?.sections?.project_prompt).toBeNull()
      expect(await statusOf(session)).toEqual(CURRENT)
      scenario.sources.values.projectPrompt = 'Now there is one.'
      scenario.sources.values.knowledge = '   '
      expect(await statusOf(session)).toEqual({
        frozen: true,
        stale: [{ key: 'project_prompt' }, { key: 'knowledge_bases' }]
      })
    },
    TIMEOUT
  )

  it(
    'STS-7 which instruction file: AGENTS.md deleted so CLAUDE.md wins → CLAUDE.md; nothing now → the frozen file; nothing frozen, one now → the current file',
    async () => {
      const scenario = await envScenario({
        edit: (config) => {
          config.profile = { ...config.profile, instructionFiles: ['AGENTS.md', 'CLAUDE.md'] }
        }
      })
      const session = await frozenSession(scenario)
      scenario.sources.values.files = { 'CLAUDE.md': 'Be brief.' }
      expect(await statusOf(session)).toEqual({
        frozen: true,
        stale: [{ key: 'project_instructions', file: 'CLAUDE.md' }]
      })
      scenario.sources.values.files = {}
      expect(await statusOf(session)).toEqual({
        frozen: true,
        stale: [{ key: 'project_instructions', file: 'AGENTS.md' }]
      })

      const empty = await envScenario({ sources: sourceHost({ files: {} }) })
      const second = await frozenSession(empty)
      expect((await stateOf(second))?.sections?.project_instructions).toBeNull()
      empty.sources.values.files = { 'AGENTS.md': 'Use pnpm.' }
      expect(await statusOf(second)).toEqual({
        frozen: true,
        stale: [{ key: 'project_instructions', file: 'AGENTS.md' }]
      })
    },
    TIMEOUT
  )

  it(
    'STS-8 all six changed: reported in the fixed order',
    async () => {
      const sources = sourceHost({ bot: BOT_TEXT })
      const scenario = await envScenario({
        sources,
        host: { redaction: redactionHost },
        edit: (config) => {
          config.profile = { ...config.profile, name: 'bot' }
        }
      })
      await frozenSession(scenario)
      changeAllSources(sources)
      sources.values.bot = 'Someone else.'
      scenario.config.profile = { ...scenario.config.profile, systemPrompt: 'Other body' }
      const t2 = await scenario.t.restart({ redaction: undefined })
      const reopened = await t2.open()
      expect(await statusOf(reopened)).toEqual({
        frozen: true,
        stale: [
          { key: 'persona' },
          { key: 'placeholders' },
          { key: 'project_instructions', file: 'AGENTS.md' },
          { key: 'project_prompt' },
          { key: 'knowledge_bases' },
          { key: 'bot_profile' }
        ]
      })
    },
    TIMEOUT
  )

  it(
    'STS-9 read-only with a lock and without one: nothing published, no lock created, promptVars not asked, no tool resolution; the bot seam is asked with { compare: true }',
    async () => {
      const scenario = await botScenario()
      const { t, vars, sources } = scenario
      const session = await frozenSession(scenario)
      const lock = session.lock
      sources.calls.length = 0
      const counts = hostCounts(t)
      let recorder = recordPublications(session.harness)
      expect(await statusOf(session)).toEqual(CURRENT)
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(session.lock).toBe(lock)
      expect(hostCounts(t)).toEqual(counts)
      expect(vars.state.calls).toBe(1)
      expect(sources.calls).toContain('bot:s1:compare')
      expect(sources.calls).not.toContain('bot:s1')

      await session.destroyAgent()
      sources.calls.length = 0
      recorder = recordPublications(session.harness)
      expect(await statusOf(session)).toEqual(CURRENT)
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(session.lock).toBeUndefined()
      expect(hostCounts(t)).toEqual(counts)
      expect(t.broadcastsOf('agent_created')).toHaveLength(1)
      expect(vars.state.calls).toBe(1)
      expect(sources.calls.filter((call) => call.startsWith('bot:'))).toEqual(['bot:s1:compare'])
    },
    TIMEOUT
  )

  it(
    'STS-10 only the equal sections are reported current; nothing when all changed; once per call',
    async () => {
      const scenario = await envScenario()
      const session = await frozenSession(scenario)
      scenario.sources.values.knowledge = 'Bases: recipes.'
      await statusOf(session)
      await statusOf(session)
      expect(scenario.sources.notes).toEqual([
        ['s1', ['project_instructions', 'project_prompt']],
        ['s1', ['project_instructions', 'project_prompt']]
      ])
      changeAllSources(scenario.sources)
      await statusOf(session)
      expect(scenario.sources.notes).toHaveLength(2)
    },
    TIMEOUT
  )

  it(
    'STS-11 changed and changed back: nothing stale',
    async () => {
      const scenario = await envScenario()
      const session = await frozenSession(scenario)
      scenario.sources.values.projectPrompt = 'Something else.'
      scenario.config.cwd = '/work/other'
      expect((await statusOf(session)).stale).toHaveLength(2)
      scenario.sources.values.projectPrompt = 'Acme billing.'
      scenario.config.cwd = '/work/acme'
      expect(await statusOf(session)).toEqual(CURRENT)
    },
    TIMEOUT
  )

  it(
    'STS-12 after a rebuild: not frozen until the next lock, then frozen with nothing stale',
    async () => {
      const scenario = await envScenario()
      const session = await frozenSession(scenario)
      scenario.sources.values.projectPrompt = 'Acme billing, v2.'
      expect((await statusOf(session)).stale).toEqual([{ key: 'project_prompt' }])
      expect(await session.rebuildSystemPrompt()).toEqual({ success: true })
      expect(await statusOf(session)).toEqual(NONE)
      await send(scenario.t, session, 'u2')
      expect(await statusOf(session)).toEqual(CURRENT)
    },
    TIMEOUT
  )

  it(
    'STS-13 reads the current conversation: after a rollback it is F; a fresh F is not frozen',
    async () => {
      const scenario = await envScenario()
      const session = await frozenSession(scenario)
      await send(scenario.t, session, 'u2')
      // 根对话上重建，再发一次：根上冻结的是新内容
      scenario.sources.values.projectPrompt = 'Acme billing, v2.'
      expect(await session.rebuildSystemPrompt()).toEqual({ success: true })
      await send(scenario.t, session, 'u3')
      expect(await statusOf(session)).toEqual(CURRENT)

      // 回退到 u2：F 带着 u1 那时冻结的版本 → 此刻的来源与它不同
      const F = forkedId(await session.rollbackTo((await userEntryIds(session))[1]!))
      expect((await session.currentConversation()).id).toBe(F)
      expect(await statusOf(session)).toEqual({ frozen: true, stale: [{ key: 'project_prompt' }] })

      // 回退到第一条：全新的对话
      forkedId(await session.rollbackTo((await userEntryIds(session))[0]!))
      expect(await statusOf(session)).toEqual(NONE)
    },
    TIMEOUT
  )

  it(
    'STS-14 [WB] sections without a personaKey: the persona is never reported',
    async () => {
      const scenario = await envScenario()
      const session = await frozenSession(scenario)
      await session.harness.commit(async (tx) => {
        delete (await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)).personaKey
      }, BG)
      scenario.config.profile = { ...scenario.config.profile, systemPrompt: 'Other body' }
      scenario.config.cwd = '/work/other'
      expect(await statusOf(session)).toEqual(CURRENT)
    },
    TIMEOUT
  )

  it(
    'STS-15 asked while a run is going: it answers',
    async () => {
      const gate = deferred()
      const running = deferred()
      const hold = holdTool('hold', gate.promise, { onRun: () => running.resolve() })
      const scenario = await envScenario({
        host: { toolHost: scenarioToolHost({ agentTools: [hold] }) }
      })
      const session = await scenario.t.open()
      scenario.t.kit.queue(callTool('hold'), answer('done'))
      const sending = session.submitUser('go')
      await running.promise
      expect(session.runState).toBe('busy')
      scenario.sources.values.projectPrompt = 'Acme billing, v2.'
      expect(await statusOf(session)).toEqual({ frozen: true, stale: [{ key: 'project_prompt' }] })
      gate.resolve()
      expect(await sending).toEqual({})
    },
    TIMEOUT
  )

  it(
    'STS-16 a throwing seam: that section is neither stale nor current, the status still answers, one warning; a closed session rejects with SessionClosedError',
    async () => {
      const scenario = await envScenario()
      const session = await frozenSession(scenario)
      scenario.sources.values.knowledge = 'Bases: recipes.'
      scenario.sources.fail.add('project')
      expect(await statusOf(session)).toEqual({ frozen: true, stale: [{ key: 'knowledge_bases' }] })
      expect(scenario.sources.notes).toEqual([['s1', ['project_instructions']]])
      const warnings = scenario.t.warnings.filter((line) =>
        line.includes('reading the source of system prompt section project_prompt failed')
      )
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('project exploded')

      await scenario.t.host.closeAll()
      await expect(session.systemPromptStatus()).rejects.toBeInstanceOf(SessionClosedError)
    },
    TIMEOUT
  )

  it(
    'STS-17 a section the profile selects now but that was not frozen (D2): reported when it has content now, not listed when it is absent',
    async () => {
      const sources = sourceHost({ projectPrompt: null })
      const scenario = await envScenario({
        sources,
        edit: (config) => {
          config.profile = { ...config.profile, projectAwareness: false }
        }
      })
      const session = await frozenSession(scenario)
      expect(Object.keys((await stateOf(session))?.sections ?? {})).not.toContain('project_prompt')

      scenario.config.profile = { ...scenario.config.profile, projectAwareness: true }
      // 此刻缺席 → 不报
      expect(await statusOf(session)).toEqual(CURRENT)
      // 此刻有内容 → 报
      sources.values.projectPrompt = 'Acme billing.'
      expect(await statusOf(session)).toEqual({ frozen: true, stale: [{ key: 'project_prompt' }] })
      // 请求照旧没有这一段
      await session.destroyAgent()
      await send(scenario.t, session, 'u2')
      expect(scenario.t.kit.requests.at(-1)!.systemPrompt).not.toContain('<project_prompt>')
    },
    TIMEOUT
  )
  it(
    'STS-18 a section pending since a failed freeze (unfrozenSections) is neither compared nor counted as added: not reported, not noted',
    async () => {
      const scenario = await envScenario()
      scenario.sources.fail.add('project')
      const session = await scenario.t.open()
      await session.createAgent()
      expect((await stateOf(session))?.unfrozenSections).toEqual(['project_prompt'])
      scenario.sources.fail.delete('project')
      scenario.sources.values.projectPrompt = 'Something else now.'
      scenario.sources.calls.length = 0
      expect(await statusOf(session)).toEqual(CURRENT)
      expect(scenario.sources.calls).not.toContain('project:s1')
      expect(scenario.sources.notes).toEqual([['s1', ['project_instructions', 'knowledge_bases']]])
    },
    TIMEOUT
  )

  it.each([
    [
      'project awareness turned off',
      (config: AgentConfig) => {
        config.profile = { ...config.profile, projectAwareness: false }
      },
      [{ key: 'project_prompt' }]
    ],
    [
      'the instruction files dropped from the profile',
      (config: AgentConfig) => {
        config.profile = { ...config.profile, instructionFiles: [] }
      },
      [{ key: 'persona' }, { key: 'project_instructions' }]
    ]
  ] as const)(
    'STS-19 a frozen section the profile would no longer select is reported: %s',
    async (_name, change, expected) => {
      const scenario = await envScenario()
      const session = await frozenSession(scenario)
      change(scenario.config)
      expect(await statusOf(session)).toEqual({ frozen: true, stale: expected })
      // 请求照旧（冻结的那几段都在）
      const first = scenario.t.kit.requests[0]!.systemPrompt
      await session.destroyAgent()
      await send(scenario.t, session, 'u2')
      expect(scenario.t.kit.requests.at(-1)!.systemPrompt).toBe(first)
    },
    TIMEOUT
  )
})

describe('lock · bot section and the read note', () => {
  it(
    'BOT-1 the first lock asks the bot seam once without options; an idle restart with the text unchanged asks it only to compare, and the note includes bot_profile',
    async () => {
      const scenario = await botScenario()
      const session = await frozenSession(scenario)
      expect(scenario.sources.calls.filter((call) => call.startsWith('bot:'))).toEqual(['bot:s1'])
      expect(scenario.sources.notes).toEqual([])
      expect(scenario.t.kit.requests[0]!.systemPrompt).toContain(BOT_TEXT)
      await send(scenario.t, session, 'u2')
      expect(scenario.sources.calls.filter((call) => call.startsWith('bot:'))).toEqual(['bot:s1'])

      scenario.sources.calls.length = 0
      const t2 = await scenario.t.restart()
      const reopened = await t2.open()
      await send(t2, reopened, 'u3')
      expect(scenario.sources.calls.filter((call) => call.startsWith('bot:'))).toEqual([
        'bot:s1:compare'
      ])
      expect(scenario.sources.notes).toEqual([
        ['s1', ['project_instructions', 'project_prompt', 'knowledge_bases', 'bot_profile']]
      ])
    },
    TIMEOUT
  )

  it(
    'BOT-2 the bot text changed before the re-lock: the note leaves bot_profile out, the status reports it, the request keeps the frozen text',
    async () => {
      const scenario = await botScenario()
      const session = await frozenSession(scenario)
      const first = scenario.t.kit.requests[0]!.systemPrompt
      scenario.sources.values.bot = BOT_TEXT.replace('likes tea', 'likes coffee now')
      await session.destroyAgent()
      await send(scenario.t, session, 'u2')
      expect(scenario.t.kit.requests.at(-1)!.systemPrompt).toBe(first)
      expect(scenario.sources.notes).toEqual([
        ['s1', ['project_instructions', 'project_prompt', 'knowledge_bases']]
      ])
      expect(await statusOf(session)).toEqual({ frozen: true, stale: [{ key: 'bot_profile' }] })
    },
    TIMEOUT
  )
})
