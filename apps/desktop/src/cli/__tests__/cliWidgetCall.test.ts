/**
 * `shuvix widget call <id> <operation> [--args '<json>'] [--dry-run]` —— CLI 这一头：argv → 发到 cli.sock 的那一行 → 输出与退出码。
 *
 * 与 cliWidgetBuild.test.ts 同一套起法：beforeAll 用 esbuild-wasm 把 src/cli/index.ts 打成 cjs 包，每个用例用本机 node
 * 真的跑一次；HOME 指向临时家目录（`.shuvix/cli-token` 与一个真的 unix socket 服务端 `.shuvix/cli.sock`，
 * 记下请求行、回一条事先定好的响应）。参数的 JSON 不在 CLI 里解析（主进程一份报错，见 cliServer 的 widget.call）。
 *
 *   C-1 `widget call w-x addBook --args '{"title":"a"}' --dry-run` → params `{id, op, args: 原样的 JSON 文本, dryRun: true}`；
 *       不带 flag → params 只有 `{id, op}`；用法里列出这条命令
 *   C-2 缺 id / 缺 operation / operation 以 `--` 开头 → stderr `widget call: <id> and <operation> are required`、退出 1、不连 ShuviX
 *   C-3 回话的 stdout / stderr 原样打印（没有换行就补一个、有就不再补），退出码就是回话里的 exitCode；
 *       `--args` 在末尾没有值 → 不带 args
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
let reply: Record<string, unknown> = {
  success: true,
  data: { stdout: '', stderr: '', exitCode: 0 }
}

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
  'C shuvix widget call（CLI → cli.sock）[posix]',
  () => {
    beforeAll(async () => {
      // 短路径：unix socket 路径在 macOS 上有 ~104 字节的上限
      dir = mkdtempSync(join(tmpdir(), 'sxcall-'))
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
      reply = { success: true, data: { stdout: '', stderr: '', exitCode: 0 } }
    })

    describe('C-1 请求的形状', () => {
      it('C-1 --args + --dry-run → params {id, op, args: 原样 JSON 文本, dryRun: true}', async () => {
        const r = await cli(
          ['widget', 'call', 'w-x', 'addBook', '--args', '{"title":"a"}', '--dry-run'],
          { SHUVIX_SESSION_ID: 'sess-1' }
        )

        expect(r.code, r.stderr).toBe(0)
        expect(requests).toEqual([
          {
            token: TOKEN,
            command: 'widget.call',
            params: { id: 'w-x', op: 'addBook', args: '{"title":"a"}', dryRun: true },
            sessionId: 'sess-1'
          }
        ])
      })

      it('C-1 --dry-run 写在 --args 前面也一样', async () => {
        const r = await cli([
          'widget',
          'call',
          'w-x',
          'addBook',
          '--dry-run',
          '--args',
          '{"title":"a"}'
        ])

        expect(r.code, r.stderr).toBe(0)
        expect(requests[0].params).toEqual({
          id: 'w-x',
          op: 'addBook',
          args: '{"title":"a"}',
          dryRun: true
        })
      })

      it('C-1 不带 flag → params 只有 {id, op}（没有 args / dryRun 键）', async () => {
        const r = await cli(['widget', 'call', 'w-x', 'listBooks'])

        expect(r.code, r.stderr).toBe(0)
        expect(requests).toHaveLength(1)
        expect(requests[0].command).toBe('widget.call')
        const params = requests[0].params as Record<string, unknown>
        expect(params).toEqual({ id: 'w-x', op: 'listBooks' })
        expect(Object.keys(params)).toEqual(['id', 'op'])
      })

      it('C-1 用法里有 widget call 这条命令', async () => {
        const r = await cli(['--help'])

        expect(r.stderr).toContain(
          "shuvix widget call <id> <operation> [--args '<json>'] [--dry-run]"
        )
        expect(connections).toBe(0)
      })
    })

    describe('C-2 缺 id / operation', () => {
      it.each([
        ['缺 id 与 operation', ['widget', 'call']],
        ['缺 operation', ['widget', 'call', 'w-x']],
        ['operation 位置是 --dry-run', ['widget', 'call', 'w-x', '--dry-run']],
        ['operation 位置是 --args', ['widget', 'call', 'w-x', '--args', '{}']]
      ])('C-2 %s → stderr 一句、退出 1、不连 ShuviX', async (_label, args) => {
        const r = await cli(args, { SHUVIX_SESSION_ID: 'sess-1' })

        expect(r.code).toBe(1)
        expect(r.stderr).toBe('widget call: <id> and <operation> are required\n')
        expect(r.stdout).toBe('')
        expect(connections).toBe(0)
        expect(requests).toEqual([])
      })
    })

    describe('C-3 输出与退出码', () => {
      it('C-3 stdout 原样打印并补换行，退出 0', async () => {
        const stdout = JSON.stringify({ op: 'addBook', mode: 'write', result: { id: 1 } }, null, 2)
        reply = { success: true, data: { stdout, stderr: '', exitCode: 0 } }

        const r = await cli(['widget', 'call', 'w-x', 'addBook'])

        expect(r.code, r.stderr).toBe(0)
        expect(r.stdout).toBe(stdout + '\n')
        expect(r.stderr).toBe('')
      })

      it('C-3 已经以换行结尾的输出不再补换行', async () => {
        reply = { success: true, data: { stdout: 'out\n', stderr: 'warn\n', exitCode: 0 } }

        const r = await cli(['widget', 'call', 'w-x', 'addBook'])

        expect(r.code).toBe(0)
        expect(r.stdout).toBe('out\n')
        expect(r.stderr).toBe('warn\n')
      })

      it('C-3 操作失败（stdout 是 {error}、exitCode 1）→ 原样打印，退出 1', async () => {
        const stdout = JSON.stringify(
          { op: 'addBook', mode: 'write', error: { code: 'not_found', message: 'no' } },
          null,
          2
        )
        reply = { success: true, data: { stdout, stderr: '', exitCode: 1 } }

        const r = await cli(['widget', 'call', 'w-x', 'addBook'])

        expect(r.code).toBe(1)
        expect(r.stdout).toBe(stdout + '\n')
        expect(r.stderr).toBe('')
      })

      it('C-3 只有 stderr（宿主错误 `[code] message`）→ 打到 stderr，退出码照回话', async () => {
        reply = {
          success: true,
          data: { stdout: '', stderr: '[no_api] Widget "w-x" has no API.', exitCode: 1 }
        }

        const r = await cli(['widget', 'call', 'w-x', 'addBook'])

        expect(r.code).toBe(1)
        expect(r.stdout).toBe('')
        expect(r.stderr).toBe('[no_api] Widget "w-x" has no API.\n')
      })

      it('C-3 退出码就是回话里的 exitCode（不是 0 / 1 也照回）', async () => {
        reply = { success: true, data: { stdout: 'x', stderr: '', exitCode: 3 } }

        const r = await cli(['widget', 'call', 'w-x', 'addBook'])

        expect(r.code).toBe(3)
        expect(r.stdout).toBe('x\n')
      })

      it('C-3 --args 在末尾没有值 → 不带 args', async () => {
        const r = await cli(['widget', 'call', 'w-x', 'addBook', '--args'])

        expect(r.code, r.stderr).toBe(0)
        expect(requests).toHaveLength(1)
        expect(requests[0].params).toEqual({ id: 'w-x', op: 'addBook' })
        expect('args' in (requests[0].params as object)).toBe(false)
      })
    })
  }
)
