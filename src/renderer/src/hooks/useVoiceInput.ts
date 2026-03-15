import { useState, useRef, useCallback, useEffect } from 'react'
import { useChatStore } from '../stores/chatStore'
import type { SttBackend, SttState } from '../services/stt/types'
import { WhisperBackend } from '../services/stt/whisperBackend'

export interface UseVoiceInputReturn {
  /** 是否正在录音 */
  isRecording: boolean
  /** 录制时长（秒） */
  duration: number
  /** STT 引擎状态 */
  sttState: SttState
  /** 开始录音 */
  startRecording: () => void
  /** 停止录音（保留文字） */
  stopRecording: () => void
  /** 取消录音（丢弃文字） */
  cancelRecording: () => void
  /** 是否有可用的 STT 后端 */
  isAvailable: boolean
  /** 错误信息 */
  error: string | null
}

/**
 * 语音输入 Hook — 封装 Whisper STT 后端、录制状态、文本累积逻辑
 * 遵循 useImageUpload 的 hook 模式：管理特定输入模态，将结果写入 chatStore.inputText
 */
export function useVoiceInput(language: string): UseVoiceInputReturn {
  const { setInputText } = useChatStore()

  const [isRecording, setIsRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [sttState, setSttState] = useState<SttState>('idle')
  const [error, setError] = useState<string | null>(null)

  // 录制状态引用（避免闭包陷阱）
  const backendRef = useRef<SttBackend | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const preExistingTextRef = useRef('')
  const confirmedTextRef = useRef('')
  const interimTextRef = useRef('')
  const recordingRef = useRef(false)

  // 检测可用性
  const [isAvailable, setIsAvailable] = useState(false)
  useEffect(() => {
    const backend = new WhisperBackend()
    setIsAvailable(backend.isAvailable())
  }, [])

  /** 更新输入框文本 */
  const updateInputText = useCallback((): void => {
    const text = preExistingTextRef.current + confirmedTextRef.current + interimTextRef.current
    setInputText(text)
  }, [setInputText])

  /** 停止并清理 */
  const cleanup = useCallback((): void => {
    if (backendRef.current) {
      backendRef.current.stop()
      backendRef.current.onInterimResult = null
      backendRef.current.onFinalResult = null
      backendRef.current.onError = null
      backendRef.current.onStateChange = null
      backendRef.current = null
    }
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    recordingRef.current = false
    setIsRecording(false)
    setDuration(0)
    setSttState('idle')
  }, [])

  /** 开始录音 */
  const startRecording = useCallback((): void => {
    if (recordingRef.current) return

    setError(null)
    const backend = new WhisperBackend()
    backendRef.current = backend
    recordingRef.current = true

    // 记录录制前已有的文本
    const currentText = useChatStore.getState().inputText
    preExistingTextRef.current = currentText
    confirmedTextRef.current = ''
    interimTextRef.current = ''

    // 设置回调
    backend.onInterimResult = (text: string): void => {
      interimTextRef.current = text
      updateInputText()
    }

    backend.onFinalResult = (text: string): void => {
      confirmedTextRef.current += text
      interimTextRef.current = ''
      updateInputText()
    }

    backend.onError = (err: string): void => {
      setError(err)
      cleanup()
    }

    backend.onStateChange = (state: SttState): void => {
      setSttState(state)
      if (state === 'idle' && recordingRef.current) {
        cleanup()
      }
    }

    setIsRecording(true)
    setDuration(0)

    // 启动计时器
    const startTime = Date.now()
    timerRef.current = setInterval(() => {
      setDuration(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)

    // 启动 STT
    const lang = language === 'auto' ? undefined : language
    backend.start({ language: lang })
  }, [language, updateInputText, cleanup])

  /** 停止录音（保留文字） */
  const stopRecording = useCallback((): void => {
    if (!recordingRef.current) return
    // 将 interim 文本转为 confirmed
    if (interimTextRef.current) {
      confirmedTextRef.current += interimTextRef.current
      interimTextRef.current = ''
      updateInputText()
    }
    cleanup()
  }, [updateInputText, cleanup])

  /** 取消录音（丢弃文字） */
  const cancelRecording = useCallback((): void => {
    if (!recordingRef.current) return
    cleanup()
    // 恢复录制前的文本
    setInputText(preExistingTextRef.current)
  }, [cleanup, setInputText])

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        cleanup()
      }
    }
  }, [cleanup])

  return {
    isRecording,
    duration,
    sttState,
    startRecording,
    stopRecording,
    cancelRecording,
    isAvailable,
    error
  }
}
