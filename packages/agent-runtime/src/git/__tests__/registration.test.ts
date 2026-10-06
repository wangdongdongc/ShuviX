/**
 * git 工具作为 pi-durable 注册项（git/tool.ts 的 createGitTool）。
 *
 * 业务行为（各 action、dir 参数、询问接线）由 acceptance / dirParam / ask 三份测试钉；这里只钉迁移
 * 带来的那一层契约：
 *   GIT-R1 注册项形状：name 'git'、`replay: 'unsafe'`（一个工具里混着写操作，中断不重跑）、
 *          label 缺省 'Git' 可由宿主换、描述 / schema 静态生成、durable 兜底截断取 2× 缺省
 *   GIT-R2 工具调用 id = `api.callId`：resolveDir 与 askOp 拿到的都是它，连同 `api.taskId` /
 *          `api.conversationId`（P1-06：宿主并进 EnforceOpts，询问与审查按 tool task 认人）
 *   GIT-R3 失败交回 isError（裁定 Q12）：askOp 拒绝 → resolve 成 isError 结果、文字即那条错误；
 *          resolveDir 报出 abortError 而调用并没被取消 → 同样是 isError（文字与旧版一致）
 *   GIT-R4 取消照旧抛：context 已取消 → 拒绝且不碰环境；询问中途被取消 → 拒绝
 */
import { describe, expect, it, vi } from 'vitest'
import type { GitEnv } from '../env'
import { buildGitToolDescription, createGitTool, type CreateGitToolOptions } from '../tool'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '../../fileTools/truncate'
import { invokeTool, resultText } from '../../tools/testing/invokeTool'

/** 用不到真仓库：本组用例在 dispatch 之前就结束（help、或询问 / 解析目录那一步） */
const FAKE_ENV = { dir: '/work', fs: { promises: {} } } as unknown as GitEnv

function gitTool(over: Partial<CreateGitToolOptions> = {}): ReturnType<typeof createGitTool> {
  return createGitTool({ getEnv: () => FAKE_ENV, ...over })
}

describe('GIT-R 注册项形状', () => {
  it('GIT-R1 name / replay unsafe / label（缺省与宿主给的）/ 描述 / 兜底截断', () => {
    const tool = gitTool()
    expect(tool).toMatchObject({
      name: 'git',
      label: 'Git',
      replay: 'unsafe',
      description: buildGitToolDescription(),
      outputLimits: {
        maxBytes: 2 * DEFAULT_MAX_BYTES,
        maxLines: 2 * DEFAULT_MAX_LINES,
        retain: 'head'
      }
    })
    expect(tool.parameters).toMatchObject({ type: 'object' })
    expect(gitTool({ label: '版本控制' }).label).toBe('版本控制')
  })

  it('GIT-R1 help 不碰环境，结果带 git details', async () => {
    const getEnv = vi.fn(() => FAKE_ENV)
    const { result } = await invokeTool(gitTool({ getEnv }), { action: 'help' })
    expect(result.isError).toBeUndefined()
    expect(resultText(result)).toContain('git')
    expect(result.details).toEqual({ type: 'git', action: 'help' })
    expect(getEnv).not.toHaveBeenCalled()
  })
})

describe('GIT-R 调用身份与失败口径', () => {
  it('GIT-R2 / R3 resolveDir 与 askOp 拿到的 toolCallId 是 api.callId；askOp 拒绝 → isError、文字即原话', async () => {
    const resolveDir = vi.fn(async () => '/elsewhere')
    const askOp = vi.fn(async () => {
      throw new Error('Denied by security policy rule "no-commit#0"')
    })
    const tool = gitTool({ resolveDir, askOp })

    const { result } = await invokeTool(
      tool,
      { action: 'commit', message: 'm', dir: 'other' },
      { callId: 'call-git-1', taskId: 5 }
    )

    // P1-06：durable 的调用归属（api.taskId / api.conversationId）随 toolCallId 一起交下去
    expect(resolveDir).toHaveBeenCalledWith('other', {
      action: 'commit',
      mutates: true,
      toolCallId: 'call-git-1',
      taskId: 5,
      conversationId: 1
    })
    expect(askOp).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'commit',
        toolCallId: 'call-git-1',
        taskId: 5,
        conversationId: 1
      })
    )
    expect(result).toStrictEqual({
      isError: true,
      content: [{ type: 'text', text: 'Denied by security policy rule "no-commit#0"' }]
    })
  })

  it('GIT-R3 resolveDir 报出 abortError、调用并没被取消 → isError「Aborted」（不抛）', async () => {
    const tool = gitTool({
      resolveDir: async () => {
        throw new Error('Aborted')
      }
    })
    const { result } = await invokeTool(tool, { action: 'status', dir: 'other' })
    expect(result).toStrictEqual({ isError: true, content: [{ type: 'text', text: 'Aborted' }] })
  })
})

describe('GIT-R 取消', () => {
  it('GIT-R4 context 已取消 → 拒绝，环境都不取', async () => {
    const getEnv = vi.fn(() => FAKE_ENV)
    const ac = new AbortController()
    ac.abort()
    await expect(
      invokeTool(gitTool({ getEnv }), { action: 'status' }, { signal: ac.signal })
    ).rejects.toThrow('Aborted')
    expect(getEnv).not.toHaveBeenCalled()
  })

  it('GIT-R4 询问中途调用被取消（askOp 随之抛出）→ 拒绝，不收成 isError', async () => {
    const ac = new AbortController()
    const err = new Error('Aborted')
    const askOp = vi.fn(async () => {
      ac.abort()
      throw err
    })
    await expect(
      invokeTool(gitTool({ askOp }), { action: 'init' }, { signal: ac.signal })
    ).rejects.toBe(err)
  })
})
