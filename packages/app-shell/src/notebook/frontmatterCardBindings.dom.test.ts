// @vitest-environment jsdom
/**
 * 属性卡上 bot 的触发绑定行（`shuvix-bot-on`，描述符 kind `hookBindings`，2026-10-24；jsdom + 真 EditorView）。
 *
 * 与 hook 的 `shuvix-hook-on` 同一种只读摘要：每条绑定一行 = 埋点 id 徽章 + 「when  ·  message: …」。
 *   FB-1 bot 卡的 `shuvix-bot-on` 行：块状行（标签 settings.botOn 在上），每条绑定一枚埋点徽章（timer.fired），
 *        摘要 = `<when>  ·  message: <message>`；顺序照文件
 *   FB-2 没写 when → 摘要只有 `message: …`；值不是列表 → 退回标量渲染（普通行、原样文字、没有徽章）
 *
 * jsdom 没有布局：CM6 量尺寸要的 Range#getClientRects / getBoundingClientRect 在这里补成空矩形（同
 * frontmatterCardMeta.dom.test.ts）。焦点镜像初值为 false，视图一建好就是折叠态的卡，字段行照样渲染。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { frontmatterCard } from './frontmatterCard'

beforeAll(() => {
  const emptyRect = (): DOMRect =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({})
    }) as DOMRect
  const proto = Range.prototype as unknown as {
    getClientRects?: () => DOMRectList
    getBoundingClientRect?: () => DOMRect
  }
  if (!proto.getClientRects) {
    proto.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: [][Symbol.iterator]
      }) as unknown as DOMRectList
  }
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = emptyRect
})

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) {
    if (view.dom.isConnected) view.destroy()
  }
  document.body.innerHTML = ''
})

/** 建视图（挂进 document）；t 原样回键，标签文字即 labelKey */
function makeView(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [frontmatterCard({ t: (key) => key })] })
  })
  views.push(view)
  return view
}

const botDoc = (bindingLines: string[]): string =>
  [
    '---',
    'shuvix: bot v2',
    'name: ticker',
    'shuvix-displayName: Ticker',
    ...bindingLines,
    '---',
    '',
    '## Who I am',
    ''
  ].join('\n')

const botOnRow = (view: EditorView): HTMLElement => {
  const row = view.dom.querySelector<HTMLElement>('.cm-shuvix-fmcard-row[data-key="shuvix-bot-on"]')
  if (!row) throw new Error('shuvix-bot-on row not rendered')
  return row
}
const bindingLines = (row: HTMLElement): HTMLElement[] => [
  ...row.querySelectorAll<HTMLElement>('.cm-shuvix-fmcard-rule')
]
const badgeOf = (line: HTMLElement): string | null =>
  line.querySelector('.cm-shuvix-fmcard-trigger')?.textContent ?? null
const summaryOf = (line: HTMLElement): string | null =>
  line.querySelector('.cm-shuvix-fmcard-rule-text')?.textContent ?? null

describe('属性卡 —— bot 的触发绑定行', () => {
  it('FB-1 shuvix-bot-on → 块状行（标签 settings.botOn），timer.fired 徽章 + 「<when>  ·  message: <message>」', () => {
    const view = makeView(
      botDoc([
        'shuvix-bot-on:',
        '  - trigger: timer.fired',
        "    when: event.local.time == '18:00' && activeSessions(event.local.date) > 0",
        '    message: Go through the sessions since the last run.'
      ])
    )
    expect(view.dom.querySelector('.cm-shuvix-fmcard')).not.toBeNull()
    const row = botOnRow(view)
    expect(row.classList.contains('is-block')).toBe(true)
    expect(row.querySelector('.cm-shuvix-fmcard-label')?.textContent).toBe('settings.botOn')
    const lines = bindingLines(row)
    expect(lines).toHaveLength(1)
    expect(badgeOf(lines[0])).toBe('timer.fired')
    expect(summaryOf(lines[0])).toBe(
      "event.local.time == '18:00' && activeSessions(event.local.date) > 0  ·  message: Go through the sessions since the last run."
    )
  })

  it('FB-1 两条绑定按文件顺序各一行', () => {
    const view = makeView(
      botDoc([
        'shuvix-bot-on:',
        '  - trigger: timer.fired',
        "    when: event.local.time == '09:00'",
        '    message: Morning.',
        '  - trigger: webhook.received',
        '    message: Hook.'
      ])
    )
    const lines = bindingLines(botOnRow(view))
    expect(lines.map(badgeOf)).toEqual(['timer.fired', 'webhook.received'])
    expect(lines.map(summaryOf)).toEqual([
      "event.local.time == '09:00'  ·  message: Morning.",
      'message: Hook.'
    ])
  })

  it('FB-2 没写 when → 摘要只有「message: …」', () => {
    const view = makeView(
      botDoc(['shuvix-bot-on:', '  - trigger: timer.fired', '    message: Tick check-in.'])
    )
    const lines = bindingLines(botOnRow(view))
    expect(lines).toHaveLength(1)
    expect(badgeOf(lines[0])).toBe('timer.fired')
    expect(summaryOf(lines[0])).toBe('message: Tick check-in.')
  })

  it('FB-2 值不是列表 → 退回标量渲染：普通行、原样文字、没有徽章', () => {
    const view = makeView(botDoc(['shuvix-bot-on: oops']))
    const row = botOnRow(view)
    expect(row.classList.contains('is-block')).toBe(false)
    expect(row.querySelector('.cm-shuvix-fmcard-trigger')).toBeNull()
    expect(bindingLines(row)).toHaveLength(0)
    expect(row.querySelector('.cm-shuvix-fmcard-value')?.textContent).toBe('oops')
  })
})
