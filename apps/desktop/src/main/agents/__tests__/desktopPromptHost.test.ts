/**
 * P1-11 —— 桌面 PromptHost（`desktopPromptHost`）：系统提示词五个活段落的数据源（H11-55…60）。
 * 都按根会话解析、交回**原文**（围栏由运行时的段落统一加），每次请求准备时现调 —— 不缓存。
 *
 * 指令文件走**真的** resolveInstructionContent（临时目录）；项目 / 会话 / 知识库 / 记忆 / bot 是替身。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  projectPick: vi.fn(),
  resolveProjectConfig: vi.fn(),
  enabledBaseChoices: vi.fn(),
  resolveProjectMemoryIndex: vi.fn(),
  forSession: vi.fn(),
  recordRead: vi.fn()
}))

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getPath: () => '/tmp/x' } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: { pick: mocks.pick, pickSettings: () => undefined }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/memory', () => ({
  resolveProjectMemoryIndex: mocks.resolveProjectMemoryIndex
}))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: mocks.enabledBaseChoices }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: vi.fn() } }))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: {},
  runtimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: vi.fn(),
  resolveProjectConfig: mocks.resolveProjectConfig
}))
vi.mock('../../services/userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../services/sandbox', () => ({ sandboxGloballyActive: () => false }))
vi.mock('../../services/botService', () => ({ botService: { forSession: mocks.forSession } }))
vi.mock('../../utils/toolUtils/fileTime', () => ({ recordRead: mocks.recordRead }))
vi.mock('../../services/mcpService', () => ({ mcpService: {} }))
vi.mock('../../services/skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../../services/skillTool', () => ({ SkillTool: class {} }))
vi.mock('../AgentTool', () => ({ createAgentTool: vi.fn() }))
vi.mock('../../services/wrapToolOutput', () => ({ wrapDurableTool: (tool: object) => tool }))

import { renderBotContext, renderKnowledgeGuide } from '@shuvix/agent-runtime'
import { desktopPromptHost } from '../agentHost'

const host = desktopPromptHost
let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shuvix-h11-prompt-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.pick.mockReturnValue({ projectId: 'p1' })
  mocks.projectPick.mockReturnValue({ name: 'Proj', path: '/w/proj', systemPrompt: 'Be terse.' })
})

/** 一个新的工作目录，按给定内容写文件 */
function workspace(files: Record<string, string>): string {
  const dir = join(root, `ws-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

describe('resolveInstruction', () => {
  const CANDIDATES = ['CLAUDE.md', 'AGENTS.md']

  it('H11-55 按候选次序取第一个存在且非空的：(a) 只有 AGENTS.md → 它（已修剪）；(b) 两个都有 → CLAUDE.md；(c) CLAUDE.md 只有空白 → AGENTS.md；(d) 都没有 → null；(e) 候选为空 → null', async () => {
    const a = workspace({ 'AGENTS.md': '  rules\n' })
    expect(await host.resolveInstruction!('s1', a, CANDIDATES)).toEqual({
      filename: 'AGENTS.md',
      content: 'rules'
    })
    const b = workspace({ 'CLAUDE.md': 'claude', 'AGENTS.md': 'agents' })
    expect(await host.resolveInstruction!('s1', b, CANDIDATES)).toEqual({
      filename: 'CLAUDE.md',
      content: 'claude'
    })
    const c = workspace({ 'CLAUDE.md': '   \n\t', 'AGENTS.md': 'agents' })
    expect(await host.resolveInstruction!('s1', c, CANDIDATES)).toEqual({
      filename: 'AGENTS.md',
      content: 'agents'
    })
    const d = workspace({})
    expect(await host.resolveInstruction!('s1', d, CANDIDATES)).toBeNull()
    expect(await host.resolveInstruction!('s1', a, [])).toBeNull()
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled()
  })

  it('H11-56 cwd 为空串：按 resolveProjectConfig(s1).workingDirectory 兜底（项目会话 = 项目根；否则会话自己的目录）', async () => {
    const project = workspace({ 'AGENTS.md': 'project rules' })
    mocks.resolveProjectConfig.mockReturnValue({ workingDirectory: project })
    expect(await host.resolveInstruction!('s1', '', ['AGENTS.md'])).toEqual({
      filename: 'AGENTS.md',
      content: 'project rules'
    })
    expect(mocks.resolveProjectConfig).toHaveBeenCalledWith('s1')

    const own = workspace({ 'AGENTS.md': 'temp rules' })
    mocks.resolveProjectConfig.mockReturnValue({ workingDirectory: own })
    expect((await host.resolveInstruction!('s2', '', ['AGENTS.md']))?.content).toBe('temp rules')
    expect(mocks.resolveProjectConfig).toHaveBeenLastCalledWith('s2')
  })
})

describe('resolveProjectPrompt', () => {
  it('H11-57 修剪后的原文；只有空白 / 没有项目 → null；两次之间改了就看到新的（不缓存）', async () => {
    mocks.projectPick.mockReturnValue({ name: 'P', path: '/p', systemPrompt: '  Be terse.  ' })
    expect(await host.resolveProjectPrompt!('s1')).toBe('Be terse.')
    mocks.projectPick.mockReturnValue({ name: 'P', path: '/p', systemPrompt: '   ' })
    expect(await host.resolveProjectPrompt!('s1')).toBeNull()
    mocks.projectPick.mockReturnValue({ name: 'P', path: '/p', systemPrompt: 'Be kind.' })
    expect(await host.resolveProjectPrompt!('s1')).toBe('Be kind.')
    mocks.pick.mockReturnValue(undefined)
    expect(await host.resolveProjectPrompt!('s1')).toBeNull()
  })
})

describe('resolveKnowledgeBases', () => {
  it('H11-58 一个库都没勾 → null；勾了 → 恰为 renderKnowledgeGuide(那几个)；每次现问', async () => {
    mocks.enabledBaseChoices.mockReturnValue([])
    expect(await host.resolveKnowledgeBases!('s1')).toBeNull()
    const bases = [
      { name: 'project', label: 'Acme' },
      { name: 'notes', label: '' }
    ]
    mocks.enabledBaseChoices.mockReturnValue(bases)
    expect(await host.resolveKnowledgeBases!('s1')).toBe(renderKnowledgeGuide(bases))
    expect(mocks.enabledBaseChoices).toHaveBeenCalledTimes(2)
    expect(mocks.enabledBaseChoices).toHaveBeenLastCalledWith('s1')
  })
})

describe('resolveProjectMemory', () => {
  it('H11-59 原样交回 resolveProjectMemoryIndex(s1) 的结果；没有项目 → null', async () => {
    mocks.resolveProjectMemoryIndex.mockReturnValue('## memory index')
    expect(await host.resolveProjectMemory!('s1')).toBe('## memory index')
    expect(mocks.resolveProjectMemoryIndex).toHaveBeenCalledWith('s1')
    mocks.resolveProjectMemoryIndex.mockReturnValue(null)
    expect(await host.resolveProjectMemory!('s1')).toBeNull()
  })
})

describe('resolveBotContext', () => {
  const bot = (body: string): unknown => ({
    file: { name: 'pal', displayName: 'Pal', body },
    basePath: '/b/pal.md'
  })

  it('H11-60 绑定的 bot → 恰为 renderBotContext({name, displayName, file: basePath, body})，每次都记一次已读；文件没了 / 不是 bot 会话 → null、不记；改了正文下一次就是新的（PIN-16）', async () => {
    mocks.forSession.mockReturnValue(bot(' hi '))
    expect(await host.resolveBotContext!('s1')).toBe(
      renderBotContext({ name: 'pal', displayName: 'Pal', file: '/b/pal.md', body: ' hi ' })
    )
    expect(mocks.forSession).toHaveBeenCalledWith('s1')
    expect(mocks.recordRead.mock.calls).toEqual([['s1', '/b/pal.md']])

    mocks.forSession.mockReturnValue(bot('edited'))
    expect(await host.resolveBotContext!('s1')).toBe(
      renderBotContext({ name: 'pal', displayName: 'Pal', file: '/b/pal.md', body: 'edited' })
    )
    expect(mocks.recordRead).toHaveBeenCalledTimes(2)

    mocks.recordRead.mockClear()
    mocks.forSession.mockReturnValue(null)
    expect(await host.resolveBotContext!('s1')).toBeNull()
    expect(mocks.recordRead).not.toHaveBeenCalled()
  })
})
