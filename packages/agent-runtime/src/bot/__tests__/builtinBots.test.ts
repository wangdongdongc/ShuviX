/**
 * 随应用提供的 bot（builtinBots.ts）—— 今天只有日报 bot `daily`。
 *
 * 它不在应用包里现读：第一次启动时由宿主按界面语言写进 `~/.shuvix/bots/`（桌面 botService 的 seedBuiltinBots），
 * 之后就是一份普通 bot 文件。所以这里钉的是「写下去的那份 md」本身：三种语言都必须被 bot 解析器零告警地读回来、
 * 带着恒定的对象 id（配套策略 daily-bot-access 按它认人）、带着那条每天 18:00 的触发绑定。整理跟踪项的做法
 * 自 2026-10-25 不在正文里，而在随包的 `builtin:tracking` 技能里（种下的文件只写一次，规则得能随版本更新）：
 * 正文只指路，技能里交代的做法必须与今天的真实契约对得上（session 工具的 list-sessions 参数、事件围栏的字段、
 * 跟踪项目录与格式、日记目录、会话链接、suggest）—— 这些字面量一改，技能就成了过期指令，没有别的测试会响。
 *
 * 分组：BB-1 种子表 · BB-2 三语渲染可解析 · BB-3 语言回落 · BB-4 绑定条件求值 · BB-5 正文与契约对齐 ·
 * BB-U 已种下文件的升级（`upgradeDailyBot`）
 *
 * BB-U 的输入是 `fixtures/daily-v0.2.27.{zh,en,ja}.md`：v0.2.27 真正种下去的那三份文件，逐字节。生成方式（只生成一次，
 * 之后不许再改 —— 它们代表的是「用户盘上已经有的东西」，跟着今天的源码重生就什么都钉不住了）：用 jiti 加载
 * `git show v0.2.27:packages/agent-runtime/src/bot/builtinBots.ts`，对 zh / en / ja 各调一次
 * `BUILTIN_BOT_SEEDS[0].render(lang)` 原样写盘。v0.2.28 的种子源码与 v0.2.27 逐字节相同（渲染结果同样逐字节相同），
 * 所以这三份同时代表两个版本。目录在根 `.prettierignore` 里排除：prettier 一改，它们就不再是当年写下的那份了。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionResource } from '@shuvix/chat-protocol/knowledge'
import { TRACKING_MARKER_TYPE, TRACKING_MARKER_VERSION } from '@shuvix/chat-protocol/trackingNotes'
import { BUILTIN_BOT_SEEDS, DAILY_BOT_ID, DAILY_BOT_NAME, upgradeDailyBot } from '../builtinBots'
import { BOT_FILE_MARKER, parseBotDefinitionFile, type ParsedBotFile } from '../botFile'
import { compileWhen, evaluateWhen, setWhenHostFunctions } from '../../hook/when'

const SEED = BUILTIN_BOT_SEEDS[0]

/** 随包的 `builtin:tracking` 技能（SKILL.md + 文件格式参考）在仓库里的那份：`packages/agent-runtime/src/bot/__tests__` 往上五层是仓库根 */
const trackingSkill = (lang: string): string => {
  const dir = join(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../../../../apps/desktop/resources/skills',
    lang,
    'tracking'
  )
  return [
    readFileSync(join(dir, 'SKILL.md'), 'utf8'),
    readFileSync(join(dir, 'references/format.md'), 'utf8')
  ].join('\n')
}

/** 日报 bot 的触发条件（字面量：两边都引常量就什么都钉不住） */
const DAILY_WHEN = "event.local.time == '18:00' && activeSessions(event.local.date) > 0"

/** 每种语言的期望：显示名 + 两个正文标题（「我是谁」与「记忆」—— bot 用 edit 改自己的记忆时靠它们定位） */
const LANGS = {
  zh: {
    displayName: '日报助手',
    message: '整理自上次运行以来的会话，更新跟踪项。',
    headings: ['## 我是谁', '## 记忆']
  },
  en: {
    displayName: 'Daily',
    message: 'Go through the sessions since the last run and update the tracked items.',
    headings: ['## Who I am', '## Memory']
  },
  ja: {
    displayName: 'デイリー',
    message: '前回の実行以降のセッションを整理し、追跡項目を更新してください。',
    headings: ['## わたしは誰か', '## 記憶']
  }
} as const

type Lang = keyof typeof LANGS

/** 解析一种语言的渲染结果，连同全部诊断 */
const parseLang = (language: string): { parsed: ParsedBotFile | null; warns: string[] } => {
  const warns: string[] = []
  const parsed = parseBotDefinitionFile(SEED.render(language), 'seed', (m) => warns.push(m))
  return { parsed, warns }
}

afterEach(() => {
  setWhenHostFunctions({})
})

describe('BB —— 随应用提供的日报 bot', () => {
  it('BB-1 种子表恰一项：name daily、对象 id bot:builtin:daily', () => {
    expect(BUILTIN_BOT_SEEDS).toHaveLength(1)
    expect(SEED.name).toBe('daily')
    expect(SEED.objectId).toBe('bot:builtin:daily')
    expect(DAILY_BOT_NAME).toBe(SEED.name)
    expect(DAILY_BOT_ID).toBe(SEED.objectId)
  })

  it.each(Object.keys(LANGS) as Lang[])(
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

  it.each(Object.keys(LANGS) as Lang[])(
    'BB-5 %s 正文指向 builtin:tracking 技能（并点名 suggest），技能与今天的契约对齐（session 工具参数、事件字段、跟踪项与日记目录、格式、会话链接）；保留「我是谁 / 记忆」两个标题',
    (lang) => {
      const { body } = parseLang(lang).parsed!
      expect(body, `${lang}: 正文指路`).toContain('`builtin:tracking`')
      expect(body, `${lang}: 正文点名 suggest`).toContain('`suggest`')
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
      const lines = body.split('\n')
      for (const heading of LANGS[lang].headings) {
        expect(lines, `${lang}: ${heading}`).toContain(heading)
      }
    }
  )

  it('BB-5 配套策略 daily-bot-access 认的就是这个对象 id（种子改 id 而策略没跟，日报 bot 傍晚就会卡在询问上）', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const policy = readFileSync(
      join(here, '../../security/builtinPolicies/md/daily-bot-access.md'),
      'utf8'
    )
    const ids = [...policy.matchAll(/subject\.bot == '([^']+)'/g)].map((m) => m[1])
    expect(ids).toEqual([DAILY_BOT_ID, DAILY_BOT_ID, DAILY_BOT_ID])
  })
})

// ────────────────────── BB-U：已种下文件的升级 ──────────────────────

/** v0.2.27 种下的那份（见文件头的来历说明） */
const legacyFixture = (lang: Lang): string =>
  readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', `daily-v0.2.27.${lang}.md`),
    'utf8'
  )

/** 每种语言的「每次被叫起来时」小标题（新旧两版同一个） */
const PROCEDURE_HEADING: Record<Lang, string> = {
  zh: '## 每次被叫起来时',
  en: '## Each time I am woken up',
  ja: '## 起こされるたびに'
}

/** 「每次被叫起来时」一节的末尾（= 「记忆」一节前那个空行之前）的下标 */
const procedureEnd = (text: string, lang: Lang): number => {
  const at = text.indexOf(`\n\n${LANGS[lang].headings[1]}\n`)
  expect(at, `${lang}: 找不到「记忆」一节`).toBeGreaterThan(0)
  return at
}

/** 在「每次被叫起来时」一节的末尾插一段 */
const beforeMemory = (text: string, lang: Lang, insert: string): string => {
  const at = procedureEnd(text, lang)
  return text.slice(0, at) + insert + text.slice(at)
}

describe('BB-U —— 已经种下的日报 bot 换上新版「每次被叫起来时」', () => {
  const LANG_KEYS = Object.keys(LANGS) as Lang[]

  it.each(LANG_KEYS)(
    'BB-U0 %s 夹具就是旧版：与今天的种子同一份 frontmatter 与「我是谁 / 记忆」，只有那一节不同（旧版是编号步骤）',
    (lang) => {
      const legacy = legacyFixture(lang)
      const current = SEED.render(lang)
      expect(legacy).not.toBe(current)
      expect(legacy).toContain(`${PROCEDURE_HEADING[lang]}\n\n1. `)
      expect(legacy).not.toContain('builtin:tracking')
      // 节以外逐字相同：把两边的那一节都挖掉，剩下的应当一致
      const cut = (text: string): string => {
        const start = text.indexOf(`${PROCEDURE_HEADING[lang]}\n`)
        const end = text.indexOf(`\n\n${LANGS[lang].headings[1]}\n`)
        expect(start, lang).toBeGreaterThan(0)
        expect(end, lang).toBeGreaterThan(start)
        return text.slice(0, start) + text.slice(end)
      }
      expect(cut(legacy)).toBe(cut(current))
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
    'BB-U3 %s 用户改过显示名、在「记忆」里记了偏好：两处改动逐字节保留，只换那一节；读回零告警，id 与绑定不变',
    (lang) => {
      const edit = (text: string): string => {
        const renamed = text.replace(/^shuvix-displayName: .*$/m, 'shuvix-displayName: 我的 Daily')
        expect(renamed, lang).not.toBe(text)
        expect(renamed.endsWith('\n'), lang).toBe(true)
        return `${renamed}- 发版杂事不用跟踪。\n- Write progress in one line.\n`
      }
      const edited = edit(legacyFixture(lang))
      const upgraded = upgradeDailyBot(edited)
      expect(upgraded).toBe(edit(SEED.render(lang)))

      const warns: string[] = []
      const parsed = parseBotDefinitionFile(upgraded!, 'daily', (m) => warns.push(m))
      expect(warns).toEqual([])
      expect(parsed!.displayName).toBe('我的 Daily')
      expect(parsed!.objectId).toBe(DAILY_BOT_ID)
      expect(parsed!.name).toBe(DAILY_BOT_NAME)
      const before = parseBotDefinitionFile(edited, 'daily', () => {})!
      expect(parsed!.bindings).toStrictEqual(before.bindings)
      expect(parsed!.body).toContain('`builtin:tracking`')
      expect(parsed!.body).toContain('- 发版杂事不用跟踪。\n- Write progress in one line.')
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

  it.each(LANG_KEYS)('BB-U4 %s 那一节里改了一个字符（替换 / 删除）→ null', (lang) => {
    const legacy = legacyFixture(lang)
    const replaced = legacy.replace('read-session', 'read_session')
    expect(replaced).not.toBe(legacy)
    expect(replaced.length).toBe(legacy.length)
    expect(upgradeDailyBot(replaced)).toBeNull()

    // 删掉第 4 步末尾的句号（这一节的最后一个字符）
    const end = procedureEnd(legacy, lang)
    expect(['.', '。']).toContain(legacy[end - 1])
    const deleted = legacy.slice(0, end - 1) + legacy.slice(end)
    expect(deleted.length).toBe(legacy.length - 1)
    expect(upgradeDailyBot(deleted)).toBeNull()
  })

  it.each(LANG_KEYS)(
    'BB-U5 %s 节里多写了东西或标题换了级别 → null：第 4 步后加一行「5. …」、第 4 步同一行后面接着写、标题改成 ###',
    (lang) => {
      const legacy = legacyFixture(lang)
      const variants: Record<string, string> = {
        fifthStep: beforeMemory(legacy, lang, '\n5. 也看一眼日记。'),
        sameLine: beforeMemory(legacy, lang, ' Also mention the diary.'),
        h3: legacy.replace(`${PROCEDURE_HEADING[lang]}\n`, `#${PROCEDURE_HEADING[lang]}\n`)
      }
      for (const [label, text] of Object.entries(variants)) {
        expect(text, `${lang} ${label}`).not.toBe(legacy)
        expect(upgradeDailyBot(text), `${lang} ${label}`).toBeNull()
      }
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
