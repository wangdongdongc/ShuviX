/**
 * 内置 MCP 能力服务器的专属渲染（`builtinMcpPresentations.ts`）—— 工具名认领、折叠摘要、兜底呈现。
 *
 * 钉的是三件事：
 *   - **认名字要认全**：只有 `mcp__browser__<真实工具名>` / `mcp__ssh__<真实工具名>` /
 *     `mcp__database__<真实工具名>` 才拿得到「浏览器」「SSH」「远程数据库」的名字与图标。一台叫
 *     `browser__x` 的自定义 server 的工具 `mcp__browser__x__tool` 同样以 `mcp__browser__` 开头 ——
 *     它若也被认领，就能顶着内置浏览器的身份出现在询问卡片上；
 *   - **摘要**：每个工具「动作 + 最有信息量的那个参数」，一种优先级一条用例；
 *   - **兜底呈现**：宿主表里没有的内置 MCP 工具、退役的 multiplex `browser` 工具与退役的
 *     `database` 工具各有呈现，原型链上的名字（`constructor` / `toString` …）不算。
 *
 * 工具名清单与三台 server 真实工具目录的一致性由桌面侧的守护用例钉（chat-protocol 不能 import
 * agent-runtime，database server 只在桌面）；这里手抄一份清单，是为了让「清单里的每个名字都认得出」
 * 有一个独立的对照物。
 */
import { describe, expect, it } from 'vitest'
import en from './i18n/locales/en.json'
import zh from './i18n/locales/zh.json'
import ja from './i18n/locales/ja.json'
import {
  BUILTIN_MCP_PRESENTATIONS,
  builtinMcpToolSummary,
  fallbackToolPresentation,
  parseBuiltinMcpToolName
} from './builtinMcpPresentations'
import { buildToolSummary } from './toolSummaries'

/** 内置 browser server 的 22 个工具（CLAUDE.md「browser」一节的清单，按那里的顺序） */
const BROWSER_TOOLS = [
  'list_tabs',
  'open_tab',
  'close_tab',
  'navigate',
  'snapshot',
  'read_page',
  'screenshot',
  'click',
  'fill',
  'type',
  'press_key',
  'hover',
  'upload_file',
  'scroll',
  'wait_for',
  'evaluate',
  'network',
  'console',
  'pdf',
  'cdp',
  'events',
  'cdp_recipes'
]

/** 内置 ssh server 的 6 个工具 */
const SSH_TOOLS = ['list-hosts', 'exec', 'upload', 'download', 'sync', 'disconnect']

/** 内置 database server 的 2 个工具（仅桌面） */
const DATABASE_TOOLS = ['list-connections', 'query']

/** 把 key 原样包一层的 t —— 断言看得出「用的是哪个 key」，而不依赖文案 */
const T = (key: string): string => `T(${key})`

/** 按扁平键路径取语言包里的叶子（非字符串返回 undefined） */
function leaf(bundle: unknown, path: string): string | undefined {
  const found = path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], bundle)
  return typeof found === 'string' ? found : undefined
}

describe('parseBuiltinMcpToolName — 认名字要认全', () => {
  it('BMP-1 两台 server 的每个真实工具名都认得出（browser 22 个、ssh 6 个）', () => {
    expect(BROWSER_TOOLS).toHaveLength(22)
    expect(SSH_TOOLS).toHaveLength(6)
    for (const tool of BROWSER_TOOLS) {
      expect(parseBuiltinMcpToolName(`mcp__browser__${tool}`), tool).toEqual({
        server: 'browser',
        tool
      })
    }
    for (const tool of SSH_TOOLS) {
      expect(parseBuiltinMcpToolName(`mcp__ssh__${tool}`), tool).toEqual({ server: 'ssh', tool })
    }
    // 连字符的工具名原样保留（ssh 用 kebab-case，browser 用 snake_case）
    expect(parseBuiltinMcpToolName('mcp__ssh__list-hosts')).toEqual({
      server: 'ssh',
      tool: 'list-hosts'
    })
  })

  it('BMP-1b 手抄清单与表里的 toolNames 逐项一致（表里多一个、少一个都在这里看得见）', () => {
    expect([...BUILTIN_MCP_PRESENTATIONS.browser.toolNames].sort()).toEqual(
      [...BROWSER_TOOLS].sort()
    )
    expect([...BUILTIN_MCP_PRESENTATIONS.ssh.toolNames].sort()).toEqual([...SSH_TOOLS].sort())
  })

  it('BMP-1c database 的两个工具都认到 database 名下；手抄清单与表里的 toolNames 一致；表里恰是四台', () => {
    expect(DATABASE_TOOLS).toHaveLength(2)
    for (const tool of DATABASE_TOOLS) {
      expect(parseBuiltinMcpToolName(`mcp__database__${tool}`), tool).toEqual({
        server: 'database',
        tool
      })
    }
    expect([...BUILTIN_MCP_PRESENTATIONS.database.toolNames].sort()).toEqual(
      [...DATABASE_TOOLS].sort()
    )
    expect(Object.keys(BUILTIN_MCP_PRESENTATIONS).sort()).toEqual([
      'browser',
      'chrome',
      'database',
      'ssh'
    ])
  })

  it.each([
    // 冒名：一台叫 `browser__x` 的自定义 server 的工具
    'mcp__browser__x__tool',
    // 前缀对上、工具名不在清单里
    'mcp__browser__nope',
    'mcp__ssh__rm',
    // 前缀本身就不对
    'mcp__browserx__y',
    'mcp__browser__',
    'mcp__browser',
    'mcp__tavily__search',
    // 大小写不同的 server 名、被改名的自定义行、前缀之前多了东西
    'mcp__Browser__click',
    'mcp__ssh-custom__exec',
    'xmcp__browser__click',
    // database 同样：冒名、不在清单、空工具名、被改名的自定义行（v28 迁移给撞名行起的名字）、大小写
    'mcp__database__x__query',
    'mcp__database__nope',
    'mcp__database__',
    'mcp__database-custom__query',
    'mcp__Database__query',
    // 退役的 multiplex 工具名、退役的 database 工具名与空串
    'browser',
    'database',
    ''
  ])('BMP-2 %j 不认领', (name) => {
    expect(parseBuiltinMcpToolName(name)).toBeUndefined()
  })

  it('BMP-2b 冒名的工具拿不到浏览器的呈现，也没有摘要 —— 询问卡片上不会顶着「浏览器」出现', () => {
    expect(fallbackToolPresentation('mcp__browser__x__tool', T)).toBeUndefined()
    expect(builtinMcpToolSummary('mcp__browser__x__tool', { url: 'https://evil.example' })).toBe(
      undefined
    )
    expect(buildToolSummary('mcp__browser__x__tool', { url: 'https://evil.example' })).toBe(
      undefined
    )
  })
})

describe('browser 摘要 —— 动作 + 最有信息量的参数（一种优先级一条）', () => {
  const summary = (tool: string, args: Record<string, unknown>): string | undefined =>
    buildToolSummary(`mcp__browser__${tool}`, args)

  it.each<[string, Record<string, unknown>, string]>([
    ['open_tab', { url: 'https://a.example', text: 'ignored' }, 'open_tab https://a.example'],
    ['type', { uid: 'e5', text: 'hi' }, 'type hi'],
    // 空文本不算有信息量，落到 uid
    ['fill', { uid: 'e5', text: '' }, 'fill e5'],
    ['press_key', { key: 'Enter', tabId: 't1' }, 'press_key Enter'],
    // 绝对路径只露文件名，相对路径原样保留（更短且带上下文）
    [
      'upload_file',
      { uid: 'e1', paths: ['/Users/me/a.pdf', 'docs/b.png'] },
      'upload_file a.pdf, docs/b.png'
    ],
    ['cdp', { method: 'Network.enable' }, 'cdp Network.enable'],
    ['events', { event: 'Network.requestWillBeSent' }, 'events Network.requestWillBeSent'],
    ['evaluate', { expression: 'document.title\n.trim()' }, 'evaluate document.title'],
    ['pdf', { outputPath: '/Users/me/out/page.pdf' }, 'pdf page.pdf'],
    ['scroll', { direction: 'down', tabId: 't1' }, 'scroll down'],
    ['snapshot', { tabId: 't1' }, 'snapshot t1'],
    // 数字 tabId（扩展里是 Chrome 的数字 id）也算
    ['snapshot', { tabId: 42 }, 'snapshot 42'],
    ['screenshot', { tabId: 't1', uid: 'e2' }, 'screenshot e2']
  ])('BMP-4 %s %j → %j', (tool, args, expected) => {
    expect(summary(tool, args)).toBe(expected)
  })

  it('BMP-4b navigate：没有地址时露出 back / forward / reload；有地址时地址优先', () => {
    expect(summary('navigate', { nav: 'back', tabId: 't1' })).toBe('navigate back')
    expect(summary('navigate', { nav: 'reload', tabId: 't1' })).toBe('navigate reload')
    expect(summary('navigate', { nav: 'goto', url: 'https://b.example/x', tabId: 't1' })).toBe(
      'navigate https://b.example/x'
    )
  })

  it('BMP-4c evaluate 取第一个非空行（开头的空行与缩进不算）', () => {
    expect(summary('evaluate', { expression: '\n   \n  return document.title\nfoo()' })).toBe(
      'evaluate return document.title'
    )
    // 全是空白 → 只剩动作
    expect(summary('evaluate', { expression: '\n  \n' })).toBe('evaluate')
  })

  it('BMP-5 没有有信息量的参数 → 只剩动作；没有 args → 没有摘要', () => {
    expect(summary('list_tabs', {})).toBe('list_tabs')
    expect(summary('open_tab', { url: '  ' })).toBe('open_tab')
    expect(buildToolSummary('mcp__browser__list_tabs', undefined)).toBeUndefined()
    expect(buildToolSummary('mcp__ssh__exec', undefined)).toBeUndefined()
  })
})

describe('ssh 摘要 —— 主机在前，动作的要点在后', () => {
  const summary = (tool: string, args: Record<string, unknown>): string | undefined =>
    buildToolSummary(`mcp__ssh__${tool}`, args)

  it('BMP-6 exec / upload / download / sync / disconnect', () => {
    expect(summary('exec', { host: 'prod', command: 'ls', description: 'List files' })).toBe(
      'prod · List files'
    )
    expect(summary('exec', { host: 'prod', command: 'ls' })).toBe('prod')
    expect(
      summary('upload', { host: 'prod', localPath: '/Users/me/a.tar', remotePath: '/tmp/a.tar' })
    ).toBe('prod · a.tar → /tmp/a.tar')
    expect(
      summary('download', {
        host: 'prod',
        remotePath: '/var/log/x.log',
        localPath: '/Users/me/x.log'
      })
    ).toBe('prod · /var/log/x.log → x.log')
    expect(summary('sync', { host: 'prod', localPath: 'dist/', remotePath: '/srv/www' })).toBe(
      'prod · dist/ → /srv/www'
    )
    expect(
      summary('sync', {
        host: 'prod',
        localPath: 'dist/',
        remotePath: '/srv/www',
        direction: 'down'
      })
    ).toBe('prod · /srv/www → dist/')
    expect(summary('disconnect', { host: 'prod' })).toBe('prod')
  })

  it('BMP-6b 什么都没有 → 没有摘要（经 buildToolSummary 与直接调用都是 undefined，不是空串）', () => {
    for (const tool of ['list-hosts', 'exec', 'upload', 'download', 'sync', 'disconnect']) {
      expect(summary(tool, {}), tool).toBeUndefined()
      expect(builtinMcpToolSummary(`mcp__ssh__${tool}`, {}), tool).toBeUndefined()
    }
  })
})

describe('database 摘要 —— 连接名在前，这条查询在做什么在后', () => {
  const summary = (args: Record<string, unknown>): string | undefined =>
    buildToolSummary('mcp__database__query', args)

  it.each<[string, Record<string, unknown>, string]>([
    [
      '连接名 · 说明',
      { connection: 'prod', description: 'Count users', sql: 'SELECT count(*) FROM users' },
      'prod · Count users'
    ],
    // 模型没写说明 → 退到 SQL
    [
      '没有说明',
      { connection: 'prod', sql: 'SELECT count(*) FROM users' },
      'prod · SELECT count(*) FROM users'
    ],
    // 只有空白的说明不算说明
    [
      '说明只有空白',
      { connection: 'prod', description: '   ', sql: 'SELECT 1' },
      'prod · SELECT 1'
    ],
    // SQL 取第一个有内容的行，去掉缩进（开头的空行不算）
    [
      'SQL 以空行与缩进开头',
      { connection: 'prod', sql: '\n   \n    SELECT id\n  FROM users' },
      'prod · SELECT id'
    ],
    ['只有连接名', { connection: 'prod' }, 'prod'],
    ['只有说明', { description: 'Count users' }, 'Count users']
  ])('BMP-10 query：%s', (_label, args, expected) => {
    expect(summary(args)).toBe(expected)
    expect(builtinMcpToolSummary('mcp__database__query', args)).toBe(expected)
  })

  it('BMP-10b 什么都没有 → 没有摘要（undefined，不是空串）；list-connections 从不带摘要', () => {
    expect(summary({})).toBeUndefined()
    expect(builtinMcpToolSummary('mcp__database__query', {})).toBeUndefined()
    expect(summary({ description: '', sql: '  \n  ' })).toBeUndefined()
    // 无参工具：参数里就算有东西也不拿来写摘要
    expect(buildToolSummary('mcp__database__list-connections', {})).toBeUndefined()
    expect(
      builtinMcpToolSummary('mcp__database__list-connections', { connection: 'prod' })
    ).toBeUndefined()
  })

  it('BMP-11 退役的 `database` 工具：历史会话里的块摘要是说明；没写说明就没有摘要（它从不退到 SQL）', () => {
    expect(
      buildToolSummary('database', {
        credentialName: 'prod',
        sql: 'SELECT 1',
        description: 'Count users'
      })
    ).toBe('Count users')
    expect(buildToolSummary('database', { credentialName: 'prod', sql: 'SELECT 1' })).toBe(
      undefined
    )
    // 旧工具的名字不在内置 server 的名下：摘要只走 toolSummaries 的旧条目
    expect(builtinMcpToolSummary('database', { description: 'Count users' })).toBeUndefined()
  })
})

describe('fallbackToolPresentation —— 宿主表里没有时的呈现', () => {
  it('BMP-7 browser 工具 / ssh 普通工具 / ssh exec（终端形态）/ 退役的 browser 工具', () => {
    expect(fallbackToolPresentation('mcp__browser__snapshot', T)).toEqual({
      label: 'T(tool.browserLabel)',
      icon: 'Globe',
      iconColor: '#60a5fa'
    })
    expect(fallbackToolPresentation('mcp__ssh__list-hosts', T)).toEqual({
      label: 'T(tool.sshLabel)',
      icon: 'SquareTerminal',
      iconColor: '#38bdf8'
    })
    expect(fallbackToolPresentation('mcp__ssh__exec', T)).toEqual({
      label: 'T(tool.sshLabel)',
      icon: 'Terminal',
      iconColor: '#38bdf8',
      detailView: 'terminal'
    })
    // 历史会话里 multiplex `browser` 工具的块
    expect(fallbackToolPresentation('browser', T)).toEqual({
      label: 'T(tool.browserLabel)',
      icon: 'Globe',
      iconColor: '#60a5fa'
    })
  })

  it('BMP-7c database 的两个工具与退役的 database 工具：远程数据库的标签、Database 图标，没有详情形态', () => {
    for (const name of [
      'mcp__database__list-connections',
      'mcp__database__query',
      // 历史会话里旧 `database` 工具的块
      'database'
    ]) {
      expect(fallbackToolPresentation(name, T), name).toStrictEqual({
        label: 'T(tool.remoteDbLabel)',
        icon: 'Database',
        iconColor: '#f59e0b'
      })
    }
  })

  it.each(['mcp__tavily__search', 'read', 'ssh', 'constructor', '__proto__', 'toString', ''])(
    'BMP-7b %j → undefined（第三方工具、普通内置工具、原型链上的名字都不给呈现）',
    (name) => {
      expect(fallbackToolPresentation(name, T)).toBeUndefined()
    }
  )

  it('BMP-8 改动返回的对象不影响下一次调用', () => {
    for (const name of [
      'mcp__browser__click',
      'mcp__ssh__exec',
      'browser',
      'mcp__database__query',
      'database'
    ]) {
      const first = fallbackToolPresentation(name, T)!
      const before = { ...first }
      first.label = 'hacked'
      first.icon = 'Wrench'
      first.iconColor = '#f472b6'
      first.detailView = undefined
      expect(fallbackToolPresentation(name, T), name).toEqual(before)
    }
    // 表本身也没被改到
    expect(BUILTIN_MCP_PRESENTATIONS.browser.presentation).toEqual({
      icon: 'Globe',
      iconColor: '#60a5fa'
    })
    expect(BUILTIN_MCP_PRESENTATIONS.database.presentation).toEqual({
      icon: 'Database',
      iconColor: '#f59e0b'
    })
  })

  it('BMP-9 每个 labelKey 在三语里都是非空字符串；zh 是「浏览器」「SSH」与「远程数据库」', () => {
    const keys = [
      ...Object.values(BUILTIN_MCP_PRESENTATIONS).map((def) => def.labelKey),
      // 退役的 browser / database 工具走同一个 key（经兜底呈现取）
      'tool.browserLabel',
      'tool.remoteDbLabel'
    ]
    for (const key of keys) {
      for (const [lang, bundle] of Object.entries({ en, zh, ja })) {
        const text = leaf(bundle, key)
        expect(text, `${lang}:${key}`).toBeTypeOf('string')
        expect(text!.trim(), `${lang}:${key}`).not.toBe('')
      }
    }
    expect(leaf(zh, BUILTIN_MCP_PRESENTATIONS.browser.labelKey)).toBe('浏览器')
    expect(leaf(zh, BUILTIN_MCP_PRESENTATIONS.ssh.labelKey)).toBe('SSH')
    expect(leaf(zh, BUILTIN_MCP_PRESENTATIONS.database.labelKey)).toBe('远程数据库')
  })
})
