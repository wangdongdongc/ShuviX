// @vitest-environment jsdom
/**
 * upload_file 在页面里找 `<input type=file>` 的那个函数 —— 放到真 DOM（jsdom）里跑。
 *
 * cdpOps.test.ts 里那组用例把页面整个假掉了，只看命令顺序；这个函数本身（label 的 control、
 * 选择器、文本节点取父元素）在那里一行都没执行过。它错了的代价是：样式化的上传按钮
 * （原生 input 藏在里面、AX 树里看不到）一个都传不上，而单测照样全绿。
 *
 * 函数不导出，从 uploadFileOp 发出的那条 Runtime.callFunctionOn 里取出原文 —— 测的就是
 * 真正交给页面的那一份。本文件在 jsdom 环境里跑（上面那行指令必须留在文件最顶端），
 * 而 node 的类型检查里没有 DOM lib，所以用到的那一点 DOM 按形状描述。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uploadFileOp } from '../cdpOps'
import type { TabCdpSession } from '../attachManager'

interface MiniNode {
  nodeType: number
  firstChild: MiniNode | null
}

interface MiniDocument {
  body: { innerHTML: string }
  getElementById(id: string): MiniNode | null
}

const doc = (): MiniDocument => (globalThis as unknown as { document: MiniDocument }).document

const byId = (id: string): MiniNode => {
  const node = doc().getElementById(id)
  if (!node) throw new Error(`fixture has no #${id}`)
  return node
}

/** 交给页面的那个函数，this = uid 指向的节点 */
let locate: (node: MiniNode) => unknown

beforeAll(async () => {
  let declaration = ''
  const session = {
    controller: {
      getNode: () => undefined,
      resolveElement: async (uid: string) => ({
        uid,
        backendNodeId: 1,
        objectId: 'o1',
        relocated: false
      }),
      release: async () => {}
    },
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.callFunctionOn' && params?.returnByValue === false) {
        declaration = String(params.functionDeclaration)
      }
      // 没找到 input：op 以业务错误收尾，函数原文已经拿到
      return { result: {} }
    }
  } as unknown as TabCdpSession
  await uploadFileOp(session, 'e1', ['/tmp/a.txt'])
  expect(declaration).toMatch(/^function\s*\(/)
  const fn = new Function(`return (${declaration})`)() as (this: MiniNode) => unknown
  locate = (node) => fn.call(node)
})

beforeEach(() => {
  doc().body.innerHTML = `
    <input type="file" id="plain">
    <label id="for-label" for="hidden-input">Choose a file</label>
    <input type="file" id="hidden-input" hidden>
    <label id="wrap-label">Attach <input type="file" id="wrapped"></label>
    <div id="dropzone" role="button"><span>Drop files here</span><input type="text" id="caption"><input type="file" id="inner" hidden></div>
    <div id="two-inputs"><input type="file"><input type="file"></div>
    <input type="text" id="text-input">
    <label id="text-label" for="text-input">Name</label>
    <button id="plain-button">Upload</button>
  `
})

describe('upload_file 找文件 input 的页面函数（真 DOM）', () => {
  it('环境自检：跑在有 document 的环境里', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('object')
    expect(byId('plain').nodeType).toBe(1)
  })

  it.each<[string, string, string]>([
    ['文件 input 自己', 'plain', 'plain'],
    ['for 指向它的 label（input 本身藏着）', 'for-label', 'hidden-input'],
    ['包着它的 label', 'wrap-label', 'wrapped'],
    ['里面恰有一个文件 input 的容器（别的 input 不算）', 'dropzone', 'inner']
  ])('U8 %s → 找到那个 input', (_label, from, expected) => {
    expect(locate(byId(from))).toBe(byId(expected))
  })

  it('U8 uid 指向 label 里的文本节点 → 按它的父元素找', () => {
    const text = byId('for-label').firstChild!
    expect(text.nodeType).toBe(3)
    expect(locate(text)).toBe(byId('hidden-input'))
  })

  it.each<[string, string]>([
    ['里面有两个文件 input（有歧义）', 'two-inputs'],
    ['文本 input', 'text-input'],
    ['control 是文本 input 的 label', 'text-label'],
    ['里面什么 input 都没有的按钮', 'plain-button']
  ])('U8 %s → null', (_label, from) => {
    expect(locate(byId(from))).toBeNull()
  })
})
