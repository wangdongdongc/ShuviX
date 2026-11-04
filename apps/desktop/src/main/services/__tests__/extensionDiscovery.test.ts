/**
 * 查找这条会话没开启的 MCP 服务器（`tool_search` 与提示词那段说明共用）。全程不连接；第三方的描述只参与匹配。
 *
 *   ED-1 内置服务器按工具名 + 三种语言的名字与说明找得到；非 ASCII 的词也认子串，ASCII 不认
 *   ED-2 chrome / plan 不拿去问；单字符（任何文字）与停用词不算词 → 空
 *   ED-3 查询就是名字（不分大小写，也认 mcp: / mcp__）→ 只回它
 *   ED-4 只留不低于最高分一半的：3 比 1 只留最高，2 比 1 都留
 *   ED-5 第三方：描述里的词找得到它，但 extensionChoiceLine 不带描述；名字过滤、截到 64、最多 8 个工具；cachedTools 坏了不抛
 *   ED-6 extensionSourceOf：内置 / 主机（不带账号和 token）/ 命令行（不带 env，截到 500）；参数读不出 → 只有命令；
 *        地址解析不了 → 不带协议和账号
 *   ED-7 列表给出的过滤后写法调回来照样找得到
 *   ED-8 isExtensionOff：勾着、档案声明的、用户取消的都不算「没开」；extensionPromptEntries 不列它们，第三方不带说明
 *
 *   ED-W 组件也是服务器（一个组件一台）：id、显示名、说明、操作名、操作说明都找得到；`widget` 这个词只算低分；id / 唯一的显示名
 *        直接命中；给模型看的文字只有过滤后的服务器名、显示名和操作名，从没有说明；提示词最多列 20 个组件
 *
 * mcpService 与组件表替身（只给配置表）；i18next 用真的，三份语言文件都加载（getFixedT 要读它们）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'

const state = vi.hoisted(() => ({
  configured: vi.fn<() => McpServer[]>(),
  widgets: new Map<string, { id: string; name: string; description: string }>()
}))

vi.mock('../mcpService', () => ({ mcpService: { configuredServers: state.configured } }))
vi.mock('../widget/widgetRegistry', () => ({
  widgetRegistry: { findById: (id: string) => state.widgets.get(id) }
}))

import {
  exactExtensionName,
  extensionChoiceLine,
  extensionPromptEntries,
  extensionSourceOf,
  findExtensions,
  isExtensionOff,
  offeredServers,
  rankExtensionDocuments,
  tokenizeExtensionText
} from '../extensionDiscovery'

function server(name: string, patch: Partial<McpServer> = {}): McpServer {
  return {
    id: `id-${name}`,
    name,
    type: 'stdio',
    command: 'npx',
    args: '[]',
    env: '{}',
    url: '',
    headers: '{}',
    metadata: '{}',
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[]',
    createdAt: 0,
    updatedAt: 0,
    ...patch
  }
}

const builtin = (name: string): McpServer => server(name, { type: 'inproc', isBuiltin: 1 })

const withTools = (name: string, tools: unknown, patch: Partial<McpServer> = {}): McpServer =>
  server(name, { cachedTools: JSON.stringify(tools), ...patch })

const BUILTINS = ['browser', 'chrome', 'database', 'plan', 'ssh'].map(builtin)

const namesFound = (query: string): string[] =>
  findExtensions(query, offeredServers()).map((found) => found.name)

beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      ja: { translation: ja }
    }
  })
})

beforeEach(async () => {
  await i18next.changeLanguage('en')
  state.configured.mockReset()
  state.configured.mockReturnValue(BUILTINS)
  state.widgets.clear()
})

describe('ED-1 内置服务器按工具名与三种语言的文案找得到', () => {
  it.each([
    ['浏览器', 'browser'],
    ['网页', 'browser'],
    ['ブラウザ', 'browser'],
    ['read_page', 'browser'],
    ['tabs', 'browser'],
    ['数据库', 'database'],
    ['データベース', 'database'],
    ['ssh', 'ssh']
  ])('ED-1 %s → 只有 %s', (query, expected) => {
    expect(namesFound(query)).toEqual([expected])
  })

  it('ED-1 界面语言不影响匹配：三种语言的文案都在索引里', async () => {
    for (const language of ['zh', 'ja', 'en']) {
      await i18next.changeLanguage(language)
      expect(namesFound('浏览器')).toEqual(['browser'])
      expect(namesFound('ブラウザ')).toEqual(['browser'])
      expect(namesFound('browser')).toEqual(['browser'])
    }
  })

  it('ED-1 非 ASCII 的词也算文档文字的子串（切词结果随 ICU 版本变）', () => {
    const documents = [{ name: 'x', text: 'リモートデータベース' }]
    expect(rankExtensionDocuments('データ', documents)).toEqual(['x'])
    expect(rankExtensionDocuments('数据', [{ name: 'y', text: '远程数据库连接' }])).toEqual(['y'])
  })

  it('ED-1 ASCII 的词不认子串：base 找不到 database', () => {
    expect(rankExtensionDocuments('base', [{ name: 'x', text: 'database' }])).toEqual([])
  })

  it('ED-1 `_` / `-` 按空格算，复数归一：page 找得到 read_page，tab 找得到 list_tabs', () => {
    const documents = [{ name: 'x', text: 'read_page list_tabs' }]
    expect(rankExtensionDocuments('page', documents)).toEqual(['x'])
    expect(rankExtensionDocuments('tab', documents)).toEqual(['x'])
  })
})

describe('ED-2 不拿去问的、不算词的', () => {
  it.each(['chrome', 'plan', 'mcp:chrome', 'a', 'the'])('ED-2 %s → 空', (query) => {
    expect(namesFound(query)).toEqual([])
  })

  it.each(['的', '器', 'で', '7', 'a b c'])('ED-2 单字符不算词（任何文字）：%s → 空', (query) => {
    expect(namesFound(query)).toEqual([])
  })

  it('ED-2 offeredServers 排除 chrome 与 plan，其余照 configuredServers 的顺序', () => {
    expect(offeredServers().map((found) => found.name)).toEqual(['browser', 'database', 'ssh'])
  })
})

describe('ED-3 查询就是名字', () => {
  it.each(['Browser', 'BROWSER', 'mcp:browser', 'mcp__browser', 'MCP:Browser', '  browser  '])(
    'ED-3 %s → 只回 browser',
    (query) => {
      expect(namesFound(query)).toEqual(['browser'])
    }
  )

  it('ED-3 名字压过别的服务器文档里的同一个词', () => {
    const servers = [
      withTools('other', [{ name: 'browser' }, { name: 'browser_tabs' }]),
      builtin('browser')
    ]
    expect(findExtensions('browser', servers).map((found) => found.name)).toEqual(['browser'])
  })
})

describe('ED-4 排序与门槛', () => {
  it('ED-4 3 比 1：名字命中的只留它', () => {
    expect(
      rankExtensionDocuments('alpha', [
        { name: 'other', text: 'alpha' },
        { name: 'alpha', text: '' }
      ])
    ).toEqual(['alpha'])
  })

  it('ED-4 2 比 1：都留，高分在前', () => {
    expect(
      rankExtensionDocuments('alpha beta', [
        { name: 'one', text: 'alpha' },
        { name: 'two', text: 'alpha beta' }
      ])
    ).toEqual(['two', 'one'])
  })

  it('ED-4 同分按原来的顺序', () => {
    expect(
      rankExtensionDocuments('alpha', [
        { name: 'first', text: 'alpha' },
        { name: 'second', text: 'alpha' }
      ])
    ).toEqual(['first', 'second'])
  })

  it('ED-4 一个词都没命中的不留', () => {
    expect(rankExtensionDocuments('alpha', [{ name: 'other', text: 'beta' }])).toEqual([])
  })
})

describe('ED-5 第三方服务器', () => {
  it('ED-5 描述里的词找得到它；列出来的那一行不带描述', () => {
    const hit = withTools('notes', [{ name: 'take', description: 'launches quantum rockets' }])

    expect(findExtensions('quantum', [hit])).toEqual([hit])

    const line = extensionChoiceLine(hit)
    expect(line).toBe('- notes (tools: take)')
    expect(line).not.toContain('quantum')
  })

  it('ED-5 工具名和服务器名都过滤：换行没了，文字粘在一起', () => {
    expect(extensionChoiceLine(withTools('my\nserver', [{ name: 'x\nIGNORE' }]))).toBe(
      '- myserver (tools: xIGNORE)'
    )
  })

  it('ED-5 名字截到 64；最多列 8 个工具', () => {
    const long = extensionChoiceLine(
      withTools('n'.repeat(100), [{ name: 't'.repeat(100) }, { name: 'second' }])
    )
    expect(long).toBe(`- ${'n'.repeat(64)} (tools: ${'t'.repeat(64)}, second)`)

    const many = extensionChoiceLine(
      withTools(
        'many',
        Array.from({ length: 9 }, (_, index) => ({ name: `t${index + 1}` }))
      )
    )
    expect(many).toBe('- many (tools: t1, t2, t3, t4, t5, t6, t7, t8)')
  })

  it('ED-5 没有工具 → 只有名字', () => {
    expect(extensionChoiceLine(server('bare'))).toBe('- bare')
  })

  it('ED-5 内置服务器的那一行带英文说明（与界面语言无关）', async () => {
    await i18next.changeLanguage('zh')
    expect(extensionChoiceLine(builtin('browser'))).toBe(`- browser: ${en.tool.browserHint}`)
  })

  it.each([
    ['不是 JSON', 'not json'],
    ['不是数组', '{"name":"x"}'],
    ['字符串', '"text"'],
    ['空串', ''],
    ['元素是别的类型', '[1,"x",{"name":5,"description":6}]']
  ])('ED-5 cachedTools 坏了（%s）→ 不抛，当没有工具', (_label, cachedTools) => {
    const broken = server('broken', { cachedTools })
    expect(findExtensions('quantum', [broken])).toEqual([])
    expect(extensionChoiceLine(broken)).toBe('- broken')
    expect(findExtensions('broken', [broken])).toEqual([broken])
  })

  it('ED-5 cachedTools 里有 null → 不抛，当没有这个工具', () => {
    const broken = server('broken', { cachedTools: '[null,{"name":"good"}]' })
    expect(findExtensions('good', [broken])).toEqual([broken])
    expect(extensionChoiceLine(broken)).toBe('- broken (tools: good)')
  })
})

describe('ED-6 extensionSourceOf', () => {
  it('ED-6 内置', () => {
    expect(extensionSourceOf(builtin('browser'))).toEqual({ type: 'builtin' })
  })

  it('ED-6 http：只有主机，不带账号、路径和 token', () => {
    expect(
      extensionSourceOf(server('x', { type: 'http', url: 'https://u:p@h:1/x?token=t' }))
    ).toEqual({ type: 'url', host: 'h:1' })
  })

  it('ED-6 stdio：命令 + 参数，不带环境变量', () => {
    const source = extensionSourceOf(
      server('x', { command: 'npx', args: '["-y","pkg"]', env: '{"TOKEN":"SECRET"}' })
    )
    expect(source).toEqual({ type: 'command', command: 'npx -y pkg' })
    expect(JSON.stringify(source)).not.toContain('SECRET')
  })

  it('ED-6 命令行截到 500', () => {
    const source = extensionSourceOf(
      server('x', { args: JSON.stringify(['a'.repeat(300), 'b'.repeat(300)]) })
    )
    expect(source.type).toBe('command')
    expect((source as { command: string }).command).toHaveLength(500)
  })

  it.each([
    ['读不出', 'not json', 'npx'],
    ['不是数组', '{"a":1}', 'npx'],
    ['空串', '', 'npx'],
    ['混了别的类型', '[1,"a",null]', 'npx a']
  ])('ED-6 参数%s → %s', (_label, args, expected) => {
    expect(extensionSourceOf(server('x', { args }))).toEqual({ type: 'command', command: expected })
  })

  it('ED-6 地址解析不了：不带协议、账号、路径和 token', () => {
    const source = extensionSourceOf(
      server('x', { type: 'http', url: 'https://u:p@bad host:1/x?token=t' })
    )
    expect(source).toEqual({ type: 'url', host: 'bad host:1' })
    const text = JSON.stringify(source)
    for (const leak of ['https:', 'u:p', 'token']) expect(text).not.toContain(leak)
  })

  it('ED-6 没有协议、也解析不了的地址：留下主机那一段', () => {
    expect(extensionSourceOf(server('x', { type: 'http', url: 'not a url/x' }))).toEqual({
      type: 'url',
      host: 'not a url'
    })
  })
})

describe('ED-7 过滤后的写法', () => {
  it('ED-7 把 `my server` 列出来的名字调回来，找得到它', () => {
    const hit = server('my server')
    const listed = /^- (\S+)/.exec(extensionChoiceLine(hit))![1]
    expect(listed).toBe('myserver')
    expect(findExtensions(listed, [hit])).toEqual([hit])
  })

  it('ED-7 确实有一台就叫过滤后的名字时，原名优先', () => {
    expect(exactExtensionName('myserver', ['my server', 'myserver'])).toBe('myserver')
    expect(exactExtensionName('MyServer', ['my server'])).toBe('my server')
  })

  it('ED-7 都不是 → undefined', () => {
    expect(exactExtensionName('other', ['my server'])).toBeUndefined()
  })
})

describe('ED-8 isExtensionOff 与提示词列表', () => {
  const session = {
    names: ['mcp:ticked', 'mcp:declared', 'bash'],
    optedOut: new Set(['mcp:out'])
  }

  it.each(['ticked', 'declared', 'out'])('ED-8 %s 不算「没开」', (name) => {
    expect(isExtensionOff(server(name), session)).toBe(false)
  })

  it('ED-8 其余的算', () => {
    expect(isExtensionOff(server('other'), session)).toBe(true)
  })

  it('ED-8 提示词只列没开的：内置带说明，第三方只有过滤后的名字，没有 hint 键', () => {
    state.configured.mockReturnValue([
      server('ticked'),
      server('declared'),
      server('out'),
      builtin('chrome'),
      builtin('plan'),
      builtin('browser'),
      withTools('my tool', [{ name: 'x', description: 'SECRET_DESCRIPTION' }])
    ])

    const entries = extensionPromptEntries(session)

    expect(entries).toEqual([{ name: 'browser', hint: en.tool.browserHint }, { name: 'mytool' }])
    expect(Object.keys(entries[1])).toEqual(['name'])
    expect(JSON.stringify(entries)).not.toContain('SECRET_DESCRIPTION')
  })

  it('ED-8 内置的说明用当前界面语言', async () => {
    state.configured.mockReturnValue([builtin('browser')])
    await i18next.changeLanguage('zh')
    expect(extensionPromptEntries({ names: [], optedOut: new Set() })).toEqual([
      { name: 'browser', hint: zh.tool.browserHint }
    ])
  })

  it('ED-8 名字恰好是内置服务器的第三方：不算内置，不带内置说明', () => {
    state.configured.mockReturnValue([server('browser')])
    expect(extensionPromptEntries({ names: [], optedOut: new Set() })).toEqual([
      { name: 'browser' }
    ])
  })
})

// ─── 组件 ────────────────────────────────────────────────────────────────

describe('ED-W 组件也是一台服务器', () => {
  /** 组件的配置行（widgetServerRows 算出来的形状）+ 组件表里的一条 */
  function widget(
    id: string,
    name: string,
    description = '',
    ops: Array<{ name: string; description?: string }> = [{ name: 'run', description: '' }]
  ): McpServer {
    state.widgets.set(id, { id, name, description })
    return server(`widget-${id}`, {
      id: `widget-server:${id}`,
      type: 'inproc',
      isBuiltin: 1,
      cachedTools: JSON.stringify(ops)
    })
  }

  const EXPENSE = (): McpServer =>
    widget('expense-log', 'Money Tracker', 'Keeps receipts for the tax return.', [
      { name: 'addReceipt', description: 'Store an invoice with its amount.' },
      { name: 'listBooks', description: 'Unrelated second op.' }
    ])
  const READING = (): McpServer =>
    widget('reading-list', 'Bookshelf', 'Novels the user wants to read.', [
      { name: 'rememberNovel', description: 'Remember a novel.' }
    ])
  const GARDEN = (): McpServer => widget('garden-diary', 'Plants', 'Watering days.')

  describe('ED-W1 找得到', () => {
    it.each<[string, string]>([
      ['id 里的词', 'expense'],
      ['显示名里的词', 'money'],
      ['说明里的词（单复数归一）', 'receipt'],
      ['操作名（小驼峰拆开）', 'addReceipt'],
      ['操作名里的一个词', 'receipt'],
      ['操作说明里的词', 'invoice']
    ])('ED-W1 %s：%s', (_l, query) => {
      state.configured.mockReturnValue([EXPENSE(), READING(), GARDEN()])
      expect(namesFound(query)).toEqual(['widget-expense-log'])
    })

    it('ED-W1 小驼峰拆开：addBook → add + book（book 搜得到）；连写的大写不拆', () => {
      expect(tokenizeExtensionText('addBook')).toEqual(['add', 'book'])
      expect(tokenizeExtensionText('listBooks')).toEqual(['list', 'book'])
      expect(tokenizeExtensionText('HTTPServer')).toEqual(['httpserver'])
    })

    it('ED-W1 中文的显示名也找得到', () => {
      state.configured.mockReturnValue([widget('zh-notes', '读书笔记'), READING()])
      expect(namesFound('读书笔记')).toEqual(['widget-zh-notes'])
    })
  })

  describe('ED-W2/3 `widget` 这个词只算低分', () => {
    it('ED-W2 「expense widget」：只有那一个，不是每个组件', () => {
      state.configured.mockReturnValue([EXPENSE(), READING(), GARDEN()])
      expect(namesFound('expense widget')).toEqual(['widget-expense-log'])
    })

    it('ED-W3 `widget` 单独搜：每个组件都列（同分），别的服务器不算', () => {
      state.configured.mockReturnValue([
        ...BUILTINS,
        withTools('notes', [{ name: 'take' }]),
        EXPENSE(),
        READING()
      ])
      expect(namesFound('widget')).toEqual(['widget-expense-log', 'widget-reading-list'])
    })

    it('ED-W3 「notes widget」：名字叫 notes 的第三方压过只撞上 widget 的组件', () => {
      state.configured.mockReturnValue([withTools('notes', [{ name: 'take' }]), READING()])
      expect(namesFound('notes widget')).toEqual(['notes'])
    })

    it('ED-W4 显示名里带 Widget 的组件（现状，按裁定钉住）：名字命中得 3 分，`widget` 单独搜时只剩它', () => {
      state.configured.mockReturnValue([widget('expense-log', 'Expense Widget'), READING()])
      expect(namesFound('widget')).toEqual(['widget-expense-log'])
    })
  })

  describe('ED-W5..9 直接命中', () => {
    it.each([
      'widget-expense-log',
      'mcp:widget-expense-log',
      'mcp__widget-expense-log',
      'WIDGET-EXPENSE-LOG'
    ])('ED-W5 服务器名 %s → 只回它', (query) => {
      state.configured.mockReturnValue([EXPENSE(), READING()])
      expect(namesFound(query)).toEqual(['widget-expense-log'])
    })

    it.each(['expense-log', 'Expense-Log', '  expense-log  ', 'expense log', 'expense_log'])(
      'ED-W6 组件 id（%j）→ 只回它，别的组件的说明里有这些词也一样',
      (query) => {
        state.configured.mockReturnValue([
          EXPENSE(),
          widget('other-one', 'Other', 'The expense log of last year.')
        ])
        expect(namesFound(query)).toEqual(['widget-expense-log'])
      }
    )

    it.each([
      'Money Tracker',
      'money tracker',
      'money-tracker',
      '  MONEY TRACKER ',
      'Ｍｏｎｅｙ Ｔｒａｃｋｅｒ'
    ])('ED-W7 唯一的显示名（%j）→ 只回它，别的组件名字里有一半也一样', (query) => {
      state.configured.mockReturnValue([
        EXPENSE(),
        widget('tracker-two', 'Tracker'),
        withTools('money', [{ name: 'pay' }])
      ])
      expect(namesFound(query)).toEqual(['widget-expense-log'])
    })

    it('ED-W8 两个组件同一个显示名：不直接命中，两个都列', () => {
      state.configured.mockReturnValue([
        widget('notes-one', 'Notes'),
        widget('notes-two', 'Notes'),
        READING()
      ])
      expect(namesFound('notes')).toEqual(['widget-notes-one', 'widget-notes-two'])
    })

    it('ED-W9 id 赢：别的组件恰好起了这个显示名，也不会变成多个命中', () => {
      state.configured.mockReturnValue([READING(), widget('other-one', 'Reading List')])
      expect(namesFound('reading-list')).toEqual(['widget-reading-list'])
      // 反过来，那个显示名照样认得出（只差连字符的那个写法算 id，所以换一个 id 没有的查询）
      state.configured.mockReturnValue([READING(), widget('other-one', 'Reading Shelf')])
      expect(namesFound('reading shelf')).toEqual(['widget-other-one'])
    })
  })

  describe('ED-W10/11 多个命中时列给模型的一行', () => {
    it('ED-W10 服务器名 + 过滤后的显示名 + 操作名；说明一个字都不进', () => {
      const line = extensionChoiceLine(
        widget('a-b', 'Reading list', 'SECRET_WIDGET_DESCRIPTION', [
          { name: 'listBooks', description: 'SECRET_OP_DESCRIPTION' }
        ])
      )
      expect(line).toBe('- widget-a-b "Reading list" (tools: listBooks)')
    })

    it('ED-W10 显示名过滤：引号、换行、反引号、尖括号都去掉，字母数字空格 _ . - 留下；截到 40', () => {
      expect(
        extensionChoiceLine(widget('a-b', 'Evil "quote"\n`<b>` _x.y-z 书', '', [{ name: 'run' }]))
      ).toBe('- widget-a-b "Evil quoteb _x.y-z 书" (tools: run)')
      const long = extensionChoiceLine(widget('a-b', 'n'.repeat(80), '', [{ name: 'run' }]))
      expect(long).toBe(`- widget-a-b "${'n'.repeat(40)}" (tools: run)`)
    })

    it('ED-W10 显示名过滤完是空的 / 组件表里没有它：只有服务器名，没有一对空引号', () => {
      expect(extensionChoiceLine(widget('a-b', '"<>"', '', [{ name: 'run' }]))).toBe(
        '- widget-a-b (tools: run)'
      )
      state.widgets.delete('a-b')
      expect(extensionChoiceLine(server('widget-a-b', { type: 'inproc' }))).toBe('- widget-a-b')
    })

    it('ED-W11 操作名照第三方工具的同一条规则：批准之前也列，最多 8 个（裁定：它们是严格格式的名字）', () => {
      const ops = Array.from({ length: 10 }, (_, i) => ({ name: `op${i}`, description: 'x' }))
      const line = extensionChoiceLine(widget('a-b', 'Name', '', ops))
      expect(line).toBe(
        `- widget-a-b "Name" (tools: ${ops
          .slice(0, 8)
          .map((op) => op.name)
          .join(', ')})`
      )
    })
  })

  describe('ED-W12/13 提示词里那一段', () => {
    const OFF = { names: [] as string[], optedOut: new Set<string>() }

    it('ED-W12 组件：名字 + 一句带显示名的说明（界面语言）；不带组件说明、操作名和操作说明', async () => {
      state.configured.mockReturnValue([
        widget('a-b', 'Reading "list"', 'SECRET_WIDGET_DESCRIPTION', [
          { name: 'secretOp', description: 'SECRET_OP_DESCRIPTION' }
        ])
      ])
      const entries = extensionPromptEntries(OFF)
      expect(entries).toEqual([
        {
          name: 'widget-a-b',
          hint: en.tool.extensionWidgetHint.replace('{{name}}', 'Reading list')
        }
      ])
      expect(JSON.stringify(entries)).not.toContain('SECRET')
      expect(JSON.stringify(entries)).not.toContain('secretOp')

      await i18next.changeLanguage('zh')
      expect(extensionPromptEntries(OFF)[0]!.hint).toBe(
        zh.tool.extensionWidgetHint.replace('{{name}}', 'Reading list')
      )
    })

    it('ED-W12 显示名过滤完是空的 / 组件表里没有：只有名字，没有 hint 键', () => {
      state.configured.mockReturnValue([
        widget('a-b', '"<>"'),
        server('widget-c-d', { type: 'inproc' })
      ])
      const entries = extensionPromptEntries(OFF)
      expect(entries).toEqual([{ name: 'widget-a-b' }, { name: 'widget-c-d' }])
      expect(Object.keys(entries[0]!)).toEqual(['name'])
    })

    const widgets = (count: number, from = 0): McpServer[] =>
      Array.from({ length: count }, (_, i) => widget(`w-${from + i}`, `W${from + i}`))

    it('ED-W13 恰 20 个：全列，没有「还有」那一行', () => {
      state.configured.mockReturnValue(widgets(20))
      const entries = extensionPromptEntries(OFF)
      expect(entries).toHaveLength(20)
      expect(entries.some((entry) => entry.name === 'widget-…')).toBe(false)
    })

    it('ED-W13 21 个：列 20 个 + 「还有 1 个」', () => {
      state.configured.mockReturnValue(widgets(21))
      const entries = extensionPromptEntries(OFF)
      expect(entries).toHaveLength(21)
      expect(entries.slice(0, 20).map((entry) => entry.name)).toEqual(
        Array.from({ length: 20 }, (_, i) => `widget-w-${i}`)
      )
      expect(entries[20]).toEqual({
        name: 'widget-…',
        hint: en.tool.extensionMoreWidgets.replace('{{count}}', '1')
      })
    })

    it('ED-W13 内置和第三方不占名额、也不被挤掉；开着的和被取消的不算数', () => {
      const ticked = widget('on-one', 'On')
      const out = widget('out-one', 'Out')
      state.configured.mockReturnValue([
        builtin('browser'),
        withTools('notes', [{ name: 'x' }]),
        ticked,
        out,
        ...widgets(22)
      ])
      const entries = extensionPromptEntries({
        names: ['mcp:widget-on-one'],
        optedOut: new Set(['mcp:widget-out-one'])
      })
      const names = entries.map((entry) => entry.name)
      expect(names.slice(0, 2)).toEqual(['browser', 'notes'])
      expect(names).not.toContain('widget-on-one')
      expect(names).not.toContain('widget-out-one')
      expect(entries).toHaveLength(2 + 20 + 1)
      expect(entries.at(-1)).toEqual({
        name: 'widget-…',
        hint: en.tool.extensionMoreWidgets.replace('{{count}}', '2')
      })
    })

    it('ED-W13 isExtensionOff：组件的勾选与取消同样算', () => {
      const row = widget('a-b', 'A')
      expect(isExtensionOff(row, OFF)).toBe(true)
      expect(isExtensionOff(row, { names: ['mcp:widget-a-b'], optedOut: new Set() })).toBe(false)
      expect(isExtensionOff(row, { names: [], optedOut: new Set(['mcp:widget-a-b']) })).toBe(false)
    })
  })

  describe('ED-W14 卡片上的来源', () => {
    it('ED-W14 组件：原样的显示名（卡片是 React 文本，不用过滤）；组件表里没有 → id', () => {
      const row = widget('a-b', 'Reading "list"')
      expect(extensionSourceOf(row)).toEqual({ type: 'widget', name: 'Reading "list"' })
      state.widgets.delete('a-b')
      expect(extensionSourceOf(row)).toEqual({ type: 'widget', name: 'a-b' })
    })

    it('ED-W14 名字带保留前缀但 id 不合规（`widget-foo`）的 inproc 行不是组件', () => {
      expect(extensionSourceOf(server('widget-foo', { type: 'inproc' }))).toEqual({
        type: 'builtin'
      })
    })
  })
})
