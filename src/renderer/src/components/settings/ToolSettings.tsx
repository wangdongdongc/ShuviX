import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, Container } from 'lucide-react'

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
    })
  }, [])

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

  return (
    <div className="flex-1 px-5 py-5 space-y-6">
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
          {/* Docker 隔离开关 */}
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
        </div>
      </div>
    </div>
  )
}
