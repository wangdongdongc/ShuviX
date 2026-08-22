/**
 * LLM 日志记录开关：默认关闭 + UI 与设置双向一致。
 *
 * 默认关闭是这条特性的全部意义（请求体是整段上下文快照，逐步落盘会让库 O(N²) 膨胀），
 * 所以「全新实例里 httpLog.enabled 未写过 = 关闭」是必须锁住的不变量。
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
})
