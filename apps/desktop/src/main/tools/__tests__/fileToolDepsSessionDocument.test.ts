/**
 * 桌面文件工具 deps 的 `refuseWrite`（fileToolDeps.ts）—— 笔记本会话自己那份文档只经 doc_* 改，write / edit
 * 碰它时给模型一句指路的话。真实临时文件 + 真实 fileTime + **真实安全模块**（同 writeAskWiring.test 的
 * provider 桩），只把 toolContext.isSessionDocument 换成 spy。
 *
 * 契约（CLAUDE.md「Co-editing — every notebook」+ fileToolDeps 的注释）：这是体验上的分流，不是安全门 ——
 * 拒在询问之前（不为一次不会发生的写入弹卡），查不出来（isSessionDocument 抛）就放行、照常过路径门。
 *
 *   FD-SD0 那句话本身（逐字钉住：它指向 doc_edit / doc_insert）
 *   FD-SD1 write 这份文档 → 失败文字恰是 SESSION_DOCUMENT_REFUSAL；不弹卡、不记决策、字节不变
 *   FD-SD2 edit 这份文档 → 同上
 *   FD-SD3 read 这份文档照常读到，从不问 isSessionDocument
 *   FD-SD4 写同目录的别的文件 → 照常（一张卡、允许后落盘）
 *   FD-SD5 相对路径解析到这份文档 → spy 收到 (ctx.sessionId, 绝对路径)，被拒
 *   FD-SD6 isSessionDocument 抛 → 放行（照常一张卡、允许后落盘）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import {
  executeTool,
  failureText,
  resultText
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const SESSION_ID = 'session-doc-refusal'

const state = vi.hoisted(() => ({
  dir: '',
  requests: [] as InputRequest[],
  respond: (() => ({ kind: 'ask', allowed: true })) as (
    req: InputRequest
  ) => InputResponse | Promise<InputResponse>,
  isSessionDocument: vi.fn((_sid: string, _p: string): boolean => false)
}))

// 可编程 provider：桌面口径（内置 ask-on-external-path；会话目录给空 → 每次写都问），询问挂起走 spy
vi.mock('../../services/toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { sep: pathSep, join: joinPath } = await import('node:path')
  const makeContext = (): unknown =>
    createSecurityContext(
      { kind: 'agent', sessionId: 'session-doc-refusal', agentKind: 'root' },
      { host: 'desktop' },
      {
        host: 'desktop',
        pathSep,
        getVars: () => ({
          workspace: state.dir,
          toolResultsBase: joinPath(state.dir, '.nonexistent-tool-results'),
          skillsDirs: [],
          knowledgeRoot: '/kb',
          knowledgeSessionDirs: [],
          home: joinPath(state.dir, '.nonexistent-home'),
          systemDirs: [],
          // 会话权限表给空：写哪儿都问
          aclRead: [],
          aclWrite: []
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
    isSessionDocument: state.isSessionDocument,
    TOOL_ABORTED: 'Aborted'
  }
})
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { makeWriteTool } from '../write'
import { makeEditTool } from '../edit'
import { makeReadTool } from '../read'
import { SESSION_DOCUMENT_REFUSAL } from '../fileToolDeps'
import { _resetAll } from '../../utils/toolUtils/fileTime'
import type { ToolContext } from '../../services/toolContext'
import { clearSessionDecisions, getSessionDecisions } from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'

/** 内置策略 md 的构建期内联读取口（真实装配链要它；测试进程，不进桌面 bundle） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

const ctx: ToolContext = { sessionId: SESSION_ID }
const DOC_BODY = '# Doc\n\nbody\n'
let doc = ''

beforeAll(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'shuvix-session-doc-refusal-'))
  doc = join(state.dir, 'doc.md')
})
afterAll(() => rmSync(state.dir, { recursive: true, force: true }))
beforeEach(() => {
  _resetAll()
  clearSessionDecisions(SESSION_ID)
  writeFileSync(doc, DOC_BODY)
  state.requests = []
  state.respond = () => ({ kind: 'ask', allowed: true })
  state.isSessionDocument.mockReset()
  state.isSessionDocument.mockImplementation((_sid, p) => p === doc)
})

describe('桌面 write / edit — 笔记本会话自己那份文档', () => {
  it('FD-SD0 那句话本身：指向 doc_edit / doc_insert', () => {
    expect(SESSION_DOCUMENT_REFUSAL).toBe(
      "This is the document open in this notebook session. Change it with doc_edit or doc_insert, so the change lands in the user's editor; write and edit are for other files."
    )
  })

  it('FD-SD1 write 这份文档 → 恰是那句话；不弹卡、不记决策、字节不变', async () => {
    expect(
      await failureText(executeTool(makeWriteTool(ctx), 'sd1', { path: doc, content: 'x\n' }))
    ).toBe(SESSION_DOCUMENT_REFUSAL)
    expect(state.isSessionDocument).toHaveBeenCalledWith(SESSION_ID, doc)
    expect(state.requests).toEqual([])
    expect(getSessionDecisions(SESSION_ID)).toEqual([])
    expect(readFileSync(doc, 'utf-8')).toBe(DOC_BODY)
  })

  it('FD-SD2 edit 这份文档（先读过）→ 同一句话；不弹卡、不记决策、字节不变', async () => {
    await executeTool(makeReadTool(ctx), 'sd2r', { path: doc })
    clearSessionDecisions(SESSION_ID)
    expect(
      await failureText(
        executeTool(makeEditTool(ctx), 'sd2', { path: doc, oldText: 'body', newText: 'BODY' })
      )
    ).toBe(SESSION_DOCUMENT_REFUSAL)
    expect(state.requests).toEqual([])
    expect(getSessionDecisions(SESSION_ID)).toEqual([])
    expect(readFileSync(doc, 'utf-8')).toBe(DOC_BODY)
  })

  it('FD-SD3 read 这份文档照常读到，从不问 isSessionDocument', async () => {
    const res = await executeTool(makeReadTool(ctx), 'sd3', { path: doc })
    expect(res.isError).toBeFalsy()
    expect(resultText(res)).toContain('body')
    expect(state.isSessionDocument).not.toHaveBeenCalled()
  })

  it('FD-SD4 写同目录的别的文件 → 照常：一张带预览的卡，允许后落盘', async () => {
    const sibling = join(state.dir, 'sibling.md')
    const res = await executeTool(makeWriteTool(ctx), 'sd4', { path: sibling, content: 'hi\n' })
    expect(res.isError, resultText(res)).toBeFalsy()
    expect(state.isSessionDocument).toHaveBeenCalledWith(SESSION_ID, sibling)
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0].toolName).toBe('write')
    expect(readFileSync(sibling, 'utf-8')).toBe('hi\n')
  })

  it('FD-SD5 相对路径解析到这份文档 → spy 收到 (会话 id, 绝对路径)，被拒', async () => {
    expect(
      await failureText(executeTool(makeWriteTool(ctx), 'sd5', { path: 'doc.md', content: 'x\n' }))
    ).toBe(SESSION_DOCUMENT_REFUSAL)
    expect(state.isSessionDocument).toHaveBeenCalledWith(SESSION_ID, doc)
    expect(state.isSessionDocument).not.toHaveBeenCalledWith(SESSION_ID, 'doc.md')
    expect(state.requests).toEqual([])
    expect(readFileSync(doc, 'utf-8')).toBe(DOC_BODY)
  })

  it('FD-SD6 isSessionDocument 抛 → 放行：照常一张卡，允许后落盘', async () => {
    state.isSessionDocument.mockImplementation(() => {
      throw new Error('session row unreadable')
    })
    await executeTool(makeReadTool(ctx), 'sd6r', { path: doc })
    const res = await executeTool(makeWriteTool(ctx), 'sd6', { path: doc, content: 'new\n' })
    expect(res.isError, resultText(res)).toBeFalsy()
    expect(state.isSessionDocument).toHaveBeenCalled()
    expect(state.requests).toHaveLength(1)
    expect(readFileSync(doc, 'utf-8')).toBe('new\n')
  })
})
