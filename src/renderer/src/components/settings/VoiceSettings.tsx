import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Trash2, Check, Loader2, Mic, Volume2, Play } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'

/** 子分类标识 */
type VoiceSubTab = 'stt' | 'tts'

/** 子分类导航按钮 */
function SubTabButton({
  icon,
  label,
  active,
  onClick
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors text-left ${
        active
          ? 'bg-accent/10 text-accent font-medium'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

/** 语音设置 Tab（含 STT / TTS 子分类） */
export function VoiceSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [subTab, setSubTab] = useState<VoiceSubTab>('stt')

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧子分类导航 */}
      <div className="w-[140px] flex-shrink-0 border-r border-border-secondary py-4 px-2.5 space-y-0.5">
        <SubTabButton
          icon={<Mic size={13} />}
          label={t('settings.voiceSttTab')}
          active={subTab === 'stt'}
          onClick={() => setSubTab('stt')}
        />
        <SubTabButton
          icon={<Volume2 size={13} />}
          label={t('settings.voiceTtsTab')}
          active={subTab === 'tts'}
          onClick={() => setSubTab('tts')}
        />
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {subTab === 'stt' && <SttPanel />}
        {subTab === 'tts' && <TtsPanel />}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
// STT 面板（语音输入）
// ────────────────────────────────────────────────────────────────

/** 模型信息（来自 stt:getLocalStatus） */
interface ModelInfo {
  id: string
  name: string
  sizeMB: number
  description: string
  recommended: boolean
  downloaded: boolean
}

/** 下载进度 */
interface DownloadState {
  percent: number
  speedBytesPerSec: number
  etaSeconds: number
}

/** 格式化文件大小 */
function formatSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`
}

/** 格式化下载速度 */
function formatSpeed(bytesPerSec: number): string {
  const mbps = bytesPerSec / (1024 * 1024)
  return mbps >= 1 ? `${mbps.toFixed(1)} MB/s` : `${(bytesPerSec / 1024).toFixed(0)} KB/s`
}

/** 格式化剩余时间 */
function formatEta(seconds: number): string {
  if (seconds <= 0) return ''
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m${s > 0 ? ` ${s}s` : ''}`
}

function SttPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { voiceSttBackend, voiceSttLanguage, voiceLocalModel, providers } = useSettingsStore()

  const [models, setModels] = useState<ModelInfo[]>([])
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  const [loading, setLoading] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const status = await window.api.stt.getLocalStatus()
      setModels(status.models)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    const unsub = window.api.download.onProgress((progress) => {
      if (progress.taskId.startsWith('whisper-')) {
        setDownloads((prev) => ({
          ...prev,
          [progress.taskId]: {
            percent: progress.percent,
            speedBytesPerSec: progress.speedBytesPerSec,
            etaSeconds: progress.etaSeconds
          }
        }))

        if (progress.percent >= 100) {
          setTimeout(() => {
            setDownloads((prev) => {
              const next = { ...prev }
              delete next[progress.taskId]
              return next
            })
            void loadStatus()
          }, 500)
        }
      }
    })
    return unsub
  }, [loadStatus])

  const handleBackendChange = (backend: 'openai' | 'local'): void => {
    useSettingsStore.setState({ voiceSttBackend: backend })
    window.api.settings.set({ key: 'voice.sttBackend', value: backend })
  }

  const handleDownload = async (modelId: string): Promise<void> => {
    setLoading(true)
    try {
      await window.api.stt.downloadModel(modelId)
    } catch (err) {
      console.error('Download failed:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (modelId: string): Promise<void> => {
    await window.api.stt.deleteModel(modelId)
    void loadStatus()
  }

  const handleSelectModel = (modelId: string): void => {
    useSettingsStore.setState({ voiceLocalModel: modelId })
    window.api.settings.set({ key: 'voice.localModel', value: modelId })
  }

  const handleCancelDownload = (modelId: string): void => {
    window.api.download.cancel(`whisper-model-${modelId}`)
    setDownloads((prev) => {
      const next = { ...prev }
      delete next[`whisper-model-${modelId}`]
      return next
    })
  }

  const openaiProvider = providers.find((p) => p.name === 'openai' && p.isBuiltin)
  const openaiReady = !!openaiProvider?.apiKey?.trim() && !!openaiProvider?.isEnabled

  return (
    <div className="px-5 py-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{t('settings.voiceSttTitle')}</h3>
        <p className="text-[11px] text-text-tertiary mt-1">{t('settings.voiceSttDesc')}</p>
      </div>

      {/* 识别引擎 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          {t('settings.voiceSttBackend')}
        </label>
        <div className="flex gap-2">
          {(['openai', 'local'] as const).map((id) => (
            <button
              key={id}
              onClick={() => handleBackendChange(id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                voiceSttBackend === id
                  ? 'bg-accent text-white'
                  : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              {id === 'openai' ? 'OpenAI API' : t('settings.voiceLocalLabel')}
            </button>
          ))}
        </div>
      </div>

      {/* OpenAI 状态提示 */}
      {voiceSttBackend === 'openai' && (
        <div
          className={`rounded-lg border px-3 py-2 text-[11px] ${
            openaiReady
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
              : 'border-amber-500/30 bg-amber-500/5 text-amber-400'
          }`}
        >
          {openaiReady ? (
            t('settings.voiceWhisperReady')
          ) : (
            <span>
              {t('settings.voiceWhisperHint')}{' '}
              <button
                onClick={() => window.api.app.openSettings('providers')}
                className="underline hover:text-amber-300 transition-colors"
              >
                {t('settings.voiceGoProviders')}
              </button>
            </span>
          )}
        </div>
      )}

      {/* 识别语言 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          {t('settings.voiceSttLanguage')}
        </label>
        <select
          value={voiceSttLanguage}
          onChange={(e) => {
            useSettingsStore.setState({ voiceSttLanguage: e.target.value })
            window.api.settings.set({ key: 'voice.sttLanguage', value: e.target.value })
          }}
          className="zen-select"
        >
          <option value="auto">{t('settings.voiceLangAuto')}</option>
          <option value="zh-CN">{t('settings.voiceLangZh')}</option>
          <option value="en-US">{t('settings.voiceLangEn')}</option>
          <option value="ja-JP">{t('settings.voiceLangJa')}</option>
        </select>
      </div>

      {/* 本地模型列表 */}
      {voiceSttBackend === 'local' && (
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            {t('settings.voiceAvailableModels')}
          </label>
          <p className="text-[11px] text-text-tertiary mb-4">{t('settings.voiceModelHint')}</p>

          <div className="space-y-1">
            {models.map((model) => {
              const downloadKey = `whisper-model-${model.id}`
              const dl = downloads[downloadKey]
              const isDownloading = !!dl
              const isSelected = model.downloaded && voiceLocalModel === model.id

              return (
                <div
                  key={model.id}
                  className={`rounded-lg border px-4 py-3 transition-colors ${
                    isSelected
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border-primary bg-bg-secondary hover:bg-bg-tertiary'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">{model.name}</span>
                      <span className="text-[11px] text-text-tertiary">
                        ({formatSize(model.sizeMB)})
                      </span>
                      {model.recommended && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent/15 text-accent">
                          Recommended
                        </span>
                      )}
                      {isSelected && <Check size={14} className="text-accent" />}
                    </div>

                    <div className="flex items-center gap-1">
                      {isDownloading ? (
                        <button
                          onClick={() => handleCancelDownload(model.id)}
                          className="p-1.5 rounded-md hover:bg-bg-hover text-text-tertiary hover:text-error transition-colors"
                          title={t('settings.voiceCancelDownload')}
                        >
                          <Loader2 size={14} className="animate-spin" />
                        </button>
                      ) : model.downloaded ? (
                        <>
                          {!isSelected && (
                            <button
                              onClick={() => handleSelectModel(model.id)}
                              className="px-2 py-1 rounded-md text-[11px] text-accent hover:bg-accent/10 transition-colors"
                            >
                              {t('settings.voiceUseModel')}
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(model.id)}
                            className="p-1.5 rounded-md hover:bg-bg-hover text-text-tertiary hover:text-error transition-colors"
                            title={t('settings.voiceDeleteModel')}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleDownload(model.id)}
                          disabled={loading}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
                        >
                          <Download size={12} />
                          {t('settings.voiceDownload')}
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="text-[11px] text-text-tertiary mt-0.5">{model.description}</p>

                  {isDownloading && (
                    <div className="mt-2">
                      <div className="w-full h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
                        <div
                          className="h-full bg-accent rounded-full transition-all duration-300"
                          style={{ width: `${dl.percent}%` }}
                        />
                      </div>
                      <div className="flex justify-between mt-1 text-[10px] text-text-tertiary">
                        <span>{dl.percent}%</span>
                        <span>
                          {formatSpeed(dl.speedBytesPerSec)}
                          {dl.etaSeconds > 0 &&
                            ` · ${formatEta(dl.etaSeconds)} ${t('settings.voiceRemaining')}`}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
// TTS 面板（语音输出）
// ────────────────────────────────────────────────────────────────

/** TTS 语音选项 */
const TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const

/** TTS 语速预设 */
const TTS_SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0] as const

/** 模块级引用，防止 Audio 被 GC */
let testAudio: HTMLAudioElement | null = null

function TtsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { voiceTtsEnabled, voiceTtsVoice, voiceTtsSpeed, voiceTtsModel, providers } =
    useSettingsStore()
  const [testing, setTesting] = useState(false)

  const openaiProvider = providers.find((p) => p.name === 'openai' && p.isBuiltin)
  const openaiReady = !!openaiProvider?.apiKey?.trim() && !!openaiProvider?.isEnabled

  const save = (key: string, value: string): void => {
    window.api.settings.set({ key, value })
  }

  const handleToggleTts = (): void => {
    const next = !voiceTtsEnabled
    useSettingsStore.setState({ voiceTtsEnabled: next })
    save('voice.tts.enabled', String(next))
  }

  const handleVoiceChange = (voice: string): void => {
    useSettingsStore.setState({ voiceTtsVoice: voice })
    save('voice.tts.openai.voice', voice)
  }

  const handleModelChange = (model: string): void => {
    useSettingsStore.setState({ voiceTtsModel: model })
    save('voice.tts.openai.model', model)
  }

  const handleSpeedChange = (speed: number): void => {
    useSettingsStore.setState({ voiceTtsSpeed: speed })
    save('voice.tts.openai.speed', String(speed))
  }

  const handleTest = async (): Promise<void> => {
    if (testing) return
    setTesting(true)
    try {
      // 停止上一次测试播放
      if (testAudio) {
        testAudio.pause()
        testAudio = null
      }
      const result = await window.api.tts.speakOnce({
        text: t('settings.voiceTtsTestText')
      })
      const audio = new Audio(`shuvix-media://${result.filePath}`)
      testAudio = audio
      audio.onended = () => {
        testAudio = null
      }
      audio.onerror = () => {
        testAudio = null
      }
      await audio.play()
    } catch (err) {
      console.error('TTS test failed:', err)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="px-5 py-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{t('settings.voiceTtsTitle')}</h3>
        <p className="text-[11px] text-text-tertiary mt-1">{t('settings.voiceTtsDesc')}</p>
      </div>

      {/* 自动朗读开关 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Volume2 size={12} className="text-text-secondary" />
          <span className="text-xs font-medium text-text-secondary">
            {t('settings.voiceTtsAutoPlay')}
          </span>
        </div>
        <button
          onClick={handleToggleTts}
          className={`relative w-8 h-[18px] rounded-full transition-colors ${
            voiceTtsEnabled ? 'bg-accent' : 'bg-bg-hover'
          }`}
        >
          <span
            className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
              voiceTtsEnabled ? 'left-[16px]' : 'left-[2px]'
            }`}
          />
        </button>
      </div>

      {/* OpenAI 状态提示 */}
      <div
        className={`rounded-lg border px-3 py-2 text-[11px] ${
          openaiReady
            ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
            : 'border-amber-500/30 bg-amber-500/5 text-amber-400'
        }`}
      >
        {openaiReady ? (
          t('settings.voiceTtsReady')
        ) : (
          <span>
            {t('settings.voiceTtsHint')}{' '}
            <button
              onClick={() => window.api.app.openSettings('providers')}
              className="underline hover:text-amber-300 transition-colors"
            >
              {t('settings.voiceGoProviders')}
            </button>
          </span>
        )}
      </div>

      {/* 语音角色 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          {t('settings.voiceTtsVoice')}
        </label>
        <div className="flex flex-wrap gap-1.5">
          {TTS_VOICES.map((voice) => (
            <button
              key={voice}
              onClick={() => handleVoiceChange(voice)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors capitalize ${
                voiceTtsVoice === voice
                  ? 'border-accent text-accent bg-accent/10'
                  : 'border-border-primary text-text-tertiary hover:border-accent/50 hover:text-text-secondary'
              }`}
            >
              {voice}
            </button>
          ))}
        </div>
      </div>

      {/* 模型选择 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          {t('settings.voiceTtsModel')}
        </label>
        <div className="flex gap-1.5">
          {(
            [
              { id: 'tts-1', label: t('settings.voiceTtsModelStandard') },
              { id: 'tts-1-hd', label: t('settings.voiceTtsModelHd') }
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              onClick={() => handleModelChange(opt.id)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                voiceTtsModel === opt.id
                  ? 'border-accent text-accent bg-accent/10'
                  : 'border-border-primary text-text-tertiary hover:border-accent/50 hover:text-text-secondary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* 语速 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          {t('settings.voiceTtsSpeed')}{' '}
          <span className="text-text-tertiary font-normal">{voiceTtsSpeed}x</span>
        </label>
        <div className="flex flex-wrap gap-1.5">
          {TTS_SPEED_OPTIONS.map((speed) => (
            <button
              key={speed}
              onClick={() => handleSpeedChange(speed)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                voiceTtsSpeed === speed
                  ? 'border-accent text-accent bg-accent/10'
                  : 'border-border-primary text-text-tertiary hover:border-accent/50 hover:text-text-secondary'
              }`}
            >
              {speed}x
            </button>
          ))}
        </div>
      </div>

      {/* 测试按钮 */}
      <button
        onClick={handleTest}
        disabled={testing || !openaiReady}
        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {testing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
        {t('settings.voiceTtsTest')}
      </button>
    </div>
  )
}
