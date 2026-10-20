/**
 * 桌面文件工具 deps 的知识库接线（fileToolDeps.ts）—— 真实临时文件 + 真实 fileTime + 真实安全模块
 * （同 writeAskWiring.test 的 provider 桩），只把两个知识库根指到临时目录、把变更管线换成 spy：
 * 落在某个库里（项目库或用户库）的 md 落盘后盖 `generated`（actor = agentActorOf(ctx)）并进
 * notifyKnowledgeFileChanged（模块按需加载）；不属于任何库的路径（根外、用户根散文件、隐藏目录）一切照旧。
 *
 * 用户库与项目库上**没有任何内置策略**（等整体定型再设计），所以这里对整个临时目录「允许并记住」了写
 * （会话权限表里授予的写：vars.aclWrite 里的 <临时目录>）就不该再弹卡 —— 盖章与变更管线跟安全模块是两件事，这条得分开钉住。
 *
 * 第三个根是随应用发布的**内置库**（`<内置根>/<库名>/<语言>/…`，只读）：`knowledge.locate` 对它回 null，
 * 所以不盖章、不回执、不进管线（FD-6..FD-8）。它**没有**拒写策略（随包资源的统一裁决，见
 * builtinPolicies/index.ts）：写确实落盘，只是盖章与管线都绕开它 —— 下个版本随包还原。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import {
  executeTool,
  failureText,
  invokeTool
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
      { kind: 'agent', sessionId: 'kb-session', agentKind: 'root' },
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
          // 整个临时目录「允许并记住」了写（会话权限表，写隐含读）：库上没有策略，所以知识库写也不问
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
  // 内置库根替身：kb 的兄弟目录（同在临时目录树下，afterAll 一并收）
  getBuiltinKnowledgeDir: () => `${state.kb}-builtin`,
  // read 工具（FD-9..）的图片落盘目录；文本读取用不上，补上免得替身缺导出
  getToolResultsDir: () => join(state.dir, 'tool_results')
}))
// i18next 是单例：内置库的语言目录从它现读（真身在单测里没 init，`language` 是 undefined）——
// 替身把「当前界面语言」写死成 en，磁盘上那一层就是 `<内置根>/<库名>/en/`
vi.mock('i18next', () => ({ default: { language: 'en', t: (key: string) => `i18n(${key})` } }))
vi.mock('../../services/knowledge', () => ({ notifyKnowledgeFileChanged: state.notify }))

import { makeWriteTool } from '../write'
import { makeEditTool } from '../edit'
import { makeReadTool } from '../read'
import { _resetAll } from '../../utils/toolUtils/fileTime'
// 真的路径算术（fileToolDeps 走的也是这个子模块，不是被替身挡住的 services/knowledge 入口）：
// FD-6 拿它证明那条路径**确实落在内置库里**，而不是「不属于任何库」—— 否则与 FD-2 就没区别了
import { locateBundle } from '../../services/knowledge/knowledgePaths'
import type { ToolContext } from '../../services/toolContext'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'

/** 内置策略 md 的构建期内联读取口（真实装配链要它；测试进程，不进桌面 bundle） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

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

/** 内置库的 bundle 目录 —— 语言那一层（`<内置根>/shuvix/en/`），FD-6..FD-8 用 */
let builtinDir: string

beforeAll(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'shuvix-filetool-kb-'))
  state.kb = join(state.dir, 'kb')
  mkdirSync(join(state.kb, 'projects', 'acme'), { recursive: true })
  mkdirSync(join(`${state.kb}-user`, 'notes'), { recursive: true })
  builtinDir = join(`${state.kb}-builtin`, 'shuvix', 'en')
  mkdirSync(builtinDir, { recursive: true })
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
    const res = await executeTool(makeWriteTool(ctx), 'w1', { path: p, content: DRAFT })

    // 库上没有内置策略：写授权盖着整个临时目录，知识库写与普通写一样不问
    expect(state.requests).toEqual([])

    expect(readFileSync(p, 'utf-8')).toContain('generated: { by: "shuvix-work/gpt-5", at: "')
    expect(textOf(res)).toContain('[OKF] Stamped')
    // 变更管线模块按需加载（动态 import）：等一拍
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(1))
    expect(state.notify).toHaveBeenCalledWith(p, { kind: 'write', actor: 'shuvix-work/gpt-5' })

    await executeTool(makeEditTool(ctx), 'e1', { path: p, oldText: 'body', newText: 'body two' })
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(2))
    expect(state.notify).toHaveBeenLastCalledWith(p, { kind: 'edit', actor: 'shuvix-work/gpt-5' })
    expect(readFileSync(p, 'utf-8')).toContain('body two')
    expect(readFileSync(p, 'utf-8')).toContain('generated: { by: "shuvix-work/gpt-5", at: "')
  })

  it('FD-2 根外的 md：不盖章、无回执、变更管线不收', async () => {
    const p = join(state.dir, 'plain.md')
    const res = await executeTool(makeWriteTool(ctx), 'w2', { path: p, content: DRAFT })
    expect(state.requests).toEqual([])
    expect(readFileSync(p, 'utf-8')).toBe(DRAFT)
    expect(textOf(res)).not.toContain('[OKF]')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(state.notify).not.toHaveBeenCalled()
  })

  it('FD-3 用户库里的 write / edit 与项目库一样：盖 generated、回执 [OKF] Stamped、变更管线收到 write / edit；不弹卡', async () => {
    const p = join(`${state.kb}-user`, 'notes', 'x.md')
    const res = await executeTool(makeWriteTool(ctx), 'w3', { path: p, content: DRAFT })

    expect(state.requests).toEqual([])
    expect(readFileSync(p, 'utf-8')).toContain('generated: { by: "shuvix-work/gpt-5", at: "')
    expect(textOf(res)).toContain('[OKF] Stamped')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(1))
    expect(state.notify).toHaveBeenCalledWith(p, { kind: 'write', actor: 'shuvix-work/gpt-5' })

    await executeTool(makeEditTool(ctx), 'e3', { path: p, oldText: 'body', newText: 'body two' })
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
      const res = await executeTool(makeWriteTool(ctx), 'w4', { path: p, content: DRAFT })
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
    const written = await executeTool(makeWriteTool(ctx), 'w5', {
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

    const edited = await executeTool(makeEditTool(ctx), 'e5', {
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
    const indexRes = await executeTool(makeWriteTool(ctx), 'w6', { path: index, content: home })
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
    const brokenRes = await executeTool(makeWriteTool(ctx), 'w7', {
      path: broken,
      content: brokenText
    })
    expect(textOf(brokenRes)).toContain('[OKF] Written with warnings')
    expect(textOf(brokenRes)).not.toContain('[OKF] Stamped')
    expect(readFileSync(broken, 'utf-8')).toBe(brokenText)
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(4))
  })

  /**
   * 内置库（应用包里的只读说明书，FD-6..FD-8）：`bundleRelOf` 对它回 null，所以文件工具这一侧
   * 两件事一起绕开 —— 写钩子不盖章 / 不回执，onFileChange 不进变更管线。判据深到**语言那一层**：
   * bundle 目录是 `<内置根>/<库名>/<语言>/`。
   */
  it('FD-6 内置库里的条目：locate 回 null —— 不盖 generated、不回 OKF 回执，write / edit 都是一个字节不改', async () => {
    const p = join(builtinDir, 'x.md')
    // 前提：这条路径落在内置 bundle 里（语言那一层就是 bundle 根），不是「不属于任何库」
    expect(locateBundle(p)).toEqual({ bundle: 'builtin/shuvix', rel: 'x.md' })

    const res = await executeTool(makeWriteTool(ctx), 'w8', { path: p, content: DRAFT })

    // 写确实落盘了（内置库没有拒写策略：见文件头）—— 不是「没写成」所以没盖章
    expect(readFileSync(p, 'utf-8')).toBe(DRAFT)
    expect(textOf(res)).not.toContain('[OKF]')
    expect(state.requests).toEqual([])

    const edited = await executeTool(makeEditTool(ctx), 'e8', {
      path: p,
      oldText: 'body',
      newText: 'body two'
    })
    expect(readFileSync(p, 'utf-8')).toBe(DRAFT.replace('body', 'body two'))
    expect(textOf(edited)).not.toContain('[OKF]')
  })

  it('FD-7 同一次写入不进变更管线：notifyKnowledgeFileChanged 零调用（应用包里的目录没有 git 提交，也没有 knowledge.changed）', async () => {
    const p = join(builtinDir, 'y.md')
    await executeTool(makeWriteTool(ctx), 'w9', { path: p, content: DRAFT })
    await executeTool(makeEditTool(ctx), 'e9', { path: p, oldText: 'body', newText: 'body two' })

    // 管线模块是动态 import 的：等一拍再判「一次都没来」（与 FD-2 / FD-4 同口径）
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(state.notify).not.toHaveBeenCalled()
  })

  it('FD-8 对照：同一批里打到用户库的那一次照常盖章、照常进管线 —— 绕开的只有内置库那一份', async () => {
    const builtin = join(builtinDir, 'z.md')
    const user = join(`${state.kb}-user`, 'notes', 'z.md')

    await executeTool(makeWriteTool(ctx), 'w10', { path: builtin, content: DRAFT })
    const res = await executeTool(makeWriteTool(ctx), 'w11', { path: user, content: DRAFT })

    expect(readFileSync(builtin, 'utf-8')).toBe(DRAFT)
    expect(readFileSync(user, 'utf-8')).toContain('generated: { by: "shuvix-work/gpt-5", at: "')
    expect(textOf(res)).toContain('[OKF] Stamped')

    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(1))
    expect(state.notify).toHaveBeenCalledWith(user, { kind: 'write', actor: 'shuvix-work/gpt-5' })
    // 再等一拍：内置库那一次自始至终没来，不是「晚到一步」
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(state.notify).toHaveBeenCalledTimes(1)
    expect(state.requests).toEqual([])
  })
})

/**
 * H11-52（P1-11）—— 会话级装配的文件工具（ctx 带 agentOf、没有固定的 agent）：write / edit 落在库里时，
 * `generated.by` 与变更管线（notifyKnowledgeFileChanged）的 actor 都按**这次调用**的对话认人。
 */
describe('H11-52 文件工具的章按调用盖', () => {
  it('H11-52 对话 1 是 work / claude-sonnet-4-5、之后换成 bot / m2：write 与 edit 的章和管线 actor 各按自己那次调用', async () => {
    let current: ToolContext['agent'] = {
      profileName: 'work',
      kind: 'root',
      getModelConfig: () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        capabilities: {}
      })
    }
    const sessionCtx: ToolContext = { sessionId: 'kb-session', agentOf: () => current }
    const p = join(state.kb, 'projects', 'acme', 'h11-52.md')

    await invokeTool(
      makeWriteTool(sessionCtx),
      { path: p, content: DRAFT },
      {
        callId: 'h11-52-w',
        conversationId: 1
      }
    )
    expect(readFileSync(p, 'utf-8')).toContain('by: "shuvix-work/claude-sonnet-4-5"')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(1))
    expect(state.notify).toHaveBeenLastCalledWith(p, {
      kind: 'write',
      actor: 'shuvix-work/claude-sonnet-4-5'
    })

    current = {
      profileName: 'bot',
      kind: 'root',
      getModelConfig: () => ({ provider: 'anthropic', model: 'm2', capabilities: {} })
    }
    await invokeTool(
      makeEditTool(sessionCtx),
      { path: p, oldText: 'body', newText: 'body two' },
      { callId: 'h11-52-e', conversationId: 1 }
    )
    expect(readFileSync(p, 'utf-8')).toContain('by: "shuvix-bot/m2"')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(2))
    expect(state.notify).toHaveBeenLastCalledWith(p, { kind: 'edit', actor: 'shuvix-bot/m2' })
  })

  it('P2-06-15 按对话盖章：对话 2（派生 explore / haiku）写、对话 1（根）改、对话 4（派生但没有模型配置）写 → 各盖各的', async () => {
    const ROOT: ToolContext['agent'] = {
      profileName: 'work',
      kind: 'root',
      getModelConfig: () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        capabilities: {}
      })
    }
    const SPAWN_E: ToolContext['agent'] = {
      profileName: 'explore',
      kind: 'spawned',
      callerId: 'sub-a1',
      getModelConfig: () => ({ provider: 'anthropic', model: 'claude-haiku-4-5', capabilities: {} })
    }
    const BARE: ToolContext['agent'] = {
      profileName: 'explore',
      kind: 'spawned',
      callerId: 'sub-x'
    }
    const identities: Record<number, ToolContext['agent']> = { 1: ROOT, 2: SPAWN_E, 4: BARE }
    const sessionCtx: ToolContext = {
      sessionId: 'kb-session',
      agentOf: (conversationId) => identities[conversationId]
    }
    const p = join(state.kb, 'projects', 'acme', 'p2-06-15.md')
    const second = join(state.kb, 'projects', 'acme', 'p2-06-15-b.md')
    const before = state.notify.mock.calls.length

    await invokeTool(
      makeWriteTool(sessionCtx),
      { path: p, content: DRAFT },
      { callId: 'p2-06-15-w', conversationId: 2 }
    )
    expect(readFileSync(p, 'utf-8')).toContain('by: "shuvix-explore/claude-haiku-4-5"')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(before + 1))
    expect(state.notify).toHaveBeenLastCalledWith(p, {
      kind: 'write',
      actor: 'shuvix-explore/claude-haiku-4-5'
    })

    await invokeTool(
      makeEditTool(sessionCtx),
      { path: p, oldText: 'body', newText: 'body two' },
      { callId: 'p2-06-15-e', conversationId: 1 }
    )
    expect(readFileSync(p, 'utf-8')).toContain('by: "shuvix-work/claude-sonnet-4-5"')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(before + 2))
    expect(state.notify).toHaveBeenLastCalledWith(p, {
      kind: 'edit',
      actor: 'shuvix-work/claude-sonnet-4-5'
    })

    await invokeTool(
      makeWriteTool(sessionCtx),
      { path: second, content: DRAFT },
      { callId: 'p2-06-15-w4', conversationId: 4 }
    )
    expect(readFileSync(second, 'utf-8')).toContain('by: "shuvix-explore/unknown"')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(before + 3))
    expect(state.notify).toHaveBeenLastCalledWith(second, {
      kind: 'write',
      actor: 'shuvix-explore/unknown'
    })
  })
})

/**
 * FD-9..FD-15 —— 知识库里的覆盖保护（write 按 `knowledge.locate` 打开 applyWrite 的 refuseUnreadOverwrite）：
 * 落在某个可写库里、本会话没读过的既有文件，`write` 不许整篇覆盖（条目的文件名由 agent 自己挑，撞上已有的
 * 名字会把别人的条目整篇换掉）。真文件 + 真 fileTime（读取时间按会话分表）。
 *
 * 本文件的临时目录在 beforeAll 建、fileTime 每个用例 `_resetAll()`：同一路径跨用例写两次，后一次就会撞上这道
 * 保护 —— 所以这一组每条用例各用自己的文件名。
 */
describe('桌面文件工具 — 知识库条目的覆盖保护', () => {
  const OVERWRITE = 'already exists in the knowledge base'
  /** 种一份「别人写的」条目（不经工具，本会话没读过） */
  const seedTheirs = (p: string): void => {
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, DRAFT.replace('body', 'their body'), 'utf-8')
  }
  /** 拒绝之后：字节不变、不弹卡、变更管线一次都没来 */
  const expectRefusedUntouched = async (p: string): Promise<void> => {
    expect(readFileSync(p, 'utf-8')).toBe(DRAFT.replace('body', 'their body'))
    expect(state.requests).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(state.notify).not.toHaveBeenCalled()
  }

  it('FD-9 项目库里一份本会话没读过的条目 → write 被拒', async () => {
    const p = join(state.kb, 'projects', 'acme', 'fd9.md')
    seedTheirs(p)
    const msg = await failureText(
      executeTool(makeWriteTool(ctx), 'fd9', { path: p, content: DRAFT })
    )
    expect(msg).toContain(OVERWRITE)
    await expectRefusedUntouched(p)
  })

  it('FD-10 同一会话先 read 再 write → 成功、盖 generated、变更管线收到 write', async () => {
    const p = join(state.kb, 'projects', 'acme', 'fd10.md')
    seedTheirs(p)
    await executeTool(makeReadTool(ctx), 'fd10r', { path: p })
    const res = await executeTool(makeWriteTool(ctx), 'fd10w', { path: p, content: DRAFT })
    expect(res.isError).toBeFalsy()
    const after = readFileSync(p, 'utf-8')
    expect(after).toContain('generated: { by: "shuvix-work/gpt-5", at: "')
    expect(after).not.toContain('their body')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(1))
    expect(state.notify).toHaveBeenCalledWith(p, { kind: 'write', actor: 'shuvix-work/gpt-5' })
  })

  it('FD-11 用户库同样生效：没读过的既有条目 → write 被拒', async () => {
    const p = join(`${state.kb}-user`, 'notes', 'fd11.md')
    seedTheirs(p)
    const msg = await failureText(
      executeTool(makeWriteTool(ctx), 'fd11', { path: p, content: DRAFT })
    )
    expect(msg).toContain(OVERWRITE)
    await expectRefusedUntouched(p)
  })

  it('FD-12 读取时间按会话：会话 A 读过、会话 B 写同一文件 → 被拒（跨会话的「读过」不算数）', async () => {
    const p = join(state.kb, 'projects', 'acme', 'fd12.md')
    seedTheirs(p)
    await executeTool(makeReadTool({ ...ctx, sessionId: 'kb-a' }), 'fd12r', { path: p })
    const msg = await failureText(
      executeTool(makeWriteTool({ ...ctx, sessionId: 'kb-b' }), 'fd12w', {
        path: p,
        content: DRAFT
      })
    )
    expect(msg).toContain(OVERWRITE)
    await expectRefusedUntouched(p)
  })

  it('FD-13 钉住范围：不在 locate 范围里的路径（内置库、用户根散文件、库内隐藏目录）不受这道保护，照旧覆盖', async () => {
    for (const p of [
      join(builtinDir, 'fd13.md'),
      join(`${state.kb}-user`, 'fd13-loose.md'),
      join(`${state.kb}-user`, 'notes', '.obsidian', 'fd13.md')
    ]) {
      seedTheirs(p)
      const res = await executeTool(makeWriteTool(ctx), 'fd13', { path: p, content: DRAFT })
      expect(res.isError, p).toBeFalsy()
      expect(readFileSync(p, 'utf-8'), p).toBe(DRAFT)
    }
    expect(state.requests).toEqual([])
  })

  it('FD-14 本会话 write 新建之后再 write 同一文件 → 成功（写后记了读取时间）', async () => {
    const p = join(state.kb, 'projects', 'acme', 'fd14.md')
    const first = await executeTool(makeWriteTool(ctx), 'fd14a', { path: p, content: DRAFT })
    expect(first.isError).toBeFalsy()
    const second = await executeTool(makeWriteTool(ctx), 'fd14b', {
      path: p,
      content: DRAFT.replace('body', 'body two')
    })
    expect(second.isError).toBeFalsy()
    expect(readFileSync(p, 'utf-8')).toContain('body two')
  })

  it('FD-15 跨工具承诺「Re-read it before editing it again」：读过之后文件被宿主改写（模拟 submit 盖章）→ edit 报读后被改；再读一次就能改', async () => {
    const p = join(state.kb, 'projects', 'acme', 'fd15.md')
    seedTheirs(p)
    await executeTool(makeReadTool(ctx), 'fd15r1', { path: p })
    // 宿主盖章：内容变了，mtime 显式钉在「第一次读之后 100ms」—— fileTime 有 50ms 容差，靠写入时刻碰运气会
    // flaky；又不能推到将来，否则下面重读之后的 edit 照样被判「读后被改」。等 150ms 让重读落在它之后
    const readAt = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 150))
    writeFileSync(p, DRAFT.replace('body', 'their body stamped'), 'utf-8')
    const stampedAt = new Date(readAt + 100)
    utimesSync(p, stampedAt, stampedAt)

    const msg = await failureText(
      executeTool(makeEditTool(ctx), 'fd15e1', {
        path: p,
        oldText: 'their body stamped',
        newText: 'our body'
      })
    )
    expect(msg).toContain('modified since it was last read')
    expect(readFileSync(p, 'utf-8')).toContain('their body stamped')

    await executeTool(makeReadTool(ctx), 'fd15r2', { path: p })
    const ok = await executeTool(makeEditTool(ctx), 'fd15e2', {
      path: p,
      oldText: 'their body stamped',
      newText: 'our body'
    })
    expect(ok.isError).toBeFalsy()
    expect(readFileSync(p, 'utf-8')).toContain('our body')
  })
})
