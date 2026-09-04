/**
 * bash 工具不会执行用户的 ~/.bashrc —— macOS rshd 探测泄漏的回归测试
 *
 * 背景：Apple 的 /bin/bash（3.2）启动时做 rshd/sshd 探测。在非交互、非登录、未被当作 sh
 * 调用的前提下，只要 `isnetconn(fd 0)`（= getpeername 成功，**unix socketpair 也算**）为真
 * 且 SHLVL 缺失或为 "0"，它就在执行 `-c` 命令**之前**先 source ~/.bashrc。
 * 后台任务恰好凑齐条件（libuv 用 socketpair 实现 'pipe' stdio；打包应用环境无 SHLVL），
 * 于是后台任务 100% 会跑用户的 .bashrc，而前台（stdin 为 /dev/null）永不触发。
 *
 * 两处修复各自独立地把这条路堵死：
 *   1. shell.ts 的 `--norc`（bash 分支）—— 见 bashShellConfig.test.ts 锁其形状
 *   2. bgTaskService 的 `stdio: ['ignore', …]` —— 把 socket 型 stdin 这个触发条件本身移除
 * 本文件锁的是**行为**：不论机理如何，用户的 rc 绝不能污染任何一条命令的输出。
 *
 * ⚠️ 读这批用例前先知道一件事（实测确认）：触发需要四个条件同时成立，而两处修复各拆掉
 * 其中一个 —— 所以 U2–U7 只在**两处都退回去**时才红，单独退回任何一处它们照样绿。
 * 能逐个盯住单处回归的是另外三条，改这块代码时它们才是你的安全网：
 *   - `--norc` 掉了     → bashShellConfig.test.ts 的四条 + 本文件 N1「生产配置…」
 *   - stdin 变回管道了  → 本文件 N2
 *
 * ⚠️ SHLVL 陷阱：vitest 自己是从 shell 起来的，process.env.SHLVL 通常是 "2"，
 * 恰好压住这条分支 —— 不 stub 掉它，整组用例都是假绿。setupRcEnv() 里有一条断言把这点钉死。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolContext } from '../../services/toolContext'

const STAMP = Date.now()
const FAKE_HOME = join(tmpdir(), `shuvix-bashrc-home-${STAMP}`)
const USER_DATA_DIR = join(tmpdir(), `shuvix-bashrc-userdata-${STAMP}`)
const WORK_DIR = join(tmpdir(), `shuvix-bashrc-cwd-${STAMP}`)
const RC_PATH = join(FAKE_HOME, '.bashrc')
const SESSION_ID = 'bashrc-test-session'

/** rc 里发出的噪音标记 —— 出现在任何输出里都意味着 rc 被执行了 */
const NOISE = 'RC_NOISE_MARKER'
/** 命令自己的输出标记 */
const PAYLOAD = 'PAYLOAD_MARKER'
const ECHO_PAYLOAD = `echo ${PAYLOAD}`

// ─── mock ────────────────────────────────────────────────────────────────────

// bgTaskService → utils/paths 需要 app.getPath（日志目录）与 app.isPackaged（CLI 路径）
vi.mock('electron', () => ({ app: { getPath: () => USER_DATA_DIR, isPackaged: false } }))

/** 项目配置旋钮 —— 工厂闭包在调用时才读，故可在用例里改（U9 要注入 env vars） */
const projectConfig: { workingDirectory: string; envVars: Record<string, string> } = {
  workingDirectory: WORK_DIR,
  envVars: {}
}
// mock toolContext：避免加载 projectDao/sessionService（→ better-sqlite3）；安全门恒放行
vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => projectConfig,
  getDesktopSecurityContext: () => ({
    enforceCommand: async () => ({ status: 'allowed' })
  }),
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))

import { startBgTask, killAllBgTasks, type BgTaskStartResult } from '../../services/bgTaskService'
import { getShellConfig } from '../../utils/toolUtils/shell'
import { getShuvixCliEnv } from '../../utils/paths'
import { BashTool } from '../bash'

// ─── 夹具 ────────────────────────────────────────────────────────────────────

/** 写入假 HOME 下的 .bashrc；不调用则该用例没有 rc */
function writeRc(body: string): void {
  writeFileSync(RC_PATH, `${body}\n`, 'utf-8')
}

/**
 * 复刻触发条件里我们能控的两项：HOME 指向假目录、SHLVL 从环境中消失。
 *
 * `vi.stubEnv(name, undefined)` 会**删除**该 key（裸 `delete process.env.SHLVL` 不走
 * unstubAllEnvs 的还原路径，会漏给同进程的后续测试文件）。
 */
function setupRcEnv(): void {
  vi.stubEnv('HOME', FAKE_HOME)
  vi.stubEnv('SHLVL', undefined)
  // 假绿看门狗：SHLVL 还在的话 bash 根本不会走 rshd 分支，下面所有断言都不成立
  expect(process.env.SHLVL).toBeUndefined()
  expect(process.env.HOME).toBe(FAKE_HOME)
}

let bgCall = 0

/** 起一个后台任务（每次换 toolCallId，日志文件互不覆盖） */
function runBackground(command: string): Promise<BgTaskStartResult> {
  return startBgTask({
    sessionId: SESSION_ID,
    toolCallId: `bg-${++bgCall}`,
    command,
    description: 'rc leak test',
    cwd: WORK_DIR,
    extraEnv: { ...projectConfig.envVars, SHUVIX_SESSION_ID: SESSION_ID }
  })
}

/** 走完整的 bash 工具（前台或后台形态），返回工具结果 */
async function runTool(
  command: string,
  runInBackground = false
): Promise<{ text: string; exitCode: number | undefined }> {
  const tool = new BashTool({ sessionId: SESSION_ID } as ToolContext)
  const result = (await tool.execute(`tool-${++bgCall}`, {
    command,
    description: 'rc leak test',
    run_in_background: runInBackground
  })) as AgentToolResult<{ exitCode?: number }>
  const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  return { text, exitCode: result.details?.exitCode }
}

beforeAll(() => {
  for (const dir of [FAKE_HOME, USER_DATA_DIR, WORK_DIR]) mkdirSync(dir, { recursive: true })
})

afterAll(() => {
  for (const dir of [FAKE_HOME, USER_DATA_DIR, WORK_DIR])
    rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(RC_PATH, { force: true })
  projectConfig.envVars = {}
  setupRcEnv()
})

afterEach(() => {
  // 修复缺失时 U6 那条会真的挂起一个后台 bash —— 必须无条件收尸
  killAllBgTasks()
  vi.unstubAllEnvs()
})

// Windows 上 /bin/bash 不存在，且这个 bug 是 Apple bash 3.2 特有的形态问题
const posixOnly = describe.skipIf(process.platform === 'win32')

// ─── U2–U6：后台任务不受用户 rc 影响 ─────────────────────────────────────────

posixOnly('后台任务的输出里没有用户 rc 的痕迹', () => {
  it('U2 — rc 往 stdout 写字，后台输出仍然只有命令自己的内容', async () => {
    writeRc(`echo ${NOISE}`)

    const started = await runBackground(ECHO_PAYLOAD)

    expect(started.kind).toBe('settled')
    const output = started.kind === 'settled' ? started.output : ''
    expect(output.trim()).toBe(PAYLOAD)
    expect(output).not.toContain(NOISE)
  })

  it('U3 — 语法错误的 rc 不会把后台任务连累进错误输出', async () => {
    // 少了一个 ']'，source 时 bash 会打一串 syntax error 到 stderr（与 stdout 同一个日志 fd）
    writeRc('if [ -z "$UNSET_VAR" ; then\n  echo broken\nfi')

    const started = await runBackground(ECHO_PAYLOAD)

    expect(started.kind).toBe('settled')
    const output = started.kind === 'settled' ? started.output : ''
    expect(output.trim()).toBe(PAYLOAD)
    expect(output.toLowerCase()).not.toContain('syntax error')
  })

  it('U4 — 误粘进 rc 的非 shell 文本不会污染后台输出', async () => {
    writeRc('这是一行被误粘进 .bashrc 的散文 not a shell command')

    const started = await runBackground(ECHO_PAYLOAD)

    expect(started.kind).toBe('settled')
    const output = started.kind === 'settled' ? started.output : ''
    expect(output.trim()).toBe(PAYLOAD)
    expect(output.toLowerCase()).not.toContain('command not found')
  })

  it('U5 — rc 里的 exit 杀不掉后台任务，退出码仍来自命令本身', async () => {
    // source 出来的 `exit 3` 会终止**整个** shell —— 命令根本没机会运行
    writeRc('exit 3')

    const started = await runBackground(ECHO_PAYLOAD)

    expect(started.kind).toBe('settled')
    expect(started.info.exitCode).toBe(0)
    const output = started.kind === 'settled' ? started.output : ''
    expect(output.trim()).toBe(PAYLOAD)
  })

  it('U6 — 阻塞在读输入的 rc 不会让后台任务挂死', async () => {
    // 触发条件成立时 stdin 是永不 EOF 的 socket，这一行会把 shell 卡在启动阶段：
    // 任务熬过 2s 预热窗口转入 background，而命令一个字节都还没跑
    writeRc('read -r ANSWER')

    const started = await runBackground(ECHO_PAYLOAD)

    expect(started.kind).toBe('settled')
    const output = started.kind === 'settled' ? started.output : ''
    expect(output.trim()).toBe(PAYLOAD)
  })
})

// ─── U7 / U8：前台形态 ───────────────────────────────────────────────────────

posixOnly('前台与后台看到同一个世界', () => {
  it('U7 — 同一条命令，前台的 text 与后台的 output 完全一致', async () => {
    writeRc(`echo ${NOISE}\nnot-a-real-command-xyz`)

    const foreground = await runTool(ECHO_PAYLOAD)
    const background = await runBackground(ECHO_PAYLOAD)
    const backgroundOutput = background.kind === 'settled' ? background.output : '<went background>'

    expect(foreground.text).toBe(backgroundOutput)
    expect(foreground.text.trim()).toBe(PAYLOAD)
  })

  /**
   * 守护用例，**不是**回归用例：前台的 stdin 一直是 'ignore'（/dev/null），
   * isnetconn 从来不成立，所以它在修复前后都绿。留着是为了钉住前台的 stdio 形态 ——
   * 哪天有人把前台也改成 pipe（比如想给命令喂输入），这条会立刻变红。
   */
  it('U8 — 前台输出同样干净（守护前台的 stdin 形态）', async () => {
    writeRc(`echo ${NOISE}`)

    const foreground = await runTool(ECHO_PAYLOAD)

    expect(foreground.text.trim()).toBe(PAYLOAD)
    expect(foreground.text).not.toContain(NOISE)
  })
})

// ─── U9：--norc 没有误伤正常执行 ─────────────────────────────────────────────

posixOnly('--norc 只挡 rc，不挡环境', () => {
  /**
   * 守护用例：`--norc` 只抑制 rc 文件，不影响环境继承。但"加了个 flag 结果把项目
   * env vars / 注入的 PATH 弄丢了"是这类修复最典型的翻车方式，值得钉一条。
   */
  it('U9 — 项目 env vars、SHUVIX_SESSION_ID 与注入的 CLI PATH 仍然到达子进程', async () => {
    projectConfig.envVars = { SHUVIX_RC_TEST_VAR: 'from-project' }
    const cliDir = dirname(getShuvixCliEnv().SHUVIX_CLI)
    const command = 'echo "$SHUVIX_RC_TEST_VAR|$SHUVIX_SESSION_ID"; echo "$PATH"'

    const foreground = await runTool(command)

    expect(foreground.text).toContain(`from-project|${SESSION_ID}`)
    expect(foreground.text).toContain(cliDir)

    // 后台形态走同一条 buildSpawnEnv 路径，一并钉住
    const background = await runBackground(command)
    const output = background.kind === 'settled' ? background.output : ''
    expect(output).toContain(`from-project|${SESSION_ID}`)
    expect(output).toContain(cliDir)
  })
})

// ─── N2：后台任务没有 stdin ──────────────────────────────────────────────────

posixOnly('后台任务的 stdin 是 /dev/null', () => {
  it('N2 — 读 stdin 的后台命令立刻拿到 EOF，而不是挂起', async () => {
    // stdin 是管道时这里会永久阻塞（父进程握着写端，永远不 EOF）→ 转入 background
    const command = 'if read -r LINE; then echo "READ:$LINE"; else echo NO_STDIN; fi'

    const started = await runBackground(command)

    expect(started.kind).toBe('settled')
    expect(started.info.exitCode).toBe(0)
    const output = started.kind === 'settled' ? started.output : ''
    expect(output.trim()).toBe('NO_STDIN')
  })
})

// ─── N1：spawn 层的机理锁 ────────────────────────────────────────────────────

/**
 * 上面所有用例锁的都是**行为**：生产代码把 stdin 改成了 /dev/null，触发条件里的
 * socket 那一项已经不复存在，所以它们即便只剩 `--norc` 一道防线也照样绿 —— 反过来说，
 * 它们没法证明 `--norc` 本身还管用。
 *
 * 这一组直接在 spawn 层复刻完整的原始触发条件（bash 名义调用 + socketpair stdin +
 * 无 SHLVL），是唯一能把「`--norc` 挡得住」这件事本身钉死的地方。
 */
posixOnly('N1 — spawn 层：即便 stdin 是 socket 且无 SHLVL，--norc 依然挡得住 rc', () => {
  /**
   * 用与旧后台任务同样的 stdio 形态起 shell —— Node 的 'pipe' 在 Unix 上就是 socketpair，
   * 也就是让 isnetconn(fd 0) 为真的那个东西。
   */
  function rawSpawn(shell: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: FAKE_HOME }
      delete env.SHLVL // 复刻打包应用（Finder/launchd 拉起）的环境
      const child = spawn(shell, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (out += d.toString()))
      child.on('error', reject)
      child.on('close', () => resolve(out.trim()))
    })
  }

  const rawBash = (args: string[]): Promise<string> => rawSpawn('/bin/bash', args)

  /** 本机的 /bin/bash 是否真的做 rshd 探测（Apple bash 3.2 会，Linux/bash 5.x 不会） */
  async function probeTrigger(): Promise<boolean> {
    return (await rawBash(['-c', ECHO_PAYLOAD])).includes(NOISE)
  }

  it('带 --norc 时 rc 不执行', async () => {
    writeRc(`echo ${NOISE}`)

    expect(await rawBash(['--norc', '-c', ECHO_PAYLOAD])).toBe(PAYLOAD)
  })

  /**
   * 上一条用字面量写死了 `--norc`，锁的是"这个 flag 有效"；这一条用 **getShellConfig()
   * 解析出的真实参数**跑同一个触发条件，锁的是"生产配置在这个条件下确实干净"。
   * 二者缺一不可：前者证明工具有效，后者证明工具确实被拿在手里。
   */
  it('生产配置解析出的 shell/args 在完整触发条件下同样干净', async () => {
    const { shell, args } = getShellConfig()
    writeRc(`echo ${NOISE}`)

    expect(await rawSpawn(shell, [...args, ECHO_PAYLOAD])).toBe(PAYLOAD)
  })

  it('本机若复现 rshd 探测，则 --norc 是唯一的差异', async () => {
    writeRc(`echo ${NOISE}`)
    const reproduces = await probeTrigger()

    if (!reproduces) {
      // Linux / bash 5.x 没有这条分支 —— 夹具在这里无从比较，但上一条断言依旧有效
      expect(await rawBash(['-c', ECHO_PAYLOAD])).toBe(PAYLOAD)
      return
    }

    // 触发条件成立：不带 --norc 时 rc 抢在命令之前跑了
    expect(await rawBash(['-c', ECHO_PAYLOAD])).toBe(`${NOISE}\n${PAYLOAD}`)
    // 同一条件下加上 --norc 就干净了
    expect(await rawBash(['--norc', '-c', ECHO_PAYLOAD])).toBe(PAYLOAD)
  })

  /**
   * 夹具效力自检：在 Apple 的 bash 3.2 上，「不带 --norc + socket stdin + 无 SHLVL」
   * **必须**复现。若哪天这条变红，说明夹具失去了效力（bash 换了 / 条件变了），
   * 那时上面那条 if 分支会静悄悄地退化成永远绿 —— 这条断言就是不让它悄悄退化。
   */
  it('macOS 上的 Apple bash 3.2 必然复现该触发条件（夹具效力自检）', async () => {
    const version = await rawBash(['--norc', '-c', 'echo $BASH_VERSION'])
    const isAppleBash3 = process.platform === 'darwin' && version.startsWith('3.2')
    if (!isAppleBash3) return

    writeRc(`echo ${NOISE}`)
    expect(await probeTrigger()).toBe(true)
  })
})
