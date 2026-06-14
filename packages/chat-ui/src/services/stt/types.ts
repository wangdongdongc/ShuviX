/** STT 后端状态 */
export type SttState = 'idle' | 'recording' | 'processing'

/** STT 启动选项 */
export interface SttStartOptions {
  /** BCP-47 语言标签，如 'zh-CN', 'en-US', 'ja-JP'；传 'auto' 或 undefined 表示自动检测 */
  language?: string
}

/**
 * STT 后端接口 — 所有语音识别引擎的统一抽象
 */
export interface SttBackend {
  /** 后端名称 */
  readonly name: string

  /** 当前环境是否可用 */
  isAvailable(): boolean

  /** 开始录音/识别 */
  start(options: SttStartOptions): void

  /** 停止录音/识别 */
  stop(): void

  // ---- 事件回调 ----

  /** 临时识别结果（实时更新） */
  onInterimResult: ((text: string) => void) | null

  /** 最终识别结果（一段话确认完成） */
  onFinalResult: ((text: string) => void) | null

  /** 错误回调 */
  onError: ((error: string) => void) | null

  /** 状态变化回调 */
  onStateChange: ((state: SttState) => void) | null
}
