import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Play, AlertCircle } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  SettingsSection,
  SettingsRow,
  Toggle,
  InlineSelect,
  SegmentedControl
} from './SettingsPrimitives'

/** 语音设置 Tab —— 只有语音输出（TTS） */
export function VoiceSettings(): React.JSX.Element {
  return (
    <div className="flex-1 min-h-0 h-full overflow-y-auto">
      <TtsPanel />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
// TTS 面板（语音输出）
// ────────────────────────────────────────────────────────────────
const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const
const TTS_SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0] as const
const QWEN3_SPEED_OPTIONS = [0.8, 1.0, 1.25, 1.5] as const

let testAudio: HTMLAudioElement | null = null

interface Qwen3Status {
  ready: boolean
  hasPython: boolean
  hasDeps: boolean
  hasModel: boolean
  modelSizeMB: number | null
  platformSupported: boolean
}

function TtsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    voiceTtsEnabled,
    voiceTtsVoice,
    voiceTtsSpeed,
    voiceTtsModel,
    voiceTtsBackend,
    voiceTtsQwen3Voice,
    voiceTtsQwen3Speed,
    providers
  } = useSettingsStore()
  const [testing, setTesting] = useState(false)
  const [qwen3Status, setQwen3Status] = useState<Qwen3Status | null>(null)
  const [setupRunning, setSetupRunning] = useState(false)
  const [setupMessage, setSetupMessage] = useState('')
  const [setupPercent, setSetupPercent] = useState(-1)
  const [qwen3Voices, setQwen3Voices] = useState<
    Array<{ id: string; name: string; language: string; gender: string }>
  >([])

  const openaiProvider = providers.find((p) => p.name === 'openai' && p.isBuiltin)
  const openaiReady = !!openaiProvider?.apiKey?.trim() && !!openaiProvider?.isEnabled
  const isMac = window.api.app.platform === 'darwin'

  const save = (key: string, value: string): void => {
    window.api.settings.set({ key, value })
  }

  const loadQwen3Status = useCallback(async () => {
    try {
      const status = await window.api.tts.getQwen3Status()
      setQwen3Status(status)
      if (status.platformSupported) {
        const voices = await window.api.tts.getQwen3Voices()
        setQwen3Voices(voices)
      }
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void loadQwen3Status()
  }, [loadQwen3Status])

  useEffect(() => {
    const unsub = window.api.tts.onSetupProgress((progress) => {
      setSetupMessage(t(progress.messageKey))
      setSetupPercent(progress.percent)
      if (progress.step === 'model' && progress.percent === 100) {
        setTimeout(() => {
          setSetupRunning(false)
          void loadQwen3Status()
        }, 500)
      }
    })
    return unsub
  }, [loadQwen3Status, t])

  useEffect(() => {
    const unsub = window.api.download.onProgress((progress) => {
      if (!progress.taskId.startsWith('qwen3-')) return
      const pct = progress.percent
      const speedMB = (progress.speedBytesPerSec / (1024 * 1024)).toFixed(1)
      setSetupMessage(`${progress.taskId.replace('qwen3-model-', '')}  ${pct}%  ${speedMB} MB/s`)
      setSetupPercent(pct)
    })
    return unsub
  }, [])

  const handleToggleTts = (): void => {
    const next = !voiceTtsEnabled
    useSettingsStore.setState({ voiceTtsEnabled: next })
    save('voice.tts.enabled', String(next))
  }

  const handleBackendChange = (backend: 'openai' | 'qwen3'): void => {
    useSettingsStore.setState({ voiceTtsBackend: backend })
    save('voice.tts.backend', backend)
  }

  const handleSetup = async (): Promise<void> => {
    setSetupRunning(true)
    setSetupMessage(t('settings.voiceTtsQwen3SetupStarting'))
    setSetupPercent(-1)
    try {
      await window.api.tts.setupQwen3()
    } catch (err) {
      console.error('Qwen3 setup failed:', err)
      setSetupRunning(false)
      setSetupMessage('')
    }
  }

  const handleTest = async (): Promise<void> => {
    if (testing) return
    setTesting(true)
    try {
      if (testAudio) {
        testAudio.pause()
        testAudio = null
      }
      const removeListener = window.api.tts.onChunk((data) => {
        if (data.index === 0 && !testAudio) {
          const audio = new Audio(`shuvix-media://${data.filePath}`)
          testAudio = audio
          audio.onended = () => {
            testAudio = null
          }
          audio.onerror = () => {
            testAudio = null
          }
          audio.play()
        }
      })
      await window.api.tts.speakOnce({ text: t('settings.voiceTtsTestText') })
      removeListener()
    } catch (err) {
      console.error('TTS test failed:', err)
    } finally {
      setTesting(false)
    }
  }

  const testDisabled =
    testing ||
    (voiceTtsBackend === 'openai' && !openaiReady) ||
    (voiceTtsBackend === 'qwen3' && !qwen3Status?.ready)

  return (
    <div className="flex-1 px-5 py-5 space-y-5">
      {/* 概览 */}
      <SettingsSection title={t('settings.voiceTtsTitle')} description={t('settings.voiceTtsDesc')}>
        <SettingsRow
          title={t('settings.voiceTtsAutoPlay')}
          control={<Toggle on={voiceTtsEnabled} onClick={handleToggleTts} />}
        />
        <SettingsRow
          title={t('settings.voiceTtsBackend')}
          control={
            <SegmentedControl<'openai' | 'qwen3'>
              value={voiceTtsBackend}
              onChange={(v) => {
                if (v === 'qwen3' && !isMac) return
                handleBackendChange(v)
              }}
              options={[
                { value: 'openai', label: 'OpenAI API' },
                {
                  value: 'qwen3',
                  label: (
                    <span className={!isMac ? 'opacity-50' : ''}>
                      {t('settings.voiceTtsBackendQwen3')}
                    </span>
                  )
                }
              ]}
            />
          }
        />
      </SettingsSection>

      {/* OpenAI 配置 */}
      {voiceTtsBackend === 'openai' && (
        <SettingsSection title="OpenAI">
          <div
            className={`flex items-start gap-2 px-4 py-3 ${
              openaiReady ? 'bg-emerald-500/5 text-emerald-400' : 'bg-amber-500/5 text-amber-400'
            }`}
          >
            {openaiReady ? (
              <Check size={12} className="shrink-0 mt-0.5" />
            ) : (
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
            )}
            <p className="text-[11px] leading-relaxed">
              {openaiReady ? (
                t('settings.voiceTtsReady')
              ) : (
                <>
                  {t('settings.voiceTtsHint')}{' '}
                  <button
                    onClick={() => window.api.app.openSettings('providers')}
                    className="underline hover:opacity-80 transition-opacity"
                  >
                    {t('settings.voiceGoProviders')}
                  </button>
                </>
              )}
            </p>
          </div>
          <SettingsRow
            title={t('settings.voiceTtsVoice')}
            control={
              <InlineSelect
                value={voiceTtsVoice}
                onChange={(v) => {
                  useSettingsStore.setState({ voiceTtsVoice: v })
                  save('voice.tts.openai.voice', v)
                }}
              >
                {OPENAI_VOICES.map((voice) => (
                  <option key={voice} value={voice}>
                    {voice.charAt(0).toUpperCase() + voice.slice(1)}
                  </option>
                ))}
              </InlineSelect>
            }
          />
          <SettingsRow
            title={t('settings.voiceTtsModel')}
            control={
              <SegmentedControl<'tts-1' | 'tts-1-hd'>
                value={voiceTtsModel as 'tts-1' | 'tts-1-hd'}
                onChange={(v) => {
                  useSettingsStore.setState({ voiceTtsModel: v })
                  save('voice.tts.openai.model', v)
                }}
                options={[
                  { value: 'tts-1', label: t('settings.voiceTtsModelStandard') },
                  { value: 'tts-1-hd', label: t('settings.voiceTtsModelHd') }
                ]}
              />
            }
          />
          <SettingsRow
            title={t('settings.voiceTtsSpeed')}
            control={
              <InlineSelect
                value={String(voiceTtsSpeed)}
                onChange={(v) => {
                  const speed = Number(v)
                  useSettingsStore.setState({ voiceTtsSpeed: speed })
                  save('voice.tts.openai.speed', v)
                }}
                width={120}
              >
                {TTS_SPEED_OPTIONS.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}x
                  </option>
                ))}
              </InlineSelect>
            }
          />
        </SettingsSection>
      )}

      {/* Qwen3 配置 */}
      {voiceTtsBackend === 'qwen3' && (
        <SettingsSection title={t('settings.voiceTtsBackendQwen3')}>
          {qwen3Status?.ready ? (
            <div className="flex items-start gap-2 px-4 py-3 bg-emerald-500/5 text-emerald-400">
              <Check size={12} className="shrink-0 mt-0.5" />
              <p className="text-[11px] leading-relaxed">{t('settings.voiceTtsQwen3Ready')}</p>
            </div>
          ) : setupRunning ? (
            <div className="px-4 py-3 bg-accent/5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[11px] text-accent">
                  <Loader2 size={11} className="animate-spin" />
                  {setupMessage}
                </div>
                <button
                  onClick={() => {
                    window.api.tts.cancelSetupQwen3()
                    setSetupRunning(false)
                    setSetupMessage('')
                    setSetupPercent(-1)
                  }}
                  className="px-2 py-0.5 rounded text-[10px] text-text-tertiary hover:text-error hover:bg-error/10 transition-colors"
                >
                  {t('settings.voiceCancelDownload')}
                </button>
              </div>
              {setupPercent >= 0 && (
                <div className="mt-2 w-full h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent rounded-full transition-all duration-300"
                    style={{ width: `${setupPercent}%` }}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-start gap-2 px-4 py-3 bg-amber-500/5">
              <AlertCircle size={12} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2">
                <p className="text-[11px] text-amber-400 leading-relaxed">
                  {t('settings.voiceTtsQwen3Desc')}
                </p>
                <button
                  onClick={handleSetup}
                  className="px-3 py-1 rounded-md text-[11px] font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
                >
                  {t('settings.voiceTtsQwen3Setup')}
                </button>
              </div>
            </div>
          )}

          {qwen3Status?.ready && qwen3Voices.length > 0 && (
            <SettingsRow
              title={t('settings.voiceTtsVoice')}
              control={
                <InlineSelect
                  value={voiceTtsQwen3Voice}
                  onChange={(v) => {
                    useSettingsStore.setState({ voiceTtsQwen3Voice: v })
                    save('voice.tts.qwen3.voice', v)
                  }}
                  width={240}
                >
                  {qwen3Voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.language}, {v.gender})
                    </option>
                  ))}
                </InlineSelect>
              }
            />
          )}

          {qwen3Status?.ready && (
            <SettingsRow
              title={t('settings.voiceTtsSpeed')}
              control={
                <InlineSelect
                  value={String(voiceTtsQwen3Speed)}
                  onChange={(v) => {
                    const speed = Number(v)
                    useSettingsStore.setState({ voiceTtsQwen3Speed: speed })
                    save('voice.tts.qwen3.speed', v)
                  }}
                  width={120}
                >
                  {QWEN3_SPEED_OPTIONS.map((speed) => (
                    <option key={speed} value={speed}>
                      {speed}x
                    </option>
                  ))}
                </InlineSelect>
              }
            />
          )}
        </SettingsSection>
      )}

      {/* 测试 */}
      <button
        onClick={handleTest}
        disabled={testDisabled}
        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed self-start"
      >
        {testing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
        {t('settings.voiceTtsTest')}
      </button>
    </div>
  )
}
