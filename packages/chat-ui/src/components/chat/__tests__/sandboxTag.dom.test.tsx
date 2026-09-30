// @vitest-environment jsdom
/**
 * shell 命令工具卡上的两处沙箱信息（SandboxTag.tsx，jsdom）：
 *
 *   - UI-1 折叠的摘要行上什么都没有 —— 标记与「实际执行的命令」只在展开的终端视图里；
 *   - UI-2 提示符行上 `❯` 之前恰好一枚标记：圈住 = 「沙箱」，申请越界 = 「完全访问」，其余 = 「未隔离」；
 *          悬停说明按状态各一句（不是裸 key）；
 *   - UI-3 details 没有 `sandbox`（命令没跑起来 / 旧记录 / ssh exec）：既无标记也无「实际执行的命令」；
 *   - UI-4 「实际执行的命令」点开才向宿主要（HostApi bgTask.readInvocation），要的是当前会话 + 这次调用；
 *          等待时说「读取中」，到了整段原样显示；
 *   - UI-5 只要一次：收起再展开直接显示；还没回来就收起、回来后再展开，也不再要第二次；
 *   - UI-6 宿主答 null 或出错：说「没有执行记录」，不留未处理的 rejection；
 *   - UI-7 复制按钮复制的就是那段原文；
 *   - UI-8 缺 toolCallId / 没有当前会话 / 没有 HostApi（渠道端）：没有「实际执行的命令」，标记照在；
 *   - UI-9 TerminalView 不传 sandbox（后台任务面板）：没有标记。
 *
 * HostApi 走 `window.api` 回退（getHostApi 在没注入时读它），每条用例后删掉。i18n 走真 zh 资源。
 * 文件是 .tsx 但不写 JSX，一律 createElement（与同目录其它 DOM 用例一致）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { ShellSandboxState, ToolResultDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'

const clip = vi.hoisted(() => ({ copyToClipboard: vi.fn() }))

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))
vi.mock('../../../utils/clipboard', () => ({ copyToClipboard: clip.copyToClipboard }))

import { useChatStore } from '../../../stores/chatStore'
import { ToolCallBlock } from '../ToolCallBlock'
import { TerminalView } from '../TerminalView'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 'sess-1'
const CALL = 'tc-9'
const RECORD = "cd /w/proj && \\\nSHUVIX_SESSION_ID=sess-1 \\\n/bin/bash --norc -c 'ls -la'\n"

let container: HTMLDivElement
let root: Root

function render(element: ReturnType<typeof createElement>): void {
  act(() => {
    root.render(element)
  })
}

const TERMINAL: ToolPresentation = {
  label: 'Run Command',
  icon: 'Terminal',
  detailView: 'terminal'
}

/** HostApi 的替身：只有这里用到的 bgTask.readInvocation */
function installHost(readInvocation: (p: { sessionId: string; toolCallId: string }) => unknown): {
  spy: ReturnType<typeof vi.fn>
} {
  const spy = vi.fn(readInvocation)
  ;(window as unknown as { api?: unknown }).api = { bgTask: { readInvocation: spy } }
  return { spy }
}

/** 一个手动兑现的 promise */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  useChatStore.setState({
    toolPresentations: { bash: TERMINAL, powershell: TERMINAL },
    activeSessionId: SESSION,
    sessionToolExecutions: {},
    sessionPendingInputs: {}
  })
  clip.copyToClipboard.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

/** 渲染一张完成了的 shell 命令卡（不展开） */
function renderCard(
  over: {
    toolName?: string
    toolCallId?: string | null
    sandbox?: ShellSandboxState | null
    details?: ToolResultDetails
  } = {}
): void {
  const toolName = over.toolName ?? 'bash'
  const sandbox = over.sandbox === undefined ? 'confined' : over.sandbox
  const details =
    over.details ??
    ({
      type: toolName,
      exitCode: 0,
      truncated: false,
      cwd: '/w/proj',
      ...(sandbox ? { sandbox } : {})
    } as ToolResultDetails)
  render(
    createElement(ToolCallBlock, {
      toolName,
      ...(over.toolCallId === null ? {} : { toolCallId: over.toolCallId ?? CALL }),
      args: { command: 'ls -la', description: 'List', host: 'box' },
      result: 'total 0',
      details,
      status: 'done'
    })
  )
}

function toolRow(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-tool-name]')
  if (!el) throw new Error('tool row not rendered')
  return el
}
function expand(): void {
  act(() => {
    ;(toolRow().querySelector('button') as HTMLButtonElement).click()
  })
}
/** 提示符行（`❯` 所在的那一行）；没有终端形态 → null */
function terminalPrompt(): HTMLElement | null {
  const caret = [...container.querySelectorAll('span')].find((s) => s.textContent === '❯')
  return caret?.parentElement ?? null
}
const badges = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-sandbox]')]
const invocationView = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-invocation-view]')
/** 「实际执行的命令」那一行的开关（视图里的第一个按钮） */
function toggle(): HTMLButtonElement {
  const btn = invocationView()?.querySelector<HTMLButtonElement>('button')
  if (!btn) throw new Error('invocation toggle not rendered')
  return btn
}
const clickToggle = (): void =>
  act(() => {
    toggle().click()
  })
const invocationText = (): string | null =>
  container.querySelector('[data-invocation-text]')?.textContent ?? null
const invocationBody = (): string => (invocationView()?.textContent ?? '').trim()

const LABEL: Record<ShellSandboxState, string> = {
  confined: 'toolCall.sandbox.confined',
  escalated: 'toolCall.fullAccessTag',
  disabled: 'toolCall.sandbox.unconfined',
  unsupported: 'toolCall.sandbox.unconfined',
  unavailable: 'toolCall.sandbox.unconfined'
}

describe('提示符行上的沙箱标记', () => {
  it('UI-1 折叠态：摘要行上没有标记、没有「实际执行的命令」、没有标记文案', () => {
    installHost(() => Promise.resolve(RECORD))
    renderCard({ sandbox: 'confined' })

    expect(badges()).toHaveLength(0)
    expect(invocationView()).toBeNull()
    const label = i18n.t('toolCall.sandbox.confined')
    expect(label).not.toBe('toolCall.sandbox.confined')
    expect(toolRow().textContent).not.toContain(label)
  })

  it.each(['confined', 'escalated', 'disabled', 'unsupported', 'unavailable'] as const)(
    'UI-2 %s：展开后提示符行上 ❯ 之前恰好一枚标记，文案与悬停说明按状态',
    (state) => {
      renderCard({ sandbox: state })
      expand()

      const prompt = terminalPrompt()
      expect(prompt).not.toBeNull()
      expect(badges()).toHaveLength(1)
      const [badge] = badges()
      expect(badge.parentElement).toBe(prompt)
      expect(badge.getAttribute('data-sandbox')).toBe(state)

      const caret = [...prompt!.querySelectorAll('span')].find((s) => s.textContent === '❯')!
      expect(badge.compareDocumentPosition(caret) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

      const label = i18n.t(LABEL[state])
      expect(label).not.toBe(LABEL[state])
      expect(badge.textContent).toBe(label)

      const hintKey = `toolCall.sandbox.${state}Hint`
      const hint = i18n.t(hintKey)
      expect(hint).not.toBe(hintKey)
      expect(badge.getAttribute('title')).toBe(hint)
    }
  )

  it.each([
    ['bash', undefined],
    ['powershell', undefined],
    [
      'mcp__ssh__exec',
      { type: 'ssh', action: 'exec', exitCode: 0, host: 'box' } as unknown as ToolResultDetails
    ]
  ] as const)(
    'UI-3 %s 的 details 没有 sandbox：既无标记也无「实际执行的命令」（HostApi 与当前会话都在）',
    (toolName, details) => {
      const { spy } = installHost(() => Promise.resolve(RECORD))
      renderCard({ toolName, sandbox: null, ...(details ? { details } : {}) })
      expand()

      // 确实是终端形态 —— 否则「没有标记」什么也没证明
      expect(terminalPrompt()).not.toBeNull()
      expect(badges()).toHaveLength(0)
      expect(invocationView()).toBeNull()
      expect(spy).not.toHaveBeenCalled()
    }
  )

  it('UI-9 TerminalView 不传 sandbox（后台任务面板）：没有标记', () => {
    render(createElement(TerminalView, { command: 'ls', cwd: '/w', exitCode: 0 }))
    expect(terminalPrompt()).not.toBeNull()
    expect(badges()).toHaveLength(0)
  })
})

describe('「实际执行的命令」', () => {
  it('UI-4 点开才要：要的是当前会话 + 这次调用；等待时说读取中，到了整段原样显示', async () => {
    const pending = deferred<string | null>()
    const { spy } = installHost(() => pending.promise)
    renderCard()
    expand()

    const show = i18n.t('toolCall.invocation.show')
    expect(show).not.toBe('toolCall.invocation.show')
    expect(toggle().textContent).toBe(show)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(spy).not.toHaveBeenCalled()
    expect(invocationText()).toBeNull()

    clickToggle()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ sessionId: SESSION, toolCallId: CALL })
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    const loading = i18n.t('toolCall.invocation.loading')
    expect(loading).not.toBe('toolCall.invocation.loading')
    expect(invocationBody()).toContain(loading)
    expect(invocationText()).toBeNull()

    await act(async () => {
      pending.resolve(RECORD)
      await pending.promise
    })
    expect(invocationText()).toBe(RECORD)
    expect(invocationBody()).not.toContain(loading)
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
  })

  it('UI-5 只要一次：收起再展开直接显示，不再问宿主', async () => {
    const { spy } = installHost(() => Promise.resolve(RECORD))
    renderCard()
    expand()

    await act(async () => {
      toggle().click()
    })
    expect(invocationText()).toBe(RECORD)

    clickToggle()
    expect(invocationText()).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    clickToggle()
    expect(invocationText()).toBe(RECORD)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('UI-5 还没回来就收起，回来之后再展开：直接显示，仍只问过一次', async () => {
    const pending = deferred<string | null>()
    const { spy } = installHost(() => pending.promise)
    renderCard()
    expand()

    clickToggle()
    clickToggle()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      pending.resolve(RECORD)
      await pending.promise
    })
    expect(invocationText()).toBeNull()

    clickToggle()
    expect(invocationText()).toBe(RECORD)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('UI-6 宿主答 null：说没有执行记录', async () => {
    installHost(() => Promise.resolve(null))
    renderCard()
    expand()
    await act(async () => {
      toggle().click()
    })

    const missing = i18n.t('toolCall.invocation.missing')
    expect(missing).not.toBe('toolCall.invocation.missing')
    expect(invocationBody()).toContain(missing)
    expect(invocationText()).toBeNull()
  })

  it('UI-6 宿主出错：同样说没有执行记录，不留未处理的 rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      installHost(() => Promise.reject(new Error('ipc down')))
      renderCard()
      expand()
      await act(async () => {
        toggle().click()
      })
      // 让可能漏掉的 rejection 有机会冒出来
      await new Promise((r) => setTimeout(r, 20))

      expect(invocationBody()).toContain(i18n.t('toolCall.invocation.missing'))
      expect(invocationText()).toBeNull()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('UI-7 复制按钮复制的就是那段原文', async () => {
    installHost(() => Promise.resolve(RECORD))
    renderCard()
    expand()
    await act(async () => {
      toggle().click()
    })

    const copy = invocationView()!.querySelector<HTMLButtonElement>('button[title]')
    expect(copy).not.toBeNull()
    expect(copy).not.toBe(toggle())
    act(() => {
      copy!.click()
    })
    expect(clip.copyToClipboard).toHaveBeenCalledTimes(1)
    expect(clip.copyToClipboard).toHaveBeenCalledWith(RECORD)
  })

  it.each([
    [
      '没有 toolCallId',
      (): void => {
        installHost(() => Promise.resolve(RECORD))
        renderCard({ toolCallId: null })
      }
    ],
    [
      '没有当前会话',
      (): void => {
        installHost(() => Promise.resolve(RECORD))
        useChatStore.setState({ activeSessionId: null })
        renderCard()
      }
    ],
    [
      '没有 HostApi（渠道端）',
      (): void => {
        renderCard()
      }
    ]
  ])('UI-8 %s：没有「实际执行的命令」，标记照在', (_label, setup) => {
    setup()
    expand()

    expect(badges()).toHaveLength(1)
    expect(badges()[0].getAttribute('data-sandbox')).toBe('confined')
    expect(invocationView()).toBeNull()
    expect(container.textContent).not.toContain(i18n.t('toolCall.invocation.show'))
  })
})
