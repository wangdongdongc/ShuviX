/**
 * 随应用提供的 bot（builtinBots.ts）—— 今天只有日记助手 `daily`（2026-10-31 之前是日报助手）。
 *
 * 它不在应用包里现读：第一次启动时由宿主按界面语言写进 `~/.shuvix/bots/`（桌面 botService 的 seedBuiltinBots），
 * 之后就是一份普通 bot 文件。所以这里钉的是「写下去的那份 md」本身：三种语言都必须被 bot 解析器零告警地读回来、
 * 带着恒定的对象 id（配套策略 daily-bot-access 按它认人）、带着那条每天 18:00 的触发绑定。正文里交代的做法
 * 必须与今天的真实契约对得上（session 工具的 list-sessions 参数、事件围栏的字段、日记目录、文件名与格式、日记的
 * 小标题、会话链接、suggest）—— 这些字面量一改，正文就成了过期指令，没有别的测试会响。它不再维护跟踪项，
 * 也不再指向 `builtin:tracking` 技能（技能照旧随包，BB-5 末尾照旧钉它与契约对齐）。
 *
 * 分组：BB-1 种子表 · BB-2 三语渲染可解析 · BB-3 语言回落 · BB-4 绑定条件求值 · BB-5 正文与契约对齐 ·
 * BB-U v0.2.27 / v0.2.28 种下的文件的升级（`upgradeDailyBot`）· BB-V v0.2.29 起种下的文件的升级
 *
 * 升级的输入是两套夹具，都只生成一次、之后不许再改 —— 它们代表的是「用户盘上已经有的东西」，跟着今天的源码重生
 * 就什么都钉不住了：
 *   - `fixtures/daily-v0.2.27.{zh,en,ja}.md`：v0.2.27 真正种下去的那三份文件，逐字节。用 jiti 加载
 *     `git show v0.2.27:packages/agent-runtime/src/bot/builtinBots.ts`，对 zh / en / ja 各调一次
 *     `BUILTIN_BOT_SEEDS[0].render(lang)` 原样写盘。v0.2.28 的种子源码与 v0.2.27 逐字节相同，所以这三份同时代表两个版本。
 *   - `fixtures/daily-v0.2.29.{zh,en,ja}.md`：v0.2.29 起种下的日报助手（正文只指向 `builtin:tracking`），逐字节；
 *     v0.2.27 / v0.2.28 的文件在 v0.2.29 起的启动时也升级成了这一份。同样的做法，加载的是
 *     `git show v0.2.29:packages/agent-runtime/src/bot/builtinBots.ts`（直到 v0.2.42 那个文件都没变过）。
 * 目录在根 `.prettierignore` 里排除：prettier 一改，它们就不再是当年写下的那份了。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DAILY_MARKER_TYPE,
  DAILY_MARKER_VERSION,
  DAILY_TEMPLATE_FILE,
  dailyFileName
} from '@shuvix/chat-protocol/dailyNotes'
import { sessionResource } from '@shuvix/chat-protocol/knowledge'
import { TRACKING_MARKER_TYPE, TRACKING_MARKER_VERSION } from '@shuvix/chat-protocol/trackingNotes'
import { BUILTIN_BOT_SEEDS, DAILY_BOT_ID, DAILY_BOT_NAME, upgradeDailyBot } from '../builtinBots'
import { BOT_FILE_MARKER, parseBotDefinitionFile, type ParsedBotFile } from '../botFile'
import { compileWhen, evaluateWhen, setWhenHostFunctions } from '../../hook/when'

const SEED = BUILTIN_BOT_SEEDS[0]
const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 随包的 `builtin:tracking` 技能（SKILL.md + 文件格式参考）在仓库里的那份：`packages/agent-runtime/src/bot/__tests__` 往上五层是仓库根 */
const trackingSkill = (lang: string): string => {
  const dir = join(HERE, '../../../../../apps/desktop/resources/skills', lang, 'tracking')
  return [
    readFileSync(join(dir, 'SKILL.md'), 'utf8'),
    readFileSync(join(dir, 'references/format.md'), 'utf8')
  ].join('\n')
}

/**
 * 新日记的那个小标题（`daily.template.done`，宿主拿它写内置模板 defaultDailyTemplate）—— 从 chat-protocol 的界面
 * 文案现读：bot 往今天的日记里补要点时，找的就是这一行
 */
const diaryHeading = (lang: string): string => {
  const locale = JSON.parse(
    readFileSync(join(HERE, '../../../../chat-protocol/src/i18n/locales', `${lang}.json`), 'utf8')
  ) as { daily: { template: { done: string } } }
  return `## ${locale.daily.template.done}`
}

/** 日记 bot 的触发条件（字面量：两边都引常量就什么都钉不住） */
const DAILY_WHEN = "event.local.time == '18:00' && activeSessions(event.local.date) > 0"

/**
 * 每种语言的期望：显示名、触发消息、两个正文标题（「我是谁」与「记忆」—— bot 用 edit 改自己的记忆时靠它们定位）、
 * 正文里「这一轮不建跟踪项」那句话；`v029` 是 v0.2.29 起那一版（日报助手）的显示名与触发消息
 */
const LANGS = {
  zh: {
    displayName: '日记助手',
    message: '看看今天的会话和昨天的日记，给我几条建议。',
    headings: ['## 我是谁', '## 记忆'],
    noTracking: '不建跟踪项',
    v029: { displayName: '日报助手', message: '整理自上次运行以来的会话，更新跟踪项。' }
  },
  en: {
    displayName: 'Diary',
    message: "Look at today's sessions and yesterday's diary, and give me a few suggestions.",
    headings: ['## Who I am', '## Memory'],
    noTracking: 'no tracked items',
    v029: {
      displayName: 'Daily',
      message: 'Go through the sessions since the last run and update the tracked items.'
    }
  },
  ja: {
    displayName: '日記',
    message: '今日のセッションと昨日の日記を見て、いくつか提案してください。',
    headings: ['## わたしは誰か', '## 記憶'],
    noTracking: '追跡項目を作らず',
    v029: {
      displayName: 'デイリー',
      message: '前回の実行以降のセッションを整理し、追跡項目を更新してください。'
    }
  }
} as const

type Lang = keyof typeof LANGS
const LANG_KEYS = Object.keys(LANGS) as Lang[]

/** 解析一种语言的渲染结果，连同全部诊断 */
const parseLang = (language: string): { parsed: ParsedBotFile | null; warns: string[] } => {
  const warns: string[] = []
  const parsed = parseBotDefinitionFile(SEED.render(language), 'seed', (m) => warns.push(m))
  return { parsed, warns }
}

afterEach(() => {
  setWhenHostFunctions({})
})

describe('BB —— 随应用提供的日记 bot', () => {
  it('BB-1 种子表恰一项：name daily、对象 id bot:builtin:daily', () => {
    expect(BUILTIN_BOT_SEEDS).toHaveLength(1)
    expect(SEED.name).toBe('daily')
    expect(SEED.objectId).toBe('bot:builtin:daily')
    expect(DAILY_BOT_NAME).toBe(SEED.name)
    expect(DAILY_BOT_ID).toBe(SEED.objectId)
  })

  it.each(LANG_KEYS)(
    'BB-2 %s 渲染：bot 解析器零告警读回，标记 bot v2、id / name / 显示名 / 一条 timer.fired 绑定齐全',
    (lang) => {
      const text = SEED.render(lang)
      expect(text.split('\n').slice(0, 3)).toEqual([
        '---',
        `shuvix: ${BOT_FILE_MARKER}`,
        `shuvix-id: ${DAILY_BOT_ID}`
      ])
      const { parsed, warns } = parseLang(lang)
      expect(warns).toEqual([])
      expect(parsed).not.toBeNull()
      expect(parsed!.name).toBe('daily')
      expect(parsed!.objectId).toBe('bot:builtin:daily')
      expect(parsed!.displayName).toBe(LANGS[lang].displayName)
      expect(parsed!.description.length).toBeGreaterThan(0)
      expect(parsed!.bindings).toStrictEqual([
        { trigger: 'timer.fired', when: DAILY_WHEN, message: LANGS[lang].message }
      ])
    }
  )

  it.each([
    ['zh-CN', 'zh'],
    ['zh_TW', 'zh'],
    ['ZH', 'zh'],
    ['ja-JP', 'ja'],
    ['en-US', 'en'],
    ['fr', 'en'],
    ['', 'en']
  ] as const)('BB-3 语言回落：%j → %s', (language, expected) => {
    expect(SEED.render(language)).toBe(SEED.render(expected))
  })

  it('BB-4 绑定条件照文档行事：语法合法；18:00 有人用过 → 真，没人用 → 假；17:59 → 假且不查宿主', () => {
    const when = parseLang('en').parsed!.bindings![0].when!
    expect(compileWhen(when)).toBeNull()
    const ctx = (time: string): Record<string, unknown> => ({
      event: {
        trigger: 'timer.fired',
        sourceId: 'timer:builtin:minute',
        firedAt: '2026-10-24T10:00:00.000Z',
        local: { date: '2026-10-24', time, weekday: 6, hour: Number(time.slice(0, 2)), minute: 0 }
      },
      env: { host: 'desktop', platform: 'darwin' }
    })

    const used = vi.fn((_date: string) => 1)
    setWhenHostFunctions({ activeSessions: used })
    expect(evaluateWhen(when, ctx('18:00'))).toBe(true)
    expect(used).toHaveBeenCalledWith('2026-10-24')

    setWhenHostFunctions({ activeSessions: () => 0 })
    expect(evaluateWhen(when, ctx('18:00'))).toBe(false)

    const early = vi.fn((_date: string) => 1)
    setWhenHostFunctions({ activeSessions: early })
    expect(evaluateWhen(when, ctx('17:59'))).toBe(false)
    expect(early).not.toHaveBeenCalled()
  })

  it.each(LANG_KEYS)(
    'BB-5 %s 正文与今天的契约对齐：list-sessions 的 active_since 取事件 local 下的 date、跳过自己的运行、read-session；昨天的日记（~/.shuvix/daily/<日期>.md）；会话链接；至多三条 suggest；这一轮不建跟踪项；采纳后写日记的小标题与 shuvix: daily v1 / _template.md；不再提 builtin:tracking 与跟踪项目录；保留「我是谁 / 记忆」两个标题',
    (lang) => {
      const { body } = parseLang(lang).parsed!
      for (const needle of [
        '`session`',
        '`list-sessions`',
        '`active_since`',
        '`local`',
        '`date`',
        'self="true"',
        '`inputs`',
        '`trigger`',
        '`read-session`',
        '~/.shuvix/daily/',
        dailyFileName('YYYY-MM-DD'),
        sessionResource(''),
        '`suggest`',
        LANGS[lang].noTracking,
        `\`${diaryHeading(lang)}\``,
        `\`shuvix: ${DAILY_MARKER_TYPE} v${DAILY_MARKER_VERSION}\``,
        `\`${DAILY_TEMPLATE_FILE}\``
      ]) {
        expect(body, `${lang}: ${needle}`).toContain(needle)
      }
      for (const gone of [
        'builtin:tracking',
        '~/.shuvix/tracking',
        'lastFiredAt',
        `shuvix: ${TRACKING_MARKER_TYPE}`
      ]) {
        expect(body, `${lang}: 不再提 ${gone}`).not.toContain(gone)
      }
      // 「三条」写在正文里（suggest 一次至多三条，正文自己也这么说）
      expect(body, `${lang}: 至多三条`).toMatch(/三|three/)
      const lines = body.split('\n')
      for (const heading of LANGS[lang].headings) {
        expect(lines, `${lang}: ${heading}`).toContain(heading)
      }
    }
  )

  it.each(LANG_KEYS)(
    'BB-5 %s builtin:tracking 技能照旧随包（日记 bot 不再加载，谁要用谁加载）：它交代的做法与今天的契约对齐（session 工具参数、事件字段、跟踪项与日记目录、格式、会话链接）',
    (lang) => {
      const skill = trackingSkill(lang)
      for (const needle of [
        'list-sessions',
        'active_since',
        'lastFiredAt',
        'self="true"',
        '`bot`',
        '`inputs`',
        '`trigger`',
        'read-session',
        'inspect-session',
        '~/.shuvix/tracking/',
        '~/.shuvix/daily/',
        '`suggest`',
        'references/format.md',
        `shuvix: ${TRACKING_MARKER_TYPE} v${TRACKING_MARKER_VERSION}`,
        sessionResource('')
      ]) {
        expect(skill, `${lang}: ${needle}`).toContain(needle)
      }
    }
  )

  it('BB-5 配套策略 daily-bot-access（三种语言）两条规则认的都是这个对象 id（种子改 id 而策略没跟，日记 bot 傍晚就会卡在询问上）', () => {
    for (const suffix of ['', '.zh', '.ja']) {
      const policy = readFileSync(
        join(HERE, `../../security/builtinPolicies/md/daily-bot-access${suffix}.md`),
        'utf8'
      )
      const ids = [...policy.matchAll(/subject\.bot == '([^']+)'/g)].map((m) => m[1])
      expect(ids, `daily-bot-access${suffix}.md`).toEqual([DAILY_BOT_ID, DAILY_BOT_ID])
    }
  })
})

// ────────────────────── 升级用到的夹具与小工具 ──────────────────────

const fixture = (version: '0.2.27' | '0.2.29', lang: Lang): string =>
  readFileSync(join(HERE, 'fixtures', `daily-v${version}.${lang}.md`), 'utf8')

/** v0.2.27 / v0.2.28 种下的那份（见文件头的来历说明） */
const legacyFixture = (lang: Lang): string => fixture('0.2.27', lang)

/** v0.2.29 起种下的那份（日报助手，正文指向 builtin:tracking） */
const v029Fixture = (lang: Lang): string => fixture('0.2.29', lang)

/** 每种语言的「每次被叫起来时」小标题（各版同一个） */
const PROCEDURE_HEADING: Record<Lang, string> = {
  zh: '## 每次被叫起来时',
  en: '## Each time I am woken up',
  ja: '## 起こされるたびに'
}

const whoHeading = (lang: Lang): string => LANGS[lang].headings[0]
const memoryHeading = (lang: Lang): string => LANGS[lang].headings[1]

/** 一节的原文：从 `heading` 那一行起，到下一个 `## ` 标题前的空行（或文末的换行）为止 */
const sectionOf = (text: string, heading: string): string => {
  const start = text.indexOf(`\n${heading}\n`) + 1
  expect(start, `找不到 ${heading}`).toBeGreaterThan(0)
  const next = text.indexOf('\n\n## ', start)
  return next < 0 ? text.slice(start).replace(/\n$/, '') : text.slice(start, next)
}

/** 把 `text` 里 `heading` 那一节整个换成 `section` */
const withSection = (text: string, heading: string, section: string): string => {
  const old = sectionOf(text, heading)
  const at = text.indexOf(old)
  return text.slice(0, at) + section + text.slice(at + old.length)
}

/** frontmatter 块（含收尾的 `---` 与换行） */
const frontmatterOf = (text: string): string => {
  const end = text.indexOf('\n---\n', 3)
  expect(end, '找不到 frontmatter 的收尾').toBeGreaterThan(0)
  return text.slice(0, end + '\n---\n'.length)
}

/** 「每次被叫起来时」一节的末尾（= 「记忆」一节前那个空行之前）的下标 */
const procedureEnd = (text: string, lang: Lang): number => {
  const at = text.indexOf(`\n\n${memoryHeading(lang)}\n`)
  expect(at, `${lang}: 找不到「记忆」一节`).toBeGreaterThan(0)
  return at
}

/** 在「每次被叫起来时」一节的末尾插一段 */
const beforeMemory = (text: string, lang: Lang, insert: string): string => {
  const at = procedureEnd(text, lang)
  return text.slice(0, at) + insert + text.slice(at)
}

/** 删掉「每次被叫起来时」一节的最后一个字符（句号） */
const dropLastProcedureChar = (text: string, lang: Lang): string => {
  const end = procedureEnd(text, lang)
  expect(['.', '。']).toContain(text[end - 1])
  return text.slice(0, end - 1) + text.slice(end)
}

/** 读回零告警，交回解析结果 */
const parseClean = (text: string): ParsedBotFile => {
  const warns: string[] = []
  const parsed = parseBotDefinitionFile(text, 'daily', (m) => warns.push(m))
  expect(warns).toEqual([])
  expect(parsed).not.toBeNull()
  return parsed!
}

// ────────────────────── BB-U：v0.2.27 / v0.2.28 种下的文件 ──────────────────────

describe('BB-U —— v0.2.27 / v0.2.28 种下的日报 bot 换上日记助手', () => {
  it.each(LANG_KEYS)(
    'BB-U0 %s 夹具就是那一版：编号步骤、维护 ~/.shuvix/tracking/、不提 builtin:tracking；与 v0.2.29 那份同一份 frontmatter 与「我是谁 / 记忆」，只有那一节不同',
    (lang) => {
      const legacy = legacyFixture(lang)
      expect(legacy).not.toBe(SEED.render(lang))
      expect(legacy).toContain(`${PROCEDURE_HEADING[lang]}\n\n1. `)
      expect(legacy).toContain('~/.shuvix/tracking/')
      expect(legacy).not.toContain('builtin:tracking')
      // 节以外逐字相同：把两边的那一节都挖掉，剩下的应当一致
      const cut = (text: string): string => {
        const start = text.indexOf(`${PROCEDURE_HEADING[lang]}\n`)
        const end = text.indexOf(`\n\n${memoryHeading(lang)}\n`)
        expect(start, lang).toBeGreaterThan(0)
        expect(end, lang).toBeGreaterThan(start)
        return text.slice(0, start) + text.slice(end)
      }
      expect(cut(legacy)).toBe(cut(v029Fixture(lang)))
      expect(sectionOf(legacy, PROCEDURE_HEADING[lang])).not.toBe(
        sectionOf(v029Fixture(lang), PROCEDURE_HEADING[lang])
      )
    }
  )

  it.each(LANG_KEYS)('BB-U1 %s 旧版原样 → 升级结果与今天这种语言的种子逐字节相同', (lang) => {
    expect(upgradeDailyBot(legacyFixture(lang))).toBe(SEED.render(lang))
  })

  it.each(LANG_KEYS)(
    'BB-U2 %s 已经是新版 → null；升级过一次的再升级 → null（每次启动都调，不能一直写）',
    (lang) => {
      expect(upgradeDailyBot(SEED.render(lang))).toBeNull()
      const once = upgradeDailyBot(legacyFixture(lang))
      expect(once).not.toBeNull()
      expect(upgradeDailyBot(once!)).toBeNull()
    }
  )

  it.each(LANG_KEYS)(
    'BB-U3 %s 用户改过显示名、在「记忆」末尾记了偏好：两处改动逐字节保留（「记忆」一节整节不换，连当初的占位一起留着），其余换成日记助手；读回零告警，id 与触发条件不变、触发消息换新',
    (lang) => {
      const edit = (text: string): string => {
        const renamed = text.replace(/^shuvix-displayName: .*$/m, 'shuvix-displayName: 我的 Daily')
        expect(renamed, lang).not.toBe(text)
        expect(renamed.endsWith('\n'), lang).toBe(true)
        return `${renamed}- 发版杂事不用跟踪。\n- Write progress in one line.\n`
      }
      const legacy = legacyFixture(lang)
      const edited = edit(legacy)
      const upgraded = upgradeDailyBot(edited)
      expect(upgraded).toBe(
        edit(
          withSection(
            SEED.render(lang),
            memoryHeading(lang),
            sectionOf(legacy, memoryHeading(lang))
          )
        )
      )

      const parsed = parseClean(upgraded!)
      expect(parsed.displayName).toBe('我的 Daily')
      expect(parsed.objectId).toBe(DAILY_BOT_ID)
      expect(parsed.name).toBe(DAILY_BOT_NAME)
      const before = parseBotDefinitionFile(edited, 'daily', () => {})!
      expect(parsed.bindings).toStrictEqual([
        { trigger: 'timer.fired', when: DAILY_WHEN, message: LANGS[lang].message }
      ])
      expect(before.bindings!.map((b) => [b.trigger, b.when])).toEqual([
        ['timer.fired', DAILY_WHEN]
      ])
      expect(parsed.body).toContain('`list-sessions`')
      expect(parsed.body).not.toContain('~/.shuvix/tracking/')
      expect(parsed.body).toContain(sectionOf(SEED.render(lang), whoHeading(lang)))
      expect(parsed.body).toContain('- 发版杂事不用跟踪。\n- Write progress in one line.')
    }
  )

  it.each(LANG_KEYS)(
    'BB-U3b %s 用户删掉了「记忆」一节、那一节成了文末：照换（「后面是文末」也算整节），前面一字不动',
    (lang) => {
      const drop = (text: string): string => {
        const at = text.indexOf(`\n\n${LANGS[lang].headings[1]}\n`)
        expect(at, lang).toBeGreaterThan(0)
        return `${text.slice(0, at)}\n`
      }
      expect(upgradeDailyBot(drop(legacyFixture(lang)))).toBe(drop(SEED.render(lang)))
    }
  )

  it.each(LANG_KEYS)(
    'BB-U4 %s 那一节里改了一个字符（替换 / 删除）→ null：步骤是门，用户改过步骤就整份不动（不拼出「人设只提建议、步骤还写跟踪项」的 bot）',
    (lang) => {
      const legacy = legacyFixture(lang)
      const replaced = legacy.replace('read-session', 'read_session')
      expect(replaced).not.toBe(legacy)
      expect(replaced.length).toBe(legacy.length)

      // 删掉第 4 步末尾的句号（这一节的最后一个字符）
      const deleted = dropLastProcedureChar(legacy, lang)
      expect(deleted.length).toBe(legacy.length - 1)

      for (const [label, text] of Object.entries({ replaced, deleted })) {
        expect(upgradeDailyBot(text), `${lang} ${label}`).toBeNull()
      }
    }
  )

  it.each(LANG_KEYS)(
    'BB-U5 %s 节里多写了东西或标题换了级别 → null：第 4 步后加一行「5. …」、第 4 步同一行后面接着写、标题改成 ###，都算改过步骤，整份不动',
    (lang) => {
      const legacy = legacyFixture(lang)
      const variants: Record<string, string> = {
        fifthStep: beforeMemory(legacy, lang, '\n5. 也看一眼日记。'),
        sameLine: beforeMemory(legacy, lang, ' Also mention the diary.')
      }
      for (const [label, text] of Object.entries(variants)) {
        expect(text, `${lang} ${label}`).not.toBe(legacy)
        expect(upgradeDailyBot(text), `${lang} ${label}`).toBeNull()
      }

      const h3 = legacy.replace(`${PROCEDURE_HEADING[lang]}\n`, `#${PROCEDURE_HEADING[lang]}\n`)
      expect(h3).not.toBe(legacy)
      expect(upgradeDailyBot(h3)).toBeNull()
    }
  )

  it.each(LANG_KEYS)('BB-U6 %s CRLF 换行的副本 → null（逐字匹配，不做换行归一）', (lang) => {
    const crlf = legacyFixture(lang).replace(/\n/g, '\r\n')
    expect(upgradeDailyBot(crlf)).toBeNull()
  })

  it('BB-U7 不是日报 bot 的 md、空串 → null；种子的 upgrade 就是 upgradeDailyBot', () => {
    const other = [
      '---',
      'shuvix: bot v2',
      'name: scout',
      '---',
      '',
      '## Who I am',
      '',
      'A scout.',
      ''
    ].join('\n')
    expect(upgradeDailyBot(other)).toBeNull()
    expect(upgradeDailyBot('')).toBeNull()
    expect(SEED.upgrade).toBe(upgradeDailyBot)
  })
})

// ────────────────────── BB-V：v0.2.29 起种下的文件 ──────────────────────

describe('BB-V —— v0.2.29 起种下的日报助手（指向 builtin:tracking）换上日记助手', () => {
  it.each(LANG_KEYS)(
    'BB-V0 %s 夹具就是那一版：零告警读回、同一个 id 与触发条件、日报助手的显示名与消息、正文指向 builtin:tracking；与今天的种子相比 frontmatter 只差显示名 / 说明 / 消息三行，三节正文都不同',
    (lang) => {
      const v029 = v029Fixture(lang)
      const render = SEED.render(lang)
      expect(v029).not.toBe(render)
      const parsed = parseClean(v029)
      expect(parsed.objectId).toBe(DAILY_BOT_ID)
      expect(parsed.name).toBe(DAILY_BOT_NAME)
      expect(parsed.displayName).toBe(LANGS[lang].v029.displayName)
      expect(parsed.bindings).toStrictEqual([
        { trigger: 'timer.fired', when: DAILY_WHEN, message: LANGS[lang].v029.message }
      ])
      expect(parsed.body).toContain('`builtin:tracking`')
      expect(parsed.body).toContain('`suggest`')

      const a = frontmatterOf(v029).split('\n')
      const b = frontmatterOf(render).split('\n')
      expect(a.length).toBe(b.length)
      const differing = a
        .filter((line, i) => line !== b[i])
        .map((line) => line.trim().split(':')[0])
      expect(differing).toEqual(['shuvix-displayName', 'description', 'message'])
      for (const heading of [whoHeading(lang), PROCEDURE_HEADING[lang], memoryHeading(lang)]) {
        expect(sectionOf(v029, heading), `${lang} ${heading}`).not.toBe(sectionOf(render, heading))
      }
    }
  )

  it.each(LANG_KEYS)(
    'BB-V1 %s 原样 → 升级结果与今天这种语言的种子逐字节相同；再升级 → null',
    (lang) => {
      const once = upgradeDailyBot(v029Fixture(lang))
      expect(once).toBe(SEED.render(lang))
      expect(upgradeDailyBot(once!)).toBeNull()
    }
  )

  it.each(LANG_KEYS)(
    'BB-V2 %s 用户改过显示名、bot 把「记忆」的占位换成了记下的偏好：两处逐字节保留，其余（说明、触发消息、「我是谁」「每次被叫起来时」）换成日记助手；读回零告警，id 与触发条件不变',
    (lang) => {
      const memory = `${memoryHeading(lang)}\n\n- 回答尽量一行。\n- Release chores are not worth bringing up.`
      const edit = (text: string): string => {
        const renamed = text.replace(/^shuvix-displayName: .*$/m, 'shuvix-displayName: 我的日记')
        expect(renamed, lang).not.toBe(text)
        return withSection(renamed, memoryHeading(lang), memory)
      }
      const edited = edit(v029Fixture(lang))
      expect(edited).toContain(memory)
      const upgraded = upgradeDailyBot(edited)
      expect(upgraded).toBe(edit(SEED.render(lang)))

      const parsed = parseClean(upgraded!)
      expect(parsed.displayName).toBe('我的日记')
      expect(parsed.objectId).toBe(DAILY_BOT_ID)
      expect(parsed.name).toBe(DAILY_BOT_NAME)
      expect(parsed.bindings).toStrictEqual([
        { trigger: 'timer.fired', when: DAILY_WHEN, message: LANGS[lang].message }
      ])
      expect(parsed.body).toContain(memory)
      expect(parsed.body).toContain('`list-sessions`')
      expect(parsed.body).not.toContain('builtin:tracking')
      expect(upgradeDailyBot(upgraded!)).toBeNull()
    }
  )

  it.each(LANG_KEYS)(
    'BB-V3 %s 那一节里改了一个字符（替换 / 删除）→ null：步骤改过，显示名、「我是谁」「记忆」也都留着旧版',
    (lang) => {
      const v029 = v029Fixture(lang)
      const replaced = v029.replace('`suggest`', '`Suggest`')
      expect(replaced).not.toBe(v029)
      expect(replaced.length).toBe(v029.length)
      const deleted = dropLastProcedureChar(v029, lang)
      expect(deleted.length).toBe(v029.length - 1)

      for (const [label, text] of Object.entries({ replaced, deleted })) {
        expect(upgradeDailyBot(text), `${lang} ${label}`).toBeNull()
      }
    }
  )

  it.each(LANG_KEYS)(
    'BB-V4 %s 用户把触发时间改成 07:30：when 那一行不碰，其余照换成日记助手',
    (lang) => {
      const retime = (text: string): string => {
        const next = text.replace("event.local.time == '18:00'", "event.local.time == '07:30'")
        expect(next, lang).not.toBe(text)
        return next
      }
      const upgraded = upgradeDailyBot(retime(v029Fixture(lang)))
      expect(upgraded).toBe(retime(SEED.render(lang)))
      expect(parseClean(upgraded!).bindings![0].when).toContain("'07:30'")
    }
  )

  it.each(LANG_KEYS)('BB-V5 %s CRLF 换行的副本 → null（逐字匹配，不做换行归一）', (lang) => {
    expect(upgradeDailyBot(v029Fixture(lang).replace(/\n/g, '\r\n'))).toBeNull()
  })
})
