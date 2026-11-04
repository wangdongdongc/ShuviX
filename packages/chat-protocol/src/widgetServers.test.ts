/**
 * 组件的 MCP 服务器名字（`widgetServers.ts`）—— 每个有 API 的组件是一台 `widget-<id>`，操作是 `mcp__widget-<id>__<op>`。
 * 这些名字是好几层的接头：勾选（算读授权）、保留前缀（用户的服务器不能占）、工具卡片（只凭前缀认组件）。
 *
 *   WS-1  拼名字的几个函数：逐字
 *   WS-2  保留前缀：`widget-` 开头（不分大小写）才算；`widget`、`widgets-a`、`my-widget-a` 不算
 *   WS-3  服务器名 → id：id 不合规的 `widget-foo` 不是组件（区分大小写）
 *   WS-4  勾选项是不是组件：只认 `mcp:` 开头的加项；取消记号、别的服务器都不是
 *   WS-5  工具名长度：恰 64 放得下，65 放不下
 *   WS-6  解析工具名：与拼出来的来回一致；各种不是组件工具的写法都不认
 *   WS-7  三门语言都有组件要用的文案，占位符都在
 */
import { describe, expect, it } from 'vitest'
import en from './i18n/locales/en.json'
import ja from './i18n/locales/ja.json'
import zh from './i18n/locales/zh.json'
import {
  isReservedMcpServerName,
  isWidgetSelectionEntry,
  parseWidgetToolName,
  WIDGET_ID_REGEX,
  WIDGET_SKILL,
  WIDGET_TOOL_NAME,
  widgetIdOfServer,
  widgetSelectionEntry,
  widgetServerId,
  widgetServerName,
  widgetToolName,
  widgetToolNameFits
} from './widgetServers'

describe('WS-1 拼名字', () => {
  it('WS-1 服务器名 / 配置行 id / 勾选项 / 工具名逐字', () => {
    expect(widgetServerName('reading-list')).toBe('widget-reading-list')
    expect(widgetServerId('reading-list')).toBe('widget-server:reading-list')
    expect(widgetSelectionEntry('reading-list')).toBe('mcp:widget-reading-list')
    expect(widgetToolName('reading-list', 'addBook')).toBe('mcp__widget-reading-list__addBook')
    expect(WIDGET_TOOL_NAME).toBe('widget')
    expect(WIDGET_SKILL).toBe('builtin:widget')
  })
})

describe('WS-2 保留前缀', () => {
  it.each(['widget-x', 'widget-a-b', 'widget-', 'Widget-a-b', 'WIDGET-X'])(
    'WS-2 %s 是保留的',
    (n) => {
      expect(isReservedMcpServerName(n)).toBe(true)
    }
  )

  it.each(['widget', 'widgets-a', 'my-widget-a', 'custom-widget-a', 'browser', ''])(
    'WS-2 %j 不是保留的',
    (n) => {
      expect(isReservedMcpServerName(n)).toBe(false)
    }
  )
})

describe('WS-3 服务器名 → 组件 id', () => {
  it('WS-3 合规的 id', () => {
    expect(widgetIdOfServer('widget-a-b')).toBe('a-b')
    expect(widgetIdOfServer('widget-reading-list-2')).toBe('reading-list-2')
  })

  it.each(['widget-foo', 'widget-A-b', 'Widget-a-b', 'widget-', 'browser', 'a-b', 'widget-a--b'])(
    'WS-3 %s 不是组件',
    (name) => {
      expect(widgetIdOfServer(name)).toBeUndefined()
    }
  )

  it('WS-3 id 的规则：kebab-case，至少一个短横', () => {
    expect(WIDGET_ID_REGEX.test('a-b')).toBe(true)
    expect(WIDGET_ID_REGEX.test('foo')).toBe(false)
    expect(WIDGET_ID_REGEX.test('A-b')).toBe(false)
  })
})

describe('WS-4 勾选项是不是组件', () => {
  it('WS-4 mcp:widget-<合规 id> 是', () => {
    expect(isWidgetSelectionEntry('mcp:widget-a-b')).toBe(true)
  })

  it.each(['-mcp:widget-a-b', 'mcp:widget-foo', 'mcp:browser', 'widget-a-b', 'mcp:Widget-a-b', ''])(
    'WS-4 %j 不是',
    (entry) => {
      expect(isWidgetSelectionEntry(entry)).toBe(false)
    }
  )
})

describe('WS-5 工具名长度', () => {
  // `mcp__widget-a-b__` 是 17 个字符
  it('WS-5 恰 64 放得下，65 放不下', () => {
    const fits = 'o'.repeat(64 - 'mcp__widget-a-b__'.length)
    expect(widgetToolName('a-b', fits)).toHaveLength(64)
    expect(widgetToolNameFits('a-b', fits)).toBe(true)
    expect(widgetToolName('a-b', `${fits}o`)).toHaveLength(65)
    expect(widgetToolNameFits('a-b', `${fits}o`)).toBe(false)
  })

  it('WS-5 id 长的时候操作名要短：同一个操作名换个长 id 就放不下', () => {
    expect(widgetToolNameFits('a-b', 'listEverything')).toBe(true)
    expect(widgetToolNameFits(`long-${'x'.repeat(50)}`, 'listEverything')).toBe(false)
  })
})

describe('WS-6 解析工具名', () => {
  it.each([
    ['a-b', 'addNote'],
    ['reading-list', 'list'],
    ['reading-list-2', 'x'],
    ['a-b', 'op2Go'],
    ['a-b', `o${'p'.repeat(47)}`]
  ])('WS-6 %s / %s 来回一致', (widgetId, op) => {
    expect(parseWidgetToolName(widgetToolName(widgetId, op))).toEqual({ widgetId, op })
  })

  it.each([
    'widget',
    'mcp__browser__click',
    'mcp__widget-foo__op',
    'mcp__widget-a-b__',
    'mcp__widget-a-b__a__b',
    'mcp__widget-a-b__Add',
    'mcp__widget-a-b__1op',
    'mcp__widget-a-b__add_note',
    'mcp__Widget-a-b__op',
    'xmcp__widget-a-b__op',
    'mcp__widget-a-b__op '
  ])('WS-6 %j 不是组件的工具', (name) => {
    expect(parseWidgetToolName(name)).toBeUndefined()
  })
})

describe('WS-7 组件要用的文案', () => {
  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ] as const)('WS-7 %s：四句都有，占位符不丢', (_lang, locale) => {
    expect(locale.tool.extensionWidgetHint).toContain('{{name}}')
    expect(locale.tool.extensionMoreWidgets).toContain('{{count}}')
    expect(locale.toolCall.extensionAskWidget.length).toBeGreaterThan(0)
    expect(locale.input.extensionWidgetBadge.length).toBeGreaterThan(0)
    // 给模型看的那一句要告诉它用什么找：写着工具名
    expect(locale.tool.extensionMoreWidgets).toContain('tool_search')
  })
})
