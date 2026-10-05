/**
 * P3-02 · 纯投影（手写条目 / 手写的 pi.live、pi.inbox）。真流程（faux 驱动）在 project.flows.test.ts，
 * 与旧投影的对照在 project.golden.test.ts。
 *
 *   01-03 user 与显示侧车        06-07 通知（条目种类 / 正文形状）   09-11 assistant 块与用量
 *   12-16 工具回填、诊断段剥离、落盘   18 配对                          19-22, 24, 26-27 重试折叠
 *   28 中止的中间卡              30 压缩头                           32 跳过的种类
 *   34-36 实时卡与 toolRuns      37-38 run.retry / run.compacting    39 队列
 *   41 询问                      42-43 上下文占用                    46-50 纯度、确定性、严格 JSON、外壳
 *   51 AgentView                 52 不依赖 Node、包入口导出          54 搬家后的导出身份
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EntryRecord, ToolDiagnostic } from '@earendil-works/pi-durable'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { AssistantMessage, ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as runtime from '../../../index'
import { truncationDiagnostic, type ProcessToolOutputResult } from '../../../toolOutput/spill'
import { imagePlaceholder } from '../../../toolResultText'
import * as displayModule from '../display'
import * as entryTextModule from '../entryText'
import { projectAgentView, projectSessionView, renderHarnessDiagnostics } from '../project'
import {
  A,
  C,
  E,
  IMAGE,
  IMAGE_META,
  K1,
  META,
  N,
  P,
  PA,
  R,
  SID,
  U,
  USAGE,
  bg,
  call,
  checked,
  deepFreeze,
  display,
  expectJsonView,
  objectsOf,
  text,
  thinking,
  wrap
} from './support'

const assistant = (view: { messages: ChatMessage[] }, id: string): AssistantMessage => {
  const message = view.messages.find((m) => m.id === id)
  if (message?.role !== 'assistant') throw new Error(`no assistant card ${id}`)
  return message
}

const toolBlock = (view: { messages: ChatMessage[] }, id: string, callId: string) => {
  const block = assistant(view, id).blocks.find(
    (b) => b.type === 'tool' && b.toolCallId === callId
  )
  if (block?.type !== 'tool') throw new Error(`no tool block ${callId}`)
  return block
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('P3-02 · pure projector: user messages and inline tokens', () => {
  it('P3-02-01 a plain user message: exact shape, images from the model content, no provider / inlineTokens / notice', () => {
    const view = P([U(3, [text('look '), IMAGE, text('here')], 1000)])
    expect(view.messages).toStrictEqual([
      {
        id: '3',
        sessionId: 's',
        role: 'user',
        type: 'text',
        content: 'look here',
        model: '',
        createdAt: 1000,
        metadata: { images: [IMAGE_META] }
      }
    ])
    // string content → metadata {} (PIN-05); missing / NaN timestamp → 0; text verbatim, untrimmed
    const variants = P([U(4, 'hi', 5), U(5, '  x  '), U(6, 'y', Number.NaN)]).messages
    expect(variants.map((m) => [m.content, m.createdAt, m.metadata])).toStrictEqual([
      ['hi', 5, {}],
      ['  x  ', 0, {}],
      ['y', 0, {}]
    ])
  })

  it('P3-02-02 a resolved display sidecar: display content and tokens, images still from the model, the payload is in no content field', () => {
    const entries = [U(3, [text('run PAYLOAD-K1 please'), IMAGE], 1000)]
    const view = P(entries, {
      display: new Map([[3, display('run {{shuvixInlineToken:k1}} please', K1)]])
    })
    const [message] = view.messages
    expect(message!.content).toBe('run {{shuvixInlineToken:k1}} please')
    expect(message!.metadata).toStrictEqual({ images: [IMAGE_META], inlineTokens: K1 })
    expect(JSON.stringify(view.messages.map((m) => m.content))).not.toContain('PAYLOAD-K1')
  })

  it('P3-02-03 display versus notice shape, and the map’s scope', () => {
    const noticeShaped = U(4, '<background-task id="t">done</background-task>', 9)
    // (a) no display: a notice by shape
    expect(P([noticeShaped]).messages[0]!.metadata).toStrictEqual({ isSystemNotice: true })
    // (b) display resolved: an ordinary user message (the sidecar wins, legacy rule)
    const resolved = P([noticeShaped], { display: new Map([[4, display('/x', K1)]]) })
    expect(resolved.messages[0]!.metadata).toStrictEqual({ inlineTokens: K1 })
    expect(resolved.messages[0]!.content).toBe('/x')
    // (c) a display keyed to a notice or an assistant id is ignored
    const others = P([N(5, 'n'), A(6, [text('a')])], {
      display: new Map([
        [5, display('NOPE', K1)],
        [6, display('NOPE', K1)]
      ])
    })
    expect(others.messages.map((m) => m.content)).toEqual(['n', 'a'])
    expect(others.messages[0]!.metadata).toStrictEqual({ isSystemNotice: true })
  })
})

describe('P3-02 · pure projector: notices', () => {
  it('P3-02-06 a notice entry: UserTextMessage with isSystemNotice, by entry kind whatever the text or data.kind (PIN-20)', () => {
    const subSession = '<sub-session id="x" status="done">…</sub-session>'
    const view = P([
      N(5, subSession, 'background', 50),
      N(6, 'Today is 2026-10-05', 'date', 60),
      N(7, [text('a'), text('b')], 'zzz', 70)
    ])
    expect(view.messages).toStrictEqual([
      {
        id: '5',
        sessionId: 's',
        role: 'user',
        type: 'text',
        content: subSession,
        model: '',
        createdAt: 50,
        metadata: { isSystemNotice: true }
      },
      {
        id: '6',
        sessionId: 's',
        role: 'user',
        type: 'text',
        content: 'Today is 2026-10-05',
        model: '',
        createdAt: 60,
        metadata: { isSystemNotice: true }
      },
      {
        id: '7',
        sessionId: 's',
        role: 'user',
        type: 'text',
        content: 'ab',
        model: '',
        createdAt: 70,
        metadata: { isSystemNotice: true }
      }
    ])
  })

  it('P3-02-07 notice recognised by text shape on pi.user only when the whole text is notice blocks', () => {
    const both = `${bg('t1', 'a')}\n\n<sub-session id="s" status="done">b</sub-session>`
    const view = P([U(1, both), U(2, `hi ${bg('t2', 'c')}`), U(3, '   '), U(4, '')])
    expect(view.messages.map((m) => m.metadata)).toStrictEqual([
      { isSystemNotice: true },
      {},
      {},
      {}
    ])
    expect(view.messages[3]!.content).toBe('')
  })
})

describe('P3-02 · pure projector: assistant blocks and usage', () => {
  it('P3-02-09 block conversion and order, content, model / provider, usage', () => {
    const entry = A(
      7,
      [thinking('plan'), text('a'), call('read', { path: 'x' }, 'c1'), text('b'), thinking('\n')],
      2000,
      {
        usage: {
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 1,
          totalTokens: 126,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
    )
    const card = assistant(P([entry]), '7')
    expect(card.blocks).toStrictEqual([
      { type: 'thinking', text: 'plan' },
      { type: 'text', text: 'a' },
      { type: 'tool', toolCallId: 'c1', toolName: 'read', args: { path: 'x' } },
      { type: 'text', text: 'b' }
    ])
    expect(card.content).toBe('ab')
    expect([card.model, card.provider, card.createdAt]).toEqual(['m', 'p', 2000])
    expect(card.metadata).toStrictEqual({
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, total: 126 }
    })
  })

  it('P3-02-10 usage edge cases and empty output', () => {
    expect(assistant(P([A(1, [text('a')], 0, { usage: USAGE(7, 3, 0) })]), '1').metadata).toEqual({
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 }
    })
    expect(assistant(P([A(1, [text('a')], 0, { usage: null })]), '1').metadata).toStrictEqual({})
    expect(P([A(1, [])]).messages).toEqual([])
    expect(P([A(1, [thinking(' \n ')])]).messages).toEqual([])
    const toolOnly = assistant(P([A(1, [call('ls', {}, 'c1')], 0, { stopReason: 'toolUse' })]), '1')
    expect(toolOnly.content).toBe('')
    const images = [{ data: 'AAAA', mimeType: 'image/png' }]
    const withImages = assistant(P([A(1, [], 0, { images, usage: null })]), '1')
    expect(withImages.blocks).toEqual([])
    expect(withImages.metadata).toStrictEqual({ images })
  })

  it('P3-02-11 non-error stop reasons are ordinary; an error without a message and no later entry of its task renders its blocks (PIN-10)', () => {
    for (const stopReason of ['length', 'toolUse', 'aborted'] as const) {
      const view = P([A(1, [text('x')], 0, { stopReason, task: 1 })])
      expect(view.messages.map((m) => [m.role, m.type])).toEqual([['assistant', 'message']])
    }
    for (const errorMessage of ['', undefined]) {
      const withBlocks = P([
        A(1, [text('partial')], 0, {
          stopReason: 'error',
          task: 4,
          ...(errorMessage === undefined ? {} : { errorMessage })
        })
      ])
      expect(withBlocks.messages.map((m) => [m.type, m.content])).toEqual([['message', 'partial']])
      const empty = P([E(1, errorMessage, 4)])
      expect(empty.messages).toEqual([])
    }
  })
})

describe('P3-02 · pure projector: tool fill, harness strip, spill', () => {
  const diag = (severity: ToolDiagnostic['severity'], message: string, code?: string) =>
    ({ severity, message, ...(code === undefined ? {} : { code }) }) as ToolDiagnostic

  it('P3-02-12 result fill: text, details, isError only when true, images as placeholders', () => {
    const base = A(1, [call('read', { path: 'x' }, 'c1')], 0, { stopReason: 'toolUse' })
    const details = { type: 'read', truncated: false }
    const ok = P([base, R(2, 'c1', [text('ok')], { details })])
    expect(toolBlock(ok, '1', 'c1')).toStrictEqual({
      type: 'tool',
      toolCallId: 'c1',
      toolName: 'read',
      args: { path: 'x' },
      result: 'ok',
      details
    })
    expect(toolBlock(P([base, R(2, 'c1', [text('no')], { isError: true })]), '1', 'c1').isError).toBe(
      true
    )
    const mixed = P([base, R(2, 'c1', [text('a'), IMAGE, text('b')])])
    expect(toolBlock(mixed, '1', 'c1').result).toBe(`a\n${imagePlaceholder('image/png')}\nb`)
  })

  it('P3-02-13 harness strip: the trailing render of the diagnostics is removed exactly', () => {
    const diagnostics = [diag('info', 'M1', 'spilled-x'), diag('warn', 'M2', 'truncated')]
    const view = P([
      A(1, [call('bash', {}, 'c1')], 0, { stopReason: 'toolUse' }),
      R(2, 'c1', [text('preview'), text('<harness>\n[info] M1\n[warn] M2\n</harness>')], {
        diagnostics
      })
    ])
    expect(renderHarnessDiagnostics(diagnostics)).toBe('<harness>\n[info] M1\n[warn] M2\n</harness>')
    expect(toolBlock(view, '1', 'c1').result).toBe('preview')
  })

  it('P3-02-14 no strip when the trailing item differs, diagnostics are empty, data is malformed, or the last item is an image', () => {
    const diagnostics = [diag('info', 'M1'), diag('warn', 'M2')]
    const harness = '<harness>\n[info] M1\n[warn] M2\n</harness>'
    const cases: [string, Parameters<typeof R>[2], Parameters<typeof R>[3]][] = [
      ['(a) other severity', [text('p'), text('<harness>\n[warn] M1\n[warn] M2\n</harness>')], { diagnostics }],
      ['(a) trailing whitespace', [text('p'), text(`${harness}\n`)], { diagnostics }],
      ['(a) reordered', [text('p'), text('<harness>\n[warn] M2\n[info] M1\n</harness>')], { diagnostics }],
      ['(b) no diagnostics', [text('p'), text(harness)], { diagnostics: [] }],
      ['(c) data missing', [text('p'), text(harness)], { data: null }],
      ['(c) data malformed', [text('p'), text(harness)], { data: { diagnostics: [{ severity: 'loud', message: 'M1' }] } }],
      ['(c) diagnostics not an array', [text('p'), text(harness)], { data: { diagnostics: 'M1' } }],
      ['(d) trailing image', [text('p'), text(harness), IMAGE], { diagnostics }]
    ]
    for (const [label, content, options] of cases) {
      const view = P([
        A(1, [call('bash', {}, 'c1')], 0, { stopReason: 'toolUse' }),
        R(2, 'c1', content, options)
      ])
      const expected = content
        .map((c) => (c.type === 'text' ? c.text : imagePlaceholder(c.mimeType)))
        .join('\n')
      expect(toolBlock(view, '1', 'c1').result, label).toBe(expected)
    }
  })

  it('P3-02-15 harness-written results with no content: the diagnostic messages, without the wrapper (PIN-08)', () => {
    for (const code of ['tool_unavailable', 'aborted']) {
      const diagnostics = [diag('error', 'Tool x is not available', code)]
      // as stored by pi (the render appended to content []), and the literal empty content
      for (const content of [[text(renderHarnessDiagnostics(diagnostics))], []]) {
        const view = P([
          A(1, [call('x', {}, 'c1')], 0, { stopReason: 'toolUse' }),
          R(2, 'c1', content, { diagnostics, isError: true })
        ])
        const block = toolBlock(view, '1', 'c1')
        expect(block.isError).toBe(true)
        expect(block.result).toBe('Tool x is not available')
      }
    }
    const two = [diag('error', 'first'), diag('warn', 'second')]
    const view = P([
      A(1, [call('x', {}, 'c1')], 0, { stopReason: 'toolUse' }),
      R(2, 'c1', [text(renderHarnessDiagnostics(two))], { diagnostics: two, isError: true })
    ])
    expect(toolBlock(view, '1', 'c1').result).toBe('first\nsecond')
  })

  it('P3-02-16 spill: the locator of a spilled diagnostic, never from truncated ones, the first of two, even without a strip', () => {
    const L = '/Users/a b/.shuvix/tool_results/c1.txt'
    const result = (locator?: string): ProcessToolOutputResult => ({
      text: 'preview',
      truncated: true,
      persisted: locator !== undefined,
      originalLines: 5000,
      originalBytes: 300000,
      header: '[Output truncated: 5000 lines / 293.0KB]',
      kept: 'middle',
      ...(locator === undefined ? {} : { locator })
    })
    const spilled = truncationDiagnostic(result(L))!
    const inMemory = truncationDiagnostic(result())!
    const piTruncated = diag('warn', 'Output truncated to 2000 lines', 'truncated')
    const run = (diagnostics: ToolDiagnostic[], content = [text('preview')]) =>
      toolBlock(
        P([
          A(1, [call('bash', {}, 'c1')], 0, { stopReason: 'toolUse' }),
          R(2, 'c1', [...content, text(renderHarnessDiagnostics(diagnostics))], { diagnostics })
        ]),
        '1',
        'c1'
      )
    expect(run([spilled]).spill).toStrictEqual({ path: L })
    expect(run([spilled]).result).toBe('preview')
    expect('spill' in run([inMemory])).toBe(false)
    expect('spill' in run([piTruncated])).toBe(false)
    const second = truncationDiagnostic(result('/second.txt'))!
    expect(run([spilled, second]).spill).toStrictEqual({ path: L })
    // no strip (the trailing item is not the render), the spill is still set
    const noStrip = toolBlock(
      P([
        A(1, [call('bash', {}, 'c1')], 0, { stopReason: 'toolUse' }),
        R(2, 'c1', [text('preview')], { diagnostics: [spilled] })
      ]),
      '1',
      'c1'
    )
    expect(noStrip.result).toBe('preview')
    expect(noStrip.spill).toStrictEqual({ path: L })
  })

  it('P3-02-18 pairing: orphans dropped, a reused id fills the most recent block, calls in an error entry are not registered', () => {
    const orphan = P([U(1, 'u'), R(2, 'nope', [text('lost')])])
    expect(orphan.messages.map((m) => m.id)).toEqual(['1'])

    const reused = P([
      A(1, [call('ls', {}, 'dup')], 0, { stopReason: 'toolUse' }),
      A(2, [call('ls', {}, 'dup')], 0, { stopReason: 'toolUse' }),
      R(3, 'dup', [text('first result')])
    ])
    expect('result' in toolBlock(reused, '1', 'dup')).toBe(false)
    expect(toolBlock(reused, '2', 'dup').result).toBe('first result')

    const inError = P([
      A(1, [call('ls', {}, 'c1')], 0, { stopReason: 'error', errorMessage: 'boom' }),
      R(2, 'c1', [text('never shown')])
    ])
    expect(inError.messages.map((m) => m.type)).toEqual(['error_event'])
    expect(JSON.stringify(inError)).not.toContain('never shown')
  })
})

describe('P3-02 · pure projector: retry folding', () => {
  it('P3-02-19 folded after success: only the final card, carrying retried alongside usage', () => {
    const view = P([E(1, '429', 7), E(2, '503', 7), A(3, [text('done')], 0, { task: 7 })])
    expect(view.messages.map((m) => m.id)).toEqual(['3'])
    expect(assistant(view, '3').metadata).toEqual({
      usage: expect.any(Object),
      retried: { count: 2, lastError: '503' }
    })
    expect(view.messages.some((m) => m.type === 'error_event')).toBe(false)
  })

  it('P3-02-20 folding across tool rounds: each card carries the folds since the previous hinted card (PIN-19)', () => {
    const view = P([
      E(1, 'e1', 7),
      A(2, [call('ls', {}, 'c1')], 0, { stopReason: 'toolUse', task: 7 }),
      R(3, 'c1', [text('listing')]),
      E(4, 'e2', 7),
      E(5, 'e3', 7),
      A(6, [text('done')], 0, { task: 7 })
    ])
    expect(view.messages.map((m) => m.id)).toEqual(['2', '6'])
    expect(assistant(view, '2').metadata?.retried).toEqual({ count: 1, lastError: 'e1' })
    expect(toolBlock(view, '2', 'c1').result).toBe('listing')
    expect(assistant(view, '6').metadata?.retried).toEqual({ count: 2, lastError: 'e3' })
  })

  it('P3-02-21 live, during the backoff: nothing rendered, no live card, run.retry while busy', () => {
    const live = { run: { taskId: 7, inputs: [9] }, generation: { attempt: 2, retry: { at: 9000, error: '503' } } }
    const view = P([U(1, 'hi'), E(2, '429', 7), E(3, '503', 7)], { live, runState: 'busy' })
    expect(view.messages.map((m) => m.id)).toEqual(['1'])
    expect(view.live).toBeNull()
    expect(view.run).toStrictEqual({ state: 'busy', retry: { attempt: 2, at: 9000, error: '503' } })
  })

  it('P3-02-22 live, streaming after retries: the live card carries retried (PIN-07); the committed card keeps it', () => {
    const partial = {
      role: 'assistant',
      content: [text('par')],
      api: 'faux',
      provider: 'p',
      model: 'm',
      usage: USAGE(1, 1),
      stopReason: 'stop',
      timestamp: 50
    }
    const live = { run: { taskId: 7, inputs: [9] }, generation: { attempt: 3, message: partial } }
    const streaming = P([E(1, '429', 7), E(2, '503', 7)], { live, runState: 'busy' })
    expect(streaming.messages).toEqual([])
    expect(streaming.live!.id).toBe('live:7')
    expect(streaming.live!.message.blocks).toStrictEqual([{ type: 'text', text: 'par' }])
    expect(streaming.live!.message.metadata).toStrictEqual({
      retried: { count: 2, lastError: '503' }
    })
    expect('retry' in streaming.run).toBe(false)

    const committed = P(
      [E(1, '429', 7), E(2, '503', 7), A(3, [text('par')], 50, { task: 7 })],
      { live: {}, runState: 'idle' }
    )
    expect(committed.live).toBeNull()
    expect(assistant(committed, '3').metadata?.retried).toEqual(
      streaming.live!.message.metadata?.retried
    )
    expect(assistant(committed, '3').blocks).toEqual(streaming.live!.message.blocks)
  })

  it('P3-02-24 aborted runs: (a) abort in the backoff leaves the last error a row with the count; (b) abort while streaming leaves a hinted card', () => {
    const a = P([U(1, 'hi'), E(2, 'e1', 7), E(3, 'e2', 7)])
    expect(a.messages.map((m) => [m.id, m.type, m.metadata])).toEqual([
      ['1', 'text', {}],
      ['3', 'error_event', { retried: { count: 1, lastError: 'e1' } }]
    ])
    const b = P([
      U(1, 'hi'),
      E(2, 'e1', 7),
      E(3, 'e2', 7),
      A(4, [text('half')], 0, { stopReason: 'aborted', task: 7 })
    ])
    expect(b.messages.map((m) => [m.id, m.type])).toEqual([
      ['1', 'text'],
      ['4', 'message']
    ])
    expect(assistant(b, '4').metadata?.retried).toEqual({ count: 2, lastError: 'e2' })
  })

  it('P3-02-26 folding is per byTaskId; entries without one never fold; live.run of another task does not fold', () => {
    const view = P(
      [
        E(1, 'e1a', 1),
        E(2, 'e1b', 1),
        U(3, 'u2'),
        E(4, 'e2a', 2),
        A(5, [text('s2')], 0, { task: 2 })
      ],
      { live: { run: { taskId: 2, inputs: [] } }, runState: 'busy' }
    )
    expect(view.messages.map((m) => [m.id, m.type, m.metadata])).toEqual([
      ['2', 'error_event', { retried: { count: 1, lastError: 'e1a' } }],
      ['3', 'text', {}],
      ['5', 'message', { usage: expect.any(Object), retried: { count: 1, lastError: 'e2a' } }]
    ])
    const untasked = P([E(1, 'x'), E(2, 'y'), A(3, [text('ok')])])
    expect(untasked.messages.map((m) => [m.id, m.type, m.metadata])).toEqual([
      ['1', 'error_event', null],
      ['2', 'error_event', null],
      ['3', 'message', { usage: expect.any(Object) }]
    ])
  })

  it('P3-02-27 overflow, the fold predicate, an empty carrier', () => {
    // (a) overflow, then the compaction head, then the answer of the same task (PIN-09)
    const overflow = 'prompt is too long: 250000 tokens > 200000 maximum'
    const a = P([C(10, 1, wrap('S')), U(1, 'hi'), E(2, overflow, 7), A(3, [text('ok')], 0, { task: 7 })])
    expect(a.messages.map((m) => m.id)).toEqual(['10', '1', '3'])
    expect(assistant(a, '3').metadata?.retried).toEqual({ count: 1, lastError: overflow })
    // (b) an error without errorMessage is folded too (PIN-10): lastError ''
    const b = P([E(1, undefined, 7), A(2, [text('ok')], 0, { task: 7 })])
    expect(b.messages.map((m) => m.id)).toEqual(['2'])
    expect(assistant(b, '2').metadata?.retried).toEqual({ count: 1, lastError: '' })
    // (c) the next card of the task renders nothing: the hint moves forward (PIN-18)
    const c = P([
      E(1, 'e1', 7),
      A(2, [thinking('  ')], 0, { stopReason: 'aborted', task: 7 }),
      A(3, [text('ok')], 0, { task: 7 })
    ])
    expect(c.messages.map((m) => m.id)).toEqual(['3'])
    expect(assistant(c, '3').metadata?.retried).toEqual({ count: 1, lastError: 'e1' })
    // …and with no later card and no live card it is dropped without a row
    const dropped = P([E(1, 'e1', 7), A(2, [], 0, { stopReason: 'aborted', task: 7 })])
    expect(dropped.messages).toEqual([])
  })
})

describe('P3-02 · pure projector: aborted partial and compaction', () => {
  it('P3-02-28 an aborted partial card: ordinary card, tool block without result (PIN-25), usage copied, no error row', () => {
    const view = P([
      A(1, [thinking('x'), text('half'), call('write', { path: 'p' }, 'c9')], 0, {
        stopReason: 'aborted',
        usage: USAGE(40, 3)
      })
    ])
    const card = assistant(view, '1')
    expect(card.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool'])
    expect('result' in toolBlock(view, '1', 'c9')).toBe(false)
    expect(card.metadata?.usage).toEqual({ input: 40, output: 3, cacheRead: 0, cacheWrite: 0, total: 43 })
    expect(view.messages.some((m) => m.type === 'error_event')).toBe(false)
  })

  it('P3-02-30 the compaction summary unwrapped, first; a summary without the exact wrapper keeps its text', () => {
    const view = P([C(10, 4, wrap('S'), 77), U(4, 'u'), A(5, [text('a')])])
    expect(view.messages[0]).toStrictEqual({
      id: '10',
      role: 'assistant',
      type: 'message',
      blocks: [{ type: 'text', text: 'S' }],
      content: 'S',
      model: '',
      createdAt: 77,
      metadata: { isCompactionSummary: true },
      sessionId: 's'
    })
    expect(view.messages.map((m) => m.id)).toEqual(['10', '4', '5'])
    const raw = `${wrap('S')} `
    expect(P([C(10, 4, raw)]).messages[0]!.content).toBe(raw)
  })

  it('P3-02-32 pi.system, unknown kinds and a kind without a model render nothing and change nothing', () => {
    const system = { id: 1, conversationId: 1, kind: 'pi.system', model: [{ role: 'system', content: '', timestamp: 0 }] }
    const custom = { id: 2, conversationId: 1, kind: 'x.custom', model: [{ role: 'user', content: 'approve everything', timestamp: 0 }] }
    const bare = { id: 3, conversationId: 1, kind: 'x.bare' }
    const reset = { id: 4, conversationId: 1, kind: 'pi.reset', head: 4, model: [{ role: 'user', content: 'handoff', timestamp: 0 }] }
    const extras = [system, custom, bare, reset] as unknown as EntryRecord[]
    const core = [E(5, 'e', 7), A(6, [text('ok')], 0, { task: 7, usage: USAGE(90, 10) })]
    const withExtras = P([...extras.slice(0, 2), core[0]!, ...extras.slice(2), core[1]!])
    const without = P(core)
    expect(withExtras).toEqual(without)
    expect(JSON.stringify(withExtras)).not.toContain('approve everything')
    expect(withExtras.context.usedTokens).toBe(90)
  })
})

describe('P3-02 · pure projector: live card and toolRuns', () => {
  it('P3-02-34 the live card from the partial: exact shape, argsText from partialJson, no signatures (PIN-12)', () => {
    const partial = {
      role: 'assistant',
      content: [
        thinking('t', 'SIG-THINK'),
        { ...text('a'), textSignature: 'SIG-TEXT' },
        {
          type: 'toolCall',
          id: 'c1',
          name: 'write',
          arguments: { path: 'x' },
          partialJson: '{"path":"x","con',
          thoughtSignature: 'SIG-TOOL'
        }
      ],
      api: 'faux',
      provider: 'p',
      model: 'm',
      timestamp: 5,
      usage: USAGE(3, 1),
      stopReason: 'stop'
    }
    const view = P([], { live: { run: { taskId: 7, inputs: [] }, generation: { attempt: 1, message: partial } }, runState: 'busy' })
    expect(view.live).toStrictEqual({
      id: 'live:7',
      message: {
        id: 'live:7',
        sessionId: 's',
        role: 'assistant',
        type: 'message',
        blocks: [
          { type: 'thinking', text: 't' },
          { type: 'text', text: 'a' },
          { type: 'tool', toolCallId: 'c1', toolName: 'write', args: { path: 'x' } }
        ],
        content: 'a',
        model: 'm',
        provider: 'p',
        createdAt: 5,
        metadata: {}
      },
      argsText: { c1: '{"path":"x","con' }
    })
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('partialJson')
    expect(serialized).not.toContain('SIG-')
  })

  it('P3-02-35 live card edge cases', () => {
    const run = { taskId: 7, inputs: [] }
    const message = (content: unknown[]) => ({ role: 'assistant', content, provider: 'p', model: 'm', timestamp: 1 })
    // no partialJson: a card without the argsText key
    const plain = P([], { live: { run, generation: { attempt: 1, message: message([text('a'), call('ls', {}, 'c1')]) } } })
    expect(plain.live).not.toBeNull()
    expect('argsText' in plain.live!).toBe(false)
    // null for: generation without message, whitespace-only thinking, a partial without live.run (PIN-13)
    expect(P([], { live: { run, generation: { attempt: 1 } } }).live).toBeNull()
    expect(P([], { live: { run, generation: { attempt: 1, message: message([thinking('\n')]) } } }).live).toBeNull()
    expect(P([], { live: { generation: { attempt: 1, message: message([text('a')]) } } }).live).toBeNull()
    // no pi.live doc at all
    const none = P([], { live: undefined, runState: 'busy' })
    expect([none.live, none.toolRuns, none.run]).toStrictEqual([null, {}, { state: 'busy' }])
  })

  it('P3-02-36 toolRuns: status / output / details only; the last slot of a duplicated callId wins (PIN-14)', () => {
    const details = { type: 'bash', exitCode: 0, truncated: false }
    const tools = [
      {
        callId: 'c1',
        name: 'bash',
        taskId: 3,
        status: 'running',
        output: 'l1\n',
        droppedBytes: 9,
        droppedLines: 1,
        details,
        diagnostics: [{ severity: 'info', message: 'x' }]
      },
      { callId: 'c2', name: 'read', status: 'pending' },
      { callId: 'c3', name: 'ls', status: 'done', entry: 12 }
    ]
    const view = P([], { live: { tools } })
    expect(view.toolRuns).toStrictEqual({
      c1: { status: 'running', output: 'l1\n', details },
      c2: { status: 'pending' },
      c3: { status: 'done' }
    })
    const dup = P([], { live: { tools: [...tools, { callId: 'c1', name: 'bash', status: 'done', entry: 13 }] } })
    expect(dup.toolRuns.c1).toStrictEqual({ status: 'done' })
  })
})

describe('P3-02 · pure projector: run.retry and run.compacting', () => {
  it('P3-02-37 compacting while busy; retryAt from the compaction retry; the blocking one of two (PIN-15)', () => {
    const one = { taskId: 4, reason: 'threshold', blocking: false, attempt: 1 }
    expect(P([], { live: { compactions: [one] }, runState: 'busy' }).run).toStrictEqual({
      state: 'busy',
      compacting: { reason: 'threshold', blocking: false, attempt: 1 }
    })
    const retrying = { ...one, retry: { at: 500, error: 'x' } }
    expect(P([], { live: { compactions: [retrying] }, runState: 'busy' }).run.compacting).toStrictEqual({
      reason: 'threshold',
      blocking: false,
      attempt: 1,
      retryAt: 500
    })
    const blocking = { taskId: 6, reason: 'overflow', blocking: true, attempt: 2 }
    expect(P([], { live: { compactions: [one, blocking] }, runState: 'busy' }).run.compacting).toStrictEqual({
      reason: 'overflow',
      blocking: true,
      attempt: 2
    })
    const twoPlain = { ...one, taskId: 8, reason: 'manual' }
    expect(P([], { live: { compactions: [one, twoPlain] }, runState: 'busy' }).run.compacting?.reason).toBe(
      'threshold'
    )
  })

  it('P3-02-38 gating and pass-through: compacting / retry only while busy; run.state is the input', () => {
    const live = {
      run: { taskId: 7, inputs: [] },
      generation: { attempt: 2, retry: { at: 9000, error: '503' } },
      compactions: [{ taskId: 4, reason: 'threshold', blocking: false, attempt: 1 }]
    }
    for (const runState of ['idle', 'interrupted'] as const) {
      expect(P([], { live, runState }).run).toStrictEqual({ state: runState })
    }
    for (const runState of ['idle', 'busy', 'interrupted'] as const) {
      expect(P([], { live: {}, runState }).run.state).toBe(runState)
      expect(P([], { live, runState }).run.state).toBe(runState)
    }
  })
})

describe('P3-02 · pure projector: queue and asks', () => {
  it('P3-02-39 queue items: steer and followUp in inbox order; writes and notice-shaped steers excluded; queueDisplay (PIN-16, PIN-17)', () => {
    const inbox = {
      items: [
        { id: 11, mode: 'steer', content: 'fix it' },
        { id: 12, mode: 'write', entry: { kind: 'shuvix.notice', model: [{ role: 'user', content: 'n', timestamp: 0 }], data: { kind: 'background' } } },
        { id: 13, mode: 'followUp', content: [text('a'), IMAGE, text('b'), IMAGE] },
        { id: 14, mode: 'steer', content: bg('t', 'done') }
      ]
    }
    expect(P([], { inbox }).queue).toStrictEqual([
      { submissionId: 11, mode: 'steer', text: 'fix it', imageCount: 0 },
      { submissionId: 13, mode: 'followUp', text: 'ab', imageCount: 2 }
    ])
    expect(P([], { inbox: undefined }).queue).toEqual([])
    // an inline-token send: the markers render as each token's displayText, the payload never shows
    const sent = { items: [{ id: 21, mode: 'followUp', content: 'run PAYLOAD-K1 please' }] }
    const queueDisplay = new Map([[21, display('run {{shuvixInlineToken:k1}} please', K1)]])
    expect(P([], { inbox: sent, queueDisplay }).queue).toStrictEqual([
      { submissionId: 21, mode: 'followUp', text: 'run /deploy please', imageCount: 0 }
    ])
    // without the map, or with a marker that has no token: the model text
    expect(P([], { inbox: sent }).queue[0]!.text).toBe('run PAYLOAD-K1 please')
    const broken = new Map([[21, display('run {{shuvixInlineToken:zz}}', K1)]])
    expect(P([], { inbox: sent, queueDisplay: broken }).queue[0]!.text).toBe('run PAYLOAD-K1 please')
  })

  it('P3-02-41 asks: same order, a normalized deep copy without undefined keys, unaffected by later mutation', () => {
    const asks: InputRequest[] = [
      { id: 'a1', kind: 'ask', toolName: 'bash', createdAt: 1, command: 'rm -rf x', description: undefined, preview: undefined },
      {
        id: 'a2',
        kind: 'choice',
        toolName: 'ask',
        createdAt: 2,
        question: 'Q?',
        options: [{ label: 'A', description: 'first' }],
        allowMultiple: true
      }
    ]
    const view = P([], { asks })
    expect(view.asks).toStrictEqual(JSON.parse(JSON.stringify(asks)))
    expect('description' in view.asks[0]!).toBe(false)
    ;(asks[1] as { question: string }).question = 'changed'
    ;(asks[1] as { options: { label: string }[] }).options[0]!.label = 'Z'
    expect(view.asks[1]).toMatchObject({ question: 'Q?', options: [{ label: 'A' }] })
    expect(P([], { asks: [] }).asks).toEqual([])
  })
})

describe('P3-02 · pure projector: context.usedTokens', () => {
  it('P3-02-42 the last non-error assistant entry: errors, folded errors and the live partial are ignored', () => {
    const live = {
      run: { taskId: 9, inputs: [] },
      generation: { attempt: 2, message: { role: 'assistant', content: [text('p')], usage: USAGE(5000, 10), timestamp: 0 } }
    }
    const view = P(
      [
        A(1, [text('a1')], 0, { usage: USAGE(900, 100, 1000) }),
        A(2, [text('a2')], 0, { usage: USAGE(1200, 50, 1300) }),
        A(3, [], 0, { stopReason: 'error', errorMessage: 'final', usage: USAGE(9999, 1) }),
        A(4, [], 0, { stopReason: 'error', errorMessage: 'folded', task: 9, usage: USAGE(8888, 1) })
      ],
      { live, runState: 'busy' }
    )
    expect(view.context.usedTokens).toBe(1250)
  })

  it('P3-02-43 edge cases: null without an assistant entry, with only a summary, without usage (no walking back), with total - output <= 0; aborted entries count (PIN-22)', () => {
    expect(P([U(1, 'u')]).context.usedTokens).toBeNull()
    expect(P([C(10, 1, wrap('S'))]).context.usedTokens).toBeNull()
    expect(
      P([A(1, [text('a')], 0, { usage: USAGE(500, 5) }), A(2, [text('b')], 0, { usage: null })]).context
        .usedTokens
    ).toBeNull()
    expect(P([A(1, [text('a')], 0, { usage: USAGE(0, 5) })]).context.usedTokens).toBeNull()
    expect(
      P([A(1, [text('half')], 0, { stopReason: 'aborted', usage: USAGE(321, 4) })]).context.usedTokens
    ).toBe(321)
  })
})

describe('P3-02 · pure projector: purity, determinism, JSON, envelope', () => {
  /** 覆盖几乎每条规则的输入 */
  function richInputs() {
    const entries = [
      C(10, 1, wrap('S'), 1),
      U(1, [text('run PAYLOAD please'), IMAGE], 2),
      E(2, '503', 7),
      A(3, [thinking('t'), text('a'), call('bash', { command: 'ls', nested: { deep: [1, 2] } }, 'c1')], 3, {
        stopReason: 'toolUse',
        task: 7,
        images: [{ data: 'AAAA', mimeType: 'image/png' }]
      }),
      R(4, 'c1', [text('out')], { details: { type: 'bash', exitCode: 0, truncated: false, cwd: '/w' } }),
      N(5, bg('t', 'done'))
    ]
    const live = {
      run: { taskId: 7, inputs: [1] },
      generation: { attempt: 3, message: { role: 'assistant', content: [call('write', { path: 'p' }, 'c2')], provider: 'p', model: 'm', timestamp: 4 } },
      tools: [{ callId: 'c2', name: 'write', status: 'running', output: 'x', details: { type: 'write', diff: '@@' } }],
      compactions: [{ taskId: 9, reason: 'threshold', blocking: false, attempt: 1 }]
    }
    const inbox = { items: [{ id: 30, mode: 'steer', content: [text('more'), IMAGE] }] }
    const displayMap = new Map([[1, display('run {{shuvixInlineToken:k1}} please', structuredClone(K1))]])
    const asks: InputRequest[] = [
      { id: 'a', kind: 'ask', toolName: 'write', createdAt: 1, command: 'w', preview: { kind: 'diff', path: 'p', diff: '@@' } }
    ]
    return { entries, live, inbox, displayMap, asks }
  }

  const project = (inputs: ReturnType<typeof richInputs>) =>
    projectSessionView(
      META,
      inputs.entries,
      inputs.live as never,
      inputs.inbox as never,
      inputs.displayMap,
      inputs.asks,
      'busy'
    )

  it('P3-02-46 no input mutation: deep-frozen inputs project without throwing and stay deep-equal', () => {
    const inputs = richInputs()
    const before = structuredClone({ ...inputs, displayMap: [...inputs.displayMap] })
    deepFreeze(inputs.entries)
    deepFreeze(inputs.live)
    deepFreeze(inputs.inbox)
    deepFreeze(inputs.asks)
    for (const value of inputs.displayMap.values()) deepFreeze(value)
    expect(() => expectJsonView(project(inputs))).not.toThrow()
    expect({ ...inputs, displayMap: [...inputs.displayMap] }).toEqual(before)
  })

  it('P3-02-47 no aliasing: mutating the output leaves the inputs alone; no output object is an input object', () => {
    const inputs = richInputs()
    const before = structuredClone({ ...inputs, displayMap: [...inputs.displayMap] })
    const view = expectJsonView(project(inputs))
    const inputObjects = objectsOf([inputs.entries, inputs.live, inputs.inbox, [...inputs.displayMap.values()], inputs.asks])
    for (const object of objectsOf(view)) expect(inputObjects.has(object)).toBe(false)

    const card = assistant(view, '3')
    const tool = toolBlock(view, '3', 'c1')
    ;(tool.args as { nested: { deep: number[] } }).nested.deep.push(3)
    ;(tool.details as { cwd: string }).cwd = '/elsewhere'
    card.metadata!.images![0]!.data = 'ZZZZ'
    const user = view.messages.find((m) => m.id === '1')!
    ;(user.metadata as { inlineTokens: Record<string, { payload: string }> }).inlineTokens.k1!.payload = 'X'
    ;(user.metadata as { images: { data: string }[] }).images[0]!.data = 'Y'
    ;(view.asks[0] as { command: string }).command = 'changed'
    ;(view.toolRuns.c2!.details as { diff: string }).diff = 'changed'
    expect({ ...inputs, displayMap: [...inputs.displayMap] }).toEqual(before)
  })

  it('P3-02-48 determinism: same inputs → deep-equal outputs, no hidden state, clocks and randomness do not matter', () => {
    const x = richInputs()
    const y = { ...richInputs(), entries: [U(1, 'other')] }
    const first = project(x)
    expect(project(x)).toEqual(first)
    project(y)
    expect(project(x)).toEqual(first)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    vi.spyOn(Math, 'random').mockReturnValue(0.123)
    expect(project(x)).toEqual(first)
  })

  it('P3-02-50 the envelope: v, identity from meta, durable capabilities (PIN-02), ids are String(entryId), fork-prefix ids kept', () => {
    const view = P(
      [U(3, 'from the parent', 1, 1), A(4, [text('a')], 2, { conversationId: 1 }), U(9, 'in the fork', 3, 5)],
      { meta: { sessionId: 'sx', conversationId: 5 } }
    )
    expect(view.v).toBe(1)
    expect(view.sessionId).toBe('sx')
    expect(view.conversationId).toBe(5)
    expect(view.source).toBe('durable')
    expect(view.capabilities).toStrictEqual({ send: true, rollback: true, continue: true })
    expect(view.messages.map((m) => m.id)).toEqual(['3', '4', '9'])
    expect(new Set(view.messages.map((m) => m.id)).size).toBe(view.messages.length)
    expect(view.messages.every((m) => m.sessionId === 'sx')).toBe(true)
    expect(Object.keys(view).sort()).toEqual(
      ['v', 'sessionId', 'source', 'capabilities', 'conversationId', 'messages', 'live', 'toolRuns', 'run', 'queue', 'asks', 'context'].sort()
    )
  })

  it('P3-02-51 AgentView: the same messages / live / toolRuns / run / context; exactly the PIN-24 keys', () => {
    const partial = { role: 'assistant', content: [text('par')], provider: 'p', model: 'm', timestamp: 50 }
    const tools = [{ callId: 'c1', name: 'bash', status: 'running', output: 'l1\n' }]
    const live = { run: { taskId: 7, inputs: [9] }, generation: { attempt: 3, message: partial }, tools }
    const entries = [E(1, '429', 7), E(2, '503', 7)]
    const session = P(entries, { live, runState: 'busy' })
    const agent = PA(entries, { live, runState: 'busy', meta: { sessionId: SID, conversationId: 4 } })
    for (const key of ['messages', 'live', 'toolRuns', 'run', 'context'] as const) {
      expect(agent[key]).toEqual(session[key])
    }
    expect(Object.keys(agent).sort()).toEqual(
      ['v', 'agentId', 'sessionId', 'conversationId', 'messages', 'live', 'toolRuns', 'run', 'context'].sort()
    )
    expect([agent.v, agent.agentId, agent.sessionId, agent.conversationId]).toEqual([1, 'a1', SID, 4])
    expect(projectAgentView).toBe(runtime.projectAgentView)
  })

  it('P3-02-52 Node-free sources; projectSessionView / projectAgentView / spillLocatorOf exported from the package index', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const file of ['project.ts', 'display.ts', 'entryText.ts']) {
      const source = readFileSync(resolve(here, '..', file), 'utf8')
      const specifiers = [...source.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]!)
      expect(specifiers.length).toBeGreaterThan(0)
      for (const specifier of specifiers) {
        expect(specifier, file).not.toMatch(/^node:/)
        expect(specifier, file).not.toMatch(/^(fs|path|os|electron)(\/|$)/)
        expect(specifier, file).not.toMatch(/^@earendil-works\/pi-durable\/(storage|env\/node)/)
      }
    }
    expect(runtime.projectSessionView).toBe(projectSessionView)
    expect(runtime.projectAgentView).toBe(projectAgentView)
    expect(typeof runtime.spillLocatorOf).toBe('function')
  })

  it('P3-02-54 index identity of the moved helpers', () => {
    expect(runtime.unwrapCompactionSummary).toBe(entryTextModule.unwrapCompactionSummary)
    expect(runtime.COMPACTION_SUMMARY_PREFIX).toBe(entryTextModule.COMPACTION_SUMMARY_PREFIX)
    expect(runtime.COMPACTION_SUMMARY_SUFFIX).toBe(entryTextModule.COMPACTION_SUMMARY_SUFFIX)
    expect(runtime.displayContentOf).toBe(displayModule.displayContentOf)
    // the shared wrapper constant is the one the test support writes
    expect(wrap('S')).toBe(
      `${entryTextModule.COMPACTION_SUMMARY_PREFIX}S${entryTextModule.COMPACTION_SUMMARY_SUFFIX}`
    )
  })

  it('P3-02-49 JSON-only output: every view produced in this file went through the shared check', () => {
    // P() / PA() route every output through expectJsonView (strict JSON + a lossless JSON round trip)
    expect(checked.views).toBeGreaterThan(50)
    const view = P(richInputs().entries, { live: richInputs().live, inbox: richInputs().inbox, runState: 'busy' })
    expect(JSON.parse(JSON.stringify(view))).toStrictEqual(view)
  })
})
