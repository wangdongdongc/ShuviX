// @vitest-environment jsdom
/**
 * 改动会打穿提示词缓存时的确认（CacheBreakConfirm；jsdom）—— 锁住的 agent 换模型 / 扩展能力当场生效，
 * `confirmAgentChange` 先问主进程 `agent.previewChange`，保不住（`cache: 'lost'`）才问用户：
 *
 *   RU-1 没有 HostApi（渠道端）→ 直接 true，不预判
 *   RU-2 预判抛错 → true（照改），不出框
 *   RU-3 kept / none / 没有 agent（locked:false，cache none）→ true，不出框
 *   RU-4 lost 且挂着宿主 → 恰一个 `[data-cache-break-confirm]`，画在 body 上（portal，不在宿主的容器里），
 *        标题 cacheBreak.title；确认 → true、框消失；取消钮 / Esc / 点遮罩 → 退出动画走完后 false
 *   RU-5 lost 但一个宿主都没挂 → true，不出框
 *   RU-6 说明文字：原因按 model > tools > prompt 取一个；有上次请求的规模（promptTokens > 0）→ costTokens
 *        （千分位按 toLocaleString），没有 → cost
 *   RU-7 previewChange 收到的恰是 {sessionId, ...change}
 *   RU-8 两个宿主 → 一个框（后挂的画）；卸掉后挂的 → 仍在问（先挂的接着画）；最后一个也卸掉 → 按取消落定 false
 *   RU-9 前一问还没答又来一问 → 前一问按取消落定 false；只剩一个框，说的是后一问的原因
 *
 * CacheBreakConfirm 从 `../../api/chatApi` 取 HostApi（不经包入口），所以后端是 `window.api` 上的一个替身。
 * 确认框的 store 是模块级的：每个用例都把挂上的宿主卸干净（afterEach），问到一半的那一问随最后一个宿主落定。
 * ConfirmDialog 的取消 / Esc / 遮罩先走 120ms 的退出动画再回调，用真计时器等过去。i18n 走真 zh 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AgentChangePreview } from '@shuvix/chat-protocol/chatApi'
import { CacheBreakConfirmHost, confirmAgentChange } from '../CacheBreakConfirm'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 'sess-cache'

const previewChange = vi.fn<(params: Record<string, unknown>) => Promise<AgentChangePreview>>()

const preview = (over: Partial<AgentChangePreview> = {}): AgentChangePreview => ({
  locked: true,
  cache: 'lost',
  reasons: ['tools'],
  promptTokens: 0,
  ...over
})

/** 挂着的宿主（每个一个容器 + root），afterEach 一并卸掉 */
const mounted: { container: HTMLDivElement; root: Root }[] = []

async function mountHost(): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const entry = { container, root }
  mounted.push(entry)
  await act(async () => {
    root.render(createElement(CacheBreakConfirmHost))
  })
  return {
    container,
    unmount: async () => {
      const at = mounted.indexOf(entry)
      if (at < 0) return
      mounted.splice(at, 1)
      await act(async () => root.unmount())
      container.remove()
    }
  }
}

/** 发起一问，并让预判与随后的渲染落定 */
async function ask(
  change: Parameters<typeof confirmAgentChange>[1] = { enabledTools: ['mcp:x'] }
): Promise<{ result: Promise<boolean>; settled: () => boolean | undefined }> {
  let value: boolean | undefined
  let result!: Promise<boolean>
  await act(async () => {
    result = confirmAgentChange(SID, change)
    void result.then((v) => {
      value = v
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { result, settled: () => value }
}

const dialogs = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-cache-break-confirm]')
]
const dialog = (): HTMLElement => {
  const all = dialogs()
  expect(all).toHaveLength(1)
  return all[0]
}
const buttonText = (scope: ParentNode, text: string): HTMLButtonElement => {
  const hit = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text
  )
  if (!hit) throw new Error(`button ${text} not rendered`)
  return hit
}
const confirmButton = (): HTMLButtonElement => buttonText(dialog(), i18n.t('cacheBreak.confirm'))
const cancelButton = (): HTMLButtonElement => buttonText(dialog(), i18n.t('common.cancel'))

/** ConfirmDialog 的退出动画（useDialogClose 的 120ms）走完 */
async function finishAnimation(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
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
  previewChange.mockReset().mockResolvedValue(preview())
  ;(window as unknown as { api?: unknown }).api = { agent: { previewChange } }
})

afterEach(async () => {
  for (const entry of mounted.splice(0).reverse()) {
    await act(async () => entry.root.unmount())
    entry.container.remove()
  }
  delete (window as unknown as { api?: unknown }).api
  document.body.innerHTML = ''
})

describe('confirmAgentChange：什么时候不问', () => {
  it('RU-1 没有 HostApi（渠道端）→ true，不预判；挂着宿主也不出框', async () => {
    delete (window as unknown as { api?: unknown }).api
    await mountHost()
    const { result } = await ask()
    await expect(result).resolves.toBe(true)
    expect(previewChange).not.toHaveBeenCalled()
    expect(dialogs()).toHaveLength(0)
  })

  it('RU-2 预判抛错 → true，不出框', async () => {
    previewChange.mockRejectedValue(new Error('main is gone'))
    await mountHost()
    const { result } = await ask()
    await expect(result).resolves.toBe(true)
    expect(previewChange).toHaveBeenCalledTimes(1)
    expect(dialogs()).toHaveLength(0)
  })

  it.each<[string, AgentChangePreview]>([
    ['kept', preview({ cache: 'kept', reasons: [], promptTokens: 4000 })],
    ['none', preview({ cache: 'none', reasons: [] })],
    ['locked:false', { locked: false, cache: 'none', reasons: [], promptTokens: 0 }]
  ])('RU-3 预判 %s → true，不出框', async (_label, answer) => {
    previewChange.mockResolvedValue(answer)
    await mountHost()
    const { result } = await ask()
    await expect(result).resolves.toBe(true)
    expect(dialogs()).toHaveLength(0)
  })

  it('RU-5 lost 但没有宿主挂着 → true，不出框', async () => {
    const { result } = await ask()
    await expect(result).resolves.toBe(true)
    expect(previewChange).toHaveBeenCalledTimes(1)
    expect(dialogs()).toHaveLength(0)
  })

  it('RU-7 previewChange 收到的恰是 {sessionId, ...change}', async () => {
    previewChange.mockResolvedValue(preview({ cache: 'kept', reasons: [] }))
    await ask({ enabledTools: ['mcp:a', '-mcp:b'] })
    await ask({ provider: 'prov-1', model: 'model-b' })
    expect(previewChange.mock.calls).toEqual([
      [{ sessionId: SID, enabledTools: ['mcp:a', '-mcp:b'] }],
      [{ sessionId: SID, provider: 'prov-1', model: 'model-b' }]
    ])
  })
})

describe('lost：问用户', () => {
  it('RU-4 恰一个框，画在 body 上（不在宿主容器里），标题 cacheBreak.title；确认 → true、框消失', async () => {
    const host = await mountHost()
    const { result, settled } = await ask()
    const el = dialog()
    expect(el.parentElement).toBe(document.body)
    expect(host.container.contains(el)).toBe(false)
    expect(el.querySelector('h3')?.textContent).toBe(i18n.t('cacheBreak.title'))
    expect(i18n.t('cacheBreak.title')).not.toBe('cacheBreak.title')
    expect(settled()).toBeUndefined()

    await act(async () => {
      confirmButton().click()
    })
    await expect(result).resolves.toBe(true)
    expect(dialogs()).toHaveLength(0)
  })

  it.each<[string, () => void]>([
    ['取消钮', () => cancelButton().click()],
    [
      'Esc',
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    ],
    [
      '点遮罩',
      () =>
        dialog()
          .querySelector<HTMLElement>('.dialog-overlay')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ]
  ])('RU-4 %s → 退出动画走完后 false、框消失', async (_label, dismiss) => {
    await mountHost()
    const { result, settled } = await ask()
    await act(async () => {
      dismiss()
    })
    // 动画还在播：还没落定
    expect(settled()).toBeUndefined()
    await finishAnimation()
    await expect(result).resolves.toBe(false)
    expect(dialogs()).toHaveLength(0)
  })

  it('RU-6 原因按 model > tools > prompt 取一个；promptTokens > 0 → costTokens（千分位），0 → cost', async () => {
    await mountHost()
    const tokens = 123456
    const cases: [AgentChangePreview['reasons'], string][] = [
      [['prompt', 'tools', 'model'], 'cacheBreak.reasonModel'],
      [['prompt', 'tools'], 'cacheBreak.reasonTools'],
      [['prompt'], 'cacheBreak.reasonPrompt']
    ]
    const reasonKeys = cases.map(([, key]) => key)
    for (const [reasons, key] of cases) {
      previewChange.mockResolvedValue(preview({ reasons, promptTokens: tokens }))
      const { result } = await ask()
      const text = dialog().textContent ?? ''
      expect(text, key).toContain(i18n.t(key))
      for (const other of reasonKeys.filter((k) => k !== key)) {
        expect(text, `${key} vs ${other}`).not.toContain(i18n.t(other))
      }
      expect(text).toContain(i18n.t('cacheBreak.costTokens', { tokens: tokens.toLocaleString() }))
      await act(async () => {
        confirmButton().click()
      })
      await result
    }

    previewChange.mockResolvedValue(preview({ reasons: ['tools'], promptTokens: 0 }))
    const { result } = await ask()
    const text = dialog().textContent ?? ''
    expect(text).toContain(i18n.t('cacheBreak.cost'))
    expect(text).not.toContain(i18n.t('cacheBreak.costTokens', { tokens: '0' }))
    await act(async () => {
      confirmButton().click()
    })
    await result
  })
})

describe('两个宿主、两问', () => {
  it('RU-8 两个宿主 → 一个框；卸掉后挂的 → 先挂的接着画、仍在问；最后一个卸掉 → false', async () => {
    const a = await mountHost()
    const b = await mountHost()
    const { result, settled } = await ask()
    expect(dialogs()).toHaveLength(1)

    await b.unmount()
    expect(dialogs()).toHaveLength(1)
    expect(settled()).toBeUndefined()

    await a.unmount()
    await expect(result).resolves.toBe(false)
    expect(dialogs()).toHaveLength(0)
  })

  it('RU-8 先挂的那个画到一半被卸掉：后挂的还在 → 照样只有一个框，确认得了', async () => {
    const a = await mountHost()
    await mountHost()
    const { result } = await ask()
    await a.unmount()
    expect(dialogs()).toHaveLength(1)
    await act(async () => {
      confirmButton().click()
    })
    await expect(result).resolves.toBe(true)
  })

  it('RU-9 前一问没答又来一问 → 前一问 false；只剩一个框，说后一问的原因', async () => {
    await mountHost()
    previewChange.mockResolvedValueOnce(preview({ reasons: ['tools'] }))
    const first = await ask()
    expect(dialog().textContent).toContain(i18n.t('cacheBreak.reasonTools'))

    previewChange.mockResolvedValueOnce(preview({ reasons: ['model'] }))
    const second = await ask({ provider: 'p', model: 'm' })
    await expect(first.result).resolves.toBe(false)
    const text = dialog().textContent ?? ''
    expect(text).toContain(i18n.t('cacheBreak.reasonModel'))
    expect(text).not.toContain(i18n.t('cacheBreak.reasonTools'))
    expect(second.settled()).toBeUndefined()

    await act(async () => {
      confirmButton().click()
    })
    await expect(second.result).resolves.toBe(true)
  })
})
