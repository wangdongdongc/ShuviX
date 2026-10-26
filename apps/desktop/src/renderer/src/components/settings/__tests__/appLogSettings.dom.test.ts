// @vitest-environment jsdom
/**
 * 设置 → 监视器 → 应用日志（AppLogSettings）：main.log 的尾部，只读。
 *
 *   APL-1 打开：不带游标读一次；每条一行（级别进 data-level、标签与正文显示）；路径在说明行；
 *         续行（堆栈）收起成「另 N 行」，点开才显示
 *   APL-2 跟随：每 APP_LOG_FOLLOW_MS 带着上次的游标读；新增的条接在后面，开头的续行归到原来最后一条；
 *         暂停后不再读；reset 的结果整个替换
 *   APL-3 筛选：级别「错误」只剩 error、「警告及以上」是 warn + error；搜索对正文 / 标签 / 续行不分大小写；
 *         都不中 → noMatch
 *   APL-4 文件不在 → missing；读失败 → readFailed（带原因）；truncated → 截断说明
 *   APL-5 复制显示的记录 = 筛选后各条的原文按行拼起来；复制路径；在文件夹中显示调 app.revealPath(路径)；
 *         web 客户端没有「在文件夹中显示」
 *   APL-6 跟随的那一次还在途时点刷新：照样整个重读；在途那次晚回来的结果作废（不把旧游标之后的行再接一遍）
 *
 * ZenSelect 换成原生 select（它自己有测试）。i18n 走真 zh 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AppLogCursor, AppLogTail } from '../../../../../shared/appLog'

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn<(text: string) => void>(),
  web: false
}))
vi.mock('@shuvix/chat-ui', () => ({ copyToClipboard: mocks.copyToClipboard }))
vi.mock('../../../host/hostMedia', () => ({
  get isWebHost() {
    return mocks.web
  }
}))
vi.mock('../../common/ZenSelect', async () => {
  const { createElement: h } = await import('react')
  return {
    ZenSelect: ({
      value,
      onChange,
      options,
      placeholder
    }: {
      value: string
      onChange: (v: string) => void
      options: Array<{ value: string; label: string }>
      placeholder?: string
    }) =>
      h(
        'select',
        {
          'data-level-select': '',
          value,
          onChange: (e: { target: { value: string } }) => onChange(e.target.value)
        },
        h('option', { value: '' }, placeholder),
        ...options.map((o) => h('option', { key: o.value, value: o.value }, o.label))
      )
  }
})

import { AppLogSettings, APP_LOG_FOLLOW_MS } from '../AppLogSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PATH = '/Users/someone/Library/Logs/ShuviX/main.log'
const TEXT = [
  '[2026-10-25 07:38:27.001] [info]  (Perf)   app ready',
  '[2026-10-25 07:38:27.002] [warn]  (MCP)    server slow',
  '[2026-10-25 07:38:27.003] [error] (App)    boom',
  '    at readdirSync (node:fs:1590:26)',
  '    at Skill.scan (skill.ts:1:1)',
  ''
].join('\n')

const tailOf = (over: Partial<AppLogTail> = {}): AppLogTail => ({
  path: PATH,
  fileId: '1:42',
  start: 0,
  end: TEXT.length,
  text: TEXT,
  reset: true,
  truncated: false,
  ...over
})

const api = {
  appLog: { tail: vi.fn<(cursor?: AppLogCursor | null) => Promise<AppLogTail>>() },
  app: { revealPath: vi.fn<(path: string) => Promise<{ success: boolean }>>() }
}

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(AppLogSettings))
  })
  await flush()
}

async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

async function tick(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(APP_LOG_FOLLOW_MS)
  })
  await flush()
}

const entries = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-app-log-entry]')
]
const levels = (): string[] => entries().map((el) => el.getAttribute('data-level') ?? '')

async function setLevel(value: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>('[data-level-select]')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function search(text: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('[data-app-log-search]')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
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
  vi.useFakeTimers()
  mocks.copyToClipboard.mockReset()
  mocks.web = false
  api.appLog.tail.mockReset()
  api.appLog.tail.mockResolvedValue(tailOf())
  api.app.revealPath.mockReset()
  api.app.revealPath.mockResolvedValue({ success: true })
  ;(window as unknown as { api: typeof api }).api = api
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

describe('AppLogSettings', () => {
  it('APL-1 打开：读尾部、逐条显示、续行收起', async () => {
    await mount()
    expect(api.appLog.tail).toHaveBeenCalledExactlyOnceWith(null)
    expect(levels()).toEqual(['info', 'warn', 'error'])
    expect(entries()[1].textContent).toContain('MCP')
    expect(entries()[1].textContent).toContain('server slow')
    expect(container.querySelector('[data-app-log-path]')?.textContent).toBe(PATH)

    const error = entries()[2]
    expect(error.querySelector('pre')).toBeNull()
    const more = error.querySelector('[data-app-log-more]')
    expect(more?.textContent).toBe(i18n.t('settings.appLog.moreLines', { count: 2 }))
    await click(more)
    expect(error.querySelector('pre')?.textContent).toBe(
      '    at readdirSync (node:fs:1590:26)\n    at Skill.scan (skill.ts:1:1)'
    )
  })

  it('APL-2 跟随：带游标读新增、续行归上一条；暂停后不读；reset 整个替换', async () => {
    await mount()
    const appended = '    at more (x.ts:2:2)\n[2026-10-25 07:38:29.000] [info]  later\n'
    api.appLog.tail.mockResolvedValueOnce(
      tailOf({
        start: TEXT.length,
        end: TEXT.length + appended.length,
        text: appended,
        reset: false
      })
    )
    await tick()
    expect(api.appLog.tail).toHaveBeenLastCalledWith({ fileId: '1:42', offset: TEXT.length })
    expect(levels()).toEqual(['info', 'warn', 'error', 'info'])
    expect(entries()[2].querySelector('[data-app-log-more]')?.textContent).toBe(
      i18n.t('settings.appLog.moreLines', { count: 3 })
    )

    // 下一次：游标跟着 end 走
    api.appLog.tail.mockResolvedValueOnce(
      tailOf({ start: 0, end: 10, text: '[2026-10-25 08:00:00.000] [warn]  rotated\n' })
    )
    await tick()
    expect(api.appLog.tail).toHaveBeenLastCalledWith({
      fileId: '1:42',
      offset: TEXT.length + appended.length
    })
    expect(levels()).toEqual(['warn'])

    const follow = container.querySelector('[data-app-log-follow]')!
    expect(follow.getAttribute('aria-pressed')).toBe('true')
    await click(follow)
    expect(follow.getAttribute('aria-pressed')).toBe('false')
    const calls = api.appLog.tail.mock.calls.length
    await tick()
    await tick()
    expect(api.appLog.tail.mock.calls.length).toBe(calls)
  })

  it('APL-3 级别与搜索', async () => {
    await mount()
    await setLevel('error')
    expect(levels()).toEqual(['error'])
    await setLevel('warn')
    expect(levels()).toEqual(['warn', 'error'])
    await setLevel('')
    await search('mcp')
    expect(levels()).toEqual(['warn'])
    await search('READDIRSYNC')
    expect(levels()).toEqual(['error'])
    await search('nothing like this')
    expect(entries()).toEqual([])
    expect(container.textContent).toContain(i18n.t('settings.appLog.noMatch'))
  })

  it('APL-4 文件不在 / 读失败 / 截断', async () => {
    api.appLog.tail.mockResolvedValueOnce(tailOf({ fileId: '', end: 0, text: '' }))
    await mount()
    expect(container.textContent).toContain(i18n.t('settings.appLog.missing'))

    api.appLog.tail.mockRejectedValueOnce(new Error('denied by policy'))
    await click(container.querySelector('[data-app-log-refresh]'))
    expect(container.textContent).toContain(
      i18n.t('settings.appLog.readFailed', { message: 'denied by policy' })
    )

    api.appLog.tail.mockResolvedValueOnce(tailOf({ truncated: true, start: 900 }))
    await click(container.querySelector('[data-app-log-refresh]'))
    expect(container.querySelector('[data-app-log-limit]')?.textContent).toBe(
      i18n.t('settings.appLog.truncated', { size: '512 KB' })
    )
    expect(levels()).toEqual(['info', 'warn', 'error'])
  })

  it('APL-5 复制显示的记录、复制路径、在文件夹中显示；web 客户端没有后者', async () => {
    await mount()
    await setLevel('warn')
    await click(container.querySelector('[data-app-log-copy]'))
    expect(mocks.copyToClipboard).toHaveBeenLastCalledWith(
      [
        '[2026-10-25 07:38:27.002] [warn] (MCP) server slow',
        '[2026-10-25 07:38:27.003] [error] (App) boom',
        '    at readdirSync (node:fs:1590:26)',
        '    at Skill.scan (skill.ts:1:1)'
      ].join('\n')
    )
    await click(container.querySelector('[data-app-log-copy-path]'))
    expect(mocks.copyToClipboard).toHaveBeenLastCalledWith(PATH)
    await click(container.querySelector('[data-app-log-reveal]'))
    expect(api.app.revealPath).toHaveBeenCalledExactlyOnceWith(PATH)

    act(() => root.unmount())
    root = createRoot(container)
    mocks.web = true
    await mount()
    expect(container.querySelector('[data-app-log-path]')?.textContent).toBe(PATH)
    expect(container.querySelector('[data-app-log-reveal]')).toBeNull()
  })

  it('APL-6 跟随在途时点刷新：整个重读，晚回来的增量作废', async () => {
    await mount()
    let releasePoll: (tail: AppLogTail) => void = () => undefined
    api.appLog.tail.mockImplementationOnce(
      () => new Promise<AppLogTail>((resolve) => (releasePoll = resolve))
    )
    await tick()
    expect(api.appLog.tail).toHaveBeenLastCalledWith({ fileId: '1:42', offset: TEXT.length })

    const fresh = '[2026-10-25 09:00:00.000] [info]  after refresh\n'
    api.appLog.tail.mockResolvedValueOnce(tailOf({ end: fresh.length, text: fresh }))
    await click(container.querySelector('[data-app-log-refresh]'))
    expect(api.appLog.tail).toHaveBeenLastCalledWith(null)
    expect(entries().map((el) => el.textContent)).toEqual([
      expect.stringContaining('after refresh')
    ])

    await act(async () => {
      releasePoll(
        tailOf({
          start: TEXT.length,
          end: TEXT.length + 50,
          text: '[2026-10-25 07:38:30.000] [warn]  stale\n',
          reset: false
        })
      )
    })
    await flush()
    expect(levels()).toEqual(['info'])
    // 下一次跟随接着整个重读之后的游标
    api.appLog.tail.mockResolvedValueOnce(
      tailOf({ start: fresh.length, end: fresh.length, text: '', reset: false })
    )
    await tick()
    expect(api.appLog.tail).toHaveBeenLastCalledWith({ fileId: '1:42', offset: fresh.length })
  })
})
