/**
 * bot 文件写入回执里的排期预演（services/botScheduleHint）—— 判「这是不是一份 bot 文件」、给出此刻（`new Date()`）、
 * 宿主 env 与项目查找，文字本身来自 agent-runtime 的 botScheduleNote（schedulePreview.test 逐字钉住）。
 *
 * 契约（botScheduleHint.ts 的注释 + 2026-10-31 的裁定）：
 *  - 认法：bots 目录顶层的 md（标记可以不写），或 frontmatter 的标记是 `shuvix: bot`（detectShuvixMarker；只看
 *    frontmatter，正文里的那一行不算）；`<bots>/archived/` 里的不给（归档的 bot 不触发）；扩展名只认 .md（不分大小写）；
 *  - 解析不过 / 没有绑定 / 没有定时绑定 → null；任何一步抛错都回 null，从不抛；
 *  - env 与真的触发源相同（`{host: 'desktop', platform: process.platform}`）；
 *  - 项目查找由 main 启动时注入（setBotScheduleProjectLookup）；没注入不查；查找抛错 = 当作对得上（不说项目那一行），
 *    排期照给；
 *  - 只替身 utils/paths（getDefaultBotsDir → 临时目录）：模块本身不静态引 projectService / 数据库，不桩它们也加载得起来。
 *
 *   BSH-1  bots 目录里没写标记的 md → 回执
 *   BSH-2  bots 目录外：带 `shuvix: bot v2` → 回执；没有标记 → null
 *   BSH-3  解析器认的标记写法（引号、多个空格、没有版本号）→ 回执；只在正文里 / `shuvix: botany` / `shuvix:bot`（YAML 不认）→ null
 *   BSH-4  `<bots>/archived/x.md` → null（带标记也一样）
 *   BSH-5  `.txt` / `.markdown` → null；`X.MD` → 回执
 *   BSH-6  解析不过（YAML 坏、bots 目录里的 agent 标记、会话域埋点、CEL 语法错）→ null，不抛
 *   BSH-7  没有绑定（没写 / 空列表）→ null
 *   BSH-8  序号按文件里的位置：前面一条未知埋点（惰性、文件照样合法）→ binding #1
 *   BSH-9  项目查找 0 / 1 / 2 → 有 / 没有 / 有 那一行；查找收到的是解析器去过空白的名字；复位成 undefined → 不查
 *   BSH-10 项目查找抛错 → 排期照给、没有项目那一行
 *   BSH-11 env 与触发源一致：env.host == 'desktop' && env.platform == process.platform
 *   BSH-12 BOM + CRLF 的文本 → 与 LF 同一段
 *   BSH-13 getDefaultBotsDir 抛错 → null，不抛
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ bots: '', botsThrows: false }))

vi.mock('../../utils/paths', () => ({
  getDefaultBotsDir: () => {
    if (state.botsThrows) throw new Error('no home')
    return state.bots
  }
}))

import {
  botScheduleHint,
  botScheduleNoteFor,
  setBotScheduleProjectLookup
} from '../botScheduleHint'

let root = ''
const savedTz = process.env.TZ

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shuvix-bot-schedule-hint-'))
  state.bots = join(root, 'bots')
  return () => rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  process.env.TZ = 'Asia/Shanghai'
  vi.useFakeTimers({ toFake: ['Date'] })
  // 周六 2026-10-31 12:00:30（本地）
  vi.setSystemTime(new Date(2026, 9, 31, 12, 0, 30))
  state.botsThrows = false
})
afterEach(() => {
  vi.useRealTimers()
  setBotScheduleProjectLookup(undefined)
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

/** 一份 bot 文件：frontmatter 行（不含 `---`）+ 正文 */
function botText(frontmatter: string[], body = 'Persona.'): string {
  return ['---', ...frontmatter, '---', '', body, ''].join('\n')
}

/** 每天 20:00 一条定时绑定（可带 project） */
function daily(marker: string | null, extra: string[] = []): string {
  return botText([
    ...(marker === null ? [] : [marker]),
    'name: buddy',
    'shuvix-bot-on:',
    '  - trigger: timer.fired',
    `    when: "event.local.time == '20:00'"`,
    '    message: Evening check-in.',
    ...extra
  ])
}

const NOTE = [
  'Schedule check (local time, the next 14 days):',
  '- binding #0 (timer.fired): next at Sat 2026-10-31 20:00, Sun 2026-11-01 20:00, Mon 2026-11-02 20:00.'
].join('\n')

const inBots = (name: string): string => join(state.bots, name)
const outside = (name: string): string => join(root, 'elsewhere', name)

describe('botScheduleHint —— 认不认这是一份 bot 文件', () => {
  it('BSH-1 bots 目录里没写标记的 md → 回执（与 botScheduleNoteFor 同一段）', () => {
    const text = daily(null)
    expect(botScheduleHint(inBots('buddy.md'), text)).toBe(NOTE)
    expect(botScheduleNoteFor(text, 'buddy.md')).toBe(NOTE)
  })

  it('BSH-2 bots 目录外：带 `shuvix: bot v2` → 回执；没有标记 → null', () => {
    expect(botScheduleHint(outside('buddy.md'), daily('shuvix: bot v2'))).toBe(NOTE)
    expect(botScheduleHint(outside('buddy.md'), daily(null))).toBeNull()
  })

  it.each([
    ["shuvix: 'bot v2'"],
    ['shuvix: "bot v2"'],
    ['shuvix:    bot v2'],
    ['shuvix: bot'],
    ['shuvix: bot v1']
  ])('BSH-3 解析器认的标记写法 %s（bots 目录外）→ 回执', (marker) => {
    expect(botScheduleHint(outside('buddy.md'), daily(marker))).toBe(NOTE)
  })

  it('BSH-3 只在正文里写 `shuvix: bot` → null；`shuvix: botany` → null；`shuvix:bot`（YAML 解析不过）→ null', () => {
    const bodyOnly = `${daily(null).trimEnd()}\nshuvix: bot v2\n`
    expect(bodyOnly).toContain('\nshuvix: bot v2\n')
    expect(botScheduleHint(outside('buddy.md'), bodyOnly)).toBeNull()
    expect(botScheduleHint(outside('buddy.md'), daily('shuvix: botany'))).toBeNull()
    // detectShuvixMarker 认这一行（不要求冒号后的空格），可 YAML 把它读成一个多行的键 → 解析器整份拒绝
    expect(botScheduleHint(outside('buddy.md'), daily('shuvix:bot'))).toBeNull()
  })

  it('BSH-4 `<bots>/archived/x.md` → null，带标记也一样（归档的 bot 不触发）', () => {
    const archived = join(state.bots, 'archived', 'buddy.md')
    expect(botScheduleHint(archived, daily(null))).toBeNull()
    expect(botScheduleHint(archived, daily('shuvix: bot v2'))).toBeNull()
  })

  it('BSH-5 扩展名：.txt / .markdown → null；X.MD → 回执', () => {
    expect(botScheduleHint(inBots('buddy.txt'), daily('shuvix: bot v2'))).toBeNull()
    expect(botScheduleHint(inBots('buddy.markdown'), daily('shuvix: bot v2'))).toBeNull()
    expect(botScheduleHint(inBots('X.MD'), daily(null))).toBe(NOTE)
  })
})

describe('botScheduleHint —— 解析不过、没有绑定', () => {
  it.each([
    ['YAML 坏了', botText(['name: [unclosed', 'shuvix-bot-on: []'])],
    ['bots 目录里的 agent 标记', daily('shuvix: agent v1')],
    [
      '会话域埋点',
      botText([
        'name: buddy',
        'shuvix-bot-on:',
        '  - trigger: session.turn-completed',
        '    message: Hi.',
        '  - trigger: timer.fired',
        '    message: Tick.'
      ])
    ],
    [
      'CEL 语法错',
      botText([
        'name: buddy',
        'shuvix-bot-on:',
        '  - trigger: timer.fired',
        '    when: "event.local.time =="',
        '    message: Tick.'
      ])
    ]
  ])('BSH-6 %s → null，不抛', (_label, text) => {
    expect(() => botScheduleHint(inBots('buddy.md'), text)).not.toThrow()
    expect(botScheduleHint(inBots('buddy.md'), text)).toBeNull()
  })

  it('BSH-7 没有绑定（没写 shuvix-bot-on / 写成空列表）→ null', () => {
    expect(botScheduleHint(inBots('buddy.md'), botText(['name: buddy']))).toBeNull()
    expect(
      botScheduleHint(inBots('buddy.md'), botText(['name: buddy', 'shuvix-bot-on: []']))
    ).toBeNull()
  })

  it('BSH-8 序号按文件里的位置：前面一条未知埋点（惰性，文件照样合法）→ 定时那条是 binding #1', () => {
    const text = botText([
      'shuvix: bot v2',
      'name: buddy',
      'shuvix-bot-on:',
      '  - trigger: no.such.trigger',
      '    message: Never.',
      '  - trigger: timer.fired',
      `    when: "event.local.time == '20:00'"`,
      '    message: Evening.'
    ])
    expect(botScheduleHint(inBots('buddy.md'), text)).toBe(NOTE.replace('#0', '#1'))
  })
})

describe('botScheduleHint —— 项目查找与 env', () => {
  const withProject = daily('shuvix: bot v2', ["    project: '  Acme Site  '"])

  it.each([
    [
      0,
      `${NOTE}\n- binding #0 (timer.fired): no project is named "Acme Site", so every run would be skipped.`
    ],
    [1, NOTE],
    [
      2,
      `${NOTE}\n- binding #0 (timer.fired): more than one project is named "Acme Site", so every run would be skipped.`
    ]
  ])('BSH-9 查找回 %i → 对应的回执；查找收到的是解析器去过空白的名字', (count, expected) => {
    const lookup = vi.fn((_name: string) => count)
    setBotScheduleProjectLookup(lookup)
    expect(botScheduleHint(inBots('buddy.md'), withProject)).toBe(expected)
    expect(lookup.mock.calls).toEqual([['Acme Site']])
  })

  it('BSH-9 复位成 undefined → 不查、没有项目那一行', () => {
    const lookup = vi.fn((_name: string) => 0)
    setBotScheduleProjectLookup(lookup)
    setBotScheduleProjectLookup(undefined)
    expect(botScheduleHint(inBots('buddy.md'), withProject)).toBe(NOTE)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('BSH-10 项目查找抛错 → 排期照给、没有项目那一行', () => {
    setBotScheduleProjectLookup(() => {
      throw new Error('database closed')
    })
    expect(botScheduleHint(inBots('buddy.md'), withProject)).toBe(NOTE)
  })

  it('BSH-11 env 与触发源一致：host 是 desktop、platform 是 process.platform', () => {
    const text = botText([
      'name: buddy',
      'shuvix-bot-on:',
      '  - trigger: timer.fired',
      `    when: "env.host == 'desktop' && env.platform == '${process.platform}' && event.local.time == '20:00'"`,
      '    message: Evening.'
    ])
    expect(botScheduleHint(inBots('buddy.md'), text)).toBe(NOTE)
  })

  it('BSH-12 BOM + CRLF 的文本 → 与 LF 同一段', () => {
    const crlf = `\uFEFF${daily('shuvix: bot v2').replace(/\n/g, '\r\n')}`
    expect(crlf).toContain('\r\n')
    expect(botScheduleHint(inBots('buddy.md'), crlf)).toBe(NOTE)
    expect(botScheduleHint(outside('buddy.md'), crlf)).toBe(NOTE)
  })

  it('BSH-13 getDefaultBotsDir 抛错 → null，不抛', () => {
    state.botsThrows = true
    expect(() => botScheduleHint(inBots('buddy.md'), daily('shuvix: bot v2'))).not.toThrow()
    expect(botScheduleHint(inBots('buddy.md'), daily('shuvix: bot v2'))).toBeNull()
  })
})
