/**
 * 说明气泡的摆放算术 —— `hintPosition` 那五条分支（白盒）。
 *
 * 这个函数被单独拎出来，正是因为它的分支在真实设置页里**基本走不到**：那儿的问号清一色贴着
 * 卡片左上角，气泡永远放得下、永远不用翻转、永远不贴边。翻转、夹边、钉上边距、锚点出视口这
 * 四条只有把窗口缩到极限或把说明写到半屏高才碰得到，e2e 再多也覆盖不了 —— 于是它们只能钉在
 * 这里。坏掉的样子分别是：气泡压住它要解释的开关、靠窗底那几行的说明掉到屏幕外、贴边的问号
 * 把气泡推出视口、一段无主的说明飘在不相干的行上面。
 *
 * 两个常量不从实现里导出（它们是私有的），所以断言写的是**字面量** 6 / 8：这里钉的就是
 * 「离锚点 6px、离视口边 8px」这两个数本身，改了实现里的常量就该来改这份断言。
 *
 * 纯算术、无副作用：读 rect 与写 style 留在组件的 `place()` 里，那部分由 e2e 的 IH-E-* 覆盖。
 */
import { describe, expect, it } from 'vitest'
import { hintPosition, type HintBox } from './SettingsPrimitives'

/** 一块够大的视口，四条边都离得远 —— 除非用例自己把锚点或气泡摆到边上 */
const VIEWPORT = { width: 1000, height: 800 }
/** 典型气泡：`max-w-[280px]`，两三行高 */
const TIP = { width: 280, height: 60 }

/** 视口正中偏上的一个问号（12px 见方，和 `CircleHelp size={12}` 一样大） */
const anchor = (top: number, left = 500): HintBox => ({
  top,
  bottom: top + 12,
  left,
  width: 12
})

describe('hintPosition', () => {
  it('IH-U-1 下方放得下就贴在锚点下方，留 6px 空隙', () => {
    const a = anchor(100)
    const at = hintPosition(a, TIP, VIEWPORT)

    // 失败 = 气泡压住了它要解释的那个控件（或与它脱开一段莫名其妙的距离）
    expect(at).not.toBeNull()
    expect(at!.top).toBe(a.bottom + 6)
    // 顺带钉住「这一支不该翻转」：气泡整个在锚点下方
    expect(at!.top).toBeGreaterThan(a.bottom)
  })

  it('IH-U-2 下方放不下就翻到上方，同样留 6px 空隙', () => {
    // 下方只剩 800 - 752 = 48px，装不下 60px 高的气泡（还要留 8px 边距）
    const a = anchor(740)
    const at = hintPosition(a, TIP, VIEWPORT)

    // 失败 = 靠窗口底部那几行的说明掉到屏幕外，谁也读不到
    expect(at).not.toBeNull()
    expect(at!.top).toBe(a.top - 6 - TIP.height)
    // 翻上去之后整个在锚点上方，且没有越过上边距
    expect(at!.top + TIP.height).toBe(a.top - 6)
    expect(at!.top).toBeGreaterThanOrEqual(8)
  })

  it('IH-U-3 上下都放不下就钉在上边距 —— 盖住锚点是刻意的取舍', () => {
    // 比视口还高的说明：下方放不下，翻上去也放不下（400 - 6 - 760 = -366）
    const tall = { width: 280, height: 760 }
    const a = anchor(400)
    const at = hintPosition(a, tall, VIEWPORT)

    // 失败 = 气泡掉到视口下沿之外。它是 pointer-events-none 的 fixed 层，既不在滚动容器里
    // 也没有 max-height，掉出去就彻底够不着 —— 宁可盖住锚点，也要整段留在屏幕上
    expect(at).not.toBeNull()
    expect(at!.top).toBe(8)
    // 这一支**确实**会盖住锚点；写出来是为了让「哪天不想盖了」必须先改掉这条断言
    expect(at!.top + tall.height).toBeGreaterThan(a.top)
  })

  it('IH-U-4 水平以锚点居中，两侧各夹到 8px 边距', () => {
    // ① 空间够：气泡中线与锚点中线重合
    const mid = hintPosition(anchor(100, 500), TIP, VIEWPORT)!
    expect(mid.left + TIP.width / 2).toBe(500 + 12 / 2)

    // ② 贴着左边的问号：居中会算出负数，夹到左边距
    const left = hintPosition(anchor(100, 4), TIP, VIEWPORT)!
    // 失败 = 贴边的问号把气泡推出视口左侧
    expect(left.left).toBe(8)

    // ③ 贴着右边的问号：夹到右边距，右缘正好离视口 8px
    const right = hintPosition(anchor(100, 990), TIP, VIEWPORT)!
    // 失败 = 贴边的问号把气泡推出视口右侧
    expect(right.left).toBe(VIEWPORT.width - TIP.width - 8)
    expect(right.left + TIP.width).toBe(VIEWPORT.width - 8)
  })

  it('IH-U-5 锚点整个滚出视野就回 null（只露一点点的还照常摆）', () => {
    // 整个在视口上方（滚动容器把它卷到窗口顶边以上，rect 是负的）
    expect(hintPosition({ top: -40, bottom: -20, left: 500, width: 12 }, TIP, VIEWPORT)).toBeNull()
    // 整个在视口下方
    expect(hintPosition(anchor(900), TIP, VIEWPORT)).toBeNull()

    // 失败 = 一段无主的说明飘在不相干的行上面（或反过来：还露着半个的问号，说明却先没了）。
    // 判据是「整个出去」而不是「有一点被裁」—— 只露下半截的锚点仍该有气泡
    expect(hintPosition({ top: -6, bottom: 6, left: 500, width: 12 }, TIP, VIEWPORT)).not.toBeNull()
    expect(hintPosition(anchor(795), TIP, VIEWPORT)).not.toBeNull()
  })
})
