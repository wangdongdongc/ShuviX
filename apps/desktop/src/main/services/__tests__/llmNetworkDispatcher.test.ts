/**
 * llmNetwork 的**真 undici + 真本地 http 服务端**那半边。
 *
 * llmNetwork.test.ts 把 undici mock 掉，断言的是「传给 Agent 构造函数的参数」——
 * 那套永远跑得绿，哪怕整个机制在这个 Node 上压根不生效。这个文件补的正是那个缺口：
 *
 *  - `dispatcher` **不是标准 RequestInit 字段**，是 undici 认的扩展。整个特性
 *    （放宽 headersTimeout / bodyTimeout）建立在「这个 Node/Electron 的内置 fetch
 *    会读 init.dispatcher」这条运行时假设上 —— 假设一旦不成立，超时还是默认 300s，
 *    而所有 mock 单测依然全绿。故第一条用例是**假设探针**，不是在测我们自己的代码。
 *  - 成因链要真的能从 undici 的错误里摊出可搜索的 token（`UND_ERR_SOCKET` /
 *    `ECONNRESET`），而不是只剩一句含糊的 `TypeError: fetch failed`。
 *
 * 注意：undici 的计时轮精度约 1s，所以超时类用例只断言「最终按超时失败」，
 * 不断言耗时；15 分钟那个数字由 llmNetwork.test.ts 在构造参数上钉死。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Agent } from 'undici'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

type LlmNetworkModule = typeof import('../llmNetwork')

const servers: http.Server[] = []
let realFetch: typeof globalThis.fetch | undefined

/** 起一个只对这条用例负责的本地服务端，返回它的 URL */
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}/`
}

/** 装一层干净的包装（模块级有 installed 幂等位 + 懒建单例，必须逐用例重来） */
async function install(): Promise<LlmNetworkModule> {
  vi.resetModules()
  realFetch ??= globalThis.fetch
  const mod = await import('../llmNetwork')
  mod.installLlmNetwork()
  return mod
}

function chainOf(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  while (cur instanceof Error && parts.length < 5) {
    const code = (cur as NodeJS.ErrnoException).code
    parts.push(`${cur.name}: ${cur.message}${code ? ` (${code})` : ''}`)
    cur = cur.cause
  }
  return parts.join(' <- ')
}

afterEach(async () => {
  if (realFetch) globalThis.fetch = realFetch
  realFetch = undefined
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

describe('llmNetwork —— 运行时假设探针（真 undici）', () => {
  it('内置 fetch 确实认 init.dispatcher：换上 200ms 的 Agent 后，压着响应头不发的服务端会按 UND_ERR_HEADERS_TIMEOUT 失败', async () => {
    // 这条不是在测我们的代码，而是在钉「整个特性赖以成立的那条假设」。
    // 它一旦变红，说明换 dispatcher 这条路在当前 Node/Electron 上已经没用了 ——
    // 超时依旧是默认 300s，而其余全部 mock 单测照样绿。
    const url = await serve(() => {
      /* 收下连接，但永远不发响应头 */
    })

    const caught = await fetch(url, {
      dispatcher: new Agent({ headersTimeout: 200, bodyTimeout: 200 })
    } as RequestInit).then(
      () => undefined,
      (err: unknown) => err
    )

    expect(caught, '换了 200ms 的 dispatcher 却没超时 —— init.dispatcher 被忽略了').toBeDefined()
    expect(chainOf(caught)).toContain('UND_ERR_HEADERS_TIMEOUT')
  }, 15_000)
})

describe('llmNetwork —— 真实失败下的成因可见性', () => {
  it('服务端收下连接后直接掐断 → 作用域里读到的是可搜索的 undici token，而不是一句 fetch failed', async () => {
    // "Connection error." 这种 SDK 固定文案对排障毫无帮助，能搜的词是 UND_ERR_* / ECONNRESET
    const url = await serve((_req, res) => {
      res.socket?.destroy()
    })
    const mod = await install()

    const seen = await mod.llmNetwork.runInRequestScope(async () => {
      const caught = await globalThis.fetch(url).then(
        () => undefined,
        (err: unknown) => err
      )
      return { caught, detail: mod.llmNetwork.describeLastFailure() }
    })

    expect(seen.caught).toBeDefined()
    expect(seen.detail).toBeDefined()
    expect(seen.detail).toMatch(/UND_ERR_SOCKET|ECONNRESET/)
    // 光有这一句等于什么都没说 —— 必须还带着下一环
    expect(seen.detail).not.toBe('TypeError: fetch failed')
  })

  it('服务端压着响应头 300ms 才回 → 正常拿到响应，成因保持 undefined', async () => {
    // 放宽后的 dispatcher 下，几百毫秒的首字节等待属于日常，不该被记成失败。
    // 这里刻意不去观测那 15 分钟本身（等不起），那个数字由构造参数用例钉住。
    const url = await serve((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      }, 300)
    })
    const mod = await install()

    const seen = await mod.llmNetwork.runInRequestScope(async () => {
      const response = await globalThis.fetch(url)
      const body = await response.text()
      return { status: response.status, body, detail: mod.llmNetwork.describeLastFailure() }
    })

    expect(seen.status).toBe(200)
    expect(seen.body).toBe('ok')
    expect(seen.detail).toBeUndefined()
  })
})
