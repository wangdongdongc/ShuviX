/**
 * 桌面文件工具 deps 的知识库接线（fileToolDeps.ts）—— 真实临时文件 + 真实 fileTime + 真实安全模块
 * （同 writeAskWiring.test 的 provider 桩），只把 ShuviX 知识库根指到临时目录、把变更管线换成 spy：
 * 该根下的 md 落盘后盖 `generated`（actor = agentActorOf(ctx)）并进 notifyKnowledgeFileChanged
 * （模块按需加载）；根外一切照旧。
 *
 * 库上**没有任何内置策略**（等整体定型再设计），所以这里免询问开着就不该再弹卡 ——
 * 盖章与变更管线跟安全模块是两件事，这条得分开钉住。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

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
      { kind: 'agent', sessionId: 'kb-session', agentKind: 'root' },
      { host: 'desktop' },
      {
        host: 'desktop',
        pathSep,
        getVars: () => ({
          workspace: state.dir,
          toolResultsBase: joinPath(state.dir, '.nonexistent-tool-results'),
          skillsDirs: [],
          memoryDirs: [],
          home: joinPath(state.dir, '.nonexistent-home'),
          systemDirs: []
        }),
        // 免询问开着：库上没有策略，所以知识库写也不问
        getSessionGrants: () => ({ autoAllow: true, allowList: [] }),
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
    agentActorOf: (ctx: {
      agent?: { profileName?: string; getModelConfig?: () => { model?: string } }
    }): string =>
      `shuvix-${ctx.agent?.profileName ?? 'agent'}/${ctx.agent?.getModelConfig?.().model ?? 'unknown'}`,
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
  getUserKnowledgeRootDir: () => `${state.kb}-user`
}))
vi.mock('../../services/knowledge', () => ({ notifyKnowledgeFileChanged: state.notify }))

import { makeWriteTool } from '../write'
import { makeEditTool } from '../edit'
import { _resetAll } from '../../utils/toolUtils/fileTime'
import type { ToolContext } from '../../services/toolContext'

const DRAFT = [
  '---',
  'type: Memory',
  'title: T',
  'description: d',
  'status: draft',
  '---',
  '',
  'body',
  ''
].join('\n')
const ctx: ToolContext = {
  sessionId: 'kb-session',
  agent: {
    profileName: 'work',
    kind: 'root',
    getModelConfig: () => ({ provider: 'p', model: 'gpt-5', capabilities: {} })
  }
}
const textOf = (res: { content: unknown[] }): string => (res.content[0] as { text: string }).text

beforeAll(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'shuvix-filetool-kb-'))
  state.kb = join(state.dir, 'kb')
  mkdirSync(join(state.kb, 'projects', 'acme'), { recursive: true })
})
afterAll(() => rmSync(state.dir, { recursive: true, force: true }))
beforeEach(() => {
  _resetAll()
  state.requests = []
  state.notify.mockClear()
  state.respond = () => ({ kind: 'ask', allowed: true })
})

describe('桌面文件工具 — 知识库根目录下的写入', () => {
  it('FD-1 write：落盘并盖 generated（actor 取自 ctx.agent）、回执 [OKF] Stamped、变更管线收到 write；edit 收到 edit；库上无策略故不弹卡', async () => {
    const p = join(state.kb, 'projects', 'acme', 'x.md')
    const res = await makeWriteTool(ctx).execute('w1', { path: p, content: DRAFT })

    // 库上没有内置策略：免询问开着，知识库写与普通写一样不问
    expect(state.requests).toEqual([])

    expect(readFileSync(p, 'utf-8')).toContain('generated: { by: "shuvix-work/gpt-5", at: "')
    expect(textOf(res)).toContain('[OKF] Stamped')
    // 变更管线模块按需加载（动态 import）：等一拍
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(1))
    expect(state.notify).toHaveBeenCalledWith(p, { kind: 'write', actor: 'shuvix-work/gpt-5' })

    await makeEditTool(ctx).execute('e1', { path: p, oldText: 'body', newText: 'body two' })
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(2))
    expect(state.notify).toHaveBeenLastCalledWith(p, { kind: 'edit', actor: 'shuvix-work/gpt-5' })
    expect(readFileSync(p, 'utf-8')).toContain('body two')
    expect(readFileSync(p, 'utf-8')).toContain('generated: { by: "shuvix-work/gpt-5", at: "')
  })

  it('FD-2 根外的 md：不盖章、无回执、变更管线不收', async () => {
    const p = join(state.dir, 'plain.md')
    const res = await makeWriteTool(ctx).execute('w2', { path: p, content: DRAFT })
    expect(state.requests).toEqual([])
    expect(readFileSync(p, 'utf-8')).toBe(DRAFT)
    expect(textOf(res)).not.toContain('[OKF]')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(state.notify).not.toHaveBeenCalled()
  })
})
