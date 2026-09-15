import { describe, it, expect, vi } from 'vitest'
import { dispatchKey, isMacPlatform, KEY_DEFS, type CdpSend } from '../keyboard'

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

type KeyEvent = Record<string, unknown>

/** 按一次键（显式指定平台），返回发出的全部 Input.dispatchKeyEvent 参数 */
async function press(combo: string, mac: boolean): Promise<KeyEvent[]> {
  const { send, events } = recorder()
  await dispatchKey(send, combo, { mac })
  return events
}

/** 主键的按下事件：每个修饰键先各按下一次，主键紧随其后（抬起是按下的镜像，所以恰在正中间） */
function mainDown(events: KeyEvent[]): KeyEvent {
  return events[(events.length - 2) / 2]
}

describe('dispatchKey', () => {
  it('单键：带 text 的 keyDown + keyUp，键码走 windowsVirtualKeyCode', async () => {
    const { send, events } = recorder()
    await dispatchKey(send, 'Enter', { mac: false })
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
      modifiers: 0
    })
    expect(events[1]).toMatchObject({ type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 })
  })

  it('组合键 Control+A：modifier 包住主键，倒序释放', async () => {
    const { send, events } = recorder()
    await dispatchKey(send, 'Control+A', { mac: false })
    expect(events.map((e) => [e.type, e.key])).toEqual([
      ['rawKeyDown', 'Control'],
      ['rawKeyDown', 'A'],
      ['keyUp', 'A'],
      ['keyUp', 'Control']
    ])
    // 主键携带 Control 位掩码 (2)
    expect(events[1]).toMatchObject({ modifiers: 2, code: 'KeyA', windowsVirtualKeyCode: 65 })
  })

  it('多 modifier Meta+Shift+R：掩码合并、倒序释放', async () => {
    const { send, events } = recorder()
    await dispatchKey(send, 'Meta+Shift+R', { mac: false })
    // Meta(4) | Shift(8) = 12
    expect(events.find((e) => e.key === 'R' && e.type === 'rawKeyDown')).toMatchObject({
      modifiers: 12
    })
    const upOrder = events.filter((e) => e.type === 'keyUp').map((e) => e.key)
    expect(upOrder).toEqual(['R', 'Shift', 'Meta'])
  })

  it('单字符键：code 按字母推导，并作为 text 插入', async () => {
    const { send, events } = recorder()
    await dispatchKey(send, 'a', { mac: false })
    expect(events[0]).toMatchObject({ type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' })
  })

  it('数字键 code 为 DigitN；小写字母键码用大写字符码', async () => {
    const { send, events } = recorder()
    await dispatchKey(send, '5', { mac: false })
    expect(events[0]).toMatchObject({ key: '5', code: 'Digit5', windowsVirtualKeyCode: 53 })
    events.length = 0
    await dispatchKey(send, 'a', { mac: false })
    expect(events[0]).toMatchObject({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  })
})

describe('具名键表 KEY_DEFS', () => {
  /** 每个具名键应发出的 windowsVirtualKeyCode —— 独立抄一份，表里的码被改错要能照出来 */
  const VIRTUAL_KEY_CODES: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Space: 32,
    ' ': 32
  }

  it.each(Object.keys(KEY_DEFS))(
    'K1 %j：按下 + 抬起两条事件，键码走 windowsVirtualKeyCode，从不带 keyCode',
    async (name) => {
      const events = await press(name, false)
      expect(events).toHaveLength(2)
      const [down, up] = events
      const code = VIRTUAL_KEY_CODES[name]
      expect(code).toBeDefined()
      expect(down.windowsVirtualKeyCode).toBe(code)
      expect(up).toMatchObject({ type: 'keyUp', windowsVirtualKeyCode: code })
      if (name === 'Enter') {
        expect(down).toMatchObject({ type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r' })
      } else if (name === 'Space' || name === ' ') {
        expect(down).toMatchObject({ type: 'keyDown', key: ' ', code: 'Space', text: ' ' })
      } else {
        // 不产生字符的键：rawKeyDown 且不带 text（带了就会派生 keypress、插进一个字符）
        expect(down).toMatchObject({ type: 'rawKeyDown', key: name, code: name })
        expect(down).not.toHaveProperty('text')
      }
      // CDP 没有 keyCode 参数，传了会被静默丢弃（页面拿到的 keyCode 恒为 0）
      for (const e of events) expect(e).not.toHaveProperty('keyCode')
    }
  )
})

describe('修饰键组合', () => {
  it('K2 Control+Shift+Z：修饰键依次按下、掩码逐个累加；主键不带 text；倒序抬起、掩码逐个撤掉', async () => {
    const events = await press('Control+Shift+Z', false)
    expect(events.map((e) => [e.type, e.key, e.modifiers])).toEqual([
      ['rawKeyDown', 'Control', 2],
      ['rawKeyDown', 'Shift', 10],
      ['rawKeyDown', 'Z', 10],
      ['keyUp', 'Z', 10],
      ['keyUp', 'Shift', 2],
      ['keyUp', 'Control', 0]
    ])
    expect(events[2]).not.toHaveProperty('text')
  })

  it('K2 Shift+a 打出大写 A；Shift+Tab 仍是不带 text 的 rawKeyDown', async () => {
    expect(mainDown(await press('Shift+a', false))).toEqual({
      type: 'keyDown',
      key: 'A',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 8,
      text: 'A',
      unmodifiedText: 'A'
    })
    const tab = mainDown(await press('Shift+Tab', false))
    expect(tab).toMatchObject({ type: 'rawKeyDown', key: 'Tab', modifiers: 8 })
    expect(tab).not.toHaveProperty('text')
  })
})

describe('键名别名与符号键', () => {
  it.each<[string, KeyEvent]>([
    ['enter', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }],
    ['ESC', { type: 'rawKeyDown', key: 'Escape', windowsVirtualKeyCode: 27 }],
    ['return', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }],
    ['del', { type: 'rawKeyDown', key: 'Delete', windowsVirtualKeyCode: 46 }],
    ['up', { type: 'rawKeyDown', key: 'ArrowUp', windowsVirtualKeyCode: 38 }],
    ['pgdn', { type: 'rawKeyDown', key: 'PageDown', windowsVirtualKeyCode: 34 }],
    ['.', { type: 'keyDown', key: '.', code: 'Period', windowsVirtualKeyCode: 190, text: '.' }],
    ['/', { type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, text: '/' }],
    ['+', { type: 'keyDown', key: '+', code: 'Equal', windowsVirtualKeyCode: 187, text: '+' }],
    [
      'Control++',
      { type: 'rawKeyDown', key: '+', code: 'Equal', windowsVirtualKeyCode: 187, modifiers: 2 }
    ],
    ['@', { type: 'keyDown', key: '@', text: '@' }],
    ['F5', { type: 'rawKeyDown', key: 'F5', code: 'F5', windowsVirtualKeyCode: 0 }]
  ])('K3 %j 的主键事件', async (combo, expected) => {
    const main = mainDown(await press(combo, false))
    expect(main).toMatchObject(expected)
    if (expected.type === 'rawKeyDown') expect(main).not.toHaveProperty('text')
  })

  it.each<[string, string, number]>([
    ['ctrl+a', 'Control', 17],
    ['cmd+a', 'Meta', 91],
    ['option+x', 'Alt', 18]
  ])('K3 修饰键别名 %j：先按下 %s', async (combo, key, code) => {
    const events = await press(combo, false)
    expect(events[0]).toMatchObject({ type: 'rawKeyDown', key, windowsVirtualKeyCode: code })
  })
})

describe('macOS 编辑命令', () => {
  it.each<[string, string]>([
    ['Control+A', 'selectAll'],
    ['Control+C', 'copy'],
    ['Control+V', 'paste'],
    ['Control+X', 'cut'],
    ['Control+Z', 'undo'],
    ['Control+Shift+Z', 'redo'],
    ['ControlOrMeta+V', 'paste'],
    ['Meta+A', 'selectAll'],
    ['Alt+Backspace', 'deleteWordBackward'],
    ['Meta+ArrowLeft', 'moveToLeftEndOfLine'],
    ['Shift+Meta+ArrowDown', 'moveToEndOfDocumentAndModifySelection']
  ])('K4 Mac 上 %s → commands ["%s"]', async (combo, command) => {
    const events = await press(combo, true)
    const main = mainDown(events)
    expect(main.commands).toEqual([command])
    expect(main).not.toHaveProperty('text')
    if (combo.startsWith('Control')) {
      // agent 写的 Control 在 Mac 上换成 ⌘：一条 Control 事件都没有，主键带 Meta 位（4）、不带 Control 位（2）
      expect(events.filter((e) => e.key === 'Control')).toEqual([])
      expect(Number(main.modifiers) & 4).toBe(4)
      expect(Number(main.modifiers) & 2).toBe(0)
    }
  })

  it('K4 边界：Control+Y 换成 ⌘ 但没有命令；Control+E 保持 Control；无修饰的编辑键不带命令', async () => {
    const y = await press('Control+Y', true)
    expect(y[0]).toMatchObject({ type: 'rawKeyDown', key: 'Meta' })
    expect(mainDown(y)).not.toHaveProperty('commands')

    const e = await press('Control+E', true)
    expect(e[0]).toMatchObject({ type: 'rawKeyDown', key: 'Control' })
    expect(mainDown(e)).toMatchObject({ key: 'E', modifiers: 2 })
    expect(mainDown(e)).not.toHaveProperty('commands')

    for (const combo of ['Backspace', 'ArrowLeft']) {
      expect(mainDown(await press(combo, true))).not.toHaveProperty('commands')
    }
  })

  it.each(['Control+A', 'Alt+Backspace', 'Meta+ArrowLeft'])(
    'K5 非 Mac 上 %s 不带 commands',
    async (combo) => {
      const events = await press(combo, false)
      expect(events.filter((e) => 'commands' in e)).toEqual([])
    }
  )

  it('K5 非 Mac 上 ControlOrMeta 就是 Control', async () => {
    const events = await press('ControlOrMeta+V', false)
    expect(events[0]).toMatchObject({
      type: 'rawKeyDown',
      key: 'Control',
      windowsVirtualKeyCode: 17
    })
    expect(mainDown(events)).toMatchObject({ key: 'V', modifiers: 2 })
  })
})

describe('写错的按键描述', () => {
  it.each<[string, RegExp]>([
    ['a+b', /Unknown modifier "a"/],
    ['Control+', /Missing key/]
  ])('K6 %j → 拒绝，一条事件都不发', async (combo, error) => {
    const { send } = recorder()
    await expect(dispatchKey(send, combo, { mac: false })).rejects.toThrow(error)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('isMacPlatform', () => {
  /** 把 process.platform 钉成 platform 跑 fn，结束后原样还原属性描述符 */
  async function onPlatform(platform: string, fn: () => unknown): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...original, value: platform })
    try {
      await fn()
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  }

  it('K7 按 process.platform 判定：darwin 为真，linux 为假', async () => {
    const real = process.platform
    await onPlatform('darwin', () => expect(isMacPlatform()).toBe(true))
    await onPlatform('linux', () => expect(isMacPlatform()).toBe(false))
    expect(process.platform).toBe(real)
  })

  it('K7 不传 mac 时跟随运行平台：darwin 上 Control+A 先按 Meta，linux 上先按 Control', async () => {
    await onPlatform('darwin', async () => {
      const { send, events } = recorder()
      await dispatchKey(send, 'Control+A')
      expect(events[0]).toMatchObject({ type: 'rawKeyDown', key: 'Meta' })
    })
    await onPlatform('linux', async () => {
      const { send, events } = recorder()
      await dispatchKey(send, 'Control+A')
      expect(events[0]).toMatchObject({ type: 'rawKeyDown', key: 'Control' })
    })
  })
})

describe('宽松写法', () => {
  const emoji = String.fromCodePoint(0x1f600)

  it.each<[string, KeyEvent]>([
    [
      'Shift + Tab',
      { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 }
    ],
    ['Control + A', { type: 'rawKeyDown', key: 'A', modifiers: 2 }],
    [' ', { type: 'keyDown', key: ' ', text: ' ' }],
    [emoji, { type: 'keyDown', key: emoji, text: emoji, code: '', windowsVirtualKeyCode: 0 }]
  ])(
    'K8 %j 的主键事件（组合键里的空格被 trim、单独的空格是空格键、BMP 外字符算一个字符）',
    async (combo, expected) => {
      const main = mainDown(await press(combo, false))
      expect(main).toMatchObject(expected)
      if (expected.type === 'rawKeyDown') expect(main).not.toHaveProperty('text')
    }
  )
})
