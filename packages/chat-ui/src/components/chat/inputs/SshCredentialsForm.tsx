import { FolderOpen, KeyRound, Lock, Terminal, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SshCredentialsInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { InputFormProps } from './types'
import { isImeComposing } from '../../../utils/ime'
import {
  buildSshCredentialsPayload,
  isSshCredentialsDraftValid,
  type SshCredentialsDraft
} from './drafts'

export function SshCredentialsForm({
  request: _request,
  draft,
  onDraftChange,
  onSubmit,
  titleAccessory
}: InputFormProps<SshCredentialsInputRequest, SshCredentialsDraft>): React.JSX.Element {
  const { t } = useTranslation()
  const canConnect = isSshCredentialsDraftValid(draft)

  const update = (patch: Partial<SshCredentialsDraft>): void => {
    onDraftChange({ ...draft, ...patch })
  }

  const handleConnect = (): void => {
    if (!canConnect) return
    onSubmit({ kind: 'sshCredentials', credentials: buildSshCredentialsPayload(draft) })
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // 输入法组字中的回车是「确认选词」，不能当成提交
    if (isImeComposing(e)) return
    if (e.key === 'Enter' && canConnect && !(e.target instanceof HTMLTextAreaElement))
      handleConnect()
  }

  /** 浏览并读取私钥文件（Electron 宿主专属：通过 ipcRenderer 调系统文件对话框） */
  const handleBrowseKey = async (): Promise<void> => {
    const electron = (
      globalThis as {
        window?: {
          electron?: {
            ipcRenderer: {
              invoke: (
                channel: string,
                ...args: unknown[]
              ) => Promise<{ content?: string; path?: string } | undefined>
            }
          }
        }
      }
    ).window?.electron
    if (!electron) return
    const result = await electron.ipcRenderer.invoke('dialog:readTextFile', {
      title: t('ssh.selectKeyFile'),
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (result?.content) {
      const name = (result.path as string).split(/[/\\]/).pop() || ''
      update({ privateKey: result.content, keyFileName: name })
    }
  }

  const inputCls =
    'w-full px-2.5 py-1 rounded-lg text-xs bg-bg-secondary/70 border border-border-secondary/40 text-text-primary placeholder:text-text-tertiary/50 outline-none focus:border-accent/50 transition-colors'

  return (
    <div>
      {/* 标题行 */}
      <div className="flex items-center gap-1.5">
        <Terminal size={13} className="text-accent flex-shrink-0" />
        <p className="text-xs text-text-primary font-medium">{t('ssh.credentialTitle')}</p>
        <span className="flex-1" />
        {titleAccessory}
      </div>

      {/* 表单 */}
      <div className="flex flex-col gap-1.5 pt-1.5">
        {/* 主机 + 端口 */}
        <div className="flex gap-1.5">
          <div className="flex-1">
            <input
              type="text"
              value={draft.host}
              onChange={(e) => update({ host: e.target.value })}
              onKeyDown={handleKeyDown}
              placeholder={t('ssh.host')}
              className={inputCls}
              autoFocus
            />
          </div>
          <div className="w-14">
            <input
              type="text"
              value={draft.port}
              onChange={(e) => update({ port: e.target.value })}
              onKeyDown={handleKeyDown}
              placeholder="22"
              className={inputCls}
            />
          </div>
        </div>

        {/* 用户名 */}
        <input
          type="text"
          value={draft.username}
          onChange={(e) => update({ username: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder={t('ssh.username')}
          className={inputCls}
        />

        {/* 认证模式切换 */}
        <div className="flex gap-1">
          <button
            onClick={() => update({ authMode: 'password' })}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
              draft.authMode === 'password'
                ? 'bg-accent/15 text-accent border border-accent/30'
                : 'bg-bg-primary/30 text-text-tertiary border border-transparent hover:text-text-secondary'
            }`}
          >
            <Lock size={10} />
            {t('ssh.authPassword')}
          </button>
          <button
            onClick={() => update({ authMode: 'key' })}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
              draft.authMode === 'key'
                ? 'bg-accent/15 text-accent border border-accent/30'
                : 'bg-bg-primary/30 text-text-tertiary border border-transparent hover:text-text-secondary'
            }`}
          >
            <KeyRound size={10} />
            {t('ssh.authKey')}
          </button>
        </div>

        {/* 密码模式 */}
        {draft.authMode === 'password' && (
          <input
            type="password"
            value={draft.password}
            onChange={(e) => update({ password: e.target.value })}
            onKeyDown={handleKeyDown}
            placeholder={t('ssh.password')}
            className={inputCls}
          />
        )}

        {/* 密钥模式 */}
        {draft.authMode === 'key' && (
          <>
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <label className="text-[11px] text-text-tertiary">{t('ssh.privateKey')}</label>
                <button
                  onClick={handleBrowseKey}
                  className="flex items-center gap-0.5 text-[11px] text-accent hover:text-accent/80 transition-colors"
                >
                  <FolderOpen size={11} />
                  {t('ssh.browseKey')}
                </button>
              </div>
              {draft.keyFileName ? (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-bg-secondary/70 border border-accent/30 text-text-primary">
                  <KeyRound size={12} className="text-accent flex-shrink-0" />
                  <span className="truncate">{draft.keyFileName}</span>
                  <button
                    onClick={() => update({ privateKey: '', keyFileName: '' })}
                    className="ml-auto text-text-tertiary hover:text-error text-[11px]"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <textarea
                  value={draft.privateKey}
                  onChange={(e) => update({ privateKey: e.target.value })}
                  placeholder={t('ssh.privateKeyPlaceholder')}
                  rows={2}
                  className={`${inputCls} resize-none font-mono text-[11px] leading-snug`}
                />
              )}
            </div>
            <input
              type="password"
              value={draft.passphrase}
              onChange={(e) => update({ passphrase: e.target.value })}
              onKeyDown={handleKeyDown}
              placeholder={t('ssh.passphrase')}
              className={inputCls}
            />
          </>
        )}

        {/* 安全提示 */}
        <div className="flex items-start gap-1.5 px-2 py-1 rounded-lg border border-amber-500/30 bg-amber-500/5">
          <TriangleAlert size={11} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-text-secondary leading-snug">{t('ssh.securityWarning')}</p>
        </div>

        {/* 操作栏 */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleConnect}
            disabled={!canConnect}
            className="px-3 py-1 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('ssh.connect')}
          </button>
          <span className="text-[11px] text-text-tertiary truncate">{t('ssh.credentialHint')}</span>
        </div>
      </div>
    </div>
  )
}
