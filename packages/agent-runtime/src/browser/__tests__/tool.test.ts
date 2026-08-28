import { describe, it, expect, vi } from 'vitest'
import { createBrowserTool, buildBrowserParamsSchema, buildBrowserToolDescription } from '../tool'
import type { BrowserBackend, BrowserCaps } from '../backend'

const ALL_CAPS: BrowserCaps = {
  pdf: true,
  fullPageScreenshot: true,
  elementScreenshot: true,
  screenshotToFile: true,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true
}

const EXTENSION_CAPS: BrowserCaps = {
  pdf: false,
  fullPageScreenshot: false,
  elementScreenshot: false,
  screenshotToFile: false,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true
}

function fakeBackend(caps: BrowserCaps = ALL_CAPS): BrowserBackend {
  return {
    caps,
    listTabs: vi.fn(async () => ({ text: '[t1] Example — https://a.com' })),
    openTab: vi.fn(async () => ({ text: 'Opened in tab t2', details: { url: 'https://b.com' } })),
    closeTab: vi.fn(async () => ({ text: 'closed' })),
    navigate: vi.fn(async () => ({ text: 'navigated' })),
    snapshot: vi.fn(async () => ({ text: 'snapshot', details: { elementCount: 3 } })),
    readPage: vi.fn(async () => ({ text: 'page md' })),
    screenshot: vi.fn(async () => ({
      text: 'shot',
      images: [{ data: 'base64', mimeType: 'image/jpeg' }]
    })),
    click: vi.fn(async () => ({ text: 'clicked' })),
    fill: vi.fn(async () => ({ text: 'filled' })),
    type: vi.fn(async () => ({ text: 'typed' })),
    pressKey: vi.fn(async () => ({ text: 'pressed' })),
    scroll: vi.fn(async () => ({ text: 'scrolled' })),
    waitFor: vi.fn(async () => ({ text: 'found' })),
    evaluate: vi.fn(async () => ({ text: '42' })),
    network: vi.fn(async () => ({ text: 'requests' })),
    console: vi.fn(async () => ({ text: 'messages' })),
    pdf: vi.fn(async () => ({ text: 'pdf saved' })),
    cdp: vi.fn(async () => ({ text: 'cdp ok' })),
    events: vi.fn(async () => ({ text: 'events' }))
  }
}

describe('schema / description 按 caps 裁剪', () => {
  it('扩展 caps：schema 无 pdf action 与 pdf 专属参数', () => {
    const schema = buildBrowserParamsSchema(EXTENSION_CAPS) as {
      properties: Record<string, unknown>
    }
    expect(schema.properties.outputPath).toBeUndefined()
    expect(schema.properties.fullPage).toBeUndefined()
    expect(schema.properties.expression).toBeDefined()
    expect(JSON.stringify(schema.properties.action)).not.toContain('pdf')
  })

  it('全 caps：pdf 参数存在', () => {
    const schema = buildBrowserParamsSchema(ALL_CAPS) as { properties: Record<string, unknown> }
    expect(schema.properties.outputPath).toBeDefined()
    expect(schema.properties.fullPage).toBeDefined()
  })

  it('description 含铁律与按 caps 过滤的 action 清单', () => {
    const descAll = buildBrowserToolDescription(ALL_CAPS)
    const descExt = buildBrowserToolDescription(EXTENSION_CAPS)
    expect(descAll).toContain('ALWAYS take a snapshot')
    expect(descAll).toContain('pdf(')
    expect(descExt).not.toContain('pdf(')
  })
})

describe('createBrowserTool 参数校验', () => {
  const tool = createBrowserTool({ backend: fakeBackend() })

  it('缺必选参数 → 只回该 action 的 usage，不回全手册', async () => {
    const result = await tool.execute('tc', { action: 'click', tabId: 't1' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Missing required parameter')
    expect(text).toContain('click(tabId, uid)')
    expect(text).not.toContain('## Workflow')
    expect(result.details).toMatchObject({ type: 'browser', action: 'click' })
  })

  it('navigate goto 缺 url → usage 错误', async () => {
    const result = await tool.execute('tc', { action: 'navigate', tabId: 't1' })
    expect((result.content[0] as { text: string }).text).toContain('"url" is required')
  })

  it('navigate back 无需 url', async () => {
    const backend = fakeBackend()
    const t = createBrowserTool({ backend })
    await t.execute('tc', { action: 'navigate', tabId: 't1', nav: 'back' })
    expect(backend.navigate).toHaveBeenCalledWith({ tabId: 't1', nav: 'back', url: undefined })
  })

  it('help 返回手册；help(topic) 只回该节', async () => {
    const full = await tool.execute('tc', { action: 'help' })
    expect((full.content[0] as { text: string }).text).toContain('# browser tool manual')
    const topic = await tool.execute('tc', { action: 'help', topic: 'interaction' })
    const topicText = (topic.content[0] as { text: string }).text
    expect(topicText).toContain('## Interaction')
    expect(topicText).not.toContain('## Navigation')
  })

  it('分发到 backend 并合并 details', async () => {
    const backend = fakeBackend()
    const t = createBrowserTool({ backend })
    const result = await t.execute('tc', { action: 'snapshot', tabId: 't1' })
    // 该 tab 的第一次快照没有可比对象，必须全量
    expect(backend.snapshot).toHaveBeenCalledWith({ tabId: 't1', full: true })
    expect(result.details).toMatchObject({ type: 'browser', action: 'snapshot', elementCount: 3 })
  })

  describe('snapshot 的差异/全量判定', () => {
    // 差异依赖模型上下文里还留着上一份快照，而工具无从知道自动压缩有没有把它删掉。
    // 这里钉的是工具**自己能做的确定性判断**：距上次快照隔了几次操作。
    it('紧邻上一次快照（中间只有少量操作）→ 请求差异', async () => {
      const backend = fakeBackend()
      const t = createBrowserTool({ backend })
      await t.execute('tc', { action: 'snapshot', tabId: 't1' })
      await t.execute('tc', { action: 'click', tabId: 't1', uid: 'e1' })
      await t.execute('tc', { action: 'snapshot', tabId: 't1' })
      expect(backend.snapshot).toHaveBeenLastCalledWith({ tabId: 't1', full: false })
    })

    it('隔了太多次操作 → 退回全量（隔得越久越可能已被压缩掉）', async () => {
      const backend = fakeBackend()
      const t = createBrowserTool({ backend })
      await t.execute('tc', { action: 'snapshot', tabId: 't1' })
      for (let i = 0; i < 9; i++) {
        await t.execute('tc', { action: 'click', tabId: 't1', uid: 'e1' })
      }
      await t.execute('tc', { action: 'snapshot', tabId: 't1' })
      expect(backend.snapshot).toHaveBeenLastCalledWith({ tabId: 't1', full: true })
    })

    it('full:true 无条件回全量，即便紧邻', async () => {
      const backend = fakeBackend()
      const t = createBrowserTool({ backend })
      await t.execute('tc', { action: 'snapshot', tabId: 't1' })
      await t.execute('tc', { action: 'click', tabId: 't1', uid: 'e1' })
      await t.execute('tc', { action: 'snapshot', tabId: 't1', full: true })
      expect(backend.snapshot).toHaveBeenLastCalledWith({ tabId: 't1', full: true })
    })

    it('计数按 tab 分开 —— 另一个 tab 的操作不该影响本 tab', async () => {
      const backend = fakeBackend()
      const t = createBrowserTool({ backend })
      await t.execute('tc', { action: 'snapshot', tabId: 't1' })
      for (let i = 0; i < 9; i++) {
        await t.execute('tc', { action: 'click', tabId: 't2', uid: 'e1' })
      }
      await t.execute('tc', { action: 'snapshot', tabId: 't1' })
      expect(backend.snapshot).toHaveBeenLastCalledWith({ tabId: 't1', full: false })
    })
  })

  it('图片内容进 content（screenshot）', async () => {
    const result = await tool.execute('tc', { action: 'screenshot', tabId: 't1' })
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
  })
})

describe('cdp 边界拦截', () => {
  it('blocked 方法 → 直接拒绝，不执行 backend', async () => {
    const backend = fakeBackend()
    const t = createBrowserTool({ backend })
    const result = await t.execute('tc', { action: 'cdp', tabId: 't1', method: 'Browser.close' })
    expect((result.content[0] as { text: string }).text).toContain('blocked')
    expect(backend.cdp).not.toHaveBeenCalled()
  })

  it('已知域内方法（只读与写类）→ 直接执行', async () => {
    const backend = fakeBackend()
    const t = createBrowserTool({ backend })
    await t.execute('tc', {
      action: 'cdp',
      tabId: 't1',
      method: 'Network.getResponseBody',
      params: { requestId: 'r1' }
    })
    expect(backend.cdp).toHaveBeenCalledWith({
      tabId: 't1',
      method: 'Network.getResponseBody',
      params: { requestId: 'r1' }
    })
    await t.execute('tc', {
      action: 'cdp',
      tabId: 't1',
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 390 }
    })
    expect(backend.cdp).toHaveBeenCalledWith({
      tabId: 't1',
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 390 }
    })
  })

  it('缺 method → usage 错误', async () => {
    const backend = fakeBackend()
    const t = createBrowserTool({ backend })
    const result = await t.execute('tc', { action: 'cdp', tabId: 't1' })
    expect((result.content[0] as { text: string }).text).toContain('Missing required parameter')
  })

  it('缺 tabId → usage 错误（tabId 必选）', async () => {
    const backend = fakeBackend()
    const t = createBrowserTool({ backend })
    const result = await t.execute('tc', { action: 'cdp', method: 'DOM.getDocument' })
    expect((result.content[0] as { text: string }).text).toContain('Missing required parameter')
    expect(backend.cdp).not.toHaveBeenCalled()
  })

  it('events 只读，直接分发', async () => {
    const backend = fakeBackend()
    const t = createBrowserTool({ backend })
    await t.execute('tc', { action: 'events', tabId: 't1', event: 'Network.responseReceived' })
    expect(backend.events).toHaveBeenCalledWith({
      tabId: 't1',
      event: 'Network.responseReceived',
      sinceSeq: undefined,
      limit: undefined
    })
  })
})

describe('network/console limit 透传', () => {
  it('network(tabId, limit) → backend 收到 limit', async () => {
    const backend = fakeBackend()
    const t = createBrowserTool({ backend })
    await t.execute('tc', { action: 'network', tabId: 't1', limit: 20 })
    expect(backend.network).toHaveBeenCalledWith({ tabId: 't1', limit: 20 })
    await t.execute('tc', { action: 'console', tabId: 't1' })
    expect(backend.console).toHaveBeenCalledWith({ tabId: 't1', limit: undefined })
  })
})

describe('topic schema 按 caps 裁剪', () => {
  it('rawCdp=false → topic 枚举无 devtools', () => {
    const noCdp: BrowserCaps = { ...EXTENSION_CAPS, rawCdp: false }
    const schema = buildBrowserParamsSchema(noCdp) as { properties: Record<string, unknown> }
    expect(JSON.stringify(schema.properties.topic)).not.toContain('devtools')
    const all = buildBrowserParamsSchema(ALL_CAPS) as { properties: Record<string, unknown> }
    expect(JSON.stringify(all.properties.topic)).toContain('devtools')
  })
})

describe('help devtools topic', () => {
  it('rawCdp 端全量手册含 devtools 节与配方', async () => {
    const backend = fakeBackend()
    const t = createBrowserTool({ backend })
    const full = await t.execute('tc', { action: 'help' })
    const text = (full.content[0] as { text: string }).text
    expect(text).toContain('DevTools escape hatch')
    expect(text).toContain('uid macros')
    const topic = await t.execute('tc', { action: 'help', topic: 'devtools' })
    expect((topic.content[0] as { text: string }).text).toContain('Inspect a request/response body')
  })
})

describe('中止：卡死的操作不该拖住会话', () => {
  it('操作永不兑现 + 中途 abort → execute 立刻抛中止错，不等底层 promise', async () => {
    const backend = fakeBackend()
    // 永不兑现的 readPage —— 复刻「页面一直加载中，抽取调用挂住」的现场
    backend.readPage = vi.fn(() => new Promise<never>(() => {}))
    const t = createBrowserTool({ backend, abortError: 'TOOL_ABORTED' })
    const ctrl = new AbortController()
    const running = t.execute('tc', { action: 'read_page', tabId: 't1' }, ctrl.signal)
    ctrl.abort()
    await expect(running).rejects.toThrow('TOOL_ABORTED')
  })

  it('未中止时照常返回结果（赛跑不影响正常路径）', async () => {
    const backend = fakeBackend()
    const t = createBrowserTool({ backend, abortError: 'TOOL_ABORTED' })
    const ctrl = new AbortController()
    const out = await t.execute('tc', { action: 'read_page', tabId: 't1' }, ctrl.signal)
    expect((out.content[0] as { text: string }).text).toBe('page md')
  })

  it('操作自己抛错 → 原错误照抛，不被中止错覆盖', async () => {
    const backend = fakeBackend()
    backend.readPage = vi.fn(async () => {
      throw new Error('no such tab')
    })
    const t = createBrowserTool({ backend, abortError: 'TOOL_ABORTED' })
    await expect(
      t.execute('tc', { action: 'read_page', tabId: 't9' }, new AbortController().signal)
    ).rejects.toThrow('no such tab')
  })
})
