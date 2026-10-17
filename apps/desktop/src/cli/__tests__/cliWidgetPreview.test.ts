/**
 * `shuvix widget preview <id> [--size panel,window,phone] [--theme light|dark]` —— CLI 这一头：argv → 发到 cli.sock 的
 * 那一行 → 输出与退出码。尺寸与主题的合法性在主进程里判（一份规则），CLI 只原样转交。
 *
 * 与 cliWidgetBuild.test.ts 同一套起法：beforeAll 用 esbuild-wasm 把 src/cli/index.ts 打成 cjs 包，每个用例用本机 node
 * 真的跑一次；HOME 指向临时家目录（`.shuvix/cli-token` 与一个真的 unix socket 服务端 `.shuvix/cli.sock`）。
 *
 *   U-CLI-1 只有 id → `{token, command:'widget.preview', params:{id}, sessionId}`（没有 size / theme 键），退出 0，stdout 是
 *           缩进两格的 JSON 加换行
 *   U-CLI-2 `--size phone,panel --theme dark` 原样转；`--size TABLET` 也原样转（主进程判）
 *   U-CLI-3 `--size` 在末尾没有值、`--size ""`、`--size=phone`（等号写法不认，B9：所有命令都只认空格写法）→ 没有 size 键
 *   U-CLI-4 不带 id → stderr 一句、退出 1、不连 ShuviX
 *   U-CLI-5 主进程拒绝（认不得的尺寸）→ stderr `Error: …`、退出 1
 *   U-CLI-6 用法里有 preview 那一行
 *   U-CLI-7 没有 SHUVIX_SESSION_ID → 请求里没有 sessionId
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
  'U-CLI shuvix widget preview（CLI → cli.sock）[posix]',
  () => {
    beforeAll(async () => {
      // 短路径：unix socket 路径在 macOS 上有 ~104 字节的上限
      dir = mkdtempSync(join(tmpdir(), 'sxpv-'))
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

    it('U-CLI-1 id only → exact request with no size / theme, exit 0, pretty JSON on stdout', async () => {
      const data = {
        id: 'pv-plain',
        theme: 'app',
        images: [{ size: 'panel', width: 380, height: 760, path: '/x/pv-plain-panel.png' }],
        errors: []
      }
      reply = { success: true, data }
      const r = await cli(['widget', 'preview', 'pv-plain'], { SHUVIX_SESSION_ID: 'sess-1' })

      expect(r.code, r.stderr).toBe(0)
      expect(requests).toStrictEqual([
        {
          token: TOKEN,
          command: 'widget.preview',
          params: { id: 'pv-plain' },
          sessionId: 'sess-1'
        }
      ])
      expect(Object.keys(requests[0].params as object)).toEqual(['id'])
      expect(r.stdout).toBe(JSON.stringify(data, null, 2) + '\n')
    })

    it('U-CLI-2 --size and --theme go through as typed (validity is judged in main)', async () => {
      const r = await cli(
        ['widget', 'preview', 'pv-plain', '--size', 'phone,panel', '--theme', 'dark'],
        { SHUVIX_SESSION_ID: 'sess-1' }
      )
      expect(r.code, r.stderr).toBe(0)
      expect(requests[0].params).toStrictEqual({
        id: 'pv-plain',
        size: 'phone,panel',
        theme: 'dark'
      })

      requests = []
      const raw = await cli(
        ['widget', 'preview', 'pv-plain', '--theme', 'Sepia', '--size', 'TABLET'],
        {
          SHUVIX_SESSION_ID: 'sess-1'
        }
      )
      expect(raw.code, raw.stderr).toBe(0)
      expect(requests[0].params).toStrictEqual({ id: 'pv-plain', size: 'TABLET', theme: 'Sepia' })
    })

    it.each([
      ['--size at the end with no value', ['--size']],
      ['--size ""', ['--size', '']],
      ['--size=phone (B9: flags take the space form only)', ['--size=phone']],
      ['--theme at the end with no value', ['--theme']],
      ['--theme ""', ['--theme', '']]
    ])('U-CLI-3 %s → no size / theme key', async (_label, extra) => {
      const r = await cli(['widget', 'preview', 'pv-plain', ...extra], {
        SHUVIX_SESSION_ID: 'sess-1'
      })
      expect(r.code, r.stderr).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0].params).toStrictEqual({ id: 'pv-plain' })
    })

    it('U-CLI-4 no id → one line on stderr, exit 1, ShuviX is not contacted', async () => {
      const r = await cli(['widget', 'preview'], { SHUVIX_SESSION_ID: 'sess-1' })
      expect(r.code).toBe(1)
      expect(r.stderr).toBe('widget preview: <id> is required\n')
      expect(connections).toBe(0)
    })

    it('U-CLI-5 a refusal from main → `Error: …` on stderr, exit 1', async () => {
      reply = { success: false, error: 'unknown size "tablet" (use panel, window, phone)' }
      const r = await cli(['widget', 'preview', 'pv-plain', '--size', 'tablet'], {
        SHUVIX_SESSION_ID: 'sess-1'
      })
      expect(r.code).toBe(1)
      expect(r.stderr).toBe('Error: unknown size "tablet" (use panel, window, phone)\n')
      expect(r.stdout).toBe('')
    })

    it('U-CLI-6 the usage text lists widget preview', async () => {
      const r = await cli(['--help'])
      expect(r.stderr).toContain(
        'shuvix widget preview <id> [--size panel,window,phone] [--theme light|dark]'
      )
      expect(connections).toBe(0)
    })

    it('U-CLI-7 no SHUVIX_SESSION_ID → no sessionId in the request', async () => {
      const r = await cli(['widget', 'preview', 'pv-plain', '--size', 'phone'])
      expect(r.code, r.stderr).toBe(0)
      expect(requests).toHaveLength(1)
      expect('sessionId' in requests[0]).toBe(false)
      expect(requests[0]).toStrictEqual({
        token: TOKEN,
        command: 'widget.preview',
        params: { id: 'pv-plain', size: 'phone' }
      })
    })
  }
)
