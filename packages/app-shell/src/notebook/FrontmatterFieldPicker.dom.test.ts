// @vitest-environment jsdom
/**
 * FrontmatterFieldPicker 的 `shuvix-thinking` 槽位（jsdom）—— agent md 属性卡上的思考档位下拉。
 *
 * 候选项取 chat-protocol `SELECTABLE_THINKING_LEVELS`（与输入框的思考选择器、agent md 解析器同一份），
 * 用例循环常量而不手写五个词：
 *   - FP-1 空值：首项「未设置」+ 五档同序，当前选中「未设置」；
 *   - FP-2 选一档写回该档；选回「未设置」写回 null（= 删除该键：跟随派发方 / 父会话）；
 *   - FP-3 只读（内置档案）：下拉禁用，当前档照常显示；
 *   - FP-4 清单外的写法如实并入候选、排在五档之前 —— 合法与否一视同仁（`max` 让文件非法，`HIGH`
 *     合法但不规范；卡片都不替它归一），保存前它仍是文件里的事实；仅仅渲染不触发写回。
 *
 * 包入口 `@shuvix/chat-ui` 顶掉：这条分派路径用不到 ModelSelect / 模型目录 / ChatApi，
 * 顶掉是为了不把整个聊天包拉进 jsdom。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { AGENT_THINKING_KEY } from '@shuvix/chat-protocol/shuvixMdDescriptors'
import { SELECTABLE_THINKING_LEVELS } from '@shuvix/chat-protocol/types/thinking'

vi.mock('@shuvix/chat-ui', () => ({
  ModelSelect: () => null,
  useModelCatalogStore: () => [],
  getChatApi: () => ({})
}))

import { FrontmatterFieldPicker } from './FrontmatterFieldPicker'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let onChange: ReturnType<typeof vi.fn<(next: string | null) => void>>

/** 按属性卡的分派入参渲染思考档位槽位，交回那个原生下拉 */
async function renderThinking(value: string, readOnly = false): Promise<HTMLSelectElement> {
  await act(async () => {
    root.render(
      createElement(FrontmatterFieldPicker, {
        fieldKey: AGENT_THINKING_KEY,
        markerType: 'agent',
        kind: 'select',
        value,
        onChange,
        readOnly
      })
    )
  })
  const select = container.querySelector('select')
  if (!select) throw new Error('thinking select not rendered')
  return select
}

const optionValues = (select: HTMLSelectElement): string[] =>
  [...select.options].map((o) => o.value)

/** 改选：设 value 后派发冒泡的 change（React 对 select 只听 change） */
async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  onChange = vi.fn<(next: string | null) => void>()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('FrontmatterFieldPicker —— shuvix-thinking 的档位下拉', () => {
  it('FP-1 空值：首项「未设置」+ 五档与共享清单同序，当前选中「未设置」', async () => {
    const select = await renderThinking('')
    expect(optionValues(select)).toEqual(['', ...SELECTABLE_THINKING_LEVELS])
    expect(select.options[0].textContent).toBe(i18n.t('notebook.frontmatter.unset'))
    expect(select.value).toBe('')
    expect(select.disabled).toBe(false)
  })

  it('FP-2 选 off 写回 off；从 off 选回「未设置」写回 null（删键）', async () => {
    // off 是一个声明（「这个 agent 不思考」），不能被当成空值吞成 null
    const empty = await renderThinking('')
    await choose(empty, 'off')
    expect(onChange.mock.calls).toEqual([['off']])

    onChange.mockClear()
    const declared = await renderThinking('off')
    expect(declared.value).toBe('off')
    await choose(declared, '')
    expect(onChange.mock.calls).toEqual([[null]])
  })

  it('FP-3 只读（内置档案）：下拉禁用，当前档 xhigh 照常选中', async () => {
    const select = await renderThinking('xhigh', true)
    expect(select.disabled).toBe(true)
    expect(select.value).toBe('xhigh')
    expect(select.selectedOptions[0]?.value).toBe('xhigh')
  })

  it.each([
    ['非法', 'max'],
    ['合法但不规范', 'HIGH']
  ])(
    'FP-4 清单外的写法（%s：`%s`）：如实显示为当前项、排在五档之前，渲染本身不写回',
    async (_label, raw) => {
      const select = await renderThinking(raw)
      expect(optionValues(select)).toEqual(['', raw, ...SELECTABLE_THINKING_LEVELS])
      expect(select.value).toBe(raw)
      // 不做归一、不替用户改写：写回只发生在用户真的改选时
      expect(onChange).not.toHaveBeenCalled()
    }
  )
})
