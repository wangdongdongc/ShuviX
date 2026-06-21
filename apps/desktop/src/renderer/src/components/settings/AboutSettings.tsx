/**
 * 关于页（桌面绑定层）—— 复用共享 AboutTab，注入桌面版本号 + 自动更新 API + 外链。
 */
import { useState, useEffect } from 'react'
import { AboutTab } from '@shuvix/app-shell'
import { useUpdateStore } from '../../stores/updateStore'
import { useSettingsStore } from '../../stores/settingsStore'

export function AboutSettings(): React.JSX.Element {
  const [appVersion, setAppVersion] = useState('')
  const { updateEvent, setUpdateEvent } = useUpdateStore()
  const { autoCheckUpdate } = useSettingsStore()

  useEffect(() => {
    void window.electron.ipcRenderer.invoke('app:version').then((v: string) => setAppVersion(v))
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
