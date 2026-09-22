/**
 * 已保存的数据库连接 —— 挂在 MCP 设置里内置 `database` 那一行的展开区。
 *
 * 以前它是「LLM 工具」页 database 工具的子页；database 改成按会话勾选的内置 MCP 能力服务器之后，
 * 工具页上没有它了，设置跟着能力走（与内置 browser 的站点 / 证书设置同一处理）。凭据仍由 ShuviX
 * 保存（db_credentials）：server 在进程内按名字取用，模型只看得到名字、类型与是否只读。
 */
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil, TriangleAlert } from 'lucide-react'
import { SettingsSection, SettingsRow } from './SettingsPrimitives'
import {
  DbCredentialDialog,
  type DbCredentialDialogData,
  type DbCredentialDialogInitial
} from './DbCredentialDialog'

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

export function DatabaseConnectionsSettings(): React.JSX.Element {
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
              subtitle={
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
                        className="px-1.5 py-0.5 text-[10px] text-error hover:bg-error/10 rounded transition-colors"
                      >
                        {t('common.confirm')}
                      </button>
                      <button
                        onClick={() => setDeletingId(null)}
                        className="px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-secondary rounded transition-colors"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeletingId(cred.id)}
                      className="p-1 text-text-tertiary hover:text-error transition-colors"
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
