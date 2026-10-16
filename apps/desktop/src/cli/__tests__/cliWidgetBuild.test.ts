/**
 * `shuvix widget build <id> [--message "<提交说明>"]` —— CLI 这一头：argv → 发到 cli.sock 的那一行 → 输出与退出码。
 *
 * 与 cliTaskStop.test.ts 同一套起法：`../index` 一引入就跑 main() 并 process.exit，所以 beforeAll 用 esbuild-wasm 把
 * src/cli/index.ts 打成 cjs 包，每个用例用本机 node 真的跑一次；HOME 指向临时家目录（`.shuvix/cli-token` 与一个
 * 真的 unix socket 服务端 `.shuvix/cli.sock`，记下请求行、回一条事先定好的响应）。
 *
 *   CW-1 `--message "feat: add grid"` → 请求 `{token, command:'widget.build', params:{id, message}, sessionId}`，退出 0
 *   CW-2 不带 --message → params 只有 id
 *   CW-3 `--message` 在末尾没有值、`--message ""` → params 只有 id
 *   CW-4 带空白、中文、换行的说明原样转（不 trim）
 *   CW-5 成功回话（对象）→ stdout 是 `JSON.stringify(data, null, 2)` 加换行，退出 0
 *   CW-6 不带 id → stderr `widget build: <id> is required`，退出 1，不连 ShuviX
 *   CW-7 用法里有 `shuvix widget build <id> [--message "<commit subject>"]`
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
  'CW shuvix widget build（CLI → cli.sock）[posix]',
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

    it('CW-1 --message → 请求形状精确，退出 0', async () => {
      const r = await cli(['widget', 'build', 'my-widget', '--message', 'feat: add grid'], {
        SHUVIX_SESSION_ID: 'sess-1'
      })

      expect(r.code, r.stderr).toBe(0)
      expect(requests).toEqual([
        {
          token: TOKEN,
          command: 'widget.build',
          params: { id: 'my-widget', message: 'feat: add grid' },
          sessionId: 'sess-1'
        }
      ])
    })

    it('CW-2 不带 --message → params 只有 id', async () => {
      const r = await cli(['widget', 'build', 'my-widget'], { SHUVIX_SESSION_ID: 'sess-1' })

      expect(r.code, r.stderr).toBe(0)
      expect(requests).toHaveLength(1)
      const params = requests[0].params as Record<string, unknown>
      expect(Object.keys(params)).toEqual(['id'])
      expect(params).toEqual({ id: 'my-widget' })
    })

    it.each([
      ['--message 在末尾没有值', ['widget', 'build', 'my-widget', '--message']],
      ['--message ""', ['widget', 'build', 'my-widget', '--message', '']]
    ])('CW-3 %s → params 只有 id', async (_label, args) => {
      const r = await cli(args, { SHUVIX_SESSION_ID: 'sess-1' })

      expect(r.code, r.stderr).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0].params).toEqual({ id: 'my-widget' })
      expect(Object.keys(requests[0].params as object)).toEqual(['id'])
    })

    it('CW-4 带空白、中文、换行的说明原样转', async () => {
      const message = '  fix: 修复 \n second'
      const r = await cli(['widget', 'build', 'my-widget', '--message', message], {
        SHUVIX_SESSION_ID: 'sess-1'
      })

      expect(r.code, r.stderr).toBe(0)
      expect(requests[0].params).toEqual({ id: 'my-widget', message })
    })

    it('CW-5 成功回话 → stdout 是缩进两格的 JSON 加换行，退出 0', async () => {
      const data = {
        id: 'my-widget',
        url: 'http://127.0.0.1:1/w/my-widget/',
        buildSuccess: true,
        commit: 'abc1234'
      }
      reply = { success: true, data }
      const r = await cli(['widget', 'build', 'my-widget'], { SHUVIX_SESSION_ID: 'sess-1' })

      expect(r.code, r.stderr).toBe(0)
      expect(r.stdout).toBe(JSON.stringify(data, null, 2) + '\n')
    })

    it('CW-6 不带 id → stderr 一句、退出 1、不连 ShuviX', async () => {
      const r = await cli(['widget', 'build'], { SHUVIX_SESSION_ID: 'sess-1' })

      expect(r.code).toBe(1)
      expect(r.stderr).toBe('widget build: <id> is required\n')
      expect(connections).toBe(0)
    })

    it('CW-7 用法里有 widget build 的 --message', async () => {
      const r = await cli(['--help'])

      expect(r.stderr).toContain('shuvix widget build <id> [--message "<commit subject>"]')
      expect(connections).toBe(0)
    })
  }
)
