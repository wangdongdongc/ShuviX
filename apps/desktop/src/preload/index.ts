import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_TABLE } from '../shared/apiTable'
import {
  buildApi,
  createCommonOverrides,
  type ApiTransport,
  type DesktopApiOverrides
} from '../shared/buildApi'
import { createSyncBridge } from './syncBridge'

/**
 * 暴露给渲染端的 `window.api`：由通道表（`shared/apiTable.ts`）建出来（`shared/buildApi.ts`），这里只给 Electron
 * 的传输与本宿主的 override。成员说明与类型在 `index.d.ts`（`ShuviXAPI`）—— 本文件的编译配置里看不见它
 * （同名的 index.ts 在场时 tsc 把 index.d.ts 当成它的产物跳过），建出来的类型（`DesktopApi`）与它是否对得上由
 * `src/renderer/src/host/__tests__/apiTableTypes.test.ts` 在 typecheck:web 里核对。
 */

/** ipcRenderer 上的传输：推送的监听器不带 IpcRendererEvent，只收载荷；每次订阅各挂一个监听 */
const transport: ApiTransport = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, listener) => {
    const handler = (_event: IpcRendererEvent, ...payload: unknown[]): void => listener(...payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

const overrides: DesktopApiOverrides = {
  ...createCommonOverrides(transport),
  app: {
    /** 当前运行平台 */
    platform: process.platform as 'darwin' | 'win32' | 'linux'
  },
  /** 视图同步（pi 1.2 / chord2）：chord 链路的帧经 `sync:frame` 两个方向走（带链路 id） */
  sync: createSyncBridge(ipcRenderer)
}

const api = buildApi(API_TABLE, transport, overrides)

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
