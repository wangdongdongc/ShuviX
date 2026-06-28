import { useEffect, useState } from 'react'
import { useExtensionChatHost } from './chatHost'
import { ExtSettingsRoute } from './ExtSettingsRoute'
import { ExtMainLayout } from './ExtMainLayout'

/** 简易 hash 路由：#settings 显示设置，否则主界面 */
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const on = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

/**
 * 扩展根组件 —— 仅路由分发（对齐桌面 App.tsx：按 hash 选设置/主界面）。
 * 设置路由与主界面布局各自拆为 ExtSettingsRoute / ExtMainLayout，结构与桌面同构。
 */
export function App(): React.JSX.Element {
  const host = useExtensionChatHost()
  const route = useHashRoute()

  if (route.startsWith('#settings')) {
    return <ExtSettingsRoute host={host} route={route} />
  }
  return <ExtMainLayout host={host} />
}
