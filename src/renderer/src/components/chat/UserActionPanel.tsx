import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, FolderOpen, KeyRound, Lock, MessageCircleQuestion, ShieldAlert, Terminal } from 'lucide-react'
import { useChatStore, selectToolExecutions } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'

interface UserActionPanelProps {
  /** ask 工具：用户选择回调 */
  onUserInput: (toolCallId: string, selections: string[]) => void
  /** 沙箱审批：用户允许/拒绝工具调用 */
  onApproval: (toolCallId: string, approved: boolean) => void
  /** SSH 凭据输入回调（凭据不经过大模型） */
  onSshCredentials: (toolCallId: string, credentials: { host: string; port: number; username: string; password?: string; privateKey?: string; passphrase?: string } | null) => void
}

/**
 * 用户操作浮动面板 — 悬浮在输入框上方
 * 统一处理 AI 执行过程中需要用户介入的两种场景：
 *   1. ask 工具提问（pending_user_input）— 展示问题和可选选项
 *   2. bash 审批（pending_approval）— 展示待执行命令和允许/拒绝按钮
 */
export function UserActionPanel({ onUserInput, onApproval, onSshCredentials }: UserActionPanelProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set())

  // 从 store 查找当前需要用户操作的工具执行
  const toolExecutions = useChatStore(selectToolExecutions)
  const pendingAsk = toolExecutions.find((te) => te.status === 'pending_user_input' && te.toolName === 'ask')
  const pendingApproval = toolExecutions.find((te) => te.status === 'pending_approval')
  const pendingSsh = toolExecutions.find((te) => te.status === 'pending_ssh_credentials')

  // SSH 凭据优先（需要立即处理）
  if (pendingSsh) {
    return <SshCredentialContent pending={pendingSsh} onSshCredentials={onSshCredentials} t={t} />
  }
  // ask 优先（两者不会同时出现，但保险起见）
  if (pendingAsk) {
    return <AskContent pending={pendingAsk} selectedOptions={selectedOptions} setSelectedOptions={setSelectedOptions} onUserInput={onUserInput} t={t} />
  }
  if (pendingApproval) {
    return <ApprovalContent pending={pendingApproval} onApproval={onApproval} t={t} />
  }
  return null
}

// ---------- ask 提问子内容 ----------

function AskContent({
  pending,
  selectedOptions,
  setSelectedOptions,
  onUserInput,
  t
}: {
  pending: { toolCallId: string; args?: any }
  selectedOptions: Set<string>
  setSelectedOptions: React.Dispatch<React.SetStateAction<Set<string>>>
  onUserInput: (toolCallId: string, selections: string[]) => void
  t: (key: string) => string
}): React.JSX.Element {
  const { toolCallId, args } = pending
  const question = args?.question || ''
  const options: Array<{ label: string; description: string }> = args?.options || []
  const allowMultiple = args?.allowMultiple ?? false

  const handleToggle = (label: string): void => {
    setSelectedOptions((prev) => {
      const next = new Set(prev)
      if (allowMultiple) {
        if (next.has(label)) next.delete(label)
        else next.add(label)
      } else {
        if (next.has(label)) next.clear()
        else { next.clear(); next.add(label) }
      }
      return next
    })
  }

  const handleConfirm = (): void => {
    if (!toolCallId || selectedOptions.size === 0) return
    onUserInput(toolCallId, Array.from(selectedOptions))
    setSelectedOptions(new Set())
  }

  return (
    <div className="mx-3 mb-2 rounded-xl border border-accent/30 bg-bg-secondary/90 backdrop-blur-sm shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      {/* 问题标题 */}
      <div className="flex items-start gap-2 px-4 pt-3 pb-2">
        <MessageCircleQuestion size={16} className="text-accent flex-shrink-0 mt-0.5" />
        <p className="text-sm text-text-primary font-medium leading-snug">{question}</p>
      </div>

      {/* 选项列表 */}
      <div className="flex flex-col gap-1.5 px-4 pb-2">
        {options.map((opt) => {
          const isSelected = selectedOptions.has(opt.label)
          return (
            <button
              key={opt.label}
              onClick={() => handleToggle(opt.label)}
              className={`flex items-start gap-2.5 px-3 py-2 rounded-lg text-left transition-all border ${
                isSelected
                  ? 'border-accent bg-accent/10 text-text-primary shadow-sm'
                  : 'border-border-secondary bg-bg-primary/50 text-text-secondary hover:bg-bg-hover/50 hover:border-border-primary'
              }`}
            >
              <div className={`mt-0.5 w-4 h-4 rounded flex-shrink-0 flex items-center justify-center border transition-colors ${
                isSelected ? 'border-accent bg-accent' : 'border-border-primary'
              }`}>
                {isSelected && <Check size={11} className="text-white" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">{opt.label}</div>
                {opt.description && <div className="text-[11px] text-text-tertiary mt-0.5 leading-relaxed">{opt.description}</div>}
              </div>
            </button>
          )
        })}
      </div>

      {/* 确认栏 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border-secondary/50 bg-bg-tertiary/30">
        <button
          onClick={handleConfirm}
          disabled={selectedOptions.size === 0}
          className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t('toolCall.confirmSelection')}
        </button>
        {allowMultiple && (
          <span className="text-[10px] text-text-tertiary">{t('toolCall.multiSelectHint')}</span>
        )}
      </div>
    </div>
  )
}

// ---------- 审批子内容（通用） ----------

/** 根据工具类型渲染变更预览 */
function ApprovalPreview({ toolName, args }: { toolName: string; args?: any }): React.JSX.Element {
  const { t } = useTranslation()
  const { settingMeta, projectFieldMeta } = useSettingsStore()

  if (toolName === 'bash') {
    // bash：代码块预览
    return (
      <pre className="text-[11px] text-text-secondary bg-bg-primary/50 rounded-lg px-3 py-2 overflow-auto max-h-32 whitespace-pre-wrap break-words font-mono border border-border-secondary/50">
        {args?.command || ''}
      </pre>
    )
  }

  if (toolName === 'shuvix-setting') {
    // 系统设置：展示可读标签 + key = value
    const key = args?.key || ''
    const value = args?.value ?? ''
    const label = settingMeta[key] ? t(settingMeta[key].labelKey) : key
    return (
      <div className="text-[11px] text-text-secondary bg-bg-primary/50 rounded-lg px-3 py-2 overflow-auto max-h-32 border border-border-secondary/50 space-y-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-text-primary font-medium flex-shrink-0">{label}</span>
          <span className="text-text-tertiary text-[10px] font-mono">({key})</span>
        </div>
        <div className="font-mono text-accent/90 break-all">{value}</div>
      </div>
    )
  }

  if (toolName === 'shuvix-project') {
    // 项目配置：展示各字段可读标签 + 新值
    const { action, ...fields } = args || {}
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return <span className="text-[11px] text-text-tertiary">No changes</span>
    return (
      <div className="text-[11px] text-text-secondary bg-bg-primary/50 rounded-lg px-3 py-2 overflow-auto max-h-32 border border-border-secondary/50 space-y-1.5">
        {entries.map(([k, v]) => {
          const label = projectFieldMeta[k] ? t(projectFieldMeta[k].labelKey) : k
          return (
            <div key={k}>
              <div className="flex items-baseline gap-1.5">
                <span className="text-text-primary font-medium flex-shrink-0">{label}</span>
                <span className="text-text-tertiary text-[10px] font-mono">({k})</span>
              </div>
              <div className="font-mono text-accent/90 break-all mt-0.5">
                {typeof v === 'string' ? v : JSON.stringify(v)}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  // 其他工具：通用 JSON 预览
  return (
    <pre className="text-[11px] text-text-secondary bg-bg-primary/50 rounded-lg px-3 py-2 overflow-auto max-h-32 whitespace-pre-wrap break-words font-mono border border-border-secondary/50">
      {JSON.stringify(args, null, 2)}
    </pre>
  )
}

function ApprovalContent({
  pending,
  onApproval,
  t
}: {
  pending: { toolCallId: string; toolName: string; args?: any }
  onApproval: (toolCallId: string, approved: boolean) => void
  t: (key: string) => string
}): React.JSX.Element {
  const { toolCallId, toolName, args } = pending

  // 根据工具类型选择提示文案
  const hint = toolName === 'bash' ? t('toolCall.sandboxHint')
    : toolName === 'shuvix-project' ? t('toolCall.shuvixProjectHint')
    : toolName === 'shuvix-setting' ? t('toolCall.shuvixSettingHint')
    : t('toolCall.pendingApproval')

  return (
    <div className="mx-3 mb-2 rounded-xl border border-warning/30 bg-bg-secondary/90 backdrop-blur-sm shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      {/* 标题 */}
      <div className="flex items-start gap-2 px-4 pt-3 pb-2">
        <ShieldAlert size={16} className="text-warning flex-shrink-0 mt-0.5" />
        <p className="text-sm text-text-primary font-medium leading-snug">{t('toolCall.pendingApproval')}</p>
      </div>

      {/* 变更预览 */}
      <div className="px-4 pb-2">
        <ApprovalPreview toolName={toolName} args={args} />
      </div>

      {/* 操作栏 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border-secondary/50 bg-bg-tertiary/30">
        <button
          onClick={() => onApproval(toolCallId, true)}
          className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
        >
          {t('toolCall.allow')}
        </button>
        <button
          onClick={() => onApproval(toolCallId, false)}
          className="px-4 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
        >
          {t('toolCall.deny')}
        </button>
        <span className="text-[10px] text-text-tertiary ml-1">{hint}</span>
      </div>
    </div>
  )
}

// ---------- SSH 凭据输入子内容 ----------

type SshAuthMode = 'password' | 'key'

function SshCredentialContent({
  pending,
  onSshCredentials,
  t
}: {
  pending: { toolCallId: string }
  onSshCredentials: (toolCallId: string, credentials: { host: string; port: number; username: string; password?: string; privateKey?: string; passphrase?: string } | null) => void
  t: (key: string) => string
}): React.JSX.Element {
  const { toolCallId } = pending
  const [authMode, setAuthMode] = useState<SshAuthMode>('password')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  // 密码模式
  const [password, setPassword] = useState('')
  // 密钥模式
  const [privateKey, setPrivateKey] = useState('')
  const [keyFileName, setKeyFileName] = useState('')
  const [passphrase, setPassphrase] = useState('')

  const canConnect = host.trim() && username.trim() && (
    authMode === 'password' ? password.trim() : privateKey.trim()
  )

  const handleConnect = (): void => {
    if (!canConnect) return
    const base = { host: host.trim(), port: parseInt(port, 10) || 22, username: username.trim() }
    if (authMode === 'password') {
      onSshCredentials(toolCallId, { ...base, password })
    } else {
      onSshCredentials(toolCallId, {
        ...base,
        privateKey,
        ...(passphrase ? { passphrase } : {})
      })
    }
  }

  const handleCancel = (): void => {
    onSshCredentials(toolCallId, null)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // textarea 中 Enter 不触发提交
    if (e.key === 'Enter' && canConnect && !(e.target instanceof HTMLTextAreaElement)) handleConnect()
    if (e.key === 'Escape') handleCancel()
  }

  /** 浏览并读取私钥文件 */
  const handleBrowseKey = async (): Promise<void> => {
    const result = await window.electron.ipcRenderer.invoke('dialog:readTextFile', {
      title: t('ssh.selectKeyFile'),
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (result?.content) {
      setPrivateKey(result.content)
      // 从路径提取文件名
      const name = (result.path as string).split(/[/\\]/).pop() || ''
      setKeyFileName(name)
    }
  }

  const inputCls = 'w-full px-2.5 py-1.5 rounded-lg text-xs bg-bg-primary/50 border border-border-secondary text-text-primary placeholder:text-text-tertiary/50 outline-none focus:border-accent/50 transition-colors'

  return (
    <div className="mx-3 mb-2 rounded-xl border border-accent/30 bg-bg-secondary/90 backdrop-blur-sm shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      {/* 标题 */}
      <div className="flex items-start gap-2 px-4 pt-3 pb-2">
        <Terminal size={16} className="text-accent flex-shrink-0 mt-0.5" />
        <p className="text-sm text-text-primary font-medium leading-snug">{t('ssh.credentialTitle')}</p>
      </div>

      {/* 表单 */}
      <div className="flex flex-col gap-2 px-4 pb-2">
        {/* 主机 + 端口 */}
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-[10px] text-text-tertiary mb-0.5 block">{t('ssh.host')}</label>
            <input type="text" value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={handleKeyDown} placeholder="192.168.1.100" className={inputCls} autoFocus />
          </div>
          <div className="w-20">
            <label className="text-[10px] text-text-tertiary mb-0.5 block">{t('ssh.port')}</label>
            <input type="text" value={port} onChange={(e) => setPort(e.target.value)} onKeyDown={handleKeyDown} placeholder="22" className={inputCls} />
          </div>
        </div>

        {/* 用户名 */}
        <div>
          <label className="text-[10px] text-text-tertiary mb-0.5 block">{t('ssh.username')}</label>
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={handleKeyDown} placeholder="root" className={inputCls} />
        </div>

        {/* 认证模式切换 */}
        <div className="flex gap-1 mt-0.5">
          <button
            onClick={() => setAuthMode('password')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
              authMode === 'password'
                ? 'bg-accent/15 text-accent border border-accent/30'
                : 'bg-bg-primary/30 text-text-tertiary border border-transparent hover:text-text-secondary'
            }`}
          >
            <Lock size={11} />
            {t('ssh.authPassword')}
          </button>
          <button
            onClick={() => setAuthMode('key')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
              authMode === 'key'
                ? 'bg-accent/15 text-accent border border-accent/30'
                : 'bg-bg-primary/30 text-text-tertiary border border-transparent hover:text-text-secondary'
            }`}
          >
            <KeyRound size={11} />
            {t('ssh.authKey')}
          </button>
        </div>

        {/* 密码模式 */}
        {authMode === 'password' && (
          <div>
            <label className="text-[10px] text-text-tertiary mb-0.5 block">{t('ssh.password')}</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={handleKeyDown} placeholder="••••••••" className={inputCls} />
          </div>
        )}

        {/* 密钥模式 */}
        {authMode === 'key' && (
          <>
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <label className="text-[10px] text-text-tertiary">{t('ssh.privateKey')}</label>
                <button
                  onClick={handleBrowseKey}
                  className="flex items-center gap-0.5 text-[10px] text-accent hover:text-accent/80 transition-colors"
                >
                  <FolderOpen size={10} />
                  {t('ssh.browseKey')}
                </button>
              </div>
              {keyFileName ? (
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs bg-bg-primary/50 border border-accent/30 text-text-primary">
                  <KeyRound size={11} className="text-accent flex-shrink-0" />
                  <span className="truncate">{keyFileName}</span>
                  <button onClick={() => { setPrivateKey(''); setKeyFileName('') }} className="ml-auto text-text-tertiary hover:text-error text-[10px]">✕</button>
                </div>
              ) : (
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder={t('ssh.privateKeyPlaceholder')}
                  rows={3}
                  className={`${inputCls} resize-none font-mono text-[10px] leading-relaxed`}
                />
              )}
            </div>
            <div>
              <label className="text-[10px] text-text-tertiary mb-0.5 block">{t('ssh.passphrase')}</label>
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} onKeyDown={handleKeyDown} placeholder={t('ssh.passphrasePlaceholder')} className={inputCls} />
            </div>
          </>
        )}
      </div>

      {/* 操作栏 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border-secondary/50 bg-bg-tertiary/30">
        <button
          onClick={handleConnect}
          disabled={!canConnect}
          className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t('ssh.connect')}
        </button>
        <button
          onClick={handleCancel}
          className="px-4 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
        >
          {t('ssh.cancel')}
        </button>
        <span className="text-[10px] text-text-tertiary ml-1">{t('ssh.credentialHint')}</span>
      </div>
    </div>
  )
}
