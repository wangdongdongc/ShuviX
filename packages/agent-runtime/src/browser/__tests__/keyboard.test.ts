import { describe, it, expect, vi } from 'vitest'
import { dispatchKey, type CdpSend } from '../keyboard'

function recorder(): {
  send: CdpSend
  events: Array<Record<string, unknown>>
} {
  const events: Array<Record<string, unknown>> = []
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Input.dispatchKeyEvent') events.push(params!)
    return {} as never
  })
  return { send, events }
}

describe('dispatchKey', () => {
  it('单键：keyDown + keyUp', async () => {
    const { send, events } = recorder()
    await dispatchKey(send, 'Enter')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'keyDown', key: 'Enter', keyCode: 13, modifiers: 0 })
    expect(events[1]).toMatchObject({ type: 'keyUp', key: 'Enter' })
  })

  it('组合键 Control+A：modifier 包住主键，倒序释放', async () => {
    const { send, events } = recorder()
    await dispatchKey(send, 'Control+A')
    expect(events.map((e) => [e.type, e.key])).toEqual([
      ['keyDown', 'Control'],
      ['keyDown', 'A'],
      ['keyUp', 'A'],
      ['keyUp', 'Control']
    ])
    // 主键携带 Control 位掩码 (2)
    expect(events[1]).toMatchObject({ modifiers: 2, code: 'KeyA' })
  })

  it('多 modifier Meta+Shift+R：掩码合并、倒序释放', async () => {
    const { send, events } = recorder()
    await dispatchKey(send, 'Meta+Shift+R')
    // Meta(4) | Shift(8) = 12
    expect(events.find((e) => e.key === 'R' && e.type === 'keyDown')).toMatchObject({
      modifiers: 12
    })
    const upOrder = events.filter((e) => e.type === 'keyUp').map((e) => e.key)
    expect(upOrder).toEqual(['R', 'Shift', 'Meta'])
  })

  it('未知单字符键回退到 charCode', async () => {
    const { send, events } = recorder()
    await dispatchKey(send, 'a')
    expect(events[0]).toMatchObject({ key: 'a', code: 'KeyA' })
  })

  it('数字键 code 为 DigitN；小写字母 keyCode 用大写字符码', async () => {
    const { send, events } = recorder()
    await dispatchKey(send, '5')
    expect(events[0]).toMatchObject({ key: '5', code: 'Digit5', keyCode: 53 })
    events.length = 0
    await dispatchKey(send, 'a')
    expect(events[0]).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65 })
  })
})
