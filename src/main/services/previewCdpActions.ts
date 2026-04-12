/**
 * Preview DevTools Actions — 各 devtools_action 的具体实现
 *
 * 每个 action 是独立的 async 函数，接收 previewCdpService + devtools_params，
 * 返回 AgentToolResult<PreviewToolDetails>。
 */

import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { PreviewToolDetails } from '../../shared/types/chatMessage'
import { previewCdpService } from './previewCdpService'
import { DEVTOOLS_HELP } from '../tools/preview'

type Result = AgentToolResult<PreviewToolDetails>

/** 参数错误时返回错误信息 + devtools 帮助文档 */
function paramError(devtoolsAction: string, message: string): Result {
  return {
    content: [{ type: 'text', text: `Error: ${message}\n\n${DEVTOOLS_HELP}` }],
    details: { type: 'preview', action: 'devtools', devtoolsAction, error: message }
  }
}

// ====== Snapshot ======

export async function snapshotAction(): Promise<Result> {
  const { text, elementCount } = await previewCdpService.buildSnapshot()
  return {
    content: [{ type: 'text', text }],
    details: { type: 'preview', action: 'devtools', devtoolsAction: 'snapshot', elementCount }
  }
}

// ====== Screenshot ======

export async function screenshotAction(params: Record<string, unknown> = {}): Promise<Result> {
  const fullPage = params.fullPage === true
  const uid = params.uid as string | undefined

  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
  if (uid) {
    // 获取元素的 bounding rect 作为 clip 区域
    const rect = await previewCdpService.callOnElement<{
      x: number
      y: number
      width: number
      height: number
    }>(
      uid,
      'function(){ const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }'
    )
    clip = { ...rect, scale: 1 }
  }

  const cmdParams: Record<string, unknown> = { format: 'png' }
  if (fullPage) cmdParams.captureBeyondViewport = true
  if (clip) cmdParams.clip = clip

  const { data } = await previewCdpService.sendCommand<{ data: string }>(
    'Page.captureScreenshot',
    cmdParams
  )

  const desc = uid
    ? `Screenshot of element uid=${uid}.`
    : fullPage
      ? 'Full page screenshot.'
      : 'Viewport screenshot.'

  return {
    content: [
      { type: 'image', mimeType: 'image/png', data },
      { type: 'text', text: desc }
    ],
    details: { type: 'preview', action: 'devtools', devtoolsAction: 'screenshot' }
  }
}

// ====== Click ======

export async function clickAction(params: Record<string, unknown> = {}): Promise<Result> {
  const uid = params.uid as string | undefined
  if (!uid) {
    return paramError(
      'click',
      '"uid" is required for click action. Get UIDs by calling snapshot first.'
    )
  }

  const { x, y } = await previewCdpService.resolveCoordinates(uid)
  await previewCdpService.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await previewCdpService.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })

  // 等待一小段时间让页面响应
  await sleep(100)

  const node = previewCdpService['nodeMap'].get(uid)
  const desc = node?.name?.value
    ? `Clicked ${node.role?.value || 'element'} "${node.name.value}" (uid=${uid}).`
    : `Clicked element uid=${uid}.`

  return {
    content: [{ type: 'text', text: desc }],
    details: { type: 'preview', action: 'devtools', devtoolsAction: 'click' }
  }
}

// ====== Fill ======

export async function fillAction(params: Record<string, unknown> = {}): Promise<Result> {
  const uid = params.uid as string | undefined
  const value = params.value as string | undefined
  if (!uid || value == null) {
    return paramError('fill', '"uid" and "value" are required for fill action.')
  }

  // Focus 元素
  await previewCdpService.focusElement(uid)
  // 清空现有值并填入新值
  await previewCdpService.callOnElement<void>(
    uid,
    `function(){ this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }`
  )
  await previewCdpService.sendCommand('Input.insertText', { text: value })
  // 触发 change 事件
  await previewCdpService.callOnElement<void>(
    uid,
    `function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }`
  )

  return {
    content: [{ type: 'text', text: `Filled element uid=${uid} with "${truncate(value, 50)}".` }],
    details: { type: 'preview', action: 'devtools', devtoolsAction: 'fill' }
  }
}

// ====== Type ======

export async function typeAction(params: Record<string, unknown> = {}): Promise<Result> {
  const text = params.text as string | undefined
  const uid = params.uid as string | undefined
  const submitKey = params.submitKey as string | undefined

  if (!text) {
    return paramError('type', '"text" is required for type action.')
  }

  if (uid) {
    await previewCdpService.focusElement(uid)
  }

  await previewCdpService.sendCommand('Input.insertText', { text })

  if (submitKey) {
    await dispatchKey(submitKey)
  }

  const desc = uid
    ? `Typed "${truncate(text, 50)}" into element uid=${uid}.`
    : `Typed "${truncate(text, 50)}".`

  return {
    content: [{ type: 'text', text: desc + (submitKey ? ` Pressed ${submitKey}.` : '') }],
    details: { type: 'preview', action: 'devtools', devtoolsAction: 'type' }
  }
}

// ====== Press Key ======

export async function pressKeyAction(params: Record<string, unknown> = {}): Promise<Result> {
  const key = params.key as string | undefined
  if (!key) {
    return paramError('press_key', '"key" is required for press_key action.')
  }

  await dispatchKey(key)

  return {
    content: [{ type: 'text', text: `Pressed ${key}.` }],
    details: { type: 'preview', action: 'devtools', devtoolsAction: 'press_key' }
  }
}

// ====== Scroll ======

export async function scrollAction(params: Record<string, unknown> = {}): Promise<Result> {
  const direction = (params.direction as string) || 'down'
  const amount = (params.amount as number) || 500
  const uid = params.uid as string | undefined

  let dx = 0
  let dy = 0
  if (direction === 'down') dy = amount
  else if (direction === 'up') dy = -amount
  else if (direction === 'right') dx = amount
  else if (direction === 'left') dx = -amount

  if (uid) {
    await previewCdpService.callOnElement<void>(uid, `function(){ this.scrollBy(${dx}, ${dy}); }`)
  } else {
    await previewCdpService.sendCommand('Runtime.evaluate', {
      expression: `window.scrollBy(${dx}, ${dy})`,
      returnByValue: true
    })
  }

  return {
    content: [{ type: 'text', text: `Scrolled ${direction} by ${amount}px.` }],
    details: { type: 'preview', action: 'devtools', devtoolsAction: 'scroll' }
  }
}

// ====== Evaluate ======

export async function evaluateAction(params: Record<string, unknown> = {}): Promise<Result> {
  const expression = params.expression as string | undefined
  if (!expression) {
    return paramError('evaluate', '"expression" is required for evaluate action.')
  }

  const { result, exceptionDetails } = await previewCdpService.sendCommand<{
    result: { type: string; value?: unknown; description?: string }
    exceptionDetails?: { text: string; exception?: { description?: string } }
  }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })

  if (exceptionDetails) {
    const errMsg = exceptionDetails.exception?.description || exceptionDetails.text
    return {
      content: [{ type: 'text', text: `Error: ${errMsg}` }],
      details: { type: 'preview', action: 'devtools', devtoolsAction: 'evaluate', error: errMsg }
    }
  }

  const text =
    result.value !== undefined
      ? JSON.stringify(result.value, null, 2)
      : result.description || '(undefined)'

  return {
    content: [{ type: 'text', text }],
    details: { type: 'preview', action: 'devtools', devtoolsAction: 'evaluate' }
  }
}

// ====== Wait For ======

export async function waitForAction(params: Record<string, unknown> = {}): Promise<Result> {
  const text = params.text as string | undefined
  const timeout = (params.timeout as number) || 10000

  if (!text) {
    return paramError('wait_for', '"text" is required for wait_for action.')
  }

  const interval = 500
  const maxAttempts = Math.ceil(timeout / interval)
  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

  for (let i = 0; i < maxAttempts; i++) {
    const { result } = await previewCdpService.sendCommand<{
      result: { value: boolean }
    }>('Runtime.evaluate', {
      expression: `document.body && document.body.innerText.includes('${escaped}')`,
      returnByValue: true
    })
    if (result.value) {
      return {
        content: [{ type: 'text', text: `Found text "${truncate(text, 50)}" on page.` }],
        details: { type: 'preview', action: 'devtools', devtoolsAction: 'wait_for' }
      }
    }
    await sleep(interval)
  }

  return {
    content: [
      { type: 'text', text: `Timeout: text "${truncate(text, 50)}" not found after ${timeout}ms.` }
    ],
    details: { type: 'preview', action: 'devtools', devtoolsAction: 'wait_for', error: 'timeout' }
  }
}

// ====== Navigate ======

export async function navigateAction(params: Record<string, unknown> = {}): Promise<Result> {
  const action = (params.navigateAction as string) || 'goto'
  const url = params.url as string | undefined

  if (action === 'goto') {
    if (!url) {
      return paramError('navigate', '"url" is required for navigate with navigateAction="goto".')
    }
    await previewCdpService.sendCommand('Page.navigate', { url })
    // 等待导航完成
    await sleep(500)
    return {
      content: [{ type: 'text', text: `Navigated to ${url}.` }],
      details: { type: 'preview', action: 'devtools', devtoolsAction: 'navigate', url }
    }
  }

  if (action === 'back') {
    await previewCdpService.sendCommand('Page.navigateToHistoryEntry', await getHistoryEntry(-1))
    await sleep(300)
    return {
      content: [{ type: 'text', text: 'Navigated back.' }],
      details: { type: 'preview', action: 'devtools', devtoolsAction: 'navigate' }
    }
  }

  if (action === 'forward') {
    await previewCdpService.sendCommand('Page.navigateToHistoryEntry', await getHistoryEntry(1))
    await sleep(300)
    return {
      content: [{ type: 'text', text: 'Navigated forward.' }],
      details: { type: 'preview', action: 'devtools', devtoolsAction: 'navigate' }
    }
  }

  if (action === 'reload') {
    await previewCdpService.sendCommand('Page.reload')
    await sleep(500)
    return {
      content: [{ type: 'text', text: 'Page reloaded.' }],
      details: { type: 'preview', action: 'devtools', devtoolsAction: 'navigate' }
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown navigateAction: "${action}".` }],
    details: {
      type: 'preview',
      action: 'devtools',
      devtoolsAction: 'navigate',
      error: 'unknown action'
    }
  }
}

// ====== Network ======

export async function getNetworkRequestsAction(): Promise<Result> {
  await previewCdpService.enableNetworkCapture()
  const entries = previewCdpService.getNetworkRequests()

  if (entries.length === 0) {
    return {
      content: [{ type: 'text', text: 'No network requests captured.' }],
      details: { type: 'preview', action: 'devtools', devtoolsAction: 'get_network_requests' }
    }
  }

  const lines = entries.map((e) => {
    const status = e.failed ? 'FAILED' : (e.status ?? '...')
    const size = e.size != null ? formatBytes(e.size) : ''
    return `[${e.method}] ${status} ${e.url}${size ? ' (' + size + ')' : ''}`
  })

  return {
    content: [{ type: 'text', text: `Network requests (${entries.length}):\n${lines.join('\n')}` }],
    details: { type: 'preview', action: 'devtools', devtoolsAction: 'get_network_requests' }
  }
}

// ====== Console ======

export async function getConsoleMessagesAction(): Promise<Result> {
  await previewCdpService.enableConsoleCapture()
  const entries = previewCdpService.getConsoleMessages()

  if (entries.length === 0) {
    return {
      content: [{ type: 'text', text: 'No console messages captured.' }],
      details: { type: 'preview', action: 'devtools', devtoolsAction: 'get_console_messages' }
    }
  }

  const lines = entries.map((e) => {
    const loc = e.url ? ` (${e.url}${e.lineNumber != null ? ':' + e.lineNumber : ''})` : ''
    return `[${e.type}] ${e.text}${loc}`
  })

  return {
    content: [{ type: 'text', text: `Console messages (${entries.length}):\n${lines.join('\n')}` }],
    details: { type: 'preview', action: 'devtools', devtoolsAction: 'get_console_messages' }
  }
}

// ====== 工具函数 ======

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// ====== 键盘辅助 ======

/** 常用键的 CDP 描述 */
const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number }> = {
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
async function dispatchKey(combo: string): Promise<void> {
  const parts = combo.split('+')
  const mainKey = parts.pop()!
  const modifiers = parts

  // 计算 modifier 位掩码
  let modifierFlags = 0
  for (const mod of modifiers) {
    modifierFlags |= MODIFIER_KEYS[mod] || 0
  }

  // 解析主键
  const def = KEY_DEFS[mainKey]
  const key = def?.key ?? mainKey
  const code = def?.code ?? (mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey)
  const keyCode = def?.keyCode ?? mainKey.charCodeAt(0)

  // Press modifier keys
  for (const mod of modifiers) {
    await previewCdpService.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: mod,
      code: `${mod}Left`,
      modifiers: modifierFlags
    })
  }

  // Press main key
  await previewCdpService.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    keyCode,
    modifiers: modifierFlags
  })
  await previewCdpService.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    keyCode,
    modifiers: modifierFlags
  })

  // Release modifier keys (reverse order)
  for (const mod of modifiers.reverse()) {
    await previewCdpService.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: mod,
      code: `${mod}Left`,
      modifiers: 0
    })
  }
}

/** 获取历史条目 ID（用于 back/forward） */
async function getHistoryEntry(offset: number): Promise<{ entryId: number }> {
  const { currentIndex, entries } = await previewCdpService.sendCommand<{
    currentIndex: number
    entries: Array<{ id: number }>
  }>('Page.getNavigationHistory')
  const target = entries[currentIndex + offset]
  if (!target) throw new Error(`No navigation history entry at offset ${offset}.`)
  return { entryId: target.id }
}
