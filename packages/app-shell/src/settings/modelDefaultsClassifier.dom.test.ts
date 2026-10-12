// @vitest-environment jsdom
/**
 * ModelDefaultsSettings 的命令分类模型一行 `[data-classifier-model]`，配**真的** ModelSelect（jsdom）——
 * 「不分类」是 ModelSelect 的清除态（`allowClear` + `clearLabel`），只有真组件能证明它真能清、真显示：
 *
 *   - MD-C5 有选中时，标题为「不分类」的清除钮 → onChange('', '')；没选中时触发钮写着「不分类」；
 *     展开面板、展开提供商组、点一行 → onChange(行 id, 模型 id)
 *   - MD-C6 清单为空（没有启用的提供商带分类模型）→ 触发钮仍写「不分类」；设置里存的提供商已不在
 *     清单里 → 触发钮露出原始的行 id（钉住现状）
 *
 * `@shuvix/chat-ui` 的包入口很重（mermaid 等），这里只把它的 ModelSelect 源文件接进来。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AvailableModel } from '@shuvix/chat-protocol/types/provider'

vi.mock('@shuvix/chat-ui', async () => {
  const { ModelSelect } = await import('../../../chat-ui/src/components/chat/ModelSelect')
  return { ModelSelect }
})

import { ModelDefaultsSettings, type ModelDefaultsSettingsProps } from './ModelDefaultsSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const JEV = '~typesafe/jev-latest'
const CLASSIFIER_MODELS: AvailableModel[] = [
  {
    id: `row-or:${JEV}`,
    providerId: 'row-or',
    modelId: JEV,
    isEnabled: 1,
    sortOrder: 0,
    capabilities: '{}',
    providerName: 'OpenRouter'
  }
]

let container: HTMLDivElement
let root: Root
let onChange: ReturnType<typeof vi.fn<(provider: string, model: string) => void>>

async function render(classifier: {
  models: AvailableModel[]
  provider: string
  model: string
}): Promise<void> {
  const props: ModelDefaultsSettingsProps = {
    availableModels: [],
    defaultProvider: '',
    defaultModel: '',
    defaultThinkingLevel: 'medium',
    setDefaultProvider: vi.fn(),
    setDefaultModel: vi.fn(),
    setDefaultThinkingLevel: vi.fn(),
    classifier: { ...classifier, onChange }
  }
  await act(async () => {
    root.render(createElement(ModelDefaultsSettings, props))
  })
}

const row = (): HTMLElement => {
  const el = container.querySelector<HTMLElement>('[data-classifier-model]')
  if (!el) throw new Error('[data-classifier-model] not rendered')
  return el
}
/** 触发钮 = 这一行里的第一个按钮 */
const trigger = (): HTMLButtonElement => {
  const btn = row().querySelector<HTMLButtonElement>('button')
  if (!btn) throw new Error('classifier trigger not rendered')
  return btn
}
const off = (): string => i18n.t('settings.classifierModelNone')

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
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
  onChange = vi.fn<(provider: string, model: string) => void>()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('分类模型一行配真的 ModelSelect', () => {
  it('MD-C5 有选中：标题为「不分类」的清除钮 → onChange("", "")', async () => {
    await render({ models: CLASSIFIER_MODELS, provider: 'row-or', model: JEV })
    expect(off()).toBe('不分类')
    expect(trigger().textContent).toContain('OpenRouter')
    expect(trigger().textContent).toContain(JEV)
    const clear = [...row().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.getAttribute('title') === off()
    )
    expect(clear).toBeDefined()
    await click(clear!)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('', '')
  })

  it('MD-C5 没有选中：触发钮写着「不分类」，没有清除钮', async () => {
    await render({ models: CLASSIFIER_MODELS, provider: '', model: '' })
    expect((trigger().textContent ?? '').trim()).toBe(off())
    expect(row().querySelectorAll('button')).toHaveLength(1)
  })

  it('MD-C5 展开面板 → 展开 OpenRouter 组 → 点 Jev 那一行 → onChange(行 id, 模型 id)', async () => {
    await render({ models: CLASSIFIER_MODELS, provider: '', model: '' })
    await click(trigger())
    const panel = document.querySelector('[data-model-panel]')
    expect(panel).not.toBeNull()
    // 没有选中时提供商组都收着：先点组头
    const group = [...panel!.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.textContent ?? '').includes('OpenRouter')
    )
    expect(group).toBeDefined()
    await click(group!)
    const item = document.querySelector(`[data-model-item="row-or/${JEV}"]`)
    expect(item).not.toBeNull()
    await click(item!)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('row-or', JEV)
    expect(document.querySelector('[data-model-panel]')).toBeNull()
  })

  it('MD-C6 清单为空 → 触发钮仍写「不分类」；存的提供商已不在清单里 → 触发钮露出原始行 id（钉住现状）', async () => {
    await render({ models: [], provider: '', model: '' })
    expect((trigger().textContent ?? '').trim()).toBe(off())

    await render({ models: [], provider: 'gone-row', model: JEV })
    expect(trigger().textContent).toContain('gone-row')
    expect(trigger().textContent).toContain(JEV)
  })
})
