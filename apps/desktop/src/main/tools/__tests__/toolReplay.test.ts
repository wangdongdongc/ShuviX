/**
 * RT —— 桌面内置工具的 durable 重跑策略（`replay`）。
 *
 * durable 在一次工具调用开始前把 `replay` 记进意图；进程中断后恢复时，只有记下的与当前的都是
 * 'safe' 才重跑，否则这次调用记为「中断，可能已部分执行」交给模型（P1-04，Verified fact 1）。
 * 规则一句话：只读、重跑无害的才 'safe' —— read / ls / grep / glob；其余一律 'unsafe'（BaseTool 缺省）。
 * 把 'safe' 写到一个有副作用的工具上，恢复时它就会把那个副作用再做一遍，所以逐个钉。
 *
 * agent-runtime 那一半（read / write / edit / knowledge / next / agent）在 packages/agent-runtime 的
 * tools/__tests__/baseTool.test.ts。这里只造实例看字段，不执行 —— 模块在 import 期碰到的东西全部桩掉。
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '../../services/toolContext'

vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: '/w', referenceDirs: [], envVars: {} }),
  isPathWithinWorkspace: () => true,
  isPathWithinReferenceDirs: () => false,
  assertReadAllowed: () => {},
  assertWriteAllowed: () => {},
  getDesktopSecurityContext: () => ({}),
  getSessionPathGrants: () => ({}),
  sessionDirExtras: () => [],
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shuvix-tool-replay-test', isPackaged: false },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) }
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('markitdown-ts', () => ({ MarkItDown: class {} }))
vi.mock('word-extractor', () => ({ default: class {} }))
vi.mock('../../services/liveDocumentBridge', () => ({ requestLiveDocument: vi.fn() }))
vi.mock('../../services/sessionRecords', () => ({ sessionRecords: { pick: vi.fn() } }))
vi.mock('../../services/sessionService', () => ({ sessionService: { updateTitle: vi.fn() } }))
vi.mock('../../services/subSessionRunner', () => ({
  subSessionRunner: {},
  DEFAULT_PROMPT_TIMEOUT_SEC: 300
}))
vi.mock('../../services/artifacts/store', () => ({
  listArtifacts: vi.fn(),
  writeArtifact: vi.fn()
}))
vi.mock('../../services/artifacts/adopt', () => ({
  adoptFigure: vi.fn(),
  figureArtifactName: vi.fn(),
  listAdoptableFigures: vi.fn()
}))
vi.mock('../../services/messageService', () => ({ messageService: {} }))
vi.mock('../../services/sandbox', () => ({
  pinSession: () => false,
  sandboxGloballyActive: () => false,
  planFor: () => null,
  whyUnconfined: () => 'disabled'
}))
vi.mock('../../services/skillService', () => ({
  skillService: { findEnabled: () => [], findByName: () => undefined }
}))

import { makeReadTool } from '../read'
import { makeWriteTool } from '../write'
import { makeEditTool } from '../edit'
import { ListTool } from '../ls'
import { GlobTool } from '../glob'
import { GrepTool } from '../grep'
import { DocReadTool, DocEditTool, DocInsertTool } from '../doc'
import { SessionTool } from '../session'
import { ArtifactTool } from '../artifact'
import { BashTool } from '../bash'
import { PowerShellTool } from '../powershell'
import { SkillTool } from '../../services/skillTool'

const ctx = { sessionId: 'sess-replay' } as ToolContext

describe('RT 桌面内置工具的重跑策略', () => {
  it.each([
    ['read', () => makeReadTool(ctx)],
    ['ls', () => new ListTool(ctx)],
    ['glob', () => new GlobTool(ctx)],
    ['grep', () => new GrepTool(ctx)]
  ])('RT-1 %s 只读 → safe', (name, make) => {
    const tool = make()
    expect(tool.name).toBe(name)
    expect(tool.replay).toBe('safe')
  })

  it.each([
    ['write', () => makeWriteTool(ctx)],
    ['edit', () => makeEditTool(ctx)],
    ['doc_read', () => new DocReadTool(ctx)],
    ['doc_edit', () => new DocEditTool(ctx)],
    ['doc_insert', () => new DocInsertTool(ctx)],
    ['session', () => new SessionTool(ctx)],
    ['artifact', () => new ArtifactTool(ctx)],
    ['bash', () => new BashTool(ctx)],
    ['powershell', () => new PowerShellTool(ctx)],
    ['skill', () => new SkillTool(['anything'])]
  ])('RT-2 %s → unsafe', (name, make) => {
    const tool = make()
    expect(tool.name).toBe(name)
    expect(tool.replay).toBe('unsafe')
  })
})
