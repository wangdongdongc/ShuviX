/**
 * 浏览器窗口的键盘快捷键表（shortcuts.ts）—— 纯函数：一次按键 → 一个动作（或 null）。
 *
 *   CB-U1  macOS（⌘ 为主修饰键）：整张表逐项精确对上；字母按键盘布局打出来的字符认（AZERTY 上写着 W 的
 *          那个键是 ⌘W），打出来的不是拉丁字母时退回物理键位；
 *   CB-U2  Windows / Linux：同一张表换成 Ctrl，外加 Alt+D、Ctrl+F5 / Shift+F5 / Ctrl+⇧R、Alt+←/→、
 *          Ctrl+PageDown / PageUp；
 *   CB-U3  macOS 上故意不接的 / 别的平台的键 → null（⌘← ⌘→ 是输入框里的光标键）；
 *   CB-U4  别的平台上不该命中的 → null（Ctrl+[ ]、Meta+T、AltGr 组合、Ctrl+←、Ctrl+F）；
 *   CB-U5  只认 keyDown；按住不放（isAutoRepeat）时开 / 关 / 重开 tab 不连发，其余照发；
 *   CB-U6  Chrome 的缩放档位与 nextZoomPercent 的走法；
 *   DD-U20 开关 DevTools 停靠区：F12（各平台）、⌥⌘I（macOS，⌥ 让 key 成了别的字符也认物理键位）、
 *          Ctrl+Shift+I（Windows / Linux）；别的平台的那一个 → null；按住不放不连发（开了又关）。
 *   DD-U21 DevTools 开到 Console：⌥⌘J（macOS；key 是 ⌥ 打出来的 ∆、Dead 或 j 都认）、Ctrl+Shift+J
 *          （Windows / Linux，非拉丁布局退回物理键位）；别的修饰组合 → null；按住不放不连发。
 *   DD-U22 「选择元素」：⌥⌘C 与 ⌘⇧C（macOS）、Ctrl+Shift+C（Windows / Linux）；⌘C（拷贝）与别的修饰组合
 *          → null；按住不放不连发；⌥⌘ + 物理 I / J / C 的 key 是 Dead 时各归各的动作，⌥⌘K 不是。
 *   SC-1   历史记录页（照 Chrome）：macOS ⌘Y；⌘H（系统的「隐藏」）、⌘⇧Y、⌃Y、⌥⌘Y → null；
 *   SC-2   Windows / Linux Ctrl+H；Ctrl+Y、Ctrl+Shift+H、Alt+H、Ctrl+Alt+H → null；
 *   SC-3   非拉丁布局退回物理键位：macOS ⌘ + key「н」（物理 KeyY）、Windows Ctrl + key「р」（物理 KeyH）→ history。
 */
import { describe, expect, it } from 'vitest'
import {
  browserShortcutFor,
  nextZoomPercent,
  ZOOM_STEPS,
  type BrowserShortcut,
  type ShortcutInput
} from '../shortcuts'

interface Mods {
  shift?: boolean
  control?: boolean
  alt?: boolean
  meta?: boolean
}

/** 一次 keyDown（key 不给时按 code 推：KeyW → 'w'、Digit1 → '1'，其余用 code 本身） */
function press(code: string, mods: Mods = {}, extra: Partial<ShortcutInput> = {}): ShortcutInput {
  const letter = /^Key([A-Z])$/.exec(code)
  const digit = /^Digit(\d)$/.exec(code)
  const key = letter ? letter[1].toLowerCase() : digit ? digit[1] : code
  return {
    type: 'keyDown',
    key,
    code,
    shift: !!mods.shift,
    control: !!mods.control,
    alt: !!mods.alt,
    meta: !!mods.meta,
    ...extra
  }
}

const NEW_TAB: BrowserShortcut = { type: 'newTab' }
const CLOSE_TAB: BrowserShortcut = { type: 'closeTab' }
const REOPEN: BrowserShortcut = { type: 'reopenClosedTab' }
const OMNIBOX: BrowserShortcut = { type: 'focusOmnibox' }
const RELOAD: BrowserShortcut = { type: 'reload', ignoreCache: false }
const HARD_RELOAD: BrowserShortcut = { type: 'reload', ignoreCache: true }
const BACK: BrowserShortcut = { type: 'back' }
const FORWARD: BrowserShortcut = { type: 'forward' }
const NEXT: BrowserShortcut = { type: 'nextTab' }
const PREV: BrowserShortcut = { type: 'previousTab' }
const ZOOM_IN: BrowserShortcut = { type: 'zoom', direction: 'in' }
const ZOOM_OUT: BrowserShortcut = { type: 'zoom', direction: 'out' }
const ZOOM_RESET: BrowserShortcut = { type: 'zoom', direction: 'reset' }
const select = (index: number): BrowserShortcut => ({ type: 'selectTab', index })

/** 主修饰键 + 其余修饰 */
const P = (mac: boolean, more: Mods = {}): Mods =>
  mac ? { meta: true, ...more } : { control: true, ...more }

/** 两类平台都有的那一张表（只差主修饰键） */
function sharedTable(mac: boolean): Array<[string, ShortcutInput, BrowserShortcut]> {
  return [
    ['T newTab', press('KeyT', P(mac)), NEW_TAB],
    ['W closeTab', press('KeyW', P(mac)), CLOSE_TAB],
    ['⇧T reopen', press('KeyT', P(mac, { shift: true })), REOPEN],
    ['L focusOmnibox', press('KeyL', P(mac)), OMNIBOX],
    ['F6 focusOmnibox', press('F6'), OMNIBOX],
    ['R reload', press('KeyR', P(mac)), RELOAD],
    ['F5 reload', press('F5'), RELOAD],
    ['⇧R hard reload', press('KeyR', P(mac, { shift: true })), HARD_RELOAD],
    ['Ctrl+Tab next', press('Tab', { control: true }), NEXT],
    ['Ctrl+⇧Tab prev', press('Tab', { control: true, shift: true }), PREV],
    ['1 → index 0', press('Digit1', P(mac)), select(0)],
    ['2 → index 1', press('Digit2', P(mac)), select(1)],
    ['8 → index 7', press('Digit8', P(mac)), select(7)],
    ['9 → last', press('Digit9', P(mac)), select(-1)],
    ['= zoom in', press('Equal', P(mac)), ZOOM_IN],
    ['⇧= zoom in', press('Equal', P(mac, { shift: true }), { key: '+' }), ZOOM_IN],
    ['NumpadAdd zoom in', press('NumpadAdd', P(mac), { key: '+' }), ZOOM_IN],
    ['- zoom out', press('Minus', P(mac), { key: '-' }), ZOOM_OUT],
    ['NumpadSubtract zoom out', press('NumpadSubtract', P(mac), { key: '-' }), ZOOM_OUT],
    ['0 reset', press('Digit0', P(mac)), ZOOM_RESET],
    ['Numpad0 reset', press('Numpad0', P(mac), { key: '0' }), ZOOM_RESET]
  ]
}

describe('macOS（CB-U1）', () => {
  it.each([
    ...sharedTable(true),
    ['⌘[ back', press('BracketLeft', { meta: true }, { key: '[' }), BACK],
    ['⌘] forward', press('BracketRight', { meta: true }, { key: ']' }), FORWARD],
    ['⌘⌥→ next', press('ArrowRight', { meta: true, alt: true }), NEXT],
    ['⌘⌥← prev', press('ArrowLeft', { meta: true, alt: true }), PREV],
    ['⌘⇧] next', press('BracketRight', { meta: true, shift: true }, { key: '}' }), NEXT],
    ['⌘⇧[ prev', press('BracketLeft', { meta: true, shift: true }, { key: '{' }), PREV]
  ] as Array<[string, ShortcutInput, BrowserShortcut]>)('CB-U1 %s', (_label, input, expected) => {
    expect(browserShortcutFor(input, 'darwin')).toStrictEqual(expected)
  })

  it('CB-U1 字母按布局上打出来的字符认：AZERTY 的 ⌘ + 写着 W 的键（物理 KeyZ）→ closeTab；写着 Z 的键（物理 KeyW）→ null', () => {
    expect(browserShortcutFor(press('KeyZ', { meta: true }, { key: 'w' }), 'darwin')).toStrictEqual(
      CLOSE_TAB
    )
    expect(browserShortcutFor(press('KeyW', { meta: true }, { key: 'z' }), 'darwin')).toBeNull()
  })

  it('CB-U1 打出来的不是拉丁字母（俄文布局 ⌘ц，物理 KeyW）→ 退回物理键位 → closeTab', () => {
    expect(browserShortcutFor(press('KeyW', { meta: true }, { key: 'ц' }), 'darwin')).toStrictEqual(
      CLOSE_TAB
    )
  })

  it('CB-U1 大写字符（Shift 打出来的 T）同样认作 t', () => {
    expect(
      browserShortcutFor(press('KeyT', { meta: true, shift: true }, { key: 'T' }), 'darwin')
    ).toStrictEqual(REOPEN)
  })
})

describe.each(['win32', 'linux'] as const)('%s（CB-U2）', (platform) => {
  it.each([
    ...sharedTable(false),
    ['Alt+D focusOmnibox', press('KeyD', { alt: true }), OMNIBOX],
    ['Ctrl+F5 hard reload', press('F5', { control: true }), HARD_RELOAD],
    ['Shift+F5 hard reload', press('F5', { shift: true }), HARD_RELOAD],
    ['Ctrl+⇧R hard reload', press('KeyR', { control: true, shift: true }), HARD_RELOAD],
    ['Alt+← back', press('ArrowLeft', { alt: true }), BACK],
    ['Alt+→ forward', press('ArrowRight', { alt: true }), FORWARD],
    ['Ctrl+PageDown next', press('PageDown', { control: true }), NEXT],
    ['Ctrl+PageUp prev', press('PageUp', { control: true }), PREV]
  ] as Array<[string, ShortcutInput, BrowserShortcut]>)('CB-U2 %s', (_label, input, expected) => {
    expect(browserShortcutFor(input, platform)).toStrictEqual(expected)
  })

  it('CB-U2 字母同样按布局认（AZERTY Ctrl + 写着 W 的键 → closeTab；俄文 Ctrl+ц → closeTab）', () => {
    expect(
      browserShortcutFor(press('KeyZ', { control: true }, { key: 'w' }), platform)
    ).toStrictEqual(CLOSE_TAB)
    expect(browserShortcutFor(press('KeyW', { control: true }, { key: 'z' }), platform)).toBeNull()
    expect(
      browserShortcutFor(press('KeyW', { control: true }, { key: 'ц' }), platform)
    ).toStrictEqual(CLOSE_TAB)
  })
})

describe('macOS 上不命中的（CB-U3）', () => {
  it.each([
    ['⌘← (caret to line start)', press('ArrowLeft', { meta: true })],
    ['⌘→ (caret to line end)', press('ArrowRight', { meta: true })],
    ['Ctrl+T', press('KeyT', { control: true })],
    ['Ctrl+W', press('KeyW', { control: true })],
    ['Alt+←', press('ArrowLeft', { alt: true })],
    ['Ctrl+PageDown', press('PageDown', { control: true })],
    ['Shift+F5', press('F5', { shift: true })],
    ['Alt+D', press('KeyD', { alt: true })],
    ['⌘Ctrl+W', press('KeyW', { meta: true, control: true })],
    ['⌘⌥T', press('KeyT', { meta: true, alt: true })],
    ['⌘⇧W', press('KeyW', { meta: true, shift: true })],
    ['⌘F', press('KeyF', { meta: true })],
    ['plain T', press('KeyT')],
    ['Shift+T', press('KeyT', { shift: true }, { key: 'T' })],
    ['Escape', press('Escape')]
  ])('CB-U3 %s → null', (_label, input) => {
    expect(browserShortcutFor(input, 'darwin')).toBeNull()
  })
})

describe.each(['win32', 'linux'] as const)('%s 上不命中的（CB-U4）', (platform) => {
  it.each([
    ['Ctrl+[', press('BracketLeft', { control: true }, { key: '[' })],
    ['Ctrl+]', press('BracketRight', { control: true }, { key: ']' })],
    ['Meta+T', press('KeyT', { meta: true })],
    ['Ctrl+Alt+T (AltGr)', press('KeyT', { control: true, alt: true })],
    ['Alt+Shift+←', press('ArrowLeft', { alt: true, shift: true })],
    ['Ctrl+←', press('ArrowLeft', { control: true })],
    ['Ctrl+F', press('KeyF', { control: true })]
  ])('CB-U4 %s → null', (_label, input) => {
    expect(browserShortcutFor(input, platform)).toBeNull()
  })
})

describe('事件类型与按住连发（CB-U5）', () => {
  it.each(['keyUp', 'char'])('CB-U5 type=%s 的 ⌘T / F5 → null', (type) => {
    expect(browserShortcutFor(press('KeyT', { meta: true }, { type }), 'darwin')).toBeNull()
    expect(browserShortcutFor(press('F5', {}, { type }), 'darwin')).toBeNull()
  })

  it('CB-U5 按住不放：开 / 关 / 重开 tab 不连发', () => {
    const repeat = { isAutoRepeat: true }
    expect(browserShortcutFor(press('KeyT', { meta: true }, repeat), 'darwin')).toBeNull()
    expect(browserShortcutFor(press('KeyW', { meta: true }, repeat), 'darwin')).toBeNull()
    expect(
      browserShortcutFor(press('KeyT', { meta: true, shift: true }, repeat), 'darwin')
    ).toBeNull()
    expect(browserShortcutFor(press('KeyW', { control: true }, repeat), 'linux')).toBeNull()
  })

  it('CB-U5 按住不放：刷新 / 缩放 / 切 tab / 后退照发', () => {
    const repeat = { isAutoRepeat: true }
    expect(browserShortcutFor(press('KeyR', { meta: true }, repeat), 'darwin')).toStrictEqual(
      RELOAD
    )
    expect(browserShortcutFor(press('F5', {}, repeat), 'darwin')).toStrictEqual(RELOAD)
    expect(browserShortcutFor(press('Equal', { meta: true }, repeat), 'darwin')).toStrictEqual(
      ZOOM_IN
    )
    expect(browserShortcutFor(press('Minus', { meta: true }, repeat), 'darwin')).toStrictEqual(
      ZOOM_OUT
    )
    expect(browserShortcutFor(press('Tab', { control: true }, repeat), 'darwin')).toStrictEqual(
      NEXT
    )
    expect(
      browserShortcutFor(press('BracketLeft', { meta: true }, repeat), 'darwin')
    ).toStrictEqual(BACK)
    expect(browserShortcutFor(press('ArrowLeft', { alt: true }, repeat), 'win32')).toStrictEqual(
      BACK
    )
  })

  it('CB-U5 isAutoRepeat:false 与不给一样', () => {
    expect(
      browserShortcutFor(press('KeyT', { meta: true }, { isAutoRepeat: false }), 'darwin')
    ).toStrictEqual(NEW_TAB)
  })
})

describe('缩放档位（CB-U6）', () => {
  it('CB-U6 ZOOM_STEPS 是 Chrome 的那一串', () => {
    expect(ZOOM_STEPS).toEqual([
      25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500
    ])
  })

  it.each([
    [100, 'in', 110],
    [110, 'in', 125],
    [500, 'in', 500],
    [25, 'in', 33],
    [105, 'in', 110],
    [100, 'out', 90],
    [110, 'out', 100],
    [105, 'out', 100],
    [25, 'out', 25],
    [100, 'reset', 100],
    [250, 'reset', 100],
    [25, 'reset', 100]
  ] as const)('CB-U6 nextZoomPercent(%d, %s) → %d', (current, direction, expected) => {
    expect(nextZoomPercent(current, direction)).toBe(expected)
  })

  it('CB-U6 从 25 一路 in：走过每一档，停在 500', () => {
    const seen = [25]
    let z = 25
    for (let i = 0; i < ZOOM_STEPS.length + 3; i++) {
      z = nextZoomPercent(z, 'in')
      if (z !== seen[seen.length - 1]) seen.push(z)
    }
    expect(seen).toEqual(ZOOM_STEPS)
    expect(z).toBe(500)
  })

  it('CB-U6 从 500 一路 out：走过每一档，停在 25', () => {
    const seen = [500]
    let z = 500
    for (let i = 0; i < ZOOM_STEPS.length + 3; i++) {
      z = nextZoomPercent(z, 'out')
      if (z !== seen[seen.length - 1]) seen.push(z)
    }
    expect(seen).toEqual([...ZOOM_STEPS].reverse())
    expect(z).toBe(25)
  })
})

describe('开关 DevTools 停靠区（DD-U20）', () => {
  const DEVTOOLS: BrowserShortcut = { type: 'toggleDevtools' }

  it.each(['darwin', 'win32', 'linux'] as const)('DD-U20 %s：F12', (platform) => {
    expect(browserShortcutFor(press('F12'), platform)).toStrictEqual(DEVTOOLS)
  })

  it('DD-U20 macOS：⌥⌘I —— key 是 ⌥ 打出来的字符（ˆ）、或者就是 i，都认', () => {
    expect(
      browserShortcutFor(press('KeyI', { meta: true, alt: true }, { key: 'ˆ' }), 'darwin')
    ).toStrictEqual(DEVTOOLS)
    expect(browserShortcutFor(press('KeyI', { meta: true, alt: true }), 'darwin')).toStrictEqual(
      DEVTOOLS
    )
    // Windows / Linux 的那一个在 macOS 上不是
    expect(
      browserShortcutFor(press('KeyI', { control: true, shift: true }, { key: 'I' }), 'darwin')
    ).toBeNull()
    expect(browserShortcutFor(press('KeyI', { meta: true }), 'darwin')).toBeNull()
  })

  it.each(['win32', 'linux'] as const)('DD-U20 %s：Ctrl+Shift+I；⌘⌥I 不是', (platform) => {
    expect(
      browserShortcutFor(press('KeyI', { control: true, shift: true }, { key: 'I' }), platform)
    ).toStrictEqual(DEVTOOLS)
    expect(browserShortcutFor(press('KeyI', { meta: true, alt: true }), platform)).toBeNull()
    expect(browserShortcutFor(press('KeyI', { control: true }), platform)).toBeNull()
  })

  it('DD-U20 按住不放不连发（不然开了又关）', () => {
    const repeat = { isAutoRepeat: true }
    expect(browserShortcutFor(press('F12', {}, repeat), 'darwin')).toBeNull()
    expect(
      browserShortcutFor(press('KeyI', { meta: true, alt: true }, repeat), 'darwin')
    ).toBeNull()
    expect(
      browserShortcutFor(press('KeyI', { control: true, shift: true }, repeat), 'linux')
    ).toBeNull()
  })
})

const CONSOLE: BrowserShortcut = { type: 'devtoolsConsole' }
const INSPECT: BrowserShortcut = { type: 'inspectElement' }

describe('DevTools 开到 Console（DD-U21）', () => {
  it.each(['∆', 'Dead', 'j'])('DD-U21 macOS：⌥⌘J，key = %s → devtoolsConsole', (key) => {
    expect(
      browserShortcutFor(press('KeyJ', { meta: true, alt: true }, { key }), 'darwin')
    ).toStrictEqual(CONSOLE)
  })

  it.each([
    ['Ctrl+Shift+J', press('KeyJ', { control: true, shift: true }, { key: 'J' })],
    ['⌘⇧J', press('KeyJ', { meta: true, shift: true }, { key: 'J' })],
    ['⌘J', press('KeyJ', { meta: true })],
    ['⌥J', press('KeyJ', { alt: true })],
    ['⌥⌘⇧J', press('KeyJ', { meta: true, alt: true, shift: true })]
  ])('DD-U21 macOS：%s → null', (_label, input) => {
    expect(browserShortcutFor(input, 'darwin')).toBeNull()
  })

  describe.each(['win32', 'linux'] as const)('%s', (platform) => {
    it('DD-U21 Ctrl+Shift+J → devtoolsConsole；俄文布局（key о，物理 KeyJ）同样', () => {
      expect(
        browserShortcutFor(press('KeyJ', { control: true, shift: true }, { key: 'J' }), platform)
      ).toStrictEqual(CONSOLE)
      expect(
        browserShortcutFor(press('KeyJ', { control: true, shift: true }, { key: 'о' }), platform)
      ).toStrictEqual(CONSOLE)
    })

    it.each([
      ['Ctrl+J', press('KeyJ', { control: true })],
      ['Meta+Alt+J', press('KeyJ', { meta: true, alt: true })],
      ['Ctrl+Alt+J', press('KeyJ', { control: true, alt: true })],
      ['Ctrl+Shift+Alt+J', press('KeyJ', { control: true, shift: true, alt: true })],
      ['Meta+Shift+J', press('KeyJ', { meta: true, shift: true })]
    ])('DD-U21 %s → null', (_label, input) => {
      expect(browserShortcutFor(input, platform)).toBeNull()
    })
  })

  it('DD-U21 按住不放不连发（开了又关）；isAutoRepeat:false 照发', () => {
    const repeat = { isAutoRepeat: true }
    expect(
      browserShortcutFor(press('KeyJ', { meta: true, alt: true }, repeat), 'darwin')
    ).toBeNull()
    expect(
      browserShortcutFor(press('KeyJ', { control: true, shift: true }, repeat), 'linux')
    ).toBeNull()
    const once = { isAutoRepeat: false }
    expect(
      browserShortcutFor(press('KeyJ', { meta: true, alt: true }, once), 'darwin')
    ).toStrictEqual(CONSOLE)
    expect(
      browserShortcutFor(press('KeyJ', { control: true, shift: true }, once), 'linux')
    ).toStrictEqual(CONSOLE)
  })
})

describe('「选择元素」（DD-U22）', () => {
  it.each([
    ['⌥⌘C key ç', press('KeyC', { meta: true, alt: true }, { key: 'ç' })],
    ['⌥⌘C key Dead', press('KeyC', { meta: true, alt: true }, { key: 'Dead' })],
    ['⌥⌘C key c', press('KeyC', { meta: true, alt: true }, { key: 'c' })],
    ['⌘⇧C', press('KeyC', { meta: true, shift: true }, { key: 'C' })]
  ])('DD-U22 macOS：%s → inspectElement', (_label, input) => {
    expect(browserShortcutFor(input, 'darwin')).toStrictEqual(INSPECT)
  })

  it.each([
    ['⌘C (copy)', press('KeyC', { meta: true })],
    ['Ctrl+Shift+C', press('KeyC', { control: true, shift: true }, { key: 'C' })],
    ['⌥C', press('KeyC', { alt: true })],
    ['Ctrl+C', press('KeyC', { control: true })],
    ['⌥⌘⇧C', press('KeyC', { meta: true, alt: true, shift: true })]
  ])('DD-U22 macOS：%s → null', (_label, input) => {
    expect(browserShortcutFor(input, 'darwin')).toBeNull()
  })

  describe.each(['win32', 'linux'] as const)('%s', (platform) => {
    it('DD-U22 Ctrl+Shift+C → inspectElement', () => {
      expect(
        browserShortcutFor(press('KeyC', { control: true, shift: true }, { key: 'C' }), platform)
      ).toStrictEqual(INSPECT)
    })

    it.each([
      ['Ctrl+C', press('KeyC', { control: true })],
      ['Meta+Shift+C', press('KeyC', { meta: true, shift: true })],
      ['Ctrl+Alt+C', press('KeyC', { control: true, alt: true })],
      ['Ctrl+Shift+Alt+C', press('KeyC', { control: true, shift: true, alt: true })],
      ['Meta+Alt+C', press('KeyC', { meta: true, alt: true })]
    ])('DD-U22 %s → null', (_label, input) => {
      expect(browserShortcutFor(input, platform)).toBeNull()
    })
  })

  it('DD-U22 按住不放不连发：⌥⌘C、⌘⇧C（macOS）、Ctrl+Shift+C（Windows）', () => {
    const repeat = { isAutoRepeat: true }
    expect(
      browserShortcutFor(press('KeyC', { meta: true, alt: true }, repeat), 'darwin')
    ).toBeNull()
    expect(
      browserShortcutFor(press('KeyC', { meta: true, shift: true }, repeat), 'darwin')
    ).toBeNull()
    expect(
      browserShortcutFor(press('KeyC', { control: true, shift: true }, repeat), 'win32')
    ).toBeNull()
  })

  it.each([
    ['KeyI', { type: 'toggleDevtools' } as BrowserShortcut],
    ['KeyJ', CONSOLE],
    ['KeyC', INSPECT],
    ['KeyK', null]
  ] as const)('DD-U22 macOS：⌥⌘ + 物理 %s、key 是 Dead → %j', (code, expected) => {
    expect(
      browserShortcutFor(press(code, { meta: true, alt: true }, { key: 'Dead' }), 'darwin')
    ).toStrictEqual(expected)
  })
})

describe('历史记录页（SC-1 ~ SC-3）', () => {
  const HISTORY: BrowserShortcut = { type: 'history' }

  it('SC-1 macOS：⌘Y → history', () => {
    expect(browserShortcutFor(press('KeyY', { meta: true }), 'darwin')).toStrictEqual(HISTORY)
  })

  it.each([
    ['⌘H', press('KeyH', { meta: true })],
    ['⌘⇧Y', press('KeyY', { meta: true, shift: true }, { key: 'Y' })],
    ['⌃Y', press('KeyY', { control: true })],
    ['⌥⌘Y', press('KeyY', { meta: true, alt: true }, { key: '¥' })],
    ['Ctrl+H', press('KeyH', { control: true })]
  ])('SC-1 macOS：%s → null', (_label, input) => {
    expect(browserShortcutFor(input, 'darwin')).toBeNull()
  })

  it.each(['win32', 'linux'] as const)('SC-2 %s：Ctrl+H → history', (platform) => {
    expect(browserShortcutFor(press('KeyH', { control: true }), platform)).toStrictEqual(HISTORY)
  })

  it.each(['win32', 'linux'] as const)(
    'SC-2 %s：Ctrl+Y、Ctrl+Shift+H、Alt+H、Ctrl+Alt+H、Meta+Y → null',
    (platform) => {
      for (const [label, input] of [
        ['Ctrl+Y', press('KeyY', { control: true })],
        ['Ctrl+Shift+H', press('KeyH', { control: true, shift: true }, { key: 'H' })],
        ['Alt+H', press('KeyH', { alt: true })],
        ['Ctrl+Alt+H', press('KeyH', { control: true, alt: true })],
        ['Meta+Y', press('KeyY', { meta: true })]
      ] as const) {
        expect(browserShortcutFor(input, platform), label).toBeNull()
      }
    }
  )

  it('SC-3 非拉丁布局退回物理键位：macOS ⌘ +「н」（KeyY）、Windows Ctrl +「р」（KeyH）→ history', () => {
    expect(browserShortcutFor(press('KeyY', { meta: true }, { key: 'н' }), 'darwin')).toStrictEqual(
      HISTORY
    )
    expect(
      browserShortcutFor(press('KeyH', { control: true }, { key: 'р' }), 'win32')
    ).toStrictEqual(HISTORY)
    // 拉丁布局上按布局打出来的字母认：AZERTY 之类把 Y 换了位置的照样是 Y
    expect(browserShortcutFor(press('KeyZ', { meta: true }, { key: 'y' }), 'darwin')).toStrictEqual(
      HISTORY
    )
  })
})
