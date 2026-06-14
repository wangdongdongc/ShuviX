import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, KeyRound, X } from 'lucide-react'
import { useDialogClose } from '@shuvix/chat-ui'
import {
  SettingsSection,
  SettingsRow,
  SettingsBlock,
  SegmentedControl,
  InlineInput
} from './SettingsPrimitives'

export interface SshCredentialDialogInitial {
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
}

export interface SshCredentialDialogData {
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  password: string
  privateKey: string
  passphrase: string
  metadata: { proxyUrl?: string }
}

interface SshCredentialDialogProps {
  initial: SshCredentialDialogInitial | null
  onSave: (data: SshCredentialDialogData) => Promise<void>
  onClose: () => void
}

/** SSH 凭据 添加/编辑 弹窗（卡片式布局） */
export function SshCredentialDialog({
  initial,
  onSave,
  onClose
}: SshCredentialDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const isEdit = !!initial

  const [name, setName] = useState(initial?.name ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(initial ? String(initial.port) : '22')
  const [username, setUsername] = useState(initial?.username ?? '')
  const [authType, setAuthType] = useState<'password' | 'key'>(initial?.authType ?? 'password')
  const [password, setPassword] = useState(
    initial?.authType === 'password' ? (initial.password ?? '') : ''
  )
  const [privateKey, setPrivateKey] = useState(
    initial?.authType === 'key' ? (initial.privateKey ?? '') : ''
  )
  const [keyFileName, setKeyFileName] = useState('')
  const [passphrase, setPassphrase] = useState(
    initial?.authType === 'key' ? (initial.passphrase ?? '') : ''
  )
  const [proxyUrl, setProxyUrl] = useState(initial?.metadata?.proxyUrl ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleBrowseKey = async (): Promise<void> => {
    const result = await window.electron.ipcRenderer.invoke('dialog:readTextFile', {
      title: t('ssh.selectKeyFile'),
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (result?.content) {
      setPrivateKey(result.content)
      const fileName = (result.path as string).split(/[/\\]/).pop() || ''
      setKeyFileName(fileName)
    }
  }

  const valid =
    name.trim() &&
    host.trim() &&
    username.trim() &&
    (authType === 'password' ? password.trim() : privateKey.trim())

  const handleSave = async (): Promise<void> => {
    if (!valid) return
    setSaving(true)
    setError('')
    try {
      await onSave({
        name: name.trim(),
        host: host.trim(),
        port: parseInt(port, 10) || 22,
        username: username.trim(),
        authType,
        password: authType === 'password' ? password : '',
        privateKey: authType === 'key' ? privateKey : '',
        passphrase: authType === 'key' ? passphrase : '',
        metadata: { proxyUrl: proxyUrl.trim() || undefined }
      })
      handleClose()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      setError(message.includes('already exists') ? t('settings.toolSshDuplicateName') : message)
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
            {isEdit ? t('settings.toolSshEditTitle') : t('settings.toolSshAddTitle')}
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
          <SettingsSection title={t('settings.toolSshConnectionGroup')}>
            <SettingsRow
              title={t('settings.toolSshName')}
              description={t('settings.toolSshNameHint')}
              control={
                <InlineInput
                  value={name}
                  onChange={setName}
                  placeholder={t('settings.toolSshNamePlaceholder')}
                  autoFocus={!isEdit}
                />
              }
            />
            <SettingsRow
              title={t('ssh.host')}
              control={<InlineInput value={host} onChange={setHost} placeholder="192.168.1.100" />}
            />
            <SettingsRow
              title={t('ssh.port')}
              control={<InlineInput value={port} onChange={setPort} placeholder="22" width={80} />}
            />
            <SettingsRow
              title={t('ssh.username')}
              control={<InlineInput value={username} onChange={setUsername} placeholder="root" />}
            />
          </SettingsSection>

          {/* 认证 */}
          <SettingsSection title={t('settings.toolSshAuthGroup')}>
            <SettingsRow
              title={t('settings.toolSshAuthMethod')}
              control={
                <SegmentedControl<'password' | 'key'>
                  value={authType}
                  onChange={setAuthType}
                  options={[
                    { value: 'password', label: t('settings.toolSshAuthPassword') },
                    { value: 'key', label: t('settings.toolSshAuthKey') }
                  ]}
                />
              }
            />
            {authType === 'password' && (
              <SettingsRow
                title={t('ssh.password')}
                control={
                  <InlineInput
                    type="password"
                    value={password}
                    onChange={setPassword}
                    placeholder="••••••••"
                  />
                }
              />
            )}
            {authType === 'key' && (
              <>
                <SettingsBlock
                  label={
                    <div className="flex items-center justify-between gap-2">
                      <span>{t('ssh.privateKey')}</span>
                      <button
                        onClick={handleBrowseKey}
                        className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors"
                      >
                        <FolderOpen size={11} />
                        {t('settings.toolSshBrowseKey')}
                      </button>
                    </div>
                  }
                >
                  {keyFileName ? (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-bg-tertiary border border-accent/30 text-text-primary">
                      <KeyRound size={11} className="text-accent shrink-0" />
                      <span className="truncate">{keyFileName}</span>
                      <button
                        onClick={() => {
                          setPrivateKey('')
                          setKeyFileName('')
                        }}
                        className="ml-auto text-text-tertiary hover:text-danger"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ) : (
                    <textarea
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                      placeholder={t('settings.toolSshPrivateKeyPlaceholder')}
                      rows={4}
                      className="zen-textarea font-mono text-[11px] leading-relaxed"
                    />
                  )}
                </SettingsBlock>
                <SettingsRow
                  title={t('ssh.passphrase')}
                  control={
                    <InlineInput
                      type="password"
                      value={passphrase}
                      onChange={setPassphrase}
                      placeholder={t('settings.toolSshPassphrasePlaceholder')}
                    />
                  }
                />
              </>
            )}
          </SettingsSection>

          {/* 高级 */}
          <SettingsSection
            title={t('settings.toolSshAdvancedGroup')}
            footer={t('settings.toolSshProxyUrlHint')}
          >
            <SettingsRow
              title={t('settings.toolSshProxyUrl')}
              control={
                <InlineInput
                  value={proxyUrl}
                  onChange={setProxyUrl}
                  placeholder={t('settings.toolSshProxyUrlPlaceholder')}
                  width={240}
                />
              }
            />
          </SettingsSection>

          {error && <p className="text-[11px] text-danger px-1">{error}</p>}
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary shrink-0">
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
  )
}
