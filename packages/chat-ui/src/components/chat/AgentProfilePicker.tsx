import { getHostApi } from '@shuvix/chat-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Check, Settings, TriangleAlert } from 'lucide-react'
import type { AgentProfileSummary } from '@shuvix/chat-protocol/chatApi'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import { DEFAULT_PROFILE_NAME } from '@shuvix/chat-protocol/agentProfile'
import { useChatStore } from '../../stores/chatStore'
import { useClickOutside } from '../../hooks/useClickOutside'

export interface AgentProfilePickerProps {
  /** 生成中禁用：切换会失效运行时，对正在跑的那一轮语义不清 */
  disabled?: boolean
  /**
   * 切换成功后的种子回调（模型 / 工具已由后端写进会话树）：宿主据此同步两个选择器。
   * 无会话时（欢迎页）不会触发 —— 那种情况只记下选择，等建会话时一并应用。
   */
  onApplied?: (applied: {
    model?: { provider: string; model: string; capabilities: ModelCapabilities }
    tools: string[]
  }) => void
}

/**
 * 会话档案选择器 —— 输入卡片底部工具行的第一个选择器（模型 / 工具之前）。
 *
 * 档案决定根 Agent 的系统提示词与内置工具白名单，是「这条消息由谁处理」里最上位的一层，
 * 所以排在最左。选中即粘性生效（写会话设置 + 失效运行时，下一条消息按新档案重建）；
 * 档案声明的模型与 mcp:/skill: 工具由后端作为**种子**写进会话树，回调交给宿主更新
 * 模型/工具选择器 —— 用户可在此基础上继续调整，改的是会话，不回写档案文件。
 *
 * 常态可见性是它存在的一半理由：非 default 档案用 accent 着色，一眼看出「这个会话现在
 * 不是默认人格」；档案文件被删/改名时（settings 还指着旧名）用 warning 色如实显示，
 * 与后端 resolveAgentProfileName 的回落行为一致。
 */
export function AgentProfilePicker({
  disabled,
  onApplied
}: AgentProfilePickerProps = {}): React.JSX.Element | null {
  const { t } = useTranslation()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessionProfile = useChatStore(
    (s) => s.sessions.find((sess) => sess.id === s.activeSessionId)?.settings.agentProfile
  )
  const pendingProfile = useChatStore((s) => s.pendingAgentProfile)
  // 无会话（欢迎页）时选择只记在 store 里，建会话时一并应用
  const current = (activeSessionId ? sessionProfile : pendingProfile) ?? DEFAULT_PROFILE_NAME

  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState<AgentProfileSummary[]>([])
  const [switching, setSwitching] = useState(false)
  // 档案指定的模型没生效时的一次性提示（后端只记日志，用户在界面上也该看得见）
  const [modelWarning, setModelWarning] = useState<string | null>(null)
  const close = useCallback(() => setOpen(false), [])
  useClickOutside(ref, close, open)

  // 档案是纯文件系统驱动的（新建/删除随时发生）→ 挂载时与每次打开都现拉
  const fetchProfiles = useCallback(() => {
    void getHostApi()?.session.listAgentProfiles().then(setProfiles)
  }, [])
  useEffect(() => {
    fetchProfiles()
  }, [fetchProfiles])
  useEffect(() => {
    if (open) fetchProfiles()
  }, [open, fetchProfiles])

  const currentProfile = profiles.find((p) => p.name === current)
  const isDefault = current === DEFAULT_PROFILE_NAME
  // 档案文件已不在（被删/改名）：后端会回落 default 运行，这里如实提示而不是装作没事
  const missing = profiles.length > 0 && !currentProfile

  const pick = async (name: string): Promise<void> => {
    setOpen(false)
    if (name === current) return // 重选当前档案是空操作（避免白白重播一次种子）
    const host = getHostApi()
    if (!host) return
    if (!activeSessionId) {
      useChatStore.getState().setPendingAgentProfile(name)
      return
    }
    setSwitching(true)
    try {
      const res = await host.session.updateAgentProfile({ id: activeSessionId, name })
      if (!res.success) return
      useChatStore.getState().updateSessionSettings(activeSessionId, { agentProfile: name })
      if (res.applied) onApplied?.(res.applied)
      setModelWarning(res.modelUnavailable ?? null)
    } finally {
      setSwitching(false)
    }
  }

  if (!getHostApi()) return null // 渠道端只读，无权改会话配置

  const label = missing ? current : (currentProfile?.displayName ?? current)
  const tone = missing
    ? 'text-warning hover:text-warning'
    : isDefault
      ? 'text-text-tertiary hover:text-text-secondary'
      : 'text-accent hover:text-accent'

  return (
    <div ref={ref} className="relative flex items-center group/agent">
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled || switching}
        className={`inline-flex items-center gap-1 text-[11px] rounded px-1.5 py-0.5 transition-colors border border-transparent hover:border-border-secondary disabled:opacity-50 disabled:hover:border-transparent ${tone} ${
          !isDefault && !missing ? 'bg-accent/10' : ''
        }`}
        title={disabled ? t('agentProfile.disabledWhileStreaming') : undefined}
      >
        {missing ? <TriangleAlert size={10} /> : <Bot size={10} />}
        <span className="max-w-[120px] truncate">{label}</span>
      </button>

      {/* 档案指定的模型不可用：切换成功但模型没换，就地说明一次（点掉即消） */}
      {modelWarning && (
        <button
          type="button"
          onClick={() => setModelWarning(null)}
          className="absolute left-0 bottom-7 z-30 max-w-[280px] rounded-md border border-warning/40 bg-bg-secondary px-2 py-1.5 text-left text-[10px] text-warning shadow-xl"
        >
          {t('agentProfile.modelUnavailable', { ref: modelWarning })}
        </button>
      )}

      {/* 悬浮提示：当前档案的描述（缺失时说明会按 default 运行） */}
      {!open && (missing || currentProfile?.description) && (
        <div className="pointer-events-none absolute left-0 bottom-6 z-20 hidden min-w-[180px] max-w-[280px] rounded-md border border-border-primary bg-bg-secondary px-2 py-1.5 shadow-xl group-hover/agent:block">
          <div className="text-[11px] text-text-primary">
            {missing ? t('agentProfile.missing', { name: current }) : currentProfile?.description}
          </div>
        </div>
      )}

      {open && (
        <div className="picker-panel absolute left-0 bottom-8 z-30 w-[260px] rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden">
          <div className="py-1 max-h-[60vh] overflow-y-auto">
            {profiles.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => void pick(p.name)}
                className="flex items-start gap-1.5 w-full px-2 py-1 text-left hover:bg-bg-hover transition-colors"
              >
                <span className="w-3 shrink-0 pt-0.5 text-accent">
                  {p.name === current && <Check size={11} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[11px] text-text-primary truncate">{p.displayName}</span>
                    {p.source === 'builtin' && (
                      <span className="px-1 py-px rounded text-[9px] font-medium text-amber-500 bg-amber-500/10 whitespace-nowrap shrink-0">
                        {t('input.skillBuiltinBadge')}
                      </span>
                    )}
                    {/* 声明了模型 → 选它会顺带换模型，选之前就看得见 */}
                    {p.model && (
                      <span className="ml-auto text-[9px] text-text-tertiary truncate max-w-[90px] shrink-0">
                        {p.model.split('/').slice(1).join('/') || p.model}
                      </span>
                    )}
                  </span>
                  {p.description && (
                    <span className="block text-[10px] text-text-tertiary truncate">
                      {p.description}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              void getHostApi()?.app.openSettings('agents')
            }}
            className="flex items-center gap-1.5 w-full px-2 py-1.5 border-t border-border-secondary text-[10px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <Settings size={10} />
            {t('agentProfile.manage')}
          </button>
        </div>
      )}
    </div>
  )
}
