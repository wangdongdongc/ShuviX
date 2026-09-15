/**
 * 键盘分发 —— 把 "Enter" / "Control+A" 这样的按键描述翻译成 CDP Input.dispatchKeyEvent（两端共享）。
 *
 * 一次按键要带齐三样东西，缺一样页面就「收到了按键却什么也没发生」（实测 Electron 39）：
 *   - **windowsVirtualKeyCode**：DOM 的 event.keyCode，以及 Blink 把按键翻译成编辑命令
 *     （Backspace 删字、方向键移光标、Shift+方向键选中）都读它。CDP 里没有叫 `keyCode` 的参数 ——
 *     早先传的正是 `keyCode`，被协议静默丢弃：Backspace / 方向键全部失效，页面拿到的 keyCode 恒为 0
 *     （按 `keyCode === 13` 判回车的站点永远等不到回车）。
 *   - **text**：只有带 text 的 keyDown 才会派生 keypress 并插入字符。表单的隐式提交挂在 Enter 的
 *     keypress（charCode 13）上 —— 不带 text 的回车提交不了表单，单字符键也打不出字。
 *   - **commands**（仅 macOS）：Mac 上 ⌘A 这类快捷键由系统输入层翻译成编辑命令，合成的按键绕过了
 *     这一层，selectAll 等必须显式给出命令名（与 Playwright 的做法一致）。
 */

export type CdpSend = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

interface KeyDef {
  key: string
  code: string
  /** 作为 windowsVirtualKeyCode 发出 */
  keyCode: number
  /** 按下时插入的字符（派生 keypress）；没有 text 的键只发 rawKeyDown */
  text?: string
}

/** 常用具名键（help 手册据此列出可用键名） */
export const KEY_DEFS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' }
}

/** 具名键的宽松写法（大小写不敏感） */
const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pgdn: 'PageDown'
}

const NAMED_KEYS = new Map(Object.entries(KEY_DEFS).map(([name, def]) => [name.toLowerCase(), def]))

/** US 键盘上符号键的 code 与 keyCode（字符本身作为 text 插入） */
const SYMBOL_KEYS: Record<string, [code: string, keyCode: number]> = {
  '-': ['Minus', 189],
  _: ['Minus', 189],
  '=': ['Equal', 187],
  '+': ['Equal', 187],
  '[': ['BracketLeft', 219],
  '{': ['BracketLeft', 219],
  ']': ['BracketRight', 221],
  '}': ['BracketRight', 221],
  '\\': ['Backslash', 220],
  '|': ['Backslash', 220],
  ';': ['Semicolon', 186],
  ':': ['Semicolon', 186],
  "'": ['Quote', 222],
  '"': ['Quote', 222],
  ',': ['Comma', 188],
  '<': ['Comma', 188],
  '.': ['Period', 190],
  '>': ['Period', 190],
  '/': ['Slash', 191],
  '?': ['Slash', 191],
  '`': ['Backquote', 192],
  '~': ['Backquote', 192]
}

type ModifierName = 'Alt' | 'Control' | 'Meta' | 'Shift'

const MODIFIERS: Record<ModifierName, KeyDef & { bit: number }> = {
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, bit: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, bit: 2 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, bit: 4 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, bit: 8 }
}

/**
 * macOS 编辑命令。键 = 按 Shift/Control/Alt/Meta 顺序排列的修饰键 + 主键 code。
 * 只收 Blink 自己的按键表在 Mac 上翻译不出来的组合（Backspace、方向键、Shift+方向键不需要，实测照常生效）。
 */
const MAC_EDITING_COMMANDS: Record<string, string> = {
  'Meta+KeyA': 'selectAll',
  'Meta+KeyC': 'copy',
  'Meta+KeyX': 'cut',
  'Meta+KeyV': 'paste',
  'Meta+KeyZ': 'undo',
  'Shift+Meta+KeyZ': 'redo',
  'Alt+Backspace': 'deleteWordBackward',
  'Alt+Delete': 'deleteWordForward',
  'Alt+ArrowLeft': 'moveWordLeft',
  'Alt+ArrowRight': 'moveWordRight',
  'Shift+Alt+ArrowLeft': 'moveWordLeftAndModifySelection',
  'Shift+Alt+ArrowRight': 'moveWordRightAndModifySelection',
  'Meta+Backspace': 'deleteToBeginningOfLine',
  'Meta+ArrowLeft': 'moveToLeftEndOfLine',
  'Meta+ArrowRight': 'moveToRightEndOfLine',
  'Meta+ArrowUp': 'moveToBeginningOfDocument',
  'Meta+ArrowDown': 'moveToEndOfDocument',
  'Shift+Meta+ArrowLeft': 'moveToLeftEndOfLineAndModifySelection',
  'Shift+Meta+ArrowRight': 'moveToRightEndOfLineAndModifySelection',
  'Shift+Meta+ArrowUp': 'moveToBeginningOfDocumentAndModifySelection',
  'Shift+Meta+ArrowDown': 'moveToEndOfDocumentAndModifySelection'
}

/** 浏览器所在平台是否 macOS：桌面主进程看 process.platform，扩展（浏览器环境）看 navigator */
export function isMacPlatform(): boolean {
  const g = globalThis as {
    process?: { platform?: string; versions?: { node?: string } }
    navigator?: { platform?: string; userAgentData?: { platform?: string } }
  }
  if (g.process?.versions?.node && typeof g.process.platform === 'string') {
    return g.process.platform === 'darwin'
  }
  const nav = g.navigator
  return /mac/i.test(nav?.userAgentData?.platform ?? nav?.platform ?? '')
}

function modifierOf(raw: string, mac: boolean): ModifierName | null {
  switch (raw.trim().toLowerCase()) {
    case 'control':
    case 'ctrl':
      return 'Control'
    case 'alt':
    case 'option':
      return 'Alt'
    case 'shift':
      return 'Shift'
    case 'meta':
    case 'cmd':
    case 'command':
      return 'Meta'
    case 'controlormeta':
      return mac ? 'Meta' : 'Control'
    default:
      return null
  }
}

function parseCombo(combo: string, mac: boolean): { mods: ModifierName[]; main: string } {
  // 主键本身是加号："+" / "Control++"
  const parts =
    combo === '+'
      ? ['+']
      : combo.endsWith('++')
        ? [...combo.slice(0, -2).split('+'), '+']
        : combo.split('+')
  const last = parts.pop() ?? ''
  // "Shift + Tab" 这种带空格的写法主键也要 trim；但单独一个空格就是空格键
  const main = last.trim() || (last.length > 0 ? ' ' : '')
  const mods: ModifierName[] = []
  for (const raw of parts) {
    const mod = modifierOf(raw, mac)
    if (!mod) {
      throw new Error(
        `Unknown modifier "${raw}" in "${combo}" — use Control, Alt, Shift, Meta or ControlOrMeta.`
      )
    }
    if (!mods.includes(mod)) mods.push(mod)
  }
  // agent 写 Control+A 几乎总是想要「全选」；Mac 上那是 ⌘A（Control+A 在 Mac 是移到行首）
  if (mac && mods.includes('Control') && !mods.includes('Meta') && /^[acvxyz]$/i.test(main)) {
    mods[mods.indexOf('Control')] = 'Meta'
  }
  return { mods, main }
}

function keyDefinition(main: string, combo: string): KeyDef {
  const named = NAMED_KEYS.get(main.toLowerCase()) ?? KEY_DEFS[KEY_ALIASES[main.toLowerCase()]]
  if (named) return named
  // 按码点数判「单个字符」：emoji 等 BMP 以外的字符是两个 UTF-16 单元
  if ([...main].length === 1) {
    if (/[a-z]/i.test(main)) {
      return {
        key: main,
        code: `Key${main.toUpperCase()}`,
        keyCode: main.toUpperCase().charCodeAt(0),
        text: main
      }
    }
    if (/[0-9]/.test(main)) {
      return { key: main, code: `Digit${main}`, keyCode: main.charCodeAt(0), text: main }
    }
    const [code, keyCode] = SYMBOL_KEYS[main] ?? ['', 0]
    return { key: main, code, keyCode, text: main }
  }
  if (!main) throw new Error(`Missing key in "${combo}" — e.g. "Enter", "a", "Control+A".`)
  // 其余多字符键名（F5、Insert…）按 DOM key 原样发出：页面的 key 监听收得到，编辑命令不会触发
  return { key: main, code: main, keyCode: 0 }
}

export interface DispatchKeyOptions {
  /** 目标浏览器是否跑在 macOS（决定 commands 与 Control→⌘ 映射）；缺省按当前运行平台判定 */
  mac?: boolean
}

/** 分发一次按键（支持组合键如 "Control+A"、"Meta+Shift+R"、"Shift+Tab"） */
export async function dispatchKey(
  send: CdpSend,
  combo: string,
  opts: DispatchKeyOptions = {}
): Promise<void> {
  const mac = opts.mac ?? isMacPlatform()
  const { mods, main } = parseCombo(combo, mac)
  const def = keyDefinition(main, combo)
  const modifiers = mods.reduce((bits, m) => bits | MODIFIERS[m].bit, 0)

  let key = def.key
  let text = def.text
  if (mods.includes('Shift') && /^[a-z]$/.test(main)) {
    key = main.toUpperCase()
    text = key
  }
  // 按住 Control/Alt/Meta 时不产生字符：Control+A 不该顺手打出一个 a
  if (modifiers & ~MODIFIERS.Shift.bit) text = undefined

  const shortcut = [
    ...(['Shift', 'Control', 'Alt', 'Meta'] as const).filter((m) => mods.includes(m)),
    def.code
  ].join('+')
  const command = mac ? MAC_EDITING_COMMANDS[shortcut] : undefined

  let held = 0
  for (const m of mods) {
    const mod = MODIFIERS[m]
    held |= mod.bit
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: mod.key,
      code: mod.code,
      windowsVirtualKeyCode: mod.keyCode,
      modifiers: held
    })
  }

  await send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    modifiers,
    ...(text ? { text, unmodifiedText: text } : {}),
    ...(command ? { commands: [command] } : {})
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    modifiers
  })

  for (const m of [...mods].reverse()) {
    const mod = MODIFIERS[m]
    held &= ~mod.bit
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: mod.key,
      code: mod.code,
      windowsVirtualKeyCode: mod.keyCode,
      modifiers: held
    })
  }
}
