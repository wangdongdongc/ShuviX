/**
 * browser snapshot 编码器（`CdpController.buildSnapshot`）—— 渲染契约、四条压缩规则、体量基线。
 *
 * 输入是 13 份**真实页面的原始 AX 树**（`Accessibility.getFullAXTree` 的 nodes 数组），
 * 打桩 transport 直接回放，所以喂给 `buildSnapshot` 的就是它的真实输入。规则依据、
 * 被否方案、已复现缺陷及其修复状态见同目录的 `SNAPSHOT-ENCODING.md`。
 *
 * 三条断言接缝：
 *   S1 渲染文本 —— `buildSnapshot('URL').text`，统一用固定短 URL 并把表头行剔出统计
 *      （表头里的 URL 长度会污染体量数字）
 *   S2 uid 契约面 —— 公开面优先（`getNode` / `resolveUidMacros` / `focusElement` 发出的
 *      `DOM.focus.backendNodeId`）；只有容量/泄漏断言才伸手进私有映射，集中在 `internals()`
 *   S3 基线 —— checked-in 的 `fixtures/_baseline.json`（优化前编码器的记录，A5/A6/A7/C 的分母）
 *      与 `fixtures/_digest.json`（真实站点的结构摘要，G2）
 *
 * 刻意不做：
 *   - token 数断言（tokenizer 版本会漂，一律用字符数/行数代替）
 *   - 7 个属性各自的渲染映射（A7 已整体兜住）、表头文案措辞（但 elementCount 的数值要测）
 *   - 「每条规则至少贡献 N% 体量」这类分摊断言 —— R1 几乎被 R4 完全吸收
 *     （`StaticText "X"` 本身就满足 R4），R1 在体量上零信号，只能靠 B1/B2 的结构断言钉
 *   - `resolveCoordinates` 的 CDP 往返细节（已由 `browser/__tests__/cdpOps.test.ts` 覆盖）
 *
 * B13 曾经红过：R4 原本用单个空格拼接子孙文字，而 Chromium 对行内元素算 accessible
 * name 时不插空格，`link "图标带子元素的链接"` > [`"图标"`, `"带子元素的链接"`] 拼出来是
 * 「图标 带子元素的链接」，比不上 name。AX 树里没有 display 信息，拼接策略无论选空格
 * 还是不选都会错一半 —— 已改为**忽略全部空白**比较。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpController, type AXNode } from '../controller'
import type { CdpTransport } from '../transport'
import { resolveUidMacros } from '../../browser/cdpPolicy'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** 受控夹具：每份只钉一两条规则，小到可以整段人眼审（G1 的 golden 就是它们） */
const CONTROLLED = [
  'empty',
  'example',
  'text-nesting',
  'deep-nesting',
  'form-states',
  'aria-widgets',
  'table'
] as const
/** 真实站点：补规模与脏乱，只做结构摘要不做全文 golden（G2） */
const REAL = ['app-ui', 'bing', 'github', 'hn', 'mdn', 'wikipedia'] as const
const ALL = [...CONTROLLED, ...REAL]

/** 与 controller.ts 的 INTERACTIVE_ROLES 同源；这里独立抄一份，实现改窄了要能被 A5 照出来 */
const INTERACTIVE_ROLES = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'slider',
  'spinbutton',
  'textarea'
])

// ====== 夹具与基线 ======

interface BaselineEntry {
  /** 优化前编码器的 body 行数 */
  lines: number
  /** 优化前编码器的 body 字符数 */
  chars: number
  /** `role name` 多重集（name 已空白归一），已排序 */
  interactive: string[]
  /** 所有非空 name（空白归一）去重排序 */
  names: string[]
  /** 属性 token 出现次数 */
  attrs: Record<string, number>
}

const BASELINE: Record<string, BaselineEntry> = JSON.parse(
  readFileSync(join(FIXTURE_DIR, '_baseline.json'), 'utf8')
).fixtures

interface DigestEntry {
  elementCount: number
  lines: number
  chars: number
  interactive: number
  roles: Record<string, number>
}

const DIGEST: Record<string, DigestEntry> = JSON.parse(
  readFileSync(join(FIXTURE_DIR, '_digest.json'), 'utf8')
)

const nodesCache = new Map<string, AXNode[]>()
/** 夹具只读不改，13 份合计 1.7 MB —— 解析一次全文件共用 */
function loadNodes(name: string): AXNode[] {
  let cached = nodesCache.get(name)
  if (!cached) {
    cached = JSON.parse(readFileSync(join(FIXTURE_DIR, name + '.json'), 'utf8')).nodes as AXNode[]
    nodesCache.set(name, cached)
  }
  return cached
}

// ====== 打桩 transport ======

interface SentCommand {
  method: string
  params?: Record<string, unknown>
}

/** `Accessibility.getFullAXTree` 回放夹具，其余命令回空对象；可选地录制命令序列 */
function fakeTransport(nodes: AXNode[], sent?: SentCommand[]): CdpTransport {
  return {
    sendCommand: async <T = unknown>(
      method: string,
      params?: Record<string, unknown>
    ): Promise<T> => {
      sent?.push({ method, params })
      return (method === 'Accessibility.getFullAXTree' ? { nodes } : {}) as T
    }
  }
}

/**
 * 私有映射的唯一入口 —— `uidMap`/`nodeMap` 没有公开读法，而 A3 要钉的正是它们与打印行对得上；
 * `nodeMap` 的容量则是缺陷 #4（内存泄漏）的回归钉。除此之外一律走公开面。
 */
function internals(ctl: CdpController): {
  uidMap: Map<string, number>
  nodeMap: Map<string, AXNode>
} {
  return ctl as unknown as {
    uidMap: Map<string, number>
    nodeMap: Map<string, AXNode>
  }
}

// ====== 输出行解析 ======

/** 行 = `<缩进>- uid=<uid> [role] ["name"] [属性…]` */
interface Row {
  indent: number
  uid: string
  /** role 被 R3/IGNORED_ROLES 抑制时为空串 */
  role: string
  /** 无 name 时为 null（区别于 name 为空串——那种节点根本不打引号） */
  name: string | null
  /** 行尾属性标注原文 */
  attrs: string
}

function parseRow(line: string): Row {
  const m = /^( *)- uid=(\S+)(?: (.*))?$/.exec(line)
  if (!m) throw new Error('无法解析的行: ' + JSON.stringify(line))
  let rest = m[3] ?? ''
  let role = ''
  // role 是纯字母数字标识符；`"name"` / `[attr]` / `level=` / `value=` 都不会误吃
  const roleMatch = /^([A-Za-z][A-Za-z0-9]*)(?= |$)/.exec(rest)
  if (roleMatch) {
    role = roleMatch[1]
    rest = rest.slice(roleMatch[0].length).replace(/^ /, '')
  }
  let name: string | null = null
  if (rest.startsWith('"')) {
    // name 里可以有引号（wikipedia 的 "ability to access"）—— 收尾引号是「后面接行尾
    // 或空格+属性起始」的那一个
    let end = -1
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] !== '"') continue
      const after = rest.slice(i + 1)
      if (after === '' || /^ (?:\[|level=|value=)/.test(after)) {
        end = i
        break
      }
    }
    if (end === -1) throw new Error('name 引号未闭合: ' + JSON.stringify(line))
    name = rest.slice(1, end)
    rest = rest.slice(end + 1).replace(/^ /, '')
  }
  return { indent: m[1].length, uid: m[2], role, name, attrs: rest }
}

const ATTR_TOKEN_RE =
  /\[focused\]|\[checked=[^\]]*\]|\[expanded\]|\[collapsed\]|\[disabled\]|\[required\]|level=\d+|value="/g

/** 属性 token 按**种类**计数（`[checked=true]`/`[checked=mixed]` 归一为 `[checked=]`） */
function countAttrTokens(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of text.matchAll(ATTR_TOKEN_RE)) {
    const kind = m[0].startsWith('[checked=')
      ? '[checked=]'
      : m[0].startsWith('level=')
        ? 'level='
        : m[0].startsWith('value="')
          ? 'value='
          : m[0]
    out[kind] = (out[kind] || 0) + 1
  }
  return out
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// ====== 快照 ======

interface Snap {
  ctl: CdpController
  text: string
  elementCount: number
  /** 剔掉表头后的正文行 */
  body: string[]
  rows: Row[]
  chars: number
}

async function shoot(
  nodes: AXNode[],
  ctl = new CdpController(fakeTransport(nodes))
): Promise<Snap> {
  const { text, elementCount } = await ctl.buildSnapshot('URL')
  const body = text.split('\n').slice(1)
  return { ctl, text, elementCount, body, rows: body.map(parseRow), chars: body.join('\n').length }
}

const snapCache = new Map<string, Snap>()
/** 同一夹具的快照全文件复用（buildSnapshot 无副作用于 nodes，controller 各自独立） */
async function snap(name: string): Promise<Snap> {
  let cached = snapCache.get(name)
  if (!cached) {
    cached = await shoot(loadNodes(name))
    snapCache.set(name, cached)
  }
  return cached
}

// ====== 合成微树（只用于真实夹具覆盖不到的孤例：B9 / B13 / D1 / D4 / D5） ======

function ax(
  nodeId: string,
  role: string,
  name?: string,
  childIds?: string[],
  properties?: AXNode['properties']
): AXNode {
  return {
    nodeId,
    backendDOMNodeId: Number(nodeId),
    role: { type: 'role', value: role },
    ...(name === undefined ? {} : { name: { type: 'computed', value: name } }),
    ...(childIds ? { childIds } : {}),
    ...(properties ? { properties } : {})
  }
}

// ════════════════════════════════════════════════════════════════════════════
// A 组 · 渲染契约不变量
// ════════════════════════════════════════════════════════════════════════════

describe('A 渲染契约不变量（13 份真实 AX 树）', () => {
  it.each(ALL)('A1 %s：每行都以 `- uid=` 开头，RootWebArea 也不例外', async (fx) => {
    const { ctl, body, rows } = await snap(fx)
    expect(body.length).toBeGreaterThan(0)
    expect(body.filter((l) => !/^ *- uid=\S+( |$)/.test(l))).toEqual([])
    // 根节点保留 uid 是明确决定：被否的 R2（只给可交互元素编号）会让 `{"$uid"}` 宏失效。
    // 从 uid 反查节点角色，不看行里印没印 role 名 —— 那是 R3 的事（B5 负责）
    expect(ctl.getNode(rows[0].uid)?.role?.value).toBe('RootWebArea')
  })

  it.each(ALL)('A2 %s：表头的 elementCount === 实际正文行数', async (fx) => {
    const { elementCount, body, text } = await snap(fx)
    expect(elementCount).toBe(body.length)
    // 缺陷 #1 的回归钉：name 含换行会把一个节点渲成多行，让表头数字说谎
    expect(text.split('\n')[0]).toBe(`[snapshot] Page: URL — ${elementCount} elements`)
  })

  it.each(ALL)('A3 %s：uid 不重复，三张映射与打印出的行一一对上', async (fx) => {
    const { ctl, rows, elementCount } = await snap(fx)
    const { uidMap, nodeMap } = internals(ctl)

    const uids = rows.map((r) => r.uid)
    expect(new Set(uids).size).toBe(uids.length)
    expect(nodeMap.size).toBe(elementCount)

    // uid 现在由**内容键**决定（跨快照沿用），uidMap 是「当下的句柄」每快照重建。
    // 所以这里断言的是：打印出的每个 uid 都能 getNode；有 backendDOMNodeId 的节点
    // 其 uid 必在 uidMap 里且指向同一个 id；没有的不该混进去。
    const backendIds: number[] = []
    for (const row of rows) {
      const node = ctl.getNode(row.uid)
      expect(node, `getNode('${row.uid}') 应有节点`).toBeDefined()
      const backendId = node!.backendDOMNodeId
      if (backendId == null) {
        expect(uidMap.has(row.uid)).toBe(false)
        continue
      }
      expect(uidMap.get(row.uid)).toBe(backendId)
      backendIds.push(backendId)
    }
    // uid → backendDOMNodeId 是单射：同一个 DOM 节点不会分到两个 uid
    expect(new Set(backendIds).size).toBe(backendIds.length)
  })

  it.each(ALL)('A4 %s：零 InlineTextBox / 零 LineBreak 行，t 前缀 uid 占比 ≤ 0.06', async (fx) => {
    const { ctl, rows } = await snap(fx)
    // 从 uid 反查节点角色，不看行里印出来的 role 名 —— 把 InlineTextBox 并回 IGNORED_ROLES
    // 的话，它的 role 名同样不打印，只看文本就抓不到（实测过，只有 wikipedia 会被占比那半边照出来）
    const layoutOnly = rows.filter((r) => {
      const role = ctl.getNode(r.uid)?.role?.value
      return role === 'InlineTextBox' || role === 'LineBreak'
    })
    expect(layoutOnly.map((r) => r.uid)).toEqual([])
    // 缺陷 #2 的上限：t 前缀是「打印了却解析不了」的 uid，压不到 0（wikipedia 实测 4.1%）
    const transient = rows.filter((r) => r.uid.startsWith('t')).length
    expect(transient / rows.length).toBeLessThanOrEqual(0.06)
  })

  it.each(ALL)('A5 %s：可交互元素零丢失 —— (role, name) 多重集 === 基线', async (fx) => {
    const { rows } = await snap(fx)
    const actual = rows
      .filter((r) => INTERACTIVE_ROLES.has(r.role))
      .map((r) => `${r.role} ${normalizeWhitespace(r.name ?? '')}`)
      .sort()
    expect(actual).toEqual(BASELINE[fx].interactive)
  })

  it.each(ALL)('A6 %s：可见文本零丢失 —— 基线每个非空 name 仍是输出的子串', async (fx) => {
    const { body } = await snap(fx)
    const text = body.join('\n')
    expect(BASELINE[fx].names.filter((n) => !text.includes(n))).toEqual([])
  })

  it.each(ALL)('A7 %s：属性零丢失 —— 各属性 token 次数 ≥ 基线', async (fx) => {
    const { rows } = await snap(fx)
    const actual = countAttrTokens(rows.map((r) => r.attrs).join(' '))
    for (const [token, count] of Object.entries(BASELINE[fx].attrs)) {
      expect(actual[token] ?? 0, `${fx} 的 ${token}`).toBeGreaterThanOrEqual(count)
    }
  })

  it.each(ALL)('A8 %s：缩进 = 深度 × 1 空格', async (fx) => {
    const { rows } = await snap(fx)
    expect(rows[0].indent).toBe(0)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].indent - rows[i - 1].indent, `第 ${i + 1} 行缩进跳变`).toBeLessThanOrEqual(1)
    }
    const widths = new Set(rows.map((r) => r.indent))
    const maxIndent = Math.max(...widths)
    // 含奇数缩进 ⇒ 一层 1 空格（R5 被改回 2 空格的话，宽度集合会全是偶数）
    if (maxIndent >= 1) expect([...widths].some((w) => w % 2 === 1)).toBe(true)
  })

  it.each(ALL)('A9 %s：幂等 —— 同一棵树连拍两次逐字节相同', async (fx) => {
    // 缺陷 #3 的回归钉，也是 diff 的硬前置：无 backendId 的节点若取全局递增计数器，
    // 页面零变化也会有 33%~44% 的行 uid 漂掉。
    // 第二次要显式要全量 —— 默认会回差异（那正是这条不变量成立之后才敢做的事）。
    const nodes = loadNodes(fx)
    const ctl = new CdpController(fakeTransport(nodes))
    const first = await ctl.buildSnapshot('URL')
    const second = await ctl.buildSnapshot('URL', { full: true })
    expect(second.text).toBe(first.text)
    expect(second.elementCount).toBe(first.elementCount)
  })

  it.each(ALL)('A9b %s：同一棵树的第二次快照，差异为零变化', async (fx) => {
    // A9 的强化版：不只是「渲染出来一样」，而是 diff 也认得出「什么都没变」。
    // 这两条是不同的东西 —— 前者钉渲染确定性，后者钉 uid 身份跨快照真的对得上。
    const ctl = new CdpController(fakeTransport(loadNodes(fx)))
    await ctl.buildSnapshot('URL')
    const second = await ctl.buildSnapshot('URL')
    if (second.diffed !== true) {
      // 单行页面（empty）变化占比算不出有意义的结果，允许退回全量
      expect(second.elementCount).toBeLessThanOrEqual(1)
      return
    }
    expect(second.text).toContain('0 changed')
    expect(second.text).not.toMatch(/^[+~]/m)
  })

  it('A10 wikipedia：连拍 10 次后 nodeMap 不超过 elementCount（无泄漏）', async () => {
    // 缺陷 #4 的回归钉：旧实现的清理循环只遍历 uidMap，无 backendId 的 uid 永不回收，
    // wikipedia 实测每拍 +2499
    const ctl = new CdpController(fakeTransport(loadNodes('wikipedia')))
    let elementCount = 0
    for (let i = 0; i < 10; i++) elementCount = (await ctl.buildSnapshot('URL')).elementCount
    expect(internals(ctl).nodeMap.size).toBeLessThanOrEqual(elementCount)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// B 组 · 逐规则行为与安全边界
// ════════════════════════════════════════════════════════════════════════════

describe('B1–B3 R1：与父同名且 role 被抑制的行不打印', () => {
  it('B1 text-nesting：link "立即登录" 只占 1 行，其下无同名行', async () => {
    const { rows } = await snap('text-nesting')
    const hits = rows.filter((r) => r.name === '立即登录')
    expect(hits).toHaveLength(1)
    expect(hits[0].role).toBe('link')
  })

  it('B2 form-states：同名但**带 role** 的相邻行不许删 —— label 文本行与 textbox 行都在', async () => {
    // 最易写错的一条：R1 写成「跟上一行同名就删」，输入框会整个消失
    const { rows } = await snap('form-states')
    const account = rows.filter((r) => r.name === '账号')
    expect(account.map((r) => r.role).sort()).toEqual(['', 'textbox'])
    const password = rows.filter((r) => r.name === '密码')
    expect(password.map((r) => r.role).sort()).toEqual(['', 'textbox'])
  })

  it('B3 table：R1 只吃相邻重复 —— 三处 cell "200000" 全保留', async () => {
    const { rows } = await snap('table')
    expect(rows.filter((r) => r.role === 'cell' && r.name === '200000')).toHaveLength(3)
  })
})

describe('B4–B5 R3：StaticText 的 role 名不打印，其余 role 名照打', () => {
  it.each(ALL)('B4 %s：无 `StaticText` role 名，但文字仍在', async (fx) => {
    const { body } = await snap(fx)
    expect(body.filter((l) => /- uid=\S+ StaticText(\s|$)/.test(l))).toEqual([])
    // 光靠「没有 StaticText」还不够 —— 连文字一起丢也满足它。夹具里每个 StaticText 的
    // 文字都得在输出里找得到（被 R4 吞掉的那些，文字已并入父行的 name）
    const text = body.join('\n')
    const staticTexts = new Set(
      loadNodes(fx)
        .filter((n) => n.role?.value === 'StaticText')
        .map((n) => normalizeWhitespace(n.name?.value ?? ''))
        .filter(Boolean)
    )
    expect([...staticTexts].filter((t) => !text.includes(t))).toEqual([])
  })

  it('B5 role 抑制没写宽 —— heading/tablist/listbox/option/tab/ListMarker/image 的 role 名仍打印', async () => {
    const { rows } = await snap('aria-widgets')
    const roles = new Set(rows.map((r) => r.role))
    for (const role of ['heading', 'tablist', 'listbox', 'option', 'tab', 'ListMarker', 'image']) {
      expect(roles.has(role), `aria-widgets 应保留 role ${role}`).toBe(true)
    }
    // paragraph 不在 aria-widgets 里，去 example 取
    expect((await snap('example')).rows.some((r) => r.role === 'paragraph')).toBe(true)
  })
})

describe('B6–B13 R4：子孙文字 == 自身 name 且子孙无可交互/无属性 → 吞掉子树', () => {
  /** 该行是否吞掉了子树：下一行的缩进不比它深 */
  function isLeafLine(rows: Row[], i: number): boolean {
    const next = rows[i + 1]
    return !next || next.indent <= rows[i].indent
  }
  function findRow(rows: Row[], role: string, name: string): number {
    const i = rows.findIndex((r) => r.role === role && r.name === name)
    expect(i, `找不到 ${role} "${name}"`).toBeGreaterThanOrEqual(0)
    return i
  }

  it('B6 基本盘：link / button（含无名 image 子）/ 深埋 button / cell 各压成 1 行', async () => {
    const tn = await snap('text-nesting')
    expect(isLeafLine(tn.rows, findRow(tn.rows, 'link', '立即登录'))).toBe(true)
    // button "简体中文" 的子里还有两个无名 image —— 无名不进拼接，不该挡住 R4
    expect(isLeafLine(tn.rows, findRow(tn.rows, 'button', '简体中文'))).toBe(true)

    const dn = await snap('deep-nesting')
    expect(isLeafLine(dn.rows, findRow(dn.rows, 'button', '埋很深的按钮'))).toBe(true)

    const ex = await snap('example')
    expect(isLeafLine(ex.rows, findRow(ex.rows, 'link', 'Learn more'))).toBe(true)

    const tb = await snap('table')
    const cells = tb.rows.map((r, i) => [r, i] as const).filter(([r]) => r.role === 'cell')
    expect(cells).toHaveLength(9)
    for (const [row, i] of cells) expect(isLeafLine(tb.rows, i), `cell "${row.name}"`).toBe(true)
  })

  it.each(['text-nesting', 'table'])(
    'B7 %s：R4 吞得动 —— 没有哪一行的下一行是与它同名的纯文本行',
    async (fx) => {
      const { rows } = await snap(fx)
      const offenders = rows.filter((r, i) => {
        const next = rows[i + 1]
        return (
          !!r.name && !!next && next.indent > r.indent && next.role === '' && next.name === r.name
        )
      })
      expect(offenders.map((r) => `${r.role} "${r.name}"`)).toEqual([])
    }
  )

  it('B7 R4 的去重前置（回归钉）：拼接前必须先折叠相邻重复', async () => {
    // ⚠️ 实测：把 aggregate 里两处 `parts[parts.length-1] !== …` 守卫全删掉，13 份真实夹具
    // 的输出**逐字节不变** —— LAYOUT_ONLY_ROLES 拆出去之后，InlineTextBox 那层压根不进
    // 拼接，去重原本要修的重复源没了。所以这条只能靠合成微树钉，真实夹具在这里零信号。
    // 两棵树分别压住两处守卫：兄弟同名（cname 那处）、子树文字与子节点名重复（ctext 那处）。
    const siblings = await shoot([
      ax('1', 'link', 'X', ['2', '3']),
      ax('2', 'StaticText', 'X'),
      ax('3', 'StaticText', 'X')
    ])
    expect(siblings.body).toEqual(['- uid=e0 link "X"'])

    const nested = await shoot([
      ax('1', 'link', 'X', ['2']),
      ax('2', 'generic', 'X', ['3']),
      ax('3', 'StaticText', 'X')
    ])
    expect(nested.body).toEqual(['- uid=e0 link "X"'])
  })

  it('B8 安全边界① 子孙含可交互元素 → 不吞（mdn heading > link、hn cell > link "login"）', async () => {
    const mdn = await snap('mdn')
    const h = findRow(mdn.rows, 'heading', "Beginner's tutorials")
    expect(mdn.rows[h + 1]).toMatchObject({
      indent: mdn.rows[h].indent + 1,
      role: 'link',
      name: "Beginner's tutorials"
    })

    const hn = await snap('hn')
    const cell = findRow(hn.rows, 'LayoutTableCell', 'login')
    expect(hn.rows[cell + 1]).toMatchObject({
      indent: hn.rows[cell].indent + 1,
      role: 'link',
      name: 'login'
    })
  })

  it('B9 安全边界② 子孙带属性 → 不吞（bing link > heading level=1）', async () => {
    const { rows } = await snap('bing')
    const link = findRow(rows, 'link', 'Back to Bing search')
    expect(rows[link + 1]).toMatchObject({
      indent: rows[link].indent + 1,
      role: 'heading',
      name: 'Back to Bing search'
    })
    expect(rows[link + 1].attrs).toContain('level=1')
  })

  it('B9 安全边界② 合成微树：同名子孙只因带属性就不能吞', async () => {
    // 真实夹具只触发 1 次，光靠 bing 太脆；这里把「带属性」与「可交互」拆开单测
    const withAttr = await shoot([
      ax('1', 'LabelText', '记住我', ['2']),
      ax('2', 'StaticText', '记住我', undefined, [
        { name: 'focused', value: { type: 'boolean', value: true } }
      ])
    ])
    expect(withAttr.body).toEqual(['- uid=e0 LabelText "记住我"', ' - uid=e1 "记住我" [focused]'])

    // 同一棵树去掉属性 → 立刻被吞（证明拦住它的确实是属性，不是别的）
    const withoutAttr = await shoot([
      ax('1', 'LabelText', '记住我', ['2']),
      ax('2', 'StaticText', '记住我')
    ])
    expect(withoutAttr.body).toEqual(['- uid=e0 LabelText "记住我"'])

    // 清单给的那棵：checkbox 既可交互又带属性，两条边界同时生效
    const labelled = await shoot([
      ax('1', 'LabelText', '记住我', ['2', '3']),
      ax('2', 'checkbox', '', undefined, [
        { name: 'checked', value: { type: 'tristate', value: 'true' } }
      ]),
      ax('3', 'StaticText', '记住我')
    ])
    expect(labelled.body).toEqual([
      '- uid=e0 LabelText "记住我"',
      ' - uid=e1 checkbox [checked=true]',
      ' - uid=e2 "记住我"'
    ])
  })

  it('B10 安全边界③ 子孙文字 ≠ name → 不吞：textbox "账号" 下的 "alice" 必须还在', async () => {
    // "alice" 是输入框**当前值**的唯一出处（该 textbox 没有 value 属性），吞了等于读不到表单内容
    const { rows } = await snap('form-states')
    const box = findRow(rows, 'textbox', '账号')
    expect(rows[box + 1]).toMatchObject({ indent: rows[box].indent + 1, role: '', name: 'alice' })
  })

  it('B11 父节点无 name → 不吞（"子孙文字非空" 不是可吞条件）', async () => {
    for (const fx of ['example', 'text-nesting']) {
      const { rows } = await snap(fx)
      const i = rows.findIndex((r) => r.role === 'paragraph' && r.name === null)
      expect(i, `${fx} 应有无名 paragraph`).toBeGreaterThanOrEqual(0)
      expect(rows[i + 1].indent).toBe(rows[i].indent + 1)
      expect(rows[i + 1].name).toBeTruthy()
    }
  })

  it('B12 吞子树但父行自身属性保留', async () => {
    // guard 若写成「父或子有属性就不吞」，白白少压一半
    const fs = await snap('form-states')
    const submit = findRow(fs.rows, 'button', '提交')
    expect(fs.rows[submit].attrs).toBe('[disabled]')
    expect(isLeafLine(fs.rows, submit)).toBe(true)

    const aw = await snap('aria-widgets')
    const panel = findRow(aw.rows, 'button', '折叠面板')
    expect(aw.rows[panel].attrs).toBe('[collapsed]')
    expect(isLeafLine(aw.rows, panel)).toBe(true)

    const h1 = findRow(aw.rows, 'heading', '标题一')
    expect(aw.rows[h1].attrs).toBe('level=1')
    expect(isLeafLine(aw.rows, h1)).toBe(true)
  })

  it('B13 拼接语义（合成微树）：多个文本子拼起来等于 name 也要吞，含空白归一', async () => {
    const plain = await shoot([
      ax('1', 'link', 'Hello world', ['2', '3']),
      ax('2', 'StaticText', 'Hello'),
      ax('3', 'StaticText', 'world')
    ])
    expect(plain.body).toEqual(['- uid=e0 link "Hello world"'])

    // name 与子孙文字两侧的多余空白都要先归一再比
    const messy = await shoot([
      ax('1', 'link', 'Hello   world', ['2', '3']),
      ax('2', 'StaticText', ' Hello '),
      ax('3', 'StaticText', 'world\n')
    ])
    expect(messy.body).toEqual(['- uid=e0 link "Hello world"'])
  })

  it('B13 拼接语义（真实夹具）：link "图标带子元素的链接" 压成 1 行', async () => {
    // 曾经红过：实现用单个空格拼接子孙文字（"图标 带子元素的链接"），而 Chromium 对
    // 行内元素算 accessible name 时不插空格（"图标带子元素的链接"），两者比不上。
    // AX 树里没有 display 信息，拼接策略无论选空格还是不选都会错一半 —— 所以 R4 的
    // 比较改成**忽略全部空白**。这不丢信息：父行印的 name 才是权威渲染。
    const { rows } = await snap('text-nesting')
    const i = rows.findIndex((r) => r.role === 'link' && r.name === '图标带子元素的链接')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(rows[i + 1]?.indent ?? 0).toBeLessThanOrEqual(rows[i].indent)
  })
})

describe('B14–B15 R5：缩进 1 空格/层', () => {
  it.each(['table', 'aria-widgets'])('B14 %s：depth=3 的行恰好 3 个前导空格', async (fx) => {
    const { body, rows } = await snap(fx)
    const deep = rows.map((r, i) => [r, i] as const).filter(([r]) => r.indent === 3)
    expect(deep.length).toBeGreaterThan(0)
    for (const [, i] of deep) expect(body[i].startsWith('   - uid=')).toBe(true)
    // 2 空格缩进下 depth=3 会是 6 个空格，这里必须没有
    for (const [, i] of deep) expect(body[i].startsWith('      -')).toBe(false)
  })

  it('B15 deep-nesting：10 层全 ignored 的 div 链不产生缩进，输出恰好 4 行', async () => {
    const { body, rows } = await snap('deep-nesting')
    expect(body).toHaveLength(4)
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 2, 1])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// C 组 · 体量基线
// ════════════════════════════════════════════════════════════════════════════

/**
 * 新/旧 body 字符数的上限（实测比值 + 一点余量）。只写上限不写下限 —— 压得更狠应常绿。
 * 改这张表必须是显式提交。别指望体量断言当主力，B7 那种结构断言才是钉子。
 */
const CHAR_RATIO_LIMIT: Record<string, number> = {
  empty: 1.0, // 无可压缩物，恒等
  table: 0.42,
  'app-ui': 0.42,
  github: 0.42,
  hn: 0.45,
  wikipedia: 0.46,
  'text-nesting': 0.48,
  mdn: 0.5,
  'aria-widgets': 0.53,
  bing: 0.54,
  example: 0.55,
  'deep-nesting': 0.58,
  'form-states': 0.67
}

describe('C 体量基线（相对优化前编码器）', () => {
  it.each(ALL)('C1 %s：body 字符数不超过基线 × 上限，行数不多于基线', async (fx) => {
    const { chars, body } = await snap(fx)
    const base = BASELINE[fx]
    expect(chars / base.chars).toBeLessThanOrEqual(CHAR_RATIO_LIMIT[fx])
    expect(body.length).toBeLessThanOrEqual(base.lines)
  })

  it('C2 六份真实站点合计 ≤ 基线 × 0.45', async () => {
    let newChars = 0
    let baseChars = 0
    for (const fx of REAL) {
      newChars += (await snap(fx)).chars
      baseChars += BASELINE[fx].chars
    }
    expect(newChars / baseChars).toBeLessThanOrEqual(0.45)
  })

  it('C3 wikipedia（7259 节点）单次 buildSnapshot < 200ms', async () => {
    // 当前实测 19ms；这条只抓数量级崩塌（比如 R4 的聚合退回逐节点重走子孙的 O(n²)）
    const nodes = loadNodes('wikipedia')
    const ctl = new CdpController(fakeTransport(nodes))
    await ctl.buildSnapshot('URL') // 预热，把 JSON 解析与 JIT 排除在计时外
    const started = performance.now()
    await ctl.buildSnapshot('URL')
    expect(performance.now() - started).toBeLessThan(200)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// D 组 · 退化输入
// ════════════════════════════════════════════════════════════════════════════

describe('D 退化输入', () => {
  it('D1 nodes 为空 → `(empty page)`，且该分支**不带表头**', async () => {
    // SNAPSHOT-ENCODING.md 的缺陷 #6：与正常返回的结构不一致，尚未决定是否补表头。
    // 这里显式钉住现状，改动它会立刻红。
    const ctl = new CdpController(fakeTransport([]))
    expect(await ctl.buildSnapshot('URL')).toEqual({ text: '(empty page)', elementCount: 0 })
  })

  it('D2 empty 夹具：恰好 1 行，体量与基线相等（无可压缩物）', async () => {
    const { body, chars, elementCount } = await snap('empty')
    expect(elementCount).toBe(1)
    expect(body).toEqual(['- uid=e0 RootWebArea "Empty"'])
    expect(chars).toBe(BASELINE.empty.chars)
    expect(body.length).toBe(BASELINE.empty.lines)
  })

  it('D3 纯装饰元素：有 alt 的 image 单独成行，两处 ListMarker 保留', async () => {
    const { rows } = await snap('aria-widgets')
    expect(rows.filter((r) => r.role === 'image' && r.name === '有替换文字')).toHaveLength(1)
    // 原始 name 是 "• "，行里是空白归一后的 "•"
    expect(rows.filter((r) => r.role === 'ListMarker' && r.name === '•')).toHaveLength(2)
  })

  it('D4 name 含换行 / 含双引号 / 超长，一个节点仍只占一行', async () => {
    const newline = await shoot([ax('1', 'button', 'a\nb\nc')])
    expect(newline.body).toEqual(['- uid=e0 button "a b c"'])
    expect(newline.elementCount).toBe(1)

    // 引号不转义是现状（渲染给 LLM 读，不是给解析器读）
    const quoted = await shoot([ax('1', 'button', 'say "hi" now')])
    expect(quoted.body).toEqual(['- uid=e0 button "say "hi" now"'])

    const long = await shoot([ax('1', 'button', 'x'.repeat(10000))])
    expect(long.body).toHaveLength(1)
    expect(long.elementCount).toBe(1)
    expect(long.body[0]).toHaveLength('- uid=e0 button ""'.length + 10000)

    // 真实夹具里 github 有 170 个纯空白 name 的 StaticText —— A2 已在 13 份上整体兜住
    const gh = await snap('github')
    expect(gh.elementCount).toBe(gh.body.length)
  })

  it('D5 childIds 指向不存在的节点 → 静默跳过', async () => {
    const { body } = await shoot([
      ax('1', 'RootWebArea', 'R', ['2', 'NOPE']),
      ax('2', 'button', 'ok')
    ])
    expect(body).toEqual(['- uid=e0 RootWebArea "R"', ' - uid=e1 button "ok"'])
  })

  it('D5 环形 childIds 属契约外 —— CDP 的 AX 树保证无环，实现不设 visited 集', async () => {
    // 显式声明而不是「修一下」：加 visited 集要在 aggregate + format 两处各付一次开销，
    // 而这个输入在真实 CDP 下不可能出现。这里钉住现状（栈溢出而非静默死循环）。
    const ctl = new CdpController(fakeTransport([ax('1', 'RootWebArea', 'R', ['1'])]))
    await expect(ctl.buildSnapshot('URL')).rejects.toThrow(RangeError)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// E 组 · uid 契约面联动
// ════════════════════════════════════════════════════════════════════════════

describe('E uid 契约面联动', () => {
  it.each(['text-nesting', 'example', 'table', 'form-states', 'aria-widgets'])(
    'E1 %s：输出里每个 e 前缀 uid 都能被 `{"$uid"}` 宏解析',
    async (fx) => {
      const { ctl, rows } = await snap(fx)
      const uids = rows.map((r) => r.uid).filter((u) => u.startsWith('e'))
      expect(uids.length).toBeGreaterThan(0)
      for (const uid of uids) {
        const resolved = await resolveUidMacros({ backendNodeId: { $uid: uid } }, ctl)
        expect(resolved, `uid ${uid}`).toEqual({
          backendNodeId: ctl.getNode(uid)!.backendDOMNodeId
        })
      }
    }
  )

  it('E2 form-states：textbox 行的 uid 交给 focusElement，发出的 backendNodeId 是该节点真实 id', async () => {
    const sent: SentCommand[] = []
    const ctl = new CdpController(fakeTransport(loadNodes('form-states'), sent))
    const { rows } = await shoot(loadNodes('form-states'), ctl)
    const box = rows.find((r) => r.role === 'textbox' && r.name === '账号')!
    // 夹具里 textbox "账号" 的 nodeId / backendDOMNodeId 都是 93
    expect(ctl.getNode(box.uid)?.backendDOMNodeId).toBe(93)

    sent.length = 0
    await ctl.focusElement(box.uid)
    expect(sent).toEqual([{ method: 'DOM.focus', params: { backendNodeId: 93 } }])
  })

  it('E3 被 R4 吞掉的子节点不进 uid 体系（本快照内不可寻址）', async () => {
    // 行为的显式选定：吞掉的子树压根没走 format()，既不编号也不登记，所以既拿不到 uid，
    // 也不会在 nodeMap 里占位。契约是「uid 只在最新快照内有效」，看不见的东西点不了。
    const { ctl, rows, elementCount } = await snap('text-nesting')
    const printed = new Set(rows.map((r) => r.uid))
    const reachable = [...printed].map((uid) => ctl.getNode(uid)!.nodeId)
    // 164 = link "立即登录" 底下那个被吞掉的 StaticText
    expect(reachable).not.toContain('164')
    expect(internals(ctl).nodeMap.size).toBe(elementCount)
    // 也不该在 uidMap 里留下句柄
    expect([...internals(ctl).uidMap.values()]).not.toContain(164)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// G 组 · Golden
// ════════════════════════════════════════════════════════════════════════════

/** 受控夹具的整段输出。小到可以人眼审 —— 改动 4 条规则中任何一条，这里都会以最直观的形式红 */
const GOLDEN: Record<(typeof CONTROLLED)[number], string[]> = {
  empty: ['[snapshot] Page: URL — 1 elements', '- uid=e0 RootWebArea "Empty"'],
  example: [
    '[snapshot] Page: URL — 6 elements',
    '- uid=e0 RootWebArea "Example Domain"',
    ' - uid=e1 heading "Example Domain" level=1',
    ' - uid=e2 paragraph',
    '  - uid=e3 "This domain is for use in documentation examples without needing permission. Avoid use in operations."',
    ' - uid=e4 paragraph',
    '  - uid=e5 link "Learn more"'
  ],
  'text-nesting': [
    '[snapshot] Page: URL — 7 elements',
    '- uid=e0 RootWebArea "Text nesting"',
    ' - uid=e1 link "立即登录"',
    ' - uid=e2 button "简体中文"',
    ' - uid=e3 paragraph',
    '  - uid=e4 "账号登录"',
    ' - uid=e5 "金山软件test"',
    ' - uid=e6 link "图标带子元素的链接"'
  ],
  'deep-nesting': [
    '[snapshot] Page: URL — 4 elements',
    '- uid=e0 RootWebArea "Deep nesting"',
    ' - uid=e1 paragraph',
    '  - uid=e2 "埋很深的一段文字"',
    ' - uid=e3 button "埋很深的按钮"'
  ],
  'form-states': [
    '[snapshot] Page: URL — 24 elements',
    '- uid=e0 RootWebArea "Form states"',
    ' - uid=e1 LabelText',
    '  - uid=e2 "账号"',
    '  - uid=e3 textbox "账号"',
    '   - uid=e4 "alice"',
    ' - uid=e5 LabelText',
    '  - uid=e6 "密码"',
    '  - uid=e7 textbox "密码"',
    ' - uid=e8 checkbox [checked=true]',
    ' - uid=e9 "记住我"',
    ' - uid=ea radio [checked=true]',
    ' - uid=eb "A"',
    ' - uid=ec radio',
    ' - uid=ed "B"',
    ' - uid=ee combobox [collapsed]',
    '  - uid=ef MenuListPopup',
    '   - uid=eg option "甲"',
    '   - uid=eh option "乙"',
    ' - uid=ei button "提交" [disabled]',
    ' - uid=ej textbox "必填" [required]',
    ' - uid=ek textbox',
    '  - uid=el "一段很长的文本"',
    ' - uid=em group',
    '  - uid=en DisclosureTriangle "展开我" [collapsed]'
  ],
  'aria-widgets': [
    '[snapshot] Page: URL — 19 elements',
    '- uid=e0 RootWebArea "ARIA widgets"',
    ' - uid=e1 tablist',
    '  - uid=e2 tab "一"',
    '  - uid=e3 tab "二"',
    ' - uid=e4 listbox',
    '  - uid=e5 option "甲"',
    '  - uid=e6 option "乙"',
    ' - uid=e7 button "折叠面板" [collapsed]',
    ' - uid=e8 heading "标题一" level=1',
    ' - uid=e9 heading "标题二" level=2',
    ' - uid=ea heading "标题三" level=3',
    ' - uid=eb list',
    '  - uid=ec listitem level=1',
    '   - uid=ed ListMarker "•"',
    '   - uid=ee "项一"',
    '  - uid=ef listitem level=1',
    '   - uid=eg ListMarker "•"',
    '   - uid=eh "项二"',
    ' - uid=ei image "有替换文字"'
  ],
  table: [
    '[snapshot] Page: URL — 18 elements',
    '- uid=e0 RootWebArea "Table"',
    ' - uid=e1 table',
    '  - uid=e2 row',
    '   - uid=e3 columnheader "模型"',
    '   - uid=e4 columnheader "Ctx"',
    '   - uid=e5 columnheader "价格"',
    '  - uid=e6 row',
    '   - uid=e7 cell "opus"',
    '   - uid=e8 cell "200000"',
    '   - uid=e9 cell "15.00"',
    '  - uid=ea row',
    '   - uid=eb cell "sonnet"',
    '   - uid=ec cell "200000"',
    '   - uid=ed cell "3.00"',
    '  - uid=ee row',
    '   - uid=ef cell "haiku"',
    '   - uid=eg cell "200000"',
    '   - uid=eh cell "0.80"'
  ]
}

describe('G Golden', () => {
  it.each(CONTROLLED)('G1 %s：整段输出逐字节钉住', async (fx) => {
    const { text } = await snap(fx)
    expect(text).toBe(GOLDEN[fx].join('\n'))
  })

  it.each(REAL)('G2 %s：结构摘要（行数/字符数/role 直方图/可交互数）', async (fx) => {
    // 真实站点不做全文 golden —— 几百上千行的差异没人审得动。摘要能照出规则被削弱，
    // 又不会因为一行文案变化就要求重新审阅整份输出。
    const { elementCount, body, chars, rows } = await snap(fx)
    const roles: Record<string, number> = {}
    for (const row of rows) {
      const key = row.role || '(text)'
      roles[key] = (roles[key] || 0) + 1
    }
    expect({
      elementCount,
      lines: body.length,
      chars,
      interactive: rows.filter((r) => INTERACTIVE_ROLES.has(r.role)).length,
      roles: Object.fromEntries(Object.entries(roles).sort(([a], [b]) => (a < b ? -1 : 1)))
    }).toEqual(DIGEST[fx])
  })
})
