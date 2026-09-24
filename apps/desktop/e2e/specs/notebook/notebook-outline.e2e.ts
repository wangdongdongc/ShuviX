/**
 * 笔记本右侧目录（app-shell NotebookMinimap + LivePreviewEditor 的宿主接线）—— 主窗口笔记本上的端到端形态。
 *
 * 契约：`<nav aria-label={notebook.outline}>` 贴在编辑区右缘，平时只是一列横线（一个标题一条，长短按相对级别，
 * 当前章节那条加深）；悬停横线列或键盘聚焦进来时换成目录卡片，点一项跳到那个标题。文档里至少两个标题才出现。
 * 当前章节 = 视口顶部稍往下那一行（探针）之前的最后一个标题；可滚动的文档滚到底时算读到了最后一个标题。
 * 指针点完一项，按钮交还焦点（只读预览不把焦点交还编辑器 —— 按钮留着焦点的话下一次按键会把卡片顶开）。
 * 横线列离右缘留几 px，不盖住编辑器 4px 宽的滚动条。
 *
 *   E2  打开时：目录项 = 各标题（围栏里的 `# not a heading` 不在）；横线数 = 项数，相对级别 0/1/2 逐级变短；
 *       nav 的名字是钉死语言下的 `notebook.outline`；在文首（探针落在开场白里）没有当前项、没有加深的横线
 *   E1  一个标题 → 没有目录；补一个 → 出现（两条横线）；不可滚动的短文档当前项是第 0 个（不是「滚到底」的
 *       最后一个 —— 钉住「真能滚」这个前提，也钉住挂载时就量了一次探针）；删掉 → 目录消失
 *   E3  探针语义：K 在 +10px → K；K 在 +120px（看得见但在探针之下）→ K−1；K 在 −300px 而 K+1 还在探针之下 → K
 *   E4  滚到底 → 最后一个标题（它的顶边远在探针之下）；往回滚 100px → 回到探针的判定
 *   E6  悬停：收起时卡片区不拦指针、横线列不盖滚动条；悬停横线列 → 卡片展开、横线列隐去，当前项唯一、
 *       与加深的横线一致、字重更重；同一点此时命中卡片里的按钮；移开 → 收起
 *   E7  可写笔记本里点一项：那个标题滚到顶部附近、成为当前项，光标在该行行首，焦点回到编辑器；移开 → 收起
 *   E7b 点紧挨着下一个标题的 `Adjacent A` → 当前项是它，不是紧随其后的 `Adjacent B`
 *   E5  文档变了而没有滚动：当前章节照样重算（见用例上的说明 —— 后半段才真正区分「探针重量过」与「沿用旧行号」）
 *   E8  刚打开、第一个标题就在第 1 行 → 当前是第 0 个（挂载时就量了探针）；标题多到横线列放不下：当前那条横线
 *       留在横线列可见范围内（横线列自己滚了）；滚到底 → 最后一条加深且可见；悬停 → 当前项在卡片可见范围内
 *   E9  键盘：编辑器里 Escape 再 Tab → 焦点进目录、卡片展开；Enter → 跳转、焦点回编辑器、卡片收起
 *   E10 只读笔记（内置知识库条目）：点一项 → 滚到那个标题，光标 / 编辑器焦点不变，被点的按钮没留着焦点；
 *       移开 → 收起；再按一个键 → 卡片仍收着
 *
 * 用例顺序有讲究：E2 先跑并记下「没加深」的横线底色，E1 只有两条横线、分不出多数，要拿它来认加深的那条；
 * E5 改 long.md 之后会把文档改回原样；E10 开的是内置知识库（本仓的真目录，只读、只看不写），放最后。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createProject } from '../../harness/seed'
import {
  knowledgePane,
  notebookOutlinePane,
  sidebarPane,
  type NotebookOutlinePane,
  type OutlineRect
} from '../../harness/pages'

// ─── 夹具 ───

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut ' +
  'labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco ' +
  'laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in ' +
  'voluptate velit esse cillum dolore eu fugiat nulla pariatur.'

/** 一段正文：n 个段落（每段折成几行），段与段之间空一行 */
const body = (tag: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${tag} paragraph ${i + 1}. ${LOREM}`).join('\n\n')

/** long.md 的标题（文档序）：源码行、目录里的文字、相对级别（从 H2 写起，H2 = 0） */
const LONG_HEADINGS = [
  { src: '## Alpha', text: 'Alpha', rel: 0 },
  { src: '### Alpha Detail', text: 'Alpha Detail', rel: 1 },
  { src: '#### Alpha Fine Print', text: 'Alpha Fine Print', rel: 2 },
  { src: '## Bravo', text: 'Bravo', rel: 0 },
  { src: '### Bravo Detail', text: 'Bravo Detail', rel: 1 },
  { src: '### Adjacent A', text: 'Adjacent A', rel: 1 },
  { src: '#### Adjacent B', text: 'Adjacent B', rel: 2 },
  { src: '## Charlie', text: 'Charlie', rel: 0 },
  { src: '### Charlie Detail', text: 'Charlie Detail', rel: 1 },
  { src: '## Delta', text: 'Delta', rel: 0 },
  { src: '#### Delta Fine Print', text: 'Delta Fine Print', rel: 2 },
  { src: '## Final', text: 'Final', rel: 0 }
] as const
const idx = (text: string): number => LONG_HEADINGS.findIndex((h) => h.text === text)
const srcOf = (text: string): string => LONG_HEADINGS[idx(text)].src

/**
 * 开场白（比探针深得多）→ 八个以 H2 为顶级的章节（带 H3 / H4），每节正文都有大半个视口高；中间一节带一段围栏
 * 代码（里面有一行 `# not a heading`）；正中间有一对**紧挨着**的小标题（Adjacent A 下一行就是 Adjacent B），
 * 其后一大段正文；最后一节只有标题和一行字。其余标题之间都空行。
 */
const LONG_MD = [
  body('Intro', 3),
  '',
  srcOf('Alpha'),
  '',
  body('Alpha', 5),
  '',
  srcOf('Alpha Detail'),
  '',
  body('Alpha detail', 5),
  '',
  srcOf('Alpha Fine Print'),
  '',
  body('Alpha fine print', 5),
  '',
  srcOf('Bravo'),
  '',
  body('Bravo', 3),
  '',
  '```js',
  '# not a heading',
  'const answer = 42',
  '```',
  '',
  body('Bravo tail', 2),
  '',
  srcOf('Bravo Detail'),
  '',
  body('Bravo detail', 5),
  '',
  srcOf('Adjacent A'),
  srcOf('Adjacent B'),
  '',
  body('Adjacent', 5),
  '',
  srcOf('Charlie'),
  '',
  body('Charlie', 5),
  '',
  srcOf('Charlie Detail'),
  '',
  body('Charlie detail', 5),
  '',
  srcOf('Delta'),
  '',
  body('Delta', 5),
  '',
  srcOf('Delta Fine Print'),
  '',
  body('Delta fine print', 5),
  '',
  srcOf('Final'),
  'One line.',
  ''
].join('\n')

/** 只有一个标题（第 1 行） */
const SHORT_MD = '# Only heading\n\nSome text under the only heading.\n'

/** 一百个标题，每个下面一两行字 */
const MANY_COUNT = 100
/** many.md 第 n 个标题的源码行（每三个里一个 H2，其余 H3） */
const manySrc = (n: number): string => `${n % 3 === 1 ? '##' : '###'} Topic ${n}`
const MANY_MD = Array.from({ length: MANY_COUNT }, (_, i) => {
  const n = i + 1
  const lines = n % 2 === 0 ? [`About topic ${n}.`, `More on topic ${n}.`] : [`About topic ${n}.`]
  return [manySrc(n), '', ...lines, ''].join('\n')
}).join('\n')

/** 内置知识库里拿来当只读样本的那一条（本仓 resources 下的真文件 —— 只读） */
const BUILTIN_BASE = 'builtin/shuvix'
const READONLY_SAMPLE = `${BUILTIN_BASE}/policy-md.md`

// ─── 实例 ───

let app: E2EApp
let outline: NotebookOutlinePane
/** 没加深的横线的计算底色（E2 在文首读到：那时没有当前章节，所有横线都是这个颜色） */
let normalDash: string | null = null

async function open(file: string, marker: string): Promise<void> {
  const sidebar = sidebarPane(app.main)
  await until(() => sidebar.openSession(file), `notebook "${file}" opened`)
  await until(async () => (await outline.docText()).includes(marker), `"${file}" loaded`)
}

/** 加深的横线 = 底色不是「没加深」那个颜色的横线（下标） */
async function emphasised(): Promise<number[]> {
  if (!normalDash) throw new Error('normal dash colour not learned yet (E2 runs first)')
  return (await outline.dashes())
    .map((d, i) => (d.background !== normalDash ? i : -1))
    .filter((i) => i >= 0)
}

/**
 * 等当前章节落到 i（-1 = 没有）：目录项的 aria-current 与加深的横线一致。
 *
 * 对上之后过几帧**再核一次**：探针按帧重量，改动刚落地的那一瞬读到的是它还没重量时的旧值 —— 旧值恰好等于
 * 期望时（E1：补上第二个标题的那一刻，旧探针行号下当前仍是第 0 个），只看第一次对上就会放过真正的回归。
 */
async function waitCurrent(i: number, what: string): Promise<void> {
  const want = i < 0 ? [] : [i]
  const read = async (): Promise<{ cur: number[]; dash: number[] }> => ({
    cur: await outline.currentEntries(),
    dash: await emphasised()
  })
  await until(async () => {
    const { cur, dash } = await read()
    return (
      JSON.stringify(cur) === JSON.stringify(want) && JSON.stringify(dash) === JSON.stringify(want)
    )
  }, `outline current = ${i} (${what})`)
  await sleep(300)
  expect(await read(), `outline current still ${i} after the probe settled (${what})`).toEqual({
    cur: want,
    dash: want
  })
}

/** 卡片展开 / 收起（计算 opacity；过渡 150ms，调用方靠 until 等） */
async function isOpen(): Promise<boolean> {
  const l = await outline.layout()
  return !!l && l.cardOpacity === 1 && l.railOpacity === 0
}
async function isClosed(): Promise<boolean> {
  const l = await outline.layout()
  return !!l && l.cardOpacity === 0 && l.railOpacity === 1
}

/** 悬停横线列并等卡片展开（刚启动的窗口第一次悬停可能要几百毫秒才生效） */
async function hoverOpen(): Promise<{ x: number; y: number }> {
  const p = await outline.hoverRail()
  await until(isOpen, 'outline card opened by hover')
  return p
}

/** 指针移开并等卡片收起 */
async function moveAwayClosed(): Promise<void> {
  await outline.moveAway()
  await until(isClosed, 'outline card closed after the pointer left')
}

const inside = (inner: OutlineRect, outer: OutlineRect): boolean =>
  inner.top >= outer.top - 0.5 &&
  inner.bottom <= outer.bottom + 0.5 &&
  inner.left >= outer.left - 0.5 &&
  inner.right <= outer.right + 0.5

beforeAll(async () => {
  app = await launchApp()
  outline = notebookOutlinePane(app.main)
  // 语言钉死在 en —— nav 的名字按它比（隔离实例本来跟系统语言走）
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)

  const projDir = join(app.home, 'proj-outline')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'long.md'), LONG_MD)
  writeFileSync(join(projDir, 'short.md'), SHORT_MD)
  writeFileSync(join(projDir, 'many.md'), MANY_MD)
  const project = await createProject(app.main, { name: 'OutlineProj', path: projDir })
  for (const file of ['long.md', 'short.md', 'many.md']) {
    await app.main.eval(
      `window.api.session.create(${JSON.stringify({ projectId: project.id, notebookPath: join(projDir, file) })})`
    )
  }
})

afterAll(async () => {
  await app?.stop()
})

describe('笔记本右侧目录', () => {
  it('E2 打开时：目录项 = 各标题（围栏里的不算）；横线按相对级别变短；名字是 notebook.outline；文首没有当前项', async () => {
    await open('long.md', 'Intro paragraph 1.')
    await until(() => outline.present(), 'outline nav on long.md')

    const entries = await outline.entries()
    expect(entries.map((e) => e.text)).toEqual(LONG_HEADINGS.map((h) => h.text))
    expect(entries.map((e) => e.text)).not.toContain('not a heading')

    const dashes = await outline.dashes()
    expect(dashes).toHaveLength(entries.length)
    const widthAt = (rel: number): number[] =>
      LONG_HEADINGS.map((h, i) => (h.rel === rel ? dashes[i].width : -1)).filter((w) => w >= 0)
    // 同级同长；0 > 1 > 2
    for (const rel of [0, 1, 2]) expect(new Set(widthAt(rel)).size, `rel ${rel}`).toBe(1)
    expect(widthAt(0)[0]).toBeGreaterThan(widthAt(1)[0])
    expect(widthAt(1)[0]).toBeGreaterThan(widthAt(2)[0])

    // 名字：钉死的 en 下的 notebook.outline（语言切换是异步落到渲染端的）
    expect(en.notebook.outline).toBeTruthy()
    await until(
      async () => (await outline.label()) === en.notebook.outline,
      'outline nav labelled in English'
    )

    // 文首：开场白比探针深得多，第一个标题远在视口下方
    expect((await outline.scroll()).top).toBe(0)
    const firstOffset = await outline.lineOffset(await outline.lineOf(srcOf('Alpha')))
    expect(firstOffset).toBeGreaterThan(150)
    expect(await outline.currentEntries()).toEqual([])
    const backgrounds = (await outline.dashes()).map((d) => d.background)
    expect(new Set(backgrounds).size).toBe(1)
    normalDash = backgrounds[0]
  })

  it('E1 一个标题 → 没有目录；补一个 → 出现，不可滚动时当前项是第 0 个；删掉 → 消失', async () => {
    await open('short.md', 'Some text under the only heading.')
    expect(await outline.present()).toBe(false)

    const doc = await outline.docText()
    const added = '\n## Second\n'
    await outline.replace(doc.length, doc.length, added)
    await until(() => outline.present(), 'outline appears with the second heading')
    expect((await outline.dashes()).length).toBe(2)
    expect((await outline.entries()).map((e) => e.text)).toEqual(['Only heading', 'Second'])

    // 不可滚动：「滚到底算读到最后」的规则不该在这里生效
    const s = await outline.scroll()
    expect(s.height).toBeLessThanOrEqual(s.client)
    await waitCurrent(0, 'short note, nothing to scroll')

    await outline.replace(doc.length, doc.length + added.length, '')
    await until(async () => (await outline.present()) === false, 'outline gone again')
    expect(await outline.docText()).toBe(doc)
  })

  it('E3 探针：K 在 +10px → K；K 在 +120px → K−1；K 在 −300px 且 K+1 仍在探针之下 → K', async () => {
    await open('long.md', 'Intro paragraph 1.')
    const K = idx('Charlie')
    const kLine = await outline.lineOf(srcOf('Charlie'))
    const nextLine = await outline.lineOf(srcOf('Charlie Detail'))

    await outline.placeLine(kLine, 10)
    await waitCurrent(K, 'K at +10px')

    await outline.placeLine(kLine, 120)
    expect(await outline.lineOffset(kLine)).toBeLessThan((await outline.scroll()).client)
    await waitCurrent(K - 1, 'K at +120px')

    await outline.placeLine(kLine, -300)
    expect(await outline.lineOffset(nextLine)).toBeGreaterThan(150)
    await waitCurrent(K, 'K at -300px, K+1 still below the probe')
  })

  it('E4 滚到底 → 最后一个标题；往回滚 100px → 回到探针的判定', async () => {
    await open('long.md', 'Intro paragraph 1.')
    const last = LONG_HEADINGS.length - 1
    const lastLine = await outline.lineOf(srcOf('Final'))

    await outline.scrollToBottom()
    // 前提：最后一节短到它的标题永远到不了探针处
    expect(await outline.lineOffset(lastLine)).toBeGreaterThan(200)
    await waitCurrent(last, 'scrolled to the bottom')

    const s = await outline.scroll()
    await outline.setScrollTop(s.top - 100)
    expect(await outline.lineOffset(lastLine)).toBeGreaterThan(300)
    // 探针的判定（不钉探针深度）：顶边已在视口之上的最后一个标题 ≤ 当前 ≤ 顶边在 +60px 以内的最后一个标题
    const offsets: number[] = []
    for (const h of LONG_HEADINGS)
      offsets.push(await outline.lineOffset(await outline.lineOf(h.src)))
    const lastAtOrAbove = (px: number): number =>
      offsets.map((o, i) => (o <= px ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
    const lo = lastAtOrAbove(0)
    const hi = lastAtOrAbove(60)
    expect(lo).toBeGreaterThanOrEqual(0)
    expect(hi).toBeLessThan(last)
    await until(async () => {
      const cur = await outline.currentEntries()
      const dash = await emphasised()
      return (
        cur.length === 1 &&
        cur[0] >= lo &&
        cur[0] <= hi &&
        JSON.stringify(dash) === JSON.stringify(cur)
      )
    }, `outline current back to the probe result (${lo}..${hi})`)
  })

  it('E6 悬停：收起时不拦指针、不盖滚动条；悬停 → 展开、当前项唯一且加粗；移开 → 收起', async () => {
    await open('long.md', 'Intro paragraph 1.')
    const K = idx('Bravo Detail')
    await outline.placeLine(await outline.lineOf(srcOf('Bravo Detail')), 10)
    await waitCurrent(K, 'Bravo Detail current before hovering')
    await outline.moveAway()
    await until(isClosed, 'outline closed before hovering')

    // 收起时：卡片区（横线列之外）不拦指针 —— 点下去的是编辑器
    const l = (await outline.layout())!
    const card = l.card!
    const rail = l.rail!
    const cx = card.left + 10
    expect(cx).toBeLessThan(rail.left)
    expect(await outline.hitAt(cx, card.top + card.height / 2)).toBe('editor')
    // 横线列离右缘留了空：滚动条那一窄条上不是目录
    const railCy = rail.top + rail.height / 2
    const edgeHit = await outline.hitAt(l.scroller.right - 2, railCy)
    expect(['rail', 'entry', 'card', 'nav']).not.toContain(edgeHit)

    const p = await hoverOpen()
    await until(async () => {
      const entries = await outline.entries()
      const cur = entries.map((e, i) => (e.current ? i : -1)).filter((i) => i >= 0)
      if (JSON.stringify(cur) !== JSON.stringify([K])) return false
      if (JSON.stringify(await emphasised()) !== JSON.stringify([K])) return false
      const others = entries.filter((_, i) => i !== K).map((e) => e.weight)
      return entries[K].weight > Math.max(...others)
    }, 'one current entry, matching the emphasised dash, heavier than the rest')
    // 同一点此时落在卡片里的按钮上
    expect(await outline.hitAt(p.x, p.y)).toBe('entry')

    await moveAwayClosed()
  })

  it('E7 可写笔记本里点一项 → 那个标题到顶部附近、成为当前项，光标在行首、焦点回编辑器；移开 → 收起', async () => {
    await open('long.md', 'Intro paragraph 1.')
    const target = idx('Charlie')
    const line = await outline.lineOf(srcOf('Charlie'))
    await outline.placeLine(await outline.lineOf(srcOf('Alpha Detail')), 10)
    await waitCurrent(idx('Alpha Detail'), 'start somewhere else')

    await hoverOpen()
    await outline.clickEntry(target)
    const { from } = await outline.lineRange(line)
    await until(async () => {
      const off = await outline.lineOffset(line)
      return off >= -2 && off <= 60
    }, 'Charlie scrolled near the top')
    await waitCurrent(target, 'Charlie current after the jump')
    await until(async () => (await outline.caret()).head === from, 'caret at the start of Charlie')
    await until(async () => (await outline.focus()).active === 'editor', 'focus back in the editor')

    await moveAwayClosed()
  })

  it('E7b 点紧挨着下一个标题的 Adjacent A → 当前项是它，不是 Adjacent B', async () => {
    await open('long.md', 'Intro paragraph 1.')
    const a = idx('Adjacent A')
    const aLine = await outline.lineOf(srcOf('Adjacent A'))
    // 前提：两个标题真的紧挨着
    expect(await outline.lineOf(srcOf('Adjacent B'))).toBe(aLine + 1)
    await outline.placeLine(await outline.lineOf(srcOf('Alpha')), 10)
    await waitCurrent(idx('Alpha'), 'start somewhere else')

    await hoverOpen()
    await outline.clickEntry(a)
    await until(async () => {
      const off = await outline.lineOffset(aLine)
      return off >= -2 && off <= 60
    }, 'Adjacent A scrolled near the top')
    await waitCurrent(a, 'Adjacent A current, not Adjacent B')

    await moveAwayClosed()
  })

  /**
   * 文档变了、视口没滚：当前章节照样重算。
   *
   * 前半段是用例清单原样：K 在 +10px（K 是当前），在 K 那一行行首插一整行很长的字（折成很多行）+ 换行 →
   * K 被推到下面，当前变成 K−1。但它**分不出**「探针重量过」与「沿用旧行号」：旧探针行号 = K 原来的行号，
   * 而 K 此刻在下一行，`activeHeadingIndex` 照样得 K−1。真正能分出来的是后半段 —— 行数不变、高度变了：
   * 把那一长行摆到横跨视口顶边（K 在探针之下，当前 K−1），再把它改短（不动换行）→ K 升到探针之上，当前应是 K；
   * 若探针没有重量，旧行号（那一长行）仍在 K 之前，会停在 K−1。
   *
   * 先让编辑器失焦：编辑器握着焦点、光标停在视口上方时，插入这么长的一行会让 CM6 重估视口外的行高、
   * 并按滚动锚点改 scrollTop（那就成了「滚动了」，走的是滚动那条路，本用例就不成立了）—— 这一点在改动前的
   * 构建上一模一样，不是目录的行为；见文件末尾的 todo。
   */
  it('E5 文档变了而没有滚动：当前章节随之重算', async () => {
    await open('long.md', 'Intro paragraph 1.')
    await outline.blurEditor()
    const K = idx('Charlie')
    const original = await outline.docText()
    const kLine = await outline.lineOf(srcOf('Charlie'))

    await outline.placeLine(kLine, 10)
    await waitCurrent(K, 'K at +10px')
    const before = (await outline.scroll()).top

    // 前半段：K 行首插一整行长字（没有内部换行）
    const longText = 'wrapping words '.repeat(100).trim()
    const { from } = await outline.lineRange(kLine)
    await outline.replace(from, from, `${longText}\n`)
    await until(
      async () => (await outline.lineOf(srcOf('Charlie'))) === kLine + 1,
      'long line inserted above K'
    )
    await sleep(200)
    expect((await outline.scroll()).top).toBe(before)
    await waitCurrent(K - 1, 'K pushed below the probe by a long line')

    // 后半段：长行横跨视口顶边，K 远在探针之下
    await outline.placeLine(kLine, -100)
    expect(await outline.lineOffset(kLine + 1)).toBeGreaterThan(100)
    await waitCurrent(K - 1, 'long line under the probe')
    const top2 = (await outline.scroll()).top

    // 改短（不动换行）：行号一个没变，K 却升到了探针之上
    const long = await outline.lineRange(kLine)
    await outline.replace(long.from, long.to, 'Short now.')
    await until(
      async () => (await outline.lineOffset(kLine + 1)) < 0,
      'K rose above the probe after the line shrank'
    )
    expect((await outline.scroll()).top).toBe(top2)
    expect(await outline.lineOf(srcOf('Charlie'))).toBe(kLine + 1)
    await waitCurrent(K, 'K current again although no line number moved')

    // 复原文档（后面的用例还用它）
    const short = await outline.lineRange(kLine)
    await outline.replace(short.from, short.to + 1, '')
    await until(async () => (await outline.docText()) === original, 'long.md restored')
  })

  it('E8 标题很多：当前那条横线留在横线列可见范围内；滚到底 → 最后一条加深且可见；悬停 → 当前项在卡片可见范围内', async () => {
    await open('many.md', 'About topic 1.')
    await until(
      async () => (await outline.entries()).length === MANY_COUNT,
      'outline lists all headings of many.md'
    )
    // 刚打开、一下没滚：第一个标题就在第 1 行，探针挂载时量过一次就该认出它
    expect((await outline.scroll()).top).toBe(0)
    await waitCurrent(0, 'probe measured at mount: Topic 1 is on line 1')
    const l0 = (await outline.layout())!
    expect(l0.railScroll!.height).toBeGreaterThan(l0.railScroll!.client)

    const k = 69 // Topic 70
    await outline.placeLine(await outline.lineOf(manySrc(70)), 10)
    await waitCurrent(k, 'Topic 70 current')
    await until(async () => {
      const l = await outline.layout()
      const dash = await outline.dashRect(k)
      return !!l?.rail && !!dash && inside(dash, l.rail) && l.railScroll!.top > 0
    }, 'current dash inside the rail, rail scrolled')

    await outline.scrollToBottom()
    await waitCurrent(MANY_COUNT - 1, 'last heading current at the bottom')
    await until(async () => {
      const l = await outline.layout()
      const dash = await outline.dashRect(MANY_COUNT - 1)
      return !!l?.rail && !!dash && inside(dash, l.rail)
    }, 'last dash inside the rail')

    await hoverOpen()
    await until(async () => {
      const l = await outline.layout()
      const entry = await outline.entryRect(MANY_COUNT - 1)
      return !!l?.card && !!entry && inside(entry, l.card)
    }, 'current entry inside the card')
    await moveAwayClosed()
  })

  it('E9 键盘：Escape 再 Tab → 焦点进目录、卡片展开；Enter → 跳转、焦点回编辑器、卡片收起', async () => {
    await open('many.md', 'About topic 1.')
    await outline.moveAway()
    await outline.placeLine(await outline.lineOf(manySrc(50)), 10)
    await waitCurrent(49, 'Topic 50 current')
    await until(isClosed, 'outline closed')

    await outline.focusEditor()
    await until(async () => (await outline.focus()).active === 'editor', 'editor focused')
    await outline.pressKey('Escape')
    await outline.pressKey('Tab')
    await until(
      async () => (await outline.focus()).active === 'entry',
      'focus moved into the outline'
    )
    await until(isOpen, 'outline card opened by keyboard focus')
    const focused = (await outline.focus()).entryText
    expect(focused).toBe('Topic 1')

    await outline.pressKey('Enter')
    await waitCurrent(0, 'jumped to Topic 1')
    await until(async () => (await outline.focus()).active === 'editor', 'focus back in the editor')
    await until(isClosed, 'outline card closed after the jump')
  })

  it('E10 只读笔记：点一项 → 滚到那个标题，光标与编辑器焦点不变，按钮不留焦点；移开 → 收起；再按键 → 仍收着', async () => {
    const kb = knowledgePane(app.main)
    await kb.expand()
    await kb.setDirOpen(BUILTIN_BASE, true)
    await kb.openRow(READONLY_SAMPLE)
    await until(
      async () => (await outline.docText()).includes('## Builtin policies'),
      'read-only note loaded'
    )
    expect(await kb.editorEditable()).toBe(false)
    await until(() => outline.present(), 'outline on the read-only note')

    const entries = await outline.entries()
    const target = entries.findIndex((e) => e.text === 'Builtin policies')
    expect(target).toBeGreaterThan(0)
    const line = await outline.lineOf('## Builtin policies')
    expect(await outline.lineOffset(line)).toBeGreaterThan(200)

    await outline.moveAway()
    await until(isClosed, 'outline closed')
    const caretBefore = await outline.caret()
    const focusBefore = await outline.focus()

    await hoverOpen()
    await outline.clickEntry(target)
    await until(async () => {
      const off = await outline.lineOffset(line)
      return off >= -2 && off <= 60
    }, 'read-only note scrolled to the heading')
    await waitCurrent(target, 'clicked heading current')
    expect(await outline.caret()).toEqual(caretBefore)
    const focusAfter = await outline.focus()
    expect(focusAfter.editorHasFocus).toBe(focusBefore.editorHasFocus)
    expect(focusAfter.active).not.toBe('entry')

    await moveAwayClosed()
    await outline.pressKey('ArrowDown')
    // 断的是「没发生」：给过渡（150ms）与一帧留足时间，再连读几次
    for (let i = 0; i < 4; i++) {
      await sleep(150)
      expect(await isClosed()).toBe(true)
    }
    expect((await outline.focus()).active).not.toBe('entry')
  })

  /**
   * 待产品裁决（不是目录自己的逻辑，但目录会把它显示出来）：E5 若**不先失焦** —— 编辑器握着焦点、光标停在
   * 视口上方（E7 / E7b 点目录跳转后正是这个状态），按 E2 → E7 → E7b → E5 的顺序跑，三次都复现：插入那一长行后
   * CM6 打出 `Measure loop restarted more than 5 times`，它的高度表从此与 DOM 对不上（contentHeight ≈ 11174 而
   * scrollHeight = 7161，`view.viewport` 停在 Bravo 一节，屏幕上探针处却是那一长行），`lineBlockAtHeight` 于是
   * 指错地方，目录把 Bravo 标成当前章节；再滚 1px 也不恢复。用相近的序列（同样的跳转、同样的插入）在改动前后
   * 两个构建上对照，读数完全相同（都是重估视口外行高 +≈3150px、按锚点把 scrollTop 从 4090 挪到 5738.5，没有
   * 测量循环告警）—— 那一种坏状态只在上面这个顺序里出现，而这个顺序要点新目录，改动前的构建跑不了，所以既没能
   * 归到这次改动上，也没能排除它。
   */
  it.todo('E5-focused 编辑器握着焦点、光标在视口上方时插入长行：CM6 测量循环放弃后目录指错章节')
})
