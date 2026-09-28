/**
 * settingsService —— 已知设置注册表（KNOWN_SETTINGS）的面。
 *
 * `getSettingKeyDescriptions()` 的文本会进 settings 工具的参数 description：注册表里留着
 * 一个已经没人读的键，等于教模型去写一个无效设置（写进去了、什么也不发生、模型还以为生效）。
 * 「默认项目智能体 / 默认聊天智能体」随「档案由会话形态推导」一并下线，这里钉住它们不复活。
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
 * 自动审查开关（`security.autoReview`）—— 主进程现读、缺省开，只有字面 'false' 才关。
 * 注册表那一行同时是设置页的标签（labelKey）与 settings 工具的参数说明（desc）：标签键三语都得解析得出，
 * 说明得把取值与缺省写明 —— 模型据此改设置，没写缺省它就猜不到「不写 = 开」。
 */
describe('KNOWN_SETTINGS —— 自动审查开关', () => {
  const leaf = (bundle: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], bundle)

  it("KS-2 security.autoReview 在册：labelKey 为 settings.autoReview 且三语都有非空文案；desc 以 'true | false' 开头并写明 default true", () => {
    const entry = KNOWN_SETTINGS['security.autoReview']
    expect(entry).toBeDefined()
    expect(entry.labelKey).toBe('settings.autoReview')
    for (const [lang, bundle] of Object.entries({ en, zh, ja })) {
      const label = leaf(bundle, entry.labelKey)
      expect(typeof label === 'string' && label.trim() !== '', `${lang} ${entry.labelKey}`).toBe(
        true
      )
    }
    expect(entry.desc.startsWith('true | false')).toBe(true)
    expect(entry.desc).toContain('default true')
    // 描述文本（settings 工具的参数说明）里确实带上了这一行
    expect(getSettingKeyDescriptions()).toContain('security.autoReview')
  })
})
