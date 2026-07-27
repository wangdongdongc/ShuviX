import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Cpu, ScrollText, Wrench, Activity, ChevronRight } from 'lucide-react'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import { getHostApi } from '@shuvix/chat-ui'
import { useDialogClose } from '../../hooks/useDialogClose'

/** 将 token 数格式化为紧凑显示（如 128k） */
function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`
  }
  return String(n)
}

/** 卡片容器 —— 标题行（图标 + 名称 + 右侧附注）+ 内容 */
function InfoCard({
  icon,
  title,
  extra,
  children
}: {
  icon: React.ReactNode
  title: string
  extra?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border-secondary bg-bg-secondary/50">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-secondary">
        <span className="text-text-tertiary">{icon}</span>
        <span className="text-xs font-semibold text-text-primary">{title}</span>
        {extra && <span className="ml-auto text-[11px] text-text-tertiary">{extra}</span>}
      </div>
      <div className="px-3 py-2">{children}</div>
    </div>
  )
}

/** 键值对行（模型 / 运行状态卡片用） */
function InfoRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-24 shrink-0 text-[11px] text-text-tertiary">{label}</span>
      <span className="min-w-0 text-xs text-text-primary break-all">{value}</span>
    </div>
  )
}

/** 单个工具行 —— 点击展开与发给 LLM 一致的 description + 参数名 */
function ToolRow({
  tool,
  paramsLabel
}: {
  tool: AgentRuntimeInfo['tools'][number]
  paramsLabel: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded-md border border-border-secondary/60 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-bg-hover transition-colors"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-text-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="text-xs font-mono text-text-primary">{tool.name}</span>
        <span className="min-w-0 truncate text-[11px] text-text-tertiary">{tool.label}</span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 pt-0.5 space-y-1.5">
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-bg-primary border border-border-secondary/60 px-2 py-1.5 text-[11px] leading-relaxed text-text-secondary">
            {tool.description}
          </pre>
          {tool.parameters.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-text-tertiary">{paramsLabel}</span>
              {tool.parameters.map((p) => (
                <span
                  key={p}
                  className="rounded bg-bg-hover px-1.5 py-0.5 text-[11px] font-mono text-text-secondary"
                >
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export interface AgentInfoDialogProps {
  sessionId: string
  onClose: () => void
}

/**
 * Agent 信息弹窗 —— 只读展示运行时 Agent 对象的实时状态（卡片分组）。
 *
 * 数据经 HostApi.agent.getInfo 直接读自后端内存中的 agent.state（systemPrompt /
 * 工具集 / 模型 / 思考深度），与实际下发给 LLM 的内容零漂移；打开时即时拉取。
 */
export function AgentInfoDialog({ sessionId, onClose }: AgentInfoDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const overlayRef = useRef<HTMLDivElement>(null)
  const { closing, handleClose } = useDialogClose(onClose)
  const [info, setInfo] = useState<AgentRuntimeInfo | null | undefined>(undefined)

  // 打开时即时拉取，保证展示的是当前时刻的 Agent 状态
  useEffect(() => {
    let alive = true
    getHostApi()
      ?.agent.getInfo(sessionId)
      .then((result) => {
        if (alive) setInfo(result)
      })
      .catch(() => {
        if (alive) setInfo(null)
      })
    return () => {
      alive = false
    }
  }, [sessionId])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleOverlayClick = (e: React.MouseEvent): void => {
    if (e.target === overlayRef.current) handleClose()
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col rounded-xl border border-border-primary bg-bg-primary shadow-xl dialog-panel">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-secondary">
          <h3 className="text-sm font-semibold text-text-primary">{t('agentInfo.title')}</h3>
          <button
            onClick={handleClose}
            className="ml-auto p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
          {info === undefined ? (
            <div className="py-8 text-center text-xs text-text-tertiary">
              {t('agentInfo.loading')}
            </div>
          ) : info === null ? (
            <div className="py-8 text-center text-xs text-text-tertiary">
              {t('agentInfo.notInitialized')}
            </div>
          ) : (
            <>
              {/* 模型 */}
              <InfoCard icon={<Cpu size={13} />} title={t('agentInfo.model')}>
                <InfoRow
                  label={t('agentInfo.modelId')}
                  value={
                    <span className="font-mono">
                      {info.model.provider}/{info.model.id}
                    </span>
                  }
                />
                {info.model.name !== info.model.id && (
                  <InfoRow label={t('agentInfo.modelName')} value={info.model.name} />
                )}
                <InfoRow label={t('agentInfo.api')} value={info.model.api} />
                <InfoRow
                  label={t('agentInfo.contextWindow')}
                  value={`${formatTokens(info.model.contextWindow)} tokens`}
                />
                <InfoRow
                  label={t('agentInfo.maxTokens')}
                  value={`${formatTokens(info.model.maxTokens)} tokens`}
                />
                <InfoRow label={t('agentInfo.inputModes')} value={info.model.input.join(' + ')} />
              </InfoCard>

              {/* 运行状态 */}
              <InfoCard icon={<Activity size={13} />} title={t('agentInfo.runtime')}>
                <InfoRow
                  label={t('agentInfo.status')}
                  value={
                    info.isStreaming ? (
                      <span className="text-accent">{t('agentInfo.streaming')}</span>
                    ) : (
                      t('agentInfo.idle')
                    )
                  }
                />
                <InfoRow
                  label={t('agentInfo.thinkingLevel')}
                  value={
                    info.model.reasoning
                      ? info.thinkingLevel
                      : `${info.thinkingLevel} (${t('agentInfo.reasoningUnsupported')})`
                  }
                />
                <InfoRow label={t('agentInfo.messageCount')} value={String(info.messageCount)} />
              </InfoCard>

              {/* 系统提示词 —— 与实际下发给 LLM 的完全一致 */}
              <InfoCard
                icon={<ScrollText size={13} />}
                title={t('agentInfo.systemPrompt')}
                extra={t('agentInfo.charCount', { count: info.systemPrompt.length })}
              >
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-bg-primary border border-border-secondary/60 px-2 py-1.5 text-[11px] leading-relaxed text-text-secondary">
                  {info.systemPrompt || t('agentInfo.emptySystemPrompt')}
                </pre>
              </InfoCard>

              {/* 已装载工具 —— 读自 agent.state.tools */}
              <InfoCard
                icon={<Wrench size={13} />}
                title={t('agentInfo.tools')}
                extra={t('agentInfo.toolCount', { count: info.tools.length })}
              >
                {info.tools.length === 0 ? (
                  <div className="py-2 text-center text-[11px] text-text-tertiary">
                    {t('agentInfo.noTools')}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {info.tools.map((tool) => (
                      <ToolRow key={tool.name} tool={tool} paramsLabel={t('agentInfo.params')} />
                    ))}
                  </div>
                )}
              </InfoCard>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
