import { useEffect } from 'react'
import i18next from 'i18next'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash === '#settings'

/**
 * 应用级初始化 Hook
 * 加载设置、提供商、模型、会话列表，完成后通知主进程显示窗口
 */
export function useAppInit(): void {
  useEffect(() => {
    const init = async (): Promise<void> => {
      const t0 = performance.now()
      const lap = (label: string): void => {
        console.log(`[Perf] ${label} — ${(performance.now() - t0).toFixed(0)}ms`)
      }

      // 并行加载：通用设置 + 配置元数据
      const [settings, settingMeta, projectFieldMeta] = await Promise.all([
        window.api.settings.getAll(),
        window.api.settings.getKnownKeys(),
        window.api.project.getKnownFields()
      ])
      lap('settings + meta (parallel)')
      useSettingsStore.getState().loadSettings(settings)
      useSettingsStore.getState().loadConfigMeta(settingMeta, projectFieldMeta)

      // 同步前端 i18n 语言（优先用户设置，否则保持检测值）
      const savedLang = settings['general.language']
      if (savedLang && savedLang !== i18next.language) {
        i18next.changeLanguage(savedLang)
      }

      // 并行加载：提供商列表 + 可用模型 + 会话列表（仅主窗口）
      const promises: [Promise<ProviderInfo[]>, Promise<AvailableModel[]>, Promise<Session[] | null>] = [
        window.api.provider.listAll(),
        window.api.provider.listAvailableModels(),
        !isSettingsWindow ? window.api.session.list() : Promise.resolve(null)
      ]
      const [allProviders, availableModels, sessions] = await Promise.all(promises)
      lap('providers + models + sessions (parallel)')

      useSettingsStore.getState().setProviders(allProviders)
      useSettingsStore.getState().setAvailableModels(availableModels)
      if (sessions) {
        useChatStore.getState().setSessions(sessions)
      }

      // 数据就绪后等待浏览器完成绘制，再通知主进程显示窗口
      lap('renderer init done, waiting for paint')
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          lap('windowReady (after paint)')
          window.api.app.windowReady()
        })
      })
    }
    init()
  }, [])

  // 监听设置变更，实时刷新主题/字体等（仅主窗口）
  useEffect(() => {
    if (isSettingsWindow) return
    const unsubscribe = window.api.app.onSettingsChanged(async () => {
      const settings = await window.api.settings.getAll()
      useSettingsStore.getState().loadSettings(settings)
      // 同步前端 i18n 语言
      const savedLang = settings['general.language']
      if (savedLang && savedLang !== i18next.language) {
        i18next.changeLanguage(savedLang)
      }
      const [allProviders, availableModels] = await Promise.all([
        window.api.provider.listAll(),
        window.api.provider.listAvailableModels()
      ])
      useSettingsStore.getState().setProviders(allProviders)
      useSettingsStore.getState().setAvailableModels(availableModels)
    })
    return unsubscribe
  }, [])
}
