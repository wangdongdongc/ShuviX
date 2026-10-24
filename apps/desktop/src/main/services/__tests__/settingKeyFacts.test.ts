/**
 * 设置项的 scope 与 access（`SETTING_KEY_FACTS`，2026-10-23，docs/network-scope/design.md）—— 远程设备经 settings:set
 * 写设置时按 key 判。这里核对：已知的每个设置 key 都落在一条明确的条目上，不靠「都不中 → system + admin」兜底。
 *
 *   SK-1 KNOWN_SETTINGS 的每个 key 都有明确条目
 *   SK-2 代码里另外读写的 key（不在 KNOWN_SETTINGS 里的常量与字面量）同样都有
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../dao/settingsDao', () => ({ settingsDao: {} }))
vi.mock('../../utils/appEventBus', () => ({ appEventBus: { publish: () => {} } }))

import { KNOWN_SETTINGS } from '../settingsService'
import { settingKeyFactsOf } from '../../../shared/channelAccess'

/** 不在 KNOWN_SETTINGS 里、代码里却在读写的 key（新加一个就补在这里，并在 channelAccess.ts 里归类） */
const OTHER_KEYS = [
  'appearance.notebookTheme',
  'browser.devtoolsHeight',
  'browser.viewMode',
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
  })
})
