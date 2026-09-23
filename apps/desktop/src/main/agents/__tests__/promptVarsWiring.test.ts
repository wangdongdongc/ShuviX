/**
 * 桌面变量表的**接线**（`desktopPromptVars`）—— 钉两件事：
 *
 *  1. 内置档案正文引用的每一个 `{{shuvix:*}}` 占位符，这一端都供了值。
 *     `substitutePromptVars` 的语义是「未知占位符原样保留并 warn」—— 少供一个值**不报错**，只会把
 *     一行 `{{shuvix:visualGuide}}` 原样发给模型。日志里多一条 warn，而没人在盯主进程日志；
 *     提示词少一整节，模型只是"不会画图了"。
 *  2. 作图说明（visualGuide / visualCraft）的两个开关按**这一个 agent 的归一工具名单**
 *     （`PromptVarsCtx.toolNames`，与 resolveTools 收到的是同一份）判：
 *      - `drawingSkill`：名单点了 `skill:builtin:drawing` **且** skillService.findEnabled() 里有它
 *        （没在侧栏停用）→ 手艺段换成一句「先加载技能」的指路；否则整段手艺留在提示里；
 *      - `artifact`：名单里有 `artifact` → guide 教「改图走 adopt」（craft 没有载体，永远不教）。
 *     说明里提到的每样东西都得真在它手里 —— 派发出来的、覆盖了档案的、停用了技能的都一样。
 *
 * 待查名单**从档案正文现算**，不手抄：加一个占位符就自动进入检查，而一份手抄名单只会停在写它的那天。
 * 段落只凭代码记号认（三语一字不差）：POINTER `builtin:drawing`、EXAMPLE「```svg + 换行 + <svg」
 * （手艺段的范例围栏）、ADOPT `adopt`。
 *
 * 取 host 适配面的办法：顶掉 `createAgentFactory`，把 agentHost 传进去的那个对象接住。
 * 其余 mock 只为让模块能加载（dao 会开 SQLite，electron / mcp 在 node 下起不来）；skillService
 * 必须桩成可控的 findEnabled —— 真服务的构造函数会去碰真实 HOME 下的 `~/.shuvix/skills`。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type { AgentHostAdapter, PromptVars, PromptVarsCtx } from '@shuvix/agent-runtime'
import type { Skill } from '../../types/skill'

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined },
  pick: vi.fn(),
  pickSettings: vi.fn(),
  projectPick: vi.fn(),
  findEnabled: vi.fn()
}))

vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return {
    ...actual,
    createAgentFactory: (host: AgentHostAdapter) => {
      mocks.host.value = host
      return { createAgent: vi.fn() }
    }
  }
})

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getPath: () => '/tmp/x' } }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pick: mocks.pick, pickSettings: mocks.pickSettings }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/toolRegistry', () => ({ getBuiltinToolEntries: () => [] }))
vi.mock('../../services/skillTool', () => ({ SkillTool: class {} }))
vi.mock('../../services/skillService', () => ({
  skillService: { findEnabled: mocks.findEnabled }
}))
vi.mock('../../services/mcpService', () => ({ mcpService: {} }))
vi.mock('../../services/agentModelResolver', () => ({ resolveModel: vi.fn() }))
vi.mock('../../services/providerOAuthService', () => ({ providerOAuthService: {} }))
vi.mock('../../services/sessionStorage', () => ({ ensureSessionTree: vi.fn() }))
vi.mock('../../services/instruction', () => ({ resolveInstructionContent: vi.fn() }))
vi.mock('../../services/memory', () => ({ resolveProjectMemoryIndex: vi.fn() }))
vi.mock('../../services/httpLogService', () => ({ httpLogService: {} }))
vi.mock('../../services/llmNetwork', () => ({ llmNetwork: {} }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: {} }))
vi.mock('../../services/wrapToolOutput', () => ({
  wrapToolOutput: vi.fn(),
  getOutputStrategy: vi.fn()
}))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: {},
  electronToolResultTransform: vi.fn(),
  runtimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: vi.fn(),
  resolveProjectConfig: vi.fn()
}))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: () => [] }))
vi.mock('@earendil-works/pi-agent-core/node', () => ({ NodeExecutionEnv: class {} }))
vi.mock('../AgentTool', () => ({ createAgentTool: vi.fn() }))

import i18next from 'i18next'
import {
  buildBuiltinProfiles,
  renderProfileSystemPrompt,
  type AgentProfile
} from '@shuvix/agent-runtime'
import { createInlineMdReader } from '@shuvix/agent-runtime/builtinAgents/inlineSources'
import '../agentHost'

const LANGUAGES = ['en', 'zh', 'ja']
const SID = 'sess-desktop-1'

const DRAWING = 'skill:builtin:drawing'
const POINTER = 'builtin:drawing'
const EXAMPLE = '```svg\n<svg'
const ADOPT = 'adopt'
/** 引用作图片段的两个占位符 */
const FRAGMENT_VARS = ['visualGuide', 'visualCraft'] as const
/** 画内联图、且手里有 artifact 的档案 —— 只有它们的提示里该教 adopt */
const ADOPT_PROFILES = ['bot', 'chat', 'coding', 'work']

const skill = (name: string, source: Skill['source']): Skill => ({
  name,
  description: `${name} description`,
  content: `${name} body`,
  basePath: `/fixture/${name.replace(':', '-')}`,
  isEnabled: true,
  source,
  dirName: source === 'builtin' ? 'builtin' : undefined
})
const BUILTIN = skill('builtin:drawing', 'builtin')
/** 用户全局目录里一个恰好也叫 drawing 的技能 —— 全局名是 `drawing`，不是 `builtin:drawing` */
const USER_DRAWING = skill('drawing', 'default')

/** 文本里引用到的 `{{shuvix:name}}` 名字（去重排序） */
const placeholdersOf = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{\{shuvix:([A-Za-z][\w-]*)\}\}/g)].map((m) => m[1]))].sort()

const countOf = (text: string, needle: string): number => text.split(needle).length - 1

/** 桌面这一端供全部内置档案（含派生用的 coding / explore / titler …），不只四个基座 */
const builtins = (language: string): AgentProfile[] =>
  buildBuiltinProfiles({ language, widgetsRoot: '/w/widgets', readMd: createInlineMdReader() })

const varsFor = async (ctx: Partial<PromptVarsCtx> = {}): Promise<PromptVars> => {
  const host = mocks.host.value
  expect(host, 'agentHost 应把适配面交给 createAgentFactory').toBeDefined()
  return await host!.promptVars({
    sessionId: SID,
    kind: 'root',
    cwd: '/w/proj',
    toolNames: [],
    ...ctx
  })
}

/**
 * 在某个界面语言下跑一段 —— 变量表按 `i18next.language` 挑片段语言，与档案正文同语言才是
 * 真实的组装（zh 的 body 配 zh 的片段）。跑完切回 en，别的用例不受影响。
 */
async function inLanguage<T>(language: string, fn: () => Promise<T>): Promise<T> {
  await i18next.changeLanguage(language)
  try {
    return await fn()
  } finally {
    await i18next.changeLanguage('en')
  }
}

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({ lng: 'en', resources: {}, showSupportNotice: false })
  }
})

afterAll(async () => {
  await i18next.changeLanguage('en')
})

beforeEach(() => {
  mocks.pick.mockReturnValue({ projectId: 'proj-1' })
  mocks.pickSettings.mockReturnValue({ notebookPath: 'notes/a.md' })
  mocks.projectPick.mockReturnValue({ name: 'Proj', path: '/w/proj' })
  mocks.findEnabled.mockReset()
  // 缺省：内置作图技能随包在架、没被停用
  mocks.findEnabled.mockReturnValue([BUILTIN])
})

describe('desktopPromptVars —— 占位符覆盖', () => {
  it('PVW-1 内置档案正文引用的每个占位符，根会话都供了值', async () => {
    const vars = await varsFor({ kind: 'root' })
    const needed = new Set(
      LANGUAGES.flatMap((l) => builtins(l)).flatMap((p) => placeholdersOf(p.systemPrompt))
    )
    expect(needed.size, '语料自检：档案正文里应当真有占位符').toBeGreaterThan(5)
    for (const name of needed) expect(vars[name], `缺 {{shuvix:${name}}}`).toBeTypeOf('string')
  })

  it('PVW-2 派生 agent：除 notebookPath 外同样齐全（派生 ctx.sessionId 是 agentId，解析不出会话）', async () => {
    const vars = await varsFor({ kind: 'spawned', cwd: '' })
    const needed = new Set(
      LANGUAGES.flatMap((l) => builtins(l))
        // 笔记本 / 协作编辑两个基座只做会话根 Agent（notebookPath 只有根会话解析得出）
        .filter((p) => p.name !== 'notebook' && p.name !== 'coedit')
        .flatMap((p) => placeholdersOf(p.systemPrompt))
    )
    for (const name of needed) expect(vars[name], `缺 {{shuvix:${name}}}`).toBeTypeOf('string')
    expect(vars.notebookPath).toBeUndefined()
  })
})

describe('desktopPromptVars —— 作图说明按这个 agent 的名单开关', () => {
  const LISTS: string[][] = [[], [DRAWING], ['artifact'], [DRAWING, 'artifact']]

  it('PVW-3 四种名单下两个值都是自含块（自带小标题）且已 trim —— 空串会让整块静默消失', async () => {
    for (const toolNames of LISTS) {
      const vars = await varsFor({ toolNames })
      for (const name of FRAGMENT_VARS) {
        const what = `${name} ${JSON.stringify(toolNames)}`
        expect(vars[name].startsWith('#'), what).toBe(true)
        expect(vars[name], what).toBe(vars[name].trim())
        expect(vars[name].length, what).toBeGreaterThan(200)
      }
    }
  })

  it('PVW-4 名单点了作图技能且在架 → 两个值都恰好一句指路，手艺范例不再常驻', async () => {
    const vars = await varsFor({ toolNames: [DRAWING] })
    for (const name of FRAGMENT_VARS) {
      expect(countOf(vars[name], POINTER), name).toBe(1)
      expect(vars[name], name).not.toContain(EXAMPLE)
    }
  })

  it('PVW-5 点了名但在侧栏停用（findEnabled 没有它）→ 不指路（连 `builtin:` 都不提），手艺原样留着', async () => {
    mocks.findEnabled.mockReturnValue([])
    const vars = await varsFor({ toolNames: [DRAWING] })
    for (const name of FRAGMENT_VARS) {
      expect(vars[name], name).not.toContain('builtin:')
      expect(vars[name], name).toContain(EXAMPLE)
    }
  })

  it('PVW-6 名单没点它（技能照样在架）→ 不指路、手艺留着；而且根本不去扫技能目录', async () => {
    const vars = await varsFor({ toolNames: [] })
    for (const name of FRAGMENT_VARS) {
      expect(vars[name], name).not.toContain(POINTER)
      expect(vars[name], name).toContain(EXAMPLE)
    }
    // 大多数 agent（titler、explore…）走这条短路：名单里没有就不碰文件系统
    expect(mocks.findEnabled).not.toHaveBeenCalled()
  })

  it('PVW-7 按全局名精确匹配：用户的 `drawing` 顶替不了 `builtin:drawing`，点 `skill:drawing` 也不算点了内置', async () => {
    mocks.findEnabled.mockReturnValue([USER_DRAWING])
    const shadowed = await varsFor({ toolNames: [DRAWING] })
    for (const name of FRAGMENT_VARS) expect(shadowed[name], name).not.toContain(POINTER)

    mocks.findEnabled.mockReturnValue([BUILTIN])
    const wrongName = await varsFor({ toolNames: ['skill:drawing'] })
    for (const name of FRAGMENT_VARS) expect(wrongName[name], name).not.toContain(POINTER)
  })

  it('PVW-8 手里有 artifact 才教 adopt（只在 visualGuide 里）；visualCraft 无论名单如何都不教', async () => {
    expect((await varsFor({ toolNames: ['artifact'] })).visualGuide).toContain(ADOPT)
    expect((await varsFor({ toolNames: [] })).visualGuide).not.toContain(ADOPT)
    for (const toolNames of LISTS) {
      const vars = await varsFor({ toolNames })
      expect(vars.visualCraft, JSON.stringify(toolNames)).not.toContain(ADOPT)
    }
  })

  it('PVW-9 派生 agent 按它自己的名单判：coding 被派发出来时同样拿到指路与 adopt', async () => {
    // 若哪天有人把作图说明塞进 ctx.kind === 'root' 分支（notebookPath 就在紧邻两行），
    // 或只按 root 判开关，派发出来的 coding 会拿到一份与它工具表对不上的说明
    const coding = builtins('en').find((p) => p.name === 'coding')!
    expect(coding.tools).toContain(DRAWING)
    const vars = await varsFor({
      kind: 'spawned',
      sessionId: 'agent-1',
      cwd: '',
      toolNames: coding.tools
    })
    expect(vars.visualGuide).toContain(POINTER)
    expect(vars.visualGuide).toContain(ADOPT)
  })
})

describe('desktopPromptVars —— 按档案自己的名单组装出的系统提示', () => {
  it('PVW-10 每个内置档案 × 三语言：引用处真被替换；指路恰在点了技能的档案里，adopt 恰在 work/chat/coding/bot', async () => {
    let checked = 0
    let referencing = 0
    /** 自检：三种界面语言下供的片段各不相同 —— 否则「× 三语言」只是把英文那份查了三遍 */
    const guides = new Set<string>()
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        for (const profile of builtins(language)) {
          const vars = await varsFor({ kind: 'root', toolNames: profile.tools })
          const out = renderProfileSystemPrompt(profile, vars)
          const what = `${profile.name}.${language}`
          const used = placeholdersOf(profile.systemPrompt)
          for (const name of FRAGMENT_VARS) {
            if (!used.includes(name)) continue
            // 引用了就必须真的替换成内容，而不是原样留一行占位符
            expect(out, `${what}.${name}`).toContain(vars[name])
            referencing++
          }
          expect(out.includes(POINTER), `${what} 的指路`).toBe(profile.tools.includes(DRAWING))
          expect(out.includes(ADOPT), `${what} 的 adopt`).toBe(
            ADOPT_PROFILES.includes(profile.name)
          )
          if (profile.name === 'work') guides.add(vars.visualGuide)
          checked++
        }
      })
    }
    expect(checked, '一个档案都没查到就等于空转').toBeGreaterThan(20)
    expect(referencing, '没有任何档案引用作图片段 —— 接线断了或占位符被删了').toBeGreaterThan(0)
    expect(guides.size, '界面语言没切过去：片段一直是同一份').toBe(3)
  })

  it.each(['root', 'spawned'] as const)(
    'PVW-11 kind=%s：每个内置档案 × 三语言都替换干净，界桩也不漏进提示',
    async (kind) => {
      let checked = 0
      for (const language of LANGUAGES) {
        await inLanguage(language, async () => {
          for (const profile of builtins(language)) {
            // 笔记本 / 协作编辑基座只做会话根 Agent：派生 ctx 解析不出 notebookPath，本就不供
            if (kind === 'spawned' && (profile.name === 'notebook' || profile.name === 'coedit'))
              continue
            const vars = await varsFor({
              kind,
              cwd: kind === 'root' ? '/w/proj' : '',
              toolNames: profile.tools
            })
            const out = renderProfileSystemPrompt(profile, vars)
            const what = `${profile.name}.${language}`
            expect(out, what).not.toContain('{{shuvix:')
            expect(placeholdersOf(out), what).toEqual([])
            expect(out, what).not.toContain('<!-- shuvix:')
            checked++
          }
        })
      }
      expect(checked, '一个档案都没查到就等于空转').toBeGreaterThan(20)
    }
  )
})
