/**
 * 会话 fork 的形态判定 —— `isForkableSessionShape`（宿主拒绝 `not_forkable` 与界面给不给入口共用这一份）。
 *
 *   CP-1  真值表：属于真实项目、settings 缺省 / 空、存储是新格式 → true；不属于项目、每一个隐藏承载项目、
 *         笔记本会话（空 notebookPath 不算）、Chrome 标签页会话、旧格式 / 缺省 / 不认识的存储类型 → false
 *
 * CP-2（拒绝原因的文案 key 与几条 fork 文案在三种语言里都在）在 chat-ui 的
 * `hooks/__tests__/sessionForkI18n.test.ts` —— `forkRefusalKey` 在 chat-ui，chat-protocol 不往上引。
 */
import { describe, expect, it } from 'vitest'
import { isForkableSessionShape, type ForkableSessionShape } from './sessionFork'
import { DURABLE_SQLITE_1, HARNESS_V3_JSONL } from './sessionStorageKind'

const base: ForkableSessionShape = {
  projectId: 'proj-1',
  storageKind: DURABLE_SQLITE_1,
  settings: {}
}

const HIDDEN_PROJECTS = [
  '__agents__',
  '__agents_builtin__',
  '__bots__',
  '__policies__',
  '__hooks__',
  '__knowledge__',
  '__knowledge_user__',
  '__knowledge_builtin__',
  '__skills__',
  '__skills_builtin__',
  '__skills:foo__'
]

describe('isForkableSessionShape (CP-1)', () => {
  it('CP-1 a real project session on the current storage kind is forkable, whatever empty settings look like', () => {
    expect(isForkableSessionShape(base)).toBe(true)
    expect(isForkableSessionShape({ ...base, settings: null })).toBe(true)
    expect(isForkableSessionShape({ ...base, settings: undefined })).toBe(true)
    const { settings: _omit, ...withoutSettings } = base
    expect(isForkableSessionShape(withoutSettings)).toBe(true)
    // 空字符串的 notebookPath 不是笔记本会话
    expect(isForkableSessionShape({ ...base, settings: { notebookPath: '' } })).toBe(true)
  })

  it('CP-1 a session outside any project is not forkable', () => {
    expect(isForkableSessionShape({ ...base, projectId: null })).toBe(false)
    expect(isForkableSessionShape({ ...base, projectId: '' })).toBe(false)
  })

  it.each(HIDDEN_PROJECTS)('CP-1 hidden carrier project %s is not forkable', (projectId) => {
    expect(isForkableSessionShape({ ...base, projectId })).toBe(false)
  })

  it('CP-1 a notebook session is not forkable', () => {
    expect(isForkableSessionShape({ ...base, settings: { notebookPath: 'a.md' } })).toBe(false)
  })

  it('CP-1 a Chrome tab session (valid binding) is not forkable; a malformed binding does not count as one', () => {
    expect(
      isForkableSessionShape({
        ...base,
        settings: { chromeTab: { installId: 'i', runId: 'r', tabId: 3 } }
      })
    ).toBe(false)
    // 字段不全的绑定不是标签页会话（chromeTabSession 的口径）—— 形态照样给
    expect(isForkableSessionShape({ ...base, settings: { chromeTab: { installId: 'i' } } })).toBe(
      true
    )
  })

  it('CP-1 storage kinds: legacy, missing and unknown kinds are not forkable', () => {
    expect(isForkableSessionShape({ ...base, storageKind: HARNESS_V3_JSONL })).toBe(false)
    expect(isForkableSessionShape({ ...base, storageKind: undefined })).toBe(false)
    expect(isForkableSessionShape({ ...base, storageKind: null })).toBe(false)
    const { storageKind: _omit, ...withoutKind } = base
    expect(isForkableSessionShape(withoutKind)).toBe(false)
    expect(isForkableSessionShape({ ...base, storageKind: 'durable-sqlite-2' })).toBe(false)
    expect(isForkableSessionShape({ ...base, storageKind: 'harness-v4-jsonl' })).toBe(false)
  })

  it('CP-1 always returns a boolean', () => {
    for (const shape of [
      base,
      { ...base, projectId: null },
      { ...base, settings: { notebookPath: 'x.md' } },
      { ...base, storageKind: null }
    ]) {
      expect(typeof isForkableSessionShape(shape)).toBe('boolean')
    }
  })
})
