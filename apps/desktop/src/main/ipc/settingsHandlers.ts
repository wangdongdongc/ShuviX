import { ipcMain, BrowserWindow, nativeTheme } from 'electron'
import { settingsService, KNOWN_SETTINGS } from '../services/settingsService'
import { changeLanguage } from '../i18n'
import type { SettingsSetParams } from '../types'
import {
  listBuiltinSections,
  setBuiltinDisabled,
  getCustomSections,
  setCustomSections,
  previewBuiltinSection
} from '../services/systemPrompt/systemPromptService'
import {
  isBuiltinSectionId,
  type BuiltinSectionId,
  type BuiltinRenderCtx
} from '../services/systemPrompt/builtinSections'
import { sessionDao } from '../dao/sessionDao'
import { projectDao } from '../dao/projectDao'
import type { ProjectPromptSection } from '@shuvix/chat-protocol/types/promptSection'

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
      const zoom = Math.max(0.5, Math.min(2.2, Number(params.value) / 100 || 1))
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.setZoomFactor(zoom)
      })
    }
    // settings.changed 由 settingsService.set 在数据层发布（覆盖所有调用方），此处不再重复广播
    return { success: true }
  })

  /** 列出全部内置系统提示词卡片（含 disable 状态 + i18n 当前语言下的 title/content） */
  ipcMain.handle('settings:listBuiltinSections', () => {
    return listBuiltinSections()
  })

  /** 写入被禁用的内置卡片 id 列表 */
  ipcMain.handle('settings:setBuiltinDisabled', (_event, ids: string[]) => {
    const filtered = (Array.isArray(ids) ? ids : []).filter(
      isBuiltinSectionId
    ) as BuiltinSectionId[]
    setBuiltinDisabled(filtered)
    return { success: true }
  })

  /** 读取用户自定义系统提示词卡片 */
  ipcMain.handle('settings:getCustomSections', () => {
    return getCustomSections()
  })

  /** 写入用户自定义系统提示词卡片 */
  ipcMain.handle(
    'settings:setCustomSections',
    (_event, sections: ProjectPromptSection[] | undefined) => {
      setCustomSections(Array.isArray(sections) ? sections : [])
      return { success: true }
    }
  )

  /**
   * 预览内置卡片的实际内容（主要给 environment 卡片用）
   * 可选传入 sessionId 以获得带项目/模型上下文的预览，否则使用启动级默认
   */
  ipcMain.handle(
    'settings:previewBuiltinSection',
    (_event, params: { id: string; sessionId?: string }) => {
      if (!params?.id || !isBuiltinSectionId(params.id)) return ''
      // environment 卡片仅需工作目录（检测 git）；可选传 sessionId 取其项目路径
      const ctx: BuiltinRenderCtx = {}
      if (params.sessionId) {
        const session = sessionDao.pick(params.sessionId, ['projectId'])
        if (session?.projectId) {
          const project = projectDao.pick(session.projectId, ['path'])
          if (project) ctx.workingDirectory = project.path
        }
      }
      return previewBuiltinSection(params.id, ctx)
    }
  )
}
