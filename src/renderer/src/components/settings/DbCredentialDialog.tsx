import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Loader2, TriangleAlert, X } from 'lucide-react'
import { useDialogClose } from '../../hooks/useDialogClose'
import {
  SettingsSection,
  SettingsRow,
  SegmentedControl,
  Toggle,
  InlineInput
} from './SettingsPrimitives'

export interface DbCredentialDialogInitial {
  id: string
  name: string
  dbType: 'mysql' | 'postgresql'
  host: string
  port: number
  username: string
  database: string
  readonly: boolean
}

export interface DbCredentialDialogData {
  name: string
  dbType: 'mysql' | 'postgresql'
  host: string
  port: number
  username: string
  password: string
  database: string
  readonly: boolean
}

interface DbCredentialDialogProps {
  initial: DbCredentialDialogInitial | null
  onSave: (data: DbCredentialDialogData) => Promise<void>
  onClose: () => void
}

/** 数据库凭据 添加/编辑 弹窗（卡片式布局） */
export function DbCredentialDialog({
  initial,
  onSave,
  onClose
}: DbCredentialDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const isEdit = !!initial

  const [name, setName] = useState(initial?.name ?? '')
  const [dbType, setDbType] = useState<'mysql' | 'postgresql'>(initial?.dbType ?? 'mysql')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(initial ? String(initial.port) : '3306')
  const [username, setUsername] = useState(initial?.username ?? '')
  const [password, setPassword] = useState('')
  const [database, setDatabase] = useState(initial?.database ?? '')
  const [readonly, setReadonly] = useState(initial?.readonly ?? true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleDbTypeChange = (next: 'mysql' | 'postgresql'): void => {
    setDbType(next)
    setPort(next === 'mysql' ? '3306' : '5432')
  }

  const handleTest = async (): Promise<void> => {
    if (!host.trim() || !username.trim() || !password.trim() || !database.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.dbCredential.testConnection({
        dbType,
        host: host.trim(),
        port: parseInt(port, 10) || (dbType === 'mysql' ? 3306 : 5432),
        username: username.trim(),
        password,
        database: database.trim()
      })
      setTestResult(result as { success: boolean; error?: string })
    } finally {
      setTesting(false)
    }
  }

  const valid =
    name.trim() && host.trim() && username.trim() && database.trim() && (isEdit || password.trim())

  const handleSave = async (): Promise<void> => {
    if (!valid) return
    setSaving(true)
    setError('')
    try {
      await onSave({
        name: name.trim(),
        dbType,
        host: host.trim(),
        port: parseInt(port, 10) || (dbType === 'mysql' ? 3306 : 5432),
        username: username.trim(),
        password,
        database: database.trim(),
        readonly
      })
      handleClose()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      setError(message.includes('already exists') ? t('settings.toolDbDuplicateName') : message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 titlebar-no-drag dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[520px] max-w-[92vw] max-h-[88vh] flex flex-col dialog-panel"
      >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-border-secondary shrink-0 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">
            {isEdit ? t('settings.toolDbEditTitle') : t('settings.toolDbAddTitle')}
          </h3>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* 表单 */}
        <div className="px-5 py-5 overflow-y-auto flex-1 space-y-5">
          {/* 连接信息 */}
          <SettingsSection title={t('settings.toolDbConnectionGroup')}>
            <SettingsRow
              title={t('settings.toolDbName')}
              description={t('settings.toolDbNameHint')}
              control={
                <InlineInput
                  value={name}
                  onChange={setName}
                  placeholder={t('settings.toolDbNamePlaceholder')}
                  autoFocus={!isEdit}
                />
              }
            />
            <SettingsRow
              title={t('settings.toolDbType')}
              control={
                <SegmentedControl<'mysql' | 'postgresql'>
                  value={dbType}
                  onChange={handleDbTypeChange}
                  options={[
                    {
                      value: 'mysql',
                      label: (
                        <span className="inline-flex items-center gap-1">
                          <Database size={11} />
                          MySQL
                        </span>
                      )
                    },
                    {
                      value: 'postgresql',
                      label: (
                        <span className="inline-flex items-center gap-1">
                          <Database size={11} />
                          PostgreSQL
                        </span>
                      )
                    }
                  ]}
                />
              }
            />
            <SettingsRow
              title={t('settings.toolDbHost')}
              control={<InlineInput value={host} onChange={setHost} placeholder="localhost" />}
            />
            <SettingsRow
              title={t('settings.toolDbPort')}
              control={
                <InlineInput
                  value={port}
                  onChange={setPort}
                  placeholder={dbType === 'mysql' ? '3306' : '5432'}
                  width={80}
                />
              }
            />
            <SettingsRow
              title={t('settings.toolDbUsername')}
              control={<InlineInput value={username} onChange={setUsername} placeholder="root" />}
            />
            <SettingsRow
              title={t('settings.toolDbPassword')}
              description={isEdit ? t('settings.toolDbPasswordEditHint') : undefined}
              control={
                <InlineInput
                  type="password"
                  value={password}
                  onChange={setPassword}
                  placeholder={isEdit ? t('settings.toolDbPasswordKeepPlaceholder') : '••••••••'}
                />
              }
            />
            <SettingsRow
              title={t('settings.toolDbDatabase')}
              control={<InlineInput value={database} onChange={setDatabase} placeholder="mydb" />}
            />
          </SettingsSection>

          {/* 权限 */}
          <SettingsSection title={t('settings.toolDbPermissionGroup')}>
            <SettingsRow
              title={t('settings.toolDbReadonly')}
              description={t('settings.toolDbReadonlyHint')}
              control={<Toggle on={readonly} onClick={() => setReadonly(!readonly)} />}
            />
            {!readonly && (
              <div className="flex items-start gap-2 px-4 py-3 bg-red-500/5">
                <TriangleAlert size={12} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-[11px] text-text-secondary leading-relaxed">
                  {t('settings.toolDbReadonlyOffWarning')}
                </p>
              </div>
            )}
          </SettingsSection>

          {testResult && (
            <p
              className={`text-[11px] px-1 ${testResult.success ? 'text-green-400' : 'text-danger'}`}
            >
              {testResult.success
                ? t('settings.toolDbTestSuccess')
                : `${t('settings.toolDbTestFailed')}: ${testResult.error}`}
            </p>
          )}

          {error && <p className="text-[11px] text-danger px-1">{error}</p>}
        </div>

        {/* 按钮 */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border-secondary shrink-0">
          <button
            onClick={handleTest}
            disabled={
              testing || !host.trim() || !username.trim() || !password.trim() || !database.trim()
            }
            className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
          >
            {testing && <Loader2 size={11} className="animate-spin" />}
            {t('settings.toolDbTest')}
          </button>
          <div className="flex gap-2">
            <button
              onClick={handleClose}
              className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={!valid || saving}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? t('settings.toolSshSaving') : isEdit ? t('common.save') : t('common.add')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
