/**
 * knowledge 工具（桌面注册）—— 复用 agent-runtime 的共享内核，桌面只注入端适配。
 * 钉：注册元数据（name / group / presentation / describe），以及写路径把工具的 op 译成日志领头词
 * （create → Creation、update / 回 draft → Update、deprecated → Deprecation）、actor 取自 agentActorOf、
 * title 透传给变更管线。services/knowledge 整体 mock（它带着扫描 / git / dao 依赖）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  root: '',
  registered: [] as Array<Record<string, unknown>>,
  record: vi.fn(),
  resolveScope: vi.fn(),
  search: vi.fn(),
  concepts: [] as unknown[]
}))

vi.mock('../../services/knowledge', () => ({
  getKnowledgeRoot: () => state.root,
  recordKnowledgeChange: state.record,
  resolveSessionScopeTarget: state.resolveScope,
  scanKnowledge: async () => ({ files: [], concepts: state.concepts }),
  searchKnowledge: state.search
}))
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

beforeAll(() => {
  state.root = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-tool-'))
})
afterAll(() => rmSync(state.root, { recursive: true, force: true }))

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

  it('TK-1 写路径：作用域按会话解析；变更管线收到 Creation / Update / Deprecation，actor = agentActorOf(ctx)，title 透传', async () => {
    state.resolveScope.mockResolvedValue({ dir: 'global', label: 'global' })
    const ctx: ToolContext = {
      sessionId: 's1',
      agent: {
        profileName: 'work',
        kind: 'root',
        getModelConfig: () => ({ provider: 'p', model: 'gpt-5', capabilities: {} })
      }
    }
    const tool = makeKnowledgeTool(ctx)
    expect(tool.label).toBe('tool.knowledgeLabel')

    await tool.execute('c1', {
      action: 'write',
      scope: 'global',
      type: 'Memory',
      title: 'T',
      description: 'd',
      body: 'b'
    })
    expect(state.resolveScope).toHaveBeenCalledWith('s1', 'global', {
      topic: undefined,
      create: true
    })
    expect(existsSync(join(state.root, 'global', 't.md'))).toBe(true)
    expect(state.record).toHaveBeenLastCalledWith({
      path: 'global/t.md',
      op: 'Creation',
      title: 'T',
      actor: 'shuvix-work/gpt-5'
    })

    await tool.execute('c2', { action: 'write', path: '/global/t.md', body: 'b2' })
    expect(state.record).toHaveBeenLastCalledWith({
      path: 'global/t.md',
      op: 'Update',
      title: 'T',
      actor: 'shuvix-work/gpt-5'
    })

    await tool.execute('c3', { action: 'set-status', path: '/global/t.md', status: 'deprecated' })
    expect(state.record).toHaveBeenLastCalledWith({
      path: 'global/t.md',
      op: 'Deprecation',
      title: 'T',
      actor: 'shuvix-work/gpt-5'
    })

    await tool.execute('c4', { action: 'set-status', path: '/global/t.md', status: 'draft' })
    expect(state.record).toHaveBeenLastCalledWith({
      path: 'global/t.md',
      op: 'Update',
      title: 'T',
      actor: 'shuvix-work/gpt-5'
    })
    expect(state.record).toHaveBeenCalledTimes(4)
  })
})
