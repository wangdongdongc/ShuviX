/**
 * bot md **笔记区**（`<!-- shuvix:bot-notes -->` 一条分界线，线以下归 bot）的纯函数契约。
 *
 * 一条贯穿全组的分界线：**split 吃 body、splice 吃 raw**。
 * `splitBotNotes` 收的是 `splitFrontmatter` 之后的正文
 * （它自己用 `findBodyOffset` 重新定位 frontmatter —— 解析产物的下标映射不回 raw，因为
 * `splitFrontmatter` 会剥 BOM 与前导空白）。两者共用同一个分界线定位器，**这个共用就是
 * 本组要守的核心不变式**：一旦漂移，就会「写在一处、读在另一处」—— 写入走「新建」分支
 * 不断追加，而读取永远看不到刚写的那条线（NX 组、NW-15/NW-18 正是钉这一点）。
 *
 * 另一条贯穿全文件的纪律：**笔记是状态不是定义**。本模块每个导出恒不抛，任何结构异常
 * 都只记 anomaly，绝不带「整份拒绝」语义（NS-7）。
 *
 * 分组：NM 分界线判别（MARKER_RE + 行/围栏上下文）· NS splitBotNotes。
 *
 * 本模块只读不写 —— 笔记的日常维护由 `bot-notes` 阶段 agent 用普通 `edit` 工具就地完成，
 * 宿主没有程序化的笔记写路径，所以这里没有写侧用例。
 */
import { describe, expect, it } from 'vitest'
import { BOT_NOTES_MARKER, splitBotNotes } from '../botNotes'

const MK = BOT_NOTES_MARKER

const md = (...lines: string[]): string => lines.join('\n')

// ─────────────────────── NM：分界线判别（行 / 围栏上下文） ───────────────────────

describe('NM —— 分界线判别', () => {
  /** 把候选行放进「人设 / 候选行 / 笔记」的标准三明治里 */
  const sandwich = (line: string): ReturnType<typeof splitBotNotes> =>
    splitBotNotes(md('P', line, 'N', ''))

  it('NM-1 标准写法：单独成行的分界线切分正文', () => {
    const r = splitBotNotes(md('P', MK, 'N', ''))
    expect(r.persona).toBe('P\n')
    expect(r.notes).toBe('N')
    expect(r.anomalies).toEqual([])
  })

  it('NM-2 无空格写法 `<!--shuvix:bot-notes-->` 同样识别', () => {
    // 钉住 `(?=\s|-->)` 而不是 `(?![\w-])` 的唯一动机：后者会把 `-->` 的首个 `-` 一并挡掉，
    // 于是这种（编辑器格式化后极常见的）写法静默退化成普通注释文本。
    expect(sandwich('<!--shuvix:bot-notes-->').notes).toBe('N')
  })

  it.each([
    ['属性位 + 多空格', '<!--   shuvix:bot-notes   v2 attr=1 -->'],
    ['版本号', '<!-- shuvix:bot-notes v1 -->'],
    ['制表符分隔', '<!--\tshuvix:bot-notes -->']
  ])('NM-3 名字之后的说明文字放行（%s）—— 给将来的属性位留的活口现在就得管用', (_l, line) => {
    expect(sandwich(line).notes, line).toBe('N')
  })

  it.each([
    ['两个空格', `${MK}  `],
    ['制表符', `${MK}\t`]
  ])('NM-4a 行尾空白放行（%s）', (_l, line) => {
    expect(sandwich(line).notes, line).toBe('N')
  })

  it('NM-4b `-->` 之后有非空白字符即不识别（`[ \\t]*$` 的边界）', () => {
    expect(sandwich(`${MK} trailing`).notes).toBeNull()
  })

  it.each([
    ['相邻词', '<!-- shuvix:bot-notesish -->'],
    ['连字符续写', '<!-- shuvix:bot-notes-extra -->']
  ])('NM-5 名字必须整词结束（%s）→ 整行逐字留在人设', (_l, line) => {
    // 否则将来加同族标记（bot-notes-archive 之类）会互相误吞
    const r = sandwich(line)
    expect(r.notes, line).toBeNull()
    expect(r.persona, line).toContain(line)
  })

  it('NM-6 属性里含 `>` 不识别（`[^\\n>]*` 的边界，现状钉板）', () => {
    expect(sandwich('<!-- shuvix:bot-notes a=">" -->').notes).toBeNull()
  })

  it('NM-7 未闭合的注释不是分界线', () => {
    expect(sandwich('<!-- shuvix:bot-notes').notes).toBeNull()
  })

  it.each([
    ['一个前导空格', ` ${MK}`],
    ['四空格缩进（缩进代码块）', `    ${MK}`]
  ])('NM-8 非行首不识别（%s）', (_l, line) => {
    const r = sandwich(line)
    expect(r.notes, line).toBeNull()
    expect(r.persona, line).toContain(line)
  })

  it('NM-9 大小写敏感（与 md 家族其余标记同策）', () => {
    // 钉板而非背书：分界线由宿主的 spliceBotNotes 写，大小写不会出错；
    // 若将来允许 agent 自己写这条线，本例是它最容易踩的静默失败之一。
    expect(sandwich('<!-- SHUVIX:BOT-NOTES -->').notes).toBeNull()
  })

  it('NM-10 CRLF 行尾：判别前剥掉行尾 \\r，Windows 文件同样识别', () => {
    const r = splitBotNotes(`P\r\n${MK}\r\nN\r\n`)
    expect(r.notes).toBe('N')
    // 人设侧的 \r **不**被剥 —— split 只 trim 笔记，人设逐字返回
    expect(r.persona).toBe('P\r\n')
  })

  it.each([
    ['反引号围栏', '```'],
    ['波浪号围栏', '~~~']
  ])('NM-11 闭合围栏内的分界线不生效、围栏之后照常生效（%s）', (_l, fence) => {
    // 人设可以在代码块里**展示**这条标记（写文档、教用户）而不触发切分
    const r = splitBotNotes(md('Fence:', fence, MK, fence, '', MK, '', 'real notes', ''))
    expect(r.notes).toBe('real notes')
    expect(r.persona).toContain(`${fence}\n${MK}\n${fence}`)
  })

  it('NM-12 未闭合围栏之后的分界线仍然生效（围栏跟踪在开而未闭时整体放弃）', () => {
    // 曾经的 BUG：人设里出现列首孤立的 ``` 之后，分界线永久不可见 —— bot 写的全部笔记
    // 逐字落进人设（self-narrative 污染），而 splice 每轮都走「新建」分支追加一条新线
    // （见 NW-18）。开而未闭的文档本就没有正解，两害相权：放弃围栏跟踪重扫一遍。
    const r = splitBotNotes(md('Fence like this:', '```', '', MK, '', 'the notes'))
    expect(r.notes).toBe('the notes')
    expect(r.persona).not.toContain('the notes')
  })
})

// ─────────────────────────── NS：splitBotNotes(body) ───────────────────────────

describe('NS —— splitBotNotes：正文切成人设与笔记', () => {
  it('NS-1 无分界线：整段正文都是人设、逐字不变（trim 是 botFile 的事）', () => {
    const body = md('  leading spaces', '', 'PERSONA', '', '')
    const r = splitBotNotes(body)
    expect(r.notes).toBeNull()
    expect(r.persona).toBe(body)
    expect(r.anomalies).toEqual([])
  })

  it('NS-2 有分界线：线上归人设（尾随空行原样保留）、线下归笔记（两端已 trim）', () => {
    const r = splitBotNotes(md('PERSONA', '', '', MK, '', '  notes prose  ', '', ''))
    expect(r.persona).toBe('PERSONA\n\n\n')
    expect(r.notes).toBe('notes prose')
  })

  it("NS-3 分界线是末行：`''`（有区但空）与 `null`（没有区）是两种状态", () => {
    expect(splitBotNotes(`P\n${MK}`).notes).toBe('')
    expect(splitBotNotes('P\n').notes).toBeNull()
  })

  it('NS-4 空串入参给出中性结果', () => {
    expect(splitBotNotes('')).toEqual({ persona: '', notes: null, anomalies: [] })
  })

  it('NS-5 只有分界线一行：人设为空是允许的形状（agents.task 型 bot）', () => {
    const r = splitBotNotes(`${MK}\n`)
    expect(r.persona).toBe('')
    expect(r.notes).toBe('')
  })

  it('NS-6 多条分界线取第一条，其后的逐字留在笔记里', () => {
    // 「多文本归笔记、少文本归人设」是两类错误里代价小的那类：bot 写的字漏进人设
    // 等于让它改写自己的设定，用户散文被当成笔记只是显示错位。
    const r = splitBotNotes(md('PERSONA', MK, 'first', MK, 'second', MK, 'third', ''))
    expect(r.persona).toBe('PERSONA\n')
    expect(r.notes).toBe(md('first', MK, 'second', MK, 'third'))
    // anomaly 数 = 分界线数 − 1
    expect(r.anomalies).toHaveLength(2)
    for (const a of r.anomalies) expect(a).toMatch(/more than one/)
  })

  it('NS-7 anomaly 不带拒绝语义（状态区软失败在纯函数层的落点）', () => {
    const r = splitBotNotes(md('P', MK, 'a', MK, 'b'))
    expect(r.anomalies.length).toBeGreaterThan(0)
    for (const a of r.anomalies) expect(a).not.toMatch(/the whole file is rejected/)
  })

  it('NS-8 笔记没有自己的语法：线以下的 markdown 逐字保留（只两端 trim）', () => {
    // 不做条目化的全部理由：用户打开 bot md 读到的就是一篇散文，不需要理解任何机器格式
    const prose = md(
      '## 关于这个用户',
      '',
      '- 偏好 pnpm',
      '- 讨论设计时先看先例',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '---',
      '',
      '尾注 {{shuvix:workingDirectory}}',
      '含 CRLF 的一行\r',
      '末行'
    )
    expect(splitBotNotes(`P\n${MK}\n${prose}\n`).notes).toBe(prose)
  })

  it.each([['<!--'], [`<!-- shuvix:bot-notes`], [' '], ['\n'.repeat(50)], ['🙂'.repeat(10)]])(
    'NS-9 畸形输入恒不抛（%#）',
    (input) => {
      expect(() => splitBotNotes(input)).not.toThrow()
    }
  )
})

// ─────────────── NW：spliceBotNotes(raw, notes)：三种模式 + 字节保真 ───────────────
