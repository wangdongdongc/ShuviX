/**
 * 浏览器窗口的键盘快捷键（照 Chrome 的那一套）—— 纯函数：一次按键 → 一个动作，不碰任何状态。
 *
 * 由 browserViewService 接在**每个 tab 页面**与**浏览器窗口外壳**的 `before-input-event` 上：焦点在页面里、
 * 在地址栏里还是在标签条上，按下去都是同一个动作。命中的按键 preventDefault —— 页面收不到它，应用菜单里
 * 同键的项（Window → Close 的 ⌘W、开发菜单的 ⌘R）也不会再触发。
 *
 * 为什么接在 before-input-event 上而不怕 agent：它只为**真实键盘**触发。agent 经 CDP 发的按键
 * （Input.dispatchKeyEvent，press_key / type 都走它）不经过这里 —— 2026-10-16 实测（Electron 39）：
 * CDP 发的 ⌘W 只到页面的 keydown，before-input-event 一次都没响；只有主进程的 sendInputEvent 会触发它，
 * 而产品里没有任何地方用 sendInputEvent 往 tab 里发键。所以 agent 按 ⌘W 关不掉 tab、按 ⌘T 开不出 tab。
 *
 * 刻意不接的：
 * - macOS 的 ⌘← / ⌘→（Chrome 里是后退 / 前进）：焦点在输入框时它们是「光标到行首 / 行尾」，而
 *   before-input-event 先于页面拿到按键，接了就把输入框里最常用的一对键吃掉了。⌘[ / ⌘] 照接。
 * - ⌘F 页内查找、Esc 停止加载：前者还没有界面；后者是页面自己最常用的键（关弹层、退出全屏）。
 */

/** 一个快捷键动作；selectTab 的 index 为 -1 表示最后一个 tab（⌘9） */
export type BrowserShortcut =
  | { type: 'newTab' }
  | { type: 'closeTab' }
  | { type: 'reopenClosedTab' }
  | { type: 'focusOmnibox' }
  | { type: 'reload'; ignoreCache: boolean }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'nextTab' }
  | { type: 'previousTab' }
  | { type: 'selectTab'; index: number }
  | { type: 'zoom'; direction: 'in' | 'out' | 'reset' }
  /** 开 / 关选中那页的停靠区（原生 DevTools）：F12、⌥⌘I（macOS）/ Ctrl+Shift+I */
  | { type: 'toggleDevtools' }
  /** 原生 DevTools 开到 Console（开着就关，照 Chrome）：⌥⌘J（macOS）/ Ctrl+Shift+J */
  | { type: 'devtoolsConsole' }
  /** 原生 DevTools 的「选择元素」模式（开 / 退出）：⌥⌘C、⌘⇧C（macOS）/ Ctrl+Shift+C */
  | { type: 'inspectElement' }

/** before-input-event 交来的按键里用得到的那几项（Electron 的 Input 结构的子集） */
export interface ShortcutInput {
  type: string
  /** 按出来的字符（随键盘布局）；字母快捷键按它认，见 letterOf */
  key?: string
  code: string
  shift: boolean
  control: boolean
  alt: boolean
  meta: boolean
  isAutoRepeat?: boolean
}

/** 一按就开 / 关 / 重开 tab（或停靠区）的动作：按住不放不连发，免得一下子关掉一排、开了又关 */
const NO_REPEAT = new Set<BrowserShortcut['type']>([
  'newTab',
  'closeTab',
  'reopenClosedTab',
  'toggleDevtools',
  'devtoolsConsole',
  'inspectElement'
])

/**
 * 按键 → 动作；不是浏览器快捷键回 null（按键照常交给页面 / 外壳）。
 * 主修饰键：macOS 是 ⌘，其余平台是 Ctrl；按键按物理键位（`code`）认，与键盘布局无关。
 */
export function browserShortcutFor(
  input: ShortcutInput,
  platform: NodeJS.Platform
): BrowserShortcut | null {
  if (input.type !== 'keyDown') return null
  const action = match(input, platform === 'darwin')
  if (!action) return null
  if (input.isAutoRepeat && NO_REPEAT.has(action.type)) return null
  return action
}

/**
 * 字母快捷键认哪个字母：照 Chrome 按**键盘布局上打出来的**字母（AZERTY 上 ⌘W 是写着 W 的那个键），
 * 打出来的不是拉丁字母（俄文布局之类）时退回物理键位，与 Chrome 在这类布局上的做法一致。
 */
function letterOf(input: ShortcutInput): string | null {
  if (input.key && /^[a-z]$/i.test(input.key)) return input.key.toLowerCase()
  const m = /^Key([A-Z])$/.exec(input.code)
  return m ? m[1].toLowerCase() : null
}

function match(input: ShortcutInput, mac: boolean): BrowserShortcut | null {
  const { code, shift, control, alt, meta } = input
  const letter = letterOf(input)
  /** 只按着主修饰键（可带 Shift） */
  const primary = mac ? meta && !control && !alt : control && !meta && !alt

  // ── 不带主修饰键的 ──
  if (!meta && !control && !shift && !alt) {
    if (code === 'F5') return { type: 'reload', ignoreCache: false }
    if (code === 'F6') return { type: 'focusOmnibox' }
    if (code === 'F12') return { type: 'toggleDevtools' }
    return null
  }
  if (!mac && alt && !control && !meta && !shift) {
    if (code === 'ArrowLeft') return { type: 'back' }
    if (code === 'ArrowRight') return { type: 'forward' }
    if (letter === 'd') return { type: 'focusOmnibox' }
    return null
  }
  if (!mac && (control || shift) && !alt && !meta && code === 'F5') {
    return { type: 'reload', ignoreCache: true }
  }

  // ── Ctrl+Tab / Ctrl+Shift+Tab：所有平台都是切 tab（macOS 上也是 Control，不是 ⌘） ──
  if (control && !meta && !alt && code === 'Tab') {
    return shift ? { type: 'previousTab' } : { type: 'nextTab' }
  }
  if (!mac && control && !meta && !alt && !shift) {
    if (code === 'PageDown') return { type: 'nextTab' }
    if (code === 'PageUp') return { type: 'previousTab' }
  }
  // macOS：⌘⌥→ / ⌘⌥← 切 tab；⌘⌥I / J / C 是 DevTools 的三个键（⌥ 让 key 成了别的字符 —— ⌥⌘I 实测是
  // "Dead"，letterOf 退回物理键位）
  if (mac && meta && alt && !control && !shift) {
    if (code === 'ArrowRight') return { type: 'nextTab' }
    if (code === 'ArrowLeft') return { type: 'previousTab' }
    if (letter === 'i') return { type: 'toggleDevtools' }
    if (letter === 'j') return { type: 'devtoolsConsole' }
    if (letter === 'c') return { type: 'inspectElement' }
    return null
  }

  if (!primary) return null

  if (shift) {
    if (letter === 't') return { type: 'reopenClosedTab' }
    if (letter === 'r') return { type: 'reload', ignoreCache: true }
    if (!mac && letter === 'i') return { type: 'toggleDevtools' }
    if (!mac && letter === 'j') return { type: 'devtoolsConsole' }
    // ⌘⇧C 在 macOS 的 Chrome 里也是「选择元素」
    if (letter === 'c') return { type: 'inspectElement' }
    // macOS：⌘⇧] / ⌘⇧[ 切 tab
    if (mac && code === 'BracketRight') return { type: 'nextTab' }
    if (mac && code === 'BracketLeft') return { type: 'previousTab' }
    // ⌘+ 在多数布局上就是 ⌘⇧=
    if (code === 'Equal') return { type: 'zoom', direction: 'in' }
    return null
  }

  switch (letter) {
    case 't':
      return { type: 'newTab' }
    case 'w':
      return { type: 'closeTab' }
    case 'l':
      return { type: 'focusOmnibox' }
    case 'r':
      return { type: 'reload', ignoreCache: false }
  }
  switch (code) {
    case 'BracketLeft':
      return mac ? { type: 'back' } : null
    case 'BracketRight':
      return mac ? { type: 'forward' } : null
    case 'Equal':
    case 'NumpadAdd':
      return { type: 'zoom', direction: 'in' }
    case 'Minus':
    case 'NumpadSubtract':
      return { type: 'zoom', direction: 'out' }
    case 'Digit0':
    case 'Numpad0':
      return { type: 'zoom', direction: 'reset' }
  }
  const digit = /^Digit([1-9])$/.exec(code)
  if (digit) {
    const n = Number(digit[1])
    return { type: 'selectTab', index: n === 9 ? -1 : n - 1 }
  }
  return null
}

/**
 * Chrome 的缩放档位（百分比）。⌘+ / ⌘− 在这些档之间走；不在档上的当前值先就近落到下一档。
 */
export const ZOOM_STEPS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500
]

/** 从当前缩放（百分比）走一档；reset 回 100 */
export function nextZoomPercent(current: number, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset') return 100
  if (direction === 'in') {
    return ZOOM_STEPS.find((s) => s > current + 0.5) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < current - 0.5) return ZOOM_STEPS[i]
  }
  return ZOOM_STEPS[0]
}
