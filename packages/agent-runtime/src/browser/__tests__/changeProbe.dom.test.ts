// @vitest-environment jsdom
/**
 * 页面变动计数的探针表达式（cdpOps 的 CHANGE_PROBE）—— 放到真 DOM（jsdom）里跑（NC-D）。
 *
 * cdpOps.test.ts 里「页面没反应」的用例把计数整个假掉了，读数是用例拨的；表达式本身（哪些算变动、
 * 哪些不算）在那里一行都没执行过。它错了的代价两头都疼：该算的没算 = 页面明明有反应却告诉 agent
 * 「没变」；不该算的算了（把属性写回原值、动画循环里的 style）= 数字永远在涨，那句话永远说不出来。
 *
 * 表达式不导出：从 pressKeyOp 发出的那条 Runtime.evaluate 里取原文，交给 jsdom 的全局 eval ——
 * 测的就是真正交给页面的那一份。本文件在 jsdom 环境里跑（上面那行指令必须留在文件最顶端），
 * 而 node 的类型检查里没有 DOM lib，所以用到的那一点 DOM 按形状描述。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pressKeyOp } from '../cdpOps'
import type { TabCdpSession } from '../attachManager'

interface MiniNode {
  data: string
}

interface MiniElement {
  id: string
  style: Record<string, string>
  firstChild: MiniNode | null
  shadowRoot: MiniRoot | null
  setAttribute(name: string, value: string): void
  appendChild(child: MiniElement): void
  attachShadow(init: { mode: 'open' | 'closed' }): MiniRoot
  dispatchEvent(event: unknown): boolean
}

interface MiniRoot {
  innerHTML: string
  querySelector(sel: string): MiniElement | null
}

interface MiniDocument {
  body: MiniElement & { innerHTML: string }
  querySelector(sel: string): MiniElement | null
  createElement(tag: string): MiniElement
  dispatchEvent(event: unknown): boolean
}

interface MiniWindow {
  document: MiniDocument
  Event: new (type: string, init?: { bubbles?: boolean }) => unknown
  dispatchEvent(event: unknown): boolean
  __shuvixChanges?: unknown
}

const win = (): MiniWindow => globalThis as unknown as MiniWindow
const doc = (): MiniDocument => win().document

const byId = (id: string): MiniElement => {
  const el = doc().querySelector(`#${id}`)
  if (!el) throw new Error(`fixture has no #${id}`)
  return el
}

/** 交给页面的那条表达式原文 */
let expression = ''

/** 探针里 performance.now() 读到的时间：用例自己拨（同一个元素 200ms 内的 style 改动不算） */
let clock = 0

/** MutationObserver 的回调是微任务；让出一拍，排上的都跑完 */
const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0))

/** 在「页面」（jsdom 的全局）里读一次计数（先让排着的变动记录送达） */
async function read(): Promise<number> {
  await tick()
  const out = (0, eval)(expression) as { changes?: unknown }
  if (typeof out?.changes !== 'number') throw new Error('the probe returned no number')
  return out.changes
}

const fire = (target: { dispatchEvent(e: unknown): boolean }, type: string): void => {
  target.dispatchEvent(new (win().Event)(type, { bubbles: true }))
}

beforeAll(async () => {
  const session = {
    send: async (method: string, params?: Record<string, unknown>) => {
      const e = String(params?.expression)
      if (method === 'Runtime.evaluate' && e.includes('__shuvixChanges')) {
        expression ||= e
        // 原文已经拿到：让这次读「没有数字」，op 随后不再读
        return { result: { value: {} } }
      }
      // 「焦点是不是单选 <select>」探针：否，按键照发
      if (method === 'Runtime.evaluate') return { result: { value: false } }
      if (method === 'Input.dispatchKeyEvent') throw new Error('key dispatched')
      return {}
    },
    eventCursor: () => 0,
    duringAction: <T>(fn: () => Promise<T>) => fn(),
    takeDialogNotes: () => [],
    getEvents: () => ({ entries: [], nextSeq: 0 }),
    controller: { reset: () => {} }
  } as unknown as TabCdpSession
  await expect(pressKeyOp(session, 'Enter')).rejects.toThrow('key dispatched')
  expect(expression).toContain('MutationObserver')
})

beforeEach(async () => {
  // 上一个用例排着的变动记录先送达，再换一份全新的计数（属性是 configurable 的，删得掉）
  await tick()
  delete win().__shuvixChanges
  clock = 1_000_000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  doc().body.innerHTML = `
    <div id="box" class="a">text</div>
    <div id="other"></div>
    <input id="field" type="text">
    <div id="host"></div>
  `
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('页面变动计数的探针在真 DOM 里（NC-D）', () => {
  it('NC-D1 页面什么都没做：两次读数相同（第一次的扫描本身不算）；计数挂在 window 上、不可枚举', async () => {
    const first = await read()
    expect(await read()).toBe(first)
    expect(await read()).toBe(first)
    expect(win().__shuvixChanges).toBeDefined()
    expect(Object.keys(win())).not.toContain('__shuvixChanges')
  })

  it.each<[string, () => void]>([
    ['加了一个子节点', () => byId('other').appendChild(doc().createElement('span'))],
    ['文本节点的文字变了', () => (byId('box').firstChild!.data = 'changed')],
    ['属性换了新值', () => byId('box').setAttribute('class', 'b')],
    ['新加了一个属性', () => byId('box').setAttribute('aria-expanded', 'true')],
    ['input 事件', () => fire(byId('field'), 'input')],
    ['change 事件', () => fire(byId('field'), 'change')],
    ['focusin 事件', () => fire(byId('field'), 'focusin')],
    ['focusout 事件', () => fire(byId('field'), 'focusout')],
    [
      '元素上的 scroll（不冒泡，靠捕获）',
      () => byId('box').dispatchEvent(new (win().Event)('scroll'))
    ],
    ['window 上的 scroll', () => fire(win(), 'scroll')],
    ['selectionchange', () => fire(doc(), 'selectionchange')]
  ])('NC-D2 %s → 读数变大', async (_label, act) => {
    const before = await read()
    act()
    expect(await read()).toBeGreaterThan(before)
  })

  it('NC-D3 把属性写回原值不算；换成别的值才算', async () => {
    const before = await read()
    byId('box').setAttribute('class', 'a')
    expect(await read()).toBe(before)
    byId('box').setAttribute('class', 'b')
    expect(await read()).toBeGreaterThan(before)
  })

  it('NC-D4 一个元素的第一次 style 改动算；同一个元素 200ms 内接着改的不算；过了 200ms 又算', async () => {
    const box = byId('box')
    const start = await read()
    box.style.display = 'block'
    const afterFirst = await read()
    expect(afterFirst).toBeGreaterThan(start)

    // 动画循环：同一个元素接着改
    clock += 50
    box.style.left = '1px'
    expect(await read()).toBe(afterFirst)
    clock += 50
    box.style.left = '2px'
    expect(await read()).toBe(afterFirst)

    // 另一个元素的第一次 style 改动，哪怕在同一段时间里，照算
    byId('other').style.display = 'none'
    const afterOther = await read()
    expect(afterOther).toBeGreaterThan(afterFirst)

    // 距上一次 style 改动超过 200ms：又算
    clock += 250
    box.style.left = '3px'
    expect(await read()).toBeGreaterThan(afterOther)
  })

  it('NC-D4 同一批记录里既有被忽略的 style 改动、又有真变动 → 只记一笔', async () => {
    const box = byId('box')
    box.style.display = 'block'
    const before = await read()
    clock += 50
    box.style.left = '1px'
    byId('other').appendChild(doc().createElement('span'))
    expect(await read()).toBe(before + 1)
  })

  it('NC-D5 之后才出现的 open shadow root 本身算一次变动；它里面的变动也看得到；不重复记', async () => {
    const before = await read()
    const root = byId('host').attachShadow({ mode: 'open' })
    const seen = await read()
    expect(seen).toBeGreaterThan(before)
    // 已经认识的 root：再读不再涨
    expect(await read()).toBe(seen)

    root.innerHTML = '<span id="inner">x</span>'
    const inside = await read()
    expect(inside).toBeGreaterThan(seen)
    expect(await read()).toBe(inside)
  })

  it('NC-D5 第一次读时就在的 shadow root：不算变动，但里面之后的变动看得到', async () => {
    const root = byId('host').attachShadow({ mode: 'open' })
    root.innerHTML = '<span id="inner">x</span>'
    await tick()
    const first = await read()
    expect(await read()).toBe(first)
    root.querySelector('#inner')!.setAttribute('class', 'on')
    expect(await read()).toBeGreaterThan(first)
  })
})
