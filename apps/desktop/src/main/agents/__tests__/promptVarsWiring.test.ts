/**
 * 桌面变量表的**接线**（`desktopPromptVars`）—— 钉的是「内置档案正文引用的每一个
 * `{{shuvix:*}}` 占位符，这一端都供了值」。
 *
 * 为什么值得单立一条：`substitutePromptVars` 的语义是「未知占位符原样保留并 warn」——
 * 少供一个值**不报错**，只会把一行 `{{shuvix:visualGuide}}` 原样发给模型。日志里多一条
 * warn，而没人在盯主进程日志；提示词少一整节，模型只是"不会画图了"。
 *
 * 待查名单**从档案正文现算**，不手抄：加一个占位符就自动进入检查，而一份手抄名单
 * 只会停在写它的那天。
 *
 * 取 host 适配面的办法：顶掉 `createAgentFactory`，把 agentHost 传进去的那个对象接住。
 * 其余 mock 只为让模块能加载（dao 会开 SQLite，electron / mcp 在 node 下起不来）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentHostAdapter, PromptVars, PromptVarsCtx } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined },
  pick: vi.fn(),
  pickSettings: vi.fn(),
  projectPick: vi.fn()
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

import {
  buildBuiltinProfiles,
  renderProfileSystemPrompt,
  type AgentProfile
} from '@shuvix/agent-runtime'
import '../agentHost'

const LANGUAGES = ['en', 'zh', 'ja']
const SID = 'sess-desktop-1'

/** 文本里引用到的 `{{shuvix:name}}` 名字（去重排序） */
const placeholdersOf = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{\{shuvix:([A-Za-z][\w-]*)\}\}/g)].map((m) => m[1]))].sort()

/** 桌面这一端供全部内置档案（含派生用的 coding / explore / titler …），不只四个基座 */
const builtins = (language: string): AgentProfile[] =>
  buildBuiltinProfiles({ language, widgetsRoot: '/w/widgets' })

const varsFor = async (ctx: Partial<PromptVarsCtx> = {}): Promise<PromptVars> => {
  const host = mocks.host.value
  expect(host, 'agentHost 应把适配面交给 createAgentFactory').toBeDefined()
  return await host!.promptVars({ sessionId: SID, kind: 'root', cwd: '/w/proj', ...ctx })
}

beforeEach(() => {
  mocks.pick.mockReturnValue({ projectId: 'proj-1' })
  mocks.pickSettings.mockReturnValue({ notebookPath: 'notes/a.md' })
  mocks.projectPick.mockReturnValue({ name: 'Proj', path: '/w/proj' })
})

describe('desktopPromptVars —— 占位符覆盖', () => {
  it('内置档案正文引用的每个占位符，根会话都供了值', async () => {
    const vars = await varsFor({ kind: 'root' })
    const needed = new Set(
      LANGUAGES.flatMap((l) => builtins(l)).flatMap((p) => placeholdersOf(p.systemPrompt))
    )
    expect(needed.size, '语料自检：档案正文里应当真有占位符').toBeGreaterThan(5)
    for (const name of needed) expect(vars[name], `缺 {{shuvix:${name}}}`).toBeTypeOf('string')
  })

  it('派生 agent：除 notebookPath 外同样齐全（派生 ctx.sessionId 是 agentId，解析不出会话）', async () => {
    const vars = await varsFor({ kind: 'spawned', cwd: '' })
    const needed = new Set(
      LANGUAGES.flatMap((l) => builtins(l))
        .filter((p) => p.name !== 'notebook') // 笔记本基座只做会话根 Agent
        .flatMap((p) => placeholdersOf(p.systemPrompt))
    )
    for (const name of needed) expect(vars[name], `缺 {{shuvix:${name}}}`).toBeTypeOf('string')
    expect(vars.notebookPath).toBeUndefined()
  })
})

describe('desktopPromptVars —— visualGuide 这一项', () => {
  it('是自含块（自带小标题）且已 trim —— 空串会让整块静默消失', async () => {
    const vars = await varsFor()
    expect(vars.visualGuide.length).toBeGreaterThan(200)
    expect(vars.visualGuide.startsWith('#')).toBe(true)
    expect(vars.visualGuide).toBe(vars.visualGuide.trim())
  })

  it('这一端带 skillShelf：指路那句在里面（桌面有内置技能货架）', async () => {
    // `renderVisualGuide(lang, { skillShelf: true })` 的宿主分支在这一端为真 —— 桌面的
    // resolveTools 会挂上 SkillTool，`builtin:drawing` 是够得到的。扩展那一端相反，钉在
    // apps/extension/src/runtime/__tests__/promptVarsWiring.test.ts。
    const vars = await varsFor()
    expect(vars.visualGuide).toContain('builtin:drawing')
  })

  it('派生 agent 也拿到它 —— coding 是被派发出来的', async () => {
    // 若哪天有人把 visualGuide 塞进 ctx.kind === 'root' 分支（notebookPath 就在紧邻两行），
    // coding 会静默收到一行裸占位符。
    const spawned = await varsFor({ kind: 'spawned', cwd: '' })
    expect(spawned.visualGuide).toBeTypeOf('string')
    expect(spawned.visualGuide.length).toBeGreaterThan(200)
  })

  it('凡引用了它的档案，替换后正文里真的出现了片段全文', async () => {
    // 「哪些档案该引用它」是档案自己的事（钉在 agentProfile/__tests__/fragments.test.ts）；
    // 这里钉的是接线：引用了就必须真的替换成内容，而不是原样留一行占位符。
    const vars = await varsFor()
    let hit = 0
    for (const language of LANGUAGES) {
      for (const profile of builtins(language)) {
        if (!placeholdersOf(profile.systemPrompt).includes('visualGuide')) continue
        expect(renderProfileSystemPrompt(profile, vars), `${profile.name}.${language}`).toContain(
          vars.visualGuide
        )
        hit++
      }
    }
    expect(hit, '没有任何档案引用 visualGuide —— 接线断了或占位符被删了').toBeGreaterThan(0)
  })
})

describe('desktopPromptVars —— 组装出的系统提示里没有残留占位符', () => {
  it.each(['root', 'spawned'] as const)(
    'kind=%s：每个内置档案 × 三语言都替换干净',
    async (kind) => {
      const vars = await varsFor({ kind, cwd: kind === 'root' ? '/w/proj' : '' })
      let checked = 0
      for (const language of LANGUAGES) {
        for (const profile of builtins(language)) {
          if (kind === 'spawned' && profile.name === 'notebook') continue
          const out = renderProfileSystemPrompt(profile, vars)
          expect(out, `${profile.name}.${language}`).not.toContain('{{shuvix:')
          expect(placeholdersOf(out), `${profile.name}.${language}`).toEqual([])
          checked++
        }
      }
      expect(checked, '一个档案都没查到就等于空转').toBeGreaterThan(20)
    }
  )
})
