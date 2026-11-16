/**
 * settingsService —— 已知设置注册表（KNOWN_SETTINGS）的面。
 *
 * `getSettingKeyDescriptions()` 的文本会进 settings 工具的参数 description：注册表里留着
 * 一个已经没人读的键，等于教模型去写一个无效设置（写进去了、什么也不发生、模型还以为生效）。
 * 「默认项目智能体 / 默认聊天智能体」随「档案由会话形态推导」一并下线，自动审查开关也已下线，
 * 这里钉住它们不复活。
 *
 * - KS-1 已下线的默认智能体键不复活
 * - KS-2 已下线的自动审查开关 `security.autoReview` 不复活
 * - KS-3 默认思考等级 `general.defaultThinkingLevel` 在册（标签三语、说明列出可选档并写明缺省）
 * - KS-4 内置 timer 触发源开关 `triggers.timer.enabled` 在册（标签三语、说明写明 true | false 与缺省开）
 * - NK-R2 通知的三个开关在册（标签与问号说明三语、说明写明缺省开）；`notification.enabled` 不复活
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../dao/settingsDao', () => ({
  settingsDao: { findAll: vi.fn(() => ({})), findByKey: vi.fn(), upsert: vi.fn() }
}))
vi.mock('../../utils/appEventBus', () => ({ appEventBus: { publish: vi.fn() } }))

import { KNOWN_SETTINGS, getSettingKeyDescriptions } from '../settingsService'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import {
  DEFAULT_THINKING_LEVEL,
  SELECTABLE_THINKING_LEVELS
} from '@shuvix/chat-protocol/types/thinking'

describe('KNOWN_SETTINGS —— 会话根 Agent 的档案没有设置项', () => {
  it('KS-1 注册表不含 general.defaultProjectAgent / general.defaultChatAgent；描述文本里也没有它们的影子', () => {
    expect(KNOWN_SETTINGS).not.toHaveProperty('general.defaultProjectAgent')
    expect(KNOWN_SETTINGS).not.toHaveProperty('general.defaultChatAgent')

    const text = getSettingKeyDescriptions()
    expect(text).not.toContain('defaultProjectAgent')
    expect(text).not.toContain('defaultChatAgent')
    expect(text).not.toContain('agent profile name')

    // 正控制组：注册表与描述文本都不是空的
    expect(KNOWN_SETTINGS).toHaveProperty('general.defaultModel')
    expect(text).toContain('general.defaultModel')
  })
})

/**
 * 自动审查开关（`security.autoReview`）已下线：主进程不再读这个键，注册表里留着它就是教模型写一个
 * 什么也不做的设置。
 */
describe('KNOWN_SETTINGS —— 自动审查没有设置项', () => {
  it('KS-2 注册表不含 security.autoReview；描述文本里也没有它', () => {
    expect(KNOWN_SETTINGS).not.toHaveProperty('security.autoReview')
    expect(getSettingKeyDescriptions()).not.toContain('autoReview')
  })
})

/**
 * 默认思考等级（`general.defaultThinkingLevel`）—— 设置 → 通用 → 默认模型里的那一行，也是 settings
 * 工具能改的键。说明里列出的取值必须就是设置页画得出的那几档（顺序同选择器）、缺省必须是
 * `DEFAULT_THINKING_LEVEL`：模型照着说明写值，列错一档就是教它写一个会被当作「没设过」的值。
 */
describe('KNOWN_SETTINGS —— 默认思考等级', () => {
  const leaf = (bundle: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], bundle)

  it('KS-3 general.defaultThinkingLevel 在册：labelKey 为 settings.defaultThinkingLevel 且三语都有非空文案；desc 以可选档清单开头并写明缺省档', () => {
    const entry = KNOWN_SETTINGS['general.defaultThinkingLevel']
    expect(entry).toBeDefined()
    expect(entry.labelKey).toBe('settings.defaultThinkingLevel')
    for (const [lang, bundle] of Object.entries({ en, zh, ja })) {
      const label = leaf(bundle, entry.labelKey)
      expect(typeof label === 'string' && label.trim() !== '', `${lang} ${entry.labelKey}`).toBe(
        true
      )
    }
    expect(entry.desc.startsWith(SELECTABLE_THINKING_LEVELS.join(' | '))).toBe(true)
    expect(entry.desc).toContain(`default ${DEFAULT_THINKING_LEVEL}`)
    expect(getSettingKeyDescriptions()).toContain('general.defaultThinkingLevel')
  })
})

/**
 * 内置 timer 触发源（实验）的开关 —— 设置 → 触发源页那一个开关，也是 settings 工具能改的键。缺省开（没设过 =
 * 开着，见 triggerTimer.isBuiltinTimerEnabled）：说明里写错缺省，模型会以为要先写 true 才有定时 bot。
 */
describe('KNOWN_SETTINGS —— 内置 timer 触发源开关', () => {
  const leaf = (bundle: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], bundle)

  it('KS-4 triggers.timer.enabled 在册：labelKey 三语都有非空文案；desc 以 true | false 开头、写明缺省 true；进描述文本', () => {
    const entry = KNOWN_SETTINGS['triggers.timer.enabled']
    expect(entry).toBeDefined()
    expect(entry.labelKey).toBe('settings.triggersTimerEnabled')
    for (const [lang, bundle] of Object.entries({ en, zh, ja })) {
      const label = leaf(bundle, entry.labelKey)
      expect(typeof label === 'string' && label.trim() !== '', `${lang} ${entry.labelKey}`).toBe(
        true
      )
    }
    expect(entry.desc.startsWith('true | false')).toBe(true)
    expect(entry.desc).toContain('default true')
    expect(entry.desc).toContain('timer.fired')
    expect(getSettingKeyDescriptions()).toContain('triggers.timer.enabled')
  })
})

/**
 * 通知的三个开关 —— 设置 → 通用 → 通知，也是 settings 工具能改的键。设置页用 `settings.notification*` 这几条文案，
 * 少一种语言就是界面上露出一个键名。总开关 `notification.enabled` 已经没人读，留在描述文本里就是教模型写一个无效设置。
 */
describe('KNOWN_SETTINGS —— 通知开关', () => {
  const leaf = (bundle: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], bundle)

  const LABELS: Record<string, string> = {
    'notification.ask': 'settings.notificationAsk',
    'notification.done': 'settings.notificationDone',
    'notification.failed': 'settings.notificationFailed'
  }

  it('NK-R2 三个键的 labelKey 与说明；设置页要用的文案三语都有；描述文本列出它们、不含 notification.enabled', () => {
    for (const [key, labelKey] of Object.entries(LABELS)) {
      expect(KNOWN_SETTINGS[key].labelKey).toBe(labelKey)
      expect(KNOWN_SETTINGS[key].desc).toContain('default true')
    }

    const uiKeys = [
      ...Object.values(LABELS).flatMap((labelKey) => [labelKey, `${labelKey}Hint`]),
      'settings.notificationSection',
      'settings.notificationSectionHint'
    ]
    for (const [lang, bundle] of Object.entries({ en, zh, ja })) {
      for (const uiKey of uiKeys) {
        const text = leaf(bundle, uiKey)
        expect(typeof text === 'string' && text.trim() !== '', `${lang} ${uiKey}`).toBe(true)
      }
    }

    const text = getSettingKeyDescriptions()
    for (const key of Object.keys(LABELS)) expect(text).toContain(key)
    expect(text).not.toContain('notification.enabled')
    expect(KNOWN_SETTINGS).not.toHaveProperty(['notification.enabled'])
  })
})

/**
 * `web_search` 的搜索方式（`webSearch.provider`，2026-11-16）—— 设置 → LLM 工具 → web_search 里的三选一，也是
 * settings 工具能改的键。密钥不是设置项：settings 表是明文，`settings:get` 智能体与远程访问都读得到。
 */
describe('KNOWN_SETTINGS —— web_search 的搜索方式', () => {
  const leaf = (bundle: unknown, path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        bundle
      )

  it('ST-WS-1 webSearch.provider 在册：标签键、三个取值、缺省是浏览器、失败不换方式', () => {
    const entry = KNOWN_SETTINGS['webSearch.provider']
    expect(entry).toBeDefined()
    expect(entry.labelKey).toBe('settings.webSearchProvider')
    expect(entry.desc.startsWith('browser | tavily | exa')).toBe(true)
    expect(entry.desc).toMatch(/in-app browser[^;]*\(default\)/)
    expect(entry.desc).toContain('never replaced by another method')
    expect(getSettingKeyDescriptions()).toContain('webSearch.provider')
  })

  it('ST-WS-2 密钥不是设置项：注册表里没有搜索 API 密钥的键，描述文本里也没有', () => {
    const keys = Object.keys(KNOWN_SETTINGS)
    expect(keys.filter((k) => /webSearch.*(key|token|secret)/i.test(k))).toEqual([])
    expect(keys.filter((k) => /tavily|\bexa\b/i.test(k))).toEqual([])
    expect(keys.filter((k) => k.startsWith('webSearch.'))).toEqual(['webSearch.provider'])
    const text = getSettingKeyDescriptions()
    expect(text).not.toMatch(/webSearch\.[A-Za-z.]*(key|token|secret)/i)
    expect(text).not.toMatch(/apiKey/i)
  })

  it('ST-WS-3 设置页用到的文案三语都有，占位符同名', () => {
    const uiKeys = [
      'webSearchProvider',
      'webSearchBrowser',
      'webSearchBrowserHint',
      'webSearchBrowserSettings',
      'webSearchNoKey',
      'webSearchKeySaved',
      'webSearchKeyPlaceholder',
      'webSearchSave',
      'webSearchTest',
      'webSearchTesting',
      'webSearchDeleteKey',
      'webSearchMissingKey',
      'webSearchTestOk'
    ]
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
    const enSettings = (en as unknown as { settings: Record<string, string> }).settings
    expect(
      Object.keys(enSettings)
        .filter((k) => k.startsWith('webSearch'))
        .sort()
    ).toEqual([...uiKeys].sort())
    for (const [lang, bundle] of Object.entries({ en, zh, ja })) {
      for (const uiKey of uiKeys) {
        const text = leaf(bundle, `settings.${uiKey}`)
        expect(typeof text === 'string' && text.trim() !== '', `${lang} ${uiKey}`).toBe(true)
        expect(placeholders(text as string), `${lang} ${uiKey}`).toEqual(
          placeholders(enSettings[uiKey])
        )
      }
    }
    expect(placeholders(enSettings.webSearchBrowserHint)).toEqual(['engine'])
    expect(placeholders(enSettings.webSearchKeySaved)).toEqual(['last4'])
    expect(placeholders(enSettings.webSearchKeyPlaceholder)).toEqual(['name'])
    expect(placeholders(enSettings.webSearchTestOk)).toEqual(['count', 'seconds'])

    // 工具卡片上的提示不再说「在浏览器里搜」（选了 API 时那是错的）
    for (const bundle of [en, zh, ja]) {
      const hint = leaf(bundle, 'tool.webSearchHint') as string
      expect(typeof hint === 'string' && hint.trim() !== '').toBe(true)
    }
    expect(leaf(en, 'tool.webSearchHint')).not.toMatch(/search engine chosen there/i)
    expect(leaf(en, 'tool.webSearchHint')).toMatch(/search API/i)
  })
})
