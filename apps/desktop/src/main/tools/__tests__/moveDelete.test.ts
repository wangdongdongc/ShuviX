/**
 * 桌面 move / delete 工具（tools/move.ts、tools/delete.ts + fileToolDeps 的接线）—— 真实临时文件、真实 fileTime、
 * 真实安全模块（同 fileToolDepsKnowledge.test 的 provider 桩：工作区 = 临时目录、整个临时目录授予了写），
 * 只把知识库变更管线换成 spy、把 files.changed 从真的事件总线上收下来。
 *
 *   MD-1 库里挪一条：盘上挪好；管线收到源 delete + 目标 write（actor 取自 ctx）；files.changed 两条（delete / write）；
 *        挪过去的那条若读过，紧接着 edit 不撞「先读」
 *   MD-2 库里挪一整个目录：管线两条都带 isDirectory；files.changed 不带 paths（整体刷新）
 *   MD-3 库里删一条：管线收到 delete；files.changed 一条 delete；空目录也删得掉，非空目录拒
 *   MD-4 库外的挪动：files.changed 照发，管线不收
 *   MD-5 源在工作区外（没授权）：出厂外部目录门问一张卡（工具名 move、Write(源)）；拒了 → 一个字节都不动、不广播
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import {
  executeTool,
  failureText,
  resultText
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const state = vi.hoisted(() => ({
  dir: '',
  kb: '',
  requests: [] as InputRequest[],
  respond: (() => ({ kind: 'ask', allowed: true })) as (req: InputRequest) => InputResponse,
  notify: vi.fn()
}))

vi.mock('../../services/toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { sep: pathSep, join: joinPath } = await import('node:path')
  const makeContext = (): unknown =>
    createSecurityContext(
      { kind: 'agent', sessionId: 'md-session', agentKind: 'root' },
      { host: 'desktop' },
      {
        host: 'desktop',
        pathSep,
        getVars: () => ({
          workspace: state.dir,
          toolResultsBase: joinPath(state.dir, '.nonexistent-tool-results'),
          skillsDirs: [],
          home: joinPath(state.dir, '.nonexistent-home'),
          systemDirs: [],
          aclRead: [state.dir],
          aclWrite: [state.dir]
        }),
        readBuiltinPolicyMd: INLINE_POLICY_MD,
        isDirectory: () => false,
        persistGrant: () => {},
        requestUserInput: async (req: InputRequest) => {
          state.requests.push(req)
          return state.respond(req)
        }
      }
    )
  return {
    resolveProjectConfig: () => ({ workingDirectory: state.dir }),
    getDesktopSecurityContext: makeContext,
    isSessionDocument: () => false,
    TOOL_ABORTED: 'Aborted'
  }
})
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.kb,
  getUserKnowledgeRootDir: () => `${state.kb}-user`,
  getBuiltinKnowledgeDir: () => `${state.kb}-builtin`,
  getToolResultsDir: () => join(state.dir, 'tool_results')
}))
vi.mock('i18next', () => ({ default: { language: 'en', t: (key: string) => key } }))
vi.mock('../../services/knowledge', () => ({ notifyKnowledgeFileChanged: state.notify }))

import { makeMoveTool } from '../move'
import { makeDeleteTool } from '../delete'
import { makeEditTool } from '../edit'
import { makeReadTool } from '../read'
import { appEventBus } from '../../utils/appEventBus'
import { _resetAll } from '../../utils/toolUtils/fileTime'
import type { ToolContext } from '../../services/toolContext'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'

const INLINE_POLICY_MD = createInlinePolicyMdReader()

const ctx: ToolContext = {
  sessionId: 'md-session',
  agent: {
    profileName: 'knowledge-writer',
    kind: 'root',
    getModelConfig: () => ({ provider: 'p', model: 'gpt-5', capabilities: {} })
  }
}
const ACTOR = 'shuvix-knowledge-writer/gpt-5'

let bundle: string
let fileEvents: Extract<AppEvent, { type: 'files.changed' }>[]
let unsubscribe: () => void

beforeAll(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'shuvix-move-delete-'))
  state.kb = join(state.dir, 'kb')
})
afterAll(() => rmSync(state.dir, { recursive: true, force: true }))
beforeEach(() => {
  _resetAll()
  bundle = join(state.kb, 'projects', `acme-${Math.random().toString(36).slice(2)}`)
  mkdirSync(bundle, { recursive: true })
  state.requests = []
  state.notify.mockClear()
  state.respond = () => ({ kind: 'ask', allowed: true })
  fileEvents = []
  unsubscribe = appEventBus.subscribe((e) => {
    if (e.type === 'files.changed') fileEvents.push(e)
  })
})
afterEach(() => unsubscribe())

/** 变更管线模块按需加载（动态 import）：等它收齐 n 条 */
const notified = async (n: number): Promise<unknown[][]> => {
  await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(n))
  return state.notify.mock.calls
}

describe('桌面 move / delete', () => {
  it('MD-1 库里挪一条：管线收到源 delete + 目标 write；files.changed 两条；读过的接着 edit 不撞「先读」', async () => {
    const from = join(bundle, 'a.md')
    const to = join(bundle, 'topics', 'b.md')
    writeFileSync(from, '# a\n\nbody\n')
    await executeTool(makeReadTool(ctx), 'r1', { path: from })

    const res = await executeTool(makeMoveTool(ctx), 'm1', { from, to })
    expect(resultText(res)).toBe(`Moved ${from} → ${to}`)
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(to, 'utf-8')).toBe('# a\n\nbody\n')
    expect(state.requests).toEqual([])

    expect(await notified(2)).toEqual([
      [from, { kind: 'delete', actor: ACTOR }],
      [to, { kind: 'write', actor: ACTOR }]
    ])
    expect(fileEvents).toEqual([
      { type: 'files.changed', root: state.dir, paths: [from], kind: 'delete' },
      { type: 'files.changed', root: state.dir, paths: [to], kind: 'write' }
    ])

    const edited = await executeTool(makeEditTool(ctx), 'e1', {
      path: to,
      oldText: 'body',
      newText: 'body two'
    })
    expect(edited.isError).toBeUndefined()
    expect(readFileSync(to, 'utf-8')).toContain('body two')
  })

  it('MD-2 库里挪一整个目录：管线两条带 isDirectory；files.changed 不带 paths', async () => {
    mkdirSync(join(bundle, 'topics', 'deep'), { recursive: true })
    writeFileSync(join(bundle, 'topics', 'deep', 'x.md'), '# x\n')
    const from = join(bundle, 'topics')
    const to = join(bundle, 'areas', 'topics')

    await executeTool(makeMoveTool(ctx), 'm2', { from, to })
    expect(readFileSync(join(to, 'deep', 'x.md'), 'utf-8')).toBe('# x\n')
    expect(await notified(2)).toEqual([
      [from, { kind: 'delete', actor: ACTOR, isDirectory: true }],
      [to, { kind: 'write', actor: ACTOR, isDirectory: true }]
    ])
    expect(fileEvents).toEqual([
      { type: 'files.changed', root: state.dir },
      { type: 'files.changed', root: state.dir }
    ])
  })

  it('MD-3 库里删一条：管线收到 delete、files.changed 一条；空目录删得掉，非空目录拒', async () => {
    const p = join(bundle, 'gone.md')
    writeFileSync(p, '# gone\n')
    const res = await executeTool(makeDeleteTool(ctx), 'd1', { path: p })
    expect(resultText(res)).toBe(`Deleted ${p}`)
    expect(existsSync(p)).toBe(false)
    expect(await notified(1)).toEqual([[p, { kind: 'delete', actor: ACTOR }]])
    expect(fileEvents).toEqual([
      { type: 'files.changed', root: state.dir, paths: [p], kind: 'delete' }
    ])

    const full = join(bundle, 'full')
    mkdirSync(full)
    writeFileSync(join(full, 'x.md'), 'x')
    expect(await failureText(executeTool(makeDeleteTool(ctx), 'd2', { path: full }))).toContain(
      'is a directory with 1 entry in it'
    )
    expect(existsSync(join(full, 'x.md'))).toBe(true)

    const empty = join(bundle, 'empty')
    mkdirSync(empty)
    await executeTool(makeDeleteTool(ctx), 'd3', { path: empty })
    expect(existsSync(empty)).toBe(false)
    expect(await notified(2)).toContainEqual([
      empty,
      { kind: 'delete', actor: ACTOR, isDirectory: true }
    ])
  })

  it('MD-4 库外的挪动：files.changed 照发，管线不收', async () => {
    const from = join(state.dir, 'plain.txt')
    const to = join(state.dir, 'renamed.txt')
    writeFileSync(from, 'p')
    await executeTool(makeMoveTool(ctx), 'm4', { from: 'plain.txt', to: 'renamed.txt' })
    expect(readFileSync(to, 'utf-8')).toBe('p')
    expect(fileEvents.map((e) => [e.paths, e.kind])).toEqual([
      [[from], 'delete'],
      [[to], 'write']
    ])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(state.notify).not.toHaveBeenCalled()
  })

  it('MD-5 源在工作区外（没授权）：问一张卡（move、Write(源)）；拒了一个字节都不动、不广播', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'shuvix-move-outside-'))
    try {
      const from = join(outside, 'secret.md')
      writeFileSync(from, 'S')
      const to = join(state.dir, 'stolen.md')
      state.respond = () => ({ kind: 'ask', allowed: false })

      const text = await failureText(executeTool(makeMoveTool(ctx), 'm5', { from, to }))
      expect(text).toMatch(/denied|declined|not allowed/i)
      expect(state.requests).toHaveLength(1)
      expect(state.requests[0]).toMatchObject({ toolName: 'move' })
      expect(JSON.stringify(state.requests[0])).toContain(from)
      expect(readFileSync(from, 'utf-8')).toBe('S')
      expect(existsSync(to)).toBe(false)
      expect(fileEvents).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
