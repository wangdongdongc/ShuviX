/**
 * `BotReply` 契约的三件套：markdown 投影（BR/BT）、跨 realm 收窄（BA）、缺结论的补救
 * （CO）。三者合起来钉的是同一条不变量 —— **content 是模型可见的唯一权威**。
 *
 * 为什么这些用例必须在这一层、而不是端到端：投影是纯函数，它的风险全在「字段的组合」
 * 上（六个键各自出现/缺席/为空的笛卡尔积），而 e2e 一轮只能验一种组合，还要付一次真
 * 会话的代价。反过来，这一层验不了「投影确实进了树」——那条留给 task.e2e.ts。
 *
 * 分组：
 *   BR 全键投影与顺序 · BT 表格（转义/对齐/退化）· BA `asBotReply` 收窄 ·
 *   CO `coerceBotReply` 的补救表 · SC 严格版与补救版的对照
 *
 * **BR-2 是这份文件的看门用例**：`BotReply` 每加一个键，它就必须在 markdown 里留下痕迹，
 * 否则那条信息对模型不存在而 UI 上它明明还在。加了字段忘了投影，第一个响的应该是它。
 */
import { describe, expect, it } from 'vitest'
import {
  asBotReply,
  botReplyToMarkdown,
  coerceBotReply,
  type BotReply,
  type BotReplyStatus
} from './botReply'

/** 六个可选/必填键的一份「每个都非空」的样本 —— 全键覆盖守卫的素材 */
const FULL: Required<BotReply> = {
  headline: '扫描完成，三个接口有回归风险',
  body: '改动集中在鉴权中间件，下游三个调用点没有跟着改。',
  points: ['auth.ts:42 少了空值判断', 'router 的顺序变了'],
  table: {
    columns: ['接口', '状态'],
    rows: [
      ['/login', '待修'],
      ['/refresh', 'OK']
    ]
  },
  status: 'warn',
  followups: ['要我直接改吗？', '需要我跑一遍集成测试吗？']
}

/** 每个键单独出现时，它在 markdown 里的「痕迹」是什么 —— BR-2 的判据表 */
const TRACES: Array<[keyof BotReply, string]> = [
  ['headline', FULL.headline],
  ['body', FULL.body],
  ['points', FULL.points[0]],
  ['table', FULL.table.columns[0]],
  ['status', 'Status: warn'],
  ['followups', FULL.followups[0]]
]

describe('BR —— 全键 markdown 投影', () => {
  it('BR-1 全键样本：六段齐出，且顺序固定为 headline → body → points → table → status → followups', () => {
    const md = botReplyToMarkdown(FULL)
    const at = (needle: string): number => md.indexOf(needle)
    // 顺序不是审美：headline 必须最先（结论先行），status 必须在正文之后（它是给 chip
    // 与重读历史的模型看的机器标签，挤在结论前会把结论推下去）
    expect(at(FULL.headline)).toBe(0)
    expect(at(FULL.headline)).toBeLessThan(at(FULL.body))
    expect(at(FULL.body)).toBeLessThan(at(FULL.points[0]))
    expect(at(FULL.points[0])).toBeLessThan(at('| 接口 | 状态 |'))
    expect(at('| 接口 | 状态 |')).toBeLessThan(at('Status: warn'))
    expect(at('Status: warn')).toBeLessThan(at('Follow-ups:'))
  })

  it.each(TRACES)(
    'BR-2 【全键覆盖守卫】只有 %s 一个键时，它仍在 markdown 里留下痕迹',
    (key, trace) => {
      // 加了新字段却忘了投影，这条先响 —— 它是本文件存在的理由
      const single = { headline: '结论', [key]: FULL[key] } as BotReply
      expect(botReplyToMarkdown(single)).toContain(trace)
    }
  )

  it('BR-3 段落之间一律空行相隔（markdown 里段与段不粘连）', () => {
    const md = botReplyToMarkdown({ headline: 'H', body: 'B', status: 'ok' })
    expect(md).toBe('H\n\nB\n\nStatus: ok')
  })

  it('BR-4 只有 headline → 就是那一行，不带任何小节脚手架', () => {
    expect(botReplyToMarkdown({ headline: '好的' })).toBe('好的')
  })

  it('BR-5 points 逐条渲染成 `- ` 列表，条目内顺序保持', () => {
    expect(botReplyToMarkdown({ headline: 'H', points: ['一', '二', '三'] })).toBe(
      'H\n\n- 一\n- 二\n- 三'
    )
  })

  it('BR-6 followups 带 `Follow-ups:` 标签 + 列表；标签是 ASCII 且不本地化', () => {
    // content 是落进会话树的持久文本 —— 跟着语言设置变会让历史消息在切语言之后改写自己
    const md = botReplyToMarkdown({ headline: 'H', followups: ['再来一次？'] })
    expect(md).toBe('H\n\nFollow-ups:\n- 再来一次？')
  })

  it.each<BotReplyStatus>(['ok', 'warn', 'error'])('BR-7 status %s 投影成一行 `Status: x`', (s) => {
    expect(botReplyToMarkdown({ headline: 'H', status: s })).toContain(`Status: ${s}`)
  })

  it.each([
    ['空数组 points', { headline: 'H', points: [] }],
    ['全空白 points', { headline: 'H', points: ['', '   '] }],
    ['空数组 followups', { headline: 'H', followups: [] }],
    ['全空白 followups', { headline: 'H', followups: ['  '] }],
    ['空白 body', { headline: 'H', body: '   \n  ' }]
  ] as Array<[string, BotReply]>)('BR-8 空/纯空白字段整段消失：%s', (_n, reply) => {
    // 「只有标题没有内容的小节」比没有它更糟 —— 模型会以为那里本该有东西
    expect(botReplyToMarkdown(reply)).toBe('H')
  })

  it('BR-9 headline 为空白时不产出前导空行（其余字段照常上位）', () => {
    // 投影本身不负责补救结论（那是 coerceBotReply 的事），但它绝不能吐出一个以空行开头
    // 的 content —— 那会在气泡顶端留一片空白
    expect(botReplyToMarkdown({ headline: '   ', body: '正文' })).toBe('正文')
  })

  it('BR-10 各段的内容原样保留（不做 trim 之外的加工，markdown 语法照旧生效）', () => {
    const md = botReplyToMarkdown({ headline: 'H', body: '## 小标题\n\n- 手写列表' })
    expect(md).toContain('## 小标题')
    expect(md).toContain('- 手写列表')
  })
})

describe('BT —— 表格投影', () => {
  const table = (columns: string[], rows: string[][]): string =>
    botReplyToMarkdown({ headline: 'H', table: { columns, rows } })

  it('BT-1 表头 + 分隔行 + 数据行，分隔行的格数与列数一致', () => {
    expect(table(['A', 'B'], [['1', '2']])).toBe('H\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')
  })

  it('BT-2 单元格里的 `|` 被转义（否则整行在 GFM 里被截断）', () => {
    expect(table(['A'], [['x|y']])).toContain('| x\\|y |')
  })

  it('BT-3 单元格里的换行压成空格（否则一行被拆成两行，整表错位）', () => {
    expect(table(['A'], [['第一行\n第二行']])).toContain('| 第一行 第二行 |')
    expect(table(['A'], [['a\r\nb']])).toContain('| a b |')
  })

  it('BT-4 行比表头短 → 补空格；长 → 截断（模型给出长短不一的行是常事）', () => {
    const md = table(['A', 'B', 'C'], [['1'], ['1', '2', '3', '4']])
    expect(md).toContain('| 1 |  |  |')
    expect(md).toContain('| 1 | 2 | 3 |')
    expect(md).not.toContain('| 4 |')
  })

  it('BT-5 单元格前后空白被 trim（对齐靠 GFM，不靠手填空格）', () => {
    expect(table([' A '], [['  1  ']])).toContain('| A |\n| --- |\n| 1 |')
  })

  it('BT-6 null/undefined 单元格渲染成空格而不是字面 "null"', () => {
    const md = table(['A', 'B'], [[null as unknown as string, undefined as unknown as string]])
    expect(md).toContain('| A | B |\n| --- | --- |\n|  |  |')
    expect(md).not.toMatch(/null|undefined/)
  })

  it('BT-7 多行表格逐行渲染，行序保持', () => {
    expect(table(['N'], [['1'], ['2'], ['3']])).toBe('H\n\n| N |\n| --- |\n| 1 |\n| 2 |\n| 3 |')
  })

  it('BT-8 只有表头没有行 → 整张表消失（与 points/followups 同一条纪律）', () => {
    // 一张只有表头的空表正是本模块开头点名要避免的「只有标题没有内容的小节」
    expect(table(['A', 'B'], [])).toBe('H')
  })

  it('BT-9 没有列 → 整张表消失（哪怕给了行）', () => {
    expect(table([], [['1']])).toBe('H')
  })

  it('BT-10 columns/rows 缺席或非数组 → 整张表消失，不抛', () => {
    const bad = { headline: 'H', table: {} as unknown as BotReply['table'] }
    expect(botReplyToMarkdown(bad)).toBe('H')
  })
})

describe('BA —— asBotReply：跨 realm / 磁盘 JSON 的收窄', () => {
  it('BA-1 全键样本原样通过（收窄不改内容）', () => {
    expect(asBotReply({ ...FULL })).toEqual(FULL)
  })

  it.each([[null], [undefined], ['x'], [42], [true], [[]]])(
    'BA-2 非对象入参（%s）→ null',
    (raw) => {
      expect(asBotReply(raw)).toBeNull()
    }
  )

  it.each([
    ['缺 headline', { body: 'b' }],
    ['headline 为空串', { headline: '' }],
    ['headline 纯空白', { headline: '  \n ' }],
    ['headline 非字符串', { headline: 42, body: 'b' }]
  ])('BA-3 %s → null（严格版不补救，那是 coerceBotReply 的事）', (_n, raw) => {
    expect(asBotReply(raw)).toBeNull()
  })

  it('BA-4 headline 被 trim；body 不 trim（它是 markdown 散文，缩进有意义）', () => {
    const out = asBotReply({ headline: '  H  ', body: '  正文  ' })!
    expect(out.headline).toBe('H')
    expect(out.body).toBe('  正文  ')
  })

  it('BA-5 未知键一律丢弃（磁盘 JSON 可能来自旧版本或手工编辑）', () => {
    const out = asBotReply({ headline: 'H', evil: 1, __proto__: { x: 1 } })!
    expect(Object.keys(out)).toEqual(['headline'])
  })

  it('BA-6 points：非字符串项与空白项被剔除，全空则整个键不铺', () => {
    expect(asBotReply({ headline: 'H', points: ['a', 42, '', '  ', 'b'] })!.points).toEqual([
      'a',
      'b'
    ])
    expect(asBotReply({ headline: 'H', points: [42, ''] })).not.toHaveProperty('points')
    expect(asBotReply({ headline: 'H', points: 'not-an-array' })).not.toHaveProperty('points')
  })

  it('BA-7 status 只认三个字面量，其余（含大小写变体）整个键不铺', () => {
    for (const s of ['ok', 'warn', 'error']) {
      expect(asBotReply({ headline: 'H', status: s })!.status).toBe(s)
    }
    for (const bad of ['OK', 'fine', 1, null]) {
      expect(asBotReply({ headline: 'H', status: bad })).not.toHaveProperty('status')
    }
  })

  it('BA-8 body 为空白 → 整个键不铺（而不是留一个空串）', () => {
    expect(asBotReply({ headline: 'H', body: '   ' })).not.toHaveProperty('body')
    expect(asBotReply({ headline: 'H', body: 42 })).not.toHaveProperty('body')
  })

  it('BA-9 table：非数组 rows / 空 rows / 空 columns 一律不铺 table 键', () => {
    for (const table of [
      { columns: ['A'], rows: 'nope' },
      { columns: ['A'], rows: [] },
      { columns: [], rows: [['1']] },
      { columns: ['A'] },
      'not-an-object'
    ]) {
      expect(asBotReply({ headline: 'H', table }), JSON.stringify(table)).not.toHaveProperty(
        'table'
      )
    }
  })

  it('BA-10 table 的行按列数对齐 —— 短补空串、长截断，与 markdown 投影同口径', () => {
    // 两边口径不一致的话，UI 会显示模型看不见的单元格：那正是「content 是唯一权威」
    // 这条不变量在单元格粒度上的样子
    const out = asBotReply({
      headline: 'H',
      table: { columns: ['A', 'B'], rows: [['1'], ['1', '2', '3'], ['1', 2]] }
    })!
    expect(out.table!.rows).toEqual([
      ['1', ''],
      ['1', '2'],
      ['1', '2']
    ])
  })

  it('BA-11 rows 里的非数组项被整行丢掉（不塌成一行空格）', () => {
    const out = asBotReply({
      headline: 'H',
      table: { columns: ['A'], rows: [['1'], 'nope', null, ['2']] }
    })!
    expect(out.table!.rows).toEqual([['1'], ['2']])
  })

  it('BA-12 【投影闭环】asBotReply(x) 非 null ⇒ botReplyToMarkdown 输出非空', () => {
    // 收窄放行了却投影不出东西，等于会话里落一条空消息 —— appendBotMessage 会拒收它，
    // 于是脚本拿到 messageId:null、journal 里没有失败记录、会话里什么都没有
    const samples: unknown[] = [
      { headline: 'H' },
      { ...FULL },
      { headline: 'H', points: ['p'] },
      { headline: 'H', table: { columns: ['A'], rows: [['1']] } },
      { headline: 'H', status: 'ok' },
      { headline: 'H', followups: ['f'] },
      // 除 headline 外全是会被剔除的垃圾 —— headline 本身仍撑得起一条消息
      { headline: 'H', body: '  ', points: [''], table: { columns: [] }, status: 'nope' }
    ]
    for (const raw of samples) {
      const narrowed = asBotReply(raw)
      expect(narrowed, JSON.stringify(raw)).not.toBeNull()
      expect(botReplyToMarkdown(narrowed!).trim(), JSON.stringify(raw)).not.toBe('')
    }
  })
})

describe('CO —— coerceBotReply：缺结论时的补救表', () => {
  it('CO-1 有 headline 时与 asBotReply 完全一致（补救层不改正常路径）', () => {
    expect(coerceBotReply({ ...FULL })).toEqual(asBotReply({ ...FULL }))
  })

  it('CO-2 缺 headline + 有 body → 提 body 首行当结论，且首行不在原位重复', () => {
    const out = coerceBotReply({ body: '第一句结论\n\n余下的解释' })!
    expect(out.headline).toBe('第一句结论')
    expect(out.body).toBe('余下的解释')
  })

  it('CO-3 body 只有一行 → 它整个升格为 headline，body 键消失（不留空 body）', () => {
    const out = coerceBotReply({ body: '就这一句' })!
    expect(out).toEqual({ headline: '就这一句' })
  })

  it('CO-4 body 首行是 markdown 标题 → 去掉 `#` 脚手架再当结论', () => {
    // 一个 `#` 是 markdown 家具，不是结论本身
    expect(coerceBotReply({ body: '### 结论在这\n细节' })!.headline).toBe('结论在这')
  })

  it('CO-5 无 body → 提第一个要点，且它从 points 里移走', () => {
    const out = coerceBotReply({ points: ['要点一', '要点二'] })!
    expect(out.headline).toBe('要点一')
    expect(out.points).toEqual(['要点二'])
  })

  it('CO-6 只有一个要点 → 升格后 points 键消失', () => {
    expect(coerceBotReply({ points: ['独苗'] })!).toEqual({ headline: '独苗' })
  })

  it('CO-7 无 body 无 points → 提表头首格当结论，表格原样留下', () => {
    const out = coerceBotReply({ table: { columns: ['接口', '状态'], rows: [['/a', 'ok']] } })!
    expect(out.headline).toBe('接口')
    expect(out.table).toEqual({ columns: ['接口', '状态'], rows: [['/a', 'ok']] })
  })

  it('CO-8 提法优先级：body 首行 > points[0] > 表头首格', () => {
    expect(
      coerceBotReply({ body: 'B', points: ['P'], table: { columns: ['C'], rows: [['1']] } })!
        .headline
    ).toBe('B')
    expect(
      coerceBotReply({ points: ['P'], table: { columns: ['C'], rows: [['1']] } })!.headline
    ).toBe('P')
  })

  it('CO-9 从 body 提结论时 points 原样不动（只有「被提上去那一份」才不重复）', () => {
    const out = coerceBotReply({ body: '结论\n解释', points: ['要点'] })!
    expect(out.points).toEqual(['要点'])
  })

  it.each([
    ['一个可用字段都没有', { status: 'ok' }],
    ['空对象', {}],
    ['字段全是会被剔除的垃圾', { body: '  ', points: [''], table: { columns: [] } }],
    ['非对象', 'nope'],
    ['null', null]
  ])('CO-10 %s → null（补救也救不回来时才真的放弃）', (_n, raw) => {
    expect(coerceBotReply(raw)).toBeNull()
  })

  it('CO-11 补救产物同样闭环：非 null ⇒ markdown 非空', () => {
    for (const raw of [
      { body: 'B' },
      { points: ['P'] },
      { table: { columns: ['C'], rows: [['1']] } }
    ]) {
      const out = coerceBotReply(raw)!
      expect(out, JSON.stringify(raw)).not.toBeNull()
      expect(botReplyToMarkdown(out).trim(), JSON.stringify(raw)).not.toBe('')
    }
  })

  it('CO-12 status / followups 在补救产物里原样保留（补救只补结论，不裁内容）', () => {
    const out = coerceBotReply({ body: '结论\n解释', status: 'warn', followups: ['再来'] })!
    expect(out.status).toBe('warn')
    expect(out.followups).toEqual(['再来'])
  })
})

describe('SC —— 严格版与补救版的分工', () => {
  it.each([
    ['缺 headline 但有 body', { body: '完整分析' }],
    ['headline 纯空白但有 points', { headline: '  ', points: ['要点'] }],
    ['只有表格', { table: { columns: ['A'], rows: [['1']] } }]
  ])('SC-1 %s：asBotReply 判 null，coerceBotReply 救回来', (_n, raw) => {
    // 严格版给侧车（UI 读的那份必须是模型看得见的同一份），补救版给 asSayContent
    // （「有形状、缺一句结论」离「没有回复」差得很远，作废会让用户拿到一句内部错误串）
    expect(asBotReply(raw)).toBeNull()
    expect(coerceBotReply(raw)).not.toBeNull()
  })

  it('SC-2 两者对「彻底没内容」的判断一致 —— 都是 null', () => {
    for (const raw of [{}, { status: 'ok' }, null, 'x', 42]) {
      expect(asBotReply(raw), JSON.stringify(raw)).toBeNull()
      expect(coerceBotReply(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})
