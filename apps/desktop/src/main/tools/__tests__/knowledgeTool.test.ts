/**
 * knowledge 工具（桌面注册）—— 复用 agent-runtime 的共享内核，桌面只注入端适配。
 * 钉：注册元数据（name / group / presentation / describe）；以及适配那一层的三件事 ——
 * 目标 bundle 按**会话**解析（工具没有 scope 参数了）、拿到的 bundle 目录再反查回 bundle id
 * 交给扫描 / 检索 / 变更管线、工具的 op 译成日志领头词（create → Creation、update / 回 draft →
 * Update、deprecated → Deprecation）并带上 agentActorOf 的 actor 与 title。
 *
 * services/knowledge 只替到接口那一层：locateBundle 用**真的**（目录 → bundle id 这条往返
 * 正是适配层的实质），扫描 / 检索 / 记账是替身。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  root: '',
  registered: [] as Array<Record<string, unknown>>,
  record: vi.fn(),
  resolveBundle: vi.fn(),
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
    sessionBundle: state.resolveBundle,
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
  state.resolveBundle.mockReset().mockResolvedValue(target())
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

  it('TK-2 写路径：bundle 按会话解析（新建才 create）、文件落在该 bundle 里；变更管线收到 bundle id + bundle 相对路径 + Creation / Update / Deprecation，actor = agentActorOf(ctx)，title 透传', async () => {
    const tool = makeKnowledgeTool(ctx)
    expect(tool.label).toBe('tool.knowledgeLabel')

    await tool.execute('c1', {
      action: 'write',
      type: 'Memory',
      title: 'T',
      description: 'd',
      body: 'b'
    })
    expect(state.resolveBundle).toHaveBeenCalledWith('s1', { create: true })
    const written = join(state.root, 'projects', 'acme', 't.md')
    expect(existsSync(written)).toBe(true)
    expect(readFileSync(written, 'utf-8')).toContain('title: T')
    expect(state.record).toHaveBeenLastCalledWith({
      bundle: BUNDLE,
      path: 't.md',
      op: 'Creation',
      title: 'T',
      actor: 'shuvix-work/gpt-5'
    })

    // 更新既有条目：给了 path 就不需要宿主建 bundle
    await tool.execute('c2', { action: 'write', path: '/t.md', body: 'b2' })
    expect(state.resolveBundle).toHaveBeenLastCalledWith('s1', { create: false })
    expect(state.record).toHaveBeenLastCalledWith({
      bundle: BUNDLE,
      path: 't.md',
      op: 'Update',
      title: 'T',
      actor: 'shuvix-work/gpt-5'
    })

    await tool.execute('c3', { action: 'set-status', path: '/t.md', status: 'deprecated' })
    expect(state.record).toHaveBeenLastCalledWith({
      bundle: BUNDLE,
      path: 't.md',
      op: 'Deprecation',
      title: 'T',
      actor: 'shuvix-work/gpt-5'
    })

    await tool.execute('c4', { action: 'set-status', path: '/t.md', status: 'draft' })
    expect(state.record).toHaveBeenLastCalledWith({
      bundle: BUNDLE,
      path: 't.md',
      op: 'Update',
      title: 'T',
      actor: 'shuvix-work/gpt-5'
    })
    expect(state.record).toHaveBeenCalledTimes(4)
  })

  it('TK-3 读路径：list / search 都把 bundle 目录反查成 bundle id 再交给扫描 / 检索；解析不出 bundle 的目录 → 空清单、空结果、写入不记账', async () => {
    const tool = makeKnowledgeTool(ctx)

    await tool.execute('c5', { action: 'list' })
    expect(state.resolveBundle).toHaveBeenLastCalledWith('s1', { create: false })
    expect(state.scan).toHaveBeenLastCalledWith(BUNDLE)

    await tool.execute('c6', { action: 'search', query: 'token', limit: 5 })
    expect(state.search).toHaveBeenLastCalledWith(BUNDLE, 'token', { limit: 5 })

    // 目标目录不在 shuvix 根下（理论上不该发生）：扫描 / 检索不被调用，写入也不记账
    const stray = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-stray-'))
    try {
      state.resolveBundle.mockResolvedValue({ bundle: BUNDLE, dir: stray, label: 'stray' })
      state.scan.mockClear()
      state.search.mockClear()

      const listed = await tool.execute('c7', { action: 'list' })
      expect(state.scan).not.toHaveBeenCalled()
      expect(listed.content[0]).toMatchObject({ text: 'No entries in stray yet.' })
      await tool.execute('c8', { action: 'search', query: 'token' })
      expect(state.search).not.toHaveBeenCalled()

      await tool.execute('c9', {
        action: 'write',
        type: 'Memory',
        title: 'Stray',
        description: 'd',
        body: 'b'
      })
      expect(existsSync(join(stray, 'stray.md'))).toBe(true)
      expect(state.record).not.toHaveBeenCalled()
    } finally {
      rmSync(stray, { recursive: true, force: true })
    }
  })
})
