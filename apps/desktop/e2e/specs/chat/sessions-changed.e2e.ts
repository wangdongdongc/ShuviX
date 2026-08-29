/**
 * AppEvent 'session.listChanged'：会话列表成员变化的广播链路
 * （sessionService → appEventBus → app:event IPC → useAppEvent → chatStore.setSessions）。
 *
 * 钉住引入本事件的原始缺口：经 IPC 直接 session.create（不经任何 UI 流程）后，
 * 侧栏此前不会出现该会话 —— 渲染层列表只在初始化拉取一次，全靠 UI 流程手动刷新。
 * 现在创建/删除落库即广播，订阅端重拉，所有窗口的列表自动跟上。
 */
import { afterAll, beforeAll, describe, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { waitRendererReady } from '../../harness/seed'

let app: E2EApp

const rowVisible = (title: string): Promise<boolean> =>
  app.main.eval<boolean>(
    `[...document.querySelectorAll('*')].some((n) => n.childElementCount === 0 && (n.textContent ?? '').includes(${JSON.stringify(title)}))`
  )

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
})

afterAll(async () => {
  await app?.stop()
})

describe('session.listChanged broadcast', () => {
  it('IPC 直建会话 → 无需任何 UI 流程，侧栏出现该会话', async () => {
    await app.main.eval(`window.api.session.create({ title: 'evt-created-session' })`)
    await until(() => rowVisible('evt-created-session'), 'created session appears in sidebar')
  })

  it('IPC 删除会话 → 行随事件消失', async () => {
    const sid = await app.main.eval<string>(
      `window.api.session.create({ title: 'evt-doomed-session' }).then((s) => s.id)`
    )
    await until(() => rowVisible('evt-doomed-session'), 'doomed session appears first')
    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    await until(async () => !(await rowVisible('evt-doomed-session')), 'doomed session disappears')
  })
})
