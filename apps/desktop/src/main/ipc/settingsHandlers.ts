import { ipcMain, BrowserWindow, nativeTheme } from 'electron'
import { settingsService, KNOWN_SETTINGS } from '../services/settingsService'
import { changeLanguage } from '../i18n'
import { refreshBuiltinKnowledge } from '../services/knowledge'
import { syncKnowledgeBuiltinProject } from '../services/knowledgeNotes'
import { syncSkillBuiltinProject } from '../services/skillNotes'
import { appEventBus } from '../utils/appEventBus'
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
      // 内置知识库按界面语言选目录：失效它的扫描 / 检索缓存、把承载项目指向新语言那一版、让侧栏重扫
      refreshBuiltinKnowledge()
      syncKnowledgeBuiltinProject()
      // 内置档案按界面语言选**文件**（`work.zh.md`）：目录不变、没有缓存要失效，但侧栏那一组
      // 把显示名直接摆在屏幕上，而它只在展开 / 窗口聚焦 / agent.changed 时重扫 —— 语言就是在
      // 另一个窗口切的，回主窗前那批行还挂着上一种语言的名字
      appEventBus.publish({ type: 'agent.changed' })
      // 内置技能同样按语言分目录：承载项目改指新语言那一版，侧栏那一组重扫（行标签取自 SKILL.md）
      syncSkillBuiltinProject()
      appEventBus.publish({ type: 'skill.changed' })
    }
    // 主题变更时同步 nativeTheme（让 widget 等 webContents 的 prefers-color-scheme 跟随）
    if (params.key === 'general.theme') {
      applyNativeThemeSource(params.value)
    }
    // UI 缩放变更时立即应用到所有窗口
    if (params.key === 'general.uiZoom') {
      const zoom = Math.max(0.5, Math.min(2.2, Number(params.value) / 100 || 1))
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.setZoomFactor(zoom)
      })
    }
    // settings.changed 由 settingsService.set 在数据层发布（覆盖所有调用方），此处不再重复广播
    return { success: true }
  })
}
