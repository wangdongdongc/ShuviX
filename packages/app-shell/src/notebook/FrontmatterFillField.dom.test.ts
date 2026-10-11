// @vitest-environment jsdom
/**
 * 属性卡里能由 ShuviX 补缺的字段行（FrontmatterFillField，jsdom）—— md 扩展元数据的编辑面
 * （用户裁决 2026-10-10：补缺键就在卡片自己的行上改，不另开一条）。
 *
 * 数据来自 ChatApi `mdMeta`（可控替身，背后一块假存储 `backend`）：get 回这条笔记的视图，setFill / unsetFill
 * 写库（id 对得上才改）。写入经组件外的队列（metaWriteQueue，那边另有用例）。契约：
 *   - FF-1…7 只读的内置档案：文件没写这个键 → 这一行可改、挂「ShuviX 设置」小标（哪怕什么都没存），改的是
 *     补缺值（setFill / unsetFill，不碰文件、不分配 id）；文件写了 → md 优先，照旧只读、没有小标；没有视图 /
 *     没有 id / 视图还没回来 → 只读、没有小标；
 *   - FF-8 / 9 写入失败亮「没保存上」，title 是原因；下一次成功写入清掉；
 *   - FF-10…14 用户文件：照旧改文件；文件没写、库里存着补缺值 → 显示它并挂小标，选「未设置」清掉的是补缺值
 *     （文件里本来没有这一行）；文件写了 → 文件为准；纯空白算没写；
 *   - FF-16 写完到重查回来之间不闪回旧值；FF-18 模型行同理；FF-20 会话互不串；FF-21 解析器不收 → 「未生效」。
 *
 * 队列与 useMdMetaView 都有模块级状态：队列每条用例 reset，视图缓存清不掉 —— 所以每条用例用独占的会话 id。
 * `@shuvix/chat-ui` 整个替掉（getChatApi 交替身；ModelSelect 换成记录 props 的桩）。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { MdMetaNoteView, MdMetaWriteResult } from '@shuvix/chat-protocol/mdMeta'
import type { FrontmatterFillFieldProps } from './FrontmatterFillField'

type GetFn = (p: { sessionId: string }) => Promise<MdMetaNoteView | null>
type SetFillFn = (p: {
  sessionId: string
  objectId: string
  key: string
  value: unknown
}) => Promise<MdMetaWriteResult>
type UnsetFillFn = (p: {
  sessionId: string
  objectId: string
  key: string
}) => Promise<MdMetaWriteResult>

interface ModelSelectProps {
  provider: string
  model: string
  placeholder?: string
  readonly?: boolean
  onChange: (provider: string, model: string) => void
}

const host = vi.hoisted(() => ({
  api: {} as { mdMeta?: unknown },
  /** 最近一次渲染的 ModelSelect 的 props */
  modelSelect: null as ModelSelectProps | null
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { createElement: h } = await import('react')
  return {
    ModelSelect: (props: ModelSelectProps) => {
      host.modelSelect = props
      return h('span', {
        'data-model-select': '',
        'data-readonly': props.readonly ? 'true' : 'false',
        'data-placeholder': props.placeholder ?? ''
      })
    },
    useModelCatalogStore: (
      selector: (s: { availableModels: never[]; providers: never[] }) => unknown
    ) => selector({ availableModels: [], providers: [] }),
    getChatApi: () => host.api
  }
})

import { FrontmatterFillField } from './FrontmatterFillField'
import { resetMetaWritesForTests } from './metaWriteQueue'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const U = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const EXPLORE = 'agent:builtin:explore'
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const MODEL = 'shuvix-model'
const THINKING = 'shuvix-thinking'

/** 假存储：get 按它回视图；setFill / unsetFill 的 id 对得上才改它的 fill */
let backend: {
  objectId: string | null
  fill: Record<string, unknown>
  warnings: string[]
  readOnly: boolean
}
/** 挂着的 get：设了就等它 resolve 再按此刻的存储回视图 */
let getGate: Promise<void> | null
let mdMeta: {
  get: ReturnType<typeof vi.fn<GetFn>>
  setFill: ReturnType<typeof vi.fn<SetFillFn>>
  unsetFill: ReturnType<typeof vi.fn<UnsetFillFn>>
}
let onFileChange: ReturnType<typeof vi.fn<(next: string | null) => void>>
let container: HTMLDivElement
let root: Root
let S: string
let seq = 0
const nextSession = (): string => `ff-${++seq}`

const viewNow = (): MdMetaNoteView => ({
  kind: 'agent',
  objectId: backend.objectId,
  idStatus: backend.objectId ? 'ok' : 'none',
  fillKeys: [MODEL, THINKING],
  fill: { ...backend.fill },
  declared: [],
  warnings: [...backend.warnings],
  readOnly: backend.readOnly
})

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** 让挂起的 promise（get / setFill / 队列）落定并把 setState 刷进 DOM */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

const props = (over: Partial<FrontmatterFillFieldProps> = {}): FrontmatterFillFieldProps => ({
  sessionId: S,
  fieldKey: THINKING,
  markerType: 'agent',
  fileValue: '',
  readOnly: true,
  onFileChange: (next) => onFileChange(next),
  ...over
})

/** 渲染一行（或以新 props 重渲染同一个实例）并落定 */
async function render(over: Partial<FrontmatterFillFieldProps> = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(FrontmatterFillField, props(over)))
  })
  await flush()
}

/** 同一会话的两行（模型 + 档位）并排 */
async function renderBoth(over: Partial<FrontmatterFillFieldProps> = {}): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        'div',
        null,
        createElement(FrontmatterFillField, { key: 'm', ...props({ ...over, fieldKey: MODEL }) }),
        createElement(FrontmatterFillField, { key: 't', ...props({ ...over, fieldKey: THINKING }) })
      )
    )
  })
  await flush()
}

const q = (sel: string): Element | null => container.querySelector(sel)
const t = (key: string): string => i18n.t(key)
const row = (key = THINKING): Element => {
  const el = q(`.cm-shuvix-fmcard-fill[data-key="${key}"]`)
  if (!el) throw new Error(`fill row ${key} not rendered`)
  return el
}
const select = (): HTMLSelectElement => {
  const el = row().querySelector('select')
  if (!el) throw new Error('thinking select not rendered')
  return el
}
/**
 * 这一行是不是「ShuviX 补缺」行：不再挂文字小标，来源说明在补缺行包裹的悬停提示里（title）——
 * 有 title 的那一层就是它，没有返回 null（与原先「有没有小标」同一口径）
 */
const tag = (key = THINKING): HTMLElement | null => {
  const el = row(key) as HTMLElement
  return el.title ? el : null
}
/** 值的文字是否按「来自 ShuviX」的样式画（强调色 + 点状下划线），只在值真来自 ShuviX 时 */
const sourced = (key = THINKING): HTMLElement | null => {
  const el = row(key) as HTMLElement
  return el.dataset.source === 'shuvix'
    ? el.querySelector<HTMLElement>('.cm-shuvix-fmcard-sourced')
    : null
}
const errorOf = (key = THINKING): HTMLElement | null =>
  row(key).querySelector('.cm-shuvix-fmcard-fill-error')
const warningOf = (key = THINKING): HTMLElement | null =>
  row(key).querySelector('.cm-shuvix-fmcard-fill-warning')

async function choose(value: string, settle = true): Promise<void> {
  const el = select()
  await act(async () => {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  if (settle) await flush()
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetMetaWritesForTests()
  S = nextSession()
  backend = { objectId: EXPLORE, fill: {}, warnings: [], readOnly: true }
  getGate = null
  host.modelSelect = null
  mdMeta = {
    get: vi.fn<GetFn>(async () => {
      if (getGate) await getGate
      return viewNow()
    }),
    setFill: vi.fn<SetFillFn>(async ({ objectId, key, value }) => {
      if (objectId === backend.objectId) backend.fill = { ...backend.fill, [key]: value }
      return { success: true }
    }),
    unsetFill: vi.fn<UnsetFillFn>(async ({ objectId, key }) => {
      if (objectId === backend.objectId) {
        const next = { ...backend.fill }
        delete next[key]
        backend.fill = next
      }
      return { success: true }
    })
  }
  host.api = { mdMeta }
  onFileChange = vi.fn<(next: string | null) => void>()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('FrontmatterFillField —— 只读的内置档案', () => {
  it('FF-1 文件没写档位、库里什么都没存 → 下拉可用、值为空、悬停说明来源；没有值可染、也不挂文字小标', async () => {
    await render()
    expect(select().disabled).toBe(false)
    expect(select().value).toBe('')
    expect(tag()).not.toBeNull()
    expect(tag()!.title).toBe(t('notebook.frontmatter.fillTagHint'))
    expect(sourced()).toBeNull()
    expect(row().textContent).not.toContain(t('notebook.frontmatter.metaTitle'))
  })

  it('FF-2 库里存着 high → 显示 high，值按「来自 ShuviX」的样式画（下拉自己的字透明）', async () => {
    backend.fill = { [THINKING]: 'high' }
    await render()
    expect(select().value).toBe('high')
    expect(tag()).not.toBeNull()
    expect(sourced()?.textContent).toBe('high')
    expect(select().className).toContain('text-transparent')
    expect(row().textContent).not.toContain(t('notebook.frontmatter.metaTitle'))
  })

  it('FF-3 选 low → setFill 恰一次（内置 id、不分配 UUID），不写文件；下拉立刻是 low', async () => {
    await render()
    await choose('low', false)
    expect(select().value).toBe('low')
    await flush()
    expect(mdMeta.setFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.setFill).toHaveBeenCalledWith({
      sessionId: S,
      objectId: EXPLORE,
      key: THINKING,
      value: 'low'
    })
    expect(onFileChange).not.toHaveBeenCalled()
    const everything = JSON.stringify([
      mdMeta.setFill.mock.calls,
      mdMeta.unsetFill.mock.calls,
      mdMeta.get.mock.calls
    ])
    expect(everything).not.toMatch(UUID_ANY)
    expect(container.innerHTML).not.toMatch(UUID_ANY)
    expect(select().value).toBe('low')
    expect(tag()).not.toBeNull()
  })

  it('FF-4 选回「未设置」→ unsetFill，不调 setFill', async () => {
    backend.fill = { [THINKING]: 'high' }
    await render()
    await choose('')
    expect(mdMeta.unsetFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.unsetFill).toHaveBeenCalledWith({
      sessionId: S,
      objectId: EXPLORE,
      key: THINKING
    })
    expect(mdMeta.setFill).not.toHaveBeenCalled()
    expect(onFileChange).not.toHaveBeenCalled()
    expect(select().value).toBe('')
  })

  it('FF-5 文件写了 off、库里存着 high → 只读、显示 off、没有小标；改不动也不写任何东西', async () => {
    backend.fill = { [THINKING]: 'high' }
    await render({ fileValue: 'off' })
    expect(select().disabled).toBe(true)
    expect(select().value).toBe('off')
    expect(tag()).toBeNull()
    await choose('low')
    expect(mdMeta.setFill).not.toHaveBeenCalled()
    expect(mdMeta.unsetFill).not.toHaveBeenCalled()
    expect(onFileChange).not.toHaveBeenCalled()
  })

  it('FF-6 get 回 null / get 失败 / 视图没有 id → 只读、显示文件值、没有小标', async () => {
    mdMeta.get.mockResolvedValue(null)
    await render()
    expect(select().disabled).toBe(true)
    expect(select().value).toBe('')
    expect(tag()).toBeNull()

    S = nextSession()
    mdMeta.get.mockRejectedValue(new Error('ipc down'))
    await render()
    expect(select().disabled).toBe(true)
    expect(tag()).toBeNull()

    S = nextSession()
    mdMeta.get.mockImplementation(async () => viewNow())
    backend.objectId = null
    backend.fill = { [THINKING]: 'high' }
    await render()
    expect(select().disabled).toBe(true)
    expect(select().value).toBe('')
    expect(tag()).toBeNull()
  })

  it('FF-7 get 还没回来 → 只读，回来之后才可用', async () => {
    const gate = deferred<void>()
    getGate = gate.promise
    await render()
    expect(select().disabled).toBe(true)
    expect(tag()).toBeNull()
    gate.resolve()
    await flush()
    expect(select().disabled).toBe(false)
    expect(tag()).not.toBeNull()
  })

  it('FF-14 文件里这一行是纯空白 → 算没写：可改、显示库里的值、挂小标', async () => {
    backend.fill = { [THINKING]: 'high' }
    await render({ fileValue: '   ' })
    expect(select().disabled).toBe(false)
    expect(select().value).toBe('high')
    expect(tag()).not.toBeNull()
  })

  it('FF-15 库里存的不是字符串（3）→ 原样字符串化显示', async () => {
    backend.fill = { [THINKING]: 3 }
    await render()
    expect(select().value).toBe('3')
  })
})

describe('FrontmatterFillField —— 写入失败', () => {
  it('FF-8 「没保存上」：title 取 message / 没有 message 取 reason / 抛错取错误信息；下一次成功写入清掉', async () => {
    await render()

    mdMeta.setFill.mockResolvedValueOnce({
      success: false,
      reason: 'invalid-value',
      message: 'bad level'
    })
    await choose('low')
    expect(errorOf()).not.toBeNull()
    expect(errorOf()!.textContent).toBe(t('notebook.frontmatter.fillSaveFailed'))
    expect(errorOf()!.title).toBe('bad level')

    mdMeta.setFill.mockResolvedValueOnce({ success: false, reason: 'no-object-id' })
    await choose('medium')
    expect(errorOf()!.title).toBe('no-object-id')

    mdMeta.setFill.mockRejectedValueOnce(new Error('ipc down'))
    await choose('high')
    expect(errorOf()!.title).toBe('ipc down')

    await choose('low')
    expect(errorOf()).toBeNull()
    expect(backend.fill).toEqual({ [THINKING]: 'low' })
  })

  it('FF-9 同一会话的失败两行都亮（队列按会话记一份错误）', async () => {
    await renderBoth()
    mdMeta.setFill.mockResolvedValueOnce({ success: false, reason: 'invalid-value' })
    await choose('low')
    expect(errorOf(THINKING)).not.toBeNull()
    expect(errorOf(MODEL)).not.toBeNull()
  })
})

describe('FrontmatterFillField —— 用户自己的文件', () => {
  beforeEach(() => {
    backend = { objectId: U, fill: {}, warnings: [], readOnly: false }
  })

  it('FF-10 文件没写、库里存着 high → 显示 high 并挂小标；选 low → 写文件一次，不写库', async () => {
    backend.fill = { [THINKING]: 'high' }
    await render({ readOnly: false })
    expect(select().disabled).toBe(false)
    expect(select().value).toBe('high')
    expect(tag()).not.toBeNull()

    await choose('low')
    expect(onFileChange).toHaveBeenCalledTimes(1)
    expect(onFileChange).toHaveBeenCalledWith('low')
    expect(mdMeta.setFill).not.toHaveBeenCalled()
    expect(mdMeta.unsetFill).not.toHaveBeenCalled()
  })

  it('FF-11 文件写了 low、库里存着 high → 显示 low、没有小标；选 medium → 写文件', async () => {
    backend.fill = { [THINKING]: 'high' }
    await render({ readOnly: false, fileValue: 'low' })
    expect(select().value).toBe('low')
    expect(tag()).toBeNull()
    await choose('medium')
    expect(onFileChange).toHaveBeenCalledWith('medium')
    expect(mdMeta.setFill).not.toHaveBeenCalled()
  })

  it('FF-12 文件没写、库里没存 / 没有 id → 普通的一行，没有小标', async () => {
    await render({ readOnly: false })
    expect(select().disabled).toBe(false)
    expect(select().value).toBe('')
    expect(tag()).toBeNull()

    S = nextSession()
    backend.objectId = null
    await render({ readOnly: false })
    expect(select().value).toBe('')
    expect(tag()).toBeNull()
  })

  it('FF-13 正显示着库里的补缺值时选「未设置」→ 经队列 unsetFill（不写文件）；重查之后成了普通的一行', async () => {
    backend.fill = { [THINKING]: 'high' }
    await render({ readOnly: false })
    await choose('')
    expect(mdMeta.unsetFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.unsetFill).toHaveBeenCalledWith({ sessionId: S, objectId: U, key: THINKING })
    expect(onFileChange).not.toHaveBeenCalled()
    expect(backend.fill).toEqual({})
    expect(select().value).toBe('')
    expect(tag()).toBeNull()
  })

  it('FF-21 解析器不收（视图带告警）且正显示着补缺值 → 「未生效」，title 是告警；文件写了或什么都没显示 → 没有', async () => {
    backend.fill = { [THINKING]: 'high' }
    backend.warnings = ['bad']
    await render({ readOnly: false })
    expect(warningOf()).not.toBeNull()
    expect(warningOf()!.textContent).toBe(t('notebook.frontmatter.fillNotApplied'))
    expect(warningOf()!.title).toBe('bad')

    await render({ readOnly: false, fileValue: 'low' })
    expect(warningOf()).toBeNull()

    S = nextSession()
    backend.fill = {}
    await render({ readOnly: false })
    expect(warningOf()).toBeNull()
  })
})

describe('FrontmatterFillField —— 时序与模型行', () => {
  it('FF-16 不闪回：setFill 挂着 → 新值；setFill 完了重查挂着 → 仍是刚写的值；重查回来 → 库里的值；从不露出旧值', async () => {
    backend.fill = { [THINKING]: 'medium' }
    await render()
    expect(select().value).toBe('medium')

    const write = deferred<MdMetaWriteResult>()
    mdMeta.setFill.mockImplementationOnce(async ({ key, value }) => {
      const result = await write.promise
      backend.fill = { ...backend.fill, [key]: value }
      return result
    })
    await choose('low')
    expect(mdMeta.setFill).toHaveBeenCalledTimes(1)
    expect(select().value).toBe('low')

    const reget = deferred<void>()
    getGate = reget.promise
    write.resolve({ success: true })
    await flush()
    expect(select().value).toBe('low')

    reget.resolve()
    await flush()
    expect(select().value).toBe('low')
    expect(backend.fill).toEqual({ [THINKING]: 'low' })
  })

  it('FF-18 模型行：内置、文件没写 → ModelSelect 可用、挂小标；选一个模型 → setFill 值是 provider/model；文件写了 → ModelSelect 只读', async () => {
    await render({ fieldKey: MODEL })
    expect(host.modelSelect?.readonly).toBe(false)
    expect(tag(MODEL)).not.toBeNull()
    await act(async () => {
      host.modelSelect!.onChange('p', 'm')
    })
    await flush()
    expect(mdMeta.setFill).toHaveBeenCalledWith({
      sessionId: S,
      objectId: EXPLORE,
      key: MODEL,
      value: 'p/m'
    })
    // 存进去的值（解析不出的 ref）回填成占位文案
    expect(row(MODEL).querySelector('[data-model-select]')?.getAttribute('data-placeholder')).toBe(
      'p/m'
    )

    S = nextSession()
    await render({ fieldKey: MODEL, fileValue: 'x/y' })
    expect(host.modelSelect?.readonly).toBe(true)
    expect(tag(MODEL)).toBeNull()
  })

  it('FF-20 s1 的在途值不出现在 s2 那一行', async () => {
    const write = deferred<MdMetaWriteResult>()
    mdMeta.setFill.mockImplementationOnce(() => write.promise)
    await render()
    await choose('low')
    expect(select().value).toBe('low')

    S = nextSession()
    await render()
    expect(select().value).toBe('')
    write.resolve({ success: true })
    await flush()
  })
})
