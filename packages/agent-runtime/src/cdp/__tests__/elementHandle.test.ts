/**
 * CdpController 的元素句柄 —— resolveElement（存活检查 + 按角色与名字重新定位）、pointOf、
 * callOn / callOnElement、resolveCoordinates。
 *
 * 打桩 transport 演一个会重渲染的页面：
 *   - nodes：Accessibility.getFullAXTree 回的整棵树，可整棵换掉。ax() 让 backendDOMNodeId = nodeId，
 *     重渲染出来的新节点换个 nodeId 就是
 *   - known：DOM.resolveNode 还解析得到的节点（已被回收的不在）；connected：仍挂在文档上的节点
 *   - quads / metrics / scrollError / callResult：pointOf 与页面函数的回包，可编程
 * 每条命令都录下来，断言发了什么、按什么顺序。
 */
import { describe, it, expect } from 'vitest'
import { CdpController, type AXNode } from '../controller'
import type { CdpTransport } from '../transport'

function ax(nodeId: string, role: string, name?: string, childIds?: string[]): AXNode {
  return {
    nodeId,
    backendDOMNodeId: Number(nodeId),
    role: { type: 'role', value: role },
    ...(name === undefined ? {} : { name: { type: 'computed', value: name } }),
    ...(childIds ? { childIds } : {})
  }
}

interface Command {
  method: string
  params?: Record<string, unknown>
}

type Point = { x: number; y: number }

interface FakePage {
  ctl: CdpController
  commands: Command[]
  nodes: AXNode[]
  known: Set<number>
  connected: Set<number>
  axTreeError: Error | null
  scrollError: Error | null
  quads: number[][] | Error
  metrics: Record<string, unknown> | Error
  /** 页面函数（isConnected 检查以外的 Runtime.callFunctionOn）的回包 */
  callResult: Record<string, unknown>
}

function fakePage(nodes: AXNode[]): FakePage {
  const ids = nodes.flatMap((n) => (n.backendDOMNodeId == null ? [] : [n.backendDOMNodeId]))
  const page: Omit<FakePage, 'ctl'> = {
    commands: [],
    nodes,
    known: new Set(ids),
    connected: new Set(ids),
    axTreeError: null,
    scrollError: null,
    quads: [[10, 10, 30, 10, 30, 30, 10, 30]],
    metrics: { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } },
    callResult: { result: { value: 'ok' } }
  }
  const respond = (method: string, params: Record<string, unknown>): unknown => {
    switch (method) {
      case 'Accessibility.getFullAXTree':
        if (page.axTreeError) throw page.axTreeError
        return { nodes: page.nodes }
      case 'DOM.resolveNode': {
        const id = Number(params.backendNodeId)
        if (!page.known.has(id)) throw new Error('No node with given id found')
        return { object: { objectId: `o${id}` } }
      }
      case 'Runtime.callFunctionOn':
        if (String(params.functionDeclaration).includes('this.isConnected')) {
          return { result: { value: page.connected.has(Number(String(params.objectId).slice(1))) } }
        }
        return page.callResult
      case 'DOM.scrollIntoViewIfNeeded':
        if (page.scrollError) throw page.scrollError
        return {}
      case 'DOM.getContentQuads':
        if (page.quads instanceof Error) throw page.quads
        return { quads: page.quads }
      case 'Page.getLayoutMetrics':
        if (page.metrics instanceof Error) throw page.metrics
        return page.metrics
      default:
        return {}
    }
  }
  const transport: CdpTransport = {
    sendCommand: async <T = unknown>(
      method: string,
      params?: Record<string, unknown>
    ): Promise<T> => {
      page.commands.push({ method, params })
      return respond(method, params ?? {}) as T
    }
  }
  return Object.assign(page, { ctl: new CdpController(transport) })
}

/** 拍一次快照再清掉录下的命令：用例只看之后发生的 */
async function snapshotted(nodes: AXNode[]): Promise<FakePage> {
  const page = fakePage(nodes)
  await page.ctl.buildSnapshot('u')
  page.commands.length = 0
  return page
}

/** 页面重渲染：换上新树（新节点都解析得到、都挂在文档上），gone 里的旧节点脱离文档 */
function rerender(page: FakePage, nodes: AXNode[], gone: number[]): void {
  page.nodes = nodes
  for (const n of nodes) {
    if (n.backendDOMNodeId == null) continue
    page.known.add(n.backendDOMNodeId)
    page.connected.add(n.backendDOMNodeId)
  }
  for (const id of gone) page.connected.delete(id)
}

/** Save(#saveId) 与 Cancel(#12) 两个按钮，另挂 extra。快照里 e0 = 根、e1 = Save、e2 = Cancel */
function saveCancel(saveId = '10', extra: AXNode[] = []): AXNode[] {
  return [
    ax('1', 'RootWebArea', 'App', [saveId, '12', ...extra.map((n) => n.nodeId)]),
    ax(saveId, 'button', 'Save'),
    ax('12', 'button', 'Cancel'),
    ...extra
  ]
}

/** 等 promise 拒绝并拿到错误（没拒绝就判红） */
async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work
  } catch (err) {
    return err as Error
  }
  throw new Error('expected the promise to reject')
}

const RELEASE_O10: Command = { method: 'Runtime.releaseObject', params: { objectId: 'o10' } }

describe('resolveElement：存活检查与重新定位', () => {
  it('C1 节点仍挂在文档上 → 直接给句柄：只发 resolveNode + isConnected 两条，不重拉 AX 树', async () => {
    const page = await snapshotted(saveCancel())
    const el = await page.ctl.resolveElement('e1')
    expect(el).toEqual({ uid: 'e1', backendNodeId: 10, objectId: 'o10', relocated: false })
    expect(page.commands.map((c) => c.method)).toEqual([
      'DOM.resolveNode',
      'Runtime.callFunctionOn'
    ])
    expect(page.commands[0].params).toEqual({ backendNodeId: 10 })
    expect(page.commands[1].params).toMatchObject({ objectId: 'o10', returnByValue: true })
    expect(String(page.commands[1].params?.functionDeclaration)).toContain('isConnected')
  })

  it('C2 节点被重渲染替换 → 先释放旧句柄、再按角色与名字在新树里找回，映射换成新节点', async () => {
    const page = await snapshotted(saveCancel())
    rerender(page, saveCancel('20'), [10])
    const el = await page.ctl.resolveElement('e1')
    expect(el).toEqual({ uid: 'e1', backendNodeId: 20, objectId: 'o20', relocated: true })
    const release = page.commands.findIndex(
      (c) => c.method === 'Runtime.releaseObject' && c.params?.objectId === 'o10'
    )
    const axTree = page.commands.findIndex((c) => c.method === 'Accessibility.getFullAXTree')
    expect(release).toBeGreaterThanOrEqual(0)
    expect(release).toBeLessThan(axTree)
    expect(page.ctl.getNode('e1')?.backendDOMNodeId).toBe(20)
  })

  it.each<[string, () => Promise<{ page: FakePage; uid: string }>]>([
    ['还没拍过快照', async () => ({ page: fakePage(saveCancel()), uid: 'e1' })],
    [
      '快照里打印了、但没有 backendDOMNodeId 的纯文本（t 前缀 uid）',
      async () => {
        const text = ax('13', 'StaticText', 'Draft saved')
        delete text.backendDOMNodeId
        const page = fakePage([
          ax('1', 'RootWebArea', 'App', ['10', '13']),
          ax('10', 'button', 'Save'),
          text
        ])
        const snap = await page.ctl.buildSnapshot('u')
        page.commands.length = 0
        const uid = /uid=(t\w+) "Draft saved"/.exec(snap.text)?.[1]
        expect(uid).toBeDefined()
        return { page, uid: uid! }
      }
    ]
  ])('C3 %s → 「not found」，一条 DOM 命令都不发', async (_label, arrange) => {
    const { page, uid } = await arrange()
    const err = await rejection(page.ctl.resolveElement(uid))
    expect(err.message).toMatch(/not found\. Take a new snapshot/)
    expect(page.commands.filter((c) => c.method === 'DOM.resolveNode')).toEqual([])
  })

  it.each<[string, (page: FakePage) => void]>([
    [
      '重渲染后页面上有两个 Save（#20、#21），找回有歧义',
      (page) =>
        rerender(
          page,
          [
            ax('1', 'RootWebArea', 'App', ['20', '21', '12']),
            ax('20', 'button', 'Save'),
            ax('21', 'button', 'Save'),
            ax('12', 'button', 'Cancel')
          ],
          [10]
        )
    ],
    [
      '节点已被回收（#10 解析不了），页面上也没有 Save 了',
      (page) => {
        page.known.delete(10)
        page.connected.delete(10)
        page.nodes = [ax('1', 'RootWebArea', 'App')]
      }
    ],
    [
      '重拉 AX 树失败（Target closed）',
      (page) => {
        page.connected.delete(10)
        page.axTreeError = new Error('Target closed')
      }
    ]
  ])('C3 %s → 抛「已不在页面上，重新快照」', async (_label, arrange) => {
    const page = await snapshotted(saveCancel())
    arrange(page)
    const err = await rejection(page.ctl.resolveElement('e1'))
    expect(err.message).toMatch(/no longer on the page.*Take a new snapshot/)
    expect(err.message).not.toContain('Target closed')
    // 只试过快照里的那个节点：有歧义时哪个候选都不碰
    expect(
      page.commands
        .filter((c) => c.method === 'DOM.resolveNode')
        .map((c) => c.params?.backendNodeId)
    ).toEqual([10])
  })

  it('C4 快照时就不唯一的不重定位：删掉第一行后，e1 不会顶替成原来的第二个「Delete」', async () => {
    const page = await snapshotted([
      ax('1', 'RootWebArea', 'App', ['10', '11']),
      ax('10', 'button', 'Delete'),
      ax('11', 'button', 'Delete')
    ])
    rerender(page, [ax('1', 'RootWebArea', 'App', ['11']), ax('11', 'button', 'Delete')], [10])
    expect((await rejection(page.ctl.resolveElement('e1'))).message).toMatch(
      /no longer on the page/
    )

    const fn = 'function(){ this.click() }'
    expect((await rejection(page.ctl.callOnElement('e1', fn))).message).toMatch(
      /no longer on the page/
    )
    expect(
      page.commands.filter(
        (c) => c.method === 'Runtime.callFunctionOn' && c.params?.functionDeclaration === fn
      )
    ).toEqual([])
  })

  it('C5 重定位不打断差异回传：随后的快照仍回差异，新出现的状态行标 +', async () => {
    const page = await snapshotted(saveCancel())
    rerender(page, saveCancel('20', [ax('21', 'status', 'Saved!')]), [10])
    await page.ctl.resolveElement('e1')
    const snap = await page.ctl.buildSnapshot('u')
    expect(snap.diffed).toBe(true)
    const added = snap.text.split('\n').filter((l) => l.startsWith('+'))
    expect(added).toHaveLength(1)
    expect(added[0]).toContain('status "Saved!"')
  })

  it('C8 重定位只替这一个 uid 换句柄：其余 uid 仍指快照里的节点，不会被顺手重映射', async () => {
    const page = await snapshotted([
      ax('1', 'RootWebArea', 'App', ['10', '11', '12']),
      ax('10', 'button', 'Delete'),
      ax('11', 'button', 'Delete'),
      ax('12', 'button', 'Save')
    ])
    expect([1, 2, 3].map((i) => page.ctl.getNode(`e${i}`)?.backendDOMNodeId)).toEqual([10, 11, 12])
    rerender(
      page,
      [
        ax('1', 'RootWebArea', 'App', ['11', '20']),
        ax('11', 'button', 'Delete'),
        ax('20', 'button', 'Save')
      ],
      [10, 12]
    )

    expect(await page.ctl.resolveElement('e3')).toMatchObject({
      backendNodeId: 20,
      relocated: true
    })
    // 新树里 #11 已是「第一个 Delete」—— 若随 e3 的重定位整体重映射，e1 会被指到它上面
    expect(await page.ctl.resolveElement('e2')).toMatchObject({
      backendNodeId: 11,
      relocated: false
    })
    expect((await rejection(page.ctl.resolveElement('e1'))).message).toMatch(
      /no longer on the page/
    )
  })
})

describe('pointOf：元素露在视口里那部分的中心', () => {
  it.each<[string, Partial<FakePage>, Point | null]>([
    [
      '多段 quad（折行的行内元素）取可见面积最大的一段',
      {
        quads: [
          [0, 0, 10, 0, 10, 10, 0, 10],
          [100, 100, 300, 100, 300, 140, 100, 140]
        ]
      },
      { x: 200, y: 120 }
    ],
    [
      '左侧伸出视口：只算露出来的部分',
      { quads: [[-50, 10, 50, 10, 50, 30, -50, 30]] },
      { x: 25, y: 20 }
    ],
    ['整个在视口下方 → null', { quads: [[0, 700, 10, 700, 10, 750, 0, 750]] }, null],
    ['不足 1px 的 quad → null', { quads: [[10, 10, 10.5, 10, 10.5, 10.5, 10, 10.5]] }, null],
    ['没有盒子（quads 为空）→ null', { quads: [] }, null],
    ['getContentQuads 失败 → null', { quads: new Error('Could not compute content quads.') }, null],
    [
      '只有 layoutViewport 时按它裁剪',
      {
        metrics: { layoutViewport: { clientWidth: 100, clientHeight: 100 } },
        quads: [[50, 50, 150, 50, 150, 90, 50, 90]]
      },
      { x: 75, y: 70 }
    ],
    [
      'cssLayoutViewport 优先于 layoutViewport',
      {
        metrics: {
          cssLayoutViewport: { clientWidth: 100, clientHeight: 100 },
          layoutViewport: { clientWidth: 1000, clientHeight: 1000 }
        },
        quads: [[50, 50, 150, 50, 150, 90, 50, 90]]
      },
      { x: 75, y: 70 }
    ],
    [
      '拿不到视口尺寸 → 不裁剪',
      {
        metrics: new Error('Page.getLayoutMetrics failed'),
        quads: [[900, 10, 1000, 10, 1000, 30, 900, 30]]
      },
      { x: 950, y: 20 }
    ],
    [
      'scrollIntoViewIfNeeded 失败照样取点',
      { scrollError: new Error('Node does not have a layout object') },
      { x: 20, y: 20 }
    ]
  ])('C6 %s', async (_label, setup, expected) => {
    const page = await snapshotted(saveCancel())
    const el = await page.ctl.resolveElement('e1')
    Object.assign(page, setup)
    page.commands.length = 0
    expect(await page.ctl.pointOf(el)).toEqual(expected)
    // 先滚进视口再取 quad：视口外的元素按滚动前的坐标点下去什么也点不到
    const methods = page.commands.map((c) => c.method)
    const scroll = methods.indexOf('DOM.scrollIntoViewIfNeeded')
    expect(scroll).toBeGreaterThanOrEqual(0)
    expect(scroll).toBeLessThan(methods.indexOf('DOM.getContentQuads'))
  })
})

describe('callOn / callOnElement / resolveCoordinates', () => {
  it('C7 callOn：参数逐个包成 {value}、returnByValue；不给参数时不带 arguments 键', async () => {
    const page = await snapshotted(saveCancel())
    const el = await page.ctl.resolveElement('e1')
    page.commands.length = 0
    page.callResult = { result: { value: 42 } }

    expect(await page.ctl.callOn(el, 'function(a, b){ return 42 }', [1, 'x'])).toBe(42)
    expect(page.commands[0]).toEqual({
      method: 'Runtime.callFunctionOn',
      params: {
        objectId: 'o10',
        functionDeclaration: 'function(a, b){ return 42 }',
        arguments: [{ value: 1 }, { value: 'x' }],
        returnByValue: true
      }
    })

    await page.ctl.callOn(el, 'function(){ return 42 }')
    expect(page.commands[1].params).toMatchObject({ objectId: 'o10', returnByValue: true })
    expect(page.commands[1].params).not.toHaveProperty('arguments')
  })

  it.each<[string, Record<string, unknown>, string]>([
    [
      '有 exception.description 时用它',
      { text: 'Uncaught', exception: { description: 'TypeError: boom' } },
      'TypeError: boom'
    ],
    ['只有 text 时用 text', { text: 'Uncaught' }, 'Uncaught']
  ])('C7 callOn：页面里抛错转成 Error（%s）', async (_label, exceptionDetails, message) => {
    const page = await snapshotted(saveCancel())
    const el = await page.ctl.resolveElement('e1')
    page.callResult = { result: {}, exceptionDetails }
    expect((await rejection(page.ctl.callOn(el, 'function(){ throw 1 }'))).message).toBe(message)
  })

  it('C7 callOnElement：页面函数抛错也释放句柄（最后一条命令是 releaseObject）', async () => {
    const page = await snapshotted(saveCancel())
    page.callResult = {
      result: {},
      exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: nope' } }
    }
    const err = await rejection(
      page.ctl.callOnElement('e1', 'function(){ throw new Error("nope") }')
    )
    expect(err.message).toBe('Error: nope')
    expect(page.commands.at(-1)).toEqual(RELEASE_O10)
  })

  it('C7 resolveCoordinates：不可见 → 抛错；可见 → 返回中心点；两种情况都释放句柄', async () => {
    const page = await snapshotted(saveCancel())
    page.quads = []
    expect((await rejection(page.ctl.resolveCoordinates('e1'))).message).toMatch(/is not visible/)
    expect(page.commands.at(-1)).toEqual(RELEASE_O10)

    page.commands.length = 0
    page.quads = [[10, 10, 30, 10, 30, 30, 10, 30]]
    expect(await page.ctl.resolveCoordinates('e1')).toEqual({ x: 20, y: 20 })
    expect(page.commands.at(-1)).toEqual(RELEASE_O10)
  })
})
