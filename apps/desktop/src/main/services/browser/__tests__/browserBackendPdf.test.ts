/**
 * 桌面浏览器后端的 pdf 导出 —— 落盘这一步。
 *
 * 能不能写那个位置，在到这里之前已经由内置 browser server 的写路径门问过了（见
 * builtinMcp/browserServer.ts 与它的接线测试）；纸张与 scale 也由 server 校验过。后端这里
 * 只剩两件事：把路径落成绝对路径并建好上级目录，以及**不再**另设一道「工作区外一律拒绝」——
 * 那会把用户刚在询问卡片上点过允许的写再拒一次（BB-1）。
 *
 * Electron 的面板服务整个换掉：tab 就是一个假的 WebContentsView，printToPDF 回固定字节、
 * 记下收到的选项；写盘是真的，落在临时目录里。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  /** 会话工作目录（真的临时目录） */
  ws: '',
  /** printToPDF 收到的选项 */
  printed: [] as Array<Record<string, unknown>>,
  /** 被激活的 tab（面板跟随 agent 正在操作的页面） */
  activated: [] as string[],
  bytes: Buffer.from('%PDF-1.7 fake')
}))

// mock 路径按**测试文件**解析：被测模块在 services/browser/，测试在其 __tests__/ 下
vi.mock('../browserViewService', () => {
  const view = {
    webContents: {
      isDestroyed: () => false,
      getURL: () => 'https://a.example/',
      printToPDF: async (opts: Record<string, unknown>) => {
        state.printed.push(opts)
        return state.bytes
      }
    }
  }
  return {
    activateTab: (id: string) => void state.activated.push(id),
    closeTab: () => {},
    createTab: () => 'tab-uuid',
    listTabs: () => [],
    getTabView: (id: string) => (id === 'tab-uuid' ? view : null)
  }
})
vi.mock('../browserCdpService', () => ({ browserCdpManager: { session: vi.fn() } }))
vi.mock('../../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: vi.fn() } }))
vi.mock('../../toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: state.ws })
}))
vi.mock('../../../utils/paths', () => ({ getToolResultsDir: () => join(state.ws, '.results') }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { createDesktopBrowserBackend } from '../browserBackend'

let outside = ''

beforeAll(() => {
  state.ws = mkdtempSync(join(tmpdir(), 'shuvix-pdf-ws-'))
  outside = mkdtempSync(join(tmpdir(), 'shuvix-pdf-else-'))
})

afterAll(() => {
  for (const dir of [state.ws, outside]) if (dir) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  state.printed.length = 0
  state.activated.length = 0
})

describe('DesktopBrowserBackend.pdf', () => {
  it('BB-1 工作目录外的绝对路径照写（写门已经问过）：结果是「Page exported to PDF: <绝对路径> (A4)」，没有「outside the session working directory」', async () => {
    const backend = createDesktopBrowserBackend('s1')
    const target = join(outside, 'deep', 'page.pdf')
    const out = await backend.pdf!({ tabId: 'tab-uuid', outputPath: target })

    expect(out).toEqual({ text: `Page exported to PDF: ${target} (A4)` })
    expect(out.details?.error).toBeUndefined()
    expect(readFileSync(target)).toEqual(state.bytes)
    expect(state.activated).toEqual(['tab-uuid'])
  })

  it('BB-2 相对路径按会话工作目录解析，上级目录一路建好', async () => {
    const backend = createDesktopBrowserBackend('s1')
    const out = await backend.pdf!({ tabId: 'tab-uuid', outputPath: 'out/deep/page.pdf' })

    const written = join(state.ws, 'out', 'deep', 'page.pdf')
    expect(out.text).toBe(`Page exported to PDF: ${written} (A4)`)
    expect(existsSync(written)).toBe(true)
    expect(readFileSync(written)).toEqual(state.bytes)
  })

  it('BB-3 server 校验过的纸张 / 横向 / scale 原样交给 printToPDF；结果写明纸张与横向', async () => {
    const backend = createDesktopBrowserBackend('s1')
    const target = join(outside, 'letter.pdf')
    const out = await backend.pdf!({
      tabId: 'tab-uuid',
      outputPath: target,
      pageSize: 'Letter',
      landscape: true,
      scale: 0.5
    })

    expect(out.text).toBe(`Page exported to PDF: ${target} (Letter, landscape)`)
    expect(state.printed).toHaveLength(1)
    expect(state.printed[0]).toMatchObject({ pageSize: 'Letter', landscape: true, scale: 0.5 })
  })

  it('BB-4 没给纸张 → A4、竖向，不带 scale', async () => {
    const backend = createDesktopBrowserBackend('s1')
    await backend.pdf!({ tabId: 'tab-uuid', outputPath: join(outside, 'plain.pdf') })
    expect(state.printed[0]).toMatchObject({ pageSize: 'A4', landscape: false })
    expect('scale' in state.printed[0]).toBe(false)
  })
})
