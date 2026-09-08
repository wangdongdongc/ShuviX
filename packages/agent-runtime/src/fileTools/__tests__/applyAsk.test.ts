/**
 * applyWrite / applyEdit 的询问接线单测 —— 内存 FileSystemPort + 假 FileGuards（写锁是真的串行链）。
 *
 * 核心不变量：询问卡片看到的 diff 与 tool result details.diff 是同一份（一次算成、一次封顶）；
 * 询问在 port.writeFile 之前、在文件锁内发生；询问期间文件被外部改动一律作废重来。
 */

import { describe, it, expect, vi } from 'vitest'
import type { FileSystemPort, FileGuards, WriteAskHook } from '../port'
import { applyWrite } from '../write'
import { applyEdit } from '../edit'
import { generateDiffString, normalizeToLF } from '../editDiff'

const DIFF_MAX_LINES = 1200
const DIFF_MAX_CHARS = 256 * 1024

interface MemFile {
  content: string
  mtimeMs: number
}

interface Harness {
  port: FileSystemPort
  guards: FileGuards
  /** 有序事件流：'ask:<path>' / 'write:<path>' —— 用于断言询问发生在写入之前 */
  events: string[]
  writes: { path: string; content: string }[]
  recordReads: string[]
  assertCalls: string[]
  seedFile(path: string, content: string): void
  seedRead(path: string): void
  /** 模拟外部编辑器改动：绕开 port.writeFile 计数，只推进 mtime */
  externalWrite(path: string, content: string): void
  contentOf(path: string): string | undefined
}

/**
 * 假 port + 假 guards。guards 的语义照桌面 fileTime 复刻：
 * 没读过就写 → 抛「必须先读」；mtime 晚于读取时间 → 抛「读后被改」。
 * mtime / 读取时间都取同一个逻辑时钟，避免真实时间戳的精度抖动。
 */
function makeHarness(): Harness {
  const files = new Map<string, MemFile>()
  const readTimes = new Map<string, number>()
  const locks = new Map<string, Promise<void>>()
  const events: string[] = []
  const writes: { path: string; content: string }[] = []
  const recordReads: string[] = []
  const assertCalls: string[] = []
  let clock = 1000
  const tick = (): number => ++clock

  const port: FileSystemPort = {
    stat: (p) => {
      const f = files.get(p)
      return Promise.resolve(
        f ? { isFile: true, isDirectory: false, size: f.content.length, mtimeMs: f.mtimeMs } : null
      )
    },
    readFile: (p) => {
      const f = files.get(p)
      if (!f) return Promise.reject(new Error(`ENOENT: ${p}`))
      return Promise.resolve(f.content)
    },
    writeFile: (p, content) => {
      events.push(`write:${p}`)
      writes.push({ path: p, content })
      files.set(p, { content, mtimeMs: tick() })
      return Promise.resolve()
    },
    readTextLines: () => {
      throw new Error('not used')
    },
    readBytes: () => {
      throw new Error('not used')
    },
    readdir: () => {
      throw new Error('not used')
    }
  }

  const guards: FileGuards = {
    hasReadTime: (p) => readTimes.has(p),
    assertNotModifiedSinceRead: (p) => {
      assertCalls.push(p)
      const time = readTimes.get(p)
      if (time === undefined) {
        throw new Error(`You must read file ${p} before overwriting it. Use the read tool first.`)
      }
      const f = files.get(p)
      if (f && f.mtimeMs > time) {
        throw new Error(`File ${p} has been modified since it was last read.`)
      }
    },
    recordRead: (p) => {
      recordReads.push(p)
      readTimes.set(p, tick())
    },
    // 真串行链（与桌面 withFileLock 同款）—— 并发用例靠它验证「后到者读到前者写入的结果」
    withFileLock: async (p, fn) => {
      const previous = locks.get(p) ?? Promise.resolve()
      let release: () => void = () => {}
      const next = new Promise<void>((resolve) => {
        release = resolve
      })
      const chained = previous.then(() => next)
      locks.set(p, chained)
      await previous
      try {
        return await fn()
      } finally {
        release()
        if (locks.get(p) === chained) locks.delete(p)
      }
    }
  }

  return {
    port,
    guards,
    events,
    writes,
    recordReads,
    assertCalls,
    seedFile: (p, content) => files.set(p, { content, mtimeMs: tick() }),
    seedRead: (p) => readTimes.set(p, tick()),
    externalWrite: (p, content) => files.set(p, { content, mtimeMs: tick() }),
    contentOf: (p) => files.get(p)?.content
  }
}

/** 记录 ask 钩子收到的载荷，并把调用点写进事件流 */
function spyAsk(
  h: Harness,
  impl?: (change: { path: string; diff: string; isNewFile?: boolean }) => void | Promise<void>
): {
  hook: WriteAskHook
  calls: { path: string; diff: string; isNewFile?: boolean }[]
} {
  const calls: { path: string; diff: string; isNewFile?: boolean }[] = []
  const hook: WriteAskHook = async (change) => {
    h.events.push(`ask:${change.path}`)
    calls.push(change)
    await impl?.(change)
  }
  return { hook, calls }
}

const changedLines = (diff: string): { added: string[]; removed: string[] } => ({
  added: diff.split('\n').filter((l) => l.startsWith('+')),
  removed: diff.split('\n').filter((l) => l.startsWith('-'))
})

const P = '/ws/file.txt'

// ─── 组 1：预览 diff ≡ 执行后 diff ────────────────────────────────────────────

describe('applyEdit/applyWrite — preview diff equals executed diff', () => {
  it('CONS-1: edit hands the ask hook the exact string it later returns in details.diff', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\nbeta\ngamma\n')
    h.seedRead(P)
    const ask = spyAsk(h)

    const res = await applyEdit(
      h.port,
      h.guards,
      P,
      { path: P, oldText: 'beta', newText: 'BETA' },
      ask.hook
    )

    expect(ask.calls).toHaveLength(1)
    // 字符串的 toBe 即逐字节相等（JS 无法再区分引用）
    expect(ask.calls[0].diff).toBe(res.details.diff)
    expect(res.details.diff).toContain('-2 beta')
    expect(res.details.diff).toContain('+2 BETA')
  })

  it('CONS-2: write of a new file previews an all-additions diff with isNewFile on both sides', async () => {
    const h = makeHarness()
    const ask = spyAsk(h)

    const res = await applyWrite(h.port, h.guards, P, { path: P, content: 'one\ntwo\n' }, ask.hook)

    expect(ask.calls[0].isNewFile).toBe(true)
    expect(res.details.isNewFile).toBe(true)
    expect(ask.calls[0].diff).toBe(res.details.diff)
    const lines = res.details.diff.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.every((l) => l.startsWith('+'))).toBe(true)
  })

  it('CONS-3: write over an existing file previews a diff against the old content, isNewFile false', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\nbeta\n')
    const ask = spyAsk(h)

    const res = await applyWrite(
      h.port,
      h.guards,
      P,
      { path: P, content: 'alpha\nGAMMA\n' },
      ask.hook
    )

    expect(ask.calls[0].isNewFile).toBe(false)
    expect(res.details.isNewFile).toBe(false)
    expect(ask.calls[0].diff).toBe(res.details.diff)
    const { added, removed } = changedLines(res.details.diff)
    expect(removed).toEqual(['-2 beta'])
    expect(added).toEqual(['+2 GAMMA'])
    expect(res.details.diff).toContain(' 1 alpha')
  })

  it('CONS-4: a >1200-line change is truncated once, and both sides get that same truncated string', async () => {
    const h = makeHarness()
    const content = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const ask = spyAsk(h)

    const res = await applyWrite(h.port, h.guards, P, { path: P, content }, ask.hook)

    const diff = res.details.diff
    expect(ask.calls[0].diff).toBe(diff)
    expect(diff.split('\n').length).toBeLessThanOrEqual(DIFF_MAX_LINES + 1)
    expect(diff).toMatch(/\n\[diff truncated — 300 more lines\]$/)
    // 只截断一次：整串里就一个标记
    expect(diff.match(/\[diff truncated/g)).toHaveLength(1)
  })

  it('CONS-5: a >256KB change (within the line budget) is char-capped identically on both sides', async () => {
    const h = makeHarness()
    const content = Array.from({ length: 300 }, () => 'x'.repeat(1000)).join('\n') + '\n'
    // 前提：触发的是字符上限而非行数上限
    const raw = generateDiffString('', normalizeToLF(content)).diff
    expect(raw.split('\n').length).toBeLessThanOrEqual(DIFF_MAX_LINES)
    expect(raw.length).toBeGreaterThan(DIFF_MAX_CHARS)

    const ask = spyAsk(h)
    const res = await applyWrite(h.port, h.guards, P, { path: P, content }, ask.hook)

    expect(ask.calls[0].diff).toBe(res.details.diff)
    expect(res.details.diff.length).toBeLessThan(raw.length)
    expect(res.details.diff).toMatch(/\[diff truncated — \d+ more lines\]$/)
  })

  it('CONS-6: a CRLF file diffs line-wise (not whole-file) and keeps CRLF on disk', async () => {
    const h = makeHarness()
    h.seedFile(P, 'a\r\nb\r\nc\r\n')
    h.seedRead(P)
    const ask = spyAsk(h)

    const res = await applyEdit(
      h.port,
      h.guards,
      P,
      { path: P, oldText: 'b', newText: 'B' },
      ask.hook
    )

    const { added, removed } = changedLines(res.details.diff)
    expect(removed).toEqual(['-2 b'])
    expect(added).toEqual(['+2 B'])
    expect(res.details.diff).not.toContain('\r')
    expect(ask.calls[0].diff).toBe(res.details.diff)
    expect(h.contentOf(P)).toBe('a\r\nB\r\nc\r\n')
  })

  it('CONS-7: a BOM file diffs without BOM noise and keeps the BOM on disk', async () => {
    const h = makeHarness()
    h.seedFile(P, '﻿a\nb\nc\n')
    h.seedRead(P)
    const ask = spyAsk(h)

    const res = await applyEdit(
      h.port,
      h.guards,
      P,
      { path: P, oldText: 'b', newText: 'B' },
      ask.hook
    )

    const { added, removed } = changedLines(res.details.diff)
    expect(removed).toEqual(['-2 b'])
    expect(added).toEqual(['+2 B'])
    expect(res.details.diff).not.toContain('﻿')
    expect(ask.calls[0].diff).toBe(res.details.diff)
    expect(h.contentOf(P)).toBe('﻿a\nB\nc\n')
  })

  it('CONS-15: firstChangedLine comes from the untruncated diff', async () => {
    const h = makeHarness()
    const keep = Array.from({ length: 100 }, (_, i) => `keep ${i}`)
    const before = Array.from({ length: 700 }, (_, i) => `old ${i}`)
    const after = Array.from({ length: 700 }, (_, i) => `new ${i}`)
    h.seedFile(P, [...keep, ...before].join('\n') + '\n')
    h.seedRead(P)
    const ask = spyAsk(h)

    const res = await applyEdit(
      h.port,
      h.guards,
      P,
      { path: P, oldText: before.join('\n'), newText: after.join('\n') },
      ask.hook
    )

    expect(res.details.diff).toMatch(/\[diff truncated — \d+ more lines\]$/)
    // 第一处改动在新文件的第 101 行 —— 截断只影响字符串，不影响这个游标
    expect(res.details.firstChangedLine).toBe(101)
  })
})

// ─── 组 1（续）：询问时序与作废重来 ──────────────────────────────────────────

describe('applyEdit/applyWrite — ask ordering and re-validation', () => {
  it('CONS-8: the ask hook runs before port.writeFile; throwing from it writes nothing', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\nbeta\n')
    h.seedRead(P)

    const ok = spyAsk(h)
    await applyEdit(h.port, h.guards, P, { path: P, oldText: 'beta', newText: 'B1' }, ok.hook)
    expect(h.events).toEqual([`ask:${P}`, `write:${P}`])

    const denied = spyAsk(h, () => {
      throw new Error('User denied access to /ws/file.txt')
    })
    await expect(
      applyEdit(h.port, h.guards, P, { path: P, oldText: 'B1', newText: 'B2' }, denied.hook)
    ).rejects.toThrow(/User denied access/)

    expect(h.writes).toHaveLength(1) // 只有第一次成功写入
    expect(h.contentOf(P)).toBe('alpha\nB1\n')
  })

  it('CONS-16: recordRead is not called when the ask hook throws', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\n')
    h.seedRead(P)
    const denied = spyAsk(h, () => {
      throw new Error('User denied access to /ws/file.txt')
    })

    await expect(
      applyEdit(h.port, h.guards, P, { path: P, oldText: 'alpha', newText: 'beta' }, denied.hook)
    ).rejects.toThrow()
    expect(h.recordReads).toEqual([])
  })

  it('CONS-9 (edit): an external change during the ask aborts the edit', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\nbeta\n')
    h.seedRead(P)
    const ask = spyAsk(h, () => {
      h.externalWrite(P, 'someone else typed this\n')
    })

    await expect(
      applyEdit(h.port, h.guards, P, { path: P, oldText: 'beta', newText: 'BETA' }, ask.hook)
    ).rejects.toThrow(/modified since it was last read/)

    expect(ask.calls).toHaveLength(1)
    expect(h.writes).toEqual([])
    expect(h.contentOf(P)).toBe('someone else typed this\n')
  })

  it('CONS-9 (write, never read): a file created during the ask aborts the write', async () => {
    const h = makeHarness()
    const ask = spyAsk(h, () => {
      h.externalWrite(P, 'created behind our back\n')
    })

    await expect(
      applyWrite(h.port, h.guards, P, { path: P, content: 'ours\n' }, ask.hook)
    ).rejects.toThrow(`${P} changed while waiting for your answer; re-read it and try again`)

    // 预览是「整份新建」，落盘却会覆盖别人刚建出来的内容 —— 必须作废
    expect(ask.calls[0].isNewFile).toBe(true)
    expect(h.writes).toEqual([])
    expect(h.contentOf(P)).toBe('created behind our back\n')
  })

  it('CONS-9 (write, never read): an existing file changed during the ask aborts the write', async () => {
    const h = makeHarness()
    h.seedFile(P, 'original\n')
    const ask = spyAsk(h, () => {
      h.externalWrite(P, 'edited elsewhere\n')
    })

    await expect(
      applyWrite(h.port, h.guards, P, { path: P, content: 'ours\n' }, ask.hook)
    ).rejects.toThrow(`${P} changed while waiting for your answer; re-read it and try again`)
    expect(h.writes).toEqual([])
  })

  it('CONS-9 (write, never read): an untouched file still goes through — the guard does not over-trigger', async () => {
    const h = makeHarness()
    h.seedFile(P, 'original\n')
    const ask = spyAsk(h)

    const res = await applyWrite(h.port, h.guards, P, { path: P, content: 'ours\n' }, ask.hook)

    expect(res.details.isNewFile).toBe(false)
    expect(h.contentOf(P)).toBe('ours\n')
  })

  it('CONS-9: the post-ask re-check only runs when an ask hook was supplied', async () => {
    const h = makeHarness()
    h.seedFile(P, 'original\n')

    // write 无 ask：没读过 → 前置检查跳过；无 ask → 事后复检也跳过
    await applyWrite(h.port, h.guards, P, { path: P, content: 'ours\n' })
    expect(h.assertCalls).toEqual([])

    // edit 无 ask：只有开头那一次前置检查
    h.seedRead(P)
    await applyEdit(h.port, h.guards, P, { path: P, oldText: 'ours', newText: 'theirs' })
    expect(h.assertCalls).toEqual([P])
  })

  it('CONS-10: concurrent edits serialize — the second ask sees the first write', async () => {
    const h = makeHarness()
    h.seedFile(P, 'line1\nline2\nline3\n')
    h.seedRead(P)

    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = spyAsk(h, () => firstGate)
    const second = spyAsk(h)

    const p1 = applyEdit(
      h.port,
      h.guards,
      P,
      { path: P, oldText: 'line1', newText: 'ONE' },
      first.hook
    )
    const p2 = applyEdit(
      h.port,
      h.guards,
      P,
      { path: P, oldText: 'line3', newText: 'THREE' },
      second.hook
    )

    // 第一次仍卡在询问里 → 第二次连询问都还没轮到
    await vi.waitFor(() => expect(first.calls).toHaveLength(1))
    expect(second.calls).toHaveLength(0)

    releaseFirst()
    await Promise.all([p1, p2])

    expect(h.events).toEqual([`ask:${P}`, `write:${P}`, `ask:${P}`, `write:${P}`])
    // 第二次的预览基于第一次写入后的内容（上下文里出现 ONE，而不是 line1）
    expect(second.calls[0].diff).toContain('ONE')
    expect(second.calls[0].diff).not.toContain('line1')
    expect(h.contentOf(P)).toBe('ONE\nline2\nTHREE\n')
  })

  it('CONS-10: a concurrent edit whose oldText no longer matches errors instead of silently dropping', async () => {
    const h = makeHarness()
    h.seedFile(P, 'target\ntail\n')
    h.seedRead(P)

    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = spyAsk(h, () => firstGate)
    const second = spyAsk(h)

    const p1 = applyEdit(
      h.port,
      h.guards,
      P,
      { path: P, oldText: 'target', newText: 'replaced' },
      first.hook
    )
    const p2 = applyEdit(
      h.port,
      h.guards,
      P,
      { path: P, oldText: 'target', newText: 'other' },
      second.hook
    )

    await vi.waitFor(() => expect(first.calls).toHaveLength(1))
    releaseFirst()

    await expect(p1).resolves.toBeDefined()
    await expect(p2).rejects.toThrow(/No match found/)
    expect(second.calls).toHaveLength(0)
    expect(h.contentOf(P)).toBe('replaced\ntail\n')
  })
})

// ─── 组 5：询问前的失败路径不得弹询问 ────────────────────────────────────────

describe('applyEdit/applyWrite — failures before the ask', () => {
  it('REG-1: a non-matching oldText fails before the ask', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\n')
    h.seedRead(P)
    const ask = spyAsk(h)

    await expect(
      applyEdit(h.port, h.guards, P, { path: P, oldText: 'nope', newText: 'x' }, ask.hook)
    ).rejects.toThrow(/No match found/)
    expect(ask.calls).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('REG-1: "No change produced" fails before the ask', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\n')
    h.seedRead(P)
    const ask = spyAsk(h)

    await expect(
      applyEdit(h.port, h.guards, P, { path: P, oldText: 'alpha', newText: 'alpha' }, ask.hook)
    ).rejects.toThrow(`No change produced: ${P}`)
    expect(ask.calls).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('REG-2: editing a missing file reports File not found before the ask', async () => {
    const h = makeHarness()
    const ask = spyAsk(h)

    await expect(
      applyEdit(h.port, h.guards, P, { path: P, oldText: 'a', newText: 'b' }, ask.hook)
    ).rejects.toThrow(`File not found: ${P}`)
    expect(ask.calls).toEqual([])
  })

  it('REG-5: writing a never-read new file needs no prior read and records one afterwards', async () => {
    const h = makeHarness()
    const ask = spyAsk(h)

    const res = await applyWrite(h.port, h.guards, P, { path: P, content: 'fresh\n' }, ask.hook)

    expect(res.details.isNewFile).toBe(true)
    expect(h.contentOf(P)).toBe('fresh\n')
    expect(h.recordReads).toEqual([P])
  })
})

// ─── 组 6：从未读文件的基线登记（「写前必读」守卫放宽） ──────────────────────
//
// 放宽后的语义：编辑本会话从未 read 过的已存在文件不再报错，edit 内部整读即登记为
// 读取基线；唯一保留的守卫报错是「基线之后被外部修改」。两个被钉住的裁决：
//   - 询问被拒 / oldText 失配时，内部整读登记的基线**留存**（读取确实发生了）；
//   - 已读文件不在整读处重复登记，基线只在写入成功后更新。

describe('applyEdit — never-read file baseline registration', () => {
  it('EG-1: never-read + no ask → goes through; internal read registers the baseline before write', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\nbeta\n')
    // 联合探针：recordRead 与 write 的相对顺序（harness 的 events 只记 ask/write）
    const order: string[] = []
    const origRecordRead = h.guards.recordRead
    h.guards.recordRead = (p) => {
      order.push(`read:${p}`)
      origRecordRead(p)
    }
    const origWriteFile = h.port.writeFile
    h.port.writeFile = (p, content) => {
      order.push(`write:${p}`)
      return origWriteFile(p, content)
    }

    const res = await applyEdit(h.port, h.guards, P, { path: P, oldText: 'beta', newText: 'BETA' })

    expect(res.details.type).toBe('edit')
    expect(h.contentOf(P)).toBe('alpha\nBETA\n')
    expect(h.assertCalls).toEqual([]) // 从未读 → 无前置校验，无 ask → 无事后复检
    expect(h.recordReads).toEqual([P, P]) // 整读基线 + 写后各一次
    // 首次 recordRead 早于 write
    expect(order).toEqual([`read:${P}`, `write:${P}`, `read:${P}`])
  })

  it('EG-2: never-read + ask, external change during the ask → modified-since; baseline precedes the ask', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\nbeta\n')
    const ask = spyAsk(h, () => {
      // 核心时序：基线登记先于询问 —— 此刻内部整读已经发生
      expect(h.recordReads).toEqual([P])
      h.externalWrite(P, 'someone else typed this\n')
    })

    await expect(
      applyEdit(h.port, h.guards, P, { path: P, oldText: 'beta', newText: 'BETA' }, ask.hook)
    ).rejects.toThrow(/modified since it was last read/)

    expect(ask.calls).toHaveLength(1)
    expect(h.writes).toEqual([])
    expect(h.contentOf(P)).toBe('someone else typed this\n')
  })

  it('EG-3: never-read + ask, untouched during the ask → goes through; only the post-ask re-check runs', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\nbeta\n')
    const ask = spyAsk(h)

    await applyEdit(h.port, h.guards, P, { path: P, oldText: 'beta', newText: 'BETA' }, ask.hook)

    expect(h.contentOf(P)).toBe('alpha\nBETA\n')
    expect(h.assertCalls).toEqual([P]) // 仅事后复检，无前置
    expect(h.events).toEqual([`ask:${P}`, `write:${P}`])
  })

  it('EG-4: already-read file does not re-register at the internal read — recordRead only after write', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\nbeta\n')
    h.seedRead(P)

    await applyEdit(h.port, h.guards, P, { path: P, oldText: 'beta', newText: 'BETA' })

    expect(h.contentOf(P)).toBe('alpha\nBETA\n')
    expect(h.recordReads).toEqual([P]) // 恰一次：仅写后
  })

  it('EG-5: ask denied on a never-read file keeps the baseline (the read did happen)', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\nbeta\n')
    const denied = spyAsk(h, () => {
      throw new Error('User denied access to /ws/file.txt')
    })

    await expect(
      applyEdit(h.port, h.guards, P, { path: P, oldText: 'beta', newText: 'BETA' }, denied.hook)
    ).rejects.toThrow(/User denied access/)
    expect(h.writes).toEqual([])
    expect(h.contentOf(P)).toBe('alpha\nbeta\n')
    // 基线留存
    expect(h.guards.hasReadTime(P)).toBe(true)

    // 无外部改动 → 以留存的基线通过前置校验，编辑成功
    await applyEdit(h.port, h.guards, P, { path: P, oldText: 'beta', newText: 'BETA' })
    expect(h.contentOf(P)).toBe('alpha\nBETA\n')

    // 基线之后被外部改动 → 抛 modified-since
    h.externalWrite(P, 'typed elsewhere\n')
    await expect(
      applyEdit(h.port, h.guards, P, { path: P, oldText: 'BETA', newText: 'X' })
    ).rejects.toThrow(/modified since it was last read/)
    expect(h.contentOf(P)).toBe('typed elsewhere\n')
  })

  it('EG-6: after the first successful edit, the recorded baseline gates the second edit', async () => {
    // 外部改动 → 第二次 edit 抛 modified-since
    const h1 = makeHarness()
    h1.seedFile(P, 'alpha\n')
    await applyEdit(h1.port, h1.guards, P, { path: P, oldText: 'alpha', newText: 'one' })
    h1.externalWrite(P, 'external\n')
    await expect(
      applyEdit(h1.port, h1.guards, P, { path: P, oldText: 'external', newText: 'two' })
    ).rejects.toThrow(/modified since/)
    expect(h1.contentOf(P)).toBe('external\n')

    // 无改动 → 第二次 edit 成功（自身写入不触发守卫）
    const h2 = makeHarness()
    h2.seedFile(P, 'alpha\n')
    await applyEdit(h2.port, h2.guards, P, { path: P, oldText: 'alpha', newText: 'one' })
    await applyEdit(h2.port, h2.guards, P, { path: P, oldText: 'one', newText: 'two' })
    expect(h2.contentOf(P)).toBe('two\n')
  })

  it('EG-7: concurrent edits on a never-read file serialize — the second ask sees the first write', async () => {
    const h = makeHarness()
    h.seedFile(P, 'line1\nline2\nline3\n') // 不 seedRead：CONS-10 的 never-read 变体

    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = spyAsk(h, () => firstGate)
    const second = spyAsk(h)

    const p1 = applyEdit(
      h.port,
      h.guards,
      P,
      { path: P, oldText: 'line1', newText: 'ONE' },
      first.hook
    )
    const p2 = applyEdit(
      h.port,
      h.guards,
      P,
      { path: P, oldText: 'line3', newText: 'THREE' },
      second.hook
    )

    await vi.waitFor(() => expect(first.calls).toHaveLength(1))
    expect(second.calls).toHaveLength(0)

    releaseFirst()
    await Promise.all([p1, p2])

    expect(h.events).toEqual([`ask:${P}`, `write:${P}`, `ask:${P}`, `write:${P}`])
    // 第二人进锁时第一人已写完（其 recordRead 成为前置校验基线）：预览基于新内容
    expect(second.calls[0].diff).toContain('ONE')
    expect(second.calls[0].diff).not.toContain('line1')
    expect(h.contentOf(P)).toBe('ONE\nline2\nTHREE\n')
  })

  it('EG-8: a failed match attempt on a never-read file still leaves the read baseline', async () => {
    // oldText 失配
    const h = makeHarness()
    h.seedFile(P, 'alpha\n')
    const ask = spyAsk(h)

    await expect(
      applyEdit(h.port, h.guards, P, { path: P, oldText: 'nope', newText: 'x' }, ask.hook)
    ).rejects.toThrow(/No match found/)
    expect(ask.calls).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.recordReads).toEqual([P]) // 失败尝试仍留基线

    // No change produced 变体同样留基线
    const h2 = makeHarness()
    h2.seedFile(P, 'alpha\n')
    const ask2 = spyAsk(h2)
    await expect(
      applyEdit(h2.port, h2.guards, P, { path: P, oldText: 'alpha', newText: 'alpha' }, ask2.hook)
    ).rejects.toThrow(`No change produced: ${P}`)
    expect(ask2.calls).toEqual([])
    expect(h2.writes).toEqual([])
    expect(h2.recordReads).toEqual([P])
  })

  it('EG-9: a failing readFile propagates as-is and leaves no half-registered baseline', async () => {
    const h = makeHarness()
    h.seedFile(P, 'alpha\n')
    const origReadFile = h.port.readFile
    // 注入读取失败（文件存在但读不出来，非 ENOENT）
    h.port.readFile = () => Promise.reject(new Error('EACCES: permission denied'))

    await expect(
      applyEdit(h.port, h.guards, P, { path: P, oldText: 'alpha', newText: 'x' })
    ).rejects.toThrow('EACCES: permission denied')
    expect(h.recordReads).toEqual([])
    expect(h.guards.hasReadTime(P)).toBe(false)

    // 重试仍按从未读走：stat 通过 → 整读登记基线 → 成功
    h.port.readFile = origReadFile
    await applyEdit(h.port, h.guards, P, { path: P, oldText: 'alpha', newText: 'x' })
    expect(h.recordReads).toEqual([P, P])
    expect(h.contentOf(P)).toBe('x\n')
  })
})
