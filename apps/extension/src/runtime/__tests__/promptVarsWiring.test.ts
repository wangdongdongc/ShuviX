/**
 * 扩展端变量表的**接线**（`extensionPromptVars`）—— 与桌面
 * `apps/desktop/src/main/agents/__tests__/promptVarsWiring.test.ts` 同结论、各写一张表
 * （纪律同 instructionFilesRuntime.test.ts：不跨 app 目录 import 夹具，否则「两端真的
 * 同语义」就失去证明力 —— 一端悄悄改了行为，另一端的表还是绿的）。
 *
 * 钉的是：**这一端实际服务的那批档案**（扩展自己的 work / chat 副本 + 共享的 notebook /
 * visualization）正文里引用的每一个 `{{shuvix:*}}`，变量表都供了值。
 * `substitutePromptVars` 的语义是「未知占位符原样保留并 warn」—— 少供一个值不报错，
 * 只会把一行裸占位符发给模型。
 *
 * 取 host 适配面的办法：顶掉 `createAgentFactory`，把 agentHost 传进去的那个对象接住。
 * 其余 mock 只为让模块能加载 —— agentHost 的 import 图带 IndexedDB / chrome.* / OPFS /
 * CDP，node 环境下一个都起不来；`./subAgent` 还反向 import agentHost（循环）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentHostAdapter, PromptVars, PromptVarsCtx } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined },
  getById: vi.fn(),
  getHandle: vi.fn()
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

vi.mock('../../storage/sessionStore', () => ({ sessionStore: { getById: mocks.getById } }))
vi.mock('../../storage/projectStore', () => ({
  projectStore: { loadState: async () => {}, getHandle: mocks.getHandle }
}))
vi.mock('../../storage/settingsStore', () => ({ settingsStore: {} }))
vi.mock('../../storage/sessionEntryStore', () => ({ ensureSessionTree: vi.fn() }))
vi.mock('../../storage/opfsWorkspace', () => ({ getTempWorkspaceHandle: vi.fn() }))
vi.mock('../eventBus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('../mcpRuntime', () => ({ mcpManager: {} }))
vi.mock('../fileTools', () => ({ createFileTools: () => [] }))
vi.mock('../browserBackend', () => ({ extensionBrowserBackend: {} }))
vi.mock('../opfsSpillSink', () => ({ createSpillSink: vi.fn() }))
vi.mock('../wrapToolOutput', () => ({ wrapToolsOutput: (t: unknown) => t }))
vi.mock('../securityProvider', () => ({ createExtensionSecurityContext: vi.fn() }))
vi.mock('../resolveSessionModel', () => ({ resolveSessionModel: vi.fn(), capsFor: () => ({}) }))
vi.mock('../instructionFilesRuntime', () => ({ resolveInstructionForSession: vi.fn() }))
vi.mock('../previewTool', () => ({ createExtensionPreviewTool: vi.fn() }))
// subAgent 反向 import agentHost —— 顶掉它才不会在加载期绕回来
vi.mock('../subAgent', () => ({
  getSessionTools: () => undefined,
  registerSessionTools: vi.fn(),
  createExtensionDispatchTool: vi.fn()
}))

import {
  buildBuiltinProfile,
  buildBuiltinProfiles,
  renderProfileSystemPrompt
} from '@shuvix/agent-runtime'
import type { AgentProfile, BuiltinProfileSpec } from '@shuvix/agent-runtime'
import '../agentHost'

import extWorkEn from '../builtinAgents/md/work.md?raw'
import extWorkZh from '../builtinAgents/md/work.zh.md?raw'
import extWorkJa from '../builtinAgents/md/work.ja.md?raw'
import extChatEn from '../builtinAgents/md/chat.md?raw'
import extChatZh from '../builtinAgents/md/chat.zh.md?raw'
import extChatJa from '../builtinAgents/md/chat.ja.md?raw'

const LANGUAGES = ['en', 'zh', 'ja']
const SID = 'sess-ext-1'

/** 与 subAgent.ts 的 EXTENSION_BUILTIN_NAMES 同一份（那边够不到：import 图带 chrome.*） */
const SERVED = new Set(['work', 'chat', 'notebook', 'visualization'])

/** 与 subAgent.ts 的 EXTENSION_*_SPEC 同形 */
const OVERRIDES: BuiltinProfileSpec[] = [
  { name: 'work', sources: { en: extWorkEn, zh: extWorkZh, ja: extWorkJa } },
  { name: 'chat', sources: { en: extChatEn, zh: extChatZh, ja: extChatJa } }
]

/** 扩展这一端实际服务的档案集（共享集过滤 + work/chat 换成浏览器变体） */
const served = (language: string): AgentProfile[] => {
  const overridden = new Map(
    OVERRIDES.map((spec) => [spec.name, buildBuiltinProfile(spec, { language })!])
  )
  return buildBuiltinProfiles({ language })
    .filter((p) => SERVED.has(p.name))
    .map((p) => overridden.get(p.name) ?? p)
}

const placeholdersOf = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{\{shuvix:([A-Za-z][\w-]*)\}\}/g)].map((m) => m[1]))].sort()

const varsFor = async (ctx: Partial<PromptVarsCtx> = {}): Promise<PromptVars> => {
  const host = mocks.host.value
  expect(host, 'agentHost 应把适配面交给 createAgentFactory').toBeDefined()
  return await host!.promptVars({ sessionId: SID, kind: 'root', cwd: 'folder', ...ctx })
}

beforeEach(() => {
  mocks.getById.mockResolvedValue({ projectId: 'proj-1', settings: { notebookPath: 'a.md' } })
  mocks.getHandle.mockReturnValue({ name: 'MyFolder' })
})

describe('extensionPromptVars —— 占位符覆盖', () => {
  it('这一端服务的档案正文引用的每个占位符，根会话都供了值', async () => {
    const vars = await varsFor({ kind: 'root' })
    const needed = new Set(
      LANGUAGES.flatMap((l) => served(l)).flatMap((p) => placeholdersOf(p.systemPrompt))
    )
    expect(needed.size, '语料自检：档案正文里应当真有占位符').toBeGreaterThan(3)
    for (const name of needed) expect(vars[name], `缺 {{shuvix:${name}}}`).toBeTypeOf('string')
  })

  it('派生 agent：除 notebookPath 外同样齐全', async () => {
    const vars = await varsFor({ kind: 'spawned', cwd: '' })
    const needed = new Set(
      LANGUAGES.flatMap((l) => served(l))
        .filter((p) => p.name !== 'notebook')
        .flatMap((p) => placeholdersOf(p.systemPrompt))
    )
    for (const name of needed) expect(vars[name], `缺 {{shuvix:${name}}}`).toBeTypeOf('string')
    expect(vars.notebookPath).toBeUndefined()
  })

  it('组装出的系统提示里没有残留占位符（每个档案 × 三语言）', async () => {
    const vars = await varsFor({ kind: 'root' })
    let checked = 0
    for (const language of LANGUAGES) {
      for (const profile of served(language)) {
        const out = renderProfileSystemPrompt(profile, vars)
        expect(out, `${profile.name}.${language}`).not.toContain('{{shuvix:')
        expect(placeholdersOf(out), `${profile.name}.${language}`).toEqual([])
        checked++
      }
    }
    expect(checked, '一个档案都没查到就等于空转').toBeGreaterThan(8)
  })
})

describe('extensionPromptVars —— visualGuide 这一项', () => {
  // 围栏渲染在共用的 chat-ui（同一个 CodeBlock），所以片段在两端同样成立 ——
  // 片段模块因此刻意不做「宿主支持与否」的分支，而这一端必须把值供上。
  it('根会话与派生 agent 都拿到自含块（自带小标题、已 trim）', async () => {
    for (const kind of ['root', 'spawned'] as const) {
      const vars = await varsFor({ kind, cwd: kind === 'root' ? 'folder' : '' })
      expect(vars.visualGuide, kind).toBeTypeOf('string')
      expect(vars.visualGuide.length, kind).toBeGreaterThan(200)
      expect(vars.visualGuide.startsWith('#'), kind).toBe(true)
      expect(vars.visualGuide, kind).toBe(vars.visualGuide.trim())
    }
  })

  it('这一端**不**带 skillShelf：不指挥模型去加载一个这里没有的技能', async () => {
    // 这一端的 resolveTools 直接丢弃 `skill:` 名，压根没有 SkillTool —— 于是
    // `renderVisualGuide` 不传 skillShelf，那句「动笔前先加载 `builtin:drawing`」整行消失。
    // 一条永远走不通的指路比没有指路更糟。桌面那一端相反，钉在
    // apps/desktop/src/main/agents/__tests__/promptVarsWiring.test.ts。
    for (const kind of ['root', 'spawned'] as const) {
      const vars = await varsFor({ kind, cwd: kind === 'root' ? 'folder' : '' })
      expect(vars.visualGuide, kind).not.toContain('builtin:drawing')
      expect(vars.visualGuide, kind).not.toContain('builtin:')
    }
  })

  it('这一端至少有一个档案引用它，且引用处都被真正替换', async () => {
    // 扩展的 work / chat 是共享 md 的**手抄副本**（见 extensionBaseProfiles.test.ts 的说明），
    // 所以「在共享那套里加一行占位符」对这一端不生效 —— 副本必须各自补。这条门就是为这个
    // 缺口而存在的：占位符曾经只加进了共享的 work/chat/coding/bot，副本没跟上，于是变量表
    // 供了值而没人引用（接线是死的），而围栏渲染在共用的 chat-ui 里、两端本该同样成立。
    // 将来再抄一份基座副本时，漏加那一行会在这里红。
    const vars = await varsFor()
    const used = new Set(
      LANGUAGES.flatMap((l) => served(l)).flatMap((p) => placeholdersOf(p.systemPrompt))
    )
    expect(used.has('visualGuide')).toBe(true)

    let hit = 0
    for (const language of LANGUAGES) {
      for (const profile of served(language)) {
        if (!placeholdersOf(profile.systemPrompt).includes('visualGuide')) continue
        expect(renderProfileSystemPrompt(profile, vars), `${profile.name}.${language}`).toContain(
          vars.visualGuide
        )
        hit++
      }
    }
    expect(hit).toBeGreaterThan(0)
  })
})
