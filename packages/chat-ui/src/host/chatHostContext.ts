/**
 * ChatHost 上下文 — 宿主向聊天对话框注入的状态契约。
 *
 * 聊天对话框（Conversation 及其子组件/hooks）不再直接读 renderer 的
 * settingsStore / sidebarStore / browserStore，而是从这里取它需要的少量宿主状态：
 *   - appearance：外观（桌面来自 settingsStore；服务端来自浏览器本地配置）
 *   - models：模型/供应商选择（桌面来自 settingsStore；服务端经 ChatApi.provider.* 拉取）
 *   - voice：语音配置（可选；不提供则朗读相关 UI 隐藏、自动朗读跳过）
 *
 * 这样 settingsStore 等宿主状态既不搬入包、也不被拆分；
 * “外观存后端 / 存浏览器”等差异天然落在宿主侧。
 */

import { createContext, useContext } from 'react'

/** 外观（主题/字号/专注模式） */
export interface ChatAppearance {
  theme: 'dark' | 'light' | 'system'
  /** 暗色主题 ID（宿主自有取值；对话框不做语义解析，仅透传/展示） */
  darkTheme: string
  /** 亮色主题 ID */
  lightTheme: string
  fontSize: number
  focusMode: boolean
}

/**
 * 模型/供应商「当前选中」状态 + 切换动作。
 * 注意：供应商/模型「目录」(providers/availableModels)已收进 chat-ui 共享 modelCatalogStore
 * （经 ChatApi.provider 拉取 + 订阅 providers.changed），ChatHost 只注入当前会话的选中模型镜像。
 */
export interface ChatModelSelection {
  activeProvider: string
  activeModel: string
  setActiveProvider: (id: string) => void
  setActiveModel: (id: string) => void
}

/** 语音配置（可选端口） */
export interface ChatVoiceConfig {
  /** 是否启用 TTS 自动朗读 */
  ttsEnabled: boolean
}

export interface ChatHostValue {
  appearance: ChatAppearance
  models: ChatModelSelection
  voice?: ChatVoiceConfig
  /**
   * 这个宿主能运行 ```interactive 交互图（沙箱 iframe + `shuvix-lib:` 库协议）。
   * 桌面给 true；Chrome 扩展不给 —— MV3 扩展页的 CSP 禁内联脚本，srcdoc 又继承它，
   * 块在那里跑不起来，按代码块显示并说明只在桌面端运行。
   */
  interactiveFigures?: boolean
  /**
   * 交互图沙箱的库从哪里加载（server mode phase D）。不给（桌面）→ `shuvix-lib://<name>`（main 注册的库协议）；
   * 浏览器里的 web 客户端认不得那个协议，给 `<origin>/lib/`（网络服务的 `/lib/<name>`，同一张白名单）——
   * 沙箱的 CSP 随之放行这个基址，模型写的 `shuvix-lib://<name>` 换成它（见 chat-protocol 的 buildSandboxDocument）
   */
  sandboxLibBase?: string
  /**
   * 让这个窗口去看另一条会话（对话里建出的新会话 —— 会话 fork —— 建好之后切过去）。不给 = 这个宿主的对话
   * 视图钉在一条会话上（悬浮窗、md 窗口、Chrome 侧边栏），会把人带去别的会话的入口（「从这里分支」）不画。
   */
  openSession?: (sessionId: string) => void
  /**
   * 控件密度：'touch' = 手指的尺寸（手机布局的 web 客户端，MobileShell 给）；不给 = 'compact'（桌面窗口、
   * Chrome 侧边栏）。同一套组件两档尺寸，不是另一套手机界面：输入卡片的工具行按它放大到约 36px，模型 / 扩展
   * 选择器在 touch 下从底部抽屉打开，扩展入口换成带字的胶囊（手机没有悬停提示，三个图标加数字读不出意思）
   */
  density?: ChatDensity
}

export type ChatDensity = 'compact' | 'touch'

export const ChatHostContext = createContext<ChatHostValue | null>(null)

/** 宿主给的控件密度（没有 ChatHostProvider 的地方也能读：当作 compact） */
export function useChatDensity(): ChatDensity {
  return useContext(ChatHostContext)?.density ?? 'compact'
}

/** 对话框组件/hooks 读取宿主注入状态的唯一入口 */
export function useChatHost(): ChatHostValue {
  const ctx = useContext(ChatHostContext)
  if (!ctx) {
    throw new Error(
      '[chat-ui] 缺少 ChatHostProvider：请在挂载 <Conversation> 前用 <ChatHostProvider value={…}> 包裹'
    )
  }
  return ctx
}
