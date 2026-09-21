// @vitest-environment jsdom
/**
 * TokenChip 组件 DOM 测试（jsdom）：
 *   - 气泡变体：图标 + 本地化源标签 + `·` + 标题；`data-token-display` 锚点逐字等于 displayText
 *     （气泡新增图标/标签后 textContent 已不等于 displayText，e2e tokenBadges 改读该锚点）；
 *   - 镜像变体（零布局约束）：无图标，at 知识拆两段 span，拼接后与底层原始子串逐字一致；
 *   - 悬停预览卡：~300ms 浮出（标题 + 源标签 + 来源路径 + payload 预览），移出即关、卡上可驻留，
 *     点击仍弹完整 TokenPayloadDialog。
 * i18n 走真 zh 资源，验证源标签本地化接线（en/ja 键存在性由 JSON 结构保证）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { TokenChip } from '../TokenChip'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CMD_TOKEN: InlineToken = {
  type: 'cmd',
  id: 'review',
  displayText: '/review',
  payload: '请 review 以下改动\n第一行\n第二行\n第三行\n第四行',
  name: '代码评审'
}

const KNOWLEDGE_TOKEN: InlineToken = {
  type: 'at',
  id: 'knowledge:knowledge/kb-b/token-refresh.md',
  displayText: 'knowledge:Token 刷新 (kb-b)',
  payload: '[knowledge entry: base kb-b, path /token-refresh.md — Token 刷新]',
  name: 'Token 刷新'
}

const PASTE_TOKEN: InlineToken = {
  type: 'paste',
  id: 'paste-1',
  displayText: '[粘贴文本 #1 · 45 行]',
  payload: '粘贴正文第一行\n粘贴正文第二行',
  name: '粘贴文本 #1'
}

let container: HTMLDivElement
let root: Root

function renderChip(token: InlineToken, inline = false): HTMLSpanElement {
  act(() => {
    root.render(createElement(TokenChip, { token, inline }))
  })
  return container.querySelector('span[role="button"]') as HTMLSpanElement
}

/** React 的 enter/leave 合成自 mouseover/mouseout */
function enter(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
}
function leave(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  })
}

function hoverCard(): HTMLDivElement | null {
  return document.body.querySelector('div.fixed.z-40')
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } }
  })
})

beforeEach(() => {
  vi.useFakeTimers()
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

describe('气泡变体 —— 类型分色 + 图标 + 本地化源标签', () => {
  it('cmd：图标 + 源标签「命令」+ `·` + 标题，锚点逐字等于 displayText', () => {
    const chip = renderChip(CMD_TOKEN)
    expect(chip.querySelector('svg')).toBeTruthy()
    expect(chip.dataset.tokenDisplay).toBe('/review')
    expect(chip.textContent).toContain('命令')
    expect(chip.textContent).toContain('·')
    expect(chip.textContent).toContain('/review')
    // 标题优先取 token.name 之外的 displayText 解析——cmd 标题即 displayText
    expect(chip.textContent).not.toContain('代码评审')
  })

  it('at 知识：源标签「知识库」，标题去 knowledge: 前缀、消歧后缀保留', () => {
    const chip = renderChip(KNOWLEDGE_TOKEN)
    expect(chip.dataset.tokenDisplay).toBe('knowledge:Token 刷新 (kb-b)')
    expect(chip.textContent).toContain('知识库')
    expect(chip.textContent).toContain('Token 刷新 (kb-b)')
    expect(chip.textContent).not.toContain('knowledge:Token')
  })
})

describe('镜像变体 —— 零布局约束', () => {
  it('无图标、无额外字符；cmd 整段一个文本节点', () => {
    const chip = renderChip(CMD_TOKEN, true)
    expect(chip.querySelector('svg')).toBeNull()
    expect(chip.textContent).toBe('/review')
  })

  it('at 知识拆两段 span：前缀 `@knowledge:` 弱化、标题着色，拼接逐字一致', () => {
    // 镜像层会把 displayText 覆写为底层原始子串（含前导 @）
    const raw = '@knowledge:Token 刷新 (kb-b)'
    const chip = renderChip({ ...KNOWLEDGE_TOKEN, displayText: raw }, true)
    expect(chip.querySelector('svg')).toBeNull()
    const spans = chip.querySelectorAll(':scope > span')
    expect(spans.length).toBe(2)
    expect(spans[0].textContent).toBe('@knowledge:')
    expect(spans[1].textContent).toBe('Token 刷新 (kb-b)')
    expect(chip.textContent).toBe(raw)
  })
})

describe('悬停预览卡', () => {
  it('悬停 ~300ms 浮出：标题 + 源标签 + 来源路径 + payload 前 3 行截断；移出即关', () => {
    const chip = renderChip(CMD_TOKEN)
    enter(chip)
    // 300ms 前不出卡
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(hoverCard()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(150)
    })
    const card = hoverCard()
    expect(card).toBeTruthy()
    expect(card!.textContent).toContain('代码评审') // 标题取 token.name
    expect(card!.textContent).toContain('命令')
    expect(card!.textContent).toContain('review') // 来源路径 = 命令 id
    expect(card!.textContent).toContain('第二行')
    expect(card!.textContent).not.toContain('第三行') // 只取前 3 行
    expect(card!.textContent).toContain('…')
    leave(chip)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(hoverCard()).toBeNull()
  })

  it('镜像层胶囊同样出卡（portal 到 body，内容一致）', () => {
    const chip = renderChip(KNOWLEDGE_TOKEN, true)
    enter(chip)
    act(() => {
      vi.advanceTimersByTime(350)
    })
    const card = hoverCard()
    expect(card).toBeTruthy()
    expect(card!.textContent).toContain('知识库')
    expect(card!.textContent).toContain('knowledge/kb-b/token-refresh.md') // 条目 id
  })

  it('paste 无来源路径行', () => {
    const chip = renderChip(PASTE_TOKEN)
    enter(chip)
    act(() => {
      vi.advanceTimersByTime(350)
    })
    const card = hoverCard()
    expect(card).toBeTruthy()
    expect(card!.textContent).toContain('粘贴文本 #1')
    expect(card!.querySelector('.font-mono.text-\\[11px\\].text-text-tertiary')).toBeNull()
  })

  it('鼠标移入卡上可驻留，移出卡片才关', () => {
    const chip = renderChip(CMD_TOKEN)
    enter(chip)
    act(() => {
      vi.advanceTimersByTime(350)
    })
    const card = hoverCard()!
    leave(chip) // 离开胶囊、进入卡片
    enter(card)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(hoverCard()).toBeTruthy()
    leave(card)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(hoverCard()).toBeNull()
  })

  it('点击关卡并弹完整 TokenPayloadDialog', () => {
    const chip = renderChip(CMD_TOKEN)
    enter(chip)
    act(() => {
      vi.advanceTimersByTime(350)
    })
    expect(hoverCard()).toBeTruthy()
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(hoverCard()).toBeNull()
    const dialog = document.body.querySelector('.dialog-panel')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain('第四行') // 完整 payload，非 3 行截断
  })
})
