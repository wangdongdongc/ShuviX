/**
 * 桌面文件工具 deps 的知识库接线（fileToolDeps.ts）—— 真实临时文件 + 真实 fileTime + 真实安全模块
 * （同 writeAskWiring.test 的 provider 桩），只把两个知识库根指到临时目录、把变更管线换成 spy：
 * 落在某个库里（项目库或用户库）的 md 落盘后盖 `generated`（actor = agentActorOf(ctx)）并进
 * notifyKnowledgeFileChanged（模块按需加载）；不属于任何库的路径（根外、用户根散文件、隐藏目录）一切照旧。
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
  getUserKnowledgeRootDir: () => `${state.kb}-user`,
  // 内置库根替身：不存在的兄弟目录 —— 这些用例里没有内置库
  getBuiltinKnowledgeDir: () => `${state.kb}-builtin`
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
  mkdirSync(join(`${state.kb}-user`, 'notes'), { recursive: true })
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

  it('FD-3 用户库里的 write / edit 与项目库一样：盖 generated、回执 [OKF] Stamped、变更管线收到 write / edit；不弹卡', async () => {
    const p = join(`${state.kb}-user`, 'notes', 'x.md')
    const res = await makeWriteTool(ctx).execute('w3', { path: p, content: DRAFT })

    expect(state.requests).toEqual([])
    expect(readFileSync(p, 'utf-8')).toContain('generated: { by: "shuvix-work/gpt-5", at: "')
    expect(textOf(res)).toContain('[OKF] Stamped')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(1))
    expect(state.notify).toHaveBeenCalledWith(p, { kind: 'write', actor: 'shuvix-work/gpt-5' })

    await makeEditTool(ctx).execute('e3', { path: p, oldText: 'body', newText: 'body two' })
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(2))
    expect(state.notify).toHaveBeenLastCalledWith(p, { kind: 'edit', actor: 'shuvix-work/gpt-5' })
    const after = readFileSync(p, 'utf-8')
    expect(after).toContain('body two')
    expect(after).toContain('generated: { by: "shuvix-work/gpt-5", at: "')
    expect(state.requests).toEqual([])
  })

  it('FD-4 在用户根下但不属于任何库（用户根散文件 / 根下与库内的隐藏目录）：不盖章、无回执、变更管线不收、不弹卡', async () => {
    const userRoot = `${state.kb}-user`
    for (const p of [
      join(userRoot, 'x.md'),
      join(userRoot, '.trash', 'x.md'),
      join(userRoot, 'notes', '.trash', 'x.md')
    ]) {
      const res = await makeWriteTool(ctx).execute('w4', { path: p, content: DRAFT })
      expect(readFileSync(p, 'utf-8'), p).toBe(DRAFT)
      expect(textOf(res), p).not.toContain('[OKF]')
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(state.notify).not.toHaveBeenCalled()
    expect(state.requests).toEqual([])
  })

  /**
   * 读宽写严（设计附录 L）：只有自称条目的 md 才盖 `generated`。普通笔记（包括保留名下手写的、以及
   * frontmatter 写坏的）宿主一个字节都不改，但它照样是库里的一篇笔记 —— 变更管线照常收到。
   */
  it('FD-5 普通笔记经真实 write / edit：宿主一个字节不改、不回盖章回执，变更管线照常收到', async () => {
    // 没有 frontmatter 的普通笔记
    const plain = join(state.kb, 'projects', 'acme', 'plain.md')
    const written = await makeWriteTool(ctx).execute('w5', {
      path: plain,
      content: '# Plain\n\nbody\n'
    })
    expect(readFileSync(plain, 'utf-8')).toBe('# Plain\n\nbody\n')
    expect(textOf(written)).not.toContain('[OKF]')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(1))
    expect(state.notify).toHaveBeenLastCalledWith(plain, {
      kind: 'write',
      actor: 'shuvix-work/gpt-5'
    })

    const edited = await makeEditTool(ctx).execute('e5', {
      path: plain,
      oldText: 'body',
      newText: 'body two'
    })
    expect(readFileSync(plain, 'utf-8')).toBe('# Plain\n\nbody two\n')
    expect(textOf(edited)).not.toContain('[OKF]')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(2))
    expect(state.notify).toHaveBeenLastCalledWith(plain, {
      kind: 'edit',
      actor: 'shuvix-work/gpt-5'
    })

    // 用户库里手写的 index.md：保留名从不盖章，带 type 也一样
    const index = join(`${state.kb}-user`, 'notes', 'index.md')
    const home = '---\ntype: Memory\ntitle: Home\n---\n\n# Home\n'
    const indexRes = await makeWriteTool(ctx).execute('w6', { path: index, content: home })
    expect(readFileSync(index, 'utf-8')).toBe(home)
    expect(textOf(indexRes)).not.toContain('[OKF] Stamped')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(3))
    expect(state.notify).toHaveBeenLastCalledWith(index, {
      kind: 'write',
      actor: 'shuvix-work/gpt-5'
    })

    // frontmatter 写坏的普通笔记：只回语法提醒，文件原样
    const broken = join(state.kb, 'projects', 'acme', 'broken.md')
    const brokenText = '---\ntitle: [x\n---\nbody\n'
    const brokenRes = await makeWriteTool(ctx).execute('w7', { path: broken, content: brokenText })
    expect(textOf(brokenRes)).toContain('[OKF] Written with warnings')
    expect(textOf(brokenRes)).not.toContain('[OKF] Stamped')
    expect(readFileSync(broken, 'utf-8')).toBe(brokenText)
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(4))
  })
})
