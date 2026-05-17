import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Terminal,
  Loader2,
  Plus,
  Trash2,
  Pencil,
  KeyRound,
  Lock,
  X,
  FolderOpen,
  TriangleAlert,
  Database,
  Bot,
  Globe
} from 'lucide-react'
import { SubAgentPanel } from './SubAgentPanel'

/** 子分类标识 */
type ToolSubTab = 'ssh' | 'database' | 'browser' | 'subagent'

/** SSH 凭据信息（来自 IPC） */
interface SshCredentialInfo {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  password: string
  privateKey: string
  passphrase: string
  metadata: { proxyUrl?: string }
  createdAt: number
  updatedAt: number
}

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
      <span className="whitespace-nowrap">{label}</span>
    </button>
  )
}

/** 工具配置页（含子分类侧边栏） */
export function ToolSettings(): React.JSX.Element {
  const [subTab, setSubTab] = useState<ToolSubTab>('ssh')
  const { t } = useTranslation()

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧子分类导航 */}
      <div className="flex-shrink-0 border-r border-border-secondary py-4 px-2.5 space-y-0.5">
        <SubTabButton
          icon={<Terminal size={13} />}
          label={t('tool.sshLabel')}
          active={subTab === 'ssh'}
          onClick={() => setSubTab('ssh')}
        />
        <SubTabButton
          icon={<Database size={13} />}
          label={t('tool.remoteDbLabel')}
          active={subTab === 'database'}
          onClick={() => setSubTab('database')}
        />
        <SubTabButton
          icon={<Globe size={13} />}
          label={t('tool.browserLabel')}
          active={subTab === 'browser'}
          onClick={() => setSubTab('browser')}
        />
        <SubTabButton
          icon={<Bot size={13} />}
          label={t('tool.subAgentTab')}
          active={subTab === 'subagent'}
          onClick={() => setSubTab('subagent')}
        />
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {subTab === 'ssh' && <SshToolPanel />}
        {subTab === 'database' && <DatabaseToolPanel />}
        {subTab === 'browser' && <BrowserToolPanel />}
        {subTab === 'subagent' && <SubAgentPanel />}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
// Browser 工具面板
// ────────────────────────────────────────────────────────────────

interface SavedSite {
  host: string
  cookieCount: number
}

function BrowserToolPanel(): React.JSX.Element {
  const { t } = useTranslation()

  const [ignoreCert, setIgnoreCert] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sites, setSites] = useState<SavedSite[]>([])
  const [sitesLoading, setSitesLoading] = useState(true)
  const [confirmHost, setConfirmHost] = useState<string | null>(null)
  const [clearingHost, setClearingHost] = useState<string | null>(null)
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const [clearingAll, setClearingAll] = useState(false)

  const loadSites = useCallback(async () => {
    setSitesLoading(true)
    try {
      const list = await window.api.browserData.listSites()
      setSites(list)
    } finally {
      setSitesLoading(false)
    }
  }, [])

  useEffect(() => {
    window.api.settings.getAll().then((settings) => {
      setIgnoreCert(settings['tool.browser.ignoreCertificateErrors'] === 'true')
      setLoading(false)
    })
    loadSites()
  }, [loadSites])

  const handleToggle = (): void => {
    const next = !ignoreCert
    setIgnoreCert(next)
    window.api.settings.set({
      key: 'tool.browser.ignoreCertificateErrors',
      value: String(next)
    })
  }

  const handleClearSite = async (host: string): Promise<void> => {
    setClearingHost(host)
    try {
      await window.api.browserData.clearSite(host)
      await loadSites()
    } finally {
      setClearingHost(null)
      setConfirmHost(null)
    }
  }

  const handleClearAll = async (): Promise<void> => {
    setClearingAll(true)
    try {
      await window.api.browserData.clearAll()
      await loadSites()
    } finally {
      setClearingAll(false)
      setConfirmClearAll(false)
    }
  }

  return (
    <div className="px-5 py-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">
          {t('settings.toolBrowserTitle')}
        </h3>
        <p className="text-[11px] text-text-tertiary mt-1">{t('settings.toolBrowserDesc')}</p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-text-tertiary py-2">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
        </div>
      )}

      {!loading && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe size={12} className="text-text-secondary" />
              <span className="text-xs font-medium text-text-secondary">
                {t('settings.toolBrowserIgnoreCertificateErrors')}
              </span>
            </div>
            <button
              onClick={handleToggle}
              className={`relative w-8 h-[18px] rounded-full transition-colors ${
                ignoreCert ? 'bg-accent' : 'bg-bg-hover'
              }`}
            >
              <span
                className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                  ignoreCert ? 'left-[16px]' : 'left-[2px]'
                }`}
              />
            </button>
          </div>
          <p className="text-[10px] text-text-tertiary -mt-1">
            {t('settings.toolBrowserIgnoreCertificateErrorsHint')}
          </p>

          {ignoreCert && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
              <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
              <p className="text-[10px] text-text-secondary leading-relaxed">
                {t('settings.toolBrowserSecurityWarning')}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ────── 已保存站点 ────── */}
      <div className="pt-2">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-xs font-semibold text-text-primary">
              {t('settings.toolBrowserSavedSitesTitle')}
            </h4>
            <p className="text-[10px] text-text-tertiary mt-0.5">
              {t('settings.toolBrowserSavedSitesDesc')}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {sites.length > 0 &&
              (confirmClearAll ? (
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={handleClearAll}
                    disabled={clearingAll}
                    className="px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/10 rounded transition-colors disabled:opacity-50 flex items-center gap-1"
                  >
                    {clearingAll && <Loader2 size={9} className="animate-spin" />}
                    {t('common.confirm')}
                  </button>
                  <button
                    onClick={() => setConfirmClearAll(false)}
                    disabled={clearingAll}
                    className="px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-secondary rounded transition-colors disabled:opacity-50"
                  >
                    {t('ssh.cancel')}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmClearAll(true)}
                  className="text-[10px] text-text-tertiary hover:text-danger transition-colors"
                >
                  {t('settings.toolBrowserClearAll')}
                </button>
              ))}
            <button
              onClick={loadSites}
              disabled={sitesLoading}
              className="text-[10px] text-text-tertiary hover:text-text-secondary disabled:opacity-50 transition-colors"
            >
              {sitesLoading ? <Loader2 size={11} className="animate-spin" /> : t('common.refresh')}
            </button>
          </div>
        </div>

        {sitesLoading && sites.length === 0 ? (
          <div className="flex items-center gap-2 text-text-tertiary py-2">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
          </div>
        ) : sites.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-[11px] text-text-tertiary">{t('settings.toolBrowserNoSites')}</p>
          </div>
        ) : (
          <div className="divide-y divide-border-primary/60 border border-border-primary/60 rounded-lg overflow-hidden bg-bg-tertiary/30">
            {sites.map((site) => (
              <div
                key={site.host}
                className="group flex items-center gap-2 px-2.5 py-1 hover:bg-bg-hover/40 transition-colors"
              >
                <Globe size={10} className="text-text-tertiary shrink-0" />
                <span className="text-[11px] text-text-primary truncate font-mono flex-1 min-w-0">
                  {site.host}
                </span>
                <span className="text-[10px] text-text-tertiary tabular-nums shrink-0">
                  {site.cookieCount}
                </span>
                {confirmHost === site.host ? (
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => handleClearSite(site.host)}
                      disabled={clearingHost === site.host}
                      className="px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/10 rounded transition-colors disabled:opacity-50 flex items-center gap-1"
                    >
                      {clearingHost === site.host && <Loader2 size={9} className="animate-spin" />}
                      {t('common.confirm')}
                    </button>
                    <button
                      onClick={() => setConfirmHost(null)}
                      disabled={clearingHost === site.host}
                      className="px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-secondary rounded transition-colors disabled:opacity-50"
                    >
                      {t('ssh.cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmHost(site.host)}
                    className="p-0.5 text-text-tertiary hover:text-danger transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                    title={t('settings.toolBrowserClearSite')}
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
// SSH 工具面板
// ────────────────────────────────────────────────────────────────

function SshToolPanel(): React.JSX.Element {
  const { t } = useTranslation()

  const [sshCredentials, setSshCredentials] = useState<SshCredentialInfo[]>([])
  const [showSshForm, setShowSshForm] = useState(false)
  const [sshEditId, setSshEditId] = useState<string | null>(null)
  const [sshFormName, setSshFormName] = useState('')
  const [sshFormHost, setSshFormHost] = useState('')
  const [sshFormPort, setSshFormPort] = useState('22')
  const [sshFormUsername, setSshFormUsername] = useState('')
  const [sshFormAuthType, setSshFormAuthType] = useState<'password' | 'key'>('password')
  const [sshFormPassword, setSshFormPassword] = useState('')
  const [sshFormPrivateKey, setSshFormPrivateKey] = useState('')
  const [sshFormKeyFileName, setSshFormKeyFileName] = useState('')
  const [sshFormPassphrase, setSshFormPassphrase] = useState('')
  const [sshFormProxyUrl, setSshFormProxyUrl] = useState('')
  const [sshSaving, setSshSaving] = useState(false)
  const [sshError, setSshError] = useState('')
  const [deletingSshId, setDeletingSshId] = useState<string | null>(null)

  const loadSshCredentials = useCallback(async () => {
    const list = await window.api.sshCredential.list()
    setSshCredentials(list)
  }, [])

  useEffect(() => {
    loadSshCredentials()
  }, [loadSshCredentials])

  const resetSshForm = (): void => {
    setShowSshForm(false)
    setSshEditId(null)
    setSshFormName('')
    setSshFormHost('')
    setSshFormPort('22')
    setSshFormUsername('')
    setSshFormAuthType('password')
    setSshFormPassword('')
    setSshFormPrivateKey('')
    setSshFormKeyFileName('')
    setSshFormPassphrase('')
    setSshFormProxyUrl('')
    setSshError('')
  }

  const startSshEdit = (cred: SshCredentialInfo): void => {
    setSshEditId(cred.id)
    setSshFormName(cred.name)
    setSshFormHost(cred.host)
    setSshFormPort(String(cred.port))
    setSshFormUsername(cred.username)
    setSshFormAuthType(cred.authType)
    setSshFormPassword(cred.authType === 'password' ? cred.password : '')
    setSshFormPrivateKey(cred.authType === 'key' ? cred.privateKey : '')
    setSshFormKeyFileName('')
    setSshFormPassphrase(cred.authType === 'key' ? cred.passphrase : '')
    setSshFormProxyUrl(cred.metadata?.proxyUrl ?? '')
    setSshError('')
    setShowSshForm(true)
  }

  const handleSshSave = async (): Promise<void> => {
    if (!sshFormName.trim() || !sshFormHost.trim() || !sshFormUsername.trim()) return
    setSshSaving(true)
    setSshError('')
    try {
      const data = {
        name: sshFormName.trim(),
        host: sshFormHost.trim(),
        port: parseInt(sshFormPort, 10) || 22,
        username: sshFormUsername.trim(),
        authType: sshFormAuthType as 'password' | 'key',
        password: sshFormAuthType === 'password' ? sshFormPassword : '',
        privateKey: sshFormAuthType === 'key' ? sshFormPrivateKey : '',
        passphrase: sshFormAuthType === 'key' ? sshFormPassphrase : '',
        metadata: { proxyUrl: sshFormProxyUrl.trim() || undefined }
      }
      if (sshEditId) {
        await window.api.sshCredential.update({ id: sshEditId, ...data })
      } else {
        await window.api.sshCredential.add(data)
      }
      await loadSshCredentials()
      resetSshForm()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      setSshError(message.includes('already exists') ? t('settings.toolSshDuplicateName') : message)
    } finally {
      setSshSaving(false)
    }
  }

  const handleSshDelete = async (id: string): Promise<void> => {
    await window.api.sshCredential.delete(id)
    await loadSshCredentials()
    setDeletingSshId(null)
  }

  const handleBrowseKey = async (): Promise<void> => {
    const result = await window.electron.ipcRenderer.invoke('dialog:readTextFile', {
      title: t('ssh.selectKeyFile'),
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (result?.content) {
      setSshFormPrivateKey(result.content)
      const name = (result.path as string).split(/[/\\]/).pop() || ''
      setSshFormKeyFileName(name)
    }
  }

  const sshFormValid =
    sshFormName.trim() &&
    sshFormHost.trim() &&
    sshFormUsername.trim() &&
    (sshFormAuthType === 'password' ? sshFormPassword.trim() : sshFormPrivateKey.trim())

  const inputCls = 'zen-input'

  return (
    <div className="px-5 py-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{t('settings.toolSshTitle')}</h3>
        <p className="text-[11px] text-text-tertiary mt-1">{t('settings.toolSshDesc')}</p>
      </div>

      {/* 安全提示 */}
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
        <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-[10px] text-text-secondary leading-relaxed">
          {t('settings.toolSshSecurityWarning')}
        </p>
      </div>

      {/* 添加按钮 */}
      {!showSshForm && (
        <button
          onClick={() => {
            resetSshForm()
            setShowSshForm(true)
          }}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-border-secondary text-xs text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
        >
          <Plus size={14} />
          {t('settings.toolSshAdd')}
        </button>
      )}

      {/* 添加/编辑表单 */}
      {showSshForm && (
        <div className="border border-accent/30 rounded-lg p-4 space-y-3 bg-accent/5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-primary">
              {sshEditId ? t('settings.toolSshName') : t('settings.toolSshAdd')}
            </span>
            <button onClick={resetSshForm} className="text-text-tertiary hover:text-text-primary">
              <X size={14} />
            </button>
          </div>

          {/* 凭据名称 */}
          <div>
            <label className="block text-[10px] text-text-tertiary mb-1">
              {t('settings.toolSshName')}
            </label>
            <input
              value={sshFormName}
              onChange={(e) => setSshFormName(e.target.value)}
              placeholder={t('settings.toolSshNamePlaceholder')}
              className={inputCls}
            />
            <p className="text-[9px] text-text-tertiary mt-0.5">{t('settings.toolSshNameHint')}</p>
          </div>

          {/* 主机 + 端口 */}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-[10px] text-text-tertiary mb-1">{t('ssh.host')}</label>
              <input
                value={sshFormHost}
                onChange={(e) => setSshFormHost(e.target.value)}
                placeholder="192.168.1.100"
                className={inputCls}
              />
            </div>
            <div className="w-20">
              <label className="block text-[10px] text-text-tertiary mb-1">{t('ssh.port')}</label>
              <input
                value={sshFormPort}
                onChange={(e) => setSshFormPort(e.target.value)}
                placeholder="22"
                className={inputCls}
              />
            </div>
          </div>

          {/* 用户名 */}
          <div>
            <label className="block text-[10px] text-text-tertiary mb-1">{t('ssh.username')}</label>
            <input
              value={sshFormUsername}
              onChange={(e) => setSshFormUsername(e.target.value)}
              placeholder="root"
              className={inputCls}
            />
          </div>

          {/* 认证模式切换 */}
          <div className="flex gap-1 mt-0.5">
            <button
              onClick={() => setSshFormAuthType('password')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                sshFormAuthType === 'password'
                  ? 'bg-accent/15 text-accent border border-accent/30'
                  : 'bg-bg-primary/30 text-text-tertiary border border-transparent hover:text-text-secondary'
              }`}
            >
              <Lock size={11} />
              {t('settings.toolSshAuthPassword')}
            </button>
            <button
              onClick={() => setSshFormAuthType('key')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                sshFormAuthType === 'key'
                  ? 'bg-accent/15 text-accent border border-accent/30'
                  : 'bg-bg-primary/30 text-text-tertiary border border-transparent hover:text-text-secondary'
              }`}
            >
              <KeyRound size={11} />
              {t('settings.toolSshAuthKey')}
            </button>
          </div>

          {/* 密码模式 */}
          {sshFormAuthType === 'password' && (
            <div>
              <label className="block text-[10px] text-text-tertiary mb-1">
                {t('ssh.password')}
              </label>
              <input
                type="password"
                value={sshFormPassword}
                onChange={(e) => setSshFormPassword(e.target.value)}
                placeholder="••••••••"
                className={inputCls}
              />
            </div>
          )}

          {/* 密钥模式 */}
          {sshFormAuthType === 'key' && (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] text-text-tertiary">{t('ssh.privateKey')}</label>
                  <button
                    onClick={handleBrowseKey}
                    className="flex items-center gap-0.5 text-[10px] text-accent hover:text-accent/80 transition-colors"
                  >
                    <FolderOpen size={10} />
                    {t('settings.toolSshBrowseKey')}
                  </button>
                </div>
                {sshFormKeyFileName ? (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-bg-tertiary border border-accent/30 text-text-primary">
                    <KeyRound size={11} className="text-accent flex-shrink-0" />
                    <span className="truncate">{sshFormKeyFileName}</span>
                    <button
                      onClick={() => {
                        setSshFormPrivateKey('')
                        setSshFormKeyFileName('')
                      }}
                      className="ml-auto text-text-tertiary hover:text-danger text-[10px]"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ) : (
                  <textarea
                    value={sshFormPrivateKey}
                    onChange={(e) => setSshFormPrivateKey(e.target.value)}
                    placeholder={t('settings.toolSshPrivateKeyPlaceholder')}
                    rows={3}
                    className="zen-textarea font-mono text-[10px] leading-relaxed"
                  />
                )}
              </div>
              <div>
                <label className="block text-[10px] text-text-tertiary mb-1">
                  {t('ssh.passphrase')}
                </label>
                <input
                  type="password"
                  value={sshFormPassphrase}
                  onChange={(e) => setSshFormPassphrase(e.target.value)}
                  placeholder={t('settings.toolSshPassphrasePlaceholder')}
                  className={inputCls}
                />
              </div>
            </>
          )}

          {/* SOCKS 代理 */}
          <div>
            <label className="block text-[10px] text-text-tertiary mb-1">
              {t('settings.toolSshProxyUrl')}
            </label>
            <input
              value={sshFormProxyUrl}
              onChange={(e) => setSshFormProxyUrl(e.target.value)}
              placeholder={t('settings.toolSshProxyUrlPlaceholder')}
              className={inputCls}
            />
            <p className="text-[9px] text-text-tertiary mt-0.5">
              {t('settings.toolSshProxyUrlHint')}
            </p>
          </div>

          {/* 错误提示 */}
          {sshError && <p className="text-[10px] text-danger">{sshError}</p>}

          {/* 操作按钮 */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleSshSave}
              disabled={!sshFormValid || sshSaving}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {sshSaving
                ? t('settings.toolSshSaving')
                : sshEditId
                  ? t('common.save')
                  : t('common.add')}
            </button>
            <button
              onClick={resetSshForm}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('ssh.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* 凭据列表 */}
      {sshCredentials.length > 0 ? (
        <div className="space-y-1.5">
          {sshCredentials.map((cred) => (
            <div
              key={cred.id}
              className="flex items-center justify-between px-3 py-2 rounded-lg bg-bg-tertiary/50 border border-border-primary hover:border-border-secondary transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-text-primary truncate">
                    {cred.name}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 text-[9px] rounded-md ${
                      cred.authType === 'key'
                        ? 'bg-blue-500/15 text-blue-400'
                        : 'bg-green-500/15 text-green-400'
                    }`}
                  >
                    {cred.authType === 'key'
                      ? t('settings.toolSshAuthKey')
                      : t('settings.toolSshAuthPassword')}
                  </span>
                </div>
                <p className="text-[10px] text-text-tertiary mt-0.5 font-mono truncate">
                  {cred.username}@{cred.host}:{cred.port}
                </p>
              </div>
              <div className="flex items-center gap-1 ml-2">
                <button
                  onClick={() => startSshEdit(cred)}
                  className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                  title="Edit"
                >
                  <Pencil size={12} />
                </button>
                {deletingSshId === cred.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleSshDelete(cred.id)}
                      className="px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/10 rounded transition-colors"
                    >
                      {t('common.confirm')}
                    </button>
                    <button
                      onClick={() => setDeletingSshId(null)}
                      className="px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-secondary rounded transition-colors"
                    >
                      {t('ssh.cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeletingSshId(cred.id)}
                    className="p-1 text-text-tertiary hover:text-danger transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        !showSshForm && (
          <div className="text-center py-4">
            <p className="text-[11px] text-text-tertiary">{t('settings.toolSshEmpty')}</p>
            <p className="text-[10px] text-text-tertiary mt-0.5">
              {t('settings.toolSshEmptyHint')}
            </p>
          </div>
        )
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
// Database 工具面板
// ────────────────────────────────────────────────────────────────

interface DbCredentialInfo {
  id: string
  name: string
  dbType: 'mysql' | 'postgresql'
  host: string
  port: number
  username: string
  database: string
  readonly: boolean
  createdAt: number
  updatedAt: number
}

function DatabaseToolPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [credentials, setCredentials] = useState<DbCredentialInfo[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [formError, setFormError] = useState('')

  const [formName, setFormName] = useState('')
  const [formDbType, setFormDbType] = useState<'mysql' | 'postgresql'>('mysql')
  const [formHost, setFormHost] = useState('')
  const [formPort, setFormPort] = useState('3306')
  const [formUsername, setFormUsername] = useState('')
  const [formPassword, setFormPassword] = useState('')
  const [formDatabase, setFormDatabase] = useState('')
  const [formReadonly, setFormReadonly] = useState(true)

  const loadCredentials = useCallback(async () => {
    const list = await window.api.dbCredential.list()
    setCredentials(list as DbCredentialInfo[])
  }, [])

  useEffect(() => {
    loadCredentials()
  }, [loadCredentials])

  const resetForm = (): void => {
    setShowForm(false)
    setEditId(null)
    setFormName('')
    setFormDbType('mysql')
    setFormHost('')
    setFormPort('3306')
    setFormUsername('')
    setFormPassword('')
    setFormDatabase('')
    setFormReadonly(true)
    setFormError('')
    setTestResult(null)
  }

  const startEdit = (cred: DbCredentialInfo): void => {
    setEditId(cred.id)
    setFormName(cred.name)
    setFormDbType(cred.dbType)
    setFormHost(cred.host)
    setFormPort(String(cred.port))
    setFormUsername(cred.username)
    setFormPassword('')
    setFormDatabase(cred.database)
    setFormReadonly(cred.readonly)
    setFormError('')
    setTestResult(null)
    setShowForm(true)
  }

  const handleDbTypeChange = (dbType: 'mysql' | 'postgresql'): void => {
    setFormDbType(dbType)
    setFormPort(dbType === 'mysql' ? '3306' : '5432')
  }

  const handleTest = async (): Promise<void> => {
    if (!formHost.trim() || !formUsername.trim() || !formPassword.trim() || !formDatabase.trim())
      return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.dbCredential.testConnection({
        dbType: formDbType,
        host: formHost.trim(),
        port: parseInt(formPort, 10) || (formDbType === 'mysql' ? 3306 : 5432),
        username: formUsername.trim(),
        password: formPassword,
        database: formDatabase.trim()
      })
      setTestResult(result as { success: boolean; error?: string })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!formName.trim() || !formHost.trim() || !formUsername.trim() || !formDatabase.trim()) return
    if (!editId && !formPassword.trim()) return
    setSaving(true)
    setFormError('')
    try {
      const data = {
        name: formName.trim(),
        dbType: formDbType,
        host: formHost.trim(),
        port: parseInt(formPort, 10) || (formDbType === 'mysql' ? 3306 : 5432),
        username: formUsername.trim(),
        password: formPassword,
        database: formDatabase.trim(),
        readonly: formReadonly
      }
      if (editId) {
        await window.api.dbCredential.update({ id: editId, ...data })
      } else {
        await window.api.dbCredential.add(data)
      }
      await loadCredentials()
      resetForm()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      setFormError(message.includes('already exists') ? t('settings.toolDbDuplicateName') : message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    await window.api.dbCredential.delete(id)
    await loadCredentials()
    setDeletingId(null)
  }

  const formValid =
    formName.trim() &&
    formHost.trim() &&
    formUsername.trim() &&
    formDatabase.trim() &&
    (editId || formPassword.trim())

  const inputCls = 'zen-input'

  return (
    <div className="px-5 py-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{t('settings.toolDbTitle')}</h3>
        <p className="text-[11px] text-text-tertiary mt-1">{t('settings.toolDbDesc')}</p>
      </div>

      <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
        <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-[10px] text-text-secondary leading-relaxed">
          {t('settings.toolDbSecurityWarning')}
        </p>
      </div>

      {!showForm && (
        <button
          onClick={() => {
            resetForm()
            setShowForm(true)
          }}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-border-secondary text-xs text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
        >
          <Plus size={14} />
          {t('settings.toolDbAdd')}
        </button>
      )}

      {showForm && (
        <div className="border border-accent/30 rounded-lg p-4 space-y-3 bg-accent/5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-primary">
              {editId ? t('settings.toolDbName') : t('settings.toolDbAdd')}
            </span>
            <button onClick={resetForm} className="text-text-tertiary hover:text-text-primary">
              <X size={14} />
            </button>
          </div>

          <div>
            <label className="block text-[10px] text-text-tertiary mb-1">
              {t('settings.toolDbName')}
            </label>
            <input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t('settings.toolDbNamePlaceholder')}
              className={inputCls}
            />
            <p className="text-[9px] text-text-tertiary mt-0.5">{t('settings.toolDbNameHint')}</p>
          </div>

          <div>
            <label className="block text-[10px] text-text-tertiary mb-1">
              {t('settings.toolDbType')}
            </label>
            <div className="flex gap-1">
              {(['mysql', 'postgresql'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => handleDbTypeChange(type)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    formDbType === type
                      ? 'bg-accent/15 text-accent border border-accent/30'
                      : 'bg-bg-primary/30 text-text-tertiary border border-transparent hover:text-text-secondary'
                  }`}
                >
                  <Database size={11} />
                  {type === 'mysql' ? 'MySQL' : 'PostgreSQL'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-[10px] text-text-tertiary mb-1">
                {t('settings.toolDbHost')}
              </label>
              <input
                value={formHost}
                onChange={(e) => setFormHost(e.target.value)}
                placeholder="localhost"
                className={inputCls}
              />
            </div>
            <div className="w-20">
              <label className="block text-[10px] text-text-tertiary mb-1">
                {t('settings.toolDbPort')}
              </label>
              <input
                value={formPort}
                onChange={(e) => setFormPort(e.target.value)}
                placeholder={formDbType === 'mysql' ? '3306' : '5432'}
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] text-text-tertiary mb-1">
              {t('settings.toolDbUsername')}
            </label>
            <input
              value={formUsername}
              onChange={(e) => setFormUsername(e.target.value)}
              placeholder="root"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-[10px] text-text-tertiary mb-1">
              {t('settings.toolDbPassword')}
              {editId && (
                <span className="text-text-tertiary ml-1">
                  ({t('settings.toolDbPasswordEditHint')})
                </span>
              )}
            </label>
            <input
              type="password"
              value={formPassword}
              onChange={(e) => setFormPassword(e.target.value)}
              placeholder={editId ? t('settings.toolDbPasswordKeepPlaceholder') : ''}
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-[10px] text-text-tertiary mb-1">
              {t('settings.toolDbDatabase')}
            </label>
            <input
              value={formDatabase}
              onChange={(e) => setFormDatabase(e.target.value)}
              placeholder="mydb"
              className={inputCls}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] text-text-primary">{t('settings.toolDbReadonly')}</p>
              <p className="text-[10px] text-text-tertiary">{t('settings.toolDbReadonlyHint')}</p>
            </div>
            <button
              onClick={() => setFormReadonly(!formReadonly)}
              className={`w-9 h-5 rounded-full transition-colors ${formReadonly ? 'bg-accent' : 'bg-border-secondary'}`}
            >
              <div
                className={`w-3.5 h-3.5 rounded-full bg-white shadow transition-transform mx-0.5 ${formReadonly ? 'translate-x-4' : 'translate-x-0'}`}
              />
            </button>
          </div>

          {!formReadonly && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/5">
              <TriangleAlert size={12} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-[10px] text-text-secondary leading-relaxed">
                {t('settings.toolDbReadonlyOffWarning')}
              </p>
            </div>
          )}

          {testResult && (
            <p className={`text-[10px] ${testResult.success ? 'text-green-400' : 'text-danger'}`}>
              {testResult.success
                ? t('settings.toolDbTestSuccess')
                : `${t('settings.toolDbTestFailed')}: ${testResult.error}`}
            </p>
          )}

          {formError && <p className="text-[10px] text-danger">{formError}</p>}

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={!formValid || saving}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? t('settings.toolSshSaving') : editId ? t('common.save') : t('common.add')}
            </button>
            <button
              onClick={handleTest}
              disabled={
                testing ||
                !formHost.trim() ||
                !formUsername.trim() ||
                !formPassword.trim() ||
                !formDatabase.trim()
              }
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
            >
              {testing && <Loader2 size={11} className="animate-spin" />}
              {t('settings.toolDbTest')}
            </button>
            <button
              onClick={resetForm}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('ssh.cancel')}
            </button>
          </div>
        </div>
      )}

      {credentials.length > 0 ? (
        <div className="space-y-1.5">
          {credentials.map((cred) => (
            <div
              key={cred.id}
              className="flex items-center justify-between px-3 py-2 rounded-lg bg-bg-tertiary/50 border border-border-primary hover:border-border-secondary transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-text-primary truncate">
                    {cred.name}
                  </span>
                  <span className="px-1.5 py-0.5 text-[9px] rounded-md bg-blue-500/15 text-blue-400">
                    {cred.dbType === 'mysql' ? 'MySQL' : 'PostgreSQL'}
                  </span>
                  {cred.readonly && (
                    <span className="px-1.5 py-0.5 text-[9px] rounded-md bg-green-500/15 text-green-400">
                      {t('settings.toolDbReadonlyBadge')}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-text-tertiary mt-0.5 font-mono truncate">
                  {cred.username}@{cred.host}:{cred.port}/{cred.database}
                </p>
              </div>
              <div className="flex items-center gap-1 ml-2">
                <button
                  onClick={() => startEdit(cred)}
                  className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                  title="Edit"
                >
                  <Pencil size={12} />
                </button>
                {deletingId === cred.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleDelete(cred.id)}
                      className="px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/10 rounded transition-colors"
                    >
                      {t('common.confirm')}
                    </button>
                    <button
                      onClick={() => setDeletingId(null)}
                      className="px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-secondary rounded transition-colors"
                    >
                      {t('ssh.cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeletingId(cred.id)}
                    className="p-1 text-text-tertiary hover:text-danger transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        !showForm && (
          <div className="text-center py-4">
            <p className="text-[11px] text-text-tertiary">{t('settings.toolDbEmpty')}</p>
            <p className="text-[10px] text-text-tertiary mt-0.5">{t('settings.toolDbEmptyHint')}</p>
          </div>
        )
      )}
    </div>
  )
}
