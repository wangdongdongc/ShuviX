/**
 * 关于页（桌面绑定层）—— 复用共享 AboutTab，注入桌面版本号 + 自动更新 API + 外链 + 应用日志的路径。
 * web 客户端里日志在跑 ShuviX 的那台电脑上：不给「在文件夹中显示」（那会在那台电脑上开文件管理器）。
 */
import { useState, useEffect } from 'react'
import { AboutTab } from '@shuvix/app-shell'
import { useUpdateStore } from '../../stores/updateStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { isWebHost } from '../../host/hostMedia'

export function AboutSettings({
  onViewLog
}: {
  /** 去监视器的应用日志子页 */
  onViewLog: () => void
}): React.JSX.Element {
  const [appVersion, setAppVersion] = useState('')
  const [logPath, setLogPath] = useState('')
  const { updateEvent, setUpdateEvent } = useUpdateStore()
  const { autoCheckUpdate } = useSettingsStore()

  useEffect(() => {
    void window.api.app.getVersion().then((v) => setAppVersion(v))
    void window.api.appLog.info().then((info) => setLogPath(info.path))
  }, [])

  // 注册实时事件监听（设置窗口独立进程，主窗口的 useAppInit 监听器不共享）
  useEffect(() => {
    const removeListener = window.api.update.onEvent((event) => setUpdateEvent(event))
    void window.api.update.getLastEvent().then((last) => {
      if (last) setUpdateEvent(last)
    })
    return removeListener
  }, [setUpdateEvent])

  return (
    <AboutTab
      appVersion={appVersion}
      openExternal={(url) => void window.api.app.openExternal(url)}
      appLog={
        logPath
          ? {
              path: logPath,
              onView: onViewLog,
              onReveal: isWebHost ? undefined : () => void window.api.app.revealPath(logPath)
            }
          : undefined
      }
      update={{
        autoCheck: autoCheckUpdate,
        event: updateEvent,
        onToggleAutoCheck: () => {
          const next = !autoCheckUpdate
          useSettingsStore.setState({ autoCheckUpdate: next })
          void window.api.settings.set({ key: 'updates.autoCheck', value: String(next) })
        },
        onCheck: () => {
          setUpdateEvent(null)
          void window.api.update.check()
        },
        onDownload: () => void window.api.update.download(),
        onInstall: () => void window.api.update.install()
      }}
    />
  )
}
