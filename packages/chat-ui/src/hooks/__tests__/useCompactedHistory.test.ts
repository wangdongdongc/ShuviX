/**
 * 压缩前的历史 —— `useCompactedHistory` 的两个纯函数。
 *
 *   U-1 `compactionAnchorOf`：当前视图的第一条是压缩摘要（assistant · message · metadata.isCompactionSummary === true）
 *       才有锚点（= 它的 id）；空列表、第一条是用户消息 / 普通助手消息 / 错误行、摘要不在第一条、标记不是 true → null
 *   U-2 `nextCompactionId`：还没取过 → 锚点（锚点为 null 就是 null）；取过 → 看最上面那段的第一条：是压缩摘要
 *       就是它的 id，否则（含空段）null —— 只看最上面那段，不看更下面的
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { compactionAnchorOf, nextCompactionId, type CompactedSegment } from '../useCompactedHistory'
import { assistant, errorRow, text, user } from '../../__tests__/support/views'

const summary = (id: string): ChatMessage =>
  assistant(id, [text('summary')], 's1', { isCompactionSummary: true })
const seg = (compactionId: string, messages: ChatMessage[]): CompactedSegment => ({
  compactionId,
  messages
})

describe('compactionAnchorOf', () => {
  it('U-1 the first message is a compaction summary → its id', () => {
    expect(compactionAnchorOf([summary('9'), user('10', 'hi'), assistant('11', [text('a')])])).toBe(
      '9'
    )
  })

  it('U-1 no anchor: empty list, first is a user / plain assistant / error row, summary not first', () => {
    expect(compactionAnchorOf([])).toBeNull()
    expect(compactionAnchorOf([user('1', 'hi'), summary('2')])).toBeNull()
    expect(compactionAnchorOf([assistant('1', [text('a')])])).toBeNull()
    expect(compactionAnchorOf([errorRow('1', 'boom')])).toBeNull()
  })

  it('U-1 the flag must be exactly true, on an assistant message', () => {
    const truthy = assistant('1', [text('a')], 's1', {
      isCompactionSummary: 'yes'
    } as unknown as Record<string, unknown>)
    expect(compactionAnchorOf([truthy])).toBeNull()
    const onUser = user('1', 'x', 's1', { isCompactionSummary: true } as never)
    expect(compactionAnchorOf([onUser])).toBeNull()
  })
})

describe('nextCompactionId', () => {
  it('U-2 nothing loaded yet → the anchor (null stays null)', () => {
    expect(nextCompactionId('9', [])).toBe('9')
    expect(nextCompactionId(null, [])).toBeNull()
  })

  it('U-2 the top segment starts with a summary → that summary id', () => {
    expect(nextCompactionId('9', [seg('9', [summary('5'), user('6', 'x')])])).toBe('5')
  })

  it('U-2 the top segment does not start with a summary (or is empty) → null; only the top segment counts', () => {
    expect(nextCompactionId('9', [seg('9', [user('2', 'x'), summary('3')])])).toBeNull()
    expect(nextCompactionId('9', [seg('9', [])])).toBeNull()
    // 下面那段以摘要开头，但最上面那段不是：到头了
    expect(
      nextCompactionId('9', [seg('5', [user('1', 'x')]), seg('9', [summary('5'), user('6', 'y')])])
    ).toBeNull()
    expect(
      nextCompactionId('9', [seg('5', [summary('2'), user('3', 'x')]), seg('9', [summary('5')])])
    ).toBe('2')
  })
})
