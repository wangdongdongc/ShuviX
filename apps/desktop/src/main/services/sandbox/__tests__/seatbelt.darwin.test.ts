/**
 * 命令沙箱 —— 真 Seatbelt（[darwin]）：RS-1..RS-9（RS-7 含 FU-19，RS-8 含 FU-10..FU-12）。
 *
 * 规格由 buildSandboxSpec 从一套**假家目录**算出（fakeHome 建在 realpath(os.tmpdir()) 下，即
 * /private/var/folders/…，不在任何可写根里），命令经 createSeatbeltBackend().wrap 包进真正的
 * /usr/bin/sandbox-exec 执行。真 HOME、真 ~/.shuvix、真 userData、真 /private/tmp/shuvix-<uid>
 * 一概不碰：uid 用哨兵 99999（/private/tmp/shuvix-ssh-99999、tmux-99999 由本文件自建自删），
 * 每会话临时目录的父目录是本文件独占的 /private/tmp/shuvix-sbxtest-<rand>。
 *
 * 能当对照的地方先不套沙箱跑一遍同一件事（control），这样红了只能是沙箱的问题，不是夹具的。
 *
 * 跳过条件：不是 macOS，或真探测不过（本套件自己跑在别的沙箱里时嵌套 sandbox-exec 以 71 退出 ——
 * 那是正常结局）。探测用的宿主路径指向真家目录，但那只是数据：探测只跑 /usr/bin/true。
 * 探测的工作区是 realpath(tmpdir())，家目录若落在它里面探测会被拒（见 SB-3），所以不能拿 fakeHome 探。
 *
 * `open` / `osascript` 两条只在 SHUVIX_SBX_UI=1 时跑：一旦回归，它们会真的拉起应用或弹 TCC 授权框。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'fs'
import { createServer, type Server } from 'net'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'

// spec.ts → utils/paths 会导入 electron；这里一条都用不到，桩掉免得真去加载 electron 包
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('electron app is not available in this test')
    },
    isPackaged: false
  }
}))

import { buildSandboxSpec } from '../spec'
import { createSeatbeltBackend, SANDBOX_EXEC } from '../backends/seatbelt'
import { explainSandboxDenial } from '../classify'
import { ROOT_PROTECTED_NAMES } from '../tables'
import type { SandboxHostPaths, SandboxSessionInput, SandboxSpec } from '../types'

const SENTINEL_UID = 99999
const RAND = randomBytes(4).toString('hex')
/** 每会话临时目录的父目录：短、独占、测完整个删掉 */
const TMP_ROOT = `/private/tmp/shuvix-sbxtest-${RAND}`
const SID = `sbxtest-${RAND}`
const OTHER_SID = `sbxother-${RAND}`
const LAUNCHD_LABEL = `com.shuvix.sbxtest.${RAND}`
const LAUNCHD_DIR = `/private/tmp/com.apple.launchd.sbxtest-${RAND}`
const SSH_CTL_DIR = `/private/tmp/shuvix-ssh-${SENTINEL_UID}`
const TMUX_DIR = `/private/tmp/tmux-${SENTINEL_UID}`
const SYS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const UI = process.env.SHUVIX_SBX_UI === '1'

const backend = createSeatbeltBackend()

/** 真探测：只跑 /usr/bin/true；宿主路径是纯数据（见文件头） */
function probeHere(): boolean {
  if (process.platform !== 'darwin') return false
  const home = homedir()
  return backend.probe({
    home,
    userData: join(home, 'Library', 'Application Support', 'ShuviX'),
    shuvixHome: join(home, '.shuvix'),
    uid: SENTINEL_UID,
    cliSocket: join(home, '.shuvix', 'cli.sock'),
    tmpRoot: TMP_ROOT
  }).available
}

const SANDBOX_OK = probeHere()

// ─── 夹具 ─────────────────────────────────────────────

let fakeHome = ''
let userData = ''
let shuvixHome = ''
let ws = ''
let paths: SandboxHostPaths

/** 与管理器同义的 realpath：不存在的部分按最近的已存在祖先拼回 */
function realLoose(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync.native(abs)
  } catch {
    const parent = dirname(abs)
    if (parent === abs) return abs
    return join(realLoose(parent), basename(abs))
  }
}

function put(path: string, content = 'seed\n'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function specOf(over: Partial<SandboxSessionInput> = {}): SandboxSpec {
  const built = buildSandboxSpec(
    paths,
    { sessionId: SID, workingDirectory: ws, grantedWrite: [], grantedRead: [], ...over },
    realLoose
  )
  if (!built.ok) throw new Error(`fixture spec rejected: ${built.reason}`)
  mkdirSync(built.spec.tmpDir, { recursive: true, mode: 0o700 })
  return built.spec
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  /** stdout + stderr（判断拒绝时两边都看） */
  out: string
}

function envFor(spec: SandboxSpec, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: SYS_PATH,
    HOME: fakeHome,
    TMPDIR: spec.tmpDir + '/',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Sbx Test',
    GIT_AUTHOR_EMAIL: 'sbx@test.invalid',
    GIT_COMMITTER_NAME: 'Sbx Test',
    GIT_COMMITTER_EMAIL: 'sbx@test.invalid',
    ...extra
  }
}

function toResult(r: ReturnType<typeof spawnSync>): RunResult {
  const stdout = String(r.stdout ?? '')
  const stderr = String(r.stderr ?? '')
  return { status: r.status, stdout, stderr, out: stdout + stderr }
}

/** 套沙箱跑一条 bash 命令（同步：一个子用例一次 spawnSync） */
function confined(
  spec: SandboxSpec,
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string> } = {}
): RunResult {
  const w = backend.wrap(spec, { file: '/bin/bash', args: ['--norc', '-c', cmd] })
  return toResult(
    spawnSync(w.file, w.args, {
      cwd: opts.cwd ?? spec.workingDirectory,
      env: envFor(spec, opts.env),
      encoding: 'utf8',
      timeout: 20_000
    })
  )
}

/** 同一条命令不套沙箱（对照） */
function unconfined(spec: SandboxSpec, cmd: string, cwd = spec.workingDirectory): RunResult {
  return toResult(
    spawnSync('/bin/bash', ['--norc', '-c', cmd], {
      cwd,
      env: envFor(spec),
      encoding: 'utf8',
      timeout: 20_000
    })
  )
}

/** 异步版本：测试进程自己要在命令跑的同时服务 unix socket，同步 spawn 会把事件循环卡死 */
function confinedAsync(spec: SandboxSpec, cmd: string): Promise<RunResult> {
  const w = backend.wrap(spec, { file: '/bin/bash', args: ['--norc', '-c', cmd] })
  return new Promise((done) => {
    const child = spawn(w.file, w.args, { cwd: spec.workingDirectory, env: envFor(spec) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      done({ status, stdout, stderr, out: stdout + stderr })
    })
  })
}

/** 单引号包一层给 bash（路径里有空格：Application Support） */
function q(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/** 说明里列出来的条目（`  - ` 开头的行）—— 与 classify.test.ts 同一个读法 */
function noteEntries(note: string | null): string[] {
  return (note ?? '')
    .split('\n')
    .filter((l) => l.startsWith('  - '))
    .map((l) => l.slice(4))
}

/** 对照：拒写的目标所在目录对当前用户本来是可写的 —— 拒绝只能来自沙箱 */
function expectParentWritable(target: string): void {
  expect(() => accessSync(dirname(target), fsConstants.W_OK)).not.toThrow()
}

/** 写入被拒：非零退出、EPERM、文件不存在 */
function expectWriteDenied(spec: SandboxSpec, target: string): void {
  expectParentWritable(target)
  expect(existsSync(target)).toBe(false)
  const r = confined(spec, `echo x > ${q(target)}`)
  expect(r.status, r.out).not.toBe(0)
  expect(r.out).toMatch(/Operation not permitted/)
  expect(existsSync(target)).toBe(false)
}

/** 写入放行：退出 0、文件落盘 */
function expectWriteAllowed(spec: SandboxSpec, target: string, mkdir = false): void {
  const cmd = `${mkdir ? `mkdir -p ${q(dirname(target))} && ` : ''}echo ok > ${q(target)}`
  const r = confined(spec, cmd)
  expect(r.status, r.out).toBe(0)
  expect(readFileSync(target, 'utf8')).toBe('ok\n')
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

describe.skipIf(!SANDBOX_OK)('seatbelt (real sandbox-exec) [darwin]', () => {
  beforeAll(() => {
    fakeHome = mkdtempSync(join(realpathSync(tmpdir()), 'sbxh-'))
    userData = join(fakeHome, 'Library', 'Application Support', 'ShuviX')
    shuvixHome = join(fakeHome, '.shuvix')
    ws = join(fakeHome, 'proj')
    paths = {
      home: fakeHome,
      userData,
      shuvixHome,
      uid: SENTINEL_UID,
      cliSocket: join(shuvixHome, 'cli.sock'),
      tmpRoot: TMP_ROOT
    }
    mkdirSync(TMP_ROOT, { recursive: true, mode: 0o700 })
    mkdirSync(ws, { recursive: true })
    mkdirSync(userData, { recursive: true })
    mkdirSync(shuvixHome, { recursive: true })
    mkdirSync(SSH_CTL_DIR, { recursive: true, mode: 0o700 })
    mkdirSync(TMUX_DIR, { recursive: true, mode: 0o700 })
  })

  afterAll(() => {
    for (const dir of [fakeHome, TMP_ROOT, SSH_CTL_DIR, TMUX_DIR, LAUNCHD_DIR]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  // ─── RS-1 ─────────────────────────────────────────

  describe('RS-1 writes allowed', () => {
    it('RS-1 a file in the working directory', () => {
      const spec = specOf()
      const r = confined(spec, 'echo ok > a')
      expect(r.status, r.out).toBe(0)
      expect(readFileSync(join(ws, 'a'), 'utf8')).toBe('ok\n')
    })

    it('RS-1 $TMPDIR is the session tmp dir and is writable', () => {
      const spec = specOf()
      const r = confined(spec, 'printf %s "$TMPDIR"; echo ok > "$TMPDIR/a"')
      expect(r.status, r.out).toBe(0)
      expect(r.stdout).toBe(spec.tmpDir + '/')
      expect(readFileSync(join(spec.tmpDir, 'a'), 'utf8')).toBe('ok\n')
    })

    it('RS-1 /private/tmp/… and /tmp/…', () => {
      const spec = specOf()
      expectWriteAllowed(spec, join(TMP_ROOT, 'free', 'pt-a'), true)
      const viaTmp = `/tmp/shuvix-sbxtest-${RAND}/t-a`
      const r = confined(spec, `echo ok > ${viaTmp}`)
      expect(r.status, r.out).toBe(0)
      expect(readFileSync(join(TMP_ROOT, 't-a'), 'utf8')).toBe('ok\n')
    })

    it('RS-1 package-manager caches under the home folder', () => {
      const spec = specOf()
      // ~/.npm 本身也可以由命令新建（subpath 含根自身）；pip 的父目录 ~/Library/Caches 不在清单里，预先建好
      expectWriteAllowed(spec, join(fakeHome, '.npm', 'x'), true)
      mkdirSync(join(fakeHome, 'Library', 'Caches'), { recursive: true })
      expectWriteAllowed(spec, join(fakeHome, 'Library', 'Caches', 'pip', 'x'), true)
    })

    it("RS-1 the session's own artifacts dir", () => {
      const spec = specOf()
      mkdirSync(join(shuvixHome, 'artifacts'), { recursive: true })
      expectWriteAllowed(spec, join(shuvixHome, 'artifacts', SID, 'x'), true)
    })

    it('RS-1 a write-grant root outside the working directory (and not without the grant)', () => {
      const grant = join(fakeHome, 'outside-grant')
      mkdirSync(grant, { recursive: true })
      expectWriteDenied(specOf(), join(grant, 'before'))
      expectWriteAllowed(specOf({ grantedWrite: [grant] }), join(grant, 'x'))
    })

    it('RS-1 temp-workspace session: writes in its workspace succeed', () => {
      const tempWs = join(userData, 'temp_workspace', SID)
      mkdirSync(tempWs, { recursive: true })
      const spec = specOf({ workingDirectory: tempWs })
      const r = confined(spec, 'echo ok > a && mkdir -p d && echo ok > d/b')
      expect(r.status, r.out).toBe(0)
      expect(readFileSync(join(tempWs, 'd', 'b'), 'utf8')).toBe('ok\n')
    })

    it('RS-1 a grant on ~/.shuvix/widgets/w is writable (and not without it)', () => {
      const widget = join(shuvixHome, 'widgets', 'w')
      mkdirSync(widget, { recursive: true })
      expectWriteDenied(specOf(), join(widget, 'before'))
      expectWriteAllowed(specOf({ grantedWrite: [widget] }), join(widget, 'x'))
    })
  })

  // ─── RS-2 ─────────────────────────────────────────

  describe('RS-2 writes denied', () => {
    it('RS-2 a file directly in the home folder', () => {
      expectWriteDenied(specOf(), join(fakeHome, 'other.txt'))
    })

    it("RS-2 ShuviX's own configuration (~/.shuvix/agents)", () => {
      mkdirSync(join(shuvixHome, 'agents'), { recursive: true })
      expectWriteDenied(specOf(), join(shuvixHome, 'agents', 'x.md'))
    })

    it("RS-2 another session's artifacts dir", () => {
      mkdirSync(join(shuvixHome, 'artifacts', OTHER_SID), { recursive: true })
      expectWriteDenied(specOf(), join(shuvixHome, 'artifacts', OTHER_SID, 'x'))
    })

    it('RS-2 userData, also from a temp-workspace session', () => {
      const tempWs = join(userData, 'temp_workspace', SID)
      mkdirSync(tempWs, { recursive: true })
      expectWriteDenied(specOf(), join(userData, 'x'))
      expectWriteDenied(specOf({ workingDirectory: tempWs }), join(userData, 'x'))
      // 别的会话的临时工作区也不行
      const otherWs = join(userData, 'temp_workspace', OTHER_SID)
      mkdirSync(otherWs, { recursive: true })
      expectWriteDenied(specOf({ workingDirectory: tempWs }), join(otherWs, 'x'))
    })

    it('RS-2 ~/.ssh even with a write grant equal to ~/.ssh', () => {
      const ssh = join(fakeHome, '.ssh')
      mkdirSync(ssh, { recursive: true })
      expectWriteDenied(specOf({ grantedWrite: [ssh] }), join(ssh, 'x'))
    })

    it('RS-2 grants equal to executed-later entries are accepted, but writes inside stay denied', () => {
      const gitCfg = join(fakeHome, '.config', 'git')
      const fish = join(fakeHome, '.config', 'fish')
      const agents = join(fakeHome, 'Library', 'LaunchAgents')
      for (const d of [gitCfg, fish, agents]) mkdirSync(d, { recursive: true })
      const spec = specOf({ grantedWrite: [gitCfg, fish, agents] })
      expectWriteDenied(spec, join(gitCfg, 'config'))
      expectWriteDenied(spec, join(fish, 'config.fish'))
      expectWriteDenied(spec, join(agents, 'x.plist'))
    })

    it('RS-2 a write grant that strictly contains a protected dir is not sandboxed at all', () => {
      for (const grant of [join(fakeHome, '.config'), join(fakeHome, 'Library')]) {
        const built = buildSandboxSpec(
          paths,
          { sessionId: SID, workingDirectory: ws, grantedWrite: [grant], grantedRead: [] },
          realLoose
        )
        expect(built.ok, grant).toBe(false)
        if (!built.ok) expect(built.reason).toMatch(/^a write grant contains /)
      }
    })

    it('RS-2 a grant that is the file ~/.zshrc', () => {
      const zshrc = join(fakeHome, '.zshrc')
      expectWriteDenied(specOf({ grantedWrite: [zshrc] }), zshrc)
    })

    it('RS-2 a grant on ~/.shuvix/policies is not re-allowed for commands', () => {
      const policies = join(shuvixHome, 'policies')
      mkdirSync(policies, { recursive: true })
      expectWriteDenied(specOf({ grantedWrite: [policies] }), join(policies, 'x.md'))
    })

    it('RS-2 the ssh control-socket and tmux dirs of this uid under /private/tmp', () => {
      const spec = specOf()
      expectWriteDenied(spec, join(SSH_CTL_DIR, 'x'))
      expectWriteDenied(spec, join(TMUX_DIR, 'x'))
    })

    it('RS-2 creating a launchd socket dir under /private/tmp', () => {
      const spec = specOf()
      expect(existsSync(LAUNCHD_DIR)).toBe(false)
      const r = confined(spec, `mkdir ${LAUNCHD_DIR}`)
      expect(r.status, r.out).not.toBe(0)
      expect(r.out).toMatch(/Operation not permitted/)
      expect(existsSync(LAUNCHD_DIR)).toBe(false)
    })
  })

  // ─── RS-3 ─────────────────────────────────────────

  describe('RS-3 root-protected names', () => {
    const FILE_NAMES = new Set(['.mcp.json', '.envrc'])
    /** 目录类的在根下预先建好（不套沙箱），测的是往里写文件 */
    function targetUnder(root: string, name: string): string {
      if (FILE_NAMES.has(name)) return join(root, name)
      mkdirSync(join(root, name), { recursive: true })
      return join(root, name, name === '.claude' ? 'settings.json' : 'x')
    }

    it.each(ROOT_PROTECTED_NAMES.map((n) => [n]))('RS-3 ws/%s is refused', (name) => {
      expectWriteDenied(specOf(), targetUnder(ws, name))
    })

    it.each(ROOT_PROTECTED_NAMES.map((n) => [n]))(
      'RS-3 <write-grant root>/%s is refused',
      (name) => {
        const grant = join(fakeHome, 'grant-root')
        mkdirSync(grant, { recursive: true })
        expectWriteDenied(specOf({ grantedWrite: [grant] }), targetUnder(grant, name))
      }
    )

    it('RS-3 the protected entry itself cannot be created at a root', () => {
      const grant = join(fakeHome, 'grant-fresh')
      mkdirSync(grant, { recursive: true })
      const r = confined(specOf({ grantedWrite: [grant] }), `mkdir ${q(join(grant, '.vscode'))}`)
      expect(r.status, r.out).not.toBe(0)
      expect(existsSync(join(grant, '.vscode'))).toBe(false)
    })

    it('RS-3 the same names deeper in the tree are allowed', () => {
      const spec = specOf()
      expectWriteAllowed(spec, join(ws, 'sub', '.vscode', 'x'), true)
      expectWriteAllowed(spec, join(ws, 'sub', '.mcp.json'), true)
    })
  })

  // ─── RS-4 ─────────────────────────────────────────

  describe('RS-4 git metadata', () => {
    let gitWs = ''
    const GIT = '/usr/bin/git'

    function seedGit(args: string[], cwd: string): string {
      return execFileSync(GIT, ['-c', 'init.defaultBranch=main', ...args], {
        cwd,
        env: envFor(specOf({ workingDirectory: gitWs })),
        encoding: 'utf8'
      })
    }

    beforeAll(() => {
      gitWs = join(fakeHome, 'gitws')
      mkdirSync(gitWs, { recursive: true })
      seedGit(['init', '-q'], gitWs)
      put(join(gitWs, 'f0'), 'zero\n')
      seedGit(['add', 'f0'], gitWs)
      seedGit(['commit', '-qm', 'init'], gitWs)
      // 子模块与 worktree 自己的那一份元数据
      put(join(gitWs, '.git', 'modules', 'm', 'config'), '[core]\n')
      put(join(gitWs, '.git', 'worktrees', 'w', 'config.worktree'), '[core]\n')
      // 一个空的 `.git` 目录项（测删除这一项本身）、一个事先写好的目录（测改名成 .git）
      mkdirSync(join(gitWs, 'r2', '.git'), { recursive: true })
      put(join(gitWs, 'prepared', 'config'), '[core]\n\tfsmonitor = /tmp/evil\n')
      mkdirSync(join(gitWs, 'nested'), { recursive: true })
    })

    const gitSpec = (): SandboxSpec => specOf({ workingDirectory: gitWs })

    it('RS-4 git add + commit succeeds and the commit is visible unconfined', () => {
      const r = confined(gitSpec(), 'echo f > f && git add f && git commit -qm x')
      expect(r.status, r.out).toBe(0)
      expect(seedGit(['log', '-1', '--format=%s'], gitWs).trim()).toBe('x')
      expect(seedGit(['rev-list', '--count', 'HEAD'], gitWs).trim()).toBe('2')
    })

    it('RS-4 git config fails and .git/config is unchanged', () => {
      const cfg = join(gitWs, '.git', 'config')
      const before = readFileSync(cfg)
      const r = confined(gitSpec(), 'git config user.name x')
      expect(r.status, r.out).not.toBe(0)
      expect(r.out).toMatch(/Operation not permitted/)
      expect(readFileSync(cfg).equals(before)).toBe(true)
    })

    it.each([
      ['.git/hooks/pre-commit'],
      ['.GIT/HOOKS/x'],
      ['.git/config.worktree'],
      ['.git/commondir']
    ])('RS-4 creating %s is refused', (rel) => {
      const target = join(gitWs, rel)
      // APFS 不区分大小写：.GIT/HOOKS/x 就是 .git/hooks/x
      const canonical = join(gitWs, rel.toLowerCase())
      expectParentWritable(canonical)
      expect(existsSync(canonical)).toBe(false)
      const r = confined(gitSpec(), `echo x > ${q(target)}`)
      expect(r.status, r.out).not.toBe(0)
      expect(r.out).toMatch(/Operation not permitted/)
      expect(existsSync(canonical)).toBe(false)
    })

    it.each([['.git/modules/m/config'], ['.git/worktrees/w/config.worktree']])(
      'RS-4 appending to %s is refused',
      (rel) => {
        const target = join(gitWs, rel)
        const before = readFileSync(target)
        const r = confined(gitSpec(), `echo x >> ${q(target)}`)
        expect(r.status, r.out).not.toBe(0)
        expect(r.out).toMatch(/Operation not permitted/)
        expect(readFileSync(target).equals(before)).toBe(true)
      }
    )

    it('RS-4 .git/info/exclude is writable', () => {
      const r = confined(gitSpec(), 'echo "*.log" >> .git/info/exclude')
      expect(r.status, r.out).toBe(0)
      expect(readFileSync(join(gitWs, '.git', 'info', 'exclude'), 'utf8')).toContain('*.log')
    })

    it('RS-4 the .git entry cannot be renamed, removed or created by rename', () => {
      const spec = gitSpec()
      const mv = confined(spec, 'mv .git .git2')
      expect(mv.status, mv.out).not.toBe(0)
      expect(existsSync(join(gitWs, '.git', 'HEAD'))).toBe(true)
      expect(existsSync(join(gitWs, '.git2'))).toBe(false)

      const rm = confined(spec, 'rmdir r2/.git')
      expect(rm.status, rm.out).not.toBe(0)
      expect(existsSync(join(gitWs, 'r2', '.git'))).toBe(true)

      const mvIn = confined(spec, 'mv prepared nested/.git')
      expect(mvIn.status, mvIn.out).not.toBe(0)
      expect(existsSync(join(gitWs, 'nested', '.git'))).toBe(false)
      expect(existsSync(join(gitWs, 'prepared', 'config'))).toBe(true)
    })

    it('RS-4 git init in a workspace without a repo, and git init sub, fail', () => {
      const emptyWs = join(fakeHome, 'gitws-empty')
      mkdirSync(emptyWs, { recursive: true })
      const r = confined(specOf({ workingDirectory: emptyWs }), 'git init -q')
      expect(r.status, r.out).not.toBe(0)
      expect(existsSync(join(emptyWs, '.git'))).toBe(false)

      const sub = confined(gitSpec(), 'git init -q sub')
      expect(sub.status, sub.out).not.toBe(0)
      expect(existsSync(join(gitWs, 'sub', '.git'))).toBe(false)
    })

    it('RS-4 git init + commit under /private/tmp and a clone into $TMPDIR succeed', () => {
      const spec = gitSpec()
      const repo = join(TMP_ROOT, 'g')
      const init = confined(
        spec,
        `mkdir -p ${repo} && cd ${repo} && git init -q && echo a > a && git add a && git commit -qm y`
      )
      expect(init.status, init.out).toBe(0)
      expect(existsSync(join(repo, '.git', 'config'))).toBe(true)

      const clone = confined(spec, `git clone -q ${q(gitWs)} "$TMPDIR/c"`)
      expect(clone.status, clone.out).toBe(0)
      expect(readFileSync(join(spec.tmpDir, 'c', 'f0'), 'utf8')).toBe('zero\n')
      expect(existsSync(join(spec.tmpDir, 'c', '.git', 'config'))).toBe(true)
    })
  })

  // ─── RS-5 ─────────────────────────────────────────

  describe('RS-5 reads', () => {
    let docs = ''
    beforeAll(() => {
      docs = join(fakeHome, 'Documents')
      put(join(docs, 'secret.txt'), 'secret\n')
      put(join(docs, 'proj', 'p.txt'), 'proj\n')
      put(join(docs, 'rg', 'r.txt'), 'read-grant\n')
      put(join(docs, 'wg', 'w.txt'), 'write-grant\n')
      put(join(fakeHome, '.ssh', 'id_test'), 'key\n')
      put(join(shuvixHome, '.session-state', 'k'), 'state\n')
      put(join(shuvixHome, 'cli-token'), 'token\n')
      put(join(userData, 'data', 'db'), 'db\n')
      put(join(userData, 'x'), 'userdata\n')
      put(join(userData, 'tool_results', SID, 'r.txt'), 'mine\n')
      put(join(userData, 'tool_results', OTHER_SID, 'r.txt'), 'theirs\n')
    })

    /** 读被拒；对照：不套沙箱时同一条命令成功 */
    function expectReadDenied(spec: SandboxSpec, cmd: string): void {
      const control = unconfined(spec, cmd)
      expect(control.status, control.out).toBe(0)
      const r = confined(spec, cmd)
      expect(r.status, r.out).not.toBe(0)
      expect(r.out).toMatch(/Operation not permitted/)
    }

    function expectReadAllowed(spec: SandboxSpec, cmd: string, expected?: string): void {
      const r = confined(spec, cmd)
      expect(r.status, r.out).toBe(0)
      if (expected !== undefined) expect(r.stdout).toBe(expected)
    }

    it('RS-5 system files are readable', () => {
      expectReadAllowed(specOf(), 'cat /etc/hosts > /dev/null')
    })

    it('RS-5 personal dirs: contents refused, metadata allowed', () => {
      const spec = specOf()
      const secret = join(docs, 'secret.txt')
      expectReadDenied(spec, `cat ${q(secret)}`)
      expectReadDenied(spec, `ls ${q(docs)}`)
      expectReadDenied(spec, `xattr -l ${q(secret)}`)
      expectReadAllowed(spec, `stat ${q(secret)} > /dev/null`)
    })

    it('RS-5 a workspace inside ~/Documents is readable and node / python start there', () => {
      const spec = specOf({ workingDirectory: join(docs, 'proj') })
      expectReadAllowed(spec, 'cat p.txt', 'proj\n')
      expectReadAllowed(
        spec,
        `${q(process.execPath)} -e "process.stdout.write(process.cwd())"`,
        join(docs, 'proj')
      )
      expectReadAllowed(spec, '/usr/bin/python3 -c pass')
      // 放回只到工作区为止
      expectReadDenied(spec, `cat ${q(join(docs, 'secret.txt'))}`)
    })

    it("RS-5 userData refused, the session's own tool_results readable, another's not", () => {
      const spec = specOf()
      expectReadDenied(spec, `cat ${q(join(userData, 'x'))}`)
      expectReadAllowed(spec, `cat ${q(join(userData, 'tool_results', SID, 'r.txt'))}`, 'mine\n')
      expectReadDenied(spec, `cat ${q(join(userData, 'tool_results', OTHER_SID, 'r.txt'))}`)
    })

    it('RS-5 credentials, session state and the database are refused even for stat', () => {
      const spec = specOf()
      const key = join(fakeHome, '.ssh', 'id_test')
      expectReadDenied(spec, `cat ${q(key)}`)
      expectReadDenied(spec, `stat ${q(key)} > /dev/null`)
      expectReadDenied(spec, `stat ${q(join(shuvixHome, '.session-state', 'k'))} > /dev/null`)
      expectReadDenied(spec, `stat ${q(join(userData, 'data', 'db'))} > /dev/null`)
    })

    it('RS-5 ~/.shuvix/cli-token stays readable (the shuvix CLI needs it)', () => {
      expectReadAllowed(specOf(), `cat ${q(join(shuvixHome, 'cli-token'))}`, 'token\n')
    })

    it('RS-5 a read grant and a write grant under ~/Documents are readable', () => {
      const spec = specOf({ grantedRead: [join(docs, 'rg')], grantedWrite: [join(docs, 'wg')] })
      expectReadAllowed(spec, `cat ${q(join(docs, 'rg', 'r.txt'))}`, 'read-grant\n')
      expectReadAllowed(spec, `cat ${q(join(docs, 'wg', 'w.txt'))}`, 'write-grant\n')
      expectReadDenied(spec, `cat ${q(join(docs, 'secret.txt'))}`)
    })
  })

  // ─── RS-6 ─────────────────────────────────────────

  describe('RS-6 network + unix sockets', () => {
    let probeScript = ''
    const servers: Server[] = []

    beforeAll(() => {
      // 放在家目录下一个普通目录里（不在个人资料清单里 → 沙箱里可读）
      probeScript = put(
        join(fakeHome, 'bin', 'netprobe.cjs'),
        [
          "const net = require('net')",
          'const [mode, arg] = process.argv.slice(2)',
          "const fail = (e) => { console.log('ERR ' + (e.code || e.message)); process.exit(3) }",
          "if (mode === 'tcp') {",
          "  const srv = net.createServer((s) => s.end('ok'))",
          "  srv.on('error', fail)",
          "  srv.listen(0, '127.0.0.1', () => {",
          "    const c = net.connect(srv.address().port, '127.0.0.1')",
          "    c.on('data', (d) => { console.log('GOT ' + d); process.exit(0) })",
          "    c.on('error', fail)",
          '  })',
          "} else if (mode === 'unix-serve') {",
          "  const srv = net.createServer((s) => s.end('ok'))",
          "  srv.on('error', fail)",
          '  srv.listen(arg, () => {',
          '    const c = net.connect(arg)',
          "    c.on('data', (d) => { console.log('GOT ' + d); process.exit(0) })",
          "    c.on('error', fail)",
          '  })',
          "} else if (mode === 'unix-connect') {",
          '  const c = net.connect(arg)',
          "  c.on('data', (d) => { console.log('GOT ' + String(d).trim()); process.exit(0) })",
          "  c.on('error', fail)",
          "} else if (mode === 'dns') {",
          "  require('dns').lookup(arg, (e, addr) => {",
          '    if (e) return fail(e)',
          "    const c = net.connect(80, addr, () => { console.log('CONNECTED ' + addr); c.destroy(); process.exit(0) })",
          "    c.on('error', fail)",
          '  })',
          '}',
          'setTimeout(() => { console.log("TIMEOUT"); process.exit(4) }, 10000)',
          ''
        ].join('\n')
      )
    })

    afterAll(async () => {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))))
    })

    const node = (args: string): string => `${q(process.execPath)} ${q(probeScript)} ${args}`

    /** 在测试进程里（不套沙箱）起一个 unix socket 服务 */
    async function serveUnconfined(path: string): Promise<void> {
      rmSync(path, { force: true })
      const srv = createServer((s) => s.end('pong\n'))
      servers.push(srv)
      await new Promise<void>((r, j) => srv.listen(path, () => r()).on('error', j))
    }

    it('RS-6 bind + connect on 127.0.0.1 inside one command', async () => {
      const r = await confinedAsync(specOf(), node('tcp'))
      expect(r.status, r.out).toBe(0)
      expect(r.stdout).toContain('GOT ok')
    })

    it('RS-6 a unix socket can be bound and used in $TMPDIR and in the working directory', async () => {
      const spec = specOf()
      const inTmp = join(spec.tmpDir, 's.sock')
      const inWs = join(ws, 's.sock')
      // AF_UNIX 路径上限 104 字节
      expect(inTmp.length).toBeLessThan(104)
      expect(inWs.length).toBeLessThan(104)
      const a = await confinedAsync(spec, node(`unix-serve ${q(inTmp)}`))
      expect(a.status, a.out).toBe(0)
      const b = await confinedAsync(spec, node(`unix-serve ${q(inWs)}`))
      expect(b.status, b.out).toBe(0)
    })

    it('RS-6 the CLI socket is reachable, any other host socket is not', async (ctx) => {
      const cli = paths.cliSocket
      const other = join(fakeHome, 'other.sock')
      if (cli.length >= 104 || other.length >= 104) ctx.skip()
      await serveUnconfined(cli)
      await serveUnconfined(other)
      const spec = specOf()
      const ok = await confinedAsync(spec, node(`unix-connect ${q(cli)}`))
      expect(ok.status, ok.out).toBe(0)
      expect(ok.stdout).toContain('GOT pong')
      const refused = await confinedAsync(spec, node(`unix-connect ${q(other)}`))
      expect(refused.status, refused.out).not.toBe(0)
      expect(refused.stdout).toContain('ERR EPERM')
    })

    it('RS-6 DNS + an outbound TCP connection work', async (ctx) => {
      const spec = specOf()
      // 对照：离线等情况下不套沙箱也连不上 → 跳过
      const control = await new Promise<number | null>((done) => {
        const c = spawn(process.execPath, [probeScript, 'dns', 'example.com'], {
          env: envFor(spec)
        })
        c.on('close', done)
      })
      if (control !== 0) ctx.skip()
      const r = await confinedAsync(spec, node('dns example.com'))
      expect(r.status, r.out).toBe(0)
      expect(r.stdout).toContain('CONNECTED')
    }, 30_000)
  })

  // ─── RS-7 ─────────────────────────────────────────

  describe('RS-7 out-of-sandbox execution', () => {
    afterEach(() => {
      // 安全网：万一回归真的提交了 launchd 作业，不套沙箱把它撤掉
      spawnSync('/bin/launchctl', ['remove', LAUNCHD_LABEL], { encoding: 'utf8' })
    })

    it('RS-7 launchctl submit is refused', () => {
      const spec = specOf()
      const r = confined(spec, `launchctl submit -l ${LAUNCHD_LABEL} -- /usr/bin/true`)
      expect(r.status, r.out).not.toBe(0)
      const listed = spawnSync('/bin/launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf8' })
      expect(listed.status).not.toBe(0)
    })

    it('RS-7 a nested sandbox-exec is refused', () => {
      const r = confined(specOf(), `${SANDBOX_EXEC} -p '(version 1)(allow default)' /usr/bin/true`)
      expect(r.status, r.out).not.toBe(0)
      expect(r.out).toMatch(/sandbox_apply|not permitted/)
    })

    it('RS-7 sudo fails with the setuid signature the classifier knows, not a password prompt', () => {
      const spec = specOf()
      const r = confined(spec, 'sudo -n true')
      expect(r.status, r.out).not.toBe(0)
      expect(r.out).not.toMatch(/a password is required/)
      const note = explainSandboxDenial({
        spec,
        outputTail: r.out,
        exitCode: r.status,
        offerEscalation: true
      })
      expect(note).toContain('running sudo or another setuid program')
    })

    it.skipIf(!UI)('RS-7 open cannot reach LaunchServices (-10827) [SHUVIX_SBX_UI=1]', () => {
      const spec = specOf()
      const r = confined(spec, 'open -g /System/Library/CoreServices/Finder.app')
      expect(r.status, r.out).not.toBe(0)
      expect(r.out).toContain('-10827')
      // FU-19：真的输出能被签名认出来 —— 恰好一条「启动应用」的原因
      const note = explainSandboxDenial({
        spec,
        outputTail: r.out,
        exitCode: r.status,
        offerEscalation: true
      })
      expect(note, r.out).not.toBeNull()
      expect(noteEntries(note)).toEqual([expect.stringContaining('opening apps')])
    })

    it.skipIf(!UI)(
      'RS-7 FU-19 open -a Calculator is refused and recognised [SHUVIX_SBX_UI=1]',
      () => {
        const spec = specOf()
        const r = confined(spec, 'open -a Calculator')
        expect(r.status, r.out).not.toBe(0)
        const note = explainSandboxDenial({
          spec,
          outputTail: r.out,
          exitCode: r.status,
          offerEscalation: true
        })
        expect(note, r.out).not.toBeNull()
        expect(noteEntries(note)).toEqual([expect.stringContaining('opening apps')])
      }
    )

    it.skipIf(!UI)('RS-7 osascript cannot send Apple Events [SHUVIX_SBX_UI=1]', () => {
      // 实测（macOS 26.5.2）：这里报的是 -1728「Can't get application」，不是 -10827
      const spec = specOf()
      const r = confined(spec, `osascript -e 'tell application "Finder" to get version'`)
      expect(r.status, r.out).not.toBe(0)
      expect(r.stdout.trim()).toBe('')
      // FU-19 的决定：-1728 刻意不算签名（一个裸的 -1728 也是普通脚本错误：对象不存在），
      // 所以这条真的拒绝没有说明 —— 宁可不说，也不把用户自己的脚本错误说成沙箱拦的
      expect(
        explainSandboxDenial({ spec, outputTail: r.out, exitCode: r.status, offerEscalation: true })
      ).toBeNull()
    })
  })

  // ─── RS-8 ─────────────────────────────────────────

  describe('RS-8 process model + signals', () => {
    /** 本组起的进程（都自成进程组时按组杀，否则按 pid） */
    const spawned: number[] = []
    afterEach(() => {
      for (const pid of spawned.splice(0)) {
        for (const target of [-pid, pid]) {
          try {
            process.kill(target, 'SIGKILL')
          } catch {
            /* 已退出 / 不是组长 */
          }
        }
      }
    })

    interface Started {
      pid: number
      /** 进程退出（信号名；自己退出的是 null） */
      exited: Promise<NodeJS.Signals | null>
      /** 输出收齐、进程关闭 */
      done: Promise<RunResult>
      /** 退出承诺是否已兑现（「目标还活着」的第二个证据） */
      settled: () => boolean
    }

    /** 起一个进程：detached = 自成进程组（bgTaskService 的拓扑）；输出收着 */
    function start(file: string, args: string[], spec: SandboxSpec, detached: boolean): Started {
      const child = spawn(file, args, {
        cwd: spec.workingDirectory,
        env: envFor(spec),
        detached,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      spawned.push(child.pid!)
      let stdout = ''
      let stderr = ''
      let hasExited = false
      child.stdout!.on('data', (d) => (stdout += d))
      child.stderr!.on('data', (d) => (stderr += d))
      const exited = new Promise<NodeJS.Signals | null>((r) =>
        child.once('exit', (_code, signal) => {
          hasExited = true
          r(signal)
        })
      )
      const done = new Promise<RunResult>((r) =>
        child.once('close', (status) => r({ status, stdout, stderr, out: stdout + stderr }))
      )
      return { pid: child.pid!, exited, done, settled: () => hasExited }
    }

    /** 套沙箱的一条 bash 命令，自成进程组 */
    function confinedDetached(spec: SandboxSpec, cmd: string): Started {
      const w = backend.wrap(spec, { file: '/bin/bash', args: ['--norc', '-c', cmd] })
      return start(w.file, w.args, spec, true)
    }

    /** 一个活着的目标：跑够 200ms 再用 */
    async function target(t: Started): Promise<Started> {
      await new Promise((r) => setTimeout(r, 200))
      expect(isAlive(t.pid)).toBe(true)
      return t
    }

    /**
     * 发信被拒：非零、EPERM；拒绝说明里没有凭空的「cannot write」（bash 的 `kill: (-N) - …` 没有路径），
     * 没有 setuid 的误判，而是指向宿主代停（`shuvix task stop <pid>`）。
     */
    function expectSignalRefused(spec: SandboxSpec, r: RunResult): void {
      expect(r.status, r.out).not.toBe(0)
      expect(r.out).toMatch(/Operation not permitted/)
      const note = explainSandboxDenial({
        spec,
        outputTail: r.out,
        exitCode: r.status,
        offerEscalation: true
      })
      expect(noteEntries(note).filter((e) => e.startsWith('cannot'))).toEqual([])
      expect(note).toContain('shuvix task stop <pid>')
      expect(note).not.toContain('setuid')
    }

    /** 目标 300ms 后仍然活着，退出承诺也没兑现 */
    async function expectStillAlive(t: Started): Promise<void> {
      await new Promise((r) => setTimeout(r, 300))
      expect(isAlive(t.pid)).toBe(true)
      expect(t.settled()).toBe(false)
    }

    it('RS-8 sandbox-exec execs in place: the spawned pid is $$ and the process group', async () => {
      const spec = specOf()
      // /bin/ps 是 setuid 程序，沙箱里起不来（exit 126）—— 用 python 在沙箱里取进程组号
      const w = backend.wrap(spec, {
        file: '/bin/bash',
        args: ['--norc', '-c', 'echo $$; /usr/bin/python3 -c "import os; print(os.getpgrp())"']
      })
      const child = spawn(w.file, w.args, {
        cwd: ws,
        env: envFor(spec),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      spawned.push(child.pid!)
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      const code = await new Promise((r) => child.on('close', r))
      expect(code, out).toBe(0)
      expect(out.trim().split('\n')).toEqual([String(child.pid), String(child.pid)])
    })

    // FU-10：每条命令是一个独立的 sandbox-exec 实例，`signal (target same-sandbox)` 只够到自己这一条 ——
    // 停上一条命令起的后台任务走宿主（`shuvix task stop <pid>`），不靠 kill
    it.each([
      ['kill -- -<pid>（整个进程组）', (pid: number) => `kill -- -${pid}`],
      ['kill <pid>', (pid: number) => `kill ${pid}`]
    ])(
      'RS-8 FU-10 a confined command cannot stop another confined task: %s',
      async (_label, killCmd) => {
        const spec = specOf()
        const a = await target(confinedDetached(spec, 'sleep 30'))

        const b = await confinedDetached(spec, killCmd(a.pid)).done
        expectSignalRefused(spec, b)
        await expectStillAlive(a)
      }
    )

    // FU-11：不在本沙箱里的进程（测试进程自己代表 ShuviX 主进程、别的进程组里的 sleep、Finder）一个都够不到。
    // 对测试进程只用 `kill -0`：万一回归，失败的是断言，而不是把 worker 杀掉
    describe('RS-8 FU-11 no signals to processes outside the sandbox', () => {
      it('RS-8 FU-11 detached sender: kill -TERM an unconfined sleep in another group, kill -0 the test process', async () => {
        const spec = specOf()
        const t = await target(start('/bin/sleep', ['30'], spec, true))

        const term = await confinedDetached(spec, `kill -TERM ${t.pid}`).done
        expectSignalRefused(spec, term)
        await expectStillAlive(t)

        const probe = await confinedDetached(spec, `kill -0 ${process.pid}`).done
        expectSignalRefused(spec, probe)
      })

      it('RS-8 FU-11 non-detached sender (same process group as the test process): same refusals', async () => {
        const spec = specOf()
        const t = await target(start('/bin/sleep', ['30'], spec, true))

        const term = confined(spec, `kill -TERM ${t.pid}`)
        expectSignalRefused(spec, term)
        await expectStillAlive(t)

        const probe = confined(spec, `kill -0 ${process.pid}`)
        expectSignalRefused(spec, probe)
      })

      it('RS-8 FU-11 Finder (kill -0 only) is out of reach', async (ctx) => {
        const found = spawnSync('/usr/bin/pgrep', ['-x', 'Finder'], { encoding: 'utf8' })
        const pid = Number(String(found.stdout).trim().split('\n')[0])
        if (found.status !== 0 || !Number.isInteger(pid) || pid <= 0) ctx.skip()
        const spec = specOf()
        const probe = await confinedDetached(spec, `kill -0 ${pid}`).done
        expectSignalRefused(spec, probe)
        expect(isAlive(pid)).toBe(true)
      })
    })

    // FU-12：正向对照 —— 同一个沙箱里的作业控制照常工作，FU-10/11 的拒绝不是因为信号整个被关掉了
    it.each([
      ['a background child', 'sleep 30 & p=$!; kill $p; wait $p; echo rc=$?'],
      ['a grandchild (bash -c)', "bash -c 'sleep 30' & p=$!; kill $p; wait $p; echo rc=$?"]
    ])('RS-8 FU-12 same-sandbox job control still works: %s', (_label, cmd) => {
      const r = confined(specOf(), cmd)
      expect(r.status, r.out).toBe(0)
      expect(r.stdout.trim()).toBe('rc=143')
    })
  })

  // ─── RS-9 ─────────────────────────────────────────

  describe('RS-9 real startup-failure formats', () => {
    it('RS-9 a profile referencing an undefined param exits 65 and is recognised', () => {
      const spec = specOf()
      const w = backend.wrap(spec, { file: '/usr/bin/true', args: [] })
      // 对照：原样的 argv 能起来
      const ok = spawnSync(w.file, w.args, { encoding: 'utf8', timeout: 10_000 })
      expect(ok.status, String(ok.stderr)).toBe(0)
      // 去掉第一对 -D：profile 里仍引用 P0，却没有定义它
      const i = w.args.indexOf('-D')
      expect(w.args[i + 1]).toMatch(/^P0=/)
      const broken = [...w.args.slice(0, i), ...w.args.slice(i + 2)]
      const r = toResult(spawnSync(w.file, broken, { encoding: 'utf8', timeout: 10_000 }))
      expect(r.status, r.out).toBe(65)
      const first = r.out.trimStart().split('\n')[0]
      expect(first.startsWith('sandbox-exec:')).toBe(true)
      expect(backend.startupFailure(r.out, 65)).toBe(first)
    })

    it('RS-9 a nested sandbox-exec exits 71 with a sandbox-exec: first line and is recognised', () => {
      const r = confined(specOf(), `${SANDBOX_EXEC} -p '(version 1)(allow default)' /usr/bin/true`)
      expect(r.status, r.out).toBe(71)
      const first = r.out.trimStart().split('\n')[0]
      expect(first.startsWith('sandbox-exec:')).toBe(true)
      expect(first).toContain('sandbox_apply')
      expect(backend.startupFailure(r.out, 71)).toBe(first)
    })
  })
})
