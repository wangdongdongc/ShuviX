/**
 * ChatEvent 缩成余项之后的主进程一侧（P3-08-45 / -46）：
 *
 *   P3-08-46 `streaming` 能力删了：`ChatFrontendCapabilities` 只剩 userInput；Electron / Chrome 前端都是
 *            `{userInput:true}`；注册表把每一种余项发给每个存活的绑定前端（不再按能力过滤）；
 *            `hasCapability(sid, 'userInput')` 照旧
 *   P3-08-45 静态：产品源码里没有任何一处 `type: '<已删除的事件>'` 字面量（`__tests__`、`legacy/`、e2e 除外）
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatEvent } from '@shuvix/chat-protocol/events'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { ChatFrontendRegistry } from '../ChatFrontendRegistry'
import type { ChatFrontend, ChatFrontendCapabilities } from '../ChatFrontend'
// eslint-disable-next-line boundaries/dependencies -- 能力删了之后两个具体前端各自的声明，与注册表放在一个用例里核对
import { ElectronFrontend } from '../../electron/ElectronFrontend'
// eslint-disable-next-line boundaries/dependencies -- 同上（Chrome 侧边栏的前端）
import { ChromeFrontend } from '../../chrome/ChromeFrontend'

function fake(
  id: string,
  capabilities: ChatFrontendCapabilities
): ChatFrontend & {
  sent: ChatEvent[]
} {
  const sent: ChatEvent[] = []
  return { id, capabilities, sent, sendEvent: (e) => void sent.push(e), isAlive: () => true }
}

const RESIDUE: ChatEvent[] = [
  { type: 'agent_start', sessionId: 's1' },
  { type: 'agent_end', sessionId: 's1', reason: 'ok' },
  { type: 'tool_review', sessionId: 's1', toolCallId: 't', reviewing: true },
  { type: 'runtime_event', sessionId: 's1', runtimeId: 'r', status: null },
  { type: 'browser_event', sessionId: 's1', action: 'open' },
  { type: 'agent_created', sessionId: 's1' },
  { type: 'agent_closing', sessionId: 's1', closing: true },
  { type: 'mcp_connecting', sessionId: 's1', server: 'x', connecting: true },
  { type: 'error', sessionId: 's1', error: 'boom' },
  { type: 'ask_count', sessionId: 's1', count: 1 }
]

describe('P3-08-46 streaming 能力删了', () => {
  it('能力只剩 userInput；Electron / Chrome 前端都是 {userInput:true}', () => {
    expectTypeOf<keyof ChatFrontendCapabilities>().toEqualTypeOf<'userInput'>()
    const electron = new ElectronFrontend({ isDestroyed: () => false } as never)
    const chrome = new ChromeFrontend({ id: 'c1', ready: true, emit: () => {} } as never, 's1')
    expect(electron.capabilities).toStrictEqual({ userInput: true })
    expect(chrome.capabilities).toStrictEqual({ userInput: true })
  })

  it('注册表把每一种余项发给每个存活的绑定前端（没有能力的也照收）；hasCapability 照旧', () => {
    const registry = new ChatFrontendRegistry()
    const plain = fake('plain', {})
    const asker = fake('asker', { userInput: true })
    registry.registerDefault(plain)
    registry.bind('s1', asker)
    for (const event of RESIDUE) registry.broadcast(event)
    expect(plain.sent).toEqual(RESIDUE)
    expect(asker.sent).toEqual(RESIDUE)
    expect(registry.hasCapability('s1', 'userInput')).toBe(true)
    expect(registry.hasCapability('s2', 'userInput')).toBe(false)
  })

  it('P3-08-49 绑在根会话上的前端经 sub→parent 映射收到派生 agent 的那一对（end 之前）', () => {
    const registry = new ChatFrontendRegistry()
    const chrome = fake('chrome:c1:s1', { userInput: true })
    registry.bind('s1', chrome)
    const sequence: ChatEvent[] = [
      {
        type: 'sub_session_register',
        sessionId: 'a1',
        parentSessionId: 's1',
        subAgentName: 'explore',
        displayName: 'E',
        description: '',
        systemPrompt: '',
        prompt: ''
      },
      { type: 'agent_start', sessionId: 'a1' },
      { type: 'agent_end', sessionId: 'a1', reason: 'ok' },
      { type: 'sub_session_end', sessionId: 'a1', parentSessionId: 's1', result: 'r' }
    ]
    for (const event of sequence) registry.broadcast(event)
    expect(chrome.sent).toEqual(sequence)
  })

  it('STREAMING_EVENT_TYPES 与 input_request 的能力表都删了', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'ChatFrontendRegistry.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/STREAMING_EVENT_TYPES/)
    expect(source).not.toMatch(/INTERACTION_CAPABILITY_MAP/)
    expect(source).not.toMatch(/input_request/)
  })
})

describe('P3-08-45 静态：产品源码里没有已删除事件的字面量', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..')
  const ROOTS = [
    'apps/desktop/src',
    'apps/extension/src',
    'packages/chat-protocol/src',
    'packages/chat-ui/src',
    'packages/app-shell/src',
    'packages/agent-runtime/src'
  ]
  const DELETED = [
    'text_delta',
    'thinking_delta',
    'text_end',
    'assistant_message',
    'token_usage',
    'toolcall_generating',
    'tool_start',
    'tool_end',
    'image_data',
    'messages_reloaded',
    'user_message',
    'queue_update',
    'input_request',
    'input_request_resolved'
  ]
  const LITERAL = new RegExp(`type:\\s*['"](${DELETED.join('|')})['"]`)
  const COMPARE = new RegExp(`type\\s*===\\s*['"](${DELETED.join('|')})['"]`)
  const CASE = new RegExp(`case\\s+['"](${DELETED.join('|')})['"]\\s*:`)

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === '__tests__' || name === 'legacy' || name === 'node_modules') return []
        return walk(full)
      }
      if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) return []
      return [full]
    })
  }

  it('扫过的文件不是空集；一处命中都没有', () => {
    const files = ROOTS.flatMap((root) => walk(join(REPO, root)))
    expect(files.length).toBeGreaterThan(200)
    const offenders = files.flatMap((file) => {
      const lines = readFileSync(file, 'utf8').split('\n')
      return lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => LITERAL.test(line) || COMPARE.test(line) || CASE.test(line))
        .map(({ line, index }) => `${relative(REPO, file)}:${index + 1}: ${line.trim()}`)
    })
    expect(offenders).toEqual([])
  })
})
