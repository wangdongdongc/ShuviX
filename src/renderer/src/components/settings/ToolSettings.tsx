import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, Container, Loader2, Plus, Trash2, Pencil, KeyRound, Lock, X, FolderOpen, TriangleAlert } from 'lucide-react'

/** 内存预设选项 */
const MEMORY_OPTIONS = ['256m', '512m', '1g', '2g', ''] as const
/** CPU 预设选项 */
const CPU_OPTIONS = ['0.5', '1', '2', ''] as const

/** 内存选项显示文本 */
function memoryLabel(v: string, unlimited: string): string {
  if (!v) return unlimited
  if (v.endsWith('m')) return `${v.slice(0, -1)} MB`
  if (v.endsWith('g')) return `${Number(v.slice(0, -1))} GB`
  return v
}

/** CPU 选项显示文本 */
function cpuLabel(v: string, unlimited: string): string {
  if (!v) return unlimited
  return `${v} Core${Number(v) > 1 ? 's' : ''}`
}

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
  createdAt: number
  updatedAt: number
}

/** 工具配置页 */
export function ToolSettings(): React.JSX.Element {
  const { t } = useTranslation()

  // Bash Docker 配置状态
  const [dockerEnabled, setDockerEnabled] = useState(false)
  const [dockerImage, setDockerImage] = useState('')
  const [dockerMemory, setDockerMemory] = useState('512m')
  const [dockerCpus, setDockerCpus] = useState('1')
  // Docker 状态：null=加载中, 'ready'=可用, 'notInstalled'=未安装, 'notRunning'=引擎未启动
  const [dockerStatus, setDockerStatus] = useState<'ready' | 'notInstalled' | 'notRunning' | null>(null)
  const [loading, setLoading] = useState(true)

  // SSH 凭据状态
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
  const [sshSaving, setSshSaving] = useState(false)
  const [sshError, setSshError] = useState('')
  const [deletingSshId, setDeletingSshId] = useState<string | null>(null)

  // 加载设置 + 检查 Docker 可用性
  useEffect(() => {
    Promise.all([
      window.api.settings.getAll(),
      window.api.docker.validate()
    ]).then(([settings, dockerResult]) => {
      setDockerEnabled(settings['tool.bash.dockerEnabled'] === 'true')
      setDockerImage(settings['tool.bash.dockerImage'] || '')
      setDockerMemory(settings['tool.bash.dockerMemory'] || '512m')
      setDockerCpus(settings['tool.bash.dockerCpus'] || '1')
      if (dockerResult.ok) {
        setDockerStatus('ready')
      } else {
        setDockerStatus(dockerResult.error === 'dockerNotRunning' ? 'notRunning' : 'notInstalled')
      }
      setLoading(false)
    })
  }, [])

  // 加载 SSH 凭据
  const loadSshCredentials = useCallback(async () => {
    const list = await window.api.sshCredential.list()
    setSshCredentials(list)
  }, [])

  useEffect(() => {
    loadSshCredentials()
  }, [loadSshCredentials])

  /** 保存单个设置 */
  const save = (key: string, value: string): void => {
    window.api.settings.set({ key, value })
  }

  const dockerAvailable = dockerStatus === 'ready'

  /** 切换 Docker 启用 */
  const handleToggleDocker = (): void => {
    if (!dockerAvailable) return
    const next = !dockerEnabled
    setDockerEnabled(next)
    save('tool.bash.dockerEnabled', String(next))
  }

  // ===== SSH 凭据操作 =====

  /** 重置表单 */
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
    setSshError('')
  }

  /** 开始编辑 */
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
    setSshError('')
    setShowSshForm(true)
  }

  /** 保存凭据 */
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
        passphrase: sshFormAuthType === 'key' ? sshFormPassphrase : ''
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

  /** 删除凭据 */
  const handleSshDelete = async (id: string): Promise<void> => {
    await window.api.sshCredential.delete(id)
    await loadSshCredentials()
    setDeletingSshId(null)
  }

  /** 浏览并读取私钥文件 */
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

  const sshFormValid = sshFormName.trim() && sshFormHost.trim() && sshFormUsername.trim() && (
    sshFormAuthType === 'password' ? sshFormPassword.trim() : sshFormPrivateKey.trim()
  )

  const inputCls = 'w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors'

  return (
    <div className="flex-1 px-5 py-5 space-y-6 overflow-y-auto">
      {/* 标题 + 描述 */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{t('settings.toolsTitle')}</h3>
        <p className="text-[11px] text-text-tertiary mt-1">{t('settings.toolsDesc')}</p>
      </div>

      {/* Bash 工具配置 */}
      <div className="border border-border-secondary rounded-lg overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center gap-2 px-4 py-3 bg-bg-secondary">
          <Terminal size={14} className="text-accent" />
          <span className="text-xs font-semibold text-text-primary">{t('settings.toolBashTitle')}</span>
        </div>

        <div className="px-4 py-4 space-y-4">
          {/* 加载中状态 */}
          {loading && (
            <div className="flex items-center gap-2 text-text-tertiary py-2">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
            </div>
          )}

          {/* Docker 隔离开关 */}
          {!loading && (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Container size={12} className="text-text-secondary" />
                  <span className="text-xs font-medium text-text-secondary">{t('settings.toolBashDocker')}</span>
                </div>
                <button
                  onClick={handleToggleDocker}
                  disabled={!dockerAvailable}
                  className={`relative w-8 h-[18px] rounded-full transition-colors ${
                    dockerEnabled && dockerAvailable ? 'bg-accent' : 'bg-bg-hover'
                  } ${!dockerAvailable ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span
                    className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                      dockerEnabled ? 'left-[16px]' : 'left-[2px]'
                    }`}
                  />
                </button>
              </div>
              <p className="text-[10px] text-text-tertiary -mt-2">
                {dockerStatus === 'notInstalled'
                  ? t('settings.toolBashDockerNotInstalled')
                  : dockerStatus === 'notRunning'
                    ? t('settings.toolBashDockerNotRunning')
                    : t('settings.toolBashDockerHint')}
              </p>

              {/* Docker 开启后的详细配置 */}
              {dockerEnabled && dockerAvailable && (
                <div className="space-y-3 pl-0.5">
                  {/* 镜像 */}
                  <div>
                    <label className="block text-[10px] text-text-tertiary mb-1">{t('settings.toolBashImage')}</label>
                    <input
                      value={dockerImage}
                      onChange={(e) => setDockerImage(e.target.value)}
                      onBlur={() => save('tool.bash.dockerImage', dockerImage)}
                      className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors font-mono"
                      placeholder={t('settings.toolBashImagePlaceholder')}
                    />
                  </div>

                  {/* 资源限制说明 */}
                  <p className="text-[10px] text-text-tertiary">{t('settings.toolBashResourceHint')}</p>

                  {/* 内存上限 */}
                  <div>
                    <label className="block text-[10px] text-text-tertiary mb-1.5">{t('settings.toolBashMemory')}</label>
                    <div className="flex gap-1.5">
                      {MEMORY_OPTIONS.map(opt => (
                        <button
                          key={opt || '__unlimited'}
                          onClick={() => { setDockerMemory(opt); save('tool.bash.dockerMemory', opt) }}
                          className={`px-2.5 py-1 rounded-md text-[10px] font-medium border transition-colors ${
                            dockerMemory === opt
                              ? 'border-accent text-accent bg-accent/10'
                              : 'border-border-primary text-text-tertiary hover:border-accent/50 hover:text-text-secondary'
                          }`}
                        >
                          {memoryLabel(opt, t('settings.toolBashUnlimited'))}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* CPU 限制 */}
                  <div>
                    <label className="block text-[10px] text-text-tertiary mb-1.5">{t('settings.toolBashCpus')}</label>
                    <div className="flex gap-1.5">
                      {CPU_OPTIONS.map(opt => (
                        <button
                          key={opt || '__unlimited'}
                          onClick={() => { setDockerCpus(opt); save('tool.bash.dockerCpus', opt) }}
                          className={`px-2.5 py-1 rounded-md text-[10px] font-medium border transition-colors ${
                            dockerCpus === opt
                              ? 'border-accent text-accent bg-accent/10'
                              : 'border-border-primary text-text-tertiary hover:border-accent/50 hover:text-text-secondary'
                          }`}
                        >
                          {cpuLabel(opt, t('settings.toolBashUnlimited'))}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* SSH 凭据管理 */}
      <div className="border border-border-secondary rounded-lg overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center gap-2 px-4 py-3 bg-bg-secondary">
          <Terminal size={14} className="text-accent" />
          <span className="text-xs font-semibold text-text-primary">{t('settings.toolSshTitle')}</span>
        </div>

        <div className="px-4 py-4 space-y-3">
          <p className="text-[10px] text-text-tertiary">{t('settings.toolSshDesc')}</p>

          {/* 安全提示 */}
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[10px] text-text-secondary leading-relaxed">{t('settings.toolSshSecurityWarning')}</p>
          </div>

          {/* 添加按钮 */}
          {!showSshForm && (
            <button
              onClick={() => { resetSshForm(); setShowSshForm(true) }}
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
                <label className="block text-[10px] text-text-tertiary mb-1">{t('settings.toolSshName')}</label>
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
                  <label className="block text-[10px] text-text-tertiary mb-1">{t('ssh.password')}</label>
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
                          onClick={() => { setSshFormPrivateKey(''); setSshFormKeyFileName('') }}
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
                        className={`${inputCls} resize-none font-mono text-[10px] leading-relaxed`}
                      />
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] text-text-tertiary mb-1">{t('ssh.passphrase')}</label>
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

              {/* 错误提示 */}
              {sshError && (
                <p className="text-[10px] text-danger">{sshError}</p>
              )}

              {/* 操作按钮 */}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSshSave}
                  disabled={!sshFormValid || sshSaving}
                  className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {sshSaving ? t('settings.toolSshSaving') : (sshEditId ? t('common.save') : t('common.add'))}
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
                      <span className="text-xs font-medium text-text-primary truncate">{cred.name}</span>
                      <span className={`px-1.5 py-0.5 text-[9px] rounded-md ${
                        cred.authType === 'key'
                          ? 'bg-blue-500/15 text-blue-400'
                          : 'bg-green-500/15 text-green-400'
                      }`}>
                        {cred.authType === 'key' ? t('settings.toolSshAuthKey') : t('settings.toolSshAuthPassword')}
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
          ) : !showSshForm && (
            <div className="text-center py-4">
              <p className="text-[11px] text-text-tertiary">{t('settings.toolSshEmpty')}</p>
              <p className="text-[10px] text-text-tertiary mt-0.5">{t('settings.toolSshEmptyHint')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
