/**
 * 桌面 git 工具的审批接线集成测试 —— 经 registerBuiltinTool 捕获的 factory 拿到真实工具，
 * 真实临时仓库 + mock 掉 toolContext/sessionDao/i18n。
 *
 * 覆盖 makeDesktopApproveOp 的五条响应分支、makeDesktopResolveDir 的「工作目录内豁免」，
 * 以及三语审批文案键的齐全性。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'

interface CapturedTool {
  execute: (id: string, params: unknown) => Promise<{ content: { type: string }[] }>
}

interface Registration {
  name: string
  factory: (ctx: { sessionId: string; requestUserInput?: unknown }) => CapturedTool
}

const state = vi.hoisted(() => ({
  workingDirectory: '',
  settings: undefined as { autoApprove?: boolean } | undefined,
  registration: undefined as unknown,
  readGuard: [] as { path: string; displayPath?: string }[],
  writeGuard: [] as { path: string; displayPath?: string }[]
}))

vi.mock('../../services/toolContext', () => ({
  TOOL_ABORTED: 'Aborted',
  resolveProjectConfig: () => ({ workingDirectory: state.workingDirectory }),
  isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
    const r = resolve(absolutePath)
    const base = resolve(workingDirectory)
    return r === base || r.startsWith(base + sep)
  },
  assertReadApproved: (
    _ctx: unknown,
    _config: unknown,
    _id: string,
    _tool: string,
    path: string,
    displayPath?: string
  ) => void state.readGuard.push({ path, displayPath }),
  assertWriteApproved: (
    _ctx: unknown,
    _config: unknown,
    _id: string,
    _tool: string,
    path: string,
    displayPath?: string
  ) => void state.writeGuard.push({ path, displayPath })
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pickSettings: () => state.settings }
}))
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: (reg: unknown) => void (state.registration = reg)
}))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))

import '../git'

const dirs: string[] = []

function makeDir(): string {
  const d = nodeFs.mkdtempSync(join(tmpdir(), 'shuvix-desktop-git-'))
  dirs.push(d)
  return d
}

function makeRepo(): string {
  const d = makeDir()
  execSync('git init -b main', { cwd: d, stdio: 'ignore' })
  return d
}

function textOf(result: { content: { type: string }[] }): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

/** 用捕获到的注册项装出一个真实 git 工具（走桌面 resolveDir / approveOp） */
function makeTool(requestUserInput?: (req: InputRequest) => Promise<InputResponse>): CapturedTool {
  const reg = state.registration as Registration
  return reg.factory({ sessionId: 'git-session', requestUserInput })
}

beforeEach(() => {
  state.workingDirectory = makeDir()
  state.settings = undefined
  state.readGuard = []
  state.writeGuard = []
})

afterEach(() => {
  for (const d of dirs.splice(0)) nodeFs.rmSync(d, { recursive: true, force: true })
})

describe('桌面 makeDesktopApproveOp', () => {
  it('GIT-9: 弹审批时带上 reason 对应的本地化描述与命令行', async () => {
    const requests: InputRequest[] = []
    const tool = makeTool(async (req) => {
      requests.push(req)
      return { kind: 'approval', approved: true }
    })

    await tool.execute('a1', { action: 'init' })

    expect(requests).toHaveLength(1)
    const req = requests[0]
    if (req.kind !== 'approval') throw new Error('expected approval request')
    expect(req.id).toBe('a1')
    expect(req.toolName).toBe('git')
    expect(req.command).toBe('git init')
    expect(req.description).toBe('tool.gitApproval.createRepo')
    expect(existsSync(join(state.workingDirectory, '.git'))).toBe(true)
  })

  it('GIT-9: 会话免审批 → 零弹窗直接执行', async () => {
    state.settings = { autoApprove: true }
    const requestUserInput = vi.fn(
      async (): Promise<InputResponse> => ({ kind: 'approval', approved: true })
    )
    const tool = makeTool(requestUserInput)

    await tool.execute('a2', { action: 'init' })

    expect(requestUserInput).not.toHaveBeenCalled()
    expect(existsSync(join(state.workingDirectory, '.git'))).toBe(true)
  })

  it('GIT-9: 无 requestUserInput 通道 → 直接放行（与文件写入链相反，pin 当前有意为之的行为）', async () => {
    const tool = makeTool(undefined)

    const out = await tool.execute('a3', { action: 'init' })

    expect(textOf(out)).not.toContain('Error')
    expect(existsSync(join(state.workingDirectory, '.git'))).toBe(true)
  })

  it('GIT-9: cancel → 抛 Aborted，操作不执行', async () => {
    const tool = makeTool(async () => ({ kind: 'cancel', reason: 'aborted' }))

    await expect(tool.execute('a4', { action: 'init' })).rejects.toThrow('Aborted')
    expect(existsSync(join(state.workingDirectory, '.git'))).toBe(false)
  })

  it('GIT-9: other → 抛含 provided feedback instead 的错误，操作不执行', async () => {
    const tool = makeTool(async () => ({ kind: 'other', text: '先别建仓库' }))

    await expect(tool.execute('a5', { action: 'init' })).rejects.toThrow(
      /User declined git init and provided feedback instead: 先别建仓库/
    )
    expect(existsSync(join(state.workingDirectory, '.git'))).toBe(false)
  })

  it('GIT-9: approved:false → 抛 User denied git ...（带 reason 时抛 reason）', async () => {
    const denied = makeTool(async () => ({ kind: 'approval', approved: false }))
    await expect(denied.execute('a6', { action: 'init' })).rejects.toThrow('User denied git init')
    expect(existsSync(join(state.workingDirectory, '.git'))).toBe(false)

    const withReason = makeTool(async () => ({
      kind: 'approval',
      approved: false,
      reason: '这个目录不要建仓库'
    }))
    await expect(withReason.execute('a7', { action: 'init' })).rejects.toThrow('这个目录不要建仓库')
  })
})

describe('桌面 makeDesktopResolveDir', () => {
  it('GIT-10: dir 在工作目录内 + mutates → 不触发路径审批', async () => {
    const repo = join(state.workingDirectory, 'sub')
    nodeFs.mkdirSync(repo, { recursive: true })
    execSync('git init -b main', { cwd: repo, stdio: 'ignore' })
    nodeFs.writeFileSync(join(repo, 'a.txt'), 'hi\n')

    const tool = makeTool(async () => ({ kind: 'approval', approved: true }))
    const out = await tool.execute('r1', { action: 'add', dir: 'sub', paths: ['a.txt'] })

    expect(textOf(out)).not.toContain('Error')
    // 相对 dir 归一到工作目录内的仓库，且暂存真的发生了
    expect(execSync('git diff --cached --name-only', { cwd: repo, encoding: 'utf8' })).toContain(
      'a.txt'
    )
    expect(state.writeGuard).toEqual([])
    expect(state.readGuard).toEqual([])
  })

  it('GIT-10: dir 在工作目录外 + mutates → 走 assertWriteApproved', async () => {
    const outside = makeRepo()
    nodeFs.writeFileSync(join(outside, 'a.txt'), 'hi\n')

    const tool = makeTool(async () => ({ kind: 'approval', approved: true }))
    const out = await tool.execute('r2', { action: 'add', dir: outside, paths: ['a.txt'] })

    expect(textOf(out)).not.toContain('Error')
    expect(state.writeGuard).toEqual([{ path: outside, displayPath: outside }])
    expect(state.readGuard).toEqual([])
  })

  it('GIT-10: dir 在工作目录外 + 只读 action → 走 assertReadApproved', async () => {
    const outside = makeRepo()

    const tool = makeTool(async () => ({ kind: 'approval', approved: true }))
    await tool.execute('r3', { action: 'status', dir: outside })

    expect(state.readGuard).toEqual([{ path: outside, displayPath: outside }])
    expect(state.writeGuard).toEqual([])
  })
})

describe('git 审批文案', () => {
  it('GIT-11: tool.gitApproval 的三个原因码在 en/zh/ja 三语齐全', () => {
    const locales: Record<string, { tool?: { gitApproval?: Record<string, string> } }> = {
      en,
      zh,
      ja
    }
    for (const [lang, dict] of Object.entries(locales)) {
      const keys = Object.keys(dict.tool?.gitApproval ?? {}).sort()
      expect({ lang, keys }).toEqual({
        lang,
        keys: ['createRepo', 'deleteBranch', 'discardChanges']
      })
    }
  })
})
