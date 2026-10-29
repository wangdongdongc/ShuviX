// @vitest-environment jsdom
/**
 * ModelDefaultsSettings（设置 → 通用 → 默认模型）DOM 测试（jsdom）—— 默认思考等级那一行
 * `[data-default-thinking]`：
 *
 *   - MD-1 恰好六段，顺序跟输入框思考选择器同一份（`SELECTABLE_THINKING_LEVELS`）—— 两处各写一份就会
 *     漂移；文案就是档位名本身，界面语言是中文也不翻译；
 *   - MD-2 受控：prop 给哪一档，就恰好那一段是选中态（SegmentedControl 以 `shadow-sm` 标选中）；
 *   - MD-3 点一段只回调 `setDefaultThinkingLevel(该档)` 一次，不碰默认提供商 / 模型的 setter；
 *   - MD-4 prop 变了，选中态跟着变（组件不自己留一份状态）。
 *
 * 命令分类模型一行 `[data-classifier-model]`（可选的 `classifier` prop）：
 *
 *   - MD-C1 不给 prop → 没有这一行，只有默认模型那一个 ModelSelect；
 *   - MD-C2 给了 → 这一行的 ModelSelect 拿到同一个 models 数组、provider / model、allowClear，
 *     clearLabel 是「不分类」的译文；行标题是译文而不是原始键名；
 *   - MD-C3 它的 onChange(p, m) 只回调 classifier.onChange(p, m) 一次，不碰默认模型的 setter；反过来
 *     默认模型的 onChange 也不碰分类模型；
 *   - MD-C4 prop 变了，ModelSelect 收到的跟着变（组件不自己留一份状态）。
 * （「不分类」的真实交互 —— 清除、空态文案、选一行 —— 用真的 ModelSelect，见
 *  modelDefaultsClassifier.dom.test.ts。）
 *
 * 包入口 `@shuvix/chat-ui` 顶掉，ModelSelect 换成一个记下 props 的空壳；SettingsPrimitives 用真的。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AvailableModel } from '@shuvix/chat-protocol/types/provider'
import {
  SELECTABLE_THINKING_LEVELS,
  type SelectableThinkingLevel
} from '@shuvix/chat-protocol/types/thinking'

/** ModelSelect 空壳收到的 props（按 clearLabel 认是哪一行的；每次渲染覆盖成最新的） */
interface ModelSelectProbeProps {
  availableModels: AvailableModel[]
  provider: string
  model: string
  onChange: (provider: string, model: string) => void
  allowClear?: boolean
  clearLabel?: string
}
const probe = vi.hoisted(() => ({
  latest: new Map<string, ModelSelectProbeProps>()
}))

vi.mock('@shuvix/chat-ui', () => ({
  ModelSelect: (props: ModelSelectProbeProps) => {
    probe.latest.set(props.clearLabel ?? '', props)
    return createElement('div', { 'data-probe': 'model-select' })
  }
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

async function render(
  defaultThinkingLevel: SelectableThinkingLevel,
  extra: Partial<ModelDefaultsSettingsProps> = {}
): Promise<void> {
  const props: ModelDefaultsSettingsProps = {
    availableModels: [],
    defaultProvider: '',
    defaultModel: '',
    defaultThinkingLevel,
    ...(setters as unknown as Pick<
      ModelDefaultsSettingsProps,
      'setDefaultProvider' | 'setDefaultModel' | 'setDefaultThinkingLevel'
    >),
    ...extra
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
  probe.latest.clear()
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
  it('MD-1 恰好六段：顺序即 SELECTABLE_THINKING_LEVELS，文案即档位名本身（中文界面也不翻译）', async () => {
    await render('medium')
    const texts = segments().map((button) => (button.textContent ?? '').trim())
    expect(texts).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(texts).toEqual([...SELECTABLE_THINKING_LEVELS])
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

// ─────────────────────────────────────────────────────────────────────────
// 命令分类模型一行

const model = (providerId: string, modelId: string, providerName = providerId): AvailableModel => ({
  id: `${providerId}:${modelId}`,
  providerId,
  modelId,
  isEnabled: 1,
  sortOrder: 0,
  capabilities: '{}',
  providerName
})

const CHAT_MODELS = [model('row-chat', 'gpt-x', 'Chat Co')]
const CLASSIFIER_MODELS = [model('row-or', '~typesafe/jev-latest', 'OpenRouter')]

/** 某一行的 ModelSelect 最近一次收到的 props（按它的 clearLabel 认） */
function selectProps(
  clearKey: 'settings.defaultModelNone' | 'settings.classifierModelNone'
): ModelSelectProbeProps {
  const props = probe.latest.get(i18n.t(clearKey))
  if (!props) throw new Error(`no ModelSelect rendered with clearLabel = t(${clearKey})`)
  return props
}

describe('命令分类模型一行 [data-classifier-model]', () => {
  it('MD-C1 不给 classifier → 没有这一行，DOM 里只有默认模型那一个 ModelSelect', async () => {
    await render('medium')
    expect(container.querySelector('[data-classifier-model]')).toBeNull()
    expect(container.querySelectorAll('[data-probe="model-select"]')).toHaveLength(1)
    expect(probe.latest.has(i18n.t('settings.classifierModelNone'))).toBe(false)
  })

  it('MD-C2 给了 classifier → 这一行的 ModelSelect 拿到同一个 models 数组、provider / model、allowClear 与「不分类」的译文；行标题是译文', async () => {
    const onChange = vi.fn()
    await render('medium', {
      availableModels: CHAT_MODELS,
      classifier: {
        models: CLASSIFIER_MODELS,
        provider: 'row-or',
        model: '~typesafe/jev-latest',
        onChange
      }
    })
    const row = container.querySelector('[data-classifier-model]')
    expect(row).not.toBeNull()
    expect(row!.querySelectorAll('[data-probe="model-select"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-probe="model-select"]')).toHaveLength(2)

    const props = selectProps('settings.classifierModelNone')
    expect(props.availableModels).toBe(CLASSIFIER_MODELS)
    expect(props.provider).toBe('row-or')
    expect(props.model).toBe('~typesafe/jev-latest')
    expect(props.allowClear).toBe(true)
    expect(props.clearLabel).toBe(i18n.t('settings.classifierModelNone'))
    expect(props.clearLabel).not.toBe('settings.classifierModelNone')
    // 默认模型那一行拿的是对话模型的清单，两份没串
    expect(selectProps('settings.defaultModelNone').availableModels).toBe(CHAT_MODELS)

    const title = i18n.t('settings.classifierModelRow')
    expect(title).not.toBe('settings.classifierModelRow')
    expect(container.textContent).toContain(title)
    expect(container.textContent).not.toContain('settings.classifierModelRow')
  })

  it('MD-C3 分类那一行 onChange("r", "m") → 只回调 classifier.onChange("r", "m") 一次；默认模型那一行 onChange 也不碰分类模型', async () => {
    const onChange = vi.fn()
    await render('medium', {
      classifier: { models: CLASSIFIER_MODELS, provider: '', model: '', onChange }
    })
    await act(async () => {
      selectProps('settings.classifierModelNone').onChange('r', 'm')
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('r', 'm')
    expect(setters.setDefaultProvider).not.toHaveBeenCalled()
    expect(setters.setDefaultModel).not.toHaveBeenCalled()
    expect(setters.setDefaultThinkingLevel).not.toHaveBeenCalled()

    await act(async () => {
      selectProps('settings.defaultModelNone').onChange('p', 'q')
    })
    expect(setters.setDefaultProvider).toHaveBeenCalledWith('p')
    expect(setters.setDefaultModel).toHaveBeenCalledWith('q')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('MD-C4 prop 变了，ModelSelect 收到的跟着变（组件不自己留一份状态）', async () => {
    const onChange = vi.fn()
    await render('medium', {
      classifier: { models: CLASSIFIER_MODELS, provider: '', model: '', onChange }
    })
    expect(selectProps('settings.classifierModelNone')).toMatchObject({ provider: '', model: '' })

    const next = [...CLASSIFIER_MODELS, model('row-oc', 'jev-1.13', 'OpenCode')]
    await render('medium', {
      classifier: { models: next, provider: 'row-oc', model: 'jev-1.13', onChange }
    })
    const props = selectProps('settings.classifierModelNone')
    expect(props.availableModels).toBe(next)
    expect(props).toMatchObject({ provider: 'row-oc', model: 'jev-1.13' })
    expect(onChange).not.toHaveBeenCalled()
  })
})
