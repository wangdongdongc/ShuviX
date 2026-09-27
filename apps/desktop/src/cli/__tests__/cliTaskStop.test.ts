/**
 * `shuvix task stop <pid>`（FU-5）—— CLI 这一头：argv → 发到 cli.sock 的那一行 → 退出码。
 *
 * `../index` 一引入就跑 main() 并 process.exit，所以不在进程内引它：beforeAll 用 esbuild-wasm 把
 * src/cli/index.ts 打成一个 cjs 包放进临时目录，每个用例用本机 node 真的跑一次（真的退出码、真的
 * stdout / stderr）。HOME 指向临时家目录：里面有 `.shuvix/cli-token`（tok）和一个真的 unix socket
 * 服务端 `.shuvix/cli.sock`，它记下收到的请求行、回一条事先定好的响应。
 *
 *  (a) 请求就是 `{token, command:'task.stop', params:{pid:<数字>}, sessionId}`，成功回话原样打到 stdout、退出 0；
 *  (b) 失败回话 → stderr `Error: <原因>`、退出 1；
 *  (c) 没有 / 空的 SHUVIX_SESSION_ID → 请求里干脆没有 sessionId 这个键；
 *  (d) pid 不是一串数字 → 本地就拒（stderr 一句、退出 1），根本不连 ShuviX；
 *  (e) `task` / `task kill 5` → 用法、退出 1、不连；
 *  (f) `--help`（退出 0）与不带参数（退出 1）打印的用法里有 `shuvix task stop <pid>`。
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

let dir = ''
let home = ''
let bundle = ''
let server: Server | null = null
/** 服务端收到的请求（每条一行 JSON，已解析） */
let requests: Record<string, unknown>[] = []
/** 服务端被连了几次（本地就该拒掉的用例要求 0） */
let connections = 0
/** 下一个请求的回话 */
let reply: Record<string, unknown> = { success: true, data: 'ok' }

interface CliRun {
  code: number | null
  stdout: string
  stderr: string
}

/** 跑一次打好的 CLI；env 只给 PATH / HOME 加上用例自己的（不把测试进程的 SHUVIX_SESSION_ID 带进去） */
function cli(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [bundle, ...args],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env }, timeout: 15_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0
        done({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

describe.skipIf(process.platform === 'win32')(
  'FU-5 shuvix task stop（CLI → cli.sock）[posix]',
  () => {
    beforeAll(async () => {
      // 短路径：unix socket 路径在 macOS 上有 ~104 字节的上限
      dir = mkdtempSync(join(tmpdir(), 'sxcli-'))
      home = join(dir, 'h')
      mkdirSync(join(home, '.shuvix'), { recursive: true })
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

    it('FU-5a task stop 123 + SHUVIX_SESSION_ID → 请求形状精确；成功回话打到 stdout，退出 0', async () => {
      reply = { success: true, data: 'stopping background task 123' }
      const r = await cli(['task', 'stop', '123'], { SHUVIX_SESSION_ID: 'sess-1' })

      expect(r.code, r.stderr).toBe(0)
      expect(r.stdout).toBe('stopping background task 123\n')
      expect(requests).toEqual([
        { token: TOKEN, command: 'task.stop', params: { pid: 123 }, sessionId: 'sess-1' }
      ])
      // pid 是 JSON 数字，不是字符串
      expect(typeof (requests[0].params as { pid: unknown }).pid).toBe('number')
    })

    it('FU-5b 失败回话 → stderr「Error: <原因>」，退出 1', async () => {
      reply = { success: false, error: 'no background task with pid 123 in this session' }
      const r = await cli(['task', 'stop', '123'], { SHUVIX_SESSION_ID: 'sess-1' })

      expect(r.code).toBe(1)
      expect(r.stderr).toBe('Error: no background task with pid 123 in this session\n')
      expect(r.stdout).toBe('')
      expect(requests).toHaveLength(1)
    })

    it.each([
      ['没有 SHUVIX_SESSION_ID', {}],
      ['SHUVIX_SESSION_ID 为空', { SHUVIX_SESSION_ID: '' }]
    ])('FU-5c %s → 请求里没有 sessionId 这个键', async (_label, env) => {
      const r = await cli(['task', 'stop', '123'], env as Record<string, string>)

      expect(r.code, r.stderr).toBe(0)
      expect(requests).toHaveLength(1)
      expect('sessionId' in requests[0]).toBe(false)
      expect(requests[0]).toEqual({ token: TOKEN, command: 'task.stop', params: { pid: 123 } })
    })

    it.each([
      [['task', 'stop']],
      [['task', 'stop', 'abc']],
      [['task', 'stop', '-5']],
      [['task', 'stop', '1.5']],
      [['task', 'stop', '0x10']],
      [['task', 'stop', '1e3']],
      [['task', 'stop', ' 7']]
    ])('FU-5d %j → 本地就拒：stderr 一句，退出 1，不连 ShuviX', async (args) => {
      const r = await cli(args, { SHUVIX_SESSION_ID: 'sess-1' })

      expect(r.code).toBe(1)
      expect(r.stderr).toBe('task stop: <pid> (a number) is required\n')
      expect(r.stdout).toBe('')
      expect(connections).toBe(0)
    })

    it.each([[['task']], [['task', 'kill', '5']]])(
      'FU-5e %j → 打印用法，退出 1，不连 ShuviX',
      async (args) => {
        const r = await cli(args, { SHUVIX_SESSION_ID: 'sess-1' })

        expect(r.code).toBe(1)
        expect(r.stderr).toContain('Usage:')
        expect(r.stderr).toContain('shuvix task stop <pid>')
        expect(connections).toBe(0)
      }
    )

    it.each([
      [['--help'], 0],
      [[], 1]
    ] as const)('FU-5f %j → 用法里有 shuvix task stop <pid>，退出 %i', async (args, code) => {
      const r = await cli([...args])

      expect(r.code).toBe(code)
      expect(r.stderr).toContain('shuvix task stop <pid>')
      expect(connections).toBe(0)
    })
  }
)
