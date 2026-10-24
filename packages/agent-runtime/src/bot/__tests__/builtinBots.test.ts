/**
 * 随应用提供的 bot（builtinBots.ts）—— 今天只有日报 bot `daily`。
 *
 * 它不在应用包里现读：第一次启动时由宿主按界面语言写进 `~/.shuvix/bots/`（桌面 botService 的 seedBuiltinBots），
 * 之后就是一份普通 bot 文件。所以这里钉的是「写下去的那份 md」本身：三种语言都必须被 bot 解析器零告警地读回来、
 * 带着恒定的对象 id（配套策略 daily-bot-access 按它认人）、带着那条每天 18:00 的触发绑定；正文里交代的做法
 * 必须与今天的真实契约对得上（session 工具的 list-sessions 参数、事件围栏的字段、跟踪项目录与格式、会话链接）——
 * 这些字面量一改，种子里的说明就成了过期指令，没有别的测试会响。
 *
 * 分组：BB-1 种子表 · BB-2 三语渲染可解析 · BB-3 语言回落 · BB-4 绑定条件求值 · BB-5 正文与契约对齐
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionResource } from '@shuvix/chat-protocol/knowledge'
import { TRACKING_MARKER_TYPE, TRACKING_MARKER_VERSION } from '@shuvix/chat-protocol/trackingNotes'
import { BUILTIN_BOT_SEEDS, DAILY_BOT_ID, DAILY_BOT_NAME } from '../builtinBots'
import { BOT_FILE_MARKER, parseBotDefinitionFile, type ParsedBotFile } from '../botFile'
import { compileWhen, evaluateWhen, setWhenHostFunctions } from '../../hook/when'

const SEED = BUILTIN_BOT_SEEDS[0]

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
    'BB-5 %s 正文与今天的契约对齐（session 工具参数、事件字段、跟踪项目录与格式、会话链接）；保留「我是谁 / 记忆」两个标题',
    (lang) => {
      const { body } = parseLang(lang).parsed!
      for (const needle of [
        'list-sessions',
        'active_since',
        'lastFiredAt',
        'self="true"',
        `bot="${DAILY_BOT_ID}"`,
        '`inputs`',
        '`trigger`',
        'read-session',
        'inspect-session',
        '~/.shuvix/tracking/',
        `shuvix: ${TRACKING_MARKER_TYPE} v${TRACKING_MARKER_VERSION}`,
        sessionResource('')
      ]) {
        expect(body, `${lang}: ${needle}`).toContain(needle)
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
    expect(ids).toEqual([DAILY_BOT_ID, DAILY_BOT_ID])
  })
})
