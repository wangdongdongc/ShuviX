import { create } from 'zustand'
import {
  defaultThinkingLevelOf,
  type SelectableThinkingLevel
} from '@shuvix/chat-protocol/types/thinking'

// ProviderInfo / ProviderModelInfo / AvailableModel / ConfigMeta 类型定义在 src/preload/index.d.ts（全局可用）

/** 深色系主题 ID */
export type DarkThemeId =
  | 'github-dark'
  | 'dracula'
  | 'one-dark'
  | 'catppuccin-mocha'
  | 'gruvbox-dark'
  | 'nord'
  | 'tokyo-night'
/** 浅色系主题 ID */
export type LightThemeId = 'github-light' | 'one-light' | 'catppuccin-latte' | 'solarized-light'

/** 笔记本编辑器外观预设 */
export type NotebookThemeId = 'default' | 'things'

interface SettingsState {
  /** 所有提供商列表（含禁用的） */
  providers: ProviderInfo[]
  /** 所有可用模型（已启用提供商 + 已启用模型） */
  availableModels: AvailableModel[]
  /** 输入框模型选择器此刻显示的 provider ID（当前会话的；欢迎页上是新会话会用的） */
  activeProvider: string
  /** 输入框模型选择器此刻显示的模型 ID */
  activeModel: string
  /**
   * 设置里的默认模型（`general.defaultProvider` / `general.defaultModel`）—— 设置页「默认模型」那一格。与
   * 选择器上的那个是两回事：新会话先用它的基座 md 声明的模型，没声明才用它
   */
  defaultProvider: string
  defaultModel: string
  /** 新会话的默认思考等级（`general.defaultThinkingLevel`） */
  defaultThinkingLevel: SelectableThinkingLevel
  /** 主题模式 */
  theme: 'dark' | 'light' | 'system'
  /** 深色模式使用的具体主题 */
  darkTheme: DarkThemeId
  /** 浅色模式使用的具体主题 */
  lightTheme: LightThemeId
  /** 笔记本编辑器外观预设 */
  notebookTheme: NotebookThemeId
  /** 字体大小 (px) */
  fontSize: number
  /** UI 缩放比例 (%) */
  uiZoom: number
  /** 专注模式：选中会话时淡化未选中的会话项与边缘 UI 区域 */
  focusMode: boolean
  /** TTS 自动朗读开关 */
  voiceTtsEnabled: boolean
  /** TTS 语音角色 */
  voiceTtsVoice: string
  /** TTS 语速 */
  voiceTtsSpeed: number
  /** TTS 模型 */
  voiceTtsModel: string
  /** TTS 后端 */
  voiceTtsBackend: 'openai' | 'qwen3'
  /** Qwen3 语音角色 */
  voiceTtsQwen3Voice: string
  /** Qwen3 语速 */
  voiceTtsQwen3Speed: number
  /** Qwen3 情感指令 */
  voiceTtsQwen3Emotion: string
  /** 设置面板是否打开 */
  isSettingsOpen: boolean
  /** 设置面板当前 Tab */
  activeSettingsTab:
    | 'general'
    | 'archived'
    | 'providers'
    | 'hooks'
    | 'tools'
    | 'mcp'
    | 'network'
    | 'voice'
    | 'triggers'
    | 'telegramBots'
    | 'monitor'
    | 'about'
  /** 启动时自动检查更新 */
  autoCheckUpdate: boolean
  /** 是否已加载 */
  loaded: boolean
  /** 系统设置 key 元数据（询问弹窗用） */
  settingMeta: Record<string, ConfigMeta>
  /** 项目字段元数据（询问弹窗用） */
  projectFieldMeta: Record<string, ConfigMeta>

  // Actions
  setProviders: (providers: ProviderInfo[]) => void
  setAvailableModels: (models: AvailableModel[]) => void
  setActiveProvider: (provider: string) => void
  setActiveModel: (model: string) => void
  setDefaultProvider: (provider: string) => void
  setDefaultModel: (model: string) => void
  setDefaultThinkingLevel: (level: SelectableThinkingLevel) => void
  setTheme: (theme: 'dark' | 'light' | 'system') => void
  setDarkTheme: (theme: DarkThemeId) => void
  setLightTheme: (theme: LightThemeId) => void
  setNotebookTheme: (theme: NotebookThemeId) => void
  setFontSize: (size: number) => void
  setUiZoom: (zoom: number) => void
  setFocusMode: (enabled: boolean) => void
  setIsSettingsOpen: (open: boolean) => void
  setActiveSettingsTab: (tab: SettingsState['activeSettingsTab']) => void
  loadSettings: (settings: Record<string, string>) => void
  /** 加载配置元数据（启动时调用一次） */
  loadConfigMeta: (
    settingMeta: Record<string, ConfigMeta>,
    projectFieldMeta: Record<string, ConfigMeta>
  ) => void
}

/**
 * 设置读回来之前的主题：上次记下的那份（loadSettings 写、HTML 内联脚本读的同一组 localStorage 键，
 * 取值规则也与内联脚本一致）。各窗口的外壳一挂载就按 store 写 data-theme，而 md、文件预览、widget、
 * 悬浮窗都在首帧（ready-to-show）就显示 —— 这里要是写死缺省，窗口就先闪一下 github-dark，
 * 等设置读回来才变回用户的主题。
 */
function lastKnownTheme(): Pick<SettingsState, 'theme' | 'darkTheme' | 'lightTheme'> {
  try {
    const mode = localStorage.getItem('theme') || 'system'
    return {
      theme: mode === 'light' || mode === 'system' ? mode : 'dark',
      darkTheme: (localStorage.getItem('darkTheme') as DarkThemeId | null) || 'github-dark',
      lightTheme: (localStorage.getItem('lightTheme') as LightThemeId | null) || 'github-light'
    }
  } catch {
    // 拿不到 localStorage（站点数据被禁用、非浏览器环境）：内联脚本同样什么也没设，等设置读回来
    return { theme: 'system', darkTheme: 'github-dark', lightTheme: 'github-light' }
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  providers: [],
  availableModels: [],
  activeProvider: '',
  activeModel: '',
  defaultProvider: '',
  defaultModel: '',
  defaultThinkingLevel: defaultThinkingLevelOf(undefined),
  ...lastKnownTheme(),
  notebookTheme: 'default',
  fontSize: 14,
  uiZoom: 100,
  focusMode: true,
  voiceTtsEnabled: false,
  voiceTtsVoice: 'alloy',
  voiceTtsSpeed: 1.0,
  voiceTtsModel: 'tts-1',
  voiceTtsBackend: 'openai',
  voiceTtsQwen3Voice: 'Vivian',
  voiceTtsQwen3Speed: 1.0,
  voiceTtsQwen3Emotion: '',
  isSettingsOpen: false,
  activeSettingsTab: 'general',
  autoCheckUpdate: true,
  loaded: false,
  settingMeta: {},
  projectFieldMeta: {},

  setProviders: (providers) => set({ providers }),
  setAvailableModels: (models) => set({ availableModels: models }),
  setActiveProvider: (provider) => set({ activeProvider: provider }),
  setActiveModel: (model) => set({ activeModel: model }),
  setDefaultProvider: (provider) => set({ defaultProvider: provider }),
  setDefaultModel: (model) => set({ defaultModel: model }),
  setDefaultThinkingLevel: (level) => set({ defaultThinkingLevel: level }),
  setTheme: (theme) => set({ theme }),
  setDarkTheme: (darkTheme) => set({ darkTheme }),
  setLightTheme: (lightTheme) => set({ lightTheme }),
  setNotebookTheme: (notebookTheme) => set({ notebookTheme }),
  setFontSize: (size) => set({ fontSize: size }),
  setUiZoom: (zoom) => set({ uiZoom: zoom }),
  setFocusMode: (enabled) => set({ focusMode: enabled }),
  setIsSettingsOpen: (open) => set({ isSettingsOpen: open }),
  setActiveSettingsTab: (tab) => set({ activeSettingsTab: tab }),

  loadConfigMeta: (settingMeta, projectFieldMeta) => set({ settingMeta, projectFieldMeta }),

  /** 从 settings 表加载通用设置（不覆盖当前会话的 activeProvider/activeModel） */
  loadSettings: (settings) => {
    const rawDark = settings['general.darkTheme'] || 'github-dark'
    const darkTheme = (rawDark === 'dark' ? 'github-dark' : rawDark) as DarkThemeId
    const rawLight = settings['general.lightTheme'] || 'github-light'
    const lightTheme = (rawLight === 'light' ? 'github-light' : rawLight) as LightThemeId
    set({
      theme: (settings['general.theme'] as 'dark' | 'light' | 'system') || 'system',
      darkTheme,
      lightTheme,
      notebookTheme: (settings['appearance.notebookTheme'] as NotebookThemeId) || 'default',
      fontSize: Number(settings['general.fontSize']) || 14,
      uiZoom: Number(settings['general.uiZoom']) || 100,
      focusMode: settings['appearance.focusMode'] !== 'false',
      defaultProvider: settings['general.defaultProvider'] || '',
      defaultModel: settings['general.defaultModel'] || '',
      defaultThinkingLevel: defaultThinkingLevelOf(settings['general.defaultThinkingLevel']),
      voiceTtsEnabled: settings['voice.tts.enabled'] === 'true',
      voiceTtsVoice: settings['voice.tts.openai.voice'] || 'alloy',
      voiceTtsSpeed: Number(settings['voice.tts.openai.speed']) || 1.0,
      voiceTtsModel: settings['voice.tts.openai.model'] || 'tts-1',
      voiceTtsBackend: (settings['voice.tts.backend'] as 'openai' | 'qwen3') || 'openai',
      voiceTtsQwen3Voice: settings['voice.tts.qwen3.voice'] || 'Vivian',
      voiceTtsQwen3Speed: Number(settings['voice.tts.qwen3.speed']) || 1.0,
      voiceTtsQwen3Emotion: settings['voice.tts.qwen3.emotion'] || '',
      autoCheckUpdate: settings['updates.autoCheck'] !== 'false',
      loaded: true
    })
    // 同步主题到 localStorage，供 HTML 内联脚本在下次打开时消除闪烁；语言同理，i18n.ts 初始化时读
    localStorage.setItem('theme', settings['general.theme'] || 'system')
    localStorage.setItem('darkTheme', darkTheme)
    localStorage.setItem('lightTheme', lightTheme)
    localStorage.setItem('language', settings['general.language'] || 'en')
  }
}))
