/**
 * CdpController 的快照差异按「看的人」（viewer）分基线。
 *
 * 差异的前提是「上一份快照还在**这个模型**的上下文里」。同一个 tab 被两个 agent 交替快照时，
 * 一份共用的基线会让 A 拿到相对于 B 那份的差异 —— 一份它从没见过的快照，比多花几千 token
 * 糟得多。所以这里的每条用例都拿「单个看的人、干净的 before → after」那份差异做参照：
 * 夹进另一个看的人之后，A 拿到的必须**逐字**还是它。
 *
 * 素材同 snapshotDiff.test.ts：small-change 这一对真实的「动作前后」AX 树。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CdpController, type AXNode } from '../controller'

const PAIR = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'pairs', 'small-change.json'), 'utf8')
) as { before: AXNode[]; after: AXNode[] }

/** 可切换树的 transport —— 模拟「同一个 tab 上前后几次快照」 */
function page(initial: AXNode[]): { ctl: CdpController; set: (nodes: AXNode[]) => void } {
  let nodes = initial
  const ctl = new CdpController({
    sendCommand: async <T = unknown>(method: string): Promise<T> =>
      (method === 'Accessibility.getFullAXTree' ? { nodes } : {}) as T
  })
  return {
    ctl,
    set: (next) => {
      nodes = next
    }
  }
}

/** 参照：只有一个看的人时 before → after 的那份差异 */
async function referenceDiff(): Promise<string> {
  const { ctl, set } = page(PAIR.before)
  await ctl.buildSnapshot('URL')
  set(PAIR.after)
  const d = await ctl.buildSnapshot('URL')
  expect(d.diffed).toBe(true)
  return d.text
}

/** 全量快照的表头 */
const FULL_HEADER = /^\[snapshot\] Page: URL — \d+ elements\n/

describe('CdpController：差异基线按看的人分开', () => {
  it('C1/C2 A 拍 before、B 拍 after（B 第一次 → 全量）、A 再拍 after → A 拿到的仍是 before→after 那份差异', async () => {
    const ref = await referenceDiff()
    const { ctl, set } = page(PAIR.before)
    const a1 = await ctl.buildSnapshot('URL', { viewer: 'A' })
    expect(a1.diffed).toBeUndefined()

    set(PAIR.after)
    const b1 = await ctl.buildSnapshot('URL', { viewer: 'B' })
    expect(b1.diffed).toBeUndefined()
    expect(b1.text).toMatch(FULL_HEADER)

    const a2 = await ctl.buildSnapshot('URL', { viewer: 'A' })
    expect(a2.diffed).toBe(true)
    expect(a2.text).toBe(ref)
  })

  it('C3 A 的快照不挪 B 的基线：B 下一次仍相对于它自己那份 before', async () => {
    const ref = await referenceDiff()
    const { ctl, set } = page(PAIR.before)
    await ctl.buildSnapshot('URL', { viewer: 'B' })
    await ctl.buildSnapshot('URL', { viewer: 'A' })
    set(PAIR.after)
    const a2 = await ctl.buildSnapshot('URL', { viewer: 'A' })
    expect(a2.text).toBe(ref)
    // 若基线是共用的，A 刚把它挪到了 after，B 这里会是一份「0 changed」的全折叠
    const b2 = await ctl.buildSnapshot('URL', { viewer: 'B' })
    expect(b2.diffed).toBe(true)
    expect(b2.text).toBe(ref)
  })

  it('C4 reset()（导航等）→ 所有看的人都回到全量', async () => {
    const { ctl } = page(PAIR.before)
    await ctl.buildSnapshot('URL', { viewer: 'A' })
    await ctl.buildSnapshot('URL', { viewer: 'B' })
    ctl.reset()
    expect((await ctl.buildSnapshot('URL', { viewer: 'A' })).diffed).toBeUndefined()
    expect((await ctl.buildSnapshot('URL', { viewer: 'B' })).diffed).toBeUndefined()
  })

  it('C5 空页面只清拍它的那个人的基线', async () => {
    const { ctl, set } = page(PAIR.before)
    await ctl.buildSnapshot('URL', { viewer: 'A' })
    await ctl.buildSnapshot('URL', { viewer: 'B' })

    set([])
    expect(await ctl.buildSnapshot('URL', { viewer: 'A' })).toEqual({
      text: '(empty page)',
      elementCount: 0
    })

    set(PAIR.before)
    const a = await ctl.buildSnapshot('URL', { viewer: 'A' })
    expect(a.diffed).toBeUndefined()
    expect(a.text).toMatch(FULL_HEADER)
    // B 没见过那张空页，它的基线还是 before：原树再拍一次是零变化的差异
    const b = await ctl.buildSnapshot('URL', { viewer: 'B' })
    expect(b.diffed).toBe(true)
    expect(b.text).toContain('0 changed')
  })

  it('C6 full:true 的快照照样记下基线（模型确实收到了那份全量）', async () => {
    const ref = await referenceDiff()
    const { ctl, set } = page(PAIR.before)
    expect((await ctl.buildSnapshot('URL', { viewer: 'A', full: true })).diffed).toBeUndefined()
    set(PAIR.after)
    const a = await ctl.buildSnapshot('URL', { viewer: 'A' })
    expect(a.diffed).toBe(true)
    expect(a.text).toBe(ref)
  })

  it('C7 不给 opts / 不给 viewer / viewer 为空串是同一个人；"A" 是另一个人', async () => {
    const ref = await referenceDiff()
    const { ctl, set } = page(PAIR.before)
    await ctl.buildSnapshot('URL')
    set(PAIR.after)
    const same = await ctl.buildSnapshot('URL', { viewer: '' })
    expect(same.diffed).toBe(true)
    expect(same.text).toBe(ref)
    expect((await ctl.buildSnapshot('URL', { full: false })).diffed).toBe(true)
    expect((await ctl.buildSnapshot('URL', { viewer: undefined })).diffed).toBe(true)
    expect((await ctl.buildSnapshot('URL', { viewer: 'A' })).diffed).toBeUndefined()
  })

  it('C8 全量快照与看的人无关：A 与 B 的第一次逐字相同', async () => {
    const { ctl } = page(PAIR.before)
    const a = await ctl.buildSnapshot('URL', { viewer: 'A' })
    const b = await ctl.buildSnapshot('URL', { viewer: 'B' })
    expect(a.diffed).toBeUndefined()
    expect(b.diffed).toBeUndefined()
    expect(b.text).toBe(a.text)
    expect(b.elementCount).toBe(a.elementCount)
    expect(a.text).toMatch(FULL_HEADER)
  })

  it('C9 A 的 full:true 不碰 B 的基线', async () => {
    const ref = await referenceDiff()
    const { ctl, set } = page(PAIR.before)
    await ctl.buildSnapshot('URL', { viewer: 'B' })
    set(PAIR.after)
    expect((await ctl.buildSnapshot('URL', { viewer: 'A', full: true })).diffed).toBeUndefined()
    const b = await ctl.buildSnapshot('URL', { viewer: 'B' })
    expect(b.diffed).toBe(true)
    expect(b.text).toBe(ref)
  })
})
