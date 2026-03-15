import type { SttBackend, SttStartOptions, SttState } from './types'

/**
 * VAD 参数
 * - SPEECH_THRESHOLD: RMS 能量阈值，高于此值判定为语音
 * - PAUSE_MS: 语音后静默多久触发分段 — 自然语句间停顿约 300-600ms，取 500ms 兼顾灵敏与稳定
 * - VAD_INTERVAL: 能量采样间隔（ms）
 * - MIN_SPEECH_RATIO: 片段中语音帧占比低于此值则丢弃（防幻觉）
 * - ENERGY_WINDOW: 滑动窗口大小（帧数），用于平滑能量判断，避免单帧抖动误触发
 * - IDLE_FLUSH_MS: 无语音状态下积累多久的静默数据后丢弃（节省内存）
 */
const SPEECH_THRESHOLD = 0.02
const PAUSE_MS = 500
const VAD_INTERVAL = 50
const MIN_SPEECH_RATIO = 0.15
const ENERGY_WINDOW = 5
const IDLE_FLUSH_MS = 5000

/**
 * OpenAI Whisper 后端 — MediaRecorder 录音 + 能量 VAD 分段 + IPC 调用 Whisper API
 *
 * 分段策略：检测自然语句停顿（静默 ≥ PAUSE_MS）时切割。
 * 使用滑动窗口平滑 RMS 能量，减少因气息、齿音等造成的抖动误判。
 * 不做强制时长切割，让 Whisper 始终接收完整语句以获得最佳识别质量。
 */
export class WhisperBackend implements SttBackend {
  readonly name = 'openai-whisper'

  private mediaStream: MediaStream | null = null
  private mediaRecorder: MediaRecorder | null = null
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private vadTimer: ReturnType<typeof setInterval> | null = null
  private audioChunks: Blob[] = []
  private language: string | undefined
  private processing = false
  private processingPromise: Promise<void> | null = null // 当前飞行中的 processSegment

  // VAD 状态
  private totalFrames = 0
  private speechFrames = 0
  private silenceStart: number | null = null
  private isSpeaking = false
  private idleStart = 0 // 无语音状态开始时间
  private energyRing: number[] = [] // 滑动窗口环形缓冲

  onInterimResult: ((text: string) => void) | null = null
  onFinalResult: ((text: string) => void) | null = null
  onError: ((error: string) => void) | null = null
  onStateChange: ((state: SttState) => void) | null = null

  isAvailable(): boolean {
    return (
      typeof navigator?.mediaDevices?.getUserMedia === 'function' &&
      typeof window.api?.stt?.transcribe === 'function'
    )
  }

  async start(options: SttStartOptions): Promise<void> {
    this.language = options.language

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      this.onError?.('Microphone access denied')
      return
    }

    this.audioContext = new AudioContext()
    const source = this.audioContext.createMediaStreamSource(this.mediaStream)
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 2048
    source.connect(this.analyser)

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType })
    this.audioChunks = []

    this.mediaRecorder.ondataavailable = (event): void => {
      if (event.data.size > 0) {
        this.audioChunks.push(event.data)
      }
    }

    this.mediaRecorder.start(200)
    this.onStateChange?.('recording')
    this.resetVAD()

    this.vadTimer = setInterval(() => this.checkVAD(), VAD_INTERVAL)
  }

  stop(): void {
    // 立刻停止 VAD 和录音，但等所有转写处理完成后再 cleanup
    if (this.vadTimer) {
      clearInterval(this.vadTimer)
      this.vadTimer = null
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
      this.mediaRecorder.onstop = (): void => {
        void this.drainAndCleanup()
      }
    } else {
      void this.drainAndCleanup()
    }
  }

  /** 等待飞行中的处理完成 + 处理剩余音频 + 最后 cleanup */
  private async drainAndCleanup(): Promise<void> {
    // 1. 等待已经在飞行中的 processSegment 完成
    if (this.processingPromise) {
      await this.processingPromise
    }

    // 2. 处理剩余的音频片段
    if (this.hasSufficientSpeech() && this.audioChunks.length > 0) {
      await this.processSegment()
    }

    // 3. 全部完成后清理
    this.cleanup()
  }

  /** 计算当前帧的 RMS 能量 */
  private getRMS(): number {
    if (!this.analyser) return 0
    const buf = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    return Math.sqrt(sum / buf.length)
  }

  /** 滑动窗口平滑后的能量是否超过阈值 */
  private isSpeechFrame(rms: number): boolean {
    this.energyRing.push(rms)
    if (this.energyRing.length > ENERGY_WINDOW) this.energyRing.shift()
    const avg = this.energyRing.reduce((a, b) => a + b, 0) / this.energyRing.length
    return avg >= SPEECH_THRESHOLD
  }

  private hasSufficientSpeech(): boolean {
    if (this.totalFrames === 0) return false
    return this.speechFrames / this.totalFrames >= MIN_SPEECH_RATIO
  }

  private resetVAD(): void {
    this.totalFrames = 0
    this.speechFrames = 0
    this.silenceStart = null
    this.isSpeaking = false
    this.idleStart = Date.now()
    this.energyRing = []
  }

  /** VAD 检测循环 */
  private checkVAD(): void {
    const rms = this.getRMS()
    const hasSpeech = this.isSpeechFrame(rms)
    this.totalFrames++

    if (hasSpeech) {
      this.speechFrames++
      this.silenceStart = null
      if (!this.isSpeaking) {
        this.isSpeaking = true
      }
    } else if (this.isSpeaking) {
      // 语音之后的停顿
      if (this.silenceStart === null) {
        this.silenceStart = Date.now()
      } else if (Date.now() - this.silenceStart >= PAUSE_MS) {
        // 停顿足够长 → 切割发送
        this.cutSegment()
        return
      }
    }

    // 空闲状态：长时间未检测到语音 → 清空积累的静默数据
    if (!this.isSpeaking && Date.now() - this.idleStart >= IDLE_FLUSH_MS) {
      this.audioChunks = []
      this.resetVAD()
    }
  }

  /** 切割当前片段并发送（或丢弃） */
  private cutSegment(): void {
    if (this.processing) return
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return

    const shouldSend = this.hasSufficientSpeech()

    this.mediaRecorder.stop()
    this.mediaRecorder.onstop = (): void => {
      const chunks = shouldSend ? [...this.audioChunks] : []
      this.audioChunks = []
      this.resetVAD()

      if (this.mediaRecorder && this.mediaStream) {
        try {
          this.mediaRecorder.start(200)
        } catch {
          /* recorder 可能已被释放 */
        }
      }

      if (chunks.length > 0) {
        this.processingPromise = this.processSegment(chunks)
      }
    }
  }

  /** 将音频片段发送到主进程进行 Whisper 转写 */
  private async processSegment(chunks?: Blob[]): Promise<void> {
    const blobs = chunks || this.audioChunks
    if (blobs.length === 0) return

    this.processing = true
    this.onStateChange?.('processing')

    try {
      const audioBlob = new Blob(blobs, { type: 'audio/webm' })
      const buffer = await audioBlob.arrayBuffer()

      // WebM base64（供 OpenAI API 使用）
      const audioData = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      )

      // 同时解码为 16kHz mono Float32 PCM（供本地 Whisper 使用）
      let pcmf32: string | undefined
      try {
        pcmf32 = await this.decodeToPcm(buffer)
      } catch {
        // 解码失败时仍可用 WebM（OpenAI 模式）
      }

      const result = await window.api.stt.transcribe({
        audioData,
        pcmf32,
        language: this.language
      })

      if (result.text) {
        this.onFinalResult?.(result.text)
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err.message : String(err))
    } finally {
      this.processing = false
      this.processingPromise = null
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.onStateChange?.('recording')
      }
    }
  }

  /**
   * 使用 Web Audio API 将 WebM 解码为 16kHz mono Float32 PCM，返回 base64
   */
  private async decodeToPcm(webmBuffer: ArrayBuffer): Promise<string> {
    // 用 OfflineAudioContext 以 16kHz 采样率解码
    const offlineCtx = new OfflineAudioContext(1, 1, 16000)
    const audioBuffer = await offlineCtx.decodeAudioData(webmBuffer.slice(0))

    // 重采样到 16kHz mono
    const duration = audioBuffer.duration
    const sampleCount = Math.ceil(duration * 16000)
    const resampleCtx = new OfflineAudioContext(1, sampleCount, 16000)
    const source = resampleCtx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(resampleCtx.destination)
    source.start()
    const resampled = await resampleCtx.startRendering()

    const pcmFloat32 = resampled.getChannelData(0)

    // Float32Array → base64
    const bytes = new Uint8Array(pcmFloat32.buffer, pcmFloat32.byteOffset, pcmFloat32.byteLength)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  private cleanup(): void {
    if (this.vadTimer) {
      clearInterval(this.vadTimer)
      this.vadTimer = null
    }
    if (this.audioContext) {
      void this.audioContext.close()
      this.audioContext = null
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop())
      this.mediaStream = null
    }
    this.mediaRecorder = null
    this.analyser = null
    this.audioChunks = []
    this.onStateChange?.('idle')
  }
}
