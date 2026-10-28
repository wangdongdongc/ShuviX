/**
 * `shuvix widget …` 删掉了（组件的操作全部经 `widget` 工具，见 tools/widget.ts）—— CLI 这一头只剩一句说明。
 *
 * 与 cliTaskStop.test.ts 同一套：beforeAll 用 esbuild-wasm 把 src/cli/index.ts 打成 cjs 包，每个用例用本机 node 真的跑
 * 一次（真的退出码、真的 stdout / stderr）。HOME 指向临时家目录：里面有 `.shuvix/cli-token` 与一个真的 unix socket
 * 服务端 `.shuvix/cli.sock`（记下连接次数与请求行）；另一个家目录什么都没有（没有令牌）。
 *
 *   WT4-CL-01 `widget build x` / `widget` / `widget call a-b op --args {}` / `widget --help` → 退出 2，stderr 那一句说明，
 *             stdout 空，一次都不连 cli.sock
 *   WT4-CL-02 家目录里没有 cli-token → 同一句、同样退出 2（拒绝用不着令牌）
 *   WT4-CL-03 `--help`（退出 0）与不带参数（退出 1）的用法里没有 `shuvix widget`，照旧有 task stop 与 policy check
 *   WT4-CL-04 `policy check --help` 照旧：正好发一条 `{command:'policy.check', params:{flags:[['help','']]}}`，回话原样打印
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { build, stop as stopEsbuild } from 'esbuild-wasm'

const TOKEN = 'tok'
const CHAT_PROTOCOL_SRC = resolve(__dirname, '../../../../../packages/chat-protocol/src')
const REMOVED =
  'shuvix widget was removed: widgets are used and built with the `widget` tool (actions list, describe, call, create, build, preview, sql, export, open).\n'

let dir = ''
/** 有令牌、有 cli.sock 的家目录 */
let home = ''
/** 什么都没有的家目录（没有令牌） */
let bareHome = ''
let bundle = ''
let server: Server | null = null
let requests: Record<string, unknown>[] = []
let connections = 0
let reply: Record<string, unknown> = { success: true, data: 'ok' }

interface CliRun {
  code: number | null
  stdout: string
  stderr: string
}

function cli(args: string[], homeDir = home): Promise<CliRun> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [bundle, ...args],
      {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homeDir, SHUVIX_SESSION_ID: 's1' },
        timeout: 15_000
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0
        done({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

describe.skipIf(process.platform === 'win32')('shuvix widget 删掉了（CLI）[posix]', () => {
  beforeAll(async () => {
    // 短路径：unix socket 路径在 macOS 上有 ~104 字节的上限
    dir = mkdtempSync(join(tmpdir(), 'sxcliw-'))
    home = join(dir, 'h')
    bareHome = join(dir, 'b')
    mkdirSync(join(home, '.shuvix'), { recursive: true })
    mkdirSync(bareHome, { recursive: true })
    writeFileSync(join(home, '.shuvix', 'cli-token'), `${TOKEN}\n`)

    bundle = join(dir, 'cli.cjs')
    const result = await build({
      entryPoints: [resolve(__dirname, '../index.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      outfile: bundle,
      alias: { '@shuvix/chat-protocol': CHAT_PROTOCOL_SRC },
      logLevel: 'silent'
    })
    expect(result.errors).toEqual([])

    server = createServer((sock) => {
      connections++
      let buf = ''
      sock.setEncoding('utf8')
      sock.on('data', (chunk: string) => {
        buf += chunk
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        requests.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>)
        sock.end(JSON.stringify(reply) + '\n')
      })
    })
    await new Promise<void>((ok, fail) => {
      server!.once('error', fail)
      server!.listen(join(home, '.shuvix', 'cli.sock'), () => ok())
    })
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()))
    await stopEsbuild()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    requests = []
    connections = 0
    reply = { success: true, data: 'ok' }
  })

  it.each([
    [['widget', 'build', 'x']],
    [['widget']],
    [['widget', 'call', 'a-b', 'op', '--args', '{}']],
    [['widget', '--help']]
  ])('WT4-CL-01 %j → 退出 2、那一句说明、不连 ShuviX', async (args) => {
    const r = await cli(args)

    expect(r.code).toBe(2)
    expect(r.stderr).toBe(REMOVED)
    expect(r.stdout).toBe('')
    expect(connections).toBe(0)
    expect(requests).toEqual([])
  })

  it.each([[['widget', 'build', 'x']], [['widget', 'list']]])(
    'WT4-CL-02 没有 cli-token 的家目录 %j → 同一句、退出 2',
    async (args) => {
      const r = await cli(args, bareHome)

      expect(r.code).toBe(2)
      expect(r.stderr).toBe(REMOVED)
      expect(r.stderr).not.toContain('cli-token')
      expect(r.stdout).toBe('')
      expect(connections).toBe(0)
    }
  )

  it.each([
    [['--help'], 0],
    [[], 1]
  ] as const)('WT4-CL-03 %j → 用法里没有 shuvix widget，退出 %i', async (args, code) => {
    const r = await cli([...args])

    expect(r.code).toBe(code)
    expect(r.stderr).toContain('Usage:')
    expect(r.stderr).not.toContain('shuvix widget')
    expect(r.stderr).toContain('shuvix task stop <pid>')
    expect(r.stderr).toContain('shuvix policy check')
    expect(connections).toBe(0)
  })

  it('WT4-CL-04 policy check --help 照旧：正好一条 policy.check 请求，回话原样打印', async () => {
    reply = { success: true, data: { stdout: 'policy usage', stderr: '', exitCode: 0 } }
    const r = await cli(['policy', 'check', '--help'])

    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toBe('policy usage\n')
    expect(connections).toBe(1)
    expect(requests).toEqual([
      {
        token: TOKEN,
        command: 'policy.check',
        params: { flags: [['help', '']] },
        sessionId: 's1'
      }
    ])
  })
})
