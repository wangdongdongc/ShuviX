import { useState, useEffect } from 'react'
import { X, FolderOpen, Container } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import type { Session } from '../stores/chatStore'

interface SessionEditDialogProps {
  session: Session
  onClose: () => void
}

/**
 * 会话编辑弹窗 — 编辑标题、工作目录、Docker 配置
 */
export function SessionEditDialog({ session, onClose }: SessionEditDialogProps): React.JSX.Element {
  const [title, setTitle] = useState(session.title)
  const [workingDirectory, setWorkingDirectory] = useState(session.workingDirectory)
  const [dockerEnabled, setDockerEnabled] = useState(session.dockerEnabled === 1)
  const [dockerImage, setDockerImage] = useState(session.dockerImage)
  const [saving, setSaving] = useState(false)
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null)

  // 检测 Docker 可用性
  useEffect(() => {
    window.api.docker.check().then((r) => setDockerAvailable(r.available))
  }, [])

  // 按 Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  /** 选择文件夹 */
  const handleSelectFolder = async (): Promise<void> => {
    // 调用 Electron 原生文件夹选择对话框
    const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (result) {
      setWorkingDirectory(result)
    }
  }

  /** 保存所有变更 */
  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const store = useChatStore.getState()

      // 更新标题
      if (title.trim() && title.trim() !== session.title) {
        await window.api.session.updateTitle({ id: session.id, title: title.trim() })
        store.updateSessionTitle(session.id, title.trim())
      }

      // 更新工作目录
      if (workingDirectory !== session.workingDirectory) {
        await window.api.session.updateWorkingDir({
          id: session.id,
          workingDirectory
        })
        store.updateSessionWorkingDir(session.id, workingDirectory)
      }

      // 更新 Docker 配置
      const newDockerEnabled = dockerEnabled ? 1 : 0
      if (newDockerEnabled !== session.dockerEnabled || dockerImage !== session.dockerImage) {
        await window.api.session.updateDocker({
          id: session.id,
          dockerEnabled,
          dockerImage
        })
        store.updateSessionDocker(session.id, newDockerEnabled, dockerImage)
      }

      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[420px] max-w-[90vw]">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <h2 className="text-sm font-semibold text-text-primary">编辑会话</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="px-5 py-4 space-y-4">
          {/* 标题 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">标题</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent transition-colors"
              placeholder="会话标题"
            />
          </div>

          {/* 工作目录 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              <FolderOpen size={12} className="inline mr-1 -mt-0.5" />
              工作目录
            </label>
            <div className="flex gap-2">
              <input
                value={workingDirectory}
                onChange={(e) => setWorkingDirectory(e.target.value)}
                className="flex-1 bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent transition-colors font-mono"
                placeholder="/path/to/directory"
              />
              <button
                onClick={handleSelectFolder}
                className="px-3 py-2 bg-bg-secondary border border-border-primary rounded-lg text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors whitespace-nowrap"
              >
                选择…
              </button>
            </div>
            <p className="text-[10px] text-text-tertiary mt-1">
              工具执行时的工作目录，相对路径会基于此目录解析
            </p>
          </div>

          {/* Docker 隔离 */}
          <div className="border border-border-secondary rounded-lg p-3">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                <Container size={12} />
                Docker 隔离
              </label>
              <button
                onClick={() => dockerAvailable && setDockerEnabled(!dockerEnabled)}
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
            {dockerEnabled && (
              <div className="mt-3">
                <label className="block text-[10px] text-text-tertiary mb-1">Docker 镜像</label>
                <input
                  value={dockerImage}
                  onChange={(e) => setDockerImage(e.target.value)}
                  className="w-full bg-bg-secondary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors font-mono"
                  placeholder="ubuntu:latest"
                />
              </div>
            )}
            <p className="text-[10px] text-text-tertiary mt-2">
              {dockerAvailable === false
                ? '未检测到 Docker，请先安装并启动 Docker Desktop'
                : '开启后 Bash 命令将在 Docker 容器内隔离执行，当前工作目录会挂载到容器内'}
            </p>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
