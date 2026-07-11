import { describe, it, expect, vi } from 'vitest'
import { gateBrowserOp, describeBrowserOp } from '../gate'
import { BROWSER_OPS } from '../ops'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { BrowserApprovalDeps } from '../backend'

const clickSpec = BROWSER_OPS.find((op) => op.name === 'click')!
const OPTS = { toolCallId: 'tc1', abortError: 'TOOL_ABORTED' }

function deps(autoApprove: boolean, response?: InputResponse): BrowserApprovalDeps {
  return {
    isAutoApprove: () => autoApprove,
    requestUserInput: vi.fn(async () => response!)
  }
}

describe('gateBrowserOp', () => {
  it('autoApprove 开 → 直接放行，不弹审批', async () => {
    const d = deps(true)
    const result = await gateBrowserOp(clickSpec, { tabId: 't1', uid: 'e7' }, d, OPTS)
    expect(result).toBeNull()
    expect(d.requestUserInput).not.toHaveBeenCalled()
  })

  it('批准 → 放行', async () => {
    const d = deps(false, { kind: 'approval', approved: true })
    const result = await gateBrowserOp(clickSpec, { tabId: 't1', uid: 'e7' }, d, OPTS)
    expect(result).toBeNull()
    expect(d.requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'approval', toolName: 'browser' })
    )
  })

  it('拒绝 → 返回 denied 文案（不抛错）', async () => {
    const d = deps(false, { kind: 'approval', approved: false })
    const result = await gateBrowserOp(clickSpec, { tabId: 't1', uid: 'e7' }, d, OPTS)
    expect(result?.text).toContain('denied')
    expect(result?.details?.error).toBe('denied')
  })

  it('other → 返回用户反馈作为结果，不执行操作', async () => {
    const d = deps(false, { kind: 'other', text: '别点这个按钮' })
    const result = await gateBrowserOp(clickSpec, { tabId: 't1', uid: 'e7' }, d, OPTS)
    expect(result?.text).toContain('别点这个按钮')
  })

  it('cancel → 抛 abortError', async () => {
    const d = deps(false, { kind: 'cancel', reason: 'aborted' })
    await expect(gateBrowserOp(clickSpec, { tabId: 't1', uid: 'e7' }, d, OPTS)).rejects.toThrow(
      'TOOL_ABORTED'
    )
  })
})

describe('describeBrowserOp', () => {
  it('fill 文本截断 80 字符', () => {
    const long = 'x'.repeat(100)
    const desc = describeBrowserOp('fill', { tabId: 't1', uid: 'e7', text: long })
    expect(desc).toContain('x'.repeat(80) + '…')
    expect(desc).not.toContain('x'.repeat(81))
  })

  it('navigate goto 显示目标 URL；back 显示方向', () => {
    expect(describeBrowserOp('navigate', { tabId: 't1', url: 'https://a.com' })).toBe(
      'navigate(tab t1 → https://a.com)'
    )
    expect(describeBrowserOp('navigate', { tabId: 't1', nav: 'back' })).toBe(
      'navigate(tab t1, back)'
    )
  })
})
