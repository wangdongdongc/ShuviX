/**
 * `host/sessionDraftStash.ts` —— web 设置页带回聊天页的 {会话, 草稿}：
 *   SDS-1 存了再取：取一次就没了；草稿不是字符串 → 空串
 *   SDS-2 没有、坏的 JSON、没有会话 → null；存储抛错 → 存不了也不抛、取 → null
 */
import { describe, expect, it } from 'vitest'
import { stashPendingSessionDraft, takePendingSessionDraft } from '../sessionDraftStash'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size
    }
  }
}

describe('sessionDraftStash', () => {
  it('SDS-1 存了再取，取一次就没了', () => {
    const storage = memoryStorage()
    stashPendingSessionDraft({ sessionId: 's1', draft: 'hello' }, storage)
    expect(takePendingSessionDraft(storage)).toEqual({ sessionId: 's1', draft: 'hello' })
    expect(takePendingSessionDraft(storage)).toBeNull()
    storage.setItem('shuvix.openSessionDraft', JSON.stringify({ sessionId: 's2', draft: 3 }))
    expect(takePendingSessionDraft(storage)).toEqual({ sessionId: 's2', draft: '' })
  })

  it('SDS-2 没有 / 坏的 / 没有会话 → null；存储抛错不抛', () => {
    const storage = memoryStorage()
    expect(takePendingSessionDraft(storage)).toBeNull()
    storage.setItem('shuvix.openSessionDraft', '{oops')
    expect(takePendingSessionDraft(storage)).toBeNull()
    storage.setItem('shuvix.openSessionDraft', JSON.stringify({ draft: 'x' }))
    expect(takePendingSessionDraft(storage)).toBeNull()
    const throwing = {
      setItem: () => {
        throw new Error('denied')
      },
      getItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {}
    }
    expect(() => stashPendingSessionDraft({ sessionId: 's', draft: '' }, throwing)).not.toThrow()
    expect(takePendingSessionDraft(throwing)).toBeNull()
  })
})
