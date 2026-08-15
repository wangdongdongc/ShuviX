import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, Trash2, Pencil, TriangleAlert, Globe } from 'lucide-react'
import { BuiltinToolsView } from '@shuvix/app-shell'
import { SettingsSection, SettingsRow, Toggle } from './SettingsPrimitives'
import {
  SshCredentialDialog,
  type SshCredentialDialogData,
  type SshCredentialDialogInitial
} from './SshCredentialDialog'
import {
  DbCredentialDialog,
  type DbCredentialDialogData,
  type DbCredentialDialogInitial
} from './DbCredentialDialog'

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

/**
 * 工具配置页：复用共享的 <BuiltinToolsView>（每工具一个子页 + 顶部 metadata 卡片）。
 * 桌面注入：definitions 读取入口、各工具的专属配置（SSH/DB 凭据、
 * Browser 数据/证书设置——挂在统一 browser 工具的子页下）。
 * 子智能体管理已移至顶层「智能体」tab（AgentSettings）。
 */
export function ToolSettings(): React.JSX.Element {
  return (
    <BuiltinToolsView
      loadDefinitions={() => window.api.tools.definitions()}
      renderToolExtra={(name) => {
        if (name === 'ssh') return <SshToolPanel />
        if (name === 'database') return <DatabaseToolPanel />
        if (name === 'browser') return <BrowserToolPanel />
        return null
      }}
    />
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
    <div className="flex-1 px-5 py-5 space-y-5">
      {/* 行为 */}
      <SettingsSection
        title={t('settings.toolBrowserTitle')}
        description={t('settings.toolBrowserDesc')}
      >
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-4 text-text-tertiary">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
          </div>
        ) : (
          <>
            <SettingsRow
              title={t('settings.toolBrowserIgnoreCertificateErrors')}
              description={t('settings.toolBrowserIgnoreCertificateErrorsHint')}
              control={<Toggle on={ignoreCert} onClick={handleToggle} />}
            />
            {ignoreCert && (
              <div className="flex items-start gap-2 px-4 py-3 bg-amber-500/5">
                <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-text-secondary leading-relaxed">
                  {t('settings.toolBrowserSecurityWarning')}
                </p>
              </div>
            )}
          </>
        )}
      </SettingsSection>

      {/* 已保存站点 */}
      <SettingsSection
        title={t('settings.toolBrowserSavedSitesTitle')}
        description={t('settings.toolBrowserSavedSitesDesc')}
        headerAction={
          <div className="flex items-center gap-3">
            {sites.length > 0 &&
              (confirmClearAll ? (
                <div className="flex items-center gap-1">
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
                  className="text-[11px] text-text-tertiary hover:text-danger transition-colors"
                >
                  {t('settings.toolBrowserClearAll')}
                </button>
              ))}
            <button
              onClick={loadSites}
              disabled={sitesLoading}
              className="text-[11px] text-text-tertiary hover:text-text-secondary disabled:opacity-50 transition-colors"
            >
              {sitesLoading ? <Loader2 size={11} className="animate-spin" /> : t('common.refresh')}
            </button>
          </div>
        }
      >
        {sitesLoading && sites.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-4 text-text-tertiary">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
          </div>
        ) : sites.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[11px] text-text-tertiary">{t('settings.toolBrowserNoSites')}</p>
          </div>
        ) : (
          sites.map((site) => (
            <SettingsRow
              key={site.host}
              icon={<Globe size={11} className="text-text-tertiary shrink-0" />}
              title={<span className="font-mono">{site.host}</span>}
              control={
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-text-tertiary tabular-nums">
                    {site.cookieCount}
                  </span>
                  {confirmHost === site.host ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleClearSite(site.host)}
                        disabled={clearingHost === site.host}
                        className="px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/10 rounded transition-colors disabled:opacity-50 flex items-center gap-1"
                      >
                        {clearingHost === site.host && (
                          <Loader2 size={9} className="animate-spin" />
                        )}
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
                      className="p-1 text-text-tertiary hover:text-danger transition-colors"
                      title={t('settings.toolBrowserClearSite')}
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              }
            />
          ))
        )}
      </SettingsSection>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
// SSH 工具面板
// ────────────────────────────────────────────────────────────────

function SshToolPanel(): React.JSX.Element {
  const { t } = useTranslation()

  const [credentials, setCredentials] = useState<SshCredentialInfo[]>([])
  const [dialogInitial, setDialogInitial] = useState<SshCredentialDialogInitial | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadCredentials = useCallback(async () => {
    const list = await window.api.sshCredential.list()
    setCredentials(list)
  }, [])

  useEffect(() => {
    loadCredentials() // eslint-disable-line react-hooks/set-state-in-effect
  }, [loadCredentials])

  const openAddDialog = (): void => {
    setDialogInitial(null)
    setDialogOpen(true)
  }

  const openEditDialog = (cred: SshCredentialInfo): void => {
    setDialogInitial({
      id: cred.id,
      name: cred.name,
      host: cred.host,
      port: cred.port,
      username: cred.username,
      authType: cred.authType,
      password: cred.password,
      privateKey: cred.privateKey,
      passphrase: cred.passphrase,
      metadata: cred.metadata
    })
    setDialogOpen(true)
  }

  const handleSave = async (data: SshCredentialDialogData): Promise<void> => {
    if (dialogInitial) {
      await window.api.sshCredential.update({ id: dialogInitial.id, ...data })
    } else {
      await window.api.sshCredential.add(data)
    }
    await loadCredentials()
  }

  const handleDelete = async (id: string): Promise<void> => {
    await window.api.sshCredential.delete(id)
    await loadCredentials()
    setDeletingId(null)
  }

  return (
    <div className="flex-1 px-5 py-5 space-y-5">
      {/* 凭据列表 */}
      <SettingsSection
        title={t('settings.toolSshTitle')}
        description={t('settings.toolSshDesc')}
        headerAction={
          <button
            onClick={openAddDialog}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
          >
            <Plus size={12} />
            {t('settings.toolSshAdd')}
          </button>
        }
        preamble={
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-text-secondary leading-relaxed">
              {t('settings.toolSshSecurityWarning')}
            </p>
          </div>
        }
      >
        {credentials.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[11px] text-text-tertiary">{t('settings.toolSshEmpty')}</p>
            <p className="text-[10px] text-text-tertiary mt-1">{t('settings.toolSshEmptyHint')}</p>
          </div>
        ) : (
          credentials.map((cred) => (
            <SettingsRow
              key={cred.id}
              title={
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{cred.name}</span>
                  <span
                    className={`px-1.5 py-0.5 text-[9px] rounded-md font-normal shrink-0 ${
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
              }
              description={
                <span className="font-mono">
                  {cred.username}@{cred.host}:{cred.port}
                </span>
              }
              control={
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => openEditDialog(cred)}
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
              }
            />
          ))
        )}
      </SettingsSection>

      {dialogOpen && (
        <SshCredentialDialog
          initial={dialogInitial}
          onSave={handleSave}
          onClose={() => setDialogOpen(false)}
        />
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
  const [dialogInitial, setDialogInitial] = useState<DbCredentialDialogInitial | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadCredentials = useCallback(async () => {
    const list = await window.api.dbCredential.list()
    setCredentials(list as DbCredentialInfo[])
  }, [])

  useEffect(() => {
    loadCredentials() // eslint-disable-line react-hooks/set-state-in-effect
  }, [loadCredentials])

  const openAddDialog = (): void => {
    setDialogInitial(null)
    setDialogOpen(true)
  }

  const openEditDialog = (cred: DbCredentialInfo): void => {
    setDialogInitial({
      id: cred.id,
      name: cred.name,
      dbType: cred.dbType,
      host: cred.host,
      port: cred.port,
      username: cred.username,
      database: cred.database,
      readonly: cred.readonly
    })
    setDialogOpen(true)
  }

  const handleSave = async (data: DbCredentialDialogData): Promise<void> => {
    if (dialogInitial) {
      await window.api.dbCredential.update({ id: dialogInitial.id, ...data })
    } else {
      await window.api.dbCredential.add(data)
    }
    await loadCredentials()
  }

  const handleDelete = async (id: string): Promise<void> => {
    await window.api.dbCredential.delete(id)
    await loadCredentials()
    setDeletingId(null)
  }

  return (
    <div className="flex-1 px-5 py-5 space-y-5">
      {/* 凭据列表 */}
      <SettingsSection
        title={t('settings.toolDbTitle')}
        description={t('settings.toolDbDesc')}
        headerAction={
          <button
            onClick={openAddDialog}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
          >
            <Plus size={12} />
            {t('settings.toolDbAdd')}
          </button>
        }
        preamble={
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-text-secondary leading-relaxed">
              {t('settings.toolDbSecurityWarning')}
            </p>
          </div>
        }
      >
        {credentials.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[11px] text-text-tertiary">{t('settings.toolDbEmpty')}</p>
            <p className="text-[10px] text-text-tertiary mt-1">{t('settings.toolDbEmptyHint')}</p>
          </div>
        ) : (
          credentials.map((cred) => (
            <SettingsRow
              key={cred.id}
              title={
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{cred.name}</span>
                  <span className="px-1.5 py-0.5 text-[9px] rounded-md font-normal bg-blue-500/15 text-blue-400 shrink-0">
                    {cred.dbType === 'mysql' ? 'MySQL' : 'PostgreSQL'}
                  </span>
                  {cred.readonly && (
                    <span className="px-1.5 py-0.5 text-[9px] rounded-md font-normal bg-green-500/15 text-green-400 shrink-0">
                      {t('settings.toolDbReadonlyBadge')}
                    </span>
                  )}
                </div>
              }
              description={
                <span className="font-mono">
                  {cred.username}@{cred.host}:{cred.port}/{cred.database}
                </span>
              }
              control={
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => openEditDialog(cred)}
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
              }
            />
          ))
        )}
      </SettingsSection>

      {dialogOpen && (
        <DbCredentialDialog
          initial={dialogInitial}
          onSave={handleSave}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  )
}
