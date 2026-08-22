/**
 * 桌面 git 工具的询问接线集成测试 —— 经 registerBuiltinTool 捕获的 factory 拿到真实工具，
 * 真实临时仓库 + mock 掉 toolContext/sessionDao/i18n。
 *
 * 覆盖 makeDesktopAskOp 的五条响应分支、makeDesktopResolveDir 的「工作目录内豁免」，
 * 以及三语询问文案键的齐全性。
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
  settings: undefined as { autoAllow?: boolean } | undefined,
  registration: undefined as unknown,
  readGuard: [] as { path: string; displayPath?: string }[],
  writeGuard: [] as { path: string; displayPath?: string }[],
  /** 桌面 wiring 透传给 enforceGitOp 的客体属性（GIT-12 断言用） */
  gitOps: [] as { gitAction: string; command: string; force: boolean; delete: boolean }[]
}))

vi.mock('../../services/toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  return {
    TOOL_ABORTED: 'Aborted',
    resolveProjectConfig: () => ({ workingDirectory: state.workingDirectory }),
    isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
      const r = resolve(absolutePath)
      const base = resolve(workingDirectory)
      return r === base || r.startsWith(base + sep)
    },
    // 真实评估链（内置 git-safety 策略 + consent 层）；grants/挂起通道来自测试状态。
    // enforceGitOp 额外记录客体属性入参（GIT-12 透传断言），再交给真实实现。
    getDesktopSecurityContext: (ctx: {
      sessionId: string
      requestUserInput?: (req: InputRequest) => Promise<InputResponse>
    }) => {
      const real = createSecurityContext(
        { kind: 'agent', sessionId: ctx.sessionId, agentKind: 'root' },
        { host: 'desktop' },
        {
          host: 'desktop',
          pathSep: sep,
          getVars: () => ({
            workspace: state.workingDirectory,
            toolResultsBase: join(tmpdir(), '.nonexistent-tool-results'),
            skillsDirs: [],
            home: join(tmpdir(), '.nonexistent-home'),
            systemDirs: []
          }),
          getSessionGrants: () => ({
            autoAllow: !!state.settings?.autoAllow,
            allowList: []
          }),
          requestUserInput: ctx.requestUserInput
        }
      )
      return {
        ...real,
        enforceGitOp: (
          object: { gitAction: string; command: string; force: boolean; delete: boolean },
          opts: Parameters<typeof real.enforceGitOp>[1]
        ) => {
          state.gitOps.push({ ...object })
          return real.enforceGitOp(object, opts)
        }
      }
    },
    assertReadAllowed: (
      _ctx: unknown,
      _config: unknown,
      _id: string,
      _tool: string,
      path: string,
      displayPath?: string
    ) => void state.readGuard.push({ path, displayPath }),
    assertWriteAllowed: (
      _ctx: unknown,
      _config: unknown,
      _id: string,
      _tool: string,
      path: string,
      displayPath?: string
    ) => void state.writeGuard.push({ path, displayPath })
  }
})
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

/** 用捕获到的注册项装出一个真实 git 工具（走桌面 resolveDir / askOp） */
function makeTool(requestUserInput?: (req: InputRequest) => Promise<InputResponse>): CapturedTool {
  const reg = state.registration as Registration
  return reg.factory({ sessionId: 'git-session', requestUserInput })
}

beforeEach(() => {
  state.workingDirectory = makeDir()
  state.settings = undefined
  state.readGuard = []
  state.writeGuard = []
  state.gitOps = []
})

afterEach(() => {
  for (const d of dirs.splice(0)) nodeFs.rmSync(d, { recursive: true, force: true })
})

describe('桌面 makeDesktopAskOp', () => {
  it('GIT-9: 弹询问时带上 reason 对应的本地化描述与命令行', async () => {
    const requests: InputRequest[] = []
    const tool = makeTool(async (req) => {
      requests.push(req)
      return { kind: 'ask', allowed: true }
    })

    await tool.execute('a1', { action: 'init' })

    expect(requests).toHaveLength(1)
    const req = requests[0]
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    expect(req.id).toBe('a1')
    expect(req.toolName).toBe('git')
    expect(req.command).toBe('git init')
    expect(req.description).toBe('tool.gitAsk.createRepo')
    expect(existsSync(join(state.workingDirectory, '.git'))).toBe(true)
  })

  it('GIT-9: 会话免询问 → 零弹窗直接执行', async () => {
    state.settings = { autoAllow: true }
    const requestUserInput = vi.fn(
      async (): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
    )
    const tool = makeTool(requestUserInput)

    await tool.execute('a2', { action: 'init' })

    expect(requestUserInput).not.toHaveBeenCalled()
    expect(existsSync(join(state.workingDirectory, '.git'))).toBe(true)
  })

  it('GIT-9: 无 requestUserInput 通道 → fail-closed 拒绝（与文件写入链一致；桌面正常运行时恒有通道）', async () => {
    const tool = makeTool(undefined)

    await expect(tool.execute('a3', { action: 'init' })).rejects.toThrow(/no way to ask/)
    expect(existsSync(join(state.workingDirectory, '.git'))).toBe(false)
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

  it('GIT-9: allowed:false → 抛 User denied git ...（带 reason 时抛 reason）', async () => {
    const denied = makeTool(async () => ({ kind: 'ask', allowed: false }))
    await expect(denied.execute('a6', { action: 'init' })).rejects.toThrow('User denied git init')
    expect(existsSync(join(state.workingDirectory, '.git'))).toBe(false)

    const withReason = makeTool(async () => ({
      kind: 'ask',
      allowed: false,
      reason: '这个目录不要建仓库'
    }))
    await expect(withReason.execute('a7', { action: 'init' })).rejects.toThrow('这个目录不要建仓库')
  })
})

describe('桌面 enforceGitOp 透传', () => {
  it('GIT-12: gitAction/command/force/delete 逐字段透传，force/delete 驱动 git-safety 的弹窗差异', async () => {
    // 工作目录本身建成有一次提交的仓库
    const wd = state.workingDirectory
    execSync('git init -b main', { cwd: wd, stdio: 'ignore' })
    nodeFs.writeFileSync(join(wd, 'a.txt'), 'first\n')
    execSync(
      'git -c user.name=Tester -c user.email=t@example.com -c commit.gpgsign=false add a.txt',
      { cwd: wd, stdio: 'ignore' }
    )
    execSync(
      'git -c user.name=Tester -c user.email=t@example.com -c commit.gpgsign=false commit -m init',
      { cwd: wd, stdio: 'ignore' }
    )

    const requests: InputRequest[] = []
    const tool = makeTool(async (req) => {
      requests.push(req)
      return { kind: 'ask', allowed: true }
    })

    await tool.execute('p1', { action: 'checkout', ref: 'main' })
    await tool.execute('p2', { action: 'checkout', ref: 'main', force: true })
    await tool.execute('p3', { action: 'branch', name: 'feat' }) // 建并切换
    await tool.execute('p4', { action: 'checkout', ref: 'main' })
    await tool.execute('p5', { action: 'branch', name: 'feat', delete: true })

    // 客体属性逐字段透传（gitAction / command / force / delete）
    expect(state.gitOps).toEqual([
      { gitAction: 'checkout', command: 'git checkout main', force: false, delete: false },
      { gitAction: 'checkout', command: 'git checkout --force main', force: true, delete: false },
      { gitAction: 'branch', command: 'git branch', force: false, delete: false },
      { gitAction: 'checkout', command: 'git checkout main', force: false, delete: false },
      { gitAction: 'branch', command: 'git branch -d feat', force: false, delete: true }
    ])
    // 弹窗只来自破坏性组合 —— git-safety 依据透传的 force/delete 判定
    expect(requests.map((r) => (r.kind === 'ask' ? r.command : r.kind))).toEqual([
      'git checkout --force main',
      'git branch -d feat'
    ])
  })
})

describe('桌面 makeDesktopResolveDir', () => {
  it('GIT-10: dir 在工作目录内 + mutates → 不触发路径询问', async () => {
    const repo = join(state.workingDirectory, 'sub')
    nodeFs.mkdirSync(repo, { recursive: true })
    execSync('git init -b main', { cwd: repo, stdio: 'ignore' })
    nodeFs.writeFileSync(join(repo, 'a.txt'), 'hi\n')

    const tool = makeTool(async () => ({ kind: 'ask', allowed: true }))
    const out = await tool.execute('r1', { action: 'add', dir: 'sub', paths: ['a.txt'] })

    expect(textOf(out)).not.toContain('Error')
    // 相对 dir 归一到工作目录内的仓库，且暂存真的发生了
    expect(execSync('git diff --cached --name-only', { cwd: repo, encoding: 'utf8' })).toContain(
      'a.txt'
    )
    expect(state.writeGuard).toEqual([])
    expect(state.readGuard).toEqual([])
  })

  it('GIT-10: dir 在工作目录外 + mutates → 走 assertWriteAllowed', async () => {
    const outside = makeRepo()
    nodeFs.writeFileSync(join(outside, 'a.txt'), 'hi\n')

    const tool = makeTool(async () => ({ kind: 'ask', allowed: true }))
    const out = await tool.execute('r2', { action: 'add', dir: outside, paths: ['a.txt'] })

    expect(textOf(out)).not.toContain('Error')
    expect(state.writeGuard).toEqual([{ path: outside, displayPath: outside }])
    expect(state.readGuard).toEqual([])
  })

  it('GIT-10: dir 在工作目录外 + 只读 action → 走 assertReadAllowed', async () => {
    const outside = makeRepo()

    const tool = makeTool(async () => ({ kind: 'ask', allowed: true }))
    await tool.execute('r3', { action: 'status', dir: outside })

    expect(state.readGuard).toEqual([{ path: outside, displayPath: outside }])
    expect(state.writeGuard).toEqual([])
  })
})

describe('git 询问文案', () => {
  it('GIT-11: tool.gitAsk 的三个原因码在 en/zh/ja 三语齐全', () => {
    const locales: Record<string, { tool?: { gitAsk?: Record<string, string> } }> = {
      en,
      zh,
      ja
    }
    for (const [lang, dict] of Object.entries(locales)) {
      const keys = Object.keys(dict.tool?.gitAsk ?? {}).sort()
      expect({ lang, keys }).toEqual({
        lang,
        keys: ['createRepo', 'deleteBranch', 'discardChanges']
      })
    }
  })
})
