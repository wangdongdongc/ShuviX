/**
 * LLM 日志记录开关：默认关闭 + UI 与设置双向一致。
 *
 * 默认关闭是这条特性的全部意义（请求体是整段上下文快照，逐步落盘会让库 O(N²) 膨胀），
 * 所以「全新实例里 httpLog.enabled 未写过 = 关闭」是必须锁住的不变量。
 *
 * P3-13-28：pi-durable 迁移期间记录暂停 —— 「已暂停」横幅常显（开关关着、打开之后都在），开关照常可切，
 * list IPC 照常答（已有日志仍可查看）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { httpLogPane, type HttpLogPane } from '../../harness/pages'
import { until, type CdpClient } from '../../harness/cdp'

const KEY = 'httpLog.enabled'

let app: E2EApp
let settings: CdpClient
let pane: HttpLogPane

beforeAll(async () => {
  app = await launchApp()
  settings = await app.openSettings('monitor/httpLogs')
  pane = await httpLogPane(settings)
})
afterAll(async () => {
  await app.stop()
})

const setting = (): Promise<string | undefined> =>
  app.main.eval(`window.api.settings.get(${JSON.stringify(KEY)})`)

describe('LLM 日志记录开关', () => {
  it('全新实例：设置未写过，开关呈关闭态', async () => {
    expect(await setting()).toBeFalsy()
    expect(await pane.recordOn()).toBe(false)
  })

  it('关闭时状态行给出「记录已关闭」而非中性空态', async () => {
    // 开关状态是异步读出来的，轮询到落定
    const text = await until(async () => {
      const current = await pane.statusText()
      return /关闭|off|オフ/i.test(current) ? current : ''
    }, 'disabled hint in status bar')
    expect(text).toMatch(/关闭|off|オフ/i)
  })

  it('开启后写入设置；关闭后写回 false', async () => {
    await pane.toggleRecord()
    expect(await pane.recordOn()).toBe(true)
    expect(await setting()).toBe('true')

    await pane.toggleRecord()
    expect(await pane.recordOn()).toBe(false)
    expect(await setting()).toBe('false')
  })

  // 注：隔离实例无 API key，本来就不会发出请求 —— 这条只是 list 通路的冒烟，
  // 「关闭即不写库」的真正断言在 src/main/services/__tests__/httpLogService.test.ts。
  it('全新实例日志表为空（list IPC 通路可用）', async () => {
    const rows = await app.main.eval<unknown[]>(`window.api.httpLog.list({ limit: 10 })`)
    expect(rows).toEqual([])
  })

  it('P3-13-28 the paused banner shows with the toggle off and stays after toggling on (then off again)', async () => {
    expect(await pane.recordOn()).toBe(false)
    const off = await until(async () => (await pane.pausedText()) || null, 'paused banner')
    expect(off.length).toBeGreaterThan(0)

    await pane.toggleRecord()
    expect(await pane.recordOn()).toBe(true)
    expect(await pane.pausedText()).toBe(off)
    // 开着时状态行不再说「记录中」：横幅替它说
    expect(await settings.eval<string>(`document.body.textContent ?? ''`)).not.toMatch(
      /记录中|Recording:|記録中/
    )

    await pane.toggleRecord()
    expect(await pane.recordOn()).toBe(false)
    expect(await setting()).toBe('false')
    expect(await pane.pausedText()).toBe(off)
  })

  it('P3-13-28 history stays viewable while paused: the list IPC still answers', async () => {
    const rows = await app.main.eval<unknown[]>(`window.api.httpLog.list({ limit: 10 })`)
    expect(Array.isArray(rows)).toBe(true)
    expect(await pane.pausedText()).not.toBe('')
  })
})
