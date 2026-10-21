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
 */
import { describe, expect, it } from 'vitest'
import { API_OVERRIDE_CHANNELS, API_TABLE } from '../apiTable'
import {
  CHANNEL_ACCESS,
  channelAccessOf,
  channelCallAccessOf,
  type ChannelAccess
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
