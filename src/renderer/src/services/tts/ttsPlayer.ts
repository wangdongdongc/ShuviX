/**
 * 全局 TTS 音频播放器 — 管理切片队列播放、中断和清理
 */
class TtsPlayer {
  private audio: HTMLAudioElement | null = null
  private queue: string[] = []
  private removeChunkListener: (() => void) | null = null
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

  /** 播放单个音频文件（供 VoiceSettings 试听等场景使用） */
  async play(filePath: string, messageId?: string): Promise<void> {
    this.stop()

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

  /** 合成并播放文本 — 切片流水线模式 */
  async speak(text: string, messageId?: string): Promise<void> {
    this.stop()

    this._isLoading = true
    this._playingMessageId = messageId ?? null
    this.queue = []
    this.notify()

    // 监听逐片推送，收到第一片立即播放
    this.removeChunkListener = window.api.tts.onChunk((data) => {
      if (!this._isLoading && !this._isPlaying) return
      this.queue.push(data.filePath)
      if (!this._isPlaying && this.queue.length === 1) {
        this.playNext(messageId)
      }
    })

    try {
      await window.api.tts.speakOnce({ text })
      // invoke 返回 = 所有片段合成完毕（或被中止）
      if (!this._isLoading && !this._isPlaying) return
      this._isLoading = false
      this.notify()
      // 合成结束且队列空且没在播放 → cleanup
      if (!this._isPlaying && this.queue.length === 0) {
        this.cleanup()
      }
    } catch {
      this.cleanup()
    }
  }

  /** 从队列取下一片播放 */
  private async playNext(messageId?: string): Promise<void> {
    const filePath = this.queue.shift()
    if (!filePath) {
      // 队列空了，如果合成也结束则 cleanup
      if (!this._isLoading) this.cleanup()
      return
    }

    if (this.audio) {
      this.audio.pause()
      this.audio.onended = null
      this.audio.onerror = null
    }

    this.audio = new Audio(`shuvix-media://${filePath}`)
    this._isPlaying = true
    this._playingMessageId = messageId ?? null
    this.notify()

    this.audio.onended = (): void => void this.playNext(messageId)
    this.audio.onerror = (): void => void this.playNext(messageId)

    try {
      await this.audio.play()
    } catch {
      this.playNext(messageId)
    }
  }

  /** 停止播放并中止后台合成 */
  stop(): void {
    // 通知 main 中止后台合成
    window.api.tts.abortTts()
    // 清理 chunk 事件监听
    this.removeChunkListener?.()
    this.removeChunkListener = null
    this.queue = []
    // 清理音频
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

  private cleanup(): void {
    this.removeChunkListener?.()
    this.removeChunkListener = null
    this.queue = []
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
