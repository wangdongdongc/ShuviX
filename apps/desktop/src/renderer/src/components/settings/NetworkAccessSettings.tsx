/**
 * 设置 → 通用 → 网络访问（server mode phase B，docs/server/phase-bc-network-and-web.md §B1）。
 *
 * 两个开关 + 端口：「允许从浏览器访问」开着时只监听 127.0.0.1（只有这台电脑能连，别处经 SSH 隧道 —— 关着局域网开关时
 * 有一行说明）；其下「允许局域网里的其他设备」开着才监听 0.0.0.0（网络访问关着时这个开关不可点）。开着时列出能用来
 * 打开的地址（每个可复制）、连着的浏览器（地址、浏览器、连上的时刻，实时）；监听失败（端口被占 …）时一行原因。
 * **风险写在明面上**（不只收进 `?` 气泡，紧挨着局域网开关）：允许其他设备后局域网里的任何人都能通过 ShuviX 完全
 * 控制这台电脑，没有密码。状态跟着 `network.changed` 重拉。
 *
 * 无头运行（`shuvix --headless`，状态带 `headless: true`）：网络访问开关显示为开、锁住，局域网开关显示启动时的选择
 * （`--lan`）、锁住，端口也锁住，各带一句说明 —— 主进程本来就拒绝关掉、换共享与换端口（关掉等于把唯一的入口关掉；
 * 后两件让这个浏览器当场断开），这些由命令行 / 服务文件定。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Globe, Laptop, MonitorSmartphone, Network, TriangleAlert } from 'lucide-react'
import { copyToClipboard, useAppEvent } from '@shuvix/chat-ui'
import {
  isValidNetworkPort,
  type NetworkClientInfo,
  type NetworkStatus
} from '../../../../shared/network'
import {
  SettingsSection,
  SettingsRow,
  SettingsBlock,
  Toggle,
  InlineInput
} from './SettingsPrimitives'

/** 监听失败的原因（主进程给的 Node 错误码或消息）→ 人读的一句 */
function errorText(
  t: (key: string, options?: Record<string, unknown>) => string,
  error: string,
  port: number
): string {
  if (error === 'EADDRINUSE') return t('settings.networkErrorInUse', { port })
  if (error === 'EACCES') return t('settings.networkErrorAccess', { port })
  return t('settings.networkErrorOther', { port, error })
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
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
      title={t('settings.networkCopy')}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? t('settings.networkCopied') : t('settings.networkCopy')}
    </button>
  )
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
          {client.userAgent ? ` · ${client.userAgent}` : ''}
        </span>
      }
    />
  )
}

export function NetworkAccessSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<NetworkStatus | null>(null)
  const [busy, setBusy] = useState(false)
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

  const toggleLan = async (): Promise<void> => {
    if (!status || busy) return
    setBusy(true)
    try {
      setStatus(await window.api.network.setLan(!status.lan))
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

  const enabled = status?.enabled ?? false
  const lan = status?.lan ?? false
  /** 无头运行：两个开关与端口都锁住（主进程拒绝关掉、换共享与换端口） */
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
        <SettingsRow
          icon={<Network size={11} className="text-text-tertiary shrink-0" />}
          title={t('settings.networkLan')}
          control={
            <span data-network-lan={lan ? 'on' : 'off'}>
              <Toggle
                on={lan}
                color="amber"
                disabled={!status || busy || headless || !enabled}
                onClick={() => void toggleLan()}
              />
            </span>
          }
        />
        {headless && (
          <SettingsBlock>
            <div data-network-headless-lan className="text-[11px] text-text-tertiary">
              {t('settings.networkHeadlessLanNote')}
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
        {enabled && !lan && status && (
          <SettingsBlock>
            <div
              data-network-local-only
              className="flex items-start gap-2 text-[11px] leading-relaxed text-text-tertiary"
            >
              <Laptop size={12} className="mt-[2px] shrink-0" />
              <span className="select-text">
                {t('settings.networkLocalOnly', { port: status.port })}
              </span>
            </div>
          </SettingsBlock>
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
              <span>{errorText(t, status.error, status.port)}</span>
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
        </div>
      )}
    </div>
  )
}
