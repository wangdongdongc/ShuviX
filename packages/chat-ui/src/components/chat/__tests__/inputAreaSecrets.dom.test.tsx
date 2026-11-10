// @vitest-environment jsdom
/**
 * 输入框里对模型藏起来的值（docs/auto-redaction-design.md §14；jsdom）：
 *
 *   SC-1 （桌面）「+」→ 菜单（模型不能看图时只有「添加敏感信息」）→ 表单：不回显的输入框、三个类别；添加 → 光标处一个
 *        胶囊（镜像层 `data-secret-chip`），textarea 里是胶囊文字、不是真值；发送 → agent.prompt 带着真值与
 *        secrets；乐观占位气泡里没有真值
 *   SC-2 打开表单时选中了一段 → 预填、添加后替换那一段；Esc 关掉表单什么都不加
 *   SC-3 提示：停笔之后问 redaction.inspect（会话 + 正文 + 粘贴全文）；提示行列出那一项，正文里画虚线；点「隐藏」→
 *        换成胶囊、提示收起；发送带着它
 *   SC-4 提示的 ×：提示收起，照原样发（secrets 为空），同一个值不再提示
 *   SC-5 退格紧贴胶囊尾部 → 整个删掉；删掉之后发送不再带它
 *   SC-6 （触屏）「+」→ 底部面板 → 「添加敏感信息」→ 表单面板（16px 输入框）→ 添加 → 胶囊
 *   SC-7 宿主没有 inspect（旧宿主 / 渠道端）：不提示、照常发
 *
 * 话没发出去放回输入框时（真值只在胶囊的登记里）：
 *   SC-8  胶囊经 notSent 放回：textarea 里是胶囊文字、镜像层有 data-secret-chip、整个 DOM 里没有真值；重发带真值与 secrets
 *   SC-9  经 lost + 宽限放回：每个检查点（占位、被拒、等待、放回）DOM 里都没有真值
 *   SC-10 粘贴芯片里确认的（没有胶囊、只有值）：放回之后粘贴芯片回来，重发的 secrets 还带着它
 *   SC-11 放回之后：藏起来的值不再提示；新加的胶囊编号 #2
 *   SC-12 放回之后：退格紧贴胶囊尾部、或改了占位里的字 → 胶囊没了，下一次发送不带它
 *   SC-13 steer / followUp 失败：同 SC-8
 *
 * 运行中发（steer 与空闲竞态退回的 prompt，粘贴芯片随 token 走）：
 *   SC-14 粘贴芯片里确认的值：运行中回车 → steer 的 text 是标记态（没有真值）、paste token 的 payload 带真值、secrets 带它，
 *         发完 DOM 里没有真值；点下去时已是 idle → agent.prompt 收同样的载荷，乐观占位里没有真值、paste token 还在
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import type { RedactionHint } from '@shuvix/chat-protocol/utils/redactionPlaceholders'

vi.mock('@shuvix/chat-ui', () => {
  const api = (): unknown => (globalThis as unknown as { window: { api: unknown } }).window.api
  return {
    getHostApi: api,
    getSessionChannelApi: api,
    useChatHost: () => ({
      models: {
        activeProvider: 'prov-1',
        activeModel: 'model-m',
        setActiveProvider: vi.fn(),
        setActiveModel: vi.fn()
      }
    })
  }
})

import { applySessionView, useChatStore } from '../../../stores/chatStore'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { InputArea, type InputAreaProps } from '../InputArea'
import { V, resetStore } from '../../../__tests__/support/views'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { HINT_DEBOUNCE_MS } from '../../../hooks/useRedactionHints'
import { PROMPT_OUTCOME_GRACE_MS as GRACE } from '../../../stores/promptOutcome'
import {
  advance,
  composerShot,
  fakeLink,
  longPaste,
  lost,
  notSent,
  pasteInto,
  useFakeClock
} from '../../../__tests__/support/sendFailure'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 'prov-1'
const M = 'model-m'
const PASSWORD = 'Xk9#mP2q'

let prompt: ReturnType<typeof vi.fn>
let inspect: ReturnType<typeof vi.fn> | undefined
/** inspect 交回的：按文本交给一个函数算 */
let hintsFor: (text: string) => RedactionHint[] = () => []

function buildApi(withInspect = true): Record<string, unknown> {
  prompt = vi.fn(async () => ({ success: true }))
  inspect = withInspect
    ? vi.fn(async (params: { texts: string[] }) => params.texts.map((t) => hintsFor(t)))
    : undefined
  return {
    sync: fakeLink(),
    session: { list: async () => [], updateEnabledTools: vi.fn(async () => ({ success: true })) },
    agent: {
      init: async () => ({ success: true }),
      prompt,
      steer: vi.fn(async () => ({ success: true })),
      followUp: vi.fn(async () => ({ success: true })),
      abort: vi.fn(async () => ({ success: true })),
      respondToInput: vi.fn(async () => ({ success: true }))
    },
    ...(inspect ? { redaction: { inspect } } : {}),
    tools: { list: async () => [] },
    files: { scan: async () => ({ root: null, paths: [] }) },
    mentions: { listKnowledgeEntries: async () => [] },
    events: { subscribe: () => () => {} },
    app: { openSettings: () => {} }
  }
}

const PROVIDER: ProviderInfo = {
  id: P,
  name: 'openai',
  displayName: 'Prov One',
  apiKey: '',
  baseUrl: '',
  apiProtocol: 'openai-completions' as ProviderInfo['apiProtocol'],
  metadata: '',
  isBuiltin: 0,
  isEnabled: 1,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0
}
const MODEL: AvailableModel = {
  id: 'row-m',
  providerId: P,
  modelId: M,
  isEnabled: 1,
  sortOrder: 0,
  capabilities: '{}',
  providerName: 'openai'
}

let container: HTMLDivElement
let root: Root

async function flush(ms = 0): Promise<void> {
  if (vi.isFakeTimers()) {
    await advance(ms)
    return
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function mountInput(touch = false): Promise<void> {
  await act(async () => {
    const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
    const area = createElement(Area, { inline: true })
    root.render(
      touch
        ? createElement(
            ChatHostContext.Provider,
            { value: { density: 'touch' } as ChatHostValue },
            area
          )
        : area
    )
  })
  await flush()
}

const textarea = (): HTMLTextAreaElement => container.querySelector('textarea')!
const plus = (): HTMLButtonElement => container.querySelector('button[data-attach-button]')!
const q = <T extends Element = HTMLElement>(selector: string): T | null =>
  document.body.querySelector<T>(selector)

function setNative(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value)
}

async function type(value: string, caret = value.length): Promise<void> {
  const el = textarea()
  await act(async () => {
    setNative(el, value)
    el.selectionStart = el.selectionEnd = caret
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

async function key(el: Element, keyName: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true })
    )
  })
  await flush()
}

async function fillSecret(value: string, category?: string): Promise<void> {
  const input = q<HTMLInputElement>('[data-secret-input]')!
  await act(async () => {
    setNative(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (category) await click(q(`[data-secret-category="${category}"]`)!)
  await click(q('[data-secret-add]')!)
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  hintsFor = () => []
  ;(window as unknown as { api: unknown }).api = buildApi()
  useModelCatalogStore.setState({ loaded: true, providers: [PROVIDER], availableModels: [MODEL] })
  resetStore('s1')
  useChatStore.setState({
    sessions: [
      {
        id: 's1',
        title: 's1',
        projectId: null,
        parentId: null,
        settings: {},
        createdAt: 0,
        updatedAt: 0,
        lastActiveAt: 0
      }
    ],
    slashCommands: [],
    modelSupportsVision: false,
    maxContextTokens: 0
  })
  act(() => applySessionView('s1', V('s1', { run: { state: 'idle' } })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('+ 添加敏感信息', () => {
  it('SC-1 菜单 → 表单 → 胶囊；发送带真值与 secrets，乐观气泡里没有真值', async () => {
    await mountInput()
    await type('use ')
    await click(plus())
    expect(q('[data-plus-panel]')).not.toBeNull()
    expect(q('[data-plus-images]')).toBeNull()
    await click(q('[data-plus-secret]')!)
    const input = q<HTMLInputElement>('[data-secret-input]')!
    expect(input.type).toBe('password')
    expect(
      [...document.body.querySelectorAll('[data-secret-category]')].map(
        (b) => (b as HTMLElement).dataset.secretCategory
      )
    ).toEqual(['PASSWORD', 'API_KEY', 'SECRET'])
    await fillSecret(PASSWORD, 'API_KEY')

    const chipText = '[🔒 API key #1]'
    expect(q('[data-plus-panel]')).toBeNull()
    expect(textarea().value).toBe(`use ${chipText}`)
    expect(textarea().value).not.toContain(PASSWORD)
    expect(container.querySelector('[data-secret-chip]')!.textContent).toBe(chipText)

    // 回之前看一眼乐观气泡
    let release: () => void = () => {}
    prompt.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ success: true })))
    )
    await key(textarea(), 'Enter')
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0]![0]).toEqual({
      sessionId: 's1',
      text: `use ${PASSWORD}`,
      secrets: [{ value: PASSWORD, category: 'API_KEY' }]
    })
    const pending = JSON.stringify(useChatStore.getState().sessionPendingPrompt.s1)
    expect(pending).toContain(chipText)
    expect(pending).not.toContain(PASSWORD)
    expect(textarea().value).toBe('')
    await act(async () => release())
    await flush()
  })

  it('SC-2 选中一段再打开：预填并替换那一段；Esc 什么都不加', async () => {
    await mountInput()
    await type(`root / ${PASSWORD} ok`)
    const el = textarea()
    el.selectionStart = 7
    el.selectionEnd = 7 + PASSWORD.length
    await click(plus())
    await click(q('[data-plus-secret]')!)
    expect(q<HTMLInputElement>('[data-secret-input]')!.value).toBe(PASSWORD)
    await click(q('[data-secret-add]')!)
    expect(textarea().value).toBe('root / [🔒 Password #1] ok')

    await click(plus())
    await click(q('[data-plus-secret]')!)
    await key(q('[data-secret-input]')!, 'Escape')
    expect(q('[data-secret-form]')).toBeNull()
    expect(textarea().value).toBe('root / [🔒 Password #1] ok')
  })
})

describe('提示', () => {
  const hintPassword = (text: string): RedactionHint[] => {
    const i = text.indexOf(PASSWORD)
    return i === -1 ? [] : [{ start: i, end: i + PASSWORD.length, category: 'PASSWORD' }]
  }

  it('SC-3 停笔后问 inspect；提示行 + 虚线；点「隐藏」→ 胶囊，发送带着它', async () => {
    hintsFor = hintPassword
    await mountInput()
    await type(`sudo password ${PASSWORD} please`)
    expect(q('[data-redaction-hints]')).toBeNull()
    await flush(HINT_DEBOUNCE_MS + 50)
    expect(inspect).toHaveBeenCalled()
    expect(inspect!.mock.calls.at(-1)![0]).toEqual({
      sessionId: 's1',
      provider: P,
      model: M,
      texts: [`sudo password ${PASSWORD} please`]
    })
    const bar = q('[data-redaction-hints]')!
    expect(bar.querySelector('[data-redaction-hint="PASSWORD"]')!.textContent).toBe('Password Xk9…')
    expect(bar.textContent).not.toContain(PASSWORD)
    expect(container.querySelector('[data-redaction-hint-span]')!.textContent).toBe(PASSWORD)

    await click(bar.querySelector('[data-redaction-hide-all]')!)
    expect(textarea().value).toBe('sudo password [🔒 Password #1] please')
    expect(q('[data-redaction-hints]')).toBeNull()

    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[0]![0]).toMatchObject({
      text: `sudo password ${PASSWORD} please`,
      secrets: [{ value: PASSWORD, category: 'PASSWORD' }]
    })
  })

  it('SC-4 ×：提示收起、照原样发；同一个值不再提示', async () => {
    hintsFor = hintPassword
    await mountInput()
    await type(`pw ${PASSWORD}`)
    await flush(HINT_DEBOUNCE_MS + 50)
    await click(q('[data-redaction-hints-dismiss]')!)
    expect(q('[data-redaction-hints]')).toBeNull()
    await type(`pw ${PASSWORD} again`)
    await flush(HINT_DEBOUNCE_MS + 50)
    expect(q('[data-redaction-hints]')).toBeNull()
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[0]![0]).toEqual({
      sessionId: 's1',
      text: `pw ${PASSWORD} again`,
      secrets: []
    })
  })

  it('SC-7 宿主没有 inspect：不提示、照常发', async () => {
    ;(window as unknown as { api: unknown }).api = buildApi(false)
    hintsFor = hintPassword
    await mountInput()
    await type(`pw ${PASSWORD}`)
    await flush(HINT_DEBOUNCE_MS + 50)
    expect(q('[data-redaction-hints]')).toBeNull()
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[0]![0]).toMatchObject({ text: `pw ${PASSWORD}`, secrets: [] })
  })
})

describe('胶囊的编辑与触屏', () => {
  it('SC-5 退格紧贴胶囊尾部 → 整个删掉；之后发送不带它', async () => {
    await mountInput()
    await type('x ')
    await click(plus())
    await click(q('[data-plus-secret]')!)
    await fillSecret(PASSWORD)
    const value = textarea().value
    textarea().selectionStart = textarea().selectionEnd = value.length
    await key(textarea(), 'Backspace')
    expect(textarea().value).toBe('x ')
    await type('x done')
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[0]![0]).toEqual({ sessionId: 's1', text: 'x done', secrets: [] })
  })

  it('SC-6 触屏：底部面板 → 表单面板（16px）→ 胶囊', async () => {
    await mountInput(true)
    await click(plus())
    expect(q('[data-touch-sheet="plus"]')).not.toBeNull()
    await click(q('[data-plus-secret]')!)
    expect(q('[data-touch-sheet="plus"]')).toBeNull()
    expect(q('[data-touch-sheet="secret"]')).not.toBeNull()
    expect(q('[data-secret-input]')!.className).toContain('text-[16px]')
    await fillSecret(PASSWORD)
    expect(q('[data-touch-sheet="secret"]')).toBeNull()
    expect(textarea().value).toBe('[🔒 Password #1]')
  })
})

describe('话没发出去，放回输入框', () => {
  const ALSO = 'Second#Value9'
  const chipOf = (seq: number): string => `[🔒 Password #${seq}]`
  const hidden = (...values: string[]): Array<{ value: string; category: string }> =>
    values.map((value) => ({ value, category: 'PASSWORD' }))
  const hintEverywhere = (text: string): RedactionHint[] => {
    const i = text.indexOf(PASSWORD)
    return i === -1 ? [] : [{ start: i, end: i + PASSWORD.length, category: 'PASSWORD' }]
  }

  async function addChip(value: string): Promise<void> {
    await click(plus())
    await click(q('[data-plus-secret]')!)
    await fillSecret(value)
  }

  const failOnce = (fn: ReturnType<typeof vi.fn>, error: Error): void => {
    fn.mockImplementationOnce(() => Promise.reject(error))
  }

  const expectChipBack = (value: string, seq = 1): void => {
    expect(textarea().value).toBe(value)
    expect(container.querySelector('[data-secret-chip]')!.textContent).toBe(chipOf(seq))
    expect(document.body.innerHTML).not.toContain(PASSWORD)
    expect(textarea().value).not.toContain(PASSWORD)
  }

  /** 发一条带胶囊的（第一次经 notSent 失败），放回之后的样子断言过 */
  async function sendAndRestore(): Promise<void> {
    failOnce(prompt, notSent())
    await mountInput()
    await type('use ')
    await addChip(PASSWORD)
    await key(textarea(), 'Enter')
    expectChipBack(`use ${chipOf(1)}`)
  }

  it('SC-8 经 notSent：胶囊回来，DOM 里没有真值；重发带真值与 secrets', async () => {
    await sendAndRestore()
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[1]![0]).toEqual({
      sessionId: 's1',
      text: `use ${PASSWORD}`,
      secrets: hidden(PASSWORD)
    })
  })

  it('SC-9 经 lost + 宽限：每个检查点 DOM 里都没有真值', async () => {
    useFakeClock()
    let reject: (error: unknown) => void = () => {}
    prompt.mockImplementationOnce(() => new Promise((_resolve, rej) => (reject = rej)))
    await mountInput()
    await type('use ')
    await addChip(PASSWORD)
    const clean = (): void => {
      expect(document.body.innerHTML).not.toContain(PASSWORD)
      expect(textarea().value).not.toContain(PASSWORD)
      expect(JSON.stringify(useChatStore.getState().sessionPendingPrompt)).not.toContain(PASSWORD)
    }
    clean()

    await key(textarea(), 'Enter')
    expect(prompt).toHaveBeenCalledTimes(1)
    clean()
    await act(async () => reject(lost()))
    await flush()
    clean()
    await advance(GRACE - 1)
    clean()
    expect(textarea().value).toBe('')
    await advance(1)
    clean()
    expectChipBack(`use ${chipOf(1)}`)
    expect(container.querySelector('[data-send-error]')).not.toBeNull()

    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[1]![0].secrets).toEqual(hidden(PASSWORD))
  })

  /** 一段含真值的长文折叠成粘贴芯片，提示里确认隐藏（只记下值），发一次、经 notSent 放回 */
  async function hideInsidePasteAndRestore(): Promise<string> {
    hintsFor = hintEverywhere
    failOnce(prompt, notSent())
    await mountInput()
    await pasteInto(textarea(), longPaste('line', `pw ${PASSWORD}`))
    await flush(HINT_DEBOUNCE_MS + 50)
    await click(q('[data-redaction-hide-all]')!)
    expect(q('[data-redaction-hints]')).toBeNull()
    const chip = textarea().value
    expect(chip).not.toContain(PASSWORD)
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[0]![0].secrets).toEqual(hidden(PASSWORD))
    expect(textarea().value).toBe(chip)
    expect(composerShot(container).chips).toEqual([chip])
    return chip
  }

  it('SC-10 粘贴芯片里确认的：放回之后芯片回来，重发的 secrets 还带着它', async () => {
    await hideInsidePasteAndRestore()
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[1]![0]).toEqual(prompt.mock.calls[0]![0])
  })

  it('SC-11 粘贴里藏起来的值：放回之后问了宿主也不再提示；新胶囊编号 #2', async () => {
    await hideInsidePasteAndRestore()
    const asked = inspect!.mock.calls.length
    await flush(HINT_DEBOUNCE_MS + 50)
    expect(inspect!.mock.calls.length).toBeGreaterThan(asked)
    expect(q('[data-redaction-hints]')).toBeNull()

    await addChip(ALSO)
    expect(container.querySelector('[data-secret-chip]')!.textContent).toBe(chipOf(2))
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[1]![0].secrets).toEqual(hidden(ALSO, PASSWORD))
  })

  it('SC-11 胶囊：放回之后新加的编号 #2，两个值都发得出去', async () => {
    await sendAndRestore()
    await addChip(ALSO)
    expect(textarea().value).toBe(`use ${chipOf(1)}${chipOf(2)}`)
    expect(
      [...container.querySelectorAll('[data-secret-chip]')].map((chip) => chip.textContent)
    ).toEqual([chipOf(1), chipOf(2)])
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[1]![0]).toEqual({
      sessionId: 's1',
      text: `use ${PASSWORD}${ALSO}`,
      secrets: hidden(PASSWORD, ALSO)
    })
  })

  it('SC-12 放回之后退格紧贴胶囊尾部 → 整个删掉，下一次发送不带它', async () => {
    await sendAndRestore()
    const el = textarea()
    el.selectionStart = el.selectionEnd = el.value.length
    await key(el, 'Backspace')
    expect(textarea().value).toBe('use ')
    expect(container.querySelector('[data-secret-chip]')).toBeNull()
    await type('use nothing')
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[1]![0]).toEqual({
      sessionId: 's1',
      text: 'use nothing',
      secrets: []
    })
  })

  it('SC-12 放回之后改了占位里的字 → 胶囊没了，下一次发送不带它', async () => {
    await sendAndRestore()
    const edited = `use ${chipOf(1).replace('Password', 'Pasword')}`
    await type(edited)
    expect(container.querySelector('[data-secret-chip]')).toBeNull()
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[1]![0]).toEqual({ sessionId: 's1', text: edited, secrets: [] })
  })

  it.each<[string, 'steer' | 'followUp']>([
    ['steer', 'steer'],
    ['followUp', 'followUp']
  ])('SC-13 %s 失败：胶囊回来，DOM 里没有真值，重发带真值与 secrets', async (_label, method) => {
    const agent = (
      window as unknown as { api: { agent: Record<string, ReturnType<typeof vi.fn>> } }
    ).api.agent
    failOnce(agent[method]!, notSent())
    await mountInput()
    act(() => applySessionView('s1', V('s1', { run: { state: 'busy' } })))
    await flush()
    await type('use ')
    await addChip(PASSWORD)

    const fire = async (): Promise<void> => {
      if (method === 'followUp')
        await click(container.querySelector('[data-queue-tier="followUp"]')!)
      else await key(textarea(), 'Enter')
    }
    await fire()
    expect(agent[method]).toHaveBeenCalledTimes(1)
    expectChipBack(`use ${chipOf(1)}`)
    expect(container.querySelector('[data-send-error]')).not.toBeNull()

    await fire()
    expect(agent[method]).toHaveBeenCalledTimes(2)
    expect(agent[method]!.mock.calls[1]![0]).toEqual({
      sessionId: 's1',
      text: `use ${PASSWORD}`,
      secrets: hidden(PASSWORD)
    })
  })

  describe('SC-14 运行中发：粘贴芯片里确认的值随 token 走', () => {
    /** 运行中：一段含真值的长文折叠成粘贴芯片，提示里确认隐藏（只记下值） */
    async function hideInsidePasteWhileBusy(): Promise<void> {
      hintsFor = hintEverywhere
      await mountInput()
      act(() => applySessionView('s1', V('s1', { run: { state: 'busy' } })))
      await flush()
      await pasteInto(textarea(), longPaste('line', `pw ${PASSWORD}`))
      await flush(HINT_DEBOUNCE_MS + 50)
      await click(q('[data-redaction-hide-all]')!)
      expect(q('[data-redaction-hints]')).toBeNull()
      expect(textarea().value).not.toContain(PASSWORD)
    }

    type Sent = {
      text: string
      inlineTokens?: Record<string, { type: string; payload: string }>
      secrets: unknown
    }

    const expectTokenPayload = (sent: Sent): void => {
      expect(sent.text).toMatch(/^\{\{shuvixInlineToken:[a-z0-9]+\}\}$/)
      expect(sent.text).not.toContain(PASSWORD)
      const tokens = Object.values(sent.inlineTokens ?? {})
      expect(tokens).toHaveLength(1)
      expect(tokens[0]!.type).toBe('paste')
      expect(tokens[0]!.payload).toContain(PASSWORD)
      expect(sent.secrets).toEqual(hidden(PASSWORD))
    }

    it('SC-14 运行中回车 → steer：text 是标记态、payload 带真值、secrets 带它；发完 DOM 里没有真值', async () => {
      await hideInsidePasteWhileBusy()
      const agent = (
        window as unknown as { api: { agent: Record<string, ReturnType<typeof vi.fn>> } }
      ).api.agent
      await key(textarea(), 'Enter')
      expect(agent.steer).toHaveBeenCalledTimes(1)
      expect(prompt).not.toHaveBeenCalled()
      expectTokenPayload(agent.steer!.mock.calls[0]![0] as Sent)
      expect(textarea().value).toBe('')
      expect(document.body.innerHTML).not.toContain(PASSWORD)
    })

    it('SC-14 点下去时已是 idle → agent.prompt 收同样的载荷；乐观占位里没有真值、paste token 还在', async () => {
      let resolve: (value: unknown) => void = () => {}
      prompt.mockImplementationOnce(() => new Promise((res) => (resolve = res)))
      await hideInsidePasteWhileBusy()
      const agent = (
        window as unknown as { api: { agent: Record<string, ReturnType<typeof vi.fn>> } }
      ).api.agent
      const button = container.querySelector<HTMLButtonElement>('[data-queue-tier="steer"]')!
      await act(async () => {
        applySessionView('s1', V('s1', { run: { state: 'idle' } }))
        button.click()
      })
      await flush()
      expect(prompt).toHaveBeenCalledTimes(1)
      expect(agent.steer).not.toHaveBeenCalled()
      expectTokenPayload(prompt.mock.calls[0]![0] as Sent)
      const pending = JSON.stringify(useChatStore.getState().sessionPendingPrompt)
      expect(pending).not.toContain(PASSWORD)
      expect(pending).toContain('"type":"paste"')
      expect(document.body.innerHTML).not.toContain(PASSWORD)
      await act(async () => resolve({ success: true }))
      await flush()
    })
  })
})
