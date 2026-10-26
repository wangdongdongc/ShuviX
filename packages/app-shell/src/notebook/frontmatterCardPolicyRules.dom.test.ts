// @vitest-environment jsdom
/**
 * 属性卡上策略的规则行（`shuvix-policy-rules`，描述符 kind `policyRules`；jsdom + 真 EditorView）。
 *
 *   FP-1 每条规则一行：效力徽章 + 条件串（+ match）；处置（自动脱敏的 detect / redact）是效力旁的一枚小签，
 *        不进条件串；没有处置的规则没有这枚小签
 *
 * 搭架子同 frontmatterCardBindings.dom.test.ts（jsdom 补空矩形、t 原样回键）。
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

const policyDoc = [
  '---',
  'shuvix: policy v1',
  'name: redact-sensitive',
  'shuvix-policy-rules:',
  '  - effect: allow',
  '    subject.kind: [agent]',
  '    action: [send]',
  '    object.type: [modelRequest]',
  '    disposition: detect',
  '  - effect: deny',
  '    subject.kind: [agent]',
  '    action: [disclose]',
  '    object.type: [sensitive]',
  '    match: "object.category == \'PRIVATE_KEY\'"',
  '---',
  '',
  'Body.'
].join('\n')

describe('属性卡 —— 策略的规则行', () => {
  it('FP-1 处置是效力旁的一枚小签，不进条件串', () => {
    const view = makeView(policyDoc)
    const rules = [...view.dom.querySelectorAll<HTMLElement>('.cm-shuvix-fmcard-rule')]
    expect(rules).toHaveLength(2)
    const [first, second] = rules
    expect(first!.querySelector('.cm-shuvix-fmcard-effect')?.textContent).toBe('allow')
    expect(
      first!.querySelector<HTMLElement>('.cm-shuvix-fmcard-disposition')?.dataset.disposition
    ).toBe('detect')
    const text = first!.querySelector('.cm-shuvix-fmcard-rule-text')?.textContent ?? ''
    expect(text).toContain('modelRequest')
    expect(text).not.toContain('disposition')
    expect(second!.querySelector('.cm-shuvix-fmcard-disposition')).toBeNull()
    expect(second!.querySelector('.cm-shuvix-fmcard-rule-text')?.textContent).toContain(
      "object.category == 'PRIVATE_KEY'"
    )
  })
})
