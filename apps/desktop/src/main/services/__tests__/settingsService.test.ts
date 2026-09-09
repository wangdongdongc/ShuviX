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
