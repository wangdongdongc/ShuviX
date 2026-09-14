/**
 * knowledge 工具（桌面注册）—— 复用 agent-runtime 的共享**读侧**内核，桌面只注入端适配。
 * 钉：注册元数据（name / group / presentation / describe）；以及适配那一层的两件事 ——
 * 目标库按**会话 + base** 解析（`project` 是根会话所属项目的库，只有 create 允许宿主建库），
 * 拿到的 bundle 目录再反查回 bundle id 交给扫描 / 检索。
 *
 * 只有 `create` 会写盘并自己记一笔账；改动条目走普通 `edit`，那条路的记账钉在文件工具那侧。
 *
 * services/knowledge 只替到接口那一层：locateBundle 用**真的**（目录 → bundle id 这条往返
 * 正是适配层的实质），扫描 / 检索是替身。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  root: '',
  registered: [] as Array<Record<string, unknown>>,
  record: vi.fn(),
  resolveBase: vi.fn(),
  listBases: vi.fn(),
  search: vi.fn(),
  scan: vi.fn(),
  concepts: [] as unknown[]
}))

vi.mock('../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`
}))
vi.mock('../../services/knowledge', async () => {
  const real = await vi.importActual<typeof import('../../services/knowledge/knowledgePaths')>(
    '../../services/knowledge/knowledgePaths'
  )
  return {
    locateBundle: real.locateBundle,
    recordKnowledgeChange: state.record,
    listBases: state.listBases,
    resolveBase: state.resolveBase,
    scanBundle: state.scan,
    searchBundle: state.search
  }
})
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: (meta: Record<string, unknown>) => {
    state.registered.push(meta)
  }
}))
vi.mock('../../services/toolContext', () => ({
  agentActorOf: (ctx: {
    agent?: { profileName?: string; getModelConfig?: () => { model?: string } }
  }): string =>
    `shuvix-${ctx.agent?.profileName ?? 'agent'}/${ctx.agent?.getModelConfig?.().model ?? 'unknown'}`,
  getDesktopSecurityContext: () => ({ enforcePath: vi.fn() }),
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))

import { KNOWLEDGE_DESCRIPTION, KnowledgeParamsSchema } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { makeKnowledgeTool } from '../knowledge'
import type { ToolContext } from '../../services/toolContext'

const BUNDLE = 'projects/acme'

const ctx: ToolContext = {
  sessionId: 's1',
  agent: {
    profileName: 'work',
    kind: 'root',
    getModelConfig: () => ({ provider: 'p', model: 'gpt-5', capabilities: {} })
  }
}

/** 本会话的目标 bundle：`projects/acme`，落在临时 shuvix 根下 */
const target = (): { bundle: string; dir: string; label: string } => ({
  bundle: BUNDLE,
  dir: join(state.root, 'projects', 'acme'),
  label: 'project "Acme"'
})

beforeAll(() => {
  state.root = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-tool-'))
})
afterAll(() => rmSync(state.root, { recursive: true, force: true }))

beforeEach(() => {
  state.record.mockClear()
  state.resolveBase.mockReset().mockResolvedValue(target())
  state.listBases.mockReset().mockResolvedValue([])
  state.scan.mockReset().mockResolvedValue({ files: [], concepts: state.concepts })
  state.search.mockReset().mockResolvedValue([])
})

describe('knowledge 工具（桌面注册）', () => {
  it('TK-1 注册元数据：name / group / presentation / describe / label', () => {
    const meta = state.registered.find((m) => m.name === 'knowledge')!
    expect(meta).toBeDefined()
    expect(meta.group).toBe('general')
    expect(meta.presentation).toEqual(BUILTIN_TOOL_PRESENTATIONS.knowledge.presentation)
    expect((meta.presentation as { icon: string }).icon).toBe('BookOpen')
    const described = (meta.describe as () => { description: string; parameters: unknown })()
    expect(described.description).toBe(KNOWLEDGE_DESCRIPTION)
    expect(described.parameters).toBe(KnowledgeParamsSchema)
    expect((meta.getLabel as () => string)()).toBe('tool.knowledgeLabel')
  })

  it('TK-2 create 是唯一允许宿主建库的 action（create: true）并把变更记成 Creation（actor = agentActorOf）；读侧一律 create: false 且不记账', async () => {
    const tool = makeKnowledgeTool(ctx)
    expect(tool.label).toBe('tool.knowledgeLabel')

    await tool.execute('c1', {
      action: 'create',
      base: 'project',
      type: 'Memory',
      title: 'T',
      description: 'd',
      body: 'b'
    })
    expect(state.resolveBase).toHaveBeenLastCalledWith('s1', 'project', { create: true })
    const written = join(state.root, 'projects', 'acme', 't.md')
    expect(existsSync(written)).toBe(true)
    expect(readFileSync(written, 'utf-8')).toContain('shuvix: okf v0.2')
    expect(state.record).toHaveBeenLastCalledWith({
      bundle: BUNDLE,
      path: 't.md',
      op: 'Creation',
      title: 'T',
      actor: 'shuvix-work/gpt-5'
    })

    for (const action of ['list', 'search', 'validate'] as const) {
      await tool.execute('c2', { action, base: 'project', query: 'q' })
      expect(state.resolveBase, action).toHaveBeenLastCalledWith('s1', 'project', { create: false })
    }
    expect(state.record).toHaveBeenCalledTimes(1)
  })

  it('TK-3 读路径：list / search / validate 都把 bundle 目录反查成 bundle id 再交给扫描 / 检索；解析不出 bundle 的目录 → 空清单、空结果', async () => {
    const tool = makeKnowledgeTool(ctx)

    await tool.execute('c5', { action: 'list', base: 'project' })
    expect(state.scan).toHaveBeenLastCalledWith(BUNDLE)

    await tool.execute('c6', { action: 'search', base: 'project', query: 'token', limit: 5 })
    expect(state.search).toHaveBeenLastCalledWith(BUNDLE, 'token', { limit: 5 })

    await tool.execute('c7', { action: 'validate', base: 'project' })
    expect(state.scan).toHaveBeenLastCalledWith(BUNDLE)

    // 目标目录不在 shuvix 根下（理论上不该发生）：扫描 / 检索不被调用
    const stray = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-stray-'))
    try {
      state.resolveBase.mockResolvedValue({ bundle: BUNDLE, dir: stray, label: 'stray' })
      state.scan.mockClear()
      state.search.mockClear()

      const listed = await tool.execute('c8', { action: 'list', base: 'project' })
      expect(state.scan).not.toHaveBeenCalled()
      expect(listed.content[0]).toMatchObject({ text: `No entries in stray — ${stray} yet.` })
      await tool.execute('c9', { action: 'search', base: 'project', query: 'token' })
      expect(state.search).not.toHaveBeenCalled()
    } finally {
      rmSync(stray, { recursive: true, force: true })
    }
  })
})
