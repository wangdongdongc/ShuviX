/**
 * 网络访问的 IPC 与「要窗口」的导出落点（server mode phase B）：经注册表的定义直接以窗口 / 网络上下文调用
 * （`listDefinitions()`），服务一律替身。
 *
 *   NH-10 `widget:pickExportTarget({id})` 从网络来 → `{ success: false, reason: 'unavailable' }`；不弹保存框、不读 downloads 路径、
 *         不查窗口
 *   NH-11 `registerNetworkHandlers()`：network:status 原样交回 networkService.status() 的值（同一引用）；setEnabled / setPort
 *         把参数交给服务、原样交回它 resolve 的值；setPort 的拒绝原样拒绝；窗口与网络两种上下文表现一样
 *   NH-11b 局域网开关与「开放给」两条通道（2026-10-19 去掉，谁能连由安全策略定）不再注册
 *
 * `widget:exportForDownload`（server mode phase D：web 客户端没有保存框，导出到 userData 下的临时目录再经 `/files/download`
 * 下载）。userData 是临时目录；exportWidget 与 widgetService.getById 是替身，WidgetExportError 是带 code 的同形类。
 *
 *   WE-1 网络上下文：先认 widget，再在 `<userData>/widget-exports/export-XXXXXX/` 新建的空目录里导出 `<widget.id>.zip`
 *        （overwrite:false）；回包恰是 {success:true, zipPath, entryCount}（没有 byteSize）；不弹框、不碰 shell、不查窗口
 *   WE-2 两次导出 → 两个不同的目录
 *   WE-3 WidgetExportError → {success:false, code, error}；普通 Error / 抛字符串 → UNKNOWN；不认得 / 不是字符串 / 缺的 id
 *        （含参数是 undefined）→ WIDGET_NOT_FOUND，不建临时目录、不调 exportWidget
 *   WE-4 导出前清掉一小时以前的（目录与文件）；十分钟前的留着；清理失败不影响这次导出
 *   WE-5 widget-exports 不在 → 先建出来（认得的 widget）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ClientContext } from '../registry'

const state = vi.hoisted(() => {
  class WidgetExportError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
      this.name = 'WidgetExportError'
    }
  }
  /** userData 指向哪里（每条用例一个临时目录） */
  const paths = { userData: '' }
  return {
    paths,
    WidgetExportError,
    exportWidget: vi.fn(),
    getById: vi.fn(),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/picked.zip' })),
    getPath: vi.fn((name: string) => (name === 'userData' ? paths.userData : '/Users/x/Downloads')),
    showItemInFolder: vi.fn(),
    fromWebContents: vi.fn(() => null),
    fromId: vi.fn(() => undefined),
    status: vi.fn(),
    setEnabled: vi.fn(),
    setPort: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showSaveDialog: state.showSaveDialog },
  app: { getPath: state.getPath },
  shell: { showItemInFolder: state.showItemInFolder },
  BrowserWindow: { getAllWindows: vi.fn(() => []), fromWebContents: state.fromWebContents },
  webContents: { fromId: state.fromId }
}))
vi.mock('../../services/widget', () => ({
  widgetService: { getById: (...args: unknown[]): unknown => state.getById(...args) },
  widgetServer: {},
  exportWidget: (...args: unknown[]): unknown => state.exportWidget(...args),
  resolveExportZipPath: vi.fn(),
  WidgetExportError: state.WidgetExportError
}))
// 列表补项目名（widgetHandlers 的 withProjectTags）：真的项目服务要数据库
vi.mock('../../services/projectService', () => ({ projectService: { getById: vi.fn() } }))
vi.mock('../../services/widgetWindowService', () => ({}))
vi.mock('../../frontend/network', () => ({
  networkService: {
    status: state.status,
    setEnabled: state.setEnabled,
    setPort: state.setPort
  }
}))

import { listDefinitions } from '../registry'
import { registerWidgetHandlers } from '../widgetHandlers'
import { registerNetworkHandlers } from '../networkHandlers'

registerWidgetHandlers()
registerNetworkHandlers()

const netCtx: ClientContext = {
  client: { kind: 'network', id: 'ws:1', remoteAddress: '192.168.1.20', userAgent: 'UA/1' },
  transport: 'network'
}
const winCtx: ClientContext = {
  client: { kind: 'window', id: 'ipc:7', webContentsId: 7 },
  transport: 'ipc'
}

function call(ctx: ClientContext, channel: string, ...args: unknown[]): unknown {
  const definition = listDefinitions().find((d) => d.channel === channel)
  if (!definition) throw new Error(`no definition for ${channel}`)
  return definition.fn(ctx, ...args)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('NH-10 widget:pickExportTarget 从网络来', () => {
  it("NH-10 → { success: false, reason: 'unavailable' }；不弹保存框、不读路径、不查窗口", async () => {
    await expect(
      Promise.resolve(call(netCtx, 'widget:pickExportTarget', { id: 'w' }))
    ).resolves.toEqual({
      success: false,
      reason: 'unavailable'
    })
    expect(state.showSaveDialog).not.toHaveBeenCalled()
    expect(state.getPath).not.toHaveBeenCalled()
    expect(state.fromWebContents).not.toHaveBeenCalled()
    expect(state.fromId).not.toHaveBeenCalled()
  })
})

describe('NH-11 registerNetworkHandlers', () => {
  it.each([
    ['window', winCtx],
    ['network', netCtx]
  ])('NH-11 %s 上下文：status / setEnabled / setPort 交给服务、原样交回', async (_name, ctx) => {
    const status = { enabled: true, port: 7766, listening: true, addresses: [], clients: [] }
    state.status.mockReturnValue(status)
    expect(call(ctx, 'network:status')).toBe(status)
    expect(state.status).toHaveBeenCalledTimes(1)

    const enabled = { ...status, enabled: false }
    state.setEnabled.mockResolvedValue(enabled)
    await expect(call(ctx, 'network:setEnabled', true)).resolves.toBe(enabled)
    expect(state.setEnabled).toHaveBeenCalledWith(true)

    const ported = { ...status, port: 8080 }
    state.setPort.mockResolvedValue(ported)
    await expect(call(ctx, 'network:setPort', 8080)).resolves.toBe(ported)
    expect(state.setPort).toHaveBeenCalledWith(8080)
  })

  it.each([
    ['window', winCtx],
    ['network', netCtx]
  ])('NH-11 %s 上下文：setPort 的拒绝原样拒绝', async (_name, ctx) => {
    const error = new Error('The port must be an integer between 1024 and 65535.')
    state.setPort.mockRejectedValue(error)
    await expect(call(ctx, 'network:setPort', 80)).rejects.toBe(error)
  })
})

describe('NH-11b 局域网开关的两条通道不再注册', () => {
  it('NH-11b network:setLan / network:setLanInterface 没有定义', () => {
    const channels = listDefinitions().map((d) => d.channel)
    expect(channels).toContain('network:setPort')
    expect(channels).not.toContain('network:setLan')
    expect(channels).not.toContain('network:setLanInterface')
  })
})

// ─── widget:exportForDownload（WE-1…5） ───────────────────────────────────

const WIDGET = { id: 'demo-widget', name: 'Demo widget' }
const canRestrictWrites = process.platform !== 'win32' && process.getuid?.() !== 0

let userData: string
/** 每次 exportWidget 被调时，目标所在目录的状态 */
let seenDirs: Array<{ dir: string; existed: boolean; entries: string[] }>

const exportsRoot = (): string => join(userData, 'widget-exports')

type ExportResult =
  | { success: true; zipPath: string; entryCount: number }
  | { success: false; code: string; error: string }

const exportForDownload = (ctx: ClientContext, params: unknown): Promise<ExportResult> =>
  Promise.resolve(call(ctx, 'widget:exportForDownload', params)) as Promise<ExportResult>

describe('widget:exportForDownload', () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'shuvix-export-dl-'))
    state.paths.userData = userData
    seenDirs = []
    state.getById.mockReset()
    state.getById.mockImplementation((id: string) => (id === WIDGET.id ? WIDGET : undefined))
    state.exportWidget.mockReset()
    state.exportWidget.mockImplementation(async (params: { targetPath: string }) => {
      const dir = dirname(params.targetPath)
      seenDirs.push({
        dir,
        existed: existsSync(dir),
        entries: existsSync(dir) ? readdirSync(dir) : []
      })
      writeFileSync(params.targetPath, 'PK')
      return { zipPath: params.targetPath, entryCount: 7, byteSize: 1234 }
    })
  })

  afterEach(() => {
    try {
      chmodSync(join(exportsRoot(), 'locked-old'), 0o755)
    } catch {
      /* 没建过 */
    }
    rmSync(userData, { recursive: true, force: true })
  })

  it('WE-1 网络上下文：新建的空目录里导出 <widget.id>.zip；回包恰三项；不弹框、不碰 shell、不查窗口', async () => {
    const result = await exportForDownload(netCtx, { id: 'demo-widget' })

    expect(state.getById).toHaveBeenCalledWith('demo-widget')
    expect(state.exportWidget).toHaveBeenCalledTimes(1)
    const [params] = state.exportWidget.mock.calls[0] as [
      { id: string; targetPath: string; overwrite: boolean }
    ]
    expect(Object.keys(params).sort()).toStrictEqual(['id', 'overwrite', 'targetPath'])
    expect(params.id).toBe('demo-widget')
    expect(params.overwrite).toBe(false)
    expect(basename(params.targetPath)).toBe('demo-widget.zip')
    const dir = dirname(params.targetPath)
    expect(dirname(dir)).toBe(exportsRoot())
    expect(basename(dir)).toMatch(/^export-[A-Za-z0-9]{6}$/)
    expect(seenDirs).toStrictEqual([{ dir, existed: true, entries: [] }])

    expect(result).toStrictEqual({ success: true, zipPath: params.targetPath, entryCount: 7 })
    expect(state.showSaveDialog).not.toHaveBeenCalled()
    expect(state.showItemInFolder).not.toHaveBeenCalled()
    expect(state.fromWebContents).not.toHaveBeenCalled()
    expect(state.fromId).not.toHaveBeenCalled()
  })

  it('WE-1 文件名与 id 取自认出来的 widget（widget.id），不是请求里的原样', async () => {
    state.getById.mockImplementation((id: string) =>
      id === 'alias' ? { id: 'real-id', name: 'Real' } : undefined
    )
    const result = await exportForDownload(netCtx, { id: 'alias' })
    expect(result.success).toBe(true)
    const [params] = state.exportWidget.mock.calls[0] as [{ id: string; targetPath: string }]
    expect(params.id).toBe('real-id')
    expect(basename(params.targetPath)).toBe('real-id.zip')
  })

  it('WE-2 两次导出 → 两个不同的目录', async () => {
    const first = await exportForDownload(netCtx, { id: 'demo-widget' })
    const second = await exportForDownload(netCtx, { id: 'demo-widget' })
    expect(first.success && second.success).toBe(true)
    if (!first.success || !second.success) return
    expect(dirname(first.zipPath)).not.toBe(dirname(second.zipPath))
    expect(existsSync(first.zipPath)).toBe(true)
    expect(existsSync(second.zipPath)).toBe(true)
    expect(readdirSync(exportsRoot()).sort()).toStrictEqual(
      [basename(dirname(first.zipPath)), basename(dirname(second.zipPath))].sort()
    )
  })

  it('WE-3 WidgetExportError → {success:false, code, error}', async () => {
    state.exportWidget.mockRejectedValueOnce(
      new state.WidgetExportError('PACK_FAILED', 'Could not pack the widget.')
    )
    await expect(exportForDownload(netCtx, { id: 'demo-widget' })).resolves.toStrictEqual({
      success: false,
      code: 'PACK_FAILED',
      error: 'Could not pack the widget.'
    })
  })

  it('WE-3 普通 Error / 抛字符串 → UNKNOWN', async () => {
    state.exportWidget.mockRejectedValueOnce(new Error('disk full'))
    await expect(exportForDownload(netCtx, { id: 'demo-widget' })).resolves.toStrictEqual({
      success: false,
      code: 'UNKNOWN',
      error: 'disk full'
    })
    state.exportWidget.mockRejectedValueOnce('weird failure')
    await expect(exportForDownload(netCtx, { id: 'demo-widget' })).resolves.toStrictEqual({
      success: false,
      code: 'UNKNOWN',
      error: 'weird failure'
    })
  })

  it('WE-3 不认得 / 不是字符串 / 缺的 id（含参数 undefined）→ WIDGET_NOT_FOUND，不建临时目录、不导出', async () => {
    for (const params of [{ id: 'nope' }, { id: 5 }, { id: '' }, {}, undefined, null]) {
      const result = await exportForDownload(netCtx, params)
      expect(result.success, JSON.stringify(params)).toBe(false)
      if (result.success) continue
      expect(result.code, JSON.stringify(params)).toBe('WIDGET_NOT_FOUND')
      expect(typeof result.error).toBe('string')
      expect(result.error.length).toBeGreaterThan(0)
    }
    expect(state.exportWidget).not.toHaveBeenCalled()
    // 连 widget-exports 都没建（更没有 export-XXXXXX）
    expect(existsSync(exportsRoot())).toBe(false)
  })

  it('WE-4 一小时以前的目录与文件清掉；十分钟前的留着', async () => {
    const now = Date.now() / 1000
    mkdirSync(join(exportsRoot(), 'old-dir'), { recursive: true })
    writeFileSync(join(exportsRoot(), 'old-dir', 'old.zip'), 'PK')
    writeFileSync(join(exportsRoot(), 'old-file'), 'x')
    mkdirSync(join(exportsRoot(), 'fresh-dir'))
    utimesSync(join(exportsRoot(), 'old-dir'), now - 7200, now - 7200)
    utimesSync(join(exportsRoot(), 'old-file'), now - 7200, now - 7200)
    utimesSync(join(exportsRoot(), 'fresh-dir'), now - 600, now - 600)

    const result = await exportForDownload(netCtx, { id: 'demo-widget' })
    expect(result.success).toBe(true)
    expect(existsSync(join(exportsRoot(), 'old-dir'))).toBe(false)
    expect(existsSync(join(exportsRoot(), 'old-file'))).toBe(false)
    expect(existsSync(join(exportsRoot(), 'fresh-dir'))).toBe(true)
  })

  it('WE-4 清理失败（读不出 mtime 的悬空链接、删不掉的旧目录）不影响这次导出', async () => {
    mkdirSync(exportsRoot(), { recursive: true })
    symlinkSync(join(userData, 'nowhere'), join(exportsRoot(), 'dangling'))
    const now = Date.now() / 1000
    if (canRestrictWrites) {
      mkdirSync(join(exportsRoot(), 'locked-old'))
      writeFileSync(join(exportsRoot(), 'locked-old', 'old.zip'), 'PK')
      utimesSync(join(exportsRoot(), 'locked-old'), now - 7200, now - 7200)
      chmodSync(join(exportsRoot(), 'locked-old'), 0o555)
    }

    const result = await exportForDownload(netCtx, { id: 'demo-widget' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(existsSync(result.zipPath)).toBe(true)
    if (canRestrictWrites)
      expect(statSync(join(exportsRoot(), 'locked-old')).isDirectory()).toBe(true)
  })

  it('WE-5 widget-exports 不在 → 先建出来', async () => {
    expect(existsSync(exportsRoot())).toBe(false)
    const result = await exportForDownload(netCtx, { id: 'demo-widget' })
    expect(result.success).toBe(true)
    expect(statSync(exportsRoot()).isDirectory()).toBe(true)
  })
})
