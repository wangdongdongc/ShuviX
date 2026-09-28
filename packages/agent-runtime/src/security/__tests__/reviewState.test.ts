/**
 * 询问点自动审查的会话内状态（reviewState.ts）—— 进程内存、按会话分桶：
 *   - 拒绝计数：连续 3 次或累计 20 次审查拒绝之后，本会话的询问跳过审查、直接问人；
 *     审查放行 / 人回答一次清连续计数，累计计数只有 clearReviewState 清；
 *   - 人在审批卡片上写的反馈：执行层收到「其它」回答时记下，审查员只认这一份；
 *   - 进行中的审查：会话被停止时一并中止，下一次 prompt 之前不再受理新的。
 *
 * 状态是进程级的 Map：每条用例用自己的会话 id，afterEach 统一 clearReviewState。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  REVIEW_CONSECUTIVE_DENIAL_LIMIT,
  REVIEW_TOTAL_DENIAL_LIMIT,
  abortSessionReviews,
  clearReviewState,
  humanFeedbackOf,
  noteHumanFeedback,
  noteReviewCleared,
  noteReviewDenied,
  reopenSessionReviews,
  reviewSuspended,
  trackReview
} from '../reviewState'

const used = new Set<string>()
let seq = 0

/** 本条用例专用的会话 id（afterEach 清掉） */
function newSid(label = 'rs'): string {
  const sid = `review-state-${label}-${++seq}`
  used.add(sid)
  return sid
}

afterEach(() => {
  for (const sid of used) clearReviewState(sid)
  used.clear()
  vi.useRealTimers()
})

/** 连着拒绝 n 次 */
function denyTimes(sid: string, n: number): void {
  for (let i = 0; i < n; i++) noteReviewDenied(sid)
}

describe('reviewState — 拒绝计数', () => {
  it('RS-1 新会话不暂停；对不存在的会话调 noteReviewCleared 不抛、不凭空建状态（之后的拒绝从零数起）', () => {
    const sid = newSid()
    expect(reviewSuspended(sid)).toBe(false)

    expect(() => noteReviewCleared(sid)).not.toThrow()
    expect(reviewSuspended(sid)).toBe(false)

    // 状态是否凭空建出来，从外面只看得到计数：清零之后第三次拒绝才暂停，与全新的会话一模一样
    denyTimes(sid, 2)
    expect(reviewSuspended(sid)).toBe(false)
    noteReviewDenied(sid)
    expect(reviewSuspended(sid)).toBe(true)
  })

  it('RS-2 同一会话 deny 两次仍不暂停，第三次暂停', () => {
    const sid = newSid()
    noteReviewDenied(sid)
    expect(reviewSuspended(sid)).toBe(false)
    noteReviewDenied(sid)
    expect(reviewSuspended(sid)).toBe(false)
    noteReviewDenied(sid)
    expect(reviewSuspended(sid)).toBe(true)
  })

  it('RS-3 deny×2 → cleared → deny×2 仍不暂停（连续计数清零了）；再 deny 一次暂停', () => {
    const sid = newSid()
    denyTimes(sid, 2)
    noteReviewCleared(sid)
    denyTimes(sid, 2)
    expect(reviewSuspended(sid)).toBe(false)
    noteReviewDenied(sid)
    expect(reviewSuspended(sid)).toBe(true)
  })

  it('RS-4 以 (deny, deny, cleared) 循环累计：到 19 次都不暂停，第 20 次暂停；之后 cleared 也不再恢复', () => {
    const sid = newSid()
    let total = 0
    while (total < REVIEW_TOTAL_DENIAL_LIMIT) {
      for (let i = 0; i < 2 && total < REVIEW_TOTAL_DENIAL_LIMIT; i++) {
        noteReviewDenied(sid)
        total += 1
        // 连续计数从没到 3：暂停与否只看累计
        expect({ total, suspended: reviewSuspended(sid) }).toEqual({
          total,
          suspended: total >= REVIEW_TOTAL_DENIAL_LIMIT
        })
      }
      if (total < REVIEW_TOTAL_DENIAL_LIMIT) noteReviewCleared(sid)
    }
    expect(total).toBe(20)
    expect(reviewSuspended(sid)).toBe(true)

    noteReviewCleared(sid)
    expect(reviewSuspended(sid)).toBe(true)
    noteReviewCleared(sid)
    expect(reviewSuspended(sid)).toBe(true)
  })

  it('RS-5 因连续拒绝暂停之后，一次 cleared 就恢复（累计还没到 20）', () => {
    const sid = newSid()
    denyTimes(sid, 3)
    expect(reviewSuspended(sid)).toBe(true)
    noteReviewCleared(sid)
    expect(reviewSuspended(sid)).toBe(false)
  })

  it('RS-6 clearReviewState 两个计数都清：累计到 20 → clear → deny×2 仍不暂停', () => {
    const sid = newSid()
    for (let i = 0; i < 10; i++) {
      denyTimes(sid, 2)
      noteReviewCleared(sid)
    }
    expect(reviewSuspended(sid)).toBe(true)

    clearReviewState(sid)
    expect(reviewSuspended(sid)).toBe(false)
    denyTimes(sid, 2)
    expect(reviewSuspended(sid)).toBe(false)
    noteReviewDenied(sid)
    expect(reviewSuspended(sid)).toBe(true)
  })

  it('RS-7 会话之间互不影响：一个暂停、清零或清理，另一个的计数原样', () => {
    const a = newSid('a')
    const b = newSid('b')

    denyTimes(a, 3)
    denyTimes(b, 2)
    expect(reviewSuspended(a)).toBe(true)
    expect(reviewSuspended(b)).toBe(false)

    // a 清零不动 b 的连续计数：b 再拒一次就到 3
    noteReviewCleared(a)
    expect(reviewSuspended(a)).toBe(false)
    noteReviewDenied(b)
    expect(reviewSuspended(b)).toBe(true)

    // 清理 b 不动 a
    denyTimes(a, 3)
    clearReviewState(b)
    expect(reviewSuspended(b)).toBe(false)
    expect(reviewSuspended(a)).toBe(true)
  })

  it('RS-8 阈值常量 3 / 20；@shuvix/agent-runtime 入口导出 clearReviewState、reviewSuspended 与这两个常量', async () => {
    expect(REVIEW_CONSECUTIVE_DENIAL_LIMIT).toBe(3)
    expect(REVIEW_TOTAL_DENIAL_LIMIT).toBe(20)

    const runtime = await import('../../index')
    expect(runtime.clearReviewState).toBe(clearReviewState)
    expect(runtime.reviewSuspended).toBe(reviewSuspended)
    expect(runtime.REVIEW_CONSECUTIVE_DENIAL_LIMIT).toBe(3)
    expect(runtime.REVIEW_TOTAL_DENIAL_LIMIT).toBe(20)
  })
})

describe('reviewState — 人在审批卡片上写的反馈', () => {
  it('RS-9 noteHumanFeedback / humanFeedbackOf：旧 → 新、返回副本、每会话上限 20 丢旧的、按会话隔离、clearReviewState 清掉', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-28T10:00:00Z'))
    const t0 = Date.now()
    const a = newSid('a')
    const b = newSid('b')

    expect(humanFeedbackOf(a)).toEqual([])

    noteHumanFeedback(a, 'rm -rf build', 'only delete build/tmp')
    vi.advanceTimersByTime(1000)
    noteHumanFeedback(a, 'Write(/ws/a.txt)', 'write it to b.txt instead')
    expect(humanFeedbackOf(a)).toEqual([
      { ts: t0, target: 'rm -rf build', text: 'only delete build/tmp' },
      { ts: t0 + 1000, target: 'Write(/ws/a.txt)', text: 'write it to b.txt instead' }
    ])

    // 副本：增删返回的数组不动存着的那份
    const copy = humanFeedbackOf(a)
    expect(copy).not.toBe(humanFeedbackOf(a))
    copy.pop()
    copy.push({ ts: 0, target: 'x', text: 'injected' }, { ts: 1, target: 'y', text: 'again' })
    expect(humanFeedbackOf(a).map((n) => n.text)).toEqual([
      'only delete build/tmp',
      'write it to b.txt instead'
    ])

    // 按会话隔离
    expect(humanFeedbackOf(b)).toEqual([])
    noteHumanFeedback(b, 'ls', 'fine')
    expect(humanFeedbackOf(b)).toEqual([{ ts: expect.any(Number), target: 'ls', text: 'fine' }])
    expect(humanFeedbackOf(a)).toHaveLength(2)

    // 上限 20：再记 20 条，最早的两条被挤掉，剩下的仍是旧 → 新
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(10)
      noteHumanFeedback(a, `cmd-${i}`, `note-${i}`)
    }
    const kept = humanFeedbackOf(a)
    expect(kept).toHaveLength(20)
    expect(kept.map((n) => n.target)).toEqual(Array.from({ length: 20 }, (_, i) => `cmd-${i}`))
    for (let i = 1; i < kept.length; i++) expect(kept[i].ts).toBeGreaterThan(kept[i - 1].ts)

    // clearReviewState 只清这个会话的
    clearReviewState(a)
    expect(humanFeedbackOf(a)).toEqual([])
    expect(humanFeedbackOf(b)).toHaveLength(1)
  })
})

describe('reviewState — 进行中的审查', () => {
  it('RS-10 trackReview 登记并返回注销函数；abortSessionReviews 只中止本会话已登记的；之后 trackReview 回 null 直到 reopenSessionReviews；注销的不再被中止；clearReviewState 中止进行中的并解除关闭', () => {
    const a = newSid('a')
    const b = newSid('b')

    const inA = new AbortController()
    const releasedA = new AbortController()
    const inB = new AbortController()
    const releaseA = trackReview(a, inA)
    const releaseReleased = trackReview(a, releasedA)
    const releaseB = trackReview(b, inB)
    expect(typeof releaseA).toBe('function')
    expect(typeof releaseReleased).toBe('function')
    expect(typeof releaseB).toBe('function')

    // 注销了的不再被中止
    releaseReleased!()
    abortSessionReviews(a)
    expect(inA.signal.aborted).toBe(true)
    expect(releasedA.signal.aborted).toBe(false)
    // 别的会话不受影响，也照常受理
    expect(inB.signal.aborted).toBe(false)
    expect(trackReview(b, new AbortController())).not.toBeNull()

    // 停止之后、下一轮之前：不再受理
    expect(trackReview(a, new AbortController())).toBeNull()
    expect(trackReview(a, new AbortController())).toBeNull()
    releaseA!()

    reopenSessionReviews(a)
    const afterReopen = new AbortController()
    const releaseAfterReopen = trackReview(a, afterReopen)
    expect(typeof releaseAfterReopen).toBe('function')
    releaseAfterReopen!()

    // 对从没停止过的会话 reopen 无害
    expect(() => reopenSessionReviews(newSid('never-stopped'))).not.toThrow()
    releaseB!()
  })

  it('RS-10 clearReviewState：中止进行中的审查、解除「已停止」；清理之前拿到的注销函数不会误删之后登记的', () => {
    const sid = newSid()

    const inflight = new AbortController()
    const staleRelease = trackReview(sid, inflight)
    expect(staleRelease).not.toBeNull()
    clearReviewState(sid)
    expect(inflight.signal.aborted).toBe(true)

    // 已停止的会话 → clearReviewState 之后重新受理
    abortSessionReviews(sid)
    expect(trackReview(sid, new AbortController())).toBeNull()
    clearReviewState(sid)
    const fresh = new AbortController()
    const release = trackReview(sid, fresh)
    expect(typeof release).toBe('function')

    // 旧的注销函数指着清理之前那一组：调了它，新登记的照样会被停止中止
    staleRelease!()
    abortSessionReviews(sid)
    expect(fresh.signal.aborted).toBe(true)
    release!()
  })
})
