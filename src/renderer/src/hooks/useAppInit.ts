import { useEffect } from 'react'
import i18next from 'i18next'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSidebarStore } from '../stores/sidebarStore'
import { useBrowserStore } from '../stores/browserStore'
import { loadPanelLayout, isPinnedScope } from '../stores/panelLayout'
import { useUpdateStore } from '../stores/updateStore'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash.startsWith('#settings')

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

      // 并行加载：通用设置 + 配置元数据 + 插件工具渲染配置
      const [settings, settingMeta, projectFieldMeta, toolPresentations] = await Promise.all([
        window.api.settings.getAll(),
        window.api.settings.getKnownKeys(),
        window.api.project.getKnownFields(),
        window.api.tools.presentations()
      ])
      lap('settings + meta + toolPresentations (parallel)')
      useSettingsStore.getState().loadSettings(settings)
      useSettingsStore.getState().loadConfigMeta(settingMeta, projectFieldMeta)
      useChatStore.getState().setToolPresentations(toolPresentations)
      // 初始化时将全局默认值作为 fallback，useSessionInit 切换会话后会覆盖
      useSettingsStore.getState().setActiveProvider(settings['general.defaultProvider'] || '')
      useSettingsStore.getState().setActiveModel(settings['general.defaultModel'] || '')

      // 同步前端 i18n 语言（优先用户设置，否则保持检测值）
      const savedLang = settings['general.language']
      if (savedLang && savedLang !== i18next.language) {
        i18next.changeLanguage(savedLang)
      }

      // 并行加载：提供商列表 + 可用模型 + 会话列表（仅主窗口）
      const promises: [
        Promise<ProviderInfo[]>,
        Promise<AvailableModel[]>,
        Promise<Session[] | null>
      ] = [
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
        // 加载 WebUI 分享状态
        const sharedList = await window.api.webui.listShared()
        useChatStore
          .getState()
          .setSharedSessionIds(new Map(sharedList.map((s) => [s.sessionId, s.mode])))
        // 从 session settings + bot 列表构建 Telegram 绑定关系
        const telegramBindings = new Map<string, { botId: string; username: string }>()
        const botList = await window.api.telegram.listBots()
        const botMap = new Map(botList.map((b) => [b.id, b.username]))
        for (const s of sessions) {
          if (s.settings?.telegramBotId) {
            telegramBindings.set(s.id, {
              botId: s.settings.telegramBotId,
              username: botMap.get(s.settings.telegramBotId) ?? ''
            })
          }
        }
        useChatStore.getState().setTelegramBindings(telegramBindings)
      }

      // 恢复面板布局（宽度 + 开关状态）
      loadPanelLayout().then((layout) => {
        if (layout.sidebarWidth) useSidebarStore.setState({ width: layout.sidebarWidth })
        if (layout.sidebarOpen === false) useSidebarStore.setState({ isOpen: false })
        if (layout.browserWidth) useBrowserStore.setState({ width: layout.browserWidth })
        // 悬浮窗：右面板默认 'files' tab,没有 browser tab 的运行时依赖问题,可安全恢复 isOpen
        // 主窗口：browser 依赖运行时 server,重启后需用户重新打开,故不自动恢复
        if (isPinnedScope && layout.browserOpen) {
          useBrowserStore.setState({ isOpen: true })
        }
      })

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

  // 注册更新事件监听器，并在设置加载完成后按需自动检查更新（仅主窗口）
  useEffect(() => {
    if (isSettingsWindow) return

    const removeListener = window.api.update.onEvent((event) => {
      useUpdateStore.getState().setUpdateEvent(event)
    })

    // 等待 settingsStore 加载完成后再决定是否自动检查
    const checkIfNeeded = (): void => {
      const { loaded, autoCheckUpdate } = useSettingsStore.getState()
      if (!loaded) {
        // settings 尚未加载，稍后重试
        setTimeout(checkIfNeeded, 200)
        return
      }
      if (autoCheckUpdate) {
        void window.api.update.check()
      }
    }
    checkIfNeeded()

    return removeListener
  }, [])

  // 监听会话配置变更（LAN 分享 / Telegram 绑定 / 工具允许列表等），刷新派生 store
  useEffect(() => {
    if (isSettingsWindow) return
    const unsubscribe = window.api.session.onConfigChanged(async (payload) => {
      // 1. 同步该会话的 settings(allowList / autoApprove 等),保证 SessionConfigPanel 等读 store 的视图能即时刷新
      if (payload?.sessionId) {
        const updated = await window.api.session.getById(payload.sessionId)
        if (updated) {
          useChatStore.getState().updateSessionSettings(payload.sessionId, updated.settings ?? {})
        }
      }
      const [sharedList, botList] = await Promise.all([
        window.api.webui.listShared(),
        window.api.telegram.listBots()
      ])
      useChatStore
        .getState()
        .setSharedSessionIds(new Map(sharedList.map((s) => [s.sessionId, s.mode])))
      const botMap = new Map(botList.map((b) => [b.id, b.username]))
      const telegramBindings = new Map<string, { botId: string; username: string }>()
      for (const s of useChatStore.getState().sessions) {
        const botId = s.settings?.telegramBotId
        if (botId) {
          telegramBindings.set(s.id, { botId, username: botMap.get(botId) ?? '' })
        }
      }
      // 直接通过 bot 的 boundSessionId 反向构建（兼容 store 内 session 尚未同步的情况）
      for (const b of botList) {
        if (b.boundSessionId && !telegramBindings.has(b.boundSessionId)) {
          telegramBindings.set(b.boundSessionId, { botId: b.id, username: b.username ?? '' })
        }
      }
      useChatStore.getState().setTelegramBindings(telegramBindings)
    })
    return unsubscribe
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
      const [allProviders, availableModels, toolPresentations] = await Promise.all([
        window.api.provider.listAll(),
        window.api.provider.listAvailableModels(),
        // 工具渲染配置中的 label 由主进程 i18n 决定，语言切换后需重新拉取
        window.api.tools.presentations()
      ])
      useSettingsStore.getState().setProviders(allProviders)
      useSettingsStore.getState().setAvailableModels(availableModels)
      useChatStore.getState().setToolPresentations(toolPresentations)
    })
    return unsubscribe
  }, [])
}
