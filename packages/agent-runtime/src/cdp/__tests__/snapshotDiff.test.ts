/**
 * 快照差异回传单测。
 *
 * 两层：`diffSnapshotBody` 的纯函数行为（合成小输入，钉判定与格式），以及跑通
 * `CdpController` 的端到端（真实的「动作前后」AX 树对，钉收益与退回全量的开关）。
 *
 * 这个模块的风险不在「省得够不够多」，而在**误导**：一份看起来合理、实则对不上模型
 * 手里那份快照的差异，比多花几千 token 糟得多。所以 P0 的用例都在「什么时候不该回
 * 差异」和「输出能不能自证」上。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { diffSnapshotBody, diffHeader } from '../snapshotDiff'
import { CdpController } from '../controller'
import type { AXNode } from '../controller'

const PAIRS = join(__dirname, 'fixtures', 'pairs')
const loadPair = (name: string): { before: AXNode[]; after: AXNode[] } =>
  JSON.parse(readFileSync(join(PAIRS, `${name}.json`), 'utf8'))

/** 可切换树的 transport —— 模拟「同一个 tab 上前后两次快照」 */
function switchable(initial: AXNode[]): { transport: never; set: (n: AXNode[]) => void } {
  let nodes = initial
  return {
    transport: {
      sendCommand: async (m: string) =>
        m === 'Accessibility.getFullAXTree' ? { nodes } : ({} as never)
    } as never,
    set: (n: AXNode[]) => {
      nodes = n
    }
  }
}

/** 造一份「快照正文」：每行 `- uid=eN role "name"` */
const L = (uid: string, rest: string, indent = 0): string =>
  `${' '.repeat(indent)}- uid=${uid} ${rest}`

describe('diffSnapshotBody — 什么时候不该回差异', () => {
  it('没有上一份（任一侧为空）→ null，调用方回全量', () => {
    expect(diffSnapshotBody([], [L('e0', 'link "a"')])).toBeNull()
    expect(diffSnapshotBody([L('e0', 'link "a"')], [])).toBeNull()
  })

  it('变化占比过高 → null —— 省不了多少，还让模型多做一次拼接', () => {
    const prev = Array.from({ length: 10 }, (_, i) => L(`e${i}`, `link "旧${i}"`))
    // 10 行里换掉 6 行 > 50%
    const next = prev.map((l, i) => (i < 6 ? L(`n${i}`, `link "新${i}"`) : l))
    expect(diffSnapshotBody(prev, next)).toBeNull()
  })

  it('幸存 uid 的相对顺序变了 → null —— 顺序变说明结构真的动了', () => {
    // 按 uid 配对是 O(n) 的代价：单纯换位置在文本上看不出来，只能靠顺序检查兜住
    const prev = [L('e0', 'link "a"'), L('e1', 'link "b"'), L('e2', 'link "c"')]
    const next = [L('e2', 'link "c"'), L('e1', 'link "b"'), L('e0', 'link "a"')]
    expect(diffSnapshotBody(prev, next)).toBeNull()
  })

  it('顺序保持时正常出差异（与上一条对照）', () => {
    const prev = [L('e0', 'link "a"'), L('e1', 'link "b"')]
    const next = [L('e0', 'link "a"'), L('e1', 'link "B"')]
    expect(diffSnapshotBody(prev, next)).not.toBeNull()
  })
})

describe('diffSnapshotBody — 分类与格式', () => {
  const prev = [
    L('e0', 'RootWebArea "页"'),
    L('e1', 'link "一"', 1),
    L('e2', 'link "二"', 1),
    L('e3', 'link "三"', 1)
  ]

  it('零变化 → 全部折叠成一行，计数为 0 changed', () => {
    // 收益最大的一档：实测 hn 滚动一下，688 行 AX 树零变化
    const d = diffSnapshotBody(prev, prev)!
    expect(d.changed).toBe(0)
    expect(d.unchanged).toBe(4)
    expect(d.removed).toBe(0)
    expect(d.body).toBe('  … 4 lines unchanged')
  })

  it('新增行标 + 且带一行上下文（让模型知道挂在哪儿）', () => {
    const next = [...prev, L('e4', 'link "四"', 1)]
    const d = diffSnapshotBody(prev, next)!
    expect(d.changed).toBe(1)
    expect(d.body).toContain('+' + L('e4', 'link "四"', 1))
    // 上下文：新增行前一行原样带出（前缀是空格，不是 +/~）
    expect(d.body).toContain(' ' + L('e3', 'link "三"', 1))
  })

  it('uid 还在但内容变了 → 标 ~', () => {
    const next = prev.map((l, i) => (i === 2 ? L('e2', 'link "贰"', 1) : l))
    const d = diffSnapshotBody(prev, next)!
    expect(d.changed).toBe(1)
    expect(d.body).toContain('~' + L('e2', 'link "贰"', 1))
  })

  it('消失的行单独列出，不占正文位置', () => {
    const next = prev.filter((l) => !l.includes('uid=e2'))
    const d = diffSnapshotBody(prev, next)!
    expect(d.removed).toBe(1)
    expect(d.body).toContain('- uid=e2 (gone)')
  })

  it('未变的连续段折叠成「… N lines unchanged」', () => {
    const long = Array.from({ length: 20 }, (_, i) => L(`e${i}`, `link "${i}"`))
    const next = [...long, L('x', 'link "新"')]
    const d = diffSnapshotBody(long, next)!
    expect(d.body).toContain('… 19 lines unchanged')
    // 折叠后的正文必须显著短于全量
    expect(d.body.length).toBeLessThan(next.join('\n').length / 2)
  })
})

describe('diffHeader — 自证（这是丢了上一份时的唯一防线）', () => {
  const d = { body: '', changed: 2, unchanged: 30, removed: 1 }

  it('说清相对于谁、多少没变、丢了怎么补', () => {
    const h = diffHeader('https://x/', 32, d)
    expect(h).toContain('previous snapshot of this tab') // 相对于谁
    expect(h).toContain('30 unchanged') // 多少没变
    expect(h).toContain('full:true') // 丢了怎么补
    expect(h).toContain('2 changed')
    expect(h).toContain('1 gone')
  })

  it('没有删除时不提 gone —— 表头本身在小页面上就是主要成本', () => {
    expect(diffHeader('u', 3, { body: '', changed: 1, unchanged: 2, removed: 0 })).not.toContain(
      'gone'
    )
  })
})

describe('端到端：CdpController 上的差异回传', () => {
  it('同一 tab 的第二次快照默认回差异，full:true 强制全量', async () => {
    const { transport, set } = switchable(loadPair('small-change').before)
    const ctl = new CdpController(transport)
    const first = await ctl.buildSnapshot('URL')
    expect(first.diffed).toBeUndefined() // 头一次没有可比对象

    set(loadPair('small-change').after)
    const diffed = await ctl.buildSnapshot('URL')
    expect(diffed.diffed).toBe(true)

    set(loadPair('small-change').after)
    const full = await ctl.buildSnapshot('URL', { full: true })
    expect(full.diffed).toBeUndefined()
    expect(full.text.split('\n').length).toBeGreaterThan(diffed.text.split('\n').length)
  })

  it('reset() 之后作废上一份，回到全量', async () => {
    const { transport } = switchable(loadPair('form-fill').before)
    const ctl = new CdpController(transport)
    await ctl.buildSnapshot('URL')
    ctl.reset()
    expect((await ctl.buildSnapshot('URL')).diffed).toBeUndefined()
  })

  it.each([
    ['hn-noop', 0.1], // AX 树零变化 —— 收益上限
    ['small-change', 0.6],
    ['rerender', 0.6],
    ['form-fill', 0.6]
  ])('%s：差异不超过全量的 %s', async (name, ratio) => {
    const pair = loadPair(name)
    const { transport, set } = switchable(pair.before)
    const ctl = new CdpController(transport)
    await ctl.buildSnapshot('URL')
    set(pair.after)
    const d = await ctl.buildSnapshot('URL')

    const { transport: t2 } = switchable(pair.after)
    const full = await new CdpController(t2).buildSnapshot('URL')

    expect(d.diffed).toBe(true)
    expect(d.text.length).toBeLessThan(full.text.length * ratio)
    // 元素数必须仍然是完整页面的，不能因为回差异就少报
    expect(d.elementCount).toBe(full.elementCount)
  })

  it('整树重渲染：内容几乎没变时差异也应该很小（uid 稳定性的回归钉）', async () => {
    // 改造前这里是 26 行里 24 行变化（92% 是 uid 漂移噪声）。uid 改成按内容键
    // 跨快照沿用之后应当只剩真实变化，这条红了说明身份稳定性退化了。
    const pair = loadPair('rerender')
    const { transport, set } = switchable(pair.before)
    const ctl = new CdpController(transport)
    await ctl.buildSnapshot('URL')
    set(pair.after)
    const d = await ctl.buildSnapshot('URL')
    const marked = d.text.split('\n').filter((l) => /^[+~]/.test(l)).length
    expect(marked).toBeLessThanOrEqual(2)
  })
})
