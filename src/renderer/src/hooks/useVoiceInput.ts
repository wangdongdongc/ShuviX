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
 *
 * 停止行为：
 * - stopRecording: 立刻停止录音（UI 反馈），但保持回调存活，
 *   让后端把剩余音频处理完（drainAndCleanup），最后 onStateChange('idle') 触发最终清理。
 * - cancelRecording: 立刻中止一切，丢弃文字。
 */
export function useVoiceInput(language: string): UseVoiceInputReturn {
  const { setInputText } = useChatStore()

  const [isRecording, setIsRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [sttState, setSttState] = useState<SttState>('idle')
  const [error, setError] = useState<string | null>(null)

  const backendRef = useRef<SttBackend | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const preExistingTextRef = useRef('')
  const confirmedTextRef = useRef('')
  const interimTextRef = useRef('')
  const recordingRef = useRef(false)

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

  /** 停止计时器 */
  const stopTimer = useCallback((): void => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /** 最终清理：清空回调和引用 */
  const finalCleanup = useCallback((): void => {
    if (backendRef.current) {
      backendRef.current.onInterimResult = null
      backendRef.current.onFinalResult = null
      backendRef.current.onError = null
      backendRef.current.onStateChange = null
      backendRef.current = null
    }
    stopTimer()
    recordingRef.current = false
    setIsRecording(false)
    setDuration(0)
    setSttState('idle')
  }, [stopTimer])

  /** 强制中止：立刻停止后端 + 清理（用于 cancel 和 unmount） */
  const forceAbort = useCallback((): void => {
    if (backendRef.current) {
      backendRef.current.stop()
    }
    finalCleanup()
  }, [finalCleanup])

  /** 开始录音 */
  const startRecording = useCallback((): void => {
    if (recordingRef.current) return

    setError(null)
    const backend = new WhisperBackend()
    backendRef.current = backend
    recordingRef.current = true

    const currentText = useChatStore.getState().inputText
    preExistingTextRef.current = currentText
    confirmedTextRef.current = ''
    interimTextRef.current = ''

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
      finalCleanup()
    }

    // 后端完全空闲后触发最终清理
    backend.onStateChange = (state: SttState): void => {
      setSttState(state)
      if (state === 'idle') {
        finalCleanup()
      }
    }

    setIsRecording(true)
    setDuration(0)

    const startTime = Date.now()
    timerRef.current = setInterval(() => {
      setDuration(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)

    const lang = language === 'auto' ? undefined : language
    backend.start({ language: lang })
  }, [language, updateInputText, finalCleanup])

  /** 停止录音（保留文字，等待剩余音频处理完成） */
  const stopRecording = useCallback((): void => {
    if (!recordingRef.current) return
    recordingRef.current = false

    // 立刻反映到 UI
    setIsRecording(false)
    stopTimer()

    // 提升 interim 文本
    if (interimTextRef.current) {
      confirmedTextRef.current += interimTextRef.current
      interimTextRef.current = ''
      updateInputText()
    }

    // 通知后端停止录音 — 它会 drain 剩余音频，处理完成后
    // 调用 onFinalResult（如果有结果），然后 onStateChange('idle') 触发 finalCleanup
    backendRef.current?.stop()
  }, [updateInputText, stopTimer])

  /** 取消录音（丢弃文字，立刻中止） */
  const cancelRecording = useCallback((): void => {
    if (!recordingRef.current) return
    forceAbort()
    setInputText(preExistingTextRef.current)
  }, [forceAbort, setInputText])

  // 组件卸载时强制中止
  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        forceAbort()
      }
    }
  }, [forceAbort])

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
