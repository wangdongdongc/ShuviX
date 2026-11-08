// @vitest-environment jsdom
/**
 * 设置 → 关于（AboutSettings，桌面绑定层）：更新调用本身被拒时（web 客户端断线、无头模式拒绝下载 / 安装）
 * 不会有 update:event 跟来，绑定层把拒绝原因写成一条 error 事件，界面不至于「点了没反应」。
 *
 *   AS-1 up-to-date 时点检查、check 以 Error('disconnected') 拒绝 → store 的 updateEvent 恰是
 *        {type:'error', message:'disconnected'}，AboutTab 收到的也是它，没有未处理的拒绝；
 *        对照：check 成功 → updateEvent 留在点检查时清成的 null
 *   AS-2 download 以带 code 的 Error 拒绝 → {type:'error', message}，不带 code 键；install 以字符串拒绝 →
 *        {type:'error', message: 那个字符串}
 *
 * AboutTab 换成记下 props 的替身（它自己的测试在 app-shell aboutTab.dom.test.ts）；updateStore 用真的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AboutTabProps } from '@shuvix/app-shell'
import type { UpdateEvent } from '@shuvix/chat-protocol/chatApi'

const mocks = vi.hoisted(() => ({ props: null as AboutTabProps | null }))
vi.mock('@shuvix/app-shell', () => ({
  AboutTab: (props: AboutTabProps) => {
    mocks.props = props
    return null
  }
}))
vi.mock('../../../host/hostMedia', () => ({ isWebHost: false }))

import { AboutSettings } from '../AboutSettings'
import { useUpdateStore } from '../../../stores/updateStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const UP_TO_DATE: UpdateEvent = { type: 'up-to-date', version: '0.2.60' }

const api = {
  app: {
    getVersion: vi.fn(async () => '0.2.60'),
    openExternal: vi.fn(async () => undefined),
    revealPath: vi.fn(async () => ({ success: true }))
  },
  appLog: { info: vi.fn(async () => ({ path: '/x' })) },
  update: {
    onEvent: vi.fn(() => () => {}),
    getLastEvent: vi.fn(async () => null),
    check: vi.fn<() => Promise<{ success: boolean }>>(),
    download: vi.fn<() => Promise<{ success: boolean }>>(),
    install: vi.fn<() => Promise<{ success: boolean }>>()
  },
  settings: { set: vi.fn(async () => undefined) }
}

let container: HTMLDivElement
let root: Root
const unhandled = vi.fn()

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(AboutSettings, { onViewLog: vi.fn() }))
  })
  await flush()
}

const props = (): AboutTabProps => {
  if (!mocks.props) throw new Error('AboutTab not rendered')
  return mocks.props
}

beforeEach(() => {
  mocks.props = null
  useUpdateStore.setState({ updateEvent: null })
  api.update.check.mockReset().mockResolvedValue({ success: true })
  api.update.download.mockReset().mockResolvedValue({ success: true })
  api.update.install.mockReset().mockResolvedValue({ success: true })
  ;(window as unknown as { api: typeof api }).api = api
  unhandled.mockReset()
  process.on('unhandledRejection', unhandled)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  process.off('unhandledRejection', unhandled)
})

describe('AboutSettings 接住更新调用的拒绝', () => {
  it('AS-1 检查被拒 → 写成 error 事件；检查成功 → 留在 null', async () => {
    useUpdateStore.setState({ updateEvent: UP_TO_DATE })
    api.update.check.mockRejectedValueOnce(new Error('disconnected'))
    await mount()
    expect(props().update?.event).toStrictEqual(UP_TO_DATE)

    act(() => props().update!.onCheck())
    await flush()
    const expected = { type: 'error', message: 'disconnected' }
    expect(api.update.check).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().updateEvent).toStrictEqual(expected)
    expect(props().update?.event).toStrictEqual(expected)
    expect(unhandled).not.toHaveBeenCalled()

    // 对照：成功的检查不写 error，事件留在点检查时清成的 null（之后由 update:event 推来）
    act(() => props().update!.onCheck())
    await flush()
    expect(api.update.check).toHaveBeenCalledTimes(2)
    expect(useUpdateStore.getState().updateEvent).toBeNull()
    expect(props().update?.event).toBeNull()
  })

  it('AS-2 下载 / 安装被拒 → error 事件，不带 code；字符串原样作 message', async () => {
    await mount()
    api.update.download.mockRejectedValueOnce(
      Object.assign(new Error('ShuviX is running headless…'), { code: 'headless' })
    )
    act(() => props().update!.onDownload())
    await flush()
    const afterDownload = useUpdateStore.getState().updateEvent
    expect(afterDownload).toStrictEqual({ type: 'error', message: 'ShuviX is running headless…' })
    expect('code' in (afterDownload as object)).toBe(false)

    api.update.install.mockRejectedValueOnce('nope')
    act(() => props().update!.onInstall())
    await flush()
    expect(useUpdateStore.getState().updateEvent).toStrictEqual({ type: 'error', message: 'nope' })
    expect(props().update?.event).toStrictEqual({ type: 'error', message: 'nope' })
    expect(unhandled).not.toHaveBeenCalled()
  })
})
