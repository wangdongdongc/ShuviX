/**
 * 键盘分发 —— 常用键 CDP 描述 + 组合键支持（从桌面 browserCdpActions 搬入，两端共享）。
 */

export type CdpSend = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

/** 常用键的 CDP 描述 */
export const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
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
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  ' ': { key: ' ', code: 'Space', keyCode: 32 }
}

const MODIFIER_KEYS: Record<string, number> = {
  Control: 2,
  Alt: 1,
  Shift: 8,
  Meta: 4
}

/** 分发键盘事件（支持组合键如 "Control+A", "Meta+Shift+R"） */
export async function dispatchKey(send: CdpSend, combo: string): Promise<void> {
  const parts = combo.split('+')
  const mainKey = parts.pop()!
  const modifiers = parts

  // 计算 modifier 位掩码
  let modifierFlags = 0
  for (const mod of modifiers) {
    modifierFlags |= MODIFIER_KEYS[mod] || 0
  }

  // 解析主键；单字符按 UI Events code 规范推导：字母 KeyX / 数字 DigitN，keyCode 用大写字符码
  const def = KEY_DEFS[mainKey]
  const key = def?.key ?? mainKey
  let fallbackCode = mainKey
  if (mainKey.length === 1) {
    if (/[a-zA-Z]/.test(mainKey)) fallbackCode = `Key${mainKey.toUpperCase()}`
    else if (/[0-9]/.test(mainKey)) fallbackCode = `Digit${mainKey}`
  }
  const code = def?.code ?? fallbackCode
  const keyCode =
    def?.keyCode ??
    (mainKey.length === 1 ? mainKey.toUpperCase().charCodeAt(0) : mainKey.charCodeAt(0))

  // Press modifier keys
  for (const mod of modifiers) {
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: mod,
      code: `${mod}Left`,
      modifiers: modifierFlags
    })
  }

  // Press main key
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    keyCode,
    modifiers: modifierFlags
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    keyCode,
    modifiers: modifierFlags
  })

  // Release modifier keys (reverse order)
  for (const mod of modifiers.reverse()) {
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: mod,
      code: `${mod}Left`,
      modifiers: 0
    })
  }
}
