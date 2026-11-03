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
 * mcpService 替身（只给配置表）；i18next 用真的，三份语言文件都加载（getFixedT 要读它们）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'

const state = vi.hoisted(() => ({ configured: vi.fn<() => McpServer[]>() }))

vi.mock('../mcpService', () => ({ mcpService: { configuredServers: state.configured } }))

import {
  exactExtensionName,
  extensionChoiceLine,
  extensionPromptEntries,
  extensionSourceOf,
  findExtensions,
  isExtensionOff,
  offeredServers,
  rankExtensionDocuments
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
