/**
 * `src/renderer/web.html` 的 CSP（server mode phase D）—— 浏览器里的 web 客户端没有 `shuvix-*` 协议：本地文件、交互图的库、
 * widget 都走这台网络服务自己的 HTTP 路由（`/files/*`、`/lib/*`、`/w/*`），所以图片 / 媒体 / iframe / 脚本都只要 'self'。
 * 与 CP-8 读 index.html 同一个读法（fs 读文本、正则取 meta 的 content）。
 *
 *   WH-1 没有任何 `shuvix-` 源，没有 'unsafe-eval'
 *   WH-2 script-src / img-src / media-src / frame-src 都含 'self'；frame-src 不再列 `http://127.0.0.1:*`（widget 改走转发）
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `apps/desktop/src/renderer/src/web/__tests__` → `apps/desktop/src/renderer` */
const RENDERER_DIR = resolve(HERE, '../../..')

function webCsp(): Map<string, string[]> {
  const html = readFileSync(join(RENDERER_DIR, 'web.html'), 'utf8')
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1]
  expect(csp, 'web.html 里找不到 meta CSP').toBeTruthy()
  return new Map(
    csp!
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...tokens] = part.split(/\s+/)
        return [name, tokens] as const
      })
  )
}

describe('web.html 的 CSP', () => {
  it("WH-1 没有 shuvix- 源，没有 'unsafe-eval'", () => {
    const directives = webCsp()
    expect(directives.size).toBeGreaterThan(5)
    for (const [name, tokens] of directives) {
      for (const token of tokens) expect(token, name).not.toContain('shuvix-')
      expect(tokens, name).not.toContain("'unsafe-eval'")
    }
  })

  it("WH-2 script / img / media / frame 都含 'self'；frame-src 不再列 127.0.0.1", () => {
    const directives = webCsp()
    for (const name of ['script-src', 'img-src', 'media-src', 'frame-src']) {
      expect(directives.get(name), name).toContain("'self'")
    }
    const frame = directives.get('frame-src') ?? []
    expect(frame).not.toContain('http://127.0.0.1:*')
    expect(frame.some((token) => token.includes('127.0.0.1'))).toBe(false)
  })
})
