/**
 * 全局 TTS 音频播放器 — 管理播放、中断和清理
 */
class TtsPlayer {
  private audio: HTMLAudioElement | null = null
  private _isPlaying = false
  private _isLoading = false
  private _playingMessageId: string | null = null
  private listeners: Set<() => void> = new Set()

  get isPlaying(): boolean {
    return this._isPlaying
  }

  get isLoading(): boolean {
    return this._isLoading
  }

  get playingMessageId(): string | null {
    return this._playingMessageId
  }

  /** 订阅状态变化（用于 useSyncExternalStore） */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn())
  }

  /** 播放音频文件 */
  async play(filePath: string, messageId?: string): Promise<void> {
    this.stop()

    // Electron 打包后用 file:// 协议加载本地临时文件
    this.audio = new Audio(`shuvix-media://${filePath}`)
    this._playingMessageId = messageId ?? null
    this._isPlaying = true
    this._isLoading = false
    this.notify()

    this.audio.onended = (): void => {
      this.cleanup()
    }
    this.audio.onerror = (): void => {
      this.cleanup()
    }

    await this.audio.play()
  }

  /** 停止播放 */
  stop(): void {
    if (this.audio) {
      this.audio.pause()
      this.audio.onended = null
      this.audio.onerror = null
      this.audio = null
    }
    const wasActive = this._isPlaying || this._isLoading
    this._isPlaying = false
    this._isLoading = false
    this._playingMessageId = null
    if (wasActive) {
      this.notify()
    }
  }

  /** 合成并播放文本 */
  async speak(text: string, messageId?: string): Promise<void> {
    this.stop()

    this._isLoading = true
    this._playingMessageId = messageId ?? null
    this.notify()

    try {
      const result = await window.api.tts.speakOnce({ text })
      // 如果在等待期间被中断（stop 被调用），不再播放
      if (!this._isLoading) return
      await this.play(result.filePath, messageId)
    } catch {
      this.cleanup()
    }
  }

  private cleanup(): void {
    if (this.audio) {
      this.audio.onended = null
      this.audio.onerror = null
      this.audio = null
    }
    this._isPlaying = false
    this._isLoading = false
    this._playingMessageId = null
    this.notify()
  }
}

export const ttsPlayer = new TtsPlayer()
