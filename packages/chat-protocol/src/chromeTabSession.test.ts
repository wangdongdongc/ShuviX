/**
 * Chrome 标签页会话的形态判定 —— `chromeTabOf` / `isChromeTabSessionSettings`。
 *
 * 一条标签页会话是带 `settings.chromeTab = {installId, runId, tabId}` 的普通会话：不进列表、寿命跟着
 * 标签页、根档案推出基座 `tab`。所有地方都经这一份判定，所以钉的是「字段不全的算不是」的每个边角：
 *
 *   CTS-1  合法绑定回一份只含三个键的拷贝（改它不动原对象）
 *   CTS-2  settings / chromeTab 缺失或不是对象 → undefined，不抛
 *   CTS-3  installId / runId 不是非空字符串 → undefined
 *   CTS-4  tabId 必须是非负整数（-1 是 Chrome 的 TAB_ID_NONE，不是标签页）；0 合法
 *   CTS-5  isChromeTabSessionSettings 恰在 chromeTabOf 有值时为 true，恒为布尔
 */
import { describe, expect, it } from 'vitest'
import {
  chromeTabOf,
  isChromeTabSessionSettings,
  type ChromeTabSessionShape
} from './chromeTabSession'

const valid = { installId: 'i', runId: 'r', tabId: 5 }

/** 一张表覆盖 CTS-1~4 的全部输入：[说明, settings, 期望的绑定] */
const table: Array<[string, unknown, ReturnType<typeof chromeTabOf>]> = [
  ['合法', { chromeTab: valid }, valid],
  ['带多余字段', { chromeTab: { ...valid, extra: 1 } }, valid],
  ['tabId 0', { chromeTab: { ...valid, tabId: 0 } }, { ...valid, tabId: 0 }],
  ['settings undefined', undefined, undefined],
  ['settings null', null, undefined],
  ['settings {}', {}, undefined],
  ['chromeTab null', { chromeTab: null }, undefined],
  ["chromeTab 'x'", { chromeTab: 'x' }, undefined],
  ['chromeTab 5', { chromeTab: 5 }, undefined],
  ['chromeTab true', { chromeTab: true }, undefined],
  ['chromeTab []', { chromeTab: [] }, undefined],
  ["installId ''", { chromeTab: { ...valid, installId: '' } }, undefined],
  ['installId 5', { chromeTab: { ...valid, installId: 5 } }, undefined],
  ['installId null', { chromeTab: { ...valid, installId: null } }, undefined],
  ['installId 缺失', { chromeTab: { runId: 'r', tabId: 5 } }, undefined],
  ["runId ''", { chromeTab: { ...valid, runId: '' } }, undefined],
  ['runId 5', { chromeTab: { ...valid, runId: 5 } }, undefined],
  ['runId null', { chromeTab: { ...valid, runId: null } }, undefined],
  ['runId 缺失', { chromeTab: { installId: 'i', tabId: 5 } }, undefined],
  ["tabId '5'", { chromeTab: { ...valid, tabId: '5' } }, undefined],
  ['tabId 1.5', { chromeTab: { ...valid, tabId: 1.5 } }, undefined],
  ['tabId NaN', { chromeTab: { ...valid, tabId: Number.NaN } }, undefined],
  ['tabId Infinity', { chromeTab: { ...valid, tabId: Number.POSITIVE_INFINITY } }, undefined],
  ['tabId null', { chromeTab: { ...valid, tabId: null } }, undefined],
  ['tabId 缺失', { chromeTab: { installId: 'i', runId: 'r' } }, undefined],
  ['tabId -1（TAB_ID_NONE）', { chromeTab: { ...valid, tabId: -1 } }, undefined],
  ['tabId -7', { chromeTab: { ...valid, tabId: -7 } }, undefined]
]

describe('chromeTabOf / isChromeTabSessionSettings', () => {
  it('CTS-1 合法绑定回一份拷贝：恰好 installId / runId / tabId 三个键；改拷贝不动原 settings', () => {
    const settings = { chromeTab: { ...valid, extra: 1 } }
    const binding = chromeTabOf(settings)

    expect(binding).toStrictEqual({ installId: 'i', runId: 'r', tabId: 5 })
    expect(Object.keys(binding!).sort()).toEqual(['installId', 'runId', 'tabId'])
    expect(binding).not.toBe(settings.chromeTab)
    binding!.tabId = 6
    binding!.installId = 'other'
    expect(settings.chromeTab).toEqual({ installId: 'i', runId: 'r', tabId: 5, extra: 1 })
  })

  it.each(table.filter(([, , expected]) => expected === undefined))(
    'CTS-2/3/4 %s → undefined，不抛',
    (_label, settings) => {
      expect(() => chromeTabOf(settings as ChromeTabSessionShape)).not.toThrow()
      expect(chromeTabOf(settings as ChromeTabSessionShape)).toBeUndefined()
    }
  )

  it('CTS-4 tabId 0 是合法的标签页 id（非负整数），负数一律不是', () => {
    expect(chromeTabOf({ chromeTab: { ...valid, tabId: 0 } })).toStrictEqual({
      ...valid,
      tabId: 0
    })
    expect(chromeTabOf({ chromeTab: { ...valid, tabId: -1 } })).toBeUndefined()
  })

  it('CTS-5 isChromeTabSessionSettings 恒为布尔，且在整张表上与 chromeTabOf 逐例一致', () => {
    for (const [label, settings, expected] of table) {
      const shape = settings as ChromeTabSessionShape
      expect(chromeTabOf(shape), label).toStrictEqual(expected)
      const verdict = isChromeTabSessionSettings(shape)
      expect(typeof verdict, label).toBe('boolean')
      expect(verdict, label).toBe(expected !== undefined)
    }
  })
})
