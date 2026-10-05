/**
 * P3-05-01 clientIdOf —— IPC 调用方的客户端 id 只看 `event.sender.id`。
 */
import { describe, expect, it } from 'vitest'
import { clientIdOf, parseClientId, webContentsIdOf } from '../clientIdentity'

describe('P3-05-01 clientIdOf', () => {
  it("P3-05-01 {sender:{id:7}} → 'ipc:7'，{sender:{id:8}} → 'ipc:8'；同一个 sender 两次相等；只读 sender.id", () => {
    expect(clientIdOf({ sender: { id: 7 } })).toBe('ipc:7')
    expect(clientIdOf({ sender: { id: 8 } })).toBe('ipc:8')

    const sender = { id: 7 }
    expect(clientIdOf({ sender })).toBe(clientIdOf({ sender }))

    // 只读 sender.id：senderFrame / processId 一碰就抛
    const event = {
      sender: { id: 9 },
      get senderFrame(): never {
        throw new Error('senderFrame must not be read')
      },
      get processId(): never {
        throw new Error('processId must not be read')
      }
    }
    expect(clientIdOf(event)).toBe('ipc:9')
    const reads: string[] = []
    const proxied = new Proxy(
      { id: 10 },
      {
        get(target, key, receiver) {
          reads.push(String(key))
          return Reflect.get(target, key, receiver)
        }
      }
    )
    expect(clientIdOf({ sender: proxied })).toBe('ipc:10')
    expect(reads).toEqual(['id'])
  })

  it('P3-05-01 拆分：ipc:7 → 7；chrome:3 / bogus / ipc:x / ipc: 不是 webContents id', () => {
    expect(webContentsIdOf('ipc:7')).toBe(7)
    expect(webContentsIdOf('chrome:3')).toBeUndefined()
    expect(webContentsIdOf('bogus')).toBeUndefined()
    expect(webContentsIdOf('ipc:x')).toBeUndefined()
    expect(webContentsIdOf('ipc:')).toBeUndefined()
    expect(parseClientId('chrome:3')).toEqual({ prefix: 'chrome', rest: '3' })
    expect(parseClientId(':3')).toBeUndefined()
  })
})
