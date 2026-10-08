// @vitest-environment jsdom
/**
 * ModelDefaultsSettings（设置 → 通用 → 默认模型）DOM 测试（jsdom）—— 默认思考等级那一行
 * `[data-default-thinking]`：
 *
 *   - MD-1 恰好五段，顺序与文案都跟输入框思考选择器同一份（`SELECTABLE_THINKING_LEVELS` +
 *     `THINKING_LEVEL_LABEL_KEYS`）—— 两处各写一份就会漂移；
 *   - MD-2 受控：prop 给哪一档，就恰好那一段是选中态（SegmentedControl 以 `shadow-sm` 标选中）；
 *   - MD-3 点一段只回调 `setDefaultThinkingLevel(该档)` 一次，不碰默认提供商 / 模型的 setter；
 *   - MD-4 prop 变了，选中态跟着变（组件不自己留一份状态）。
 *
 * 包入口 `@shuvix/chat-ui` 顶掉，ModelSelect 换成一个可辨认的空壳（默认模型那一行不是这里的事）；
 * SettingsPrimitives 用真的。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import {
  SELECTABLE_THINKING_LEVELS,
  THINKING_LEVEL_LABEL_KEYS,
  type SelectableThinkingLevel
} from '@shuvix/chat-protocol/types/thinking'

vi.mock('@shuvix/chat-ui', () => ({
  ModelSelect: () => createElement('div', { 'data-probe': 'model-select' })
}))

import { ModelDefaultsSettings, type ModelDefaultsSettingsProps } from './ModelDefaultsSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let setters: {
  setDefaultProvider: ReturnType<typeof vi.fn>
  setDefaultModel: ReturnType<typeof vi.fn>
  setDefaultThinkingLevel: ReturnType<typeof vi.fn>
}

async function render(defaultThinkingLevel: SelectableThinkingLevel): Promise<void> {
  const props: ModelDefaultsSettingsProps = {
    availableModels: [],
    defaultProvider: '',
    defaultModel: '',
    defaultThinkingLevel,
    ...(setters as unknown as Pick<
      ModelDefaultsSettingsProps,
      'setDefaultProvider' | 'setDefaultModel' | 'setDefaultThinkingLevel'
    >)
  }
  await act(async () => {
    root.render(createElement(ModelDefaultsSettings, props))
  })
}

/** 默认思考等级那一行里的分段按钮（按 DOM 顺序） */
function segments(): HTMLButtonElement[] {
  const row = container.querySelector('[data-default-thinking]')
  if (!row) throw new Error('[data-default-thinking] not rendered')
  return [...row.querySelectorAll<HTMLButtonElement>('button')]
}

const isSelected = (button: HTMLButtonElement): boolean =>
  button.className.split(/\s+/).includes('shadow-sm')

/** 选中态的下标（应恰有一个） */
function selectedIndexes(): number[] {
  return segments().flatMap((button, index) => (isSelected(button) ? [index] : []))
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  setters = {
    setDefaultProvider: vi.fn(),
    setDefaultModel: vi.fn(),
    setDefaultThinkingLevel: vi.fn()
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('默认思考等级一行 [data-default-thinking]', () => {
  it('MD-1 恰好五段：顺序即 SELECTABLE_THINKING_LEVELS，文案即 THINKING_LEVEL_LABEL_KEYS 的译文', async () => {
    await render('medium')
    const texts = segments().map((button) => (button.textContent ?? '').trim())
    const expected = SELECTABLE_THINKING_LEVELS.map((level) =>
      i18n.t(THINKING_LEVEL_LABEL_KEYS[level])
    )
    expect(texts).toHaveLength(5)
    expect(texts).toEqual(expected)
    // 译文真的取到了（不是 i18next 兜底露出的原始键名）
    for (const [i, level] of SELECTABLE_THINKING_LEVELS.entries()) {
      expect(texts[i]).not.toBe(THINKING_LEVEL_LABEL_KEYS[level])
    }
  })

  it.each([...SELECTABLE_THINKING_LEVELS])(
    'MD-2 prop 为 %s → 恰好那一段是选中态',
    async (level) => {
      await render(level)
      expect(selectedIndexes()).toEqual([SELECTABLE_THINKING_LEVELS.indexOf(level)])
    }
  )

  it('MD-3 选中 medium 时点 xhigh：只回调 setDefaultThinkingLevel("xhigh") 一次，不碰提供商 / 模型', async () => {
    await render('medium')
    const xhigh = segments()[SELECTABLE_THINKING_LEVELS.indexOf('xhigh')]
    await act(async () => {
      xhigh.click()
    })
    expect(setters.setDefaultThinkingLevel).toHaveBeenCalledTimes(1)
    expect(setters.setDefaultThinkingLevel).toHaveBeenCalledWith('xhigh')
    expect(setters.setDefaultProvider).not.toHaveBeenCalled()
    expect(setters.setDefaultModel).not.toHaveBeenCalled()
  })

  it('MD-4 prop 从 medium 换成 high：选中态跟着移过去', async () => {
    await render('medium')
    expect(selectedIndexes()).toEqual([SELECTABLE_THINKING_LEVELS.indexOf('medium')])
    await render('high')
    expect(selectedIndexes()).toEqual([SELECTABLE_THINKING_LEVELS.indexOf('high')])
  })
})
