import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Trash2, Check, Loader2 } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'

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

/** 语音设置 Tab */
export function VoiceSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const { voiceSttBackend, voiceSttLanguage, voiceLocalModel, providers } = useSettingsStore()

  const [models, setModels] = useState<ModelInfo[]>([])
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  const [loading, setLoading] = useState(false)

  /** 加载本地 Whisper 状态 */
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

  // 监听下载进度
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

        // 下载完成后刷新状态
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

  /** 切换后端 */
  const handleBackendChange = (backend: 'openai' | 'local'): void => {
    useSettingsStore.setState({ voiceSttBackend: backend })
    window.api.settings.set({ key: 'voice.sttBackend', value: backend })
  }

  /** 下载模型 */
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

  /** 删除模型 */
  const handleDelete = async (modelId: string): Promise<void> => {
    await window.api.stt.deleteModel(modelId)
    void loadStatus()
  }

  /** 选中模型 */
  const handleSelectModel = (modelId: string): void => {
    useSettingsStore.setState({ voiceLocalModel: modelId })
    window.api.settings.set({ key: 'voice.localModel', value: modelId })
  }

  /** 取消下载 */
  const handleCancelDownload = (modelId: string): void => {
    window.api.download.cancel(`whisper-model-${modelId}`)
    setDownloads((prev) => {
      const next = { ...prev }
      delete next[`whisper-model-${modelId}`]
      return next
    })
  }

  // OpenAI 配置状态
  const openaiProvider = providers.find((p) => p.name === 'openai' && p.isBuiltin)
  const openaiReady = !!openaiProvider?.apiKey?.trim() && !!openaiProvider?.isEnabled

  return (
    <div className="flex-1 px-5 py-5 space-y-6">
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

      {/* 本地模型列表（仅本地模式显示） */}
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
                  {/* 第一行：名称 + 大小 + 标签 + 操作按钮 */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">{model.name}</span>
                      <span className="text-[11px] text-text-tertiary">({formatSize(model.sizeMB)})</span>
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

                  {/* 第二行：描述 */}
                  <p className="text-[11px] text-text-tertiary mt-0.5">{model.description}</p>

                  {/* 下载进度条 */}
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
                          {dl.etaSeconds > 0 && ` · ${formatEta(dl.etaSeconds)} ${t('settings.voiceRemaining')}`}
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
