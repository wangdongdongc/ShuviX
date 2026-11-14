/**
 * 桌面提示词块的**接线**（`desktopPromptBlocks`）—— 钉几件事：
 *
 *  1. 内置档案在 `shuvix-prompt-blocks` 里点名的每一个随人设冻结的块（`document` / `drawing` / `environment`），
 *     这一端都交出了字符串（PBW-1 / PBW-2）。档案正文是纯文字：没有 `{{shuvix:*}}` 占位符，组装出的提示里也没有
 *     （PBW-11）。组装 = `composePersona(档案, 块)`：正文之后按固定次序追加选中且非空的块，各包在同名标签里。
 *  2. 作图说明（`drawing` 块）的两个开关按**这一个 agent 的归一工具名单**
 *     （`PromptBlocksCtx.toolNames`，与 resolveTools 收到的是同一份）判：
 *      - `drawingSkill`：名单里有技能工具 `skill` **且** skillService.findModelInvocable() 里有
 *        `builtin:drawing`（没在侧栏停用、也没写 `disable-model-invocation`）→ 才有这份说明（载体 +
 *        「本会话第一张图之前先加载技能」）；否则是空串，整块不出。2026-10-28 起档案
 *        不再逐个点名技能（`skill` 的货架是模型可调用的全部），会话勾选也不再有 `skill:` / `-skill:`。2026-09-24 起 svg 契约、框箭头预算与范例图只在技能里
 *        （用户裁决）：指一个拿不到的技能是死路，而契约不再有常驻的第二份；
 *      - `artifact`：名单里有 `artifact` → guide 教「改图走 adopt」（craft 没有载体，永远不教）。
 *     说明里提到的每样东西都得真在它手里 —— 派发出来的、覆盖了档案的、停用了技能的都一样。
 *     一个块名两种正文：手里有 `doc_edit` 的 agent（图往文件里画）拿 craft（只有「先加载」），其余拿 guide
 *     （带载体）。下面用 `drawingOf('guide' | 'craft', …)` 取两种：craft 就是名单里多一个 `doc_edit`。
 *
 *  3. 第三个开关 `interactive`（交互块那一段）**不看名单，看回复落在哪儿**：只有根 agent 的回复显示成
 *     一条对话（派生 agent 的回复是交回父 agent 的工具结果），而 Chrome 标签页会话显示在扩展侧栏里
 *     —— 那里的 CSP 跑不了它。所以：根 + 不是标签页会话 → 教；标签页会话 / 派生 → 不教（PBW-12…15）。
 *
 * 段落只凭代码记号认（三语一字不差）：POINTER `builtin:drawing`、EXAMPLE「```svg + 换行 + <svg」
 * （范例图的围栏 —— 如今只在技能里，提示里任何时候都不该有）、ADOPT `adopt`。
 *
 *  4. `document` 块（PBW-DK1…DK6）只给根会话的笔记本：「打开的文档」一行，文档是 ShuviX 文件时（按会话的
 *     **承载项目**判，chat-protocol `shuvixFileKindOfProject`）再接上那种文件的说明；说明书在不在取 knowledge 的
 *     `builtinManualDir()`，名单里有 `knowledge` 才指路；不是笔记本会话 → 空串，整块不出。
 *
 *  5. 临时目录（PBW-T1…T5）：组装出的环境清单里，工作目录那一行之后紧跟「临时文件」
 *     一行（目录来自注入的解析器，命令那半句只给名单里有 bash / powershell 的档案）；没有目录时那一行整行消失，
 *     清单中间不留空行；没点 `environment` 块或手里没有文件工具的档案不提它。
 *
 *  6. `extensions` 块（PBW-E1…E6）只对持有 `tool_search` 的 agent 说：列配置里有、这条
 *     会话没开的服务器（已在名单里的、用户取消的都不列）；没持有就不去问 configuredServers，值是空串。
 *
 * 编号沿用改名前 promptVarsWiring.test.ts 的 PVW-*（2026-11-13 变量表改成提示词块，前缀换成 PBW）；
 * 只为占位符替换机制与 `shellTool` 变量存在的用例已删。
 *
 * 其余 mock 只为让模块能加载（dao 会开 SQLite，
 * electron / mcp 在 node 下起不来）；skillService 必须桩成可控的 findModelInvocable —— 真服务的构造函数会去碰
 * 真实 HOME 下的 `~/.shuvix/skills`。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import type { PromptBlockTexts, PromptBlocksCtx } from '@shuvix/agent-runtime'
import type { Skill } from '../../types/skill'

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  pickSettings: vi.fn(),
  projectPick: vi.fn(),
  findEnabled: vi.fn(),
  findModelInvocable: vi.fn(),
  /** 配置里启用、配齐了的 MCP 服务器（`extensions` 块的候选）；每条用例复位成空 */
  configuredServers: vi.fn(),
  /** builtinManualDir 的答复：内置说明书当前语言那一版的目录（null = 这台机器上没有）；每条用例复位 */
  manualDir: '/fixture/knowledge/shuvix/en' as string | null,
  /** Windows 上解析出的 PowerShell 版本（PBW-S*）；null = 用真的 getPowerShellConfig */
  psConfig: null as null | { exe: string; edition: 'pwsh' | 'windows-powershell' }
}))

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
  skillService: { findEnabled: mocks.findEnabled, findModelInvocable: mocks.findModelInvocable }
}))
vi.mock('../../services/mcpService', () => ({
  mcpService: { configuredServers: mocks.configuredServers }
}))
vi.mock('../../services/instruction', () => ({ resolveInstructionContent: vi.fn() }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: {} }))
vi.mock('../../services/wrapToolOutput', () => ({ wrapDurableTool: vi.fn() }))
vi.mock('../../services/userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../services/sandbox', () => ({ sandboxGloballyActive: () => false }))
vi.mock('../../services/botService', () => ({ botService: { forSession: () => null } }))
vi.mock('../../utils/toolUtils/fileTime', () => ({ recordRead: vi.fn() }))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: {}
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: vi.fn(),
  resolveProjectConfig: vi.fn()
}))
vi.mock('../../services/knowledge', () => ({
  enabledBaseChoices: () => [],
  builtinManualDir: () => mocks.manualDir
}))
vi.mock('../AgentTool', () => ({ createAgentTool: vi.fn() }))
vi.mock('../../services/widget/widgetRegistry', () => ({
  widgetRegistry: {
    findById: (id: string) =>
      id === 'a-b' ? { id, name: 'Reading "list"', description: 'SECRET_WIDGET' } : undefined
  }
}))
vi.mock('../../utils/toolUtils/shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/toolUtils/shell')>()
  return {
    ...actual,
    getPowerShellConfig: () => mocks.psConfig ?? actual.getPowerShellConfig()
  }
})

import i18next from 'i18next'
import {
  BASE_PROFILE_NAMES,
  buildBuiltinProfiles,
  composePersona,
  fencePromptBlock,
  normalizeToolNames,
  renderDocumentBlock,
  renderDocumentKind,
  renderEnvironment,
  renderTempDirectory,
  type AgentProfile
} from '@shuvix/agent-runtime'
import type { ShuvixFileKind } from '@shuvix/chat-protocol/shuvixFileNotes'
import { createInlineMdReader } from '@shuvix/agent-runtime/builtinAgents/inlineSources'
import { desktopPromptBlocks, setSessionTempDirResolver } from '../agentHost'

const LANGUAGES = ['en', 'zh', 'ja']
const SID = 'sess-desktop-1'

/** 技能工具在名单里的写法（档案 `shuvix-tools` 写 `skill`） */
const SKILL = 'skill'
const POINTER = 'builtin:drawing'
const EXAMPLE = '```svg\n<svg'
const ADOPT = 'adopt'
/** `drawing` 块的两种正文：聊天里的（带载体）与改文档的 agent 的（只有「先加载」） */
const DRAWING_VARIANTS = ['guide', 'craft'] as const
type DrawingVariant = (typeof DRAWING_VARIANTS)[number]
/** 随人设冻结、由档案点名的三块 */
const PERSONA_BLOCKS = ['document', 'drawing', 'environment'] as const
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

/** 文本里的 `{{shuvix:name}}` 名字（去重排序）—— 正文已是纯文字，任何地方都不该再有 */
const placeholdersOf = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{\{shuvix:([A-Za-z][\w-]*)\}\}/g)].map((m) => m[1]))].sort()

const countOf = (text: string, needle: string): number => text.split(needle).length - 1

/** 桌面这一端供全部内置档案（含派生用的 coding / explore / titler …），不只四个基座 */
const builtins = (language: string): AgentProfile[] =>
  buildBuiltinProfiles({ language, readMd: createInlineMdReader() })

const blocksFor = async (ctx: Partial<PromptBlocksCtx> = {}): Promise<PromptBlockTexts> => {
  return await desktopPromptBlocks({
    sessionId: SID,
    kind: 'root',
    cwd: '/w/proj',
    toolNames: [],
    ...ctx
  })
}

/** `drawing` 块的正文；craft = 同一份名单再加 `doc_edit`（改文档的 agent） */
const drawingOf = async (
  variant: DrawingVariant,
  ctx: Partial<PromptBlocksCtx> = {}
): Promise<string> => {
  const toolNames = [...(ctx.toolNames ?? []), ...(variant === 'craft' ? ['doc_edit'] : [])]
  const { drawing } = await blocksFor({ ...ctx, toolNames })
  expect(drawing, `drawing(${variant}) 应当是字符串`).toBeTypeOf('string')
  return drawing!
}

/** 按档案自己的名单组装出的人设（正文 + 块） */
const personaOf = async (
  profile: AgentProfile,
  ctx: Partial<PromptBlocksCtx> = {}
): Promise<{ out: string; blocks: PromptBlockTexts }> => {
  const blocks = await blocksFor({ kind: 'root', toolNames: profile.tools, ...ctx })
  return { out: composePersona(profile, blocks), blocks }
}

/**
 * 在某个界面语言下跑一段 —— 块按 `i18next.language` 挑片段语言，与档案正文同语言才是
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
  mocks.findModelInvocable.mockReset()
  mocks.configuredServers.mockReset()
  mocks.configuredServers.mockReturnValue([])
  // 缺省：内置作图技能随包在架、没被停用、模型可调用
  mocks.findEnabled.mockReturnValue([BUILTIN])
  mocks.findModelInvocable.mockReturnValue([BUILTIN])
  mocks.manualDir = '/fixture/knowledge/shuvix/en'
})

describe('desktopPromptBlocks —— 档案点名的块都交得出', () => {
  it('PBW-1 内置档案点名的每个随人设冻结的块，根会话都交出了字符串；正文里没有占位符', async () => {
    const blocks = await blocksFor({ kind: 'root' })
    const profiles = LANGUAGES.flatMap((l) => builtins(l))
    const needed = new Set(
      profiles.flatMap((p) =>
        p.promptBlocks.filter((b) => (PERSONA_BLOCKS as readonly string[]).includes(b))
      )
    )
    expect([...needed].sort(), '语料自检：三块都应当有档案点名').toEqual([...PERSONA_BLOCKS])
    for (const name of PERSONA_BLOCKS) {
      expect(blocks[name], `缺 ${name} 块`).toBeTypeOf('string')
    }
    // 跟着 tool_search 走、不在词表里的那一块同样是字符串
    expect(blocks.extensions).toBeTypeOf('string')
    // 正文是纯文字：留着占位符就会原样发给模型
    for (const profile of profiles) {
      expect(placeholdersOf(profile.systemPrompt), profile.name).toEqual([])
    }
  })

  it('PBW-2 派生 agent：同样齐全；document 是空串（派生 ctx.sessionId 是 agentId，解析不出会话的文档）', async () => {
    const blocks = await blocksFor({ kind: 'spawned', cwd: '' })
    for (const name of PERSONA_BLOCKS) {
      expect(blocks[name], `缺 ${name} 块`).toBeTypeOf('string')
    }
    expect(blocks.document).toBe('')
  })
})

describe('desktopPromptBlocks —— 作图说明按这个 agent 的名单开关', () => {
  const LISTS: string[][] = [[], [SKILL], ['artifact'], [SKILL, 'artifact']]

  it('PBW-3 四种名单：技能在架时 guide 是自含块（自带小标题）、craft 恰好一段，都已 trim；技能不在名单上时两种都是空串', async () => {
    for (const toolNames of LISTS) {
      const hasSkill = toolNames.includes(SKILL)
      const texts = {
        guide: await drawingOf('guide', { toolNames }),
        craft: await drawingOf('craft', { toolNames })
      }
      for (const variant of DRAWING_VARIANTS) {
        const what = `${variant} ${JSON.stringify(toolNames)}`
        expect(texts[variant], what).toBe(texts[variant].trim())
        // 契约只在技能里：技能不在，整份说明不出（空串 → 整块不出，见 PBW-16）
        if (!hasSkill) expect(texts[variant], what).toBe('')
        else expect(texts[variant].length, what).toBeGreaterThan(0)
      }
      if (hasSkill) {
        const what = JSON.stringify(toolNames)
        expect(texts.guide.startsWith('#'), what).toBe(true)
        expect(texts.guide.length, what).toBeGreaterThan(200)
        // craft 只是一段（「先加载技能」）
        expect(texts.craft.split(/\n[ \t]*\n/), what).toHaveLength(1)
      }
    }
  })

  it('PBW-4 名单有技能工具且作图技能在架 → 两种都恰好一句指路，范例图不在提示里', async () => {
    // 缺省 ctx 是桌面根会话 → guide 连交互段一起给；交互段也指向技能，但不重复点名
    expect(await drawingOf('guide', { toolNames: [SKILL] })).toContain('```interactive')
    for (const variant of DRAWING_VARIANTS) {
      const text = await drawingOf(variant, { toolNames: [SKILL] })
      expect(countOf(text, POINTER), variant).toBe(1)
      expect(text, variant).not.toContain(EXAMPLE)
    }
  })

  it('PBW-5 名单有 skill 但作图技能在侧栏停用，或启用着却只许用户调用（findModelInvocable 都没有它）→ 两种都是空串（连 `builtin:` 都不提），手里有 artifact 也一样', async () => {
    mocks.findEnabled.mockReturnValue([])
    mocks.findModelInvocable.mockReturnValue([])
    for (const variant of DRAWING_VARIANTS) {
      expect(await drawingOf(variant, { toolNames: [SKILL, 'artifact'] }), variant).toBe('')
    }

    // disable-model-invocation：findEnabled 里有它，货架上（findModelInvocable）没有 —— 按货架判
    mocks.findEnabled.mockReturnValue([BUILTIN])
    for (const variant of DRAWING_VARIANTS) {
      expect(await drawingOf(variant, { toolNames: [SKILL, 'artifact'] }), variant).toBe('')
    }
  })

  it('PBW-6 名单里没有技能工具（作图技能照样在架）→ 两种都是空串；而且根本不去扫技能目录', async () => {
    for (const variant of DRAWING_VARIANTS) {
      expect(await drawingOf(variant, { toolNames: [] }), variant).toBe('')
    }
    // titler、explore 这些 agent 走这条短路：名单里没有就不碰文件系统
    expect(mocks.findEnabled).not.toHaveBeenCalled()
    expect(mocks.findModelInvocable).not.toHaveBeenCalled()
  })

  it('PBW-7 按全局名精确匹配：架上只有用户的 `drawing` 顶替不了 `builtin:drawing`；名单里只有旧写法 `skill:builtin:drawing`（没有 `skill`）也不算', async () => {
    mocks.findModelInvocable.mockReturnValue([USER_DRAWING])
    for (const variant of DRAWING_VARIANTS) {
      expect(await drawingOf(variant, { toolNames: [SKILL] }), variant).toBe('')
    }

    mocks.findModelInvocable.mockReturnValue([BUILTIN])
    for (const variant of DRAWING_VARIANTS) {
      expect(await drawingOf(variant, { toolNames: ['skill:builtin:drawing'] }), variant).toBe('')
    }
  })

  it('PBW-8 技能在架且手里有 artifact 才教 adopt（只在 guide 里）；craft 无论名单如何都不教', async () => {
    expect(await drawingOf('guide', { toolNames: [SKILL, 'artifact'] })).toContain(ADOPT)
    expect(await drawingOf('guide', { toolNames: [SKILL] })).not.toContain(ADOPT)
    // 只有 artifact、没有技能：整份说明都不出，adopt 不会单独冒出来
    expect(await drawingOf('guide', { toolNames: ['artifact'] })).toBe('')
    for (const toolNames of LISTS) {
      expect(await drawingOf('craft', { toolNames }), JSON.stringify(toolNames)).not.toContain(
        ADOPT
      )
    }
  })

  it('PBW-9 派生 agent 按它自己的名单判：coding 被派发出来时同样拿到指路与 adopt', async () => {
    // 若哪天有人把作图说明塞进 ctx.kind === 'root' 分支（document 块就在紧邻几行），
    // 或只按 root 判开关，派发出来的 coding 会拿到一份与它工具表对不上的说明
    const coding = builtins('en').find((p) => p.name === 'coding')!
    expect(coding.tools).toContain(SKILL)
    const drawing = await drawingOf('guide', {
      kind: 'spawned',
      sessionId: 'agent-1',
      cwd: '',
      toolNames: coding.tools
    })
    expect(drawing).toContain(POINTER)
    expect(drawing).toContain(ADOPT)
  })

  it('PBW-9b 一个块名两种正文：名单里有 doc_edit（改文档的 agent）拿 craft，没有的拿 guide', async () => {
    const guide = await drawingOf('guide', { toolNames: [SKILL, 'artifact'] })
    const craft = await drawingOf('craft', { toolNames: [SKILL, 'artifact'] })
    expect(craft).not.toBe(guide)
    // 载体那段（「回复里的 ```svg 围栏会内联渲染」）只在 guide 里
    expect(guide).toContain('```svg ')
    expect(craft).not.toContain('```svg ')
    // notebook 的名单真有 doc_edit —— 上面的 craft 就是它拿到的那一种
    const notebook = builtins('en').find((p) => p.name === 'notebook')!
    expect(notebook.tools).toContain('doc_edit')
    expect((await blocksFor({ toolNames: notebook.tools })).drawing).toBe(
      await drawingOf('craft', { toolNames: [SKILL] })
    )
  })
})

describe('desktopPromptBlocks —— 按档案自己的名单组装出的系统提示', () => {
  it('PBW-10 每个内置档案 × 三语言：点名的块真追加在正文之后；指路恰在点了 drawing 块且带技能工具的档案里，adopt 恰在 work/chat/coding/bot', async () => {
    let checked = 0
    let appended = 0
    /** 自检：三种界面语言下供的片段各不相同 —— 否则「× 三语言」只是把英文那份查了三遍 */
    const guides = new Set<string>()
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        for (const profile of builtins(language)) {
          const { out, blocks } = await personaOf(profile)
          const what = `${profile.name}.${language}`
          expect(out.startsWith(profile.systemPrompt.trim()), `${what} 正文原样在最前`).toBe(true)
          const drawing = blocks.drawing ?? ''
          if (profile.promptBlocks.includes('drawing') && drawing) {
            // 点了名、有内容，就必须真的追加在提示里（包在同名标签里）
            expect(out, `${what}.drawing`).toContain(fencePromptBlock('drawing', drawing))
            appended++
          } else {
            expect(out, `${what}.drawing`).not.toContain('<drawing>')
          }
          expect(out.includes(POINTER), `${what} 的指路`).toBe(
            profile.promptBlocks.includes('drawing') && profile.tools.includes(SKILL)
          )
          expect(out.includes(ADOPT), `${what} 的 adopt`).toBe(
            ADOPT_PROFILES.includes(profile.name)
          )
          if (profile.name === 'work') guides.add(drawing)
          checked++
        }
      })
    }
    expect(checked, '一个档案都没查到就等于空转').toBeGreaterThan(20)
    expect(appended, '没有任何档案拿到作图块 —— 接线断了或档案不再点名').toBeGreaterThan(0)
    expect(guides.size, '界面语言没切过去：片段一直是同一份').toBe(3)
  })

  it.each(['root', 'spawned'] as const)(
    'PBW-11 kind=%s：每个内置档案 × 三语言组装出来没有占位符，界桩也不漏进提示',
    async (kind) => {
      let checked = 0
      for (const language of LANGUAGES) {
        await inLanguage(language, async () => {
          for (const profile of builtins(language)) {
            const { out } = await personaOf(profile, {
              kind,
              cwd: kind === 'root' ? '/w/proj' : ''
            })
            const what = `${profile.name}.${language}`
            expect(out, what).not.toContain('{{shuvix:')
            expect(placeholdersOf(out), what).toEqual([])
            expect(out, what).not.toContain('<!-- shuvix:')
            expect(out, what).not.toMatch(/\n{3,}/)
            checked++
          }
        })
      }
      expect(checked, '一个档案都没查到就等于空转').toBeGreaterThan(20)
    }
  )
})

describe('desktopPromptBlocks —— 交互块按回复落在哪儿给（PBW-12…15）', () => {
  const INTERACTIVE = '```interactive'
  /** 载体段那句「回复里的 ```svg 围栏会内联渲染」的记号（```svg + 空格） */
  const CARRIER = '```svg '
  /** 一条 Chrome 标签页会话的 settings（字段齐全，chromeTabOf 认它） */
  const CHROME_TAB = { chromeTab: { installId: 'i', runId: 'r', tabId: 7 } }
  /** 拿 guide 那一种、在桌面根会话里就该教交互块的档案 */
  const INTERACTIVE_PROFILES = ['bot', 'chat', 'coding', 'work']

  it('PBW-12 桌面会话的根 agent：作图技能在架才教交互块（契约在技能里、不常驻），craft 从不教', async () => {
    const guide = await drawingOf('guide', { kind: 'root', toolNames: [SKILL, 'artifact'] })
    expect(guide).toContain(INTERACTIVE)
    expect(guide).toContain('references/interactive.md')
    expect(guide).not.toContain('shuvix-lib://')
    expect(
      await drawingOf('craft', { kind: 'root', toolNames: [SKILL, 'artifact'] })
    ).not.toContain(INTERACTIVE)
    for (const toolNames of [[], ['read'], ['artifact']]) {
      const what = JSON.stringify(toolNames)
      for (const variant of DRAWING_VARIANTS) {
        expect(await drawingOf(variant, { kind: 'root', toolNames }), what).not.toContain(
          INTERACTIVE
        )
      }
    }
  })

  it('PBW-13 Chrome 标签页会话的根：不教交互块（侧栏的 CSP 跑不了它），svg 载体照旧在', async () => {
    mocks.pickSettings.mockReturnValue(CHROME_TAB)
    const drawing = await drawingOf('guide', { kind: 'root', toolNames: [SKILL] })
    expect(drawing).not.toContain(INTERACTIVE)
    expect(drawing).not.toContain('shuvix-lib://')
    expect(drawing).toContain(CARRIER)
    // 反证：同一份 ctx 换成普通会话就教 —— 上面的「不教」确实是 chromeTab 带来的
    mocks.pickSettings.mockReturnValue({})
    expect(await drawingOf('guide', { kind: 'root', toolNames: [SKILL] })).toContain(INTERACTIVE)
  })

  it('PBW-14 派生 agent（coding 的名单）：不教交互块，但指路与 adopt 照旧按名单给', async () => {
    const coding = builtins('en').find((p) => p.name === 'coding')!
    const drawing = await drawingOf('guide', {
      kind: 'spawned',
      sessionId: 'agent-1',
      cwd: '',
      toolNames: coding.tools
    })
    expect(drawing).not.toContain(INTERACTIVE)
    expect(drawing).toContain(POINTER)
    expect(drawing).toContain(ADOPT)
  })

  it('PBW-15 组装出的提示：根会话里恰 work / chat / coding / bot 教交互块（tab 给了 chromeTab）；派生一个都不教', async () => {
    let checked = 0
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        for (const profile of builtins(language)) {
          mocks.pickSettings.mockReturnValue(
            profile.name === 'tab' ? CHROME_TAB : { notebookPath: 'notes/a.md' }
          )
          const { out: root } = await personaOf(profile)
          const what = `${profile.name}.${language}`
          expect(root.includes(INTERACTIVE), `${what} root`).toBe(
            INTERACTIVE_PROFILES.includes(profile.name)
          )
          checked++

          const { out: spawned } = await personaOf(profile, {
            kind: 'spawned',
            sessionId: 'agent-1',
            cwd: ''
          })
          expect(spawned, `${what} spawned`).not.toContain(INTERACTIVE)
        }
      })
    }
    expect(checked, '一个档案都没查到就等于空转').toBeGreaterThan(20)
  })
})

describe('desktopPromptBlocks —— 契约只在技能里（PBW-16 / PBW-17）', () => {
  it('PBW-16 每个点了 drawing 块的内置档案 × 三语言：名单去掉技能工具 → 块是空串，提示里整块不出', async () => {
    let checked = 0
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        for (const profile of builtins(language)) {
          if (!profile.promptBlocks.includes('drawing')) continue
          const what = `${profile.name}.${language}`
          const withSkill = await personaOf(profile)
          const without = await personaOf(profile, {
            toolNames: profile.tools.filter((n) => n !== SKILL)
          })
          expect(without.blocks.drawing, what).toBe('')
          // 正控制组：带着技能工具时确实有内容、而且确实追加进了提示 —— 下面的「不在」才有意义
          const drawing = withSkill.blocks.drawing ?? ''
          expect(drawing.length, what).toBeGreaterThan(0)
          expect(withSkill.out, what).toContain(fencePromptBlock('drawing', drawing))
          expect(without.out, what).not.toContain(drawing)
          // 空块：不留空标签，也没有两段空行并成的三连换行
          expect(without.out, what).not.toContain('<drawing>')
          expect(without.out, what).not.toMatch(/\n{3,}/)
          expect(without.out, what).toBe(without.out.trim())
          expect(without.out, what).not.toContain(POINTER)
          checked++
        }
      })
    }
    // 六个档案（work / chat / coding / bot / notebook / tab）× 三语言
    expect(checked, '一个点了 drawing 块的档案都没查到 —— 这条在空转').toBeGreaterThanOrEqual(18)
  })

  it('PBW-17 每个内置档案 × 三语言按自己的名单组装：提示里没有颜色 token、十六进制颜色、范例图 —— 这些只在技能里', async () => {
    let checked = 0
    let pointing = 0
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        for (const profile of builtins(language)) {
          const { out } = await personaOf(profile)
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
    // 正控制组：确实有档案拿到了作图说明（六个档案 × 三语言）
    expect(pointing).toBeGreaterThanOrEqual(18)
  })
})

/**
 * Shell 一行说的是**命令工具**跑在哪个 shell 里（模型据此选语法），不是用户的登录 shell —— 所以
 * `$SHELL` 一概不读。这一行只给手里有 bash / powershell 的 agent。
 *
 *   | 平台             | Shell 一行                                    |
 *   | win32            | PowerShell 7 (pwsh) / Windows PowerShell 5.1  |
 *   | darwin / linux   | bash                                          |
 *   | 其它             | unknown                                       |
 */
describe('desktopPromptBlocks —— Shell 一行按平台给（PBW-S1…S5）', () => {
  const REAL_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform')!
  const setPlatform = (platform: string): void => {
    Object.defineProperty(process, 'platform', { ...REAL_PLATFORM_DESC, value: platform })
  }
  /** 环境清单里 Shell 那一行的值；没有那一行 → undefined */
  const shellOf = async (toolNames: string[]): Promise<string | undefined> => {
    const head = '- Shell: '
    const { environment } = await blocksFor({ toolNames })
    return environment
      ?.split('\n')
      .find((line) => line.startsWith(head))
      ?.slice(head.length)
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', REAL_PLATFORM_DESC)
    vi.unstubAllEnvs()
    mocks.psConfig = null
  })

  it('PBW-S1 darwin + SHELL=/bin/zsh：Shell 是 bash（命令工具的 shell，不是登录 shell）；名单里没有命令工具就没有这一行', async () => {
    setPlatform('darwin')
    vi.stubEnv('SHELL', '/bin/zsh')
    expect(await shellOf(['bash'])).toBe('bash')
    // 没有 bash / powershell 的 agent（bot、tab …）不被告知 Shell
    expect(await shellOf([])).toBeUndefined()
    expect(await shellOf(['read', 'write'])).toBeUndefined()
  })

  it('PBW-S2 linux、SHELL 没设：同样是 bash（从前这里是 unknown）', async () => {
    setPlatform('linux')
    vi.stubEnv('SHELL', undefined)
    expect(await shellOf(['bash'])).toBe('bash')
  })

  it('PBW-S3 ShuviX 不发布的平台（freebsd）：Shell unknown', async () => {
    setPlatform('freebsd')
    vi.stubEnv('SHELL', '/usr/local/bin/bash')
    expect(await shellOf(['bash'])).toBe('unknown')
  })

  it('PBW-S4 win32 + pwsh 7：Shell 说出版本；混进来的 SHELL=/usr/bin/bash 不理', async () => {
    setPlatform('win32')
    vi.stubEnv('SHELL', '/usr/bin/bash')
    mocks.psConfig = { exe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', edition: 'pwsh' }
    expect(await shellOf(['powershell'])).toBe('PowerShell 7 (pwsh)')
  })

  it('PBW-S5 win32 + 系统自带的 5.1：Shell 是 Windows PowerShell 5.1', async () => {
    setPlatform('win32')
    vi.stubEnv('SHELL', '/usr/bin/bash')
    mocks.psConfig = { exe: 'C:\\Windows\\powershell.exe', edition: 'windows-powershell' }
    expect(await shellOf(['powershell'])).toBe('Windows PowerShell 5.1')
  })
})

/**
 * H11-62（P1-11）—— 锁在冻结人设时交给宿主的名单，是 `normalizeToolNames('root', 档案, 会话勾选)`
 * 这一份（与 resolveAgentTools 收到的同一份）。按这个形态喂进去，作图指路 / adopt / 交互块与 document 块
 * 都照旧。
 */
describe('desktopPromptBlocks —— 锁的名单形态（H11-62）', () => {
  it('H11-62 work 名单 + 勾选 [mcp:ssh, skill:pdf]：skill:pdf 不进名单（技能不按会话勾选），名单有 skill；指路恰一次、教 adopt、根会话教交互块；document 块按会话给，派生不给', async () => {
    const work = builtins('en').find((p) => p.name === 'work')!
    const toolNames = normalizeToolNames('root', work.tools, ['mcp:ssh', 'skill:pdf'])
    expect(toolNames).toContain('mcp:ssh')
    expect(toolNames).toContain(SKILL)
    expect(toolNames).not.toContain('skill:pdf')

    mocks.pickSettings.mockReturnValue({})
    const root = await blocksFor({ kind: 'root', toolNames })
    expect(countOf(root.drawing!, POINTER)).toBe(1)
    expect(root.drawing).toContain(ADOPT)
    expect(root.drawing).toContain('```interactive')
    // 不是笔记本会话：没有打开的文档，整块不出
    expect(root.document).toBe('')

    mocks.pickSettings.mockReturnValue({ notebookPath: 'notes/a.md' })
    expect((await blocksFor({ kind: 'root', toolNames })).document).toBe(
      renderDocumentBlock('en', { path: 'notes/a.md' })
    )
    expect(renderDocumentBlock('en', { path: 'notes/a.md' })).toContain('`notes/a.md`')

    const spawned = await blocksFor({ kind: 'spawned', sessionId: 'agent-1', cwd: '', toolNames })
    expect(spawned.document).toBe('')
  })

  it('H11-62b 会话勾选里旧的取消记号 [-skill:builtin:drawing] 不再起作用：名单照样有 skill、指路恰一次；作图说明只跟侧栏走 —— 内置作图技能停用了才整段为空', async () => {
    const work = builtins('en').find((p) => p.name === 'work')!
    expect(work.tools).toContain(SKILL)
    const toolNames = normalizeToolNames('root', work.tools, ['-skill:builtin:drawing'])
    expect(toolNames).toContain(SKILL)
    expect(toolNames).toEqual(normalizeToolNames('root', work.tools, []))
    mocks.pickSettings.mockReturnValue({})

    const stale = await blocksFor({ kind: 'root', toolNames })
    expect(countOf(stale.drawing!, POINTER)).toBe(1)

    // 拿掉作图说明的路径是侧栏：内置作图技能停用（findModelInvocable 不再给它）
    mocks.findEnabled.mockReturnValue([])
    mocks.findModelInvocable.mockReturnValue([])
    const disabled = await blocksFor({ kind: 'root', toolNames })
    expect(disabled.drawing).toBe('')
  })
})

/**
 * `document` 块（PBW-DK1…DK6）—— 笔记本会话打开的是哪份文档；文档是 ShuviX 文件时再说这是什么文件、规范在说明书哪一条。
 * 判定按会话的承载项目（sessionDao.pick 的 projectId），说明书在不在取 knowledge 的 builtinManualDir()（替身
 * 给 `/fixture/knowledge/shuvix/en`），名单里有 `knowledge` 才指路 —— 2026-11-08 起按条目名经 `knowledge` 读，
 * 目录从不进提示词。会话的 notebookPath 缺省是 `notes/a.md`（见 beforeEach）。
 */
describe('desktopPromptBlocks —— 打开的文档与它是哪种 ShuviX 文件（PBW-DK）', () => {
  const MANUAL = '/fixture/knowledge/shuvix/en'
  const PATH = 'notes/a.md'
  /** 承载项目 → 种类 → 说明书条目（显式抄一份：这里钉的是接线，不复用被测的判定） */
  const CARRIERS: Array<[projectId: string, kind: ShuvixFileKind, files: string[]]> = [
    ['__bots__', 'bot', ['bot-md.md']],
    ['__agents__', 'agent', ['agent-md.md']],
    ['__agents_builtin__', 'agent', ['agent-md.md']],
    ['__policies__', 'policy', ['policy-md.md', 'network-policy.md', 'redaction.md']],
    ['__policies_builtin__', 'policy', ['policy-md.md', 'network-policy.md', 'redaction.md']],
    ['__hooks__', 'hook', ['hook-md.md']],
    ['__hooks_builtin__', 'hook', ['hook-md.md']],
    ['__skills__', 'skill', ['skills.md']],
    ['__skills_builtin__', 'skill', ['skills.md']],
    ['__skills:ext__', 'skill', ['skills.md']],
    ['__knowledge__', 'knowledge', ['knowledge-entry.md']],
    ['__knowledge_user__', 'knowledge', ['knowledge-entry.md']],
    ['__knowledge_builtin__', 'knowledge', ['knowledge-entry.md']]
  ]
  const WITH_READ = ['doc_read', 'read', 'knowledge', 'skill']
  /** 只有「打开的文档」一行、没有种类说明的块 */
  const OPEN_ONLY = renderDocumentBlock('en', { path: PATH })
  /** 块里「打开的文档」那一行之后的部分（种类说明） */
  const kindGuideOf = (document: string): string => {
    expect(document.startsWith(`${OPEN_ONLY}\n\n`), '应当以「打开的文档」一行开头').toBe(true)
    return document.slice(OPEN_ONLY.length + 2)
  }

  it.each(CARRIERS)(
    'PBW-DK1 根会话、名单有 knowledge，承载项目 %s → %s：打开的文档一行 + 自带小标题的种类说明、按条目名点到说明书、不带目录、与片段直接渲染逐字相同；按本会话查 projectId',
    async (projectId, kind, files) => {
      mocks.pick.mockReturnValue({ projectId })
      const { document } = await blocksFor({ kind: 'root', toolNames: WITH_READ })
      const guide = kindGuideOf(document!)
      expect(guide.startsWith('## ')).toBe(true)
      for (const file of files) expect(guide).toContain(`\`/${file}\``)
      expect(document).not.toContain(MANUAL)
      expect(document).toBe(
        renderDocumentBlock('en', {
          path: PATH,
          kindGuide: renderDocumentKind('en', { kind, manual: true, knowledge: true })
        })
      )
      expect(mocks.pick).toHaveBeenCalledWith(SID, expect.arrayContaining(['projectId']))
    }
  )

  it.each([
    ['普通项目', { projectId: 'proj-1' }],
    ['无项目', { projectId: null }],
    ['会话行不存在', undefined],
    ['日报', { projectId: '__daily__' }],
    ['跟踪项', { projectId: '__tracking__' }]
  ])(
    'PBW-DK2 不是 ShuviX 文件（%s）→ 块里只有「打开的文档」一行，没有种类说明',
    async (_label, row) => {
      mocks.pick.mockReturnValue(row)
      const { document } = await blocksFor({ kind: 'root', toolNames: WITH_READ })
      expect(document).toBe(OPEN_ONLY)
      expect(document).toContain(`\`${PATH}\``)
    }
  )

  it('PBW-DK2b 不是笔记本会话（没有 notebookPath）→ 空串，承载项目再像也一样', async () => {
    mocks.pick.mockReturnValue({ projectId: '__policies__' })
    mocks.pickSettings.mockReturnValue({})
    expect((await blocksFor({ kind: 'root', toolNames: WITH_READ })).document).toBe('')
  })

  it('PBW-DK3 名单没有 knowledge，或这台机器上没有说明书 → 仍说这是什么文件，但不指路', async () => {
    mocks.pick.mockReturnValue({ projectId: '__policies__' })
    const withoutRead = kindGuideOf(
      (await blocksFor({ kind: 'root', toolNames: ['doc_read', 'doc_edit', 'read'] })).document!
    )
    expect(withoutRead.startsWith('## ')).toBe(true)
    expect(withoutRead).not.toContain('/policy-md.md')
    expect(withoutRead).not.toContain('<<manual>>')

    mocks.manualDir = null
    const noManual = kindGuideOf(
      (await blocksFor({ kind: 'root', toolNames: WITH_READ })).document!
    )
    expect(noManual.startsWith('## ')).toBe(true)
    expect(noManual).not.toContain('/policy-md.md')
    expect(noManual).not.toContain('<<manual>>')
    // 两种缺席是同一个结果：「不指一份读不到的文件」
    expect(noManual).toBe(withoutRead)
  })

  it('PBW-DK4 派生 agent：document 块是空串（派生 ctx.sessionId 是 agentId），承载项目再像也一样', async () => {
    mocks.pick.mockReturnValue({ projectId: '__policies__' })
    const blocks = await blocksFor({
      kind: 'spawned',
      sessionId: 'agent-1',
      cwd: '',
      toolNames: WITH_READ
    })
    expect(blocks.document).toBe('')
  })

  it('PBW-DK5 界面语言 zh：取中文那一版的片段，说明书照旧按条目名点', async () => {
    mocks.pick.mockReturnValue({ projectId: '__hooks__' })
    const { document } = await inLanguage('zh', () =>
      blocksFor({ kind: 'root', toolNames: WITH_READ })
    )
    expect(document).toBe(
      renderDocumentBlock('zh', {
        path: PATH,
        kindGuide: renderDocumentKind('zh', { kind: 'hook', manual: true, knowledge: true })
      })
    )
    expect(document).toContain('\n\n## 这份文档是什么')
    expect(document).toContain('`/hook-md.md`')
    expect(document).not.toContain(MANUAL)
  })

  it('PBW-DK6 notebook 档案 × 三语言组装：document 块紧跟在正文之后、排在别的块之前；ShuviX 文件带种类说明，不是则只有「打开的文档」一行', async () => {
    let checked = 0
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        const notebook = builtins(language).find((p) => p.name === 'notebook')!
        expect(notebook.promptBlocks, language).toContain('document')
        const body = notebook.systemPrompt.trim()

        mocks.pick.mockReturnValue({ projectId: '__policies__' })
        const carrier = await personaOf(notebook)
        const open = renderDocumentBlock(language, { path: PATH })
        expect(carrier.blocks.document, language).not.toBe(open)
        expect(carrier.blocks.document!.startsWith(`${open}\n\n`), language).toBe(true)
        expect(
          carrier.out.startsWith(
            `${body}\n\n${fencePromptBlock('document', carrier.blocks.document!)}\n\n<`
          ),
          language
        ).toBe(true)
        expect(carrier.out, language).not.toContain('{{shuvix:')
        expect(carrier.out, language).not.toMatch(/\n{3,}/)

        mocks.pick.mockReturnValue({ projectId: 'proj-1' })
        const plain = await personaOf(notebook)
        expect(plain.blocks.document, language).toBe(open)
        expect(
          plain.out.startsWith(`${body}\n\n${fencePromptBlock('document', open)}\n\n<`),
          language
        ).toBe(true)
        expect(plain.out, language).not.toContain('{{shuvix:')
        expect(plain.out, language).not.toMatch(/\n{3,}/)
        checked++
      })
    }
    expect(checked).toBe(3)
  })
  it('PBW-18 document 块要过两道门：宿主给不给（是不是笔记本会话）、档案点没点 —— 缺一道都没有 <document>，也不留空标签', async () => {
    // (a) 笔记本会话、宿主给了正文，档案没点 document → 人设里没有这一块
    const blocks = await blocksFor({ kind: 'root', toolNames: ['read'] })
    expect(blocks.document).toBe(OPEN_ONLY)
    const unlisted = composePersona({ systemPrompt: 'B', promptBlocks: ['environment'] }, blocks)
    expect(unlisted).not.toContain('<document>')
    expect(unlisted).not.toContain(PATH)
    expect(unlisted.startsWith('B\n\n<environment>\n')).toBe(true)
    // 正控制组：同一份正文，点了名就有
    expect(
      composePersona({ systemPrompt: 'B', promptBlocks: ['document', 'environment'] }, blocks)
    ).toContain(fencePromptBlock('document', OPEN_ONLY))

    // (b) 内置的 work 档案（没点 document）落在同一条笔记本形态的会话上
    const work = builtins('en').find((profile) => profile.name === 'work')!
    expect(work.promptBlocks).not.toContain('document')
    const onNotebook = await personaOf(work)
    expect(onNotebook.blocks.document).toBe(OPEN_ONLY)
    expect(onNotebook.out).not.toContain('<document>')
    expect(onNotebook.out).not.toContain(OPEN_ONLY)

    // (c) 不是笔记本会话、档案点了 document → 整块不出（不是空标签），也不留三连换行
    mocks.pickSettings.mockReturnValue({})
    const plain = await blocksFor({ kind: 'root', toolNames: ['read'] })
    expect(plain.document).toBe('')
    const listed = composePersona(
      { systemPrompt: 'B', promptBlocks: ['document', 'environment'] },
      plain
    )
    expect(listed).not.toContain('<document')
    expect(listed).not.toContain('</document>')
    expect(listed).not.toMatch(/\n{3,}/)
    expect(listed.startsWith('B\n\n<environment>\n')).toBe(true)
  })
})

describe('desktopPromptBlocks —— 可以申请开启的扩展（PBW-E）', () => {
  const mcpServer = (
    name: string,
    type: 'stdio' | 'inproc' = 'stdio'
  ): Record<string, unknown> => ({
    id: `id-${name}`,
    name,
    type,
    command: 'npx',
    args: '[]',
    env: '{}',
    url: '',
    headers: '{}',
    cachedTools: JSON.stringify([{ name: 'take', description: 'SECRET_DESCRIPTION' }])
  })

  it('PBW-E1 持有 tool_search：列出没开的服务器（内置带说明、第三方只有名字），不带第三方的描述', async () => {
    mocks.configuredServers.mockReturnValue([mcpServer('notes'), mcpServer('browser', 'inproc')])
    const { extensions } = await blocksFor({ toolNames: ['tool_search'] })
    expect(extensions).toContain('`notes`')
    expect(extensions).toContain('`browser`: ')
    expect(extensions).toContain('`tool_search`')
    expect(extensions).not.toContain('<<list>>')
    expect(extensions).not.toContain('SECRET_DESCRIPTION')
  })

  it('PBW-E2 不持有 tool_search：空串，configuredServers 一次都不问', async () => {
    mocks.configuredServers.mockReturnValue([mcpServer('notes')])
    const { extensions } = await blocksFor({ toolNames: ['bash', 'read'] })
    expect(extensions).toBe('')
    expect(mocks.configuredServers).not.toHaveBeenCalled()
  })

  it('PBW-E6 组件也列，带一句说明；组件说明和操作说明不进', async () => {
    mocks.configuredServers.mockReturnValue([mcpServer('widget-a-b', 'inproc')])
    const { extensions } = await blocksFor({ toolNames: ['tool_search'] })
    // 带显示名的那句话走语言文件（这里没初始化 i18next；句子本身见 extensionDiscovery.test 的 ED-W12）
    expect(extensions).toContain('`widget-a-b`: ')
    expect(extensions).not.toContain('SECRET')
  })

  it('PBW-E3 已在名单里的（勾着 / 档案声明的）不列；chrome 与 plan 不列', async () => {
    mocks.configuredServers.mockReturnValue([
      mcpServer('ticked'),
      mcpServer('chrome', 'inproc'),
      mcpServer('plan', 'inproc'),
      mcpServer('free')
    ])
    const { extensions } = await blocksFor({ toolNames: ['tool_search', 'mcp:ticked'] })
    expect(extensions).toContain('`free`')
    for (const name of ['ticked', 'chrome', 'plan']) {
      expect(extensions).not.toContain(`\`${name}\``)
    }
  })

  it('PBW-E4 用户在这条会话取消的不列（取消记号读的是根会话的勾选）', async () => {
    mocks.configuredServers.mockReturnValue([mcpServer('out'), mcpServer('free')])
    mocks.pickSettings.mockReturnValue({ enabledTools: ['-mcp:out'] })
    const { extensions } = await blocksFor({ toolNames: ['tool_search'] })
    expect(extensions).toContain('`free`')
    expect(extensions).not.toContain('`out`')
  })

  it('PBW-E5 持有但没有可开的 → 空串；work 组装出来整块不出、不留三连换行', async () => {
    mocks.configuredServers.mockReturnValue([])
    const work = builtins('en').find((p) => p.name === 'work')!
    const { out, blocks } = await personaOf(work)
    expect(blocks.extensions).toBe('')
    expect(out).not.toContain('<extensions>')
    expect(out).not.toContain('\n\n\n')
  })

  it('PBW-E6 work / chat / coding × 三语言组装：列表落在提示词的 extensions 块里（这一块不看档案的清单，跟着 tool_search 走）', async () => {
    mocks.configuredServers.mockReturnValue([mcpServer('notes')])
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        for (const profile of builtins(language)) {
          if (!['work', 'chat', 'coding'].includes(profile.name)) continue
          const { out, blocks } = await personaOf(profile)
          const what = `${profile.name}.${language}`
          expect(profile.promptBlocks as readonly string[], what).not.toContain('extensions')
          expect(blocks.extensions, what).toContain('- `notes`')
          expect(out, what).toContain(fencePromptBlock('extensions', blocks.extensions!))
        }
      })
    }
  })
})

describe('desktopPromptBlocks —— 本会话临时目录那一行（PBW-T）', () => {
  const DIR = '/fixture/tmp/shuvix-501/abcd1234'
  /**
   * 环境清单里有这一行的档案（点了 `environment` 块、手里有文件工具），及该不该带「命令的临时目录也是它」。
   * notebook 从前的正文不提它；如今环境清单按工具给，它手里有文件工具，也有这一行
   */
  const OWNERS: Record<string, boolean> = {
    work: true,
    chat: true,
    coding: true,
    bot: false,
    notebook: false
  }
  /** 没有这一行的档案：tab 点了 environment 但手里没有文件工具，其余没点 environment 块 */
  const OTHERS = ['tab', 'explore', 'titler', 'permission-reviewer', 'knowledge-writer']

  afterEach(() => setSessionTempDirResolver(() => null))

  /** 环境清单里工作目录那一行（根会话 cwd `/w/proj`） */
  const workingDirectoryLine = (language: string): string =>
    renderEnvironment(language, { workingDirectory: '/w/proj' })

  it('PBW-T1 work / chat / coding / bot / notebook × 三语言（根会话）：恰好一整行，紧跟工作目录那一行、下一行仍是列表项；命令那半句只给有 bash 的档案', async () => {
    setSessionTempDirResolver(() => DIR)
    let checked = 0
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        for (const [name, commands] of Object.entries(OWNERS)) {
          const profile = builtins(language).find((p) => p.name === name)!
          const what = `${name}.${language}`
          // 自检：commands 的期望与档案名单一致（有 bash / powershell 的才带）
          expect(
            profile.tools.some((t) => t === 'bash' || t === 'powershell'),
            what
          ).toBe(commands)
          const { out } = await personaOf(profile)
          const line = renderTempDirectory(language, { dir: DIR, commands })
          const other = renderTempDirectory(language, { dir: DIR, commands: !commands })
          expect(countOf(out, line), what).toBe(1)
          expect(out, what).not.toContain(other)
          const lines = out.split('\n')
          const at = lines.indexOf(line)
          expect(at, `${what}：应当是一整行`).toBeGreaterThan(0)
          expect(lines[at - 1], what).toBe(workingDirectoryLine(language))
          // 工作目录是环境块的第一行
          expect(lines[at - 2], what).toBe('<environment>')
          expect(lines[at + 1]?.startsWith('- '), what).toBe(true)
          checked++
        }
      })
    }
    expect(checked).toBe(15)
  })

  it('PBW-T2 别的内置档案 × 三语言：提示里没有这个目录、没有残留占位符（根，以及能派发的那几个的派生形态）', async () => {
    setSessionTempDirResolver(() => DIR)
    const seen = new Set<string>()
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        for (const profile of builtins(language).filter((p) => OTHERS.includes(p.name))) {
          const kinds = BASE_PROFILE_NAMES.has(profile.name)
            ? (['root'] as const)
            : (['root', 'spawned'] as const)
          for (const kind of kinds) {
            const { out } = await personaOf(profile, {
              kind,
              ...(kind === 'spawned' ? { sessionId: 'agent-1', rootSessionId: SID, cwd: '' } : {})
            })
            const what = `${profile.name}.${language}.${kind}`
            expect(out, what).not.toContain(DIR)
            expect(out, what).not.toContain('{{shuvix:')
          }
          seen.add(profile.name)
        }
      })
    }
    expect([...seen].sort()).toEqual([...OTHERS].sort())
  })

  it('PBW-T3 / PBW-T4 解析器给不出目录：那一行整行消失 —— 没有三连换行，工作目录那一行之后紧跟下一项', async () => {
    setSessionTempDirResolver(() => null)
    let checked = 0
    for (const language of LANGUAGES) {
      await inLanguage(language, async () => {
        // 那一行的开头（目录之前的部分），用来确认它真的不在
        const head = renderTempDirectory(language, { dir: 'X' }).split('`X`')[0]
        expect(head.length, `${language}：取不到行首`).toBeGreaterThan(2)
        for (const name of Object.keys(OWNERS)) {
          const profile = builtins(language).find((p) => p.name === name)!
          const what = `${name}.${language}`
          const { out } = await personaOf(profile)
          expect(out, what).not.toContain('{{shuvix:')
          expect(out, what).not.toMatch(/\n{3,}/)
          expect(out, what).not.toContain(head)
          // PBW-T4：环境清单中间不留空行
          const lines = out.split('\n')
          const at = lines.indexOf(workingDirectoryLine(language))
          expect(at, `${what}：找不到工作目录那一行`).toBeGreaterThanOrEqual(0)
          expect(
            lines[at + 1]?.startsWith('- '),
            `${what}：下一行 ${JSON.stringify(lines[at + 1])}`
          ).toBe(true)
          checked++
        }
      })
    }
    expect(checked).toBe(15)
  })

  it('PBW-T5 派生的 coding（cwd 空、根会话 sess-root）：说的是根会话的目录，带命令那半句；解析器只被问到根会话', async () => {
    const resolver = vi.fn((id: string) => `/fixture/tmp/${id}`)
    setSessionTempDirResolver(resolver)
    const coding = builtins('en').find((p) => p.name === 'coding')!
    const { out } = await personaOf(coding, {
      kind: 'spawned',
      sessionId: 'agent-1',
      rootSessionId: 'sess-root',
      cwd: ''
    })
    expect(out).toContain(
      renderTempDirectory('en', { dir: '/fixture/tmp/sess-root', commands: true })
    )
    expect(resolver.mock.calls.map((call) => call[0])).toEqual(['sess-root'])
  })
})
