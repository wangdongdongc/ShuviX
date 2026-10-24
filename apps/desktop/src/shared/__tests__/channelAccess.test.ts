/**
 * `CHANNEL_ACCESS`（安全策略的事实 `object.access`）—— 每条请求通道的访问级别。表与通道表的一致性在这里核对：
 * 请求通道 = `API_TABLE` 与 `API_OVERRIDE_CHANNELS` 里种类为 invoke / send 的通道（与网络分发器同一口径）。
 *
 *   CA-1 每条请求通道都有一条归类（缺了就列出来，叫人去 channelAccess.ts 里归类）
 *   CA-2 没有一条归类的不是请求通道（event 通道、已删掉的通道都不该留着）
 *   CA-3 每个值都是 read / write / admin 之一
 *   CA-4 `channelAccessOf` 对不认识的通道回 admin（最严）
 *   CA-5 几条钉死的抽查（策略写入是 admin、会话列表是 read、发消息是 write ……）
 *   CA-6 会话权限表：读是 read，增删改都是 admin
 *   CA-7 channelCallAccessOf：回答询问卡勾了「允许并记住」→ admin（与 session:grantAcl 同档），别的回答照通道那一档；
 *        别的通道就算参数长得像也照通道那一档
 *   XS-41 会话询问的「允许并记住」（`extra.remember`）同样往权限表里写一行 → admin；按真值判（与 rememberPath 同口径）；
 *        输入框 @ 会话的候选（session:mentionEntries）是 read 的请求通道
 *
 * scope（`object.scope`，2026-10-23，docs/network-scope/design.md）：
 *   CS-1 每条请求通道都有 scope：要么点名在 CHANNEL_SCOPE_OVERRIDES，要么所在分组在 GROUP_SCOPE
 *   CS-2 没有多余的：GROUP_SCOPE 的每个分组都有请求通道，CHANNEL_SCOPE_OVERRIDES 的每个键都是请求通道
 *   CS-3 取值都在词表里，词表里每个 scope 都有通道或设置项落进来；不在任何分组里的通道 → system
 *   CS-4 抽查：页面每次加载都调的读取是 app；会话权限表、停用内置、远程访问是 security ……
 *   CS-5 settingKeyFactsOf：精确 key 优先、其次最长前缀、都不中 → system + admin；非字符串 / 空串同样
 *   CS-6 channelCallFactsOf：settings:set 按 key；勾了「记住」的回答 → security + admin；别的照通道
 */
import { describe, expect, it } from 'vitest'
import { API_OVERRIDE_CHANNELS, API_TABLE } from '../apiTable'
import {
  CHANNEL_ACCESS,
  CHANNEL_SCOPES,
  CHANNEL_SCOPE_OVERRIDES,
  GROUP_SCOPE,
  SETTING_KEY_FACTS,
  channelAccessOf,
  channelCallAccessOf,
  channelCallFactsOf,
  channelGroupOf,
  channelScopeOf,
  settingKeyFactsOf,
  type ChannelAccess,
  type ChannelScope
} from '../channelAccess'

/** 通道表 + override 里的请求通道（invoke / send） */
function requestChannels(): Set<string> {
  const channels = new Set<string>()
  for (const ns of Object.values(API_TABLE)) {
    for (const member of Object.values(ns)) {
      if (member.kind === 'invoke' || member.kind === 'send') channels.add(member.channel)
    }
  }
  for (const ns of Object.values(API_OVERRIDE_CHANNELS)) {
    for (const member of Object.values(ns)) {
      if (member !== null && (member.kind === 'invoke' || member.kind === 'send')) {
        channels.add(member.channel)
      }
    }
  }
  return channels
}

const REQUEST_CHANNELS = requestChannels()
const KEYS = Object.keys(CHANNEL_ACCESS)

describe('CA-1 每条请求通道都有归类', () => {
  it('CA-1 API_TABLE 与 API_OVERRIDE_CHANNELS 的每条 invoke / send 通道都在 CHANNEL_ACCESS 里', () => {
    const missing = [...REQUEST_CHANNELS].filter((c) => !Object.hasOwn(CHANNEL_ACCESS, c)).sort()
    expect(
      missing,
      `这些请求通道没有访问级别，请在 src/shared/channelAccess.ts 里给它们归类（read / write / admin）：${missing.join(', ')}`
    ).toEqual([])
  })
})

describe('CA-2 没有多余的归类', () => {
  it('CA-2 CHANNEL_ACCESS 的每个键都是一条请求通道', () => {
    const stale = KEYS.filter((c) => !REQUEST_CHANNELS.has(c)).sort()
    expect(
      stale,
      `这些条目不是（或已不是）请求通道，请从 src/shared/channelAccess.ts 里删掉：${stale.join(', ')}`
    ).toEqual([])
    expect(KEYS.length).toBe(REQUEST_CHANNELS.size)
  })
})

describe('CA-3 取值', () => {
  it('CA-3 每个值都是 read / write / admin 之一', () => {
    const allowed: ReadonlySet<string> = new Set<ChannelAccess>(['read', 'write', 'admin'])
    for (const key of KEYS) expect(allowed.has(CHANNEL_ACCESS[key]), key).toBe(true)
  })
})

describe('CA-4 不认识的通道', () => {
  it('CA-4 channelAccessOf 对不在表里的通道回 admin', () => {
    expect(channelAccessOf('no-such:channel')).toBe('admin')
    expect(channelAccessOf('')).toBe('admin')
    // 原型链上的名字不算在表里
    expect(channelAccessOf('toString')).toBe('admin')
    expect(channelAccessOf('__proto__')).toBe('admin')
    // 表里有的照表回
    for (const key of KEYS) expect(channelAccessOf(key), key).toBe(CHANNEL_ACCESS[key])
  })
})

describe('CA-5 抽查', () => {
  it.each<[string, ChannelAccess]>([
    // 改安全 / 配置
    ['policy:create', 'admin'],
    ['policy:delete', 'admin'],
    ['hook:create', 'admin'],
    ['settings:set', 'admin'],
    ['mdMeta:setEnabled', 'admin'],
    ['network:setPort', 'admin'],
    ['provider:updateConfig', 'admin'],
    ['update:install', 'admin'],
    // 返回值带机密
    ['provider:listAll', 'admin'],
    ['mcp:list', 'admin'],
    ['browser-data:site-details', 'admin'],
    // 驱动 agent / 改用户数据
    ['agent:prompt', 'write'],
    ['agent:abort', 'write'],
    ['agent:respondToInput', 'write'],
    ['session:create', 'write'],
    ['session:delete', 'write'],
    ['files:write', 'write'],
    ['terminal:write', 'write'],
    ['app:open-external', 'write'],
    // 只读
    ['session:list', 'read'],
    ['session:getById', 'read'],
    ['message:list', 'read'],
    ['policy:list', 'read'],
    ['provider:listAvailableModels', 'read'],
    ['network:status', 'read'],
    ['knowledge:baseOptions', 'read']
  ])('CA-5 %s → %s', (channel, access) => {
    expect(REQUEST_CHANNELS.has(channel), channel).toBe(true)
    expect(channelAccessOf(channel)).toBe(access)
  })
})

describe('CA-6 会话权限表', () => {
  it.each<[string, ChannelAccess]>([
    ['session:listAcl', 'read'],
    ['session:grantAcl', 'admin'],
    ['session:setAclAccess', 'admin'],
    ['session:removeAclEntry', 'admin']
  ])('CA-6 %s → %s', (channel, access) => {
    expect(REQUEST_CHANNELS.has(channel), channel).toBe(true)
    expect(channelAccessOf(channel)).toBe(access)
  })
})

describe('CA-7 channelCallAccessOf', () => {
  const answer = (extra?: Record<string, unknown>): unknown[] => [
    {
      sessionId: 's1',
      requestId: 'r1',
      response: { kind: 'ask', allowed: true, ...(extra ? { extra } : {}) }
    }
  ]
  it('CA-7 勾了「允许并记住」→ admin；别的回答 → write', () => {
    expect(channelCallAccessOf('agent:respondToInput', answer({ rememberPath: true }))).toBe(
      'admin'
    )
    expect(channelCallAccessOf('agent:respondToInput', answer())).toBe('write')
    expect(channelCallAccessOf('agent:respondToInput', answer({ rememberPath: false }))).toBe(
      'write'
    )
    expect(channelCallAccessOf('agent:respondToInput', [])).toBe('write')
    expect(channelCallAccessOf('agent:respondToInput', [null])).toBe('write')
  })
  it('CA-7 别的通道照通道那一档', () => {
    expect(channelCallAccessOf('agent:prompt', answer({ rememberPath: true }))).toBe('write')
    expect(channelCallAccessOf('session:list', [])).toBe('read')
    expect(channelCallAccessOf('no:such-channel', [])).toBe('admin')
  })
})

/**
 * XS-41 会话询问卡上的「允许并记住」：应答带 `extra.remember`（路径询问是 `extra.rememberPath`），宿主据此往会话
 * 权限表里写一行 `kind: 'session'` —— 与 session:grantAcl 同一档（admin）。判的是真值（`!!remember`），与
 * rememberPath 同口径：只许 write 的设备送一个 `'yes'` 也得按 admin 拦（安全模块只在 `remember === true` 时记住，
 * 这里宁可多拦）。
 */
describe('XS-41 会话询问的「允许并记住」与 @ 会话候选', () => {
  const answer = (extra?: Record<string, unknown>): unknown[] => [
    {
      sessionId: 's1',
      requestId: 'r1',
      response: { kind: 'ask', allowed: true, ...(extra ? { extra } : {}) }
    }
  ]

  it.each<[string, Record<string, unknown>, ChannelAccess]>([
    ['remember: true', { remember: true }, 'admin'],
    ['remember: false', { remember: false }, 'write'],
    ["remember: 'yes'（真值）", { remember: 'yes' }, 'admin'],
    ["remember: ''（假值）", { remember: '' }, 'write'],
    ['remember: 0（假值）', { remember: 0 }, 'write'],
    ['remember: true + rememberPath: false', { remember: true, rememberPath: false }, 'admin'],
    ['remember: false + rememberPath: true', { remember: false, rememberPath: true }, 'admin'],
    ['别的键', { note: 'x' }, 'write']
  ])('XS-41 agent:respondToInput %s → %s', (_label, extra, access) => {
    expect(channelCallAccessOf('agent:respondToInput', answer(extra))).toBe(access)
  })

  it('XS-41 别的通道带 remember 也照通道那一档', () => {
    expect(channelCallAccessOf('agent:prompt', answer({ remember: true }))).toBe('write')
    expect(channelCallAccessOf('session:list', answer({ remember: true }))).toBe('read')
  })

  it('XS-41 session:mentionEntries 是请求通道、read（API_TABLE.mentions.listSessions）', () => {
    expect(REQUEST_CHANNELS.has('session:mentionEntries')).toBe(true)
    expect(API_TABLE.mentions.listSessions).toMatchObject({
      kind: 'invoke',
      channel: 'session:mentionEntries'
    })
    expect(CHANNEL_ACCESS['session:mentionEntries']).toBe('read')
    expect(channelAccessOf('session:mentionEntries')).toBe('read')
    expect(channelCallAccessOf('session:mentionEntries', [{ query: 'x' }])).toBe('read')
  })
})

describe('CS-1 每条请求通道都有 scope', () => {
  it('CS-1 点名在 CHANNEL_SCOPE_OVERRIDES，或所在分组在 GROUP_SCOPE', () => {
    const missing = [...REQUEST_CHANNELS]
      .filter(
        (c) =>
          !Object.hasOwn(CHANNEL_SCOPE_OVERRIDES, c) &&
          !Object.hasOwn(GROUP_SCOPE, channelGroupOf(c))
      )
      .sort()
    expect(
      missing,
      `这些请求通道没有 scope，请在 src/shared/channelAccess.ts 的 GROUP_SCOPE（整个分组）或 CHANNEL_SCOPE_OVERRIDES 里归类：${missing.join(', ')}`
    ).toEqual([])
  })
})

describe('CS-2 没有多余的 scope 归类', () => {
  it('CS-2 GROUP_SCOPE 的分组都有请求通道；CHANNEL_SCOPE_OVERRIDES 的键都是请求通道', () => {
    const groups = new Set([...REQUEST_CHANNELS].map((c) => channelGroupOf(c)))
    expect(Object.keys(GROUP_SCOPE).filter((g) => !groups.has(g))).toEqual([])
    expect(Object.keys(CHANNEL_SCOPE_OVERRIDES).filter((c) => !REQUEST_CHANNELS.has(c))).toEqual([])
  })
})

describe('CS-3 取值', () => {
  it('CS-3 都在词表里；每个 scope 都用得上；不认识的通道 → system', () => {
    const vocabulary: ReadonlySet<string> = new Set(CHANNEL_SCOPES)
    for (const [k, v] of Object.entries(GROUP_SCOPE)) expect(vocabulary.has(v), k).toBe(true)
    for (const [k, v] of Object.entries(CHANNEL_SCOPE_OVERRIDES))
      expect(vocabulary.has(v), k).toBe(true)
    for (const [k, v] of Object.entries(SETTING_KEY_FACTS))
      expect(vocabulary.has(v.scope), k).toBe(true)
    const used = new Set<string>([
      ...[...REQUEST_CHANNELS].map((c) => channelScopeOf(c)),
      ...Object.values(SETTING_KEY_FACTS).map((f) => f.scope)
    ])
    expect(CHANNEL_SCOPES.filter((scope) => !used.has(scope))).toEqual([])
    expect(CHANNEL_SCOPES).toHaveLength(15)
    expect(channelScopeOf('no-such:channel')).toBe('system')
    expect(channelScopeOf('')).toBe('system')
    expect(channelScopeOf('toString')).toBe('system')
  })
})

describe('CS-4 抽查', () => {
  it.each<[string, ChannelScope]>([
    // 页面每次加载都调（useAppInit 与外壳）
    ['settings:getAll', 'app'],
    ['settings:getKnownKeys', 'app'],
    ['project:getKnownFields', 'app'],
    ['tools:presentations', 'app'],
    ['app:window-ready', 'app'],
    ['notification:reportActiveSession', 'app'],
    ['notification:consumePendingOpenSession', 'app'],
    ['mdMeta:get', 'app'],
    // 会话
    ['agent:prompt', 'sessions'],
    ['agent:respondToInput', 'sessions'],
    ['session:list', 'sessions'],
    ['session:delete', 'sessions'],
    ['session:mentionEntries', 'sessions'],
    ['calendar:openReport', 'sessions'],
    ['bgTask:stop', 'sessions'],
    ['sync:frame', 'sessions'],
    ['project:list', 'projects'],
    ['files:read', 'files'],
    ['files:write', 'files'],
    ['fs:listDirectories', 'files'],
    ['liveDoc:attach', 'files'],
    ['artifact:read', 'files'],
    ['terminal:write', 'terminal'],
    ['browser-view:navigate', 'browser'],
    ['browser-data:site-details', 'browser'],
    ['widget:open', 'widgets'],
    ['widgetWindow:open', 'widgets'],
    ['knowledge:createEntry', 'knowledge'],
    ['knowledge:mentionEntries', 'knowledge'],
    ['subAgent:save', 'agents'],
    ['bot:createNew', 'agents'],
    ['mdMeta:setFill', 'agents'],
    ['mcp:add', 'extensions'],
    ['skill:update', 'extensions'],
    ['dbCredential:add', 'extensions'],
    ['chromeExtension:repair', 'extensions'],
    ['provider:listAll', 'models'],
    ['provider:oauthLogin', 'models'],
    // 安全：策略、hooks、会话权限表、停用内置、远程访问
    ['policy:create', 'security'],
    ['hook:delete', 'security'],
    ['session:listAcl', 'security'],
    ['session:grantAcl', 'security'],
    ['mdMeta:setEnabled', 'security'],
    ['network:setEnabled', 'security'],
    ['tts:speakOnce', 'preferences'],
    ['tts:setupQwen3', 'preferences'],
    ['telegram:addBot', 'telegram'],
    ['update:install', 'system'],
    ['config:applyImport', 'system'],
    ['httpLog:list', 'system'],
    ['classifierLog:list', 'system'],
    // 没给 key 的 settings:set 按最严
    ['settings:set', 'system']
  ])('CS-4 %s → %s', (channel, scope) => {
    expect(REQUEST_CHANNELS.has(channel), channel).toBe(true)
    expect(channelScopeOf(channel)).toBe(scope)
  })
})

describe('CS-5 settingKeyFactsOf', () => {
  it.each<[unknown, ChannelScope, ChannelAccess, string]>([
    ['general.theme', 'preferences', 'write', 'general.theme'],
    ['general.language', 'preferences', 'write', 'general.language'],
    ['appearance.focusMode', 'preferences', 'write', 'appearance.'],
    ['voice.tts.openai.voice', 'preferences', 'write', 'voice.'],
    ['browser.searchEngine', 'browser', 'write', 'browser.'],
    // 最长前缀：tool.browser. 不落到 browser.
    ['tool.browser.ignoreCertificateErrors', 'browser', 'admin', 'tool.browser.'],
    ['general.defaultModel', 'models', 'admin', 'general.defaultModel'],
    ['general.defaultChatAgent', 'agents', 'admin', 'general.defaultChatAgent'],
    ['session.autoResume', 'sessions', 'admin', 'session.'],
    ['sandbox.enabled', 'security', 'admin', 'sandbox.'],
    ['general.classifierModel', 'security', 'admin', 'general.classifierModel'],
    ['network.enabled', 'security', 'admin', 'network.'],
    ['httpLog.enabled', 'system', 'admin', 'httpLog.'],
    ['updates.autoCheck', 'system', 'admin', 'updates.'],
    // 都不中 → 最严；非字符串、空串同样
    ['general.somethingNew', 'system', 'admin', ''],
    ['nope', 'system', 'admin', ''],
    ['', 'system', 'admin', ''],
    [undefined, 'system', 'admin', ''],
    [42, 'system', 'admin', '']
  ])('CS-5 %s → %s / %s', (key, scope, access, matched) => {
    expect(settingKeyFactsOf(key)).toEqual({ scope, access, matched })
  })
})

describe('CS-6 channelCallFactsOf', () => {
  it('CS-6 settings:set 按 key；参数缺了按最严', () => {
    expect(channelCallFactsOf('settings:set', [{ key: 'general.theme', value: 'dark' }])).toEqual({
      scope: 'preferences',
      access: 'write'
    })
    expect(
      channelCallFactsOf('settings:set', [{ key: 'sandbox.enabled', value: 'false' }])
    ).toEqual({ scope: 'security', access: 'admin' })
    expect(channelCallFactsOf('settings:set', [])).toEqual({ scope: 'system', access: 'admin' })
    expect(channelCallFactsOf('settings:set', [null])).toEqual({ scope: 'system', access: 'admin' })
    expect(channelCallAccessOf('settings:set', [{ key: 'general.theme' }])).toBe('write')
  })
  it('CS-6 勾了「记住」的回答 → security + admin；别的照通道', () => {
    const remember = [{ response: { kind: 'ask', allowed: true, extra: { remember: true } } }]
    expect(channelCallFactsOf('agent:respondToInput', remember)).toEqual({
      scope: 'security',
      access: 'admin'
    })
    expect(channelCallFactsOf('agent:respondToInput', [])).toEqual({
      scope: 'sessions',
      access: 'write'
    })
    expect(channelCallFactsOf('terminal:write', [{ key: 'sandbox.enabled' }])).toEqual({
      scope: 'terminal',
      access: 'write'
    })
    expect(channelCallFactsOf('no:such-channel', [])).toEqual({ scope: 'system', access: 'admin' })
  })
})
