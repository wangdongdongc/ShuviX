/**
 * cliServer `widget.preview` —— `shuvix widget preview <id> [--size …] [--theme …]` 在主进程那一头：先判尺寸与主题
 * （认不得就拒绝、不开始预览），再把整理好的选项与请求带来的会话 id 交给 previewWidget，结果原样回。
 *
 * handler 从私有的 `handlers` 表里取（构造时注册，不用 start 起 socket）。parsePreviewSizes / parsePreviewTheme 是真的
 * （vi.importActual），previewWidget 是回一个哨兵的 spy；其余依赖给空壳（与 cliServerWidgetBuild.test.ts 同一套）。
 *
 *   U-CS-1 只有 id → 全部尺寸、theme undefined、会话 id 原样；handler 回的就是 previewWidget 的结果
 *   U-CS-2 `Phone,panel` + `DARK` → ['panel','phone'] + 'dark'
 *   U-CS-3 认不得的尺寸 → 拒绝，不预览
 *   U-CS-4 认不得的主题 → 拒绝，不预览
 *   U-CS-5 没有 id / 空 id → id required
 *   U-CS-6 没有会话 id → sessionId: undefined
 *   U-CS-7 (B5) 不安全的会话 id 原样交给 previewWidget（它在开始之前拒绝：invalid session id），拒绝原样传回
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  previewWidget: vi.fn()
}))

vi.mock('../widgetPreviewService', async () => {
  const real =
    await vi.importActual<typeof import('../widgetPreviewService')>('../widgetPreviewService')
  return {
    parsePreviewSizes: real.parsePreviewSizes,
    parsePreviewTheme: real.parsePreviewTheme,
    previewWidget: mocks.previewWidget
  }
})
// 其余依赖本文件一个都不碰：给空壳
vi.mock('electron', () => ({}))
vi.mock('../widget', () => ({
  widgetService: {},
  widgetServer: {},
  exportWidget: vi.fn(),
  resolveExportZipPath: vi.fn(),
  WidgetExportError: class WidgetExportError extends Error {},
  runWidgetDbQuery: vi.fn()
}))
vi.mock('../widgetWindowService', () => ({ open: vi.fn() }))
vi.mock('../acl', () => ({ sessionAcl: { grantPath: vi.fn() } }))
vi.mock('../toolContext', () => ({ getDesktopSecurityContext: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { cliServer } from '../cliServer'

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => Promise<unknown>

const previewHandler = (): Handler => {
  const handler = (cliServer as unknown as { handlers: Map<string, Handler> }).handlers.get(
    'widget.preview'
  )
  if (!handler) throw new Error('widget.preview handler is not registered')
  return handler
}

const SENTINEL = { sentinel: true }

beforeEach(() => {
  mocks.previewWidget.mockReset()
  mocks.previewWidget.mockResolvedValue(SENTINEL)
})

describe('widget.preview', () => {
  it('U-CS-1 id only → all sizes, no theme, the session id; the result comes back unchanged', async () => {
    const out = await previewHandler()({ id: 'pv-plain' }, 'sess-1')
    expect(out).toBe(SENTINEL)
    expect(mocks.previewWidget.mock.calls).toStrictEqual([
      ['pv-plain', { sizes: ['panel', 'window', 'phone'], theme: undefined, sessionId: 'sess-1' }]
    ])
  })

  it('U-CS-2 size and theme are parsed (case, order, dedupe)', async () => {
    await previewHandler()({ id: 'pv-plain', size: 'Phone,panel', theme: 'DARK' }, 'sess-1')
    expect(mocks.previewWidget.mock.calls).toStrictEqual([
      ['pv-plain', { sizes: ['panel', 'phone'], theme: 'dark', sessionId: 'sess-1' }]
    ])
  })

  it('U-CS-3 an unknown size rejects before any preview', async () => {
    await expect(previewHandler()({ id: 'pv-plain', size: 'tablet' }, 'sess-1')).rejects.toThrow(
      /unknown size "tablet" \(use panel, window, phone\)/
    )
    expect(mocks.previewWidget).not.toHaveBeenCalled()
  })

  it('U-CS-4 an unknown theme rejects before any preview', async () => {
    await expect(previewHandler()({ id: 'pv-plain', theme: 'sepia' }, 'sess-1')).rejects.toThrow(
      /unknown theme "sepia" \(use light or dark\)/
    )
    expect(mocks.previewWidget).not.toHaveBeenCalled()
  })

  it.each([{}, { id: '' }])('U-CS-5 %j → id required', async (params) => {
    await expect(previewHandler()(params, 'sess-1')).rejects.toThrow('id required')
    expect(mocks.previewWidget).not.toHaveBeenCalled()
  })

  it('U-CS-6 no session id → sessionId: undefined', async () => {
    await previewHandler()({ id: 'pv-plain', size: 'phone' }, undefined)
    expect(mocks.previewWidget.mock.calls).toStrictEqual([
      ['pv-plain', { sizes: ['phone'], theme: undefined, sessionId: undefined }]
    ])
  })

  it('U-CS-7 (B5) an unsafe session id is passed through; the service’s refusal comes back', async () => {
    mocks.previewWidget.mockRejectedValueOnce(new Error('invalid session id'))
    await expect(previewHandler()({ id: 'pv-plain' }, '../../x')).rejects.toThrow(
      'invalid session id'
    )
    expect(mocks.previewWidget.mock.calls).toStrictEqual([
      ['pv-plain', { sizes: ['panel', 'window', 'phone'], theme: undefined, sessionId: '../../x' }]
    ])
  })
})
