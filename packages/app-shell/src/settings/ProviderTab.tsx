/**
 * ProviderTab —— 共享提供商设置（prop 驱动 + 能力开关），从桌面 ProviderSettings 抽出。
 *
 * 数据 `providers` 由宿主传入；所有后端调用走注入的 `api`；写操作后调用 `onChanged()`
 * 让宿主刷新缓存（providers + availableModels）。`caps.providerCrud=false`（扩展）隐藏
 * 增删提供商 / 同步 / 增删模型，仅保留 apiKey 编辑 + 模型启停。删除提供商的确认弹窗由宿主
 * 通过 `onRequestDeleteProvider` 处理（桌面用带资源图标的 ConfirmDialog）。
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Eye,
  EyeOff,
  Save,
  Trash2,
  Plus,
  X,
  SlidersHorizontal,
  TriangleAlert,
  Wrench,
  Brain,
  Image as ImageIcon,
  Mic,
  AlertCircle,
  KeyRound,
  LogOut,
  ExternalLink
} from 'lucide-react'
import {
  API_PROTOCOL_OPTIONS,
  type ProviderInfo,
  type ProviderModelInfo
} from '@shuvix/chat-protocol/types/provider'
import { isImeComposing } from '@shuvix/chat-ui'
import { AddProviderDialog } from './AddProviderDialog'
import { ModelCapabilitiesDialog } from './ModelCapabilitiesDialog'
import { ProviderIcon } from './ProviderIcons'
import {
  SettingsSection,
  SettingsRow,
  SettingsBlock,
  Toggle,
  InlineInput,
  InlineSelect
} from './SettingsPrimitives'

/** 订阅登录状态（宿主查询结果） */
export interface ProviderOAuthTabStatus {
  /** 该提供商是否支持订阅登录 */
  supported: boolean
  /** 支持时是哪一家（pi slug）—— 按它挑 `settings.oauthProviders.<slug>` 的说明文字 */
  slug?: string
  /** 是否已登录 */
  connected: boolean
  /** access token 到期时间（毫秒），未登录为 null */
  expiresAt: number | null
  /** 是否有登录流程正在进行（例如从别的窗口发起的） */
  pending: boolean
}

/** 登录过程中要用户输入的一段文字（浏览器回不到本机时粘贴最后停下的地址） */
export interface ProviderOAuthTabPrompt {
  promptId: string
  /** manual_code = 粘贴地址（用界面自己的说明）；text / secret 显示流程给的原文，secret 遮住 */
  input: 'manual_code' | 'text' | 'secret'
  message: string
  placeholder?: string
}

/**
 * 登录过程事件：设备码（设备码流程）、授权页地址（浏览器流程）、提问开 / 关，或一行进度文字。
 */
export type ProviderOAuthTabEvent =
  | {
      providerId: string
      kind: 'device_code'
      userCode: string
      verificationUri: string
      expiresInSeconds?: number
    }
  | { providerId: string; kind: 'auth_url'; url: string }
  | ({ providerId: string; kind: 'prompt' } & ProviderOAuthTabPrompt)
  | { providerId: string; kind: 'prompt_closed'; promptId: string }
  | { providerId: string; kind: 'message'; message: string }
  /** 登录结束（成功 / 失败 / 取消）—— 不是本组件发起的那次，靠它重查状态 */
  | { providerId: string; kind: 'finished' }

/** 一次登录进行中界面要显示的东西（登录结束即清） */
interface OAuthFlowView {
  device: { userCode: string; verificationUri: string } | null
  /** 浏览器流程的授权页（宿主已自动打开一次，这里留重开入口） */
  authUrl: string | null
  prompt: ProviderOAuthTabPrompt | null
}

const EMPTY_FLOW: OAuthFlowView = { device: null, authUrl: null, prompt: null }

/** 注入的后端契约（桌面绑 window.api.provider；扩展绑 chatApiAdapter.provider） */
export interface ProviderTabApi {
  listModels: (providerId: string) => Promise<ProviderModelInfo[]>
  toggleEnabled: (p: { id: string; isEnabled: boolean }) => Promise<unknown>
  toggleModelEnabled: (p: { id: string; isEnabled: boolean }) => Promise<unknown>
  updateConfig: (p: {
    id: string
    name?: string
    apiKey?: string
    baseUrl?: string
    apiProtocol?: ProviderInfo['apiProtocol']
    metadata?: string
  }) => Promise<unknown>
  add: (p: {
    name: string
    baseUrl: string
    apiKey: string
    apiProtocol: ProviderInfo['apiProtocol']
    metadata?: string
  }) => Promise<unknown>
  addModel: (p: { providerId: string; modelId: string }) => Promise<unknown>
  deleteModel: (id: string) => Promise<unknown>
  syncModels: (p: { providerId: string }) => Promise<{ total: number; added: number }>
  updateModelCapabilities: (p: {
    id: string
    capabilities: Record<string, unknown>
  }) => Promise<unknown>
  /**
   * 订阅登录（可选）——宿主不实现时整块界面不出现。
   *
   * `login` 的 Promise 一直挂到用户在浏览器里批准/超时/取消为止，设备码 / 授权页 / 提问经
   * `onEvent` 单独推来。
   */
  oauth?: {
    status: (providerId: string) => Promise<ProviderOAuthTabStatus>
    /** `cancelled` = 用户自己取消的，不算失败 */
    login: (
      providerId: string
    ) => Promise<{ success: boolean; error?: string; cancelled?: boolean }>
    cancel: (providerId: string) => Promise<unknown>
    logout: (providerId: string) => Promise<unknown>
    /** 回答登录中的提问；不实现时提问不显示（流程照样能靠浏览器回调完成） */
    answer?: (providerId: string, promptId: string, value: string) => Promise<unknown>
    onEvent: (callback: (event: ProviderOAuthTabEvent) => void) => () => void
    /** 打开验证页（桌面 window.api.app.openExternal）—— 登录时宿主已自动打开一次，这是重开入口 */
    openExternal?: (url: string) => void
  }
}

export interface ProviderTabProps {
  providers: ProviderInfo[]
  api: ProviderTabApi
  /** 写操作后刷新宿主缓存（providers + availableModels） */
  onChanged: () => void | Promise<void>
  caps?: { providerCrud?: boolean }
  /** providerCrud 时删除提供商（宿主负责确认弹窗 + 删除 + onChanged） */
  onRequestDeleteProvider?: (provider: ProviderInfo) => void
}

export function ProviderTab({
  providers,
  api,
  onChanged,
  caps,
  onRequestDeleteProvider
}: ProviderTabProps): React.JSX.Element {
  const { t } = useTranslation()
  const providerCrud = caps?.providerCrud ?? true
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [localEdits, setLocalEdits] = useState<
    Record<
      string,
      {
        name?: string
        apiKey?: string
        baseUrl?: string
        apiProtocol?: ProviderInfo['apiProtocol']
        customHeaders?: string
      }
    >
  >({})
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModelInfo[]>>({})
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({})
  const [syncingProviderId, setSyncingProviderId] = useState<string | null>(null)
  const [syncMessages, setSyncMessages] = useState<
    Record<string, { text: string; isError: boolean }>
  >({})
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newModelId, setNewModelId] = useState<Record<string, string>>({})
  const [editingModel, setEditingModel] = useState<{
    id: string
    providerId: string
    modelId: string
    caps: Record<string, unknown>
  } | null>(null)
  // ---- 订阅登录 ----
  const oauthApi = api.oauth
  const [oauthStatus, setOauthStatus] = useState<Record<string, ProviderOAuthTabStatus>>({})
  const [oauthFlow, setOauthFlow] = useState<Record<string, OAuthFlowView | null>>({})
  /**
   * 本组件发起、还在等结果的登录（按 provider）。别处发起的（本页重新挂载之前点的）看
   * `status.pending`，同样显示成进行中、能取消。
   */
  const [oauthBusy, setOauthBusy] = useState<Record<string, boolean>>({})
  /** 同一份，给事件订阅读（订阅只建一次，读 state 会读到旧值） */
  const oauthBusyRef = useRef<Record<string, boolean>>({})
  const markOAuthBusy = (providerId: string, busy: boolean): void => {
    oauthBusyRef.current = { ...oauthBusyRef.current, [providerId]: busy }
    setOauthBusy(oauthBusyRef.current)
  }
  /** 宿主每次渲染都可能给一个新的 onChanged —— 订阅里读最新的，不为它重订阅 */
  const onChangedRef = useRef(onChanged)
  useEffect(() => {
    onChangedRef.current = onChanged
  }, [onChanged])
  const [oauthError, setOauthError] = useState<Record<string, string | null>>({})

  /** 排序：1) 已启用优先；2) 同组内自定义优先 */
  const sortedProviders = useMemo(
    () =>
      [...providers].sort((a, b) => {
        if (a.isEnabled !== b.isEnabled) return a.isEnabled ? -1 : 1
        if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? 1 : -1
        return 0
      }),
    [providers]
  )

  const loadModelsFor = useCallback(
    async (providerId: string): Promise<void> => {
      const models = await api.listModels(providerId)
      setProviderModels((prev) => ({ ...prev, [providerId]: models }))
    },
    [api]
  )

  /** 初始：预加载已启用 provider 的模型（用于无启用模型警告） */
  useEffect(() => {
    const enabledIds = providers.filter((p) => p.isEnabled).map((p) => p.id)
    const missing = enabledIds.filter((id) => !providerModels[id])
    if (missing.length === 0) return
    Promise.all(missing.map((id) => api.listModels(id).then((m) => [id, m] as const)))
      .then((results) => {
        setProviderModels((prev) => {
          const next = { ...prev }
          for (const [id, models] of results) next[id] = models
          return next
        })
      })
      .catch(() => {})
  }, [providers]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 默认选中第一个 provider */
  useEffect(() => {
    if (selectedProviderId) {
      const exists = providers.some((p) => p.id === selectedProviderId)
      if (exists) return
    }
    setSelectedProviderId(sortedProviders.length > 0 ? sortedProviders[0].id : null)
  }, [providers, sortedProviders, selectedProviderId])

  const handleSelectProvider = (providerId: string): void => {
    setSelectedProviderId(providerId)
    if (!providerModels[providerId]) void loadModelsFor(providerId)
  }

  const handleToggleProvider = async (providerId: string, isEnabled: boolean): Promise<void> => {
    await api.toggleEnabled({ id: providerId, isEnabled })
    await onChanged()
  }

  const handleToggleModel = async (
    modelId: string,
    providerId: string,
    isEnabled: boolean
  ): Promise<void> => {
    await api.toggleModelEnabled({ id: modelId, isEnabled })
    await loadModelsFor(providerId)
    await onChanged()
  }

  const updateLocalEdit = (
    providerId: string,
    field: 'name' | 'apiKey' | 'baseUrl' | 'apiProtocol' | 'customHeaders',
    value: string
  ): void => {
    setLocalEdits((prev) => ({ ...prev, [providerId]: { ...prev[providerId], [field]: value } }))
  }

  const getCustomHeaders = (provider: ProviderInfo): string => {
    try {
      const meta = JSON.parse(provider.metadata || '{}')
      return meta.customHeaders ? JSON.stringify(meta.customHeaders, null, 2) : '{}'
    } catch {
      return '{}'
    }
  }

  const buildMetadata = (provider: ProviderInfo, customHeadersStr: string): string => {
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(provider.metadata || '{}')
    } catch {
      /* ignore */
    }
    try {
      meta.customHeaders = JSON.parse(customHeadersStr)
    } catch {
      meta.customHeaders = {}
    }
    return JSON.stringify(meta)
  }

  const hasEdits = (providerId: string): boolean => {
    const edits = localEdits[providerId]
    if (!edits) return false
    const provider = providers.find((p) => p.id === providerId)
    if (!provider) return false
    if (edits.name !== undefined && edits.name !== provider.name) return true
    if (edits.apiKey !== undefined && edits.apiKey !== provider.apiKey) return true
    if (edits.baseUrl !== undefined && edits.baseUrl !== provider.baseUrl) return true
    if (edits.apiProtocol !== undefined && edits.apiProtocol !== provider.apiProtocol) return true
    if (edits.customHeaders !== undefined && edits.customHeaders !== getCustomHeaders(provider))
      return true
    return false
  }

  const handleSaveProvider = async (providerId: string, alsoEnable?: boolean): Promise<void> => {
    const edits = localEdits[providerId]
    const provider = providers.find((p) => p.id === providerId)
    if (!edits || !provider) return
    const updates: {
      name?: string
      apiKey?: string
      baseUrl?: string
      apiProtocol?: ProviderInfo['apiProtocol']
      metadata?: string
    } = {}
    if (edits.name !== undefined && edits.name !== provider.name) updates.name = edits.name
    if (edits.apiKey !== undefined && edits.apiKey !== provider.apiKey)
      updates.apiKey = edits.apiKey
    if (edits.baseUrl !== undefined && edits.baseUrl !== provider.baseUrl)
      updates.baseUrl = edits.baseUrl
    if (edits.apiProtocol !== undefined && edits.apiProtocol !== provider.apiProtocol)
      updates.apiProtocol = edits.apiProtocol
    if (edits.customHeaders !== undefined && edits.customHeaders !== getCustomHeaders(provider))
      updates.metadata = buildMetadata(provider, edits.customHeaders)
    if (Object.keys(updates).length > 0) {
      await api.updateConfig({ id: providerId, ...updates })
    }
    if (alsoEnable) {
      await api.toggleEnabled({ id: providerId, isEnabled: true })
    }
    await onChanged()
    setLocalEdits((prev) => {
      const next = { ...prev }
      delete next[providerId]
      return next
    })
    setSavedIds((prev) => new Set(prev).add(providerId))
    setTimeout(() => {
      setSavedIds((prev) => {
        const next = new Set(prev)
        next.delete(providerId)
        return next
      })
    }, 2000)
  }

  const handleAddProvider = async (provider: {
    name: string
    baseUrl: string
    apiKey: string
    apiProtocol: ProviderInfo['apiProtocol']
    metadata?: string
  }): Promise<void> => {
    await api.add(provider)
    await onChanged()
  }

  const handleAddModel = async (providerId: string): Promise<void> => {
    const modelId = newModelId[providerId]?.trim()
    if (!modelId) return
    await api.addModel({ providerId, modelId })
    await loadModelsFor(providerId)
    await onChanged()
    setNewModelId((prev) => ({ ...prev, [providerId]: '' }))
  }

  const handleDeleteModel = async (modelId: string, providerId: string): Promise<void> => {
    await api.deleteModel(modelId)
    await loadModelsFor(providerId)
    await onChanged()
  }

  const refreshOAuthStatus = useCallback(
    async (providerId: string): Promise<void> => {
      if (!oauthApi) return
      try {
        const status = await oauthApi.status(providerId)
        setOauthStatus((prev) => ({ ...prev, [providerId]: status }))
      } catch (err) {
        // 状态查询失败不该拦住整个设置页：当作不支持处理，用户仍可用 API Key。
        // 但必须留痕 —— 这里静默吞过一次，症状是「某台机器上订阅登录入口就是不出现」，
        // 没有任何报错可查。
        console.warn('[ProviderTab] oauth status query failed', err)
      }
    },
    [oauthApi]
  )

  /** 选中的 provider 换了就查一次登录状态（只有支持的那家会返回 supported） */
  useEffect(() => {
    if (!oauthApi || !selectedProviderId) return
    void refreshOAuthStatus(selectedProviderId)
  }, [oauthApi, selectedProviderId, refreshOAuthStatus])

  /** 登录过程事件：设备码 / 授权页 / 提问要显示出来；进度文字不显示（界面有自己的等待文案） */
  useEffect(() => {
    if (!oauthApi) return
    return oauthApi.onEvent((event) => {
      const patch = (fn: (flow: OAuthFlowView) => OAuthFlowView): void =>
        setOauthFlow((prev) => ({
          ...prev,
          [event.providerId]: fn(prev[event.providerId] ?? EMPTY_FLOW)
        }))
      switch (event.kind) {
        case 'device_code':
          patch((flow) => ({
            ...flow,
            device: { userCode: event.userCode, verificationUri: event.verificationUri }
          }))
          return
        case 'auth_url':
          patch((flow) => ({ ...flow, authUrl: event.url }))
          return
        case 'prompt':
          patch((flow) => ({
            ...flow,
            prompt: {
              promptId: event.promptId,
              input: event.input,
              message: event.message,
              placeholder: event.placeholder
            }
          }))
          return
        case 'prompt_closed':
          patch((flow) =>
            flow.prompt?.promptId === event.promptId ? { ...flow, prompt: null } : flow
          )
          return
        case 'finished':
          // 本组件发起的那次由 handleOAuthLogin 的收尾处理；这里只管没人等的那次
          if (oauthBusyRef.current[event.providerId]) return
          setOauthFlow((prev) => ({ ...prev, [event.providerId]: null }))
          void refreshOAuthStatus(event.providerId).then(() => onChangedRef.current())
      }
    })
  }, [oauthApi, refreshOAuthStatus])

  const handleOAuthLogin = async (providerId: string): Promise<void> => {
    if (!oauthApi) return
    markOAuthBusy(providerId, true)
    setOauthError((prev) => ({ ...prev, [providerId]: null }))
    setOauthFlow((prev) => ({ ...prev, [providerId]: null }))
    try {
      const result = await oauthApi.login(providerId)
      if (!result.success && !result.cancelled) {
        setOauthError((prev) => ({
          ...prev,
          [providerId]: result.error || t('settings.oauthFailed')
        }))
      }
    } catch (err: unknown) {
      setOauthError((prev) => ({
        ...prev,
        [providerId]: err instanceof Error ? err.message : t('settings.oauthFailed')
      }))
    } finally {
      markOAuthBusy(providerId, false)
      setOauthFlow((prev) => ({ ...prev, [providerId]: null }))
      await refreshOAuthStatus(providerId)
      await onChanged()
    }
  }

  const handleOAuthCancel = async (providerId: string): Promise<void> => {
    if (!oauthApi) return
    await oauthApi.cancel(providerId)
    // 取消的是别处发起的那次时没有 Promise 收尾，状态要自己重查（pending 已在取消时落下）
    if (!oauthBusyRef.current[providerId]) await refreshOAuthStatus(providerId)
  }

  /** 提问的答案送回去；输入框由随后的 prompt_closed 收起（答晚了提问已不在，也是它收） */
  const handleOAuthAnswer = async (
    providerId: string,
    promptId: string,
    value: string
  ): Promise<void> => {
    await oauthApi?.answer?.(providerId, promptId, value)
  }

  const handleOAuthLogout = async (providerId: string): Promise<void> => {
    if (!oauthApi) return
    await oauthApi.logout(providerId)
    setOauthError((prev) => ({ ...prev, [providerId]: null }))
    await refreshOAuthStatus(providerId)
    await onChanged()
  }

  const handleSyncModels = async (providerId: string): Promise<void> => {
    setSyncingProviderId(providerId)
    setSyncMessages((prev) => {
      const next = { ...prev }
      delete next[providerId]
      return next
    })
    try {
      const result = await api.syncModels({ providerId })
      await loadModelsFor(providerId)
      await onChanged()
      setSyncMessages((prev) => ({
        ...prev,
        [providerId]: {
          text: t('settings.syncSuccess', { total: result.total, added: result.added }),
          isError: false
        }
      }))
    } catch (err: unknown) {
      setSyncMessages((prev) => ({
        ...prev,
        [providerId]: {
          text: err instanceof Error ? err.message : t('settings.syncFailed'),
          isError: true
        }
      }))
    } finally {
      setSyncingProviderId(null)
    }
  }

  const selectedProvider = providers.find((p) => p.id === selectedProviderId) ?? null

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧：提供商列表 */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {sortedProviders.map((p) => {
            const isSelected = selectedProviderId === p.id
            const hasModels = providerModels[p.id]
            const noEnabledModels =
              !!p.isEnabled && hasModels && !hasModels.some((m) => m.isEnabled)
            return (
              <button
                key={p.id}
                data-provider-row={p.id}
                onClick={() => handleSelectProvider(p.id)}
                className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                  isSelected
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                } ${!p.isEnabled ? 'opacity-60' : ''}`}
              >
                <ProviderIcon name={p.name} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{p.displayName || p.name}</div>
                </div>
                {noEnabledModels && (
                  <TriangleAlert
                    size={10}
                    className="text-amber-500 shrink-0"
                    aria-label={t('settings.noEnabledModels')}
                  />
                )}
                <span onClick={(e) => e.stopPropagation()} className="shrink-0">
                  <Toggle
                    on={!!p.isEnabled}
                    onClick={() => handleToggleProvider(p.id, !p.isEnabled)}
                  />
                </span>
              </button>
            )
          })}
        </div>
        {providerCrud && (
          <div className="border-t border-border-secondary p-2">
            <button
              onClick={() => setShowAddDialog(true)}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
            >
              <Plus size={12} />
              {t('settings.addProvider')}
            </button>
          </div>
        )}
      </div>

      {/* 右侧：详情面板 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selectedProvider ? (
          <ProviderDetail
            provider={selectedProvider}
            providerCrud={providerCrud}
            edits={localEdits[selectedProvider.id] || {}}
            models={providerModels[selectedProvider.id] || []}
            modelSearch={modelSearch[selectedProvider.id] || ''}
            newModelId={newModelId[selectedProvider.id] || ''}
            syncing={syncingProviderId === selectedProvider.id}
            syncMessage={syncMessages[selectedProvider.id] ?? null}
            showKey={!!showKeys[selectedProvider.id]}
            saved={savedIds.has(selectedProvider.id)}
            hasEdits={hasEdits(selectedProvider.id)}
            getCustomHeaders={getCustomHeaders}
            oauth={
              oauthApi && oauthStatus[selectedProvider.id]?.supported
                ? {
                    slug: oauthStatus[selectedProvider.id]?.slug,
                    connected: !!oauthStatus[selectedProvider.id]?.connected,
                    flow: oauthFlow[selectedProvider.id] ?? EMPTY_FLOW,
                    busy:
                      !!oauthBusy[selectedProvider.id] ||
                      !!oauthStatus[selectedProvider.id]?.pending,
                    error: oauthError[selectedProvider.id] ?? null,
                    onLogin: () => void handleOAuthLogin(selectedProvider.id),
                    onCancel: () => void handleOAuthCancel(selectedProvider.id),
                    onLogout: () => void handleOAuthLogout(selectedProvider.id),
                    onAnswer: oauthApi.answer
                      ? (promptId: string, value: string) =>
                          handleOAuthAnswer(selectedProvider.id, promptId, value)
                      : undefined,
                    onOpenVerification: oauthApi.openExternal
                  }
                : null
            }
            onToggleShowKey={() =>
              setShowKeys((prev) => ({
                ...prev,
                [selectedProvider.id]: !prev[selectedProvider.id]
              }))
            }
            onUpdateEdit={(field, value) => updateLocalEdit(selectedProvider.id, field, value)}
            onSave={() =>
              handleSaveProvider(selectedProvider.id, !selectedProvider.isEnabled || undefined)
            }
            onSetModelSearch={(v) =>
              setModelSearch((prev) => ({ ...prev, [selectedProvider.id]: v }))
            }
            onSetNewModelId={(v) =>
              setNewModelId((prev) => ({ ...prev, [selectedProvider.id]: v }))
            }
            onAddModel={() => handleAddModel(selectedProvider.id)}
            onSyncModels={() => handleSyncModels(selectedProvider.id)}
            onToggleModel={(modelId, isEnabled) =>
              handleToggleModel(modelId, selectedProvider.id, isEnabled)
            }
            onDeleteModel={(modelId) => handleDeleteModel(modelId, selectedProvider.id)}
            onEditModel={(model, modelCaps) =>
              setEditingModel({
                id: model.id,
                providerId: selectedProvider.id,
                modelId: model.modelId,
                caps: modelCaps
              })
            }
            onDeleteProvider={() => onRequestDeleteProvider?.(selectedProvider)}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-text-tertiary text-[11px]">
            {t('settings.providerSectionTitle')}
          </div>
        )}
      </div>

      {providerCrud && showAddDialog && (
        <AddProviderDialog onAdd={handleAddProvider} onClose={() => setShowAddDialog(false)} />
      )}

      {editingModel && (
        <ModelCapabilitiesDialog
          modelId={editingModel.modelId}
          capabilities={editingModel.caps}
          onSave={async (newCaps) => {
            await api.updateModelCapabilities({ id: editingModel.id, capabilities: newCaps })
            await loadModelsFor(editingModel.providerId)
          }}
          onClose={() => setEditingModel(null)}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
// 详情面板
// ────────────────────────────────────────────────────────────────

/** 重新打开验证页 / 授权页（登录开始时宿主已自动打开过一次） */
function OAuthReopenButton({
  url,
  onOpen
}: {
  url: string
  onOpen: (url: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      data-oauth-reopen
      onClick={() => onOpen(url)}
      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded text-accent hover:bg-accent/10 transition-colors"
    >
      <ExternalLink size={11} />
      {t('settings.oauthOpenPage')}
    </button>
  )
}

/**
 * 登录流程要的一段输入。浏览器流程里它与本机回调赛跑：回调先到时宿主推 prompt_closed，
 * 这一栏随之消失；只有浏览器回不到本机（在别的机器上登录、回调端口被拦）时才用得上。
 */
function OAuthPromptField({
  prompt,
  onAnswer
}: {
  prompt: ProviderOAuthTabPrompt
  onAnswer: (promptId: string, value: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const canSubmit = value.trim().length > 0 && !sending
  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setSending(true)
    try {
      await onAnswer(prompt.promptId, value.trim())
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] text-text-tertiary leading-relaxed">
        {prompt.input === 'manual_code' ? t('settings.oauthManualLabel') : prompt.message}
      </div>
      <div className="flex items-center gap-2">
        <div className="zen-input-group inline-flex items-center" style={{ width: 320 }}>
          <input
            data-oauth-prompt
            type={prompt.input === 'secret' ? 'password' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => !isImeComposing(e) && e.key === 'Enter' && void submit()}
            placeholder={prompt.placeholder}
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          data-oauth-prompt-submit
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="px-2.5 py-1 text-[11px] rounded-md bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t('settings.oauthManualSubmit')}
        </button>
      </div>
    </div>
  )
}

interface ProviderDetailProps {
  provider: ProviderInfo
  providerCrud: boolean
  edits: {
    name?: string
    apiKey?: string
    baseUrl?: string
    apiProtocol?: ProviderInfo['apiProtocol']
    customHeaders?: string
  }
  models: ProviderModelInfo[]
  modelSearch: string
  newModelId: string
  syncing: boolean
  syncMessage: { text: string; isError: boolean } | null
  showKey: boolean
  saved: boolean
  hasEdits: boolean
  getCustomHeaders: (p: ProviderInfo) => string
  /** 订阅登录（该提供商不支持、或宿主没实现时为 null） */
  oauth: {
    /** 哪一家（pi slug）—— 挑说明文字用；宿主没给时用通用文案 */
    slug?: string
    connected: boolean
    flow: OAuthFlowView
    busy: boolean
    error: string | null
    onLogin: () => void
    onCancel: () => void
    onLogout: () => void
    /** 回答提问；宿主没实现时不显示输入框 */
    onAnswer?: (promptId: string, value: string) => Promise<void>
    onOpenVerification?: (url: string) => void
  } | null
  onToggleShowKey: () => void
  onUpdateEdit: (
    field: 'name' | 'apiKey' | 'baseUrl' | 'apiProtocol' | 'customHeaders',
    value: string
  ) => void
  onSave: () => void
  onSetModelSearch: (v: string) => void
  onSetNewModelId: (v: string) => void
  onAddModel: () => void
  onSyncModels: () => void
  onToggleModel: (modelId: string, isEnabled: boolean) => void
  onDeleteModel: (modelId: string) => void
  onEditModel: (model: ProviderModelInfo, caps: Record<string, unknown>) => void
  onDeleteProvider: () => void
}

function ProviderDetail({
  provider: p,
  providerCrud,
  edits,
  models,
  modelSearch,
  newModelId,
  syncing,
  syncMessage,
  showKey,
  saved,
  hasEdits,
  getCustomHeaders,
  oauth,
  onToggleShowKey,
  onUpdateEdit,
  onSave,
  onSetModelSearch,
  onSetNewModelId,
  onAddModel,
  onSyncModels,
  onToggleModel,
  onDeleteModel,
  onEditModel,
  onDeleteProvider
}: ProviderDetailProps): React.JSX.Element {
  const { t } = useTranslation()

  const query = modelSearch.trim().toLowerCase()
  const sortedModels = [...models].sort((a, b) => b.isEnabled - a.isEnabled)
  const filteredModels = query
    ? sortedModels.filter((m) => m.modelId.toLowerCase().includes(query))
    : sortedModels

  const noEnabledModels = !!p.isEnabled && models.length > 0 && !models.some((m) => m.isEnabled)

  return (
    <div className="flex flex-col">
      <div className="px-5 py-3 border-b border-border-secondary flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <ProviderIcon name={p.name} />
          <h3 className="text-sm font-semibold text-text-primary truncate">
            {p.displayName || p.name}
          </h3>
          {p.baseUrl && (
            <span className="text-[11px] font-mono text-text-tertiary truncate">
              {p.baseUrl.replace(/^https?:\/\//, '')}
            </span>
          )}
        </div>
        {providerCrud && !p.isBuiltin && (
          <button
            onClick={onDeleteProvider}
            className="p-1.5 rounded-md text-error hover:bg-error/10 transition-colors shrink-0"
            title={t('settings.deleteProvider')}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <div className="flex-1 px-5 py-5 space-y-5">
        {noEnabledModels && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <AlertCircle size={12} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-500 leading-relaxed">
              {t('settings.noEnabledModels')}
            </p>
          </div>
        )}

        <SettingsSection title={t('settings.providerConfigGroup')}>
          {!p.isBuiltin && (
            <SettingsRow
              title={t('settings.providerName')}
              control={
                <InlineInput
                  value={edits.name ?? p.name}
                  onChange={(v) => onUpdateEdit('name', v)}
                  placeholder={t('settings.providerNamePlaceholder')}
                  width={260}
                />
              }
            />
          )}
          {oauth && (
            <SettingsBlock
              label={
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound size={12} className="text-text-tertiary" />
                  {t('settings.oauthTitle')}
                </span>
              }
              description={
                oauth.connected
                  ? t('settings.oauthConnectedDesc')
                  : t(`settings.oauthProviders.${oauth.slug}.desc`, {
                      defaultValue: t('settings.oauthDesc')
                    })
              }
            >
              {oauth.connected ? (
                <div className="flex items-center gap-3">
                  <span
                    data-oauth-connected
                    className="inline-flex items-center gap-1.5 text-[11px] text-emerald-500"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    {t('settings.oauthConnected')}
                  </span>
                  <button
                    type="button"
                    data-oauth-signout
                    onClick={oauth.onLogout}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                  >
                    <LogOut size={11} />
                    {t('settings.oauthSignOut')}
                  </button>
                </div>
              ) : oauth.busy ? (
                <div className="space-y-2">
                  {oauth.flow.device ? (
                    <>
                      <div className="text-[11px] text-text-secondary">
                        {t('settings.oauthDeviceHint')}
                      </div>
                      <div
                        data-oauth-device-code
                        className="font-mono text-base tracking-[0.25em] text-text-primary select-all"
                      >
                        {oauth.flow.device.userCode}
                      </div>
                      {oauth.onOpenVerification && (
                        <OAuthReopenButton
                          url={oauth.flow.device.verificationUri}
                          onOpen={oauth.onOpenVerification}
                        />
                      )}
                    </>
                  ) : oauth.flow.authUrl ? (
                    <>
                      <div data-oauth-browser className="text-[11px] text-text-secondary">
                        {t('settings.oauthBrowserHint')}
                      </div>
                      {oauth.onOpenVerification && (
                        <OAuthReopenButton
                          url={oauth.flow.authUrl}
                          onOpen={oauth.onOpenVerification}
                        />
                      )}
                    </>
                  ) : (
                    <div className="text-[11px] text-text-tertiary">
                      {t('settings.oauthWaiting')}
                    </div>
                  )}
                  {oauth.flow.prompt && oauth.onAnswer && (
                    <OAuthPromptField
                      key={oauth.flow.prompt.promptId}
                      prompt={oauth.flow.prompt}
                      onAnswer={oauth.onAnswer}
                    />
                  )}
                  <button
                    type="button"
                    data-oauth-cancel
                    onClick={oauth.onCancel}
                    className="px-2 py-1 text-[11px] rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  data-oauth-signin
                  onClick={oauth.onLogin}
                  className="px-2.5 py-1 text-[11px] rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
                >
                  {t(`settings.oauthProviders.${oauth.slug}.signIn`, {
                    defaultValue: t('settings.oauthSignIn')
                  })}
                </button>
              )}
              {oauth.error && (
                <div data-oauth-error className="text-[11px] text-red-500 leading-relaxed">
                  {oauth.error}
                </div>
              )}
            </SettingsBlock>
          )}
          <SettingsRow
            title="API Key"
            control={
              <div className="zen-input-group inline-flex items-center" style={{ width: 260 }}>
                <input
                  type={showKey ? 'text' : 'password'}
                  value={edits.apiKey ?? p.apiKey}
                  onChange={(e) => onUpdateEdit('apiKey', e.target.value)}
                  placeholder={t('settings.apiKeyPlaceholder', { name: p.displayName || p.name })}
                  className="font-mono"
                />
                <button
                  onClick={onToggleShowKey}
                  className="px-2 text-text-tertiary hover:text-text-primary transition-colors"
                  type="button"
                >
                  {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
            }
          />
          {/* 内置 provider 的 URL/协议由 pi-ai 注册表按 model 决定，用户不可改；
              要自定义 URL/协议请另建自定义提供商 */}
          {!p.isBuiltin && (
            <SettingsRow
              title="Base URL"
              control={
                <InlineInput
                  value={edits.baseUrl ?? p.baseUrl}
                  onChange={(v) => onUpdateEdit('baseUrl', v)}
                  placeholder={t('settings.baseUrlPlaceholder')}
                  monospace
                  width={260}
                />
              }
            />
          )}
          {!p.isBuiltin && (
            <SettingsRow
              title={t('settings.apiProtocol')}
              control={
                <InlineSelect
                  value={edits.apiProtocol ?? p.apiProtocol}
                  onChange={(v) => onUpdateEdit('apiProtocol', v)}
                  width={260}
                >
                  {API_PROTOCOL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {t(opt.labelKey)}
                    </option>
                  ))}
                </InlineSelect>
              }
            />
          )}
          {!p.isBuiltin && (
            <SettingsBlock label={t('settings.customHeaders')}>
              <textarea
                value={edits.customHeaders ?? getCustomHeaders(p)}
                onChange={(e) => onUpdateEdit('customHeaders', e.target.value)}
                placeholder={t('settings.customHeadersPlaceholder')}
                rows={3}
                className="zen-textarea font-mono text-[11px]"
              />
            </SettingsBlock>
          )}
          {(hasEdits || saved) && (
            <div className="px-4 py-3">
              <button
                onClick={onSave}
                disabled={saved || !hasEdits}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  saved
                    ? 'bg-success/20 text-success'
                    : !p.isEnabled
                      ? 'bg-green-600 text-white hover:bg-green-500'
                      : 'bg-accent text-white hover:bg-accent-hover'
                }`}
              >
                <Save size={14} />
                {saved
                  ? t('settings.saved')
                  : !p.isEnabled
                    ? t('settings.saveConfigAndEnable')
                    : t('settings.saveConfig')}
              </button>
            </div>
          )}
        </SettingsSection>

        <SettingsSection
          title={t('settings.modelManagement')}
          headerAction={
            providerCrud ? (
              <button
                onClick={onSyncModels}
                disabled={syncing}
                className="px-2 py-1 text-[11px] rounded text-accent hover:bg-accent/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {syncing ? t('settings.syncing') : t('settings.syncModels')}
              </button>
            ) : undefined
          }
        >
          {syncMessage && (
            <div
              className={`px-4 py-2 text-[11px] leading-relaxed ${
                syncMessage.isError
                  ? 'bg-red-500/5 text-error'
                  : 'bg-emerald-500/5 text-emerald-500'
              }`}
            >
              {syncMessage.text}
            </div>
          )}

          {providerCrud && (
            <div className="px-4 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newModelId}
                  onChange={(e) => onSetNewModelId(e.target.value)}
                  onKeyDown={(e) => !isImeComposing(e) && e.key === 'Enter' && onAddModel()}
                  placeholder={t('settings.addModelPlaceholder')}
                  className="zen-input flex-1 font-mono text-[11px]"
                />
                <button
                  onClick={onAddModel}
                  disabled={!newModelId.trim()}
                  className="px-2.5 py-1 text-[11px] rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  {t('common.add')}
                </button>
              </div>
              <input
                type="text"
                value={modelSearch}
                onChange={(e) => onSetModelSearch(e.target.value)}
                placeholder={t('settings.searchModel')}
                className="zen-input text-[11px]"
              />
            </div>
          )}

          {filteredModels.length === 0 ? (
            <div className="px-4 py-6 text-center text-[11px] text-text-tertiary">
              {t('settings.noMatchingModels')}
            </div>
          ) : (
            filteredModels.map((m) => {
              const modelCaps = (() => {
                try {
                  return JSON.parse(m.capabilities || '{}')
                } catch {
                  return {}
                }
              })()
              return (
                <SettingsRow
                  key={m.id}
                  title={
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-[12px] truncate">{m.modelId}</span>
                      <div className="flex items-center gap-1 shrink-0 text-text-tertiary">
                        {modelCaps.vision && <Eye size={10} />}
                        {modelCaps.functionCalling && <Wrench size={10} />}
                        {modelCaps.reasoning && <Brain size={10} />}
                        {modelCaps.imageOutput && <ImageIcon size={10} />}
                        {modelCaps.audioInput && <Mic size={10} />}
                      </div>
                    </div>
                  }
                  control={
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onEditModel(m, modelCaps)}
                        className="p-1 rounded text-text-tertiary hover:text-text-primary transition-colors"
                        title={t('settings.editCapabilities')}
                      >
                        <SlidersHorizontal size={12} />
                      </button>
                      {providerCrud && (
                        <button
                          onClick={() => onDeleteModel(m.id)}
                          className="p-1 rounded text-text-tertiary hover:text-error transition-colors"
                          title={t('settings.deleteModel')}
                        >
                          <X size={12} />
                        </button>
                      )}
                      <Toggle
                        on={!!m.isEnabled}
                        onClick={() => onToggleModel(m.id, !m.isEnabled)}
                      />
                    </div>
                  }
                />
              )
            })
          )}
        </SettingsSection>
      </div>
    </div>
  )
}
