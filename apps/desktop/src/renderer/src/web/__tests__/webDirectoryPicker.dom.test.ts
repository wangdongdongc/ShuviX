// @vitest-environment jsdom
/**
 * `web/WebDirectoryPicker.tsx`（server mode phase D）—— web 客户端代替原生「选择文件夹」框的目录浏览器。由
 * `webDirectoryPick` 的仓库驱动（`requestDirectoryPick` 挂起一次、组件 settle）；列的是服务端的目录
 * （`window.api.fs.listDirectories`，这里是一个受控的假件：每次调用记下参数，回一个由用例来结束的 Promise）。
 *
 *   DP-1 没有挂起的选择 → 什么也不渲染；挂起 → `[data-web-directory-picker]` role=dialog aria-modal；第一次请求
 *        {path:'/start', showHidden:false}；没给起点 → {showHidden:false}（没有 path 键）
 *   DP-2 子目录按回包顺序渲染成 `[data-web-dir-entry=<名字>]`；路径框是 listing.path；「上一层」只在 parent 为 null 时
 *        禁用；没有子目录 / 截断时各有一句
 *   DP-3 点一行 → {path: entry.path}；上一层 → parent；主目录 → 不带 path；输入 `  /typed  ` 回车 → '/typed'；空白 →
 *        不带 path；隐藏开关 → {path: 当前, showHidden:true}，之后的跳转一直带着它
 *   DP-4 读不了的目录 → `[data-web-dir-error="ENOENT"]`（pickFolderError），「选择」禁用，「上一层」照用
 *   DP-5 「选择」交回 listing.path 并收起；请求在途时「选择」禁用
 *   DP-6 取消 / Esc / 在遮罩上按下 → null；在对话框里按下不取消
 *   DP-7 慢的 A 与后发的 B：先回 B 再回 A → 留下的是 B
 *   DP-8 请求本身失败 → `[data-web-dir-error="request"]`（pickFolderFailed），「选择」禁用、取消照用；之后一次成功的跳转
 *        把它清掉
 *   DP-9 开着时又来一次挂起 → 上一次以 null 结束，对话框重挂、按新的起点重新请求
 *
 * 渲染层的 vitest 只收 `*.test.ts`、没有 react 插件：一律 createElement。i18n 用真的 en 资源；不引 `@shuvix/chat-ui`。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { DirectoryListing, ListDirectoriesParams } from '../../../../shared/serverFs'
import { WebDirectoryPicker } from '../WebDirectoryPicker'
import {
  currentDirectoryPick,
  requestDirectoryPick,
  settleDirectoryPick
} from '../webDirectoryPick'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const W = en.web

interface Call {
  params: ListDirectoriesParams
  resolve: (listing: DirectoryListing) => void
  reject: (error: unknown) => void
}

let calls: Call[]
let container: HTMLDivElement
let root: Root

const listDirectories = vi.fn((params: ListDirectoriesParams) => {
  return new Promise<DirectoryListing>((resolve, reject) => {
    calls.push({ params, resolve, reject })
  })
})

/** 一份回包 */
const listing = (
  path: string,
  names: string[],
  extra: Partial<DirectoryListing> = {}
): DirectoryListing => ({
  path,
  parent: path === '/' ? null : path.replace(/\/[^/]+$/, '') || '/',
  home: '/home/u',
  entries: names.map((name) => ({ name, path: `${path === '/' ? '' : path}/${name}` })),
  ...extra
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 结束第 n 次请求（缺省最后一次） */
async function answer(value: DirectoryListing, index = calls.length - 1): Promise<void> {
  await act(async () => {
    calls[index].resolve(value)
    await flush()
  })
}

async function fail(index = calls.length - 1): Promise<void> {
  await act(async () => {
    calls[index].reject(new Error('socket closed'))
    await flush()
  })
}

/** 挂起一次选择（结果收在返回的盒子里） */
function request(startPath?: string): { value: string | null | 'pending' } {
  const box: { value: string | null | 'pending' } = { value: 'pending' }
  act(() => {
    void requestDirectoryPick(startPath).then((value) => (box.value = value))
  })
  return box
}

const $ = <T extends Element = HTMLElement>(selector: string): T | null =>
  container.querySelector<T>(selector)

function must<T extends Element = HTMLElement>(selector: string): T {
  const el = $<T>(selector)
  if (!el) throw new Error(`${selector} not rendered`)
  return el
}

async function click(selector: string): Promise<void> {
  await act(async () => {
    must(selector).click()
    await flush()
  })
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const entryNames = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('[data-web-dir-entry]')].map(
    (el) => el.dataset.webDirEntry ?? ''
  )
const pathInput = (): HTMLInputElement => must<HTMLInputElement>('[data-web-dir-path]')
const chooseButton = (): HTMLButtonElement => must<HTMLButtonElement>('[data-web-dir-choose]')
const upButton = (): HTMLButtonElement => must<HTMLButtonElement>('[data-web-dir-up]')
const lastParams = (): ListDirectoriesParams => calls[calls.length - 1].params

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  calls = []
  listDirectories.mockClear()
  ;(window as unknown as { api: unknown }).api = { fs: { listDirectories } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(WebDirectoryPicker)))
})

afterEach(() => {
  // 仓库是模块级的：没结束的那一次按取消收掉，下一条用例从空开始
  const pending = currentDirectoryPick()
  if (pending) act(() => settleDirectoryPick(pending.id, null))
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('DP-1 挂起与第一次请求', () => {
  it('DP-1 没有挂起 → 什么也不渲染；挂起 → 对话框；第一次请求带起点', () => {
    expect(container.innerHTML).toBe('')
    expect(listDirectories).not.toHaveBeenCalled()

    request('/start')
    const dialog = must('[data-web-directory-picker]')
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe(W.pickFolderTitle)
    expect(listDirectories).toHaveBeenCalledTimes(1)
    expect(lastParams()).toStrictEqual({ path: '/start', showHidden: false })
  })

  it('DP-1 没给起点 → {showHidden:false}，没有 path 键', () => {
    request()
    expect(listDirectories).toHaveBeenCalledTimes(1)
    expect(lastParams()).toStrictEqual({ showHidden: false })
    expect('path' in lastParams()).toBe(false)
  })
})

describe('DP-2 渲染回包', () => {
  it('DP-2 子目录按顺序；路径框是 listing.path；上一层只在 parent 为 null 时禁用', async () => {
    request('/srv')
    await answer(listing('/srv', ['zeta', 'alpha', 'Beta']))
    expect(entryNames()).toStrictEqual(['zeta', 'alpha', 'Beta'])
    expect(pathInput().value).toBe('/srv')
    expect(upButton().disabled).toBe(false)

    await click('[data-web-dir-home]')
    await answer(listing('/', ['srv', 'home']))
    expect(pathInput().value).toBe('/')
    expect(upButton().disabled).toBe(true)
  })

  it('DP-2 没有子目录 → pickFolderEmpty；截断 → pickFolderTruncated', async () => {
    request('/empty')
    await answer(listing('/empty', []))
    expect(container.textContent).toContain(W.pickFolderEmpty)
    expect(container.textContent).not.toContain('Only the first')

    await click('[data-web-dir-home]')
    await answer(listing('/big', ['a', 'b'], { truncated: true }))
    expect(entryNames()).toStrictEqual(['a', 'b'])
    expect(container.textContent).toContain('Only the first 2 folders are shown')
    expect(container.textContent).not.toContain(W.pickFolderEmpty)
  })
})

describe('DP-3 跳转', () => {
  it('DP-3 点一行 / 上一层 / 主目录', async () => {
    request('/srv')
    await answer(listing('/srv', ['proj']))

    await click('[data-web-dir-entry="proj"]')
    expect(lastParams()).toStrictEqual({ path: '/srv/proj', showHidden: false })
    await answer(listing('/srv/proj', []))

    await click('[data-web-dir-up]')
    expect(lastParams()).toStrictEqual({ path: '/srv', showHidden: false })
    await answer(listing('/srv', ['proj']))

    await click('[data-web-dir-home]')
    expect(lastParams()).toStrictEqual({ showHidden: false })
  })

  it('DP-3 输入路径回车：去首尾空白；空白 → 不带 path', async () => {
    request('/srv')
    await answer(listing('/srv', []))

    await typeInto(pathInput(), '  /typed  ')
    await click('[data-web-dir-go]')
    expect(lastParams()).toStrictEqual({ path: '/typed', showHidden: false })
    await answer(listing('/typed', []))

    await typeInto(pathInput(), '   ')
    await click('[data-web-dir-go]')
    expect(lastParams()).toStrictEqual({ showHidden: false })
  })

  it('DP-3 隐藏开关 → {path: 当前, showHidden:true}；之后的跳转一直带着它', async () => {
    request('/srv')
    await answer(listing('/srv', ['proj']))

    await click('[data-web-dir-hidden]')
    expect(must<HTMLInputElement>('[data-web-dir-hidden]').checked).toBe(true)
    expect(lastParams()).toStrictEqual({ path: '/srv', showHidden: true })
    await answer(listing('/srv', ['.cache', 'proj']))
    expect(entryNames()).toStrictEqual(['.cache', 'proj'])

    await click('[data-web-dir-entry="proj"]')
    expect(lastParams()).toStrictEqual({ path: '/srv/proj', showHidden: true })
    await answer(listing('/srv/proj', []))
    await click('[data-web-dir-up]')
    expect(lastParams()).toStrictEqual({ path: '/srv', showHidden: true })
    await answer(listing('/srv', ['proj']))
    await click('[data-web-dir-home]')
    expect(lastParams()).toStrictEqual({ showHidden: true })
  })
})

describe('DP-4 读不了的目录', () => {
  it('DP-4 error → [data-web-dir-error=ENOENT]，选择禁用，上一层照用', async () => {
    request('/srv/nope')
    await answer(listing('/srv/nope', [], { error: 'ENOENT' }))
    const error = must('[data-web-dir-error]')
    expect(error.getAttribute('data-web-dir-error')).toBe('ENOENT')
    expect(error.textContent).toBe("Can't open this folder (ENOENT)")
    expect(chooseButton().disabled).toBe(true)
    expect(upButton().disabled).toBe(false)

    await click('[data-web-dir-up]')
    expect(lastParams()).toStrictEqual({ path: '/srv', showHidden: false })
  })
})

describe('DP-5 选择', () => {
  it('DP-5 请求在途时禁用；「选择」交回 listing.path 并收起', async () => {
    const box = request('/srv')
    expect(chooseButton().disabled).toBe(true)
    await answer(listing('/srv', ['proj']))
    expect(chooseButton().disabled).toBe(false)

    await click('[data-web-dir-entry="proj"]')
    expect(chooseButton().disabled).toBe(true)
    await answer(listing('/srv/proj', []))
    expect(chooseButton().disabled).toBe(false)

    await click('[data-web-dir-choose]')
    expect(box.value).toBe('/srv/proj')
    expect($('[data-web-directory-picker]')).toBeNull()
    expect(currentDirectoryPick()).toBeNull()
  })
})

describe('DP-6 取消', () => {
  it('DP-6 取消按钮 → null', async () => {
    const box = request('/srv')
    await answer(listing('/srv', []))
    await click('[data-web-dir-cancel]')
    expect(box.value).toBeNull()
    expect($('[data-web-directory-picker]')).toBeNull()
  })

  it('DP-6 Esc → null', async () => {
    const box = request('/srv')
    await answer(listing('/srv', []))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flush()
    })
    expect(box.value).toBeNull()
    expect($('[data-web-directory-picker]')).toBeNull()
  })

  it('DP-6 在遮罩上按下 → null；在对话框里按下不取消', async () => {
    const box = request('/srv')
    await answer(listing('/srv', ['proj']))
    const dialog = must('[data-web-directory-picker]')
    await act(async () => {
      dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      must('[data-web-dir-entry="proj"]').dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true })
      )
      await flush()
    })
    expect(box.value).toBe('pending')
    expect($('[data-web-directory-picker]')).not.toBeNull()

    const backdrop = dialog.parentElement!
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await flush()
    })
    expect(box.value).toBeNull()
    expect($('[data-web-directory-picker]')).toBeNull()
  })
})

describe('DP-7 乱序的回包', () => {
  it('DP-7 先发 A 后发 B，先回 B 再回 A → 留下的是 B', async () => {
    request('/srv')
    await answer(listing('/srv', ['a', 'b']))

    await click('[data-web-dir-entry="a"]')
    const slowA = calls.length - 1
    await click('[data-web-dir-entry="b"]')
    const fastB = calls.length - 1
    expect(calls[slowA].params).toStrictEqual({ path: '/srv/a', showHidden: false })
    expect(calls[fastB].params).toStrictEqual({ path: '/srv/b', showHidden: false })

    await answer(listing('/srv/b', ['in-b']), fastB)
    expect(pathInput().value).toBe('/srv/b')
    expect(entryNames()).toStrictEqual(['in-b'])

    await answer(listing('/srv/a', ['in-a']), slowA)
    expect(pathInput().value).toBe('/srv/b')
    expect(entryNames()).toStrictEqual(['in-b'])
  })
})

describe('DP-8 请求本身失败', () => {
  it('DP-8 → [data-web-dir-error=request]，选择禁用；之后一次成功的跳转清掉它', async () => {
    request('/srv')
    await fail()
    const error = must('[data-web-dir-error]')
    expect(error.getAttribute('data-web-dir-error')).toBe('request')
    expect(error.textContent).toBe(W.pickFolderFailed)
    expect(chooseButton().disabled).toBe(true)

    await click('[data-web-dir-home]')
    await answer(listing('/home/u', ['Documents']))
    expect($('[data-web-dir-error]')).toBeNull()
    expect(entryNames()).toStrictEqual(['Documents'])
    expect(chooseButton().disabled).toBe(false)
  })

  it('DP-8 跳转途中失败：前一份列表还在也显示失败、选择禁用', async () => {
    request('/srv')
    await answer(listing('/srv', ['proj']))
    await click('[data-web-dir-entry="proj"]')
    await fail()
    expect(must('[data-web-dir-error]').getAttribute('data-web-dir-error')).toBe('request')
    expect(chooseButton().disabled).toBe(true)
  })

  it('DP-8 失败之后取消照用', async () => {
    const box = request('/srv')
    await fail()
    await click('[data-web-dir-cancel]')
    expect(box.value).toBeNull()
    expect($('[data-web-directory-picker]')).toBeNull()
  })
})

describe('DP-9 开着时又来一次', () => {
  it('DP-9 上一次以 null 结束；对话框重挂、按新起点重新请求', async () => {
    const first = request('/one')
    await answer(listing('/one', ['x']))
    expect(entryNames()).toStrictEqual(['x'])

    const second = request('/two')
    await act(async () => {
      await flush()
    })
    expect(first.value).toBeNull()
    expect(second.value).toBe('pending')
    expect(listDirectories).toHaveBeenCalledTimes(2)
    expect(lastParams()).toStrictEqual({ path: '/two', showHidden: false })
    // 重挂：上一份列表不在了，等新的回包
    expect(entryNames()).toStrictEqual([])

    await answer(listing('/two', ['y']))
    expect(entryNames()).toStrictEqual(['y'])
    expect(pathInput().value).toBe('/two')
  })
})
