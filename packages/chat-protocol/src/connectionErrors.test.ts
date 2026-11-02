/**
 * 连接类失败的约定（`connectionFailureOf`）：只认 `code`，别的一律不算连接造成的。
 *
 *   CE-1 `disconnected` → lost；`not_connected` → not-sent（普通对象与 Error 都一样）
 *   CE-2 其余都是 null，且不抛：只有消息没有 code、别的 code、数字 code、null / undefined、抛出来的字符串 / 数字
 */
import { describe, expect, it } from 'vitest'
import {
  CONNECTION_LOST_CODE,
  NOT_CONNECTED_CODE,
  connectionFailureOf,
  type ConnectionFailure
} from './connectionErrors'

describe('connectionFailureOf', () => {
  it.each<[string, unknown, ConnectionFailure]>([
    ['plain object disconnected', { code: 'disconnected' }, 'lost'],
    ['plain object not_connected', { code: 'not_connected' }, 'not-sent'],
    ['Error disconnected', Object.assign(new Error('x'), { code: 'disconnected' }), 'lost'],
    ['Error not_connected', Object.assign(new Error('x'), { code: 'not_connected' }), 'not-sent']
  ])('CE-1 %s', (_label, error, expected) => {
    expect(connectionFailureOf(error)).toBe(expected)
  })

  it('CE-1 the exported codes are the ones on the wire', () => {
    expect(CONNECTION_LOST_CODE).toBe('disconnected')
    expect(NOT_CONNECTED_CODE).toBe('not_connected')
  })

  it.each<[string, unknown]>([
    ['the message alone is not enough', new Error('disconnected')],
    ['handler_error', Object.assign(new Error('boom'), { code: 'handler_error' })],
    ['desktop_only', { code: 'desktop_only' }],
    ['a numeric code', { code: 500 }],
    ['null', null],
    ['undefined', undefined],
    ['a thrown string', 'disconnected'],
    ['a thrown number', 42]
  ])('CE-2 %s → null, never throws', (_label, error) => {
    expect(connectionFailureOf(error)).toBeNull()
  })
})
