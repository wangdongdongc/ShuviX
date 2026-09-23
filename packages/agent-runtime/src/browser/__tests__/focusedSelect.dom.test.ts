// @vitest-environment jsdom
/**
 * 「焦点是不是单选 <select>」的探针表达式 —— 放到真 DOM（jsdom）里跑（NG-U13）。
 *
 * cdpOps.test.ts 里 press_key / type 的拒绝用例把页面整个假掉了，探针的回答是用例拨的；表达式本身
 * （穿过 shadow root 与同源 iframe 找真正的焦点、单选 / 多选 / size 的判断）在那里一行都没执行过。
 * 它错了的代价两头都疼：误报 = 焦点在普通输入框里也按不了方向键；漏报 = 方向键落在 <select> 上，
 * 弹出原生下拉菜单（桌面端会卡住主进程数秒）。
 *
 * 表达式不导出：从 pressKeyOp 发出的那条 Runtime.evaluate 里取原文，交给 jsdom 的全局 eval ——
 * 测的就是真正交给页面的那一份。末尾一组用例让 pressKeyOp 端到端地对着 jsdom 跑一次。
 * 本文件在 jsdom 环境里跑（上面那行指令必须留在文件最顶端），而 node 的类型检查里没有 DOM lib，
 * 所以用到的那一点 DOM 按形状描述。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pressKeyOp } from '../cdpOps'
import type { TabCdpSession } from '../attachManager'

interface MiniElement {
  focus(): void
  attachShadow(init: { mode: 'open' | 'closed' }): { innerHTML: string } & MiniParent
  shadowRoot: (MiniParent & { activeElement: MiniElement | null }) | null
  contentDocument: MiniDocument | null
  tagName: string
  id: string
  value: string
}

interface MiniParent {
  getElementById?(id: string): MiniElement | null
  querySelector(sel: string): MiniElement | null
}

interface MiniDocument extends MiniParent {
  body: { innerHTML: string }
  activeElement: MiniElement | null
  readyState: string
}

const doc = (): MiniDocument => (globalThis as unknown as { document: MiniDocument }).document

const byId = (id: string): MiniElement => {
  const el = doc().querySelector(`#${id}`)
  if (!el) throw new Error(`fixture has no #${id}`)
  return el
}

/** 交给页面的那条表达式原文 */
let expression = ''

/** 在「页面」（jsdom 的全局）里求值探针 */
const probe = (): unknown => (0, eval)(expression)

/** 真的发出按键时会话抛的错 —— 用它截断按键之后的等待，同时证明按键走到了分发这一步 */
const KEY_DISPATCHED = 'key dispatched'

/** 一个把探针交给 jsdom 求值的假会话；别的命令回空，分发按键时抛 KEY_DISPATCHED */
function jsdomSession(sent: string[]): TabCdpSession {
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      sent.push(method)
      if (method === 'Runtime.evaluate' && String(params?.expression) === expression) {
        return { result: { value: probe() } }
      }
      if (method === 'Input.dispatchKeyEvent') throw new Error(KEY_DISPATCHED)
      return {}
    },
    eventCursor: () => 0,
    getEvents: () => ({ entries: [], nextSeq: 0 }),
    controller: { reset: () => {} }
  } as unknown as TabCdpSession
}

beforeAll(async () => {
  const session = {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate' && !expression) {
        expression = String(params?.expression)
        // 探针说是：op 以拒绝收尾，原文已经拿到
        return { result: { value: true } }
      }
      return {}
    }
  } as unknown as TabCdpSession
  const out = await pressKeyOp(session, 'ArrowDown')
  expect(out.details?.error).toMatch(/^Focus is on a <select>/)
  expect(expression).toContain("tagName === 'SELECT'")
})

beforeEach(() => {
  doc().body.innerHTML = `
    <select id="s"><option value="a">Apple</option><option value="b">Banana</option></select>
    <select id="s1" size="1"><option>One</option><option>Two</option></select>
    <select id="m" multiple><option>One</option><option>Two</option></select>
    <select id="s4" size="4"><option>One</option><option>Two</option></select>
    <input id="after" type="text">
    <div id="host"></div>
    <div id="deep-host"></div>
  `
  // 换掉 body 的内容就把原来的焦点元素移出了文档；保险起见再 blur 一次
  ;(doc().activeElement as unknown as { blur?: () => void } | null)?.blur?.()
})

describe('探针在真 DOM 里（NG-U13）', () => {
  it('环境自检：跑在有 document 的环境里，没有焦点时 activeElement 是 body', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('object')
    expect(doc().activeElement?.tagName).toBe('BODY')
  })

  it('没有焦点（body）：否', () => {
    expect(probe()).toBe(false)
  })

  it.each([
    ['plain single <select>', 's'],
    ['size="1" <select>', 's1']
  ])('%s 获得焦点：是', (_label, id) => {
    byId(id).focus()
    expect(doc().activeElement).toBe(byId(id))
    expect(probe()).toBe(true)
  })

  it.each([
    ['multiple <select>', 'm'],
    ['size="4" <select>（列表框，不弹菜单）', 's4'],
    ['文本输入框', 'after']
  ])('%s 获得焦点：否', (_label, id) => {
    byId(id).focus()
    expect(doc().activeElement).toBe(byId(id))
    expect(probe()).toBe(false)
  })

  it('open shadow root 里的单选 <select>：穿过 shadow root 认出来', () => {
    const root = byId('host').attachShadow({ mode: 'open' })
    root.innerHTML = '<select id="shadow-s"><option>X</option><option>Y</option></select>'
    const inner = root.querySelector('#shadow-s')!
    inner.focus()
    expect(doc().activeElement).toBe(byId('host'))
    expect(byId('host').shadowRoot?.activeElement).toBe(inner)
    expect(probe()).toBe(true)
  })

  it('shadow root 套 shadow root：一层层穿进去', () => {
    const outer = byId('deep-host').attachShadow({ mode: 'open' })
    outer.innerHTML = '<div id="inner-host"></div>'
    const innerHost = outer.querySelector('#inner-host')!
    const inner = innerHost.attachShadow({ mode: 'open' })
    inner.innerHTML = '<select id="deep-s"><option>X</option></select>'
    inner.querySelector('#deep-s')!.focus()
    expect(probe()).toBe(true)
  })

  it('open shadow root 里的文本框：否', () => {
    const root = byId('host').attachShadow({ mode: 'open' })
    root.innerHTML = '<input id="shadow-i">'
    root.querySelector('#shadow-i')!.focus()
    expect(probe()).toBe(false)
  })

  it('同源 iframe 里的单选 <select>：父文档的焦点落在 iframe 元素上，穿进 contentDocument 认出来', () => {
    doc().body.innerHTML += '<iframe id="frame"></iframe>'
    const frame = byId('frame')
    const inner = frame.contentDocument
    if (!inner) throw new Error('jsdom gave the iframe no contentDocument')
    inner.body.innerHTML = '<select id="fs"><option>A</option><option>B</option></select>'
    const select = inner.querySelector('#fs')!
    select.focus()
    frame.focus()
    expect(doc().activeElement).toBe(frame)
    expect(inner.activeElement).toBe(select)
    expect(probe()).toBe(true)
    // 同一个 iframe 里焦点换到文本框：否
    inner.body.innerHTML += '<input id="fi">'
    inner.querySelector('#fi')!.focus()
    expect(probe()).toBe(false)
  })

  it('pressKeyOp 端到端：焦点在单选 <select> 上时拒绝、只发了探针；焦点在文本框里时按键照发', async () => {
    byId('s').focus()
    const refusedSent: string[] = []
    const refused = await pressKeyOp(jsdomSession(refusedSent), 'ArrowDown')
    expect(refused.details?.error).toMatch(/^Focus is on a <select>, and pressing ArrowDown/)
    expect(refusedSent).toEqual(['Runtime.evaluate'])
    expect(byId('s').value).toBe('a')

    byId('after').focus()
    const sentKeys: string[] = []
    await expect(pressKeyOp(jsdomSession(sentKeys), 'ArrowDown')).rejects.toThrow(KEY_DISPATCHED)
    expect(sentKeys[0]).toBe('Runtime.evaluate')
    expect(sentKeys).toContain('Input.dispatchKeyEvent')
  })
})
