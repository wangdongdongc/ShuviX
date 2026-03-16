import { useSyncExternalStore, useCallback } from 'react'
import { ttsPlayer } from '../services/tts/ttsPlayer'

export function useTtsPlayback(): {
  isPlaying: boolean
  isLoading: boolean
  playingMessageId: string | null
  speak: (text: string, messageId?: string) => void
  stop: () => void
} {
  const isPlaying = useSyncExternalStore(
    (cb) => ttsPlayer.subscribe(cb),
    () => ttsPlayer.isPlaying
  )
  const isLoading = useSyncExternalStore(
    (cb) => ttsPlayer.subscribe(cb),
    () => ttsPlayer.isLoading
  )
  const playingMessageId = useSyncExternalStore(
    (cb) => ttsPlayer.subscribe(cb),
    () => ttsPlayer.playingMessageId
  )

  const speak = useCallback((text: string, messageId?: string) => {
    ttsPlayer.speak(text, messageId).catch(() => {})
  }, [])

  const stop = useCallback(() => {
    ttsPlayer.stop()
  }, [])

  return { isPlaying, isLoading, playingMessageId, speak, stop }
}
