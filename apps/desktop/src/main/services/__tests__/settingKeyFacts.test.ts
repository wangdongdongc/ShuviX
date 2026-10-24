/**
 * 设置项的 scope 与 access（`SETTING_KEY_FACTS`，2026-10-23，docs/network-scope/design.md）—— 远程设备经 settings:set
 * 写设置时按 key 判。这里核对：已知的每个设置 key 都落在一条明确的条目上，不靠「都不中 → system + admin」兜底。
 *
 *   SK-1 KNOWN_SETTINGS 的每个 key 都有明确条目
 *   SK-2 代码里另外读写的 key（不在 KNOWN_SETTINGS 里的常量与字面量）同样都有；含 botTriggerService 记各条绑定上一次
 *        跑成时刻的内部键 `triggers.bot.lastFired`（落在 `triggers.` → agents / admin），与 botService 记内置 bot id
 *        认定的 `bots.builtinFiles`（落在 `bots.` → agents / admin）
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../dao/settingsDao', () => ({ settingsDao: {} }))
vi.mock('../../utils/appEventBus', () => ({ appEventBus: { publish: () => {} } }))

import { KNOWN_SETTINGS } from '../settingsService'
import { settingKeyFactsOf } from '../../../shared/channelAccess'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 不在 KNOWN_SETTINGS 里、代码里却在读写的 key（新加一个就补在这里，并在 channelAccess.ts 里归类） */
const OTHER_KEYS = [
  'appearance.notebookTheme',
  'browser.devtoolsHeight',
  'browser.viewMode',
  'bots.builtinFiles',
  'general.classifierModel',
  'general.classifierProvider',
  'general.defaultChatAgent',
  'general.defaultProjectAgent',
  'network.enabled',
  'network.lan',
  'network.lanInterface',
  'network.port',
  'provider.oauthDeviceId',
  'session.autoResume',
  'shuvix.figureExport.prefs',
  'shuvix.mobile.fontSize',
  'triggers.bot.lastFired',
  'updates.autoCheck',
  'window.browserWindow',
  'window.mainBounds',
  'window.panelLayout',
  'window.pinnedBounds',
  'window.settingsBounds'
]

describe('SK 设置项都有明确的 scope 与 access', () => {
  it('SK-1 KNOWN_SETTINGS', () => {
    const unmatched = Object.keys(KNOWN_SETTINGS).filter((key) => !settingKeyFactsOf(key).matched)
    expect(
      unmatched,
      `这些设置 key 没有条目，请在 src/shared/channelAccess.ts 的 SETTING_KEY_FACTS 里归类：${unmatched.join(', ')}`
    ).toEqual([])
  })
  it('SK-2 代码里另外读写的 key', () => {
    expect(OTHER_KEYS.filter((key) => !settingKeyFactsOf(key).matched)).toEqual([])
    // bot 触发分发的内部状态（botTriggerService 的 LAST_FIRED_KEY，模块太重不在这里加载，按源码核对常量）：
    // 不在 KNOWN_SETTINGS 里，与触发源开关同归 agents / admin
    const source = readFileSync(join(__dirname, '..', 'botTriggerService.ts'), 'utf8')
    expect(source).toContain(`export const LAST_FIRED_KEY = 'triggers.bot.lastFired'`)
    expect(KNOWN_SETTINGS).not.toHaveProperty('triggers.bot.lastFired')
    expect(settingKeyFactsOf('triggers.bot.lastFired')).toEqual({
      scope: 'agents',
      access: 'admin',
      matched: 'triggers.'
    })
    // 内置 bot id 的认定（botService 的 BUILTIN_FILES_KEY）：远程设备改它等于给某份文件发放 daily-bot-access
    const bots = readFileSync(join(__dirname, '..', 'botService.ts'), 'utf8')
    expect(bots).toContain(`export const BUILTIN_FILES_KEY = 'bots.builtinFiles'`)
    expect(settingKeyFactsOf('bots.builtinFiles')).toEqual({
      scope: 'agents',
      access: 'admin',
      matched: 'bots.'
    })
  })
})
