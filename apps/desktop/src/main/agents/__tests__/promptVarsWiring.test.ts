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
 *        （没在侧栏停用）→ 才有这份说明（载体 + 「本会话第一张图之前先加载技能」）；否则两个值都是
 *        空串，引用处整块收敛消失。2026-09-24 起 svg 契约、框箭头预算与范例图只在技能里
 *        （用户裁决）：指一个拿不到的技能是死路，而契约不再有常驻的第二份；
 *      - `artifact`：名单里有 `artifact` → guide 教「改图走 adopt」（craft 没有载体，永远不教）。
 *     说明里提到的每样东西都得真在它手里 —— 派发出来的、覆盖了档案的、停用了技能的都一样。
 *
 *  3. 第三个开关 `interactive`（交互块那一段）**不看名单，看回复落在哪儿**：只有根 agent 的回复显示成
 *     一条对话（派生 agent 的回复是交回父 agent 的工具结果），而 Chrome 标签页会话显示在扩展侧栏里
 *     —— 那里的 CSP 跑不了它。所以：根 + 不是标签页会话 → 教；标签页会话 / 派生 → 不教（PVW-12…15）。
 *
 * 待查名单**从档案正文现算**，不手抄：加一个占位符就自动进入检查，而一份手抄名单只会停在写它的那天。
 * 段落只凭代码记号认（三语一字不差）：POINTER `builtin:drawing`、EXAMPLE「```svg + 换行 + <svg」
 * （范例图的围栏 —— 如今只在技能里，提示里任何时候都不该有）、ADOPT `adopt`。
 *
 * 编号变动（2026-09-24）：PVW-3 / 5 / 6 / 7 / 8 同号改写（技能不在架时的期望从「手艺常驻」变成
 * 「空串」）；新增 PVW-16（引用处在空串下收敛干净）与 PVW-17（组装出的提示里没有契约）。
 *
 * 取 host 适配面的办法：顶掉 `createAgentFactory`，把 agentHost 传进去的那个对象接住。
 * 其余 mock 只为让模块能加载（dao 会开 SQLite，electron / mcp 在 node 下起不来）；skillService
 * 必须桩成可控的 findEnabled —— 真服务的构造函数会去碰真实 HOME 下的 `~/.shuvix/skills`。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import type { AgentHostAdapter, PromptVars, PromptVarsCtx } from '@shuvix/agent-runtime'
import type { Skill } from '../../types/skill'

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined },
  pick: vi.fn(),
  pickSettings: vi.fn(),
  projectPick: vi.fn(),
  findEnabled: vi.fn(),
  /** Windows 上解析出的 PowerShell 版本（PVW-S*）；null = 用真的 getPowerShellConfig */
  psConfig: null as null | { exe: string; edition: 'pwsh' | 'windows-powershell' }
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
vi.mock('../../services/toolRegistry', () => ({
  getBuiltinToolEntries: () => [],
  getPlatformBuiltinToolEntries: () => []
}))
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
vi.mock('../../utils/toolUtils/shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/toolUtils/shell')>()
  return {
    ...actual,
    getPowerShellConfig: () => mocks.psConfig ?? actual.getPowerShellConfig()
  }
})

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

  it('PVW-3 四种名单：技能在架时 visualGuide 是自含块（自带小标题）、visualCraft 恰好一段，都已 trim；技能不在名单上时两个都是空串', async () => {
    for (const toolNames of LISTS) {
      const vars = await varsFor({ toolNames })
      const skill = toolNames.includes(DRAWING)
      for (const name of FRAGMENT_VARS) {
        const what = `${name} ${JSON.stringify(toolNames)}`
        expect(vars[name], what).toBe(vars[name].trim())
        // 契约只在技能里：技能不在，整份说明不出（空串会让引用处整块收敛，见 PVW-16）
        if (!skill) expect(vars[name], what).toBe('')
        else expect(vars[name].length, what).toBeGreaterThan(0)
      }
      if (skill) {
        const what = JSON.stringify(toolNames)
        expect(vars.visualGuide.startsWith('#'), what).toBe(true)
        expect(vars.visualGuide.length, what).toBeGreaterThan(200)
        // visualCraft 嵌在档案自己的段落之间：它只是一段（「先加载技能」）
        expect(vars.visualCraft.split(/\n[ \t]*\n/), what).toHaveLength(1)
      }
    }
  })

  it('PVW-4 名单点了作图技能且在架 → 两个值都恰好一句指路，范例图不在提示里', async () => {
    // 缺省 ctx 是桌面根会话 → visualGuide 连交互段一起给；交互段也指向技能，但不重复点名
    const vars = await varsFor({ toolNames: [DRAWING] })
    expect(vars.visualGuide).toContain('```interactive')
    for (const name of FRAGMENT_VARS) {
      expect(countOf(vars[name], POINTER), name).toBe(1)
      expect(vars[name], name).not.toContain(EXAMPLE)
    }
  })

  it('PVW-5 点了名但在侧栏停用（findEnabled 没有它）→ 两个值都是空串（连 `builtin:` 都不提），手里有 artifact 也一样', async () => {
    mocks.findEnabled.mockReturnValue([])
    const vars = await varsFor({ toolNames: [DRAWING, 'artifact'] })
    for (const name of FRAGMENT_VARS) expect(vars[name], name).toBe('')
  })

  it('PVW-6 名单没点它（技能照样在架）→ 两个值都是空串；而且根本不去扫技能目录', async () => {
    const vars = await varsFor({ toolNames: [] })
    for (const name of FRAGMENT_VARS) expect(vars[name], name).toBe('')
    // 大多数 agent（titler、explore…）走这条短路：名单里没有就不碰文件系统
    expect(mocks.findEnabled).not.toHaveBeenCalled()
  })

  it('PVW-7 按全局名精确匹配：用户的 `drawing` 顶替不了 `builtin:drawing`，点 `skill:drawing` 也不算点了内置', async () => {
    mocks.findEnabled.mockReturnValue([USER_DRAWING])
    const shadowed = await varsFor({ toolNames: [DRAWING] })
    for (const name of FRAGMENT_VARS) expect(shadowed[name], name).toBe('')

    mocks.findEnabled.mockReturnValue([BUILTIN])
    const wrongName = await varsFor({ toolNames: ['skill:drawing'] })
    for (const name of FRAGMENT_VARS) expect(wrongName[name], name).toBe('')
  })

  it('PVW-8 技能在架且手里有 artifact 才教 adopt（只在 visualGuide 里）；visualCraft 无论名单如何都不教', async () => {
    expect((await varsFor({ toolNames: [DRAWING, 'artifact'] })).visualGuide).toContain(ADOPT)
    expect((await varsFor({ toolNames: [DRAWING] })).visualGuide).not.toContain(ADOPT)
    // 只有 artifact、没有技能：整份说明都不出，adopt 不会单独冒出来
    expect((await varsFor({ toolNames: ['artifact'] })).visualGuide).toBe('')
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

describe('desktopPromptVars —— 交互块按回复落在哪儿给（PVW-12…15）', () => {
  const INTERACTIVE = '```interactive'
  /** 载体段那句「回复里的 ```svg 围栏会内联渲染」的记号（```svg + 空格） */
  const CARRIER = '```svg '
  /** 一条 Chrome 标签页会话的 settings（字段齐全，chromeTabOf 认它） */
  const CHROME_TAB = { chromeTab: { installId: 'i', runId: 'r', tabId: 7 } }
  /** 引用 visualGuide、在桌面根会话里就该教交互块的档案 */
  const INTERACTIVE_PROFILES = ['bot', 'chat', 'coding', 'work']

  it('PVW-12 桌面会话的根 agent：作图技能在架才教交互块（契约在技能里、不常驻），visualCraft 从不教', async () => {
    const withSkill = await varsFor({ kind: 'root', toolNames: [DRAWING, 'artifact'] })
    expect(withSkill.visualGuide).toContain(INTERACTIVE)
    expect(withSkill.visualGuide).toContain('references/interactive.md')
    expect(withSkill.visualGuide).not.toContain('shuvix-lib://')
    expect(withSkill.visualCraft).not.toContain(INTERACTIVE)
    for (const toolNames of [[], ['read'], ['artifact']]) {
      const vars = await varsFor({ kind: 'root', toolNames })
      const what = JSON.stringify(toolNames)
      expect(vars.visualGuide, what).not.toContain(INTERACTIVE)
      expect(vars.visualCraft, what).not.toContain(INTERACTIVE)
    }
  })

  it('PVW-13 Chrome 标签页会话的根：不教交互块（侧栏的 CSP 跑不了它），svg 载体照旧在', async () => {
    mocks.pickSettings.mockReturnValue(CHROME_TAB)
    const vars = await varsFor({ kind: 'root', toolNames: [DRAWING] })
    expect(vars.visualGuide).not.toContain(INTERACTIVE)
    expect(vars.visualGuide).not.toContain('shuvix-lib://')
    expect(vars.visualGuide).toContain(CARRIER)
    // 反证：同一份 ctx 换成普通会话就教 —— 上面的「不教」确实是 chromeTab 带来的
    mocks.pickSettings.mockReturnValue({})
    expect((await varsFor({ kind: 'root', toolNames: [DRAWING] })).visualGuide).toContain(
      INTERACTIVE
    )
  })

  it('PVW-14 派生 agent（coding 的名单）：不教交互块，但指路与 adopt 照旧按名单给', async () => {
    const coding = builtins('en').find((p) => p.name === 'coding')!
    const vars = await varsFor({
      kind: 'spawned',
      sessionId: 'agent-1',
      cwd: '',
      toolNames: coding.tools
    })
    expect(vars.visualGuide).not.toContain(INTERACTIVE)
    expect(vars.visualGuide).toContain(POINTER)
    expect(vars.visualGuide).toContain(ADOPT)
  })

  it('PVW-15 组装出的提示：根会话里恰 work / chat / coding / bot 教交互块（tab 给了 chromeTab）；派生一个都不教', async () => {
    let checked = 0
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        for (const profile of builtins(language)) {
          mocks.pickSettings.mockReturnValue(
            profile.name === 'tab' ? CHROME_TAB : { notebookPath: 'notes/a.md' }
          )
          const root = renderProfileSystemPrompt(
            profile,
            await varsFor({ kind: 'root', toolNames: profile.tools })
          )
          const what = `${profile.name}.${language}`
          expect(root.includes(INTERACTIVE), `${what} root`).toBe(
            INTERACTIVE_PROFILES.includes(profile.name)
          )
          checked++

          if (profile.name === 'notebook' || profile.name === 'coedit') continue
          const spawned = renderProfileSystemPrompt(
            profile,
            await varsFor({
              kind: 'spawned',
              sessionId: 'agent-1',
              cwd: '',
              toolNames: profile.tools
            })
          )
          expect(spawned, `${what} spawned`).not.toContain(INTERACTIVE)
        }
      })
    }
    expect(checked, '一个档案都没查到就等于空转').toBeGreaterThan(20)
  })
})

describe('desktopPromptVars —— 契约只在技能里（PVW-16 / PVW-17）', () => {
  /** 引用了作图片段的那几个占位符 */
  const fragmentVarsOf = (profile: AgentProfile): string[] =>
    placeholdersOf(profile.systemPrompt).filter((n) =>
      (FRAGMENT_VARS as readonly string[]).includes(n)
    )

  it('PVW-16 每个引用作图片段的内置档案 × 三语言：名单去掉作图技能 → 两个值都是空串，引用处收敛干净', async () => {
    let checked = 0
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        for (const profile of builtins(language)) {
          const used = fragmentVarsOf(profile)
          if (used.length === 0) continue
          const what = `${profile.name}.${language}`
          const withSkill = await varsFor({ kind: 'root', toolNames: profile.tools })
          const without = await varsFor({
            kind: 'root',
            toolNames: profile.tools.filter((n) => n !== DRAWING)
          })
          const promptWith = renderProfileSystemPrompt(profile, withSkill)
          const out = renderProfileSystemPrompt(profile, without)
          for (const name of used) {
            expect(without[name], `${what}.${name}`).toBe('')
            // 正控制组：点了名时确实有内容、而且确实替换进了提示 —— 下面的「不在」才有意义
            expect(withSkill[name].length, `${what}.${name}`).toBeGreaterThan(0)
            expect(promptWith, `${what}.${name}`).toContain(withSkill[name])
            expect(out, `${what}.${name}`).not.toContain(withSkill[name])
          }
          // 空串占位符：没有裸占位符留下，也没有两段空行并成的三连换行
          expect(out, what).not.toContain('{{shuvix:')
          expect(out, what).not.toMatch(/\n{3,}/)
          expect(out, what).toBe(out.trim())
          expect(out, what).not.toContain(POINTER)
          checked++
        }
      })
    }
    // 七个档案（OWN-1 那份名单）× 三语言
    expect(checked, '一个引用作图片段的档案都没查到 —— 这条在空转').toBeGreaterThanOrEqual(21)
  })

  it('PVW-17 每个内置档案 × 三语言按自己的名单组装：提示里没有颜色 token、十六进制颜色、范例图 —— 这些只在技能里', async () => {
    let checked = 0
    let pointing = 0
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        for (const profile of builtins(language)) {
          const out = renderProfileSystemPrompt(
            profile,
            await varsFor({ kind: 'root', toolNames: profile.tools })
          )
          const what = `${profile.name}.${language}`
          // 从前常驻的 token 表、范例图如今一行都不该出现在任何一份组装好的提示里 ——
          // 片段不带，档案正文（例如 notebook 的「守作图技能里的预算」）也不该自己再抄一份
          expect(out, what).not.toMatch(/--(viz|theme)-/)
          expect(out, what).not.toMatch(/#[0-9a-f]{3,8}\b/i)
          expect(out, what).not.toContain(EXAMPLE)
          expect(out, what).not.toMatch(/<svg\b/i)
          if (out.includes(POINTER)) pointing++
          checked++
        }
      })
    }
    expect(checked, '一个档案都没查到就等于空转').toBeGreaterThan(20)
    // 正控制组：确实有档案拿到了作图说明（七个档案 × 三语言）
    expect(pointing).toBeGreaterThanOrEqual(21)
  })
})

/**
 * Shell 一行说的是**命令工具**跑在哪个 shell 里（模型据此选语法），不是用户的登录 shell —— 所以
 * `$SHELL` 一概不读；`shellTool` 是本平台命令工具的名字，档案正文用它指代「那个 shell 工具」。
 *
 *   | 平台             | shell                                         | shellTool    |
 *   | win32            | PowerShell 7 (pwsh) / Windows PowerShell 5.1  | powershell   |
 *   | darwin / linux   | bash                                          | bash         |
 *   | 其它             | unknown                                       | ''           |
 */
describe('desktopPromptVars —— shell / shellTool 按平台给（PVW-S1…S5）', () => {
  const REAL_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform')!
  const setPlatform = (platform: string): void => {
    Object.defineProperty(process, 'platform', { ...REAL_PLATFORM_DESC, value: platform })
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', REAL_PLATFORM_DESC)
    vi.unstubAllEnvs()
    mocks.psConfig = null
  })

  it('PVW-S1 darwin + SHELL=/bin/zsh：shell 是 bash（命令工具的 shell，不是登录 shell）', async () => {
    setPlatform('darwin')
    vi.stubEnv('SHELL', '/bin/zsh')
    const vars = await varsFor()
    expect(vars.shell).toBe('bash')
    expect(vars.shellTool).toBe('bash')
  })

  it('PVW-S2 linux、SHELL 没设：同样是 bash（从前这里是 unknown）', async () => {
    setPlatform('linux')
    vi.stubEnv('SHELL', undefined)
    const vars = await varsFor()
    expect(vars.shell).toBe('bash')
    expect(vars.shellTool).toBe('bash')
  })

  it('PVW-S3 ShuviX 不发布的平台（freebsd）：shell unknown、shellTool 空串', async () => {
    setPlatform('freebsd')
    vi.stubEnv('SHELL', '/usr/local/bin/bash')
    const vars = await varsFor()
    expect(vars.shell).toBe('unknown')
    expect(vars.shellTool).toBe('')
  })

  it('PVW-S4 win32 + pwsh 7：shell 说出版本、shellTool 是 powershell；混进来的 SHELL=/usr/bin/bash 不理', async () => {
    setPlatform('win32')
    vi.stubEnv('SHELL', '/usr/bin/bash')
    mocks.psConfig = { exe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', edition: 'pwsh' }
    const vars = await varsFor()
    expect(vars.shell).toBe('PowerShell 7 (pwsh)')
    expect(vars.shellTool).toBe('powershell')
  })

  it('PVW-S5 win32 + 系统自带的 5.1：shell 是 Windows PowerShell 5.1', async () => {
    setPlatform('win32')
    vi.stubEnv('SHELL', '/usr/bin/bash')
    mocks.psConfig = { exe: 'C:\\Windows\\powershell.exe', edition: 'windows-powershell' }
    const vars = await varsFor()
    expect(vars.shell).toBe('Windows PowerShell 5.1')
    expect(vars.shellTool).toBe('powershell')
  })

  it('PVW-S6 引用 shellTool 的档案组装出来：win32 上正文里说 powershell，darwin 上说 bash，都不留占位符', async () => {
    const work = builtins('en').find((p) => p.name === 'work')!
    expect(work.systemPrompt).toContain('{{shuvix:shellTool}}')

    setPlatform('win32')
    mocks.psConfig = { exe: 'C:\\pwsh.exe', edition: 'pwsh' }
    const onWindows = renderProfileSystemPrompt(work, await varsFor({ toolNames: work.tools }))
    expect(onWindows).not.toContain('{{shuvix:shellTool}}')
    expect(onWindows).toContain('over powershell')
    expect(onWindows).not.toMatch(/\bbash\b/)

    setPlatform('darwin')
    const onMac = renderProfileSystemPrompt(work, await varsFor({ toolNames: work.tools }))
    expect(onMac).toContain('over bash')
    expect(onMac).not.toMatch(/\bpowershell\b/i)
  })
})
