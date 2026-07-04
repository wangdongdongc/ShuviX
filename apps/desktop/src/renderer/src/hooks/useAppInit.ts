import { useEffect } from 'react'
import i18next from 'i18next'
import { useChatStore } from '@shuvix/chat-ui'
import { useSettingsStore } from '../stores/settingsStore'
import { usePanelStore, useSidebarStore } from '@shuvix/app-shell'
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
        useChatStore.getState().setSharedSessionIds(new Set(sharedList))
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

      // 恢复面板布局（宽度 + 开关状态）—— 右面板通用三态真源在共享 usePanelStore，故水合它
      loadPanelLayout().then((layout) => {
        if (layout.sidebarWidth) useSidebarStore.setState({ width: layout.sidebarWidth })
        if (layout.sidebarOpen === false) useSidebarStore.setState({ isOpen: false })
        // 桌面默认宽度 480（共享 store 默认 320，宿主无关）；无持久值时回落 480
        usePanelStore.setState({ width: layout.browserWidth ?? 480 })
        // 悬浮窗：右面板默认 'files' tab,没有 browser tab 的运行时依赖问题,可安全恢复 isOpen
        // 主窗口：browser 依赖运行时 server,重启后需用户重新打开,故不自动恢复
        if (isPinnedScope && layout.browserOpen) {
          usePanelStore.setState({ isOpen: true })
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

  // 监听会话配置变更（LAN 分享 / Telegram 绑定 / 工具允许列表等），刷新派生 store —— AppEvent 'session.configChanged'
  useEffect(() => {
    if (isSettingsWindow) return
    return window.api.events.subscribe((event) => {
      if (event.type !== 'session.configChanged') return
      void (async () => {
        // 1. 同步该会话的 settings(allowList / autoApprove 等),保证 SessionConfigPanel 等读 store 的视图能即时刷新
        const updated = await window.api.session.getById(event.sessionId)
        if (updated) {
          useChatStore.getState().updateSessionSettings(event.sessionId, updated.settings ?? {})
        }
        const [sharedList, botList] = await Promise.all([
          window.api.webui.listShared(),
          window.api.telegram.listBots()
        ])
        useChatStore.getState().setSharedSessionIds(new Set(sharedList))
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
      })()
    })
  }, [])

  // 监听内部事件，按类型做定向刷新（仅主窗口）
  useEffect(() => {
    if (isSettingsWindow) return
    // 通用设置 KV 变更 → 刷新设置 + i18n 语言 + 工具渲染配置（label 随语言变）
    const reloadSettings = async (): Promise<void> => {
      const settings = await window.api.settings.getAll()
      useSettingsStore.getState().loadSettings(settings)
      const savedLang = settings['general.language']
      if (savedLang && savedLang !== i18next.language) {
        i18next.changeLanguage(savedLang)
      }
      useChatStore.getState().setToolPresentations(await window.api.tools.presentations())
    }
    // 提供商/模型变更 → 刷新提供商 + 可用模型
    const reloadProviders = async (): Promise<void> => {
      const [allProviders, availableModels] = await Promise.all([
        window.api.provider.listAll(),
        window.api.provider.listAvailableModels()
      ])
      useSettingsStore.getState().setProviders(allProviders)
      useSettingsStore.getState().setAvailableModels(availableModels)
    }
    return window.api.events.subscribe((event) => {
      if (event.type === 'settings.changed') void reloadSettings()
      else if (event.type === 'providers.changed') void reloadProviders()
    })
  }, [])
}
