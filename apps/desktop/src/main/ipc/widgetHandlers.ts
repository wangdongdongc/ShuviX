import { dialog, app, shell } from 'electron'
import { defineHandler } from './registry'
import { windowOf } from './ipcAdapter'
import { join, resolve } from 'path'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import {
  widgetService,
  widgetServer,
  exportWidget,
  resolveExportZipPath,
  WidgetExportError
} from '../services/widget'
import * as widgetWindowService from '../services/widgetWindowService'

/**
 * Widget IPC —— 列表、打开、归档、删除、重命名、server 状态、导出 Vite 工程 zip
 * 广播事件 `widget:changed` 由 widgetService 内部在状态变更后发出
 */
export function registerWidgetHandlers(): void {
  defineHandler('widget:list', () => widgetService.listActive())
  defineHandler('widget:listArchived', () => widgetService.listArchived())

  defineHandler('widget:open', async (_ctx, id: string) => {
    try {
      const result = await widgetService.open(id)
      return { success: true, url: result.url, widget: result.widget }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /** 启动单个 widget —— 注册到 server，但不打开浏览器 */
  defineHandler('widget:startWidget', async (_ctx, id: string) => {
    try {
      const result = await widgetService.startWidget(id)
      return { success: true, url: result.url, buildSuccess: result.buildSuccess }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /** 停止单个 widget —— 退出 app 语义：关闭独立窗口 + 从 server 注销 */
  defineHandler('widget:stopWidget', (_ctx, id: string) => {
    widgetWindowService.close(id) // 关窗后 closed 回调也会反注册；下一行兜底"无窗口仅注册"的情况
    widgetService.stopWidget(id)
    return { success: true }
  })

  defineHandler(
    'widget:rename',
    async (_ctx, params: { id: string; name: string; description?: string }) => {
      await widgetService.rename(params.id, params.name, params.description)
      return { success: true }
    }
  )

  defineHandler('widget:setArchived', (_ctx, params: { id: string; archived: boolean }) => {
    widgetService.setArchived(params.id, params.archived)
    return { success: true }
  })

  defineHandler('widget:delete', async (_ctx, id: string) => {
    await widgetService.delete(id)
    return { success: true }
  })

  // ========== 独立窗口（widget app window） ==========

  /** 在独立窗口打开 widget（已开则聚焦）。构建 / URL 获取由窗口内 shell 调 widget:open 完成 */
  defineHandler('widgetWindow:open', (_ctx, id: string) => {
    try {
      widgetWindowService.open(id)
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /**
   * Widget 面板点卡片前问的两件事：此刻开着独立窗口的有哪些（同一个 widget 只开在一处），以及给出的这些
   * widget 里哪些上次是在独立窗口里打开的。浏览器里的 web 客户端不用它：它的「独立窗口」是自己的标签页
   */
  defineHandler('widgetWindow:status', (_ctx, ids: unknown) => {
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    return {
      open: widgetWindowService.openIds(),
      preferWindow: widgetWindowService.preferWindowIds(list)
    }
  })

  /** 用户在面板里选了打开方式（↗ / 菜单）—— 下次点卡片照它来 */
  defineHandler('widgetWindow:setPreferWindow', (_ctx, params: { id: string; value: boolean }) => {
    if (typeof params?.id !== 'string') return { success: false }
    widgetWindowService.setPreferWindow(params.id, params.value === true)
    return { success: true }
  })

  defineHandler('widgetWindow:close', (_ctx, id: string) => {
    widgetWindowService.close(id)
    return { success: true }
  })

  defineHandler('widgetWindow:setAlwaysOnTop', (_ctx, params: { id: string; value: boolean }) => {
    return { alwaysOnTop: widgetWindowService.setAlwaysOnTop(params.id, params.value) }
  })

  defineHandler('widgetWindow:getAlwaysOnTop', (_ctx, id: string) => {
    return { alwaysOnTop: widgetWindowService.getAlwaysOnTop(id) }
  })

  // ========== 服务器状态 ==========

  defineHandler('widget:getServerStatus', () => widgetServer.getStatus())

  defineHandler('widget:stopServer', () => {
    widgetService.stopServer()
    return { success: true }
  })

  // ========== 导出为独立 Vite 工程 zip ==========

  /** 弹出保存对话框选择 zip 落点（仅返回路径，不执行导出） */
  defineHandler(
    'widget:pickExportTarget',
    async (
      ctx,
      params: { id: string }
    ): Promise<{ success: true; path: string } | { success: false; reason: string }> => {
      // 网络客户端（浏览器）：保存框会弹在这台电脑上、而且没有父窗口 —— 这一阶段拒掉（phase D 换成下载）
      if (ctx.client.kind !== 'window') return { success: false, reason: 'unavailable' }
      const win = windowOf(ctx)
      const options = {
        title: 'Export widget',
        defaultPath: join(app.getPath('downloads'), `${params.id}.zip`),
        filters: [{ name: 'Zip archive', extensions: ['zip'] }]
      }
      const result = await (win
        ? dialog.showSaveDialog(win, options)
        : dialog.showSaveDialog(options))
      if (result.canceled || !result.filePath) {
        return { success: false, reason: 'canceled' }
      }
      return { success: true, path: result.filePath }
    }
  )

  /**
   * 在系统文件管理器中定位导出的 zip。
   * 不能复用 app:open-folder —— 那是 shell.openPath，对归档文件等于直接解压/打开。
   */
  defineHandler('widget:revealExport', (_ctx, zipPath: string): { success: true } => {
    shell.showItemInFolder(zipPath)
    return { success: true }
  })

  /**
   * 导出到服务端的临时目录（server mode phase D）—— 浏览器里的 web 客户端没有保存对话框：导出成 zip 放进
   * userData 下 `widget-exports/` 里一个新建的空目录，回它的路径，页面再经网络服务的 `/files/download` 把它下载下来。
   * 每次导出前顺手清掉一小时以前的那些（下载早就完成了）。
   */
  defineHandler(
    'widget:exportForDownload',
    async (
      _ctx,
      params: { id: string }
    ): Promise<
      | { success: true; zipPath: string; entryCount: number }
      | { success: false; code: string; error: string }
    > => {
      try {
        // 先认 widget：不认得就不必建临时目录（导出本身也会报同一个错）
        const id = typeof params?.id === 'string' ? params.id : ''
        const widget = id ? widgetService.getById(id) : undefined
        if (!widget) {
          throw new WidgetExportError('WIDGET_NOT_FOUND', `Widget "${id}" not found.`)
        }
        pruneDownloadExports()
        const dir = mkdtempSync(join(downloadExportsRoot(), 'export-'))
        const result = await exportWidget({
          id: widget.id,
          targetPath: join(dir, `${widget.id}.zip`),
          overwrite: false
        })
        return { success: true, zipPath: result.zipPath, entryCount: result.entryCount }
      } catch (err) {
        if (err instanceof WidgetExportError) {
          return { success: false, code: err.code, error: err.message }
        }
        return {
          success: false,
          code: 'UNKNOWN',
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  /** 执行导出 —— 覆盖确认已由保存对话框完成 */
  defineHandler(
    'widget:exportAsVite',
    async (
      _ctx,
      params: { id: string; targetPath: string }
    ): Promise<
      | { success: true; zipPath: string; entryCount: number }
      | { success: false; code: string; error: string }
    > => {
      try {
        // 只有"最终写入的文件 == 保存对话框询问过的那个文件"时才允许覆盖。
        // 用户在对话框里输了个不带 .zip 的名字时，真正写入的是 <那个名字>/<id>.zip，
        // 对话框从没问过它 —— 这种情况退回不覆盖，让 TARGET_EXISTS 正常报出来。
        const confirmedPath = resolve(params.targetPath)
        const overwrite = resolveExportZipPath(params.id, confirmedPath) === confirmedPath
        const result = await exportWidget({ ...params, overwrite })
        return { success: true, zipPath: result.zipPath, entryCount: result.entryCount }
      } catch (err) {
        if (err instanceof WidgetExportError) {
          return { success: false, code: err.code, error: err.message }
        }
        return {
          success: false,
          code: 'UNKNOWN',
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
}

/** 下载用导出的临时目录的根（`<userData>/widget-exports`；不在就建） */
function downloadExportsRoot(): string {
  const root = join(app.getPath('userData'), 'widget-exports')
  mkdirSync(root, { recursive: true })
  return root
}

/** 下载用导出保留多久 */
const DOWNLOAD_EXPORT_TTL_MS = 60 * 60 * 1000

/** 清掉一小时以前的下载用导出（失败只是留着，不影响这次导出） */
function pruneDownloadExports(now = Date.now()): void {
  const root = downloadExportsRoot()
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(root, name)
    try {
      if (now - statSync(path).mtimeMs > DOWNLOAD_EXPORT_TTL_MS) {
        rmSync(path, { recursive: true, force: true })
      }
    } catch {
      /* 留着 */
    }
  }
}
