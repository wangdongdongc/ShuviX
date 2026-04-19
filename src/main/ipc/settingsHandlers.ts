import { ipcMain, BrowserWindow, nativeTheme } from 'electron'
import { settingsService, KNOWN_SETTINGS } from '../services/settingsService'
import { changeLanguage } from '../i18n'
import type { SettingsSetParams } from '../types'

/**
 * 同步 ShuviX 主题选择到 Electron nativeTheme.themeSource
 * 影响所有 webContents（含 widget WebContentsView）的 prefers-color-scheme，
 * 让 widget 在用户显式选 light/dark 时也能跟随，而不仅是跟随 OS
 */
export function applyNativeThemeSource(mode: string | null | undefined): void {
  if (mode === 'light' || mode === 'dark') {
    nativeTheme.themeSource = mode
  } else {
    nativeTheme.themeSource = 'system'
  }
}

/**
 * 设置管理 IPC 处理器
 * 负责参数解析，委托给 SettingsService
 */
export function registerSettingsHandlers(): void {
  /** 获取所有设置 */
  ipcMain.handle('settings:getAll', () => {
    return settingsService.getAll()
  })

  /** 获取单个设置 */
  ipcMain.handle('settings:get', (_event, key: string) => {
    return settingsService.get(key)
  })

  /** 获取已知设置 key 的元数据（labelKey + desc） */
  ipcMain.handle('settings:getKnownKeys', () => {
    return KNOWN_SETTINGS
  })

  /** 保存设置，并广播通知所有窗口刷新 */
  ipcMain.handle('settings:set', (_event, params: SettingsSetParams) => {
    settingsService.set(params.key, params.value)
    // 语言变更时同步更新主进程 i18n
    if (params.key === 'general.language') {
      changeLanguage(params.value)
    }
    // 主题变更时同步 nativeTheme（让 widget 等 webContents 的 prefers-color-scheme 跟随）
    if (params.key === 'general.theme') {
      applyNativeThemeSource(params.value)
    }
    // UI 缩放变更时立即应用到所有窗口
    if (params.key === 'general.uiZoom') {
      const zoom = Math.max(0.5, Math.min(2.2, (Number(params.value) / 100 || 1) * 1.1))
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.setZoomFactor(zoom)
      })
    }
    // 通知所有窗口设置已变更（主窗口监听后会刷新主题/字体等）
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('app:settings-changed')
    })
    return { success: true }
  })
}
