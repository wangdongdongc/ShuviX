// @vitest-environment jsdom
/**
 * Codemode Phase 1 · D. `<ToolCallBlock>` 嵌套调用列表 DOM 渲染（CM-UI-04..07）：
 *
 *   - CM-UI-04：运行中展开时渲染 `liveExec.nestedCalls`（数量标题、工具名、状态图标、`durationMs`、`error`）
 *   - CM-UI-05：完成后展开时渲染 `details.calls`（工具名、`args` 截断至 80 字符、状态图标、`durationMs`、`error`）
 *   - CM-UI-06：同时存在 `liveExec.nestedCalls` 与 `details.calls` 时 `liveExec.nestedCalls` 优先；
 *               `details.calls` 中的畸形条目安全跳过不崩溃
 *   - CM-UI-07：均为空时不渲染嵌套调用区块；折叠态不渲染；仅存在 `nestedCalls` 或 `details.calls`
 *               （无 `args`/`result`）时卡片依然可点击展开（`canExpand === true`）
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ToolResultDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { NestedToolRunView } from '@shuvix/chat-protocol/types/sessionView'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { useChatStore, type ToolExecution } from '../../../stores/chatStore'
import { resetStore } from '../../../__tests__/support/views'
import { ToolCallBlock } from '../ToolCallBlock'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 'sess-cm'
const CODEMODE_PRESENTATION: ToolPresentation = {
  label: 'Code Mode',
  icon: 'Code',
  iconColor: '#38bdf8',
  formItems: [{ field: 'code', renderer: { type: 'code', language: 'javascript' } }]
}

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetStore(SID)
  useChatStore.setState({ toolPresentations: { codemode: CODEMODE_PRESENTATION } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

type BlockProps = Partial<Parameters<typeof ToolCallBlock>[0]>

function renderBlock(props: BlockProps = {}): void {
  act(() => {
    root.render(
      createElement(ToolCallBlock, {
        toolName: 'codemode',
        toolCallId: 'cm-1',
        status: 'done',
        ...props
      })
    )
  })
}

function setLiveExec(exec: ToolExecution): void {
  act(() => {
    useChatStore.setState((s) => ({
      sessionToolExecutions: { ...s.sessionToolExecutions, [SID]: [exec] }
    }))
  })
}

const rowEl = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-tool-name="codemode"]')!
const toggleButton = (): HTMLButtonElement | null => rowEl().querySelector('button')
const expand = (): void => {
  const btn = toggleButton()
  if (!btn) throw new Error('Expected expandable toggle button')
  act(() => btn.click())
}

describe('Codemode Phase 1 · D. ToolCallBlock 嵌套调用 DOM 渲染', () => {
  it('CM-UI-04 运行中展开时渲染 liveExec.nestedCalls（数量标题、工具名、状态图标、durationMs、error）', () => {
    const nestedCalls: NestedToolRunView[] = [
      { callId: 'n1', name: 'read', status: 'done', isError: false, durationMs: 25 },
      { callId: 'n2', name: 'grep', status: 'running' },
      {
        callId: 'n3',
        name: 'bash',
        status: 'done',
        isError: true,
        durationMs: 120,
        error: 'command failed'
      }
    ]
    setLiveExec({
      toolCallId: 'cm-1',
      toolName: 'codemode',
      args: {},
      status: 'running',
      nestedCalls
    })

    renderBlock({ status: 'running' })
    expand()

    const panel = rowEl().querySelector('.border-l')!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('Nested tool calls (3)')
    expect(panel.textContent).toContain('read')
    expect(panel.textContent).toContain('25ms')
    expect(panel.textContent).toContain('grep')
    expect(panel.textContent).toContain('bash')
    expect(panel.textContent).toContain('120ms')
    expect(panel.textContent).toContain('command failed')

    // 状态图标：ok → lucide-check，running → lucide-loader-circle / animate-spin，error → lucide-x
    expect(panel.querySelector('svg.lucide-check')).not.toBeNull()
    expect(panel.querySelector('svg.animate-spin')).not.toBeNull()
    expect(panel.querySelector('svg.lucide-x')).not.toBeNull()
  })

  it('CM-UI-05 完成后展开时渲染 details.calls（工具名、args 截断至 80 字符、状态图标、durationMs、error）', () => {
    const longArgs = `{"path":"/${'segment/'.repeat(15)}file.ts"}`
    expect(longArgs.length).toBeGreaterThan(80)
    const details = {
      calls: [
        { id: 'c1', name: 'read', args: longArgs, status: 'ok', durationMs: 18 },
        {
          id: 'c2',
          name: 'write',
          args: '{"path":"a.ts"}',
          status: 'error',
          durationMs: 9,
          error: 'permission denied'
        }
      ]
    } as unknown as ToolResultDetails

    renderBlock({ status: 'done', details })
    expand()

    const panel = rowEl().querySelector('.border-l')!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('Nested tool calls (2)')
    expect(panel.textContent).toContain('read')
    expect(panel.textContent).toContain('18ms')
    expect(panel.textContent).toContain('write')
    expect(panel.textContent).toContain('9ms')
    expect(panel.textContent).toContain('permission denied')

    // args 经 clipLine(..., 80) 截断为 80 字符（77 字符 + "..."）
    const truncated = `${longArgs.slice(0, 77)}...`
    expect(truncated).toHaveLength(80)
    expect(panel.textContent).toContain(truncated)
    expect(panel.textContent).not.toContain(longArgs)

    expect(panel.querySelector('svg.lucide-check')).not.toBeNull()
    expect(panel.querySelector('svg.lucide-x')).not.toBeNull()
  })

  it('CM-UI-06 同时存在 liveExec.nestedCalls 与 details.calls 时 liveExec.nestedCalls 优先；details.calls 畸形条目安全跳过', () => {
    // 1) 两者并存 → liveExec.nestedCalls 优先
    setLiveExec({
      toolCallId: 'cm-1',
      toolName: 'codemode',
      args: {},
      status: 'running',
      nestedCalls: [{ callId: 'live-1', name: 'live_tool', status: 'running' }]
    })
    const persistedDetails = {
      calls: [{ id: 'p-1', name: 'persisted_tool', status: 'ok', durationMs: 5 }]
    } as unknown as ToolResultDetails

    renderBlock({ status: 'running', details: persistedDetails })
    expand()

    const panel = rowEl().querySelector('.border-l')!
    expect(panel.textContent).toContain('Nested tool calls (1)')
    expect(panel.textContent).toContain('live_tool')
    expect(panel.textContent).not.toContain('persisted_tool')

    // 2) 清掉 liveExec，改测 details.calls 含畸形条目 → 安全跳过不崩溃
    act(() => {
      useChatStore.setState((s) => ({
        sessionToolExecutions: { ...s.sessionToolExecutions, [SID]: [] }
      }))
    })
    const malformedDetails = {
      calls: [
        null,
        undefined,
        'broken',
        123,
        { id: 'no-name', status: 'ok' },
        { id: 'bad-name', name: 42, status: 'ok' },
        { id: 'good', name: 'valid_tool', status: 'ok', durationMs: 7 }
      ]
    } as unknown as ToolResultDetails

    renderBlock({ status: 'done', details: malformedDetails })
    const panelAfter = rowEl().querySelector('.border-l')!
    expect(panelAfter.textContent).toContain('Nested tool calls (1)')
    expect(panelAfter.textContent).toContain('valid_tool')
    expect(panelAfter.textContent).toContain('7ms')
  })

  it('CM-UI-07 均为空时不渲染嵌套区块；折叠态不渲染；仅存在 nestedCalls 或 details.calls（无 args/result）时仍可点击展开', () => {
    // 1) 均为空（只有 result 可展开）：展开后无嵌套调用区块
    renderBlock({ status: 'done', result: 'plain output' })
    expand()
    expect(rowEl().textContent).not.toContain('Nested tool calls')

    // 2) 仅有 details.calls，无 args/result：折叠态不渲染嵌套区块，但可点击展开（canExpand === true）
    act(() => root.unmount())
    root = createRoot(container)
    renderBlock({
      status: 'done',
      args: undefined,
      result: undefined,
      details: {
        calls: [{ id: 'c1', name: 'only_details_call', status: 'ok', durationMs: 3 }]
      } as unknown as ToolResultDetails
    })
    expect(rowEl().querySelector('.border-l')).toBeNull()
    expect(rowEl().textContent).not.toContain('Nested tool calls')
    expect(rowEl().textContent).not.toContain('only_details_call')
    // 可展开（StepRow 渲染为 button）
    expect(toggleButton()).not.toBeNull()
    expand()
    expect(rowEl().textContent).toContain('Nested tool calls (1)')
    expect(rowEl().textContent).toContain('only_details_call')

    // 3) 仅有 liveExec.nestedCalls，无 args/result/details：同样折叠态不渲染，点击可展开
    act(() => root.unmount())
    root = createRoot(container)
    setLiveExec({
      toolCallId: 'cm-1',
      toolName: 'codemode',
      args: {},
      status: 'running',
      nestedCalls: [{ callId: 'n1', name: 'only_live_call', status: 'running' }]
    })
    renderBlock({
      status: 'running',
      args: undefined,
      result: undefined,
      details: undefined
    })
    expect(rowEl().querySelector('.border-l')).toBeNull()
    expect(rowEl().textContent).not.toContain('only_live_call')
    expect(toggleButton()).not.toBeNull()
    expand()
    expect(rowEl().textContent).toContain('Nested tool calls (1)')
    expect(rowEl().textContent).toContain('only_live_call')
  })
})
