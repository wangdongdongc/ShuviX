/**
 * 设置 → 通用 → 网络访问（server mode phase B，docs/server/phase-bc-network-and-web.md §B1；网络策略
 * docs/network-policy/design.md §8）。
 *
 * 一个开关 + 端口：「允许从浏览器访问」开着时监听 0.0.0.0，**谁能连由安全策略 network-admission 定**（2026-10-19，
 * 从前的「允许局域网里的其他设备」开关与「开放给」网卡选项去掉了）。开着时按准入策略的状态给一段引导：
 *  - `builtin`：内置那份只放这台电脑 —— 一行 SSH 隧道的说明，加「让 agent 帮我设置」与「复制提示词」；
 *  - `override`：谁能连由用户自己的 network-admission 决定 —— 一行说明，加「让 agent 帮我调整」与「复制提示词」；
 *  - `disabled`：准入策略被停用，局域网里任何设备都能连 —— 警告，加同样两个按钮。
 * 「让 agent 帮我设置」新建一条会话（不属于项目、勾上 shuvix 知识库），把提示词（networkPolicyPrompt.ts，带着此刻的
 * 端口、地址、连着的设备与它们的设备 ID、最近被拒的几条）填进主窗口那条会话的输入框，不自动发送（web：本标签页
 * 回到聊天）。**风险写在明面上**：远程访问没有密码，策略放进来的设备能完全控制这台电脑。
 *
 * 开着时列出能用来打开的地址（每个可复制）、连着的浏览器（地址、浏览器、设备 ID、连上的时刻，实时）、最近被拒的
 * 请求（哪个阶段、什么、谁、哪条规则、几次）；监听失败（端口被占 …）时一行原因。状态跟着 `network.changed` 重拉。
 *
 * 无头运行（`shuvix --headless`，状态带 `headless: true`）：网络访问开关显示为开、锁住，端口也锁住，各带一句说明 ——
 * 主进程本来就拒绝关掉与换端口，这些由命令行 / 服务文件定。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  Check,
  Copy,
  Globe,
  Laptop,
  MonitorSmartphone,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert
} from 'lucide-react'
import { copyToClipboard, getChatApi, useAppEvent } from '@shuvix/chat-ui'
import {
  isValidNetworkPort,
  type NetworkClientInfo,
  type NetworkDenialInfo,
  type NetworkStatus
} from '../../../../shared/network'
import {
  SettingsSection,
  SettingsRow,
  SettingsBlock,
  Toggle,
  InlineInput
} from './SettingsPrimitives'
import { buildNetworkPolicyPrompt, NETWORK_POLICY_CHAT_KNOWLEDGE } from './networkPolicyPrompt'

/** 监听失败的原因（主进程给的 Node 错误码或消息）→ 人读的一句 */
function errorText(
  t: (key: string, options?: Record<string, unknown>) => string,
  status: NetworkStatus,
  error: string
): string {
  const port = status.port
  if (error === 'EADDRINUSE') return t('settings.networkErrorInUse', { port })
  if (error === 'EACCES') return t('settings.networkErrorAccess', { port })
  return t('settings.networkErrorOther', { port, error })
}

function CopyButton({ text, label }: { text: string; label?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      onClick={() => {
        // 局域网的 http 页面不是安全上下文：copyToClipboard 在那里退回到 execCommand
        copyToClipboard(text)
        setCopied(true)
      }}
      className="inline-flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary"
      title={label ?? t('settings.networkCopy')}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? t('settings.networkCopied') : (label ?? t('settings.networkCopy'))}
    </button>
  )
}

/** 设备 ID 的短写（前 8 位）；完整的在 title 与复制按钮里 */
function shortDevice(device: string): string {
  return device.length > 8 ? `${device.slice(0, 8)}…` : device
}

function ClientRow({ client }: { client: NetworkClientInfo }): React.JSX.Element {
  const { t } = useTranslation()
  const since = new Date(client.connectedAt).toLocaleTimeString()
  return (
    <SettingsRow
      icon={<MonitorSmartphone size={11} className="text-text-tertiary shrink-0" />}
      title={<span data-network-client={client.id}>{client.remoteAddress}</span>}
      subtitle={
        <span className="block max-w-[420px] truncate" title={client.userAgent}>
          {t('settings.networkConnectedSince', { time: since })}
          {client.device ? (
            <span data-network-client-device={client.device} title={client.device}>
              {` · ${t('settings.networkDevice', { id: shortDevice(client.device) })}`}
            </span>
          ) : null}
          {client.userAgent ? ` · ${client.userAgent}` : ''}
        </span>
      }
      control={client.device ? <CopyButton text={client.device} /> : undefined}
    />
  )
}

function DenialRow({ denial }: { denial: NetworkDenialInfo }): React.JSX.Element {
  const { t } = useTranslation()
  const at = new Date(denial.lastAt).toLocaleTimeString()
  const who = [
    denial.address,
    denial.device ? t('settings.networkDevice', { id: shortDevice(denial.device) }) : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <SettingsRow
      icon={<ShieldAlert size={11} className="text-text-tertiary shrink-0" />}
      title={
        <span data-network-denial={denial.stage} className="font-mono text-[11px] select-text">
          {denial.summary}
          {denial.scope ? (
            <span data-network-denial-scope={denial.scope} className="text-text-tertiary">
              {` · ${denial.scope}`}
            </span>
          ) : null}
        </span>
      }
      subtitle={
        <span className="block max-w-[460px] truncate" title={denial.device || undefined}>
          {`${at} · ${who} · ${denial.policies.length > 0 ? denial.policies.join(', ') : denial.rule}`}
          {denial.count > 1 ? ` · ×${denial.count}` : ''}
          {denial.downgraded ? ` · ${t('settings.networkDenialDowngraded')}` : ''}
        </span>
      }
      control={denial.device ? <CopyButton text={denial.device} /> : undefined}
    />
  )
}

/** 准入策略的状态 → 引导（说明 + 两个按钮） */
function AdmissionGuide({
  status,
  onStart,
  starting
}: {
  status: NetworkStatus
  onStart: () => void
  starting: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const admission = status.admission
  const tone =
    admission === 'disabled'
      ? 'text-warning'
      : admission === 'override'
        ? 'text-text-secondary'
        : 'text-text-tertiary'
  const Icon =
    admission === 'disabled' ? TriangleAlert : admission === 'override' ? ShieldCheck : Laptop
  return (
    <SettingsBlock>
      <div data-network-admission={admission} className="space-y-2">
        <div className={`flex items-start gap-2 text-[11px] leading-relaxed ${tone}`}>
          <Icon size={12} className="mt-[2px] shrink-0" />
          <span className="select-text">
            {t(`settings.networkAdmission_${admission}`, { port: status.port })}
          </span>
        </div>
        <div className="flex items-center gap-3 pl-5">
          <button
            type="button"
            data-network-policy-chat
            disabled={starting}
            onClick={onStart}
            className="inline-flex items-center gap-1 rounded-md border border-border-secondary px-2 py-1 text-[11px] text-text-primary hover:bg-bg-hover disabled:opacity-50"
          >
            <Bot size={11} />
            {t(
              admission === 'override'
                ? 'settings.networkPolicyAdjust'
                : 'settings.networkPolicySetUp'
            )}
          </button>
          <span data-network-policy-copy>
            <CopyButton
              text={buildNetworkPolicyPrompt(t, status)}
              label={t('settings.networkPolicyCopyPrompt')}
            />
          </span>
        </div>
      </div>
    </SettingsBlock>
  )
}

export function NetworkAccessSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<NetworkStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  /** 端口输入框的草稿（null = 跟着状态走） */
  const [portDraft, setPortDraft] = useState<string | null>(null)
  const [portInvalid, setPortInvalid] = useState(false)

  const load = useCallback(() => {
    void window.api.network.status().then(setStatus, () => undefined)
  }, [])
  useEffect(load, [load])
  useAppEvent('network.changed', load)

  const toggle = async (): Promise<void> => {
    if (!status || busy) return
    setBusy(true)
    try {
      setStatus(await window.api.network.setEnabled(!status.enabled))
    } catch {
      load()
    } finally {
      setBusy(false)
    }
  }

  const commitPort = async (): Promise<void> => {
    if (portDraft === null || !status) return
    const trimmed = portDraft.trim()
    const port = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
    if (!isValidNetworkPort(port)) {
      setPortInvalid(true)
      return
    }
    setPortInvalid(false)
    setPortDraft(null)
    if (port === status.port) return
    setBusy(true)
    try {
      setStatus(await window.api.network.setPort(port))
    } catch {
      load()
    } finally {
      setBusy(false)
    }
  }

  /**
   * 「让 agent 帮我设置」：新建一条会话（不属于项目），勾上 shuvix 知识库，把提示词交给主窗口那条会话的输入框
   * （不自动发送）
   */
  const startPolicyChat = async (): Promise<void> => {
    if (!status || starting) return
    setStarting(true)
    try {
      const draft = buildNetworkPolicyPrompt(t, status)
      const api = getChatApi()
      const session = await api.session.create({
        projectId: null,
        title: t('settings.networkPolicyChatTitle')
      })
      await api.session.updateKnowledgeBases({
        id: session.id,
        knowledgeBases: [...NETWORK_POLICY_CHAT_KNOWLEDGE]
      })
      await window.api.app.openSessionWithDraft({ sessionId: session.id, draft })
    } catch {
      load()
    } finally {
      setStarting(false)
    }
  }

  const enabled = status?.enabled ?? false
  /** 无头运行：开关与端口都锁住（主进程拒绝关掉与换端口） */
  const headless = status?.headless === true

  return (
    <div className="px-5 pb-5" data-network-settings>
      <SettingsSection title={t('settings.networkTitle')} description={t('settings.networkDesc')}>
        <SettingsRow
          icon={<Globe size={11} className="text-text-tertiary shrink-0" />}
          title={t('settings.networkEnable')}
          control={
            <span data-network-toggle={enabled ? 'on' : 'off'}>
              <Toggle
                on={enabled}
                color="amber"
                disabled={!status || busy || headless}
                onClick={() => void toggle()}
              />
            </span>
          }
        />
        {headless && (
          <SettingsBlock>
            <div data-network-headless className="text-[11px] text-text-tertiary">
              {t('settings.networkHeadlessNote')}
            </div>
          </SettingsBlock>
        )}
        <SettingsBlock>
          <div
            data-network-risk
            className="flex items-start gap-2 text-[11px] leading-relaxed text-warning"
          >
            <TriangleAlert size={12} className="mt-[2px] shrink-0" />
            <span>{t('settings.networkRisk')}</span>
          </div>
        </SettingsBlock>
        {enabled && status && (
          <AdmissionGuide
            status={status}
            starting={starting}
            onStart={() => void startPolicyChat()}
          />
        )}
        <SettingsRow
          title={t('settings.networkPort')}
          subtitle={
            portInvalid ? (
              <span className="text-error">{t('settings.networkPortInvalid')}</span>
            ) : headless ? (
              <span data-network-headless-port>{t('settings.networkHeadlessPortNote')}</span>
            ) : undefined
          }
          control={
            <span data-network-port>
              <InlineInput
                type="number"
                width={96}
                min={1024}
                max={65535}
                monospace
                disabled={!status || busy || headless}
                value={portDraft ?? (status ? String(status.port) : '')}
                onChange={(v) => {
                  setPortDraft(v)
                  setPortInvalid(false)
                }}
                onBlur={() => void commitPort()}
              />
            </span>
          }
        />
        {enabled && status?.error && (
          <SettingsBlock>
            <div data-network-error className="flex items-start gap-2 text-[11px] text-error">
              <TriangleAlert size={12} className="mt-[2px] shrink-0" />
              <span>{errorText(t, status, status.error)}</span>
            </div>
          </SettingsBlock>
        )}
        {enabled && status && !status.listening && !status.error && (
          <SettingsBlock>
            <div className="text-[11px] text-text-tertiary">{t('settings.networkStarting')}</div>
          </SettingsBlock>
        )}
      </SettingsSection>

      {enabled && status?.listening && (
        <div className="mt-5 space-y-5">
          <SettingsSection title={t('settings.networkAddresses')}>
            {status.addresses.map((url) => (
              <SettingsRow
                key={url}
                title={
                  <span data-network-address={url} className="font-mono text-[12px] select-text">
                    {url}
                  </span>
                }
                control={<CopyButton text={url} />}
              />
            ))}
          </SettingsSection>

          <SettingsSection title={t('settings.networkClients')}>
            {status.clients.length === 0 ? (
              <div className="px-4 py-4 text-[11px] text-text-tertiary">
                {t('settings.networkNoClients')}
              </div>
            ) : (
              status.clients.map((client) => <ClientRow key={client.id} client={client} />)
            )}
          </SettingsSection>

          {status.denials.length > 0 && (
            <SettingsSection
              title={t('settings.networkDenials')}
              description={t('settings.networkDenialsDesc')}
            >
              {status.denials.map((denial) => (
                <DenialRow
                  key={`${denial.at}-${denial.stage}-${denial.summary}-${denial.address}`}
                  denial={denial}
                />
              ))}
            </SettingsSection>
          )}
        </div>
      )}
    </div>
  )
}
