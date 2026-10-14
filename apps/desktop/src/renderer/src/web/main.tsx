/**
 * web 客户端入口（server mode phase C，`web.html`）—— 局域网里的浏览器打开 ShuviX 的网络地址时加载的页面。
 *
 * 与桌面窗口跑的是同一个 `App`：差别只在 `window.api` 由谁提供。这里**先**装好 `window.api`（WebSocket 上的
 * 通道表，见 `webApi.ts` / `wsConnection.ts`），**再**动态引入 i18n、样式与 `App` —— 有些模块在求值时就读
 * `window.api`，静态 import 会在本文件的代码跑之前把它们求值掉。
 */
import { NETWORK_WS_PATH } from '../../../shared/networkEnvelope'
import { networkMediaUrl } from '../../../shared/networkRoutes'
import { createWsConnection, type WsConnection } from './wsConnection'
import { createWebApi, webDesktopOnlyChannels, webLocalHandlers } from './webApi'
import { notifyDesktopOnly } from './webNotices'

const wsScheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
// 本地实现里有几条要先问服务端（「在文件管理器中打开」的路径）：经同一条连接，连接建好之后才会被调到
const connectionRef: { current?: WsConnection } = {}
const localInvoke = webLocalHandlers(window, {
  invoke: (channel, ...args) =>
    connectionRef.current
      ? connectionRef.current.transport.invoke(channel, ...args)
      : Promise.reject(new Error('disconnected'))
})

const connection = createWsConnection({
  url: `${wsScheme}//${window.location.host}${NETWORK_WS_PATH}`,
  localInvoke,
  desktopOnly: webDesktopOnlyChannels(localInvoke),
  onDesktopOnly: notifyDesktopOnly
})

connectionRef.current = connection

window.api = createWebApi(connection)

async function start(): Promise<void> {
  await import('../i18n')
  await import('../assets/main.css')
  // 自己拼 shuvix-media:// 的地方（TTS 播放、语音试听）在浏览器里改走网络服务的 /files/media（phase D）
  const { setMediaFileUrlBuilder } = await import('@shuvix/chat-ui')
  setMediaFileUrlBuilder(networkMediaUrl)
  const [{ StrictMode }, { createRoot }, { default: App }, { WebStatusLayer }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../App'),
    import('./WebStatusLayer')
  ])
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
      <WebStatusLayer connection={connection} />
    </StrictMode>
  )
}

void start()
