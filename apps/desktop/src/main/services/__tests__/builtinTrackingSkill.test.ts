/**
 * SK —— 内置技能 `builtin:tracking`（跟踪项的整理手艺，`apps/desktop/resources/skills/<lang>/tracking/`）与真实契约对齐。
 *
 * 种下的日报 bot 文件只写一次，所以 2026-10-25 起「怎么整理跟踪项」不在 bot 正文里，而在这份随版本更新的技能里；
 * 正文只说「先加载它」。技能里写的是模型照着做的指令：点名的工具、字段、文件格式、目录与文件名一旦和代码对不上，
 * 模型就照着一份过期的说明去调一个不存在的参数 —— 没有别的测试会响（builtinSkillsResources 只管资源在不在场、
 * 不看措辞；builtinBots BB-5 只认几个字面量在不在）。所以这里把技能里那几处**可机读**的东西逐一对上代码：
 *
 *   SK-1 format.md 的范例：frontmatter 就是 `shuvix: track v1`，侧栏取到的标题（trackingTitle）就是范例里的 `#` 标题；
 *        范例文件名是一个合法的跟踪项文件名
 *   SK-2 技能点名的工具（session / suggest / write / ls）都在 bot 基座三种语言的工具表里（技能本身也在）
 *   SK-3 技能点名的 suggest 字段（title / detail / message）= suggest 工具 schema 里一条提议的键
 *   SK-4 日记文件名 `YYYY-MM-DD.md` 与 dailyFileName / isDayKey / dayOfDailyFile 一致；技能写的两个目录就是宿主的
 *        getDefaultDailyDir / getDefaultTrackingDir
 *
 * 读的是仓库里的真实文件，路径从 `import.meta.url` 往上找仓库根（同 builtinSkillsResources.test.ts 的做法与理由）。
 * ja 目前是 en 的逐字副本（BS-12 钉），这里照样三语各跑一遍。
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { SuggestParamsSchema } from '@shuvix/agent-runtime'
import {
  TRACKING_MARKER_TYPE,
  TRACKING_MARKER_VERSION,
  isTrackingFileName,
  trackingTitle
} from '@shuvix/chat-protocol/trackingNotes'
import { dailyFileName, dayOfDailyFile, isDayKey } from '@shuvix/chat-protocol/dailyNotes'

// utils/paths 顶层 import 了 electron：换成一个不碰真 userData 的壳（这里只问家目录下的两个目录）
vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-userData', isPackaged: false, getAppPath: () => '/' }
}))

import { getDefaultDailyDir, getDefaultTrackingDir } from '../../utils/paths'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/services/__tests__` 往上六层 */
const REPO_ROOT = resolve(HERE, '../../../../../..')
const SKILL_DIR = (lang: string): string =>
  join(REPO_ROOT, 'apps/desktop/resources/skills', lang, 'tracking')
const skillMd = (lang: string): string => readFileSync(join(SKILL_DIR(lang), 'SKILL.md'), 'utf8')
const formatMd = (lang: string): string =>
  readFileSync(join(SKILL_DIR(lang), 'references/format.md'), 'utf8')

/** bot 基座档案的三种语言（`bot.md` 是 en） */
const BOT_MD: Record<string, string> = {
  en: 'bot.md',
  zh: 'bot.zh.md',
  ja: 'bot.ja.md'
}
const botTools = (lang: string): string[] => {
  const text = readFileSync(
    join(REPO_ROOT, 'packages/agent-runtime/src/subagent/builtinAgents/md', BOT_MD[lang]),
    'utf8'
  )
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  expect(m, `${BOT_MD[lang]}: 没有 frontmatter`).not.toBeNull()
  const fm = parseYaml(m![1]) as Record<string, unknown>
  expect(typeof fm['shuvix-tools'], BOT_MD[lang]).toBe('string')
  return (fm['shuvix-tools'] as string).split(',').map((t) => t.trim())
}

const LANGS = ['zh', 'en', 'ja'] as const

/** 技能点名的工具（手维护：技能里多点了一个工具，就加进来 —— SK-2 先验证每一个确实被点名） */
const TOOLS_NAMED = ['session', 'suggest', 'write', 'ls'] as const

describe('SK —— builtin:tracking 技能与真实契约对齐', () => {
  it.each(LANGS)(
    'SK-1 %s：format.md 的范例 frontmatter 只有 `shuvix: track v1`，trackingTitle 取到的就是范例的 # 标题；范例文件名合法',
    (lang) => {
      const text = formatMd(lang)
      const m = /```markdown\n([\s\S]*?)\n```/.exec(text)
      expect(m, `${lang}: format.md 里没有 \`\`\`markdown 范例`).not.toBeNull()
      const example = `${m![1]}\n`
      const marker = `shuvix: ${TRACKING_MARKER_TYPE} v${TRACKING_MARKER_VERSION}`
      expect(marker).toBe('shuvix: track v1')
      expect(example.split('\n').slice(0, 3)).toEqual(['---', marker, '---'])

      const heading = /^# (.+)$/m.exec(example)
      expect(heading, `${lang}: 范例里没有 # 标题`).not.toBeNull()
      const title = trackingTitle(example, 'example.md')
      expect(title).toBe(heading![1].trim())
      expect(title).not.toBe('example')

      // 「文件名怎么起」那一条给的例子
      const names = [...text.matchAll(/`([\w.-]+\.md)`/g)].map((x) => x[1])
      expect(names, `${lang}: 没有范例文件名`).toContain('waiting-li-migration.md')
      for (const name of names) expect(isTrackingFileName(name), name).toBe(true)
    }
  )

  it.each(LANGS)(
    'SK-2 %s：技能点名的工具都在 bot 基座的工具表里（session / suggest / write / ls），技能本身也在',
    (lang) => {
      const text = skillMd(lang)
      const tools = botTools(lang)
      for (const tool of TOOLS_NAMED) {
        // 点名的写法：`session` 工具、`suggest`、`write`、`ls ~/.shuvix/tracking/`
        expect(text, `${lang}: 技能没点名 ${tool}（TOOLS_NAMED 过期了）`).toMatch(
          new RegExp('`' + tool + '[` ]')
        )
        expect(tools, `${lang}: bot 基座缺 ${tool}`).toContain(tool)
      }
      expect(tools).toContain('skill:builtin:tracking')
    }
  )

  it.each(LANGS)(
    'SK-3 %s：技能点名的 suggest 字段 = suggest 工具 schema 里一条提议的键（title / detail / message）',
    (lang) => {
      const text = skillMd(lang)
      // 「提议」那一条下面缩进的三行：`  - \`title\`：…`
      const fields = [...text.matchAll(/^\s+- `(\w+)`[:：]/gm)].map((x) => x[1])
      expect(fields.length, `${lang}: 没找到 suggest 字段`).toBeGreaterThan(0)
      const schema = SuggestParamsSchema as unknown as {
        properties: { suggestions: { items: { properties: Record<string, unknown> } } }
      }
      const keys = Object.keys(schema.properties.suggestions.items.properties)
      expect([...fields].sort()).toEqual([...keys].sort())
      expect([...keys].sort()).toEqual(['detail', 'message', 'title'])
    }
  )

  it.each(LANGS)(
    'SK-4 %s：日记文件名 YYYY-MM-DD.md 与 dailyFileName / isDayKey 一致；两个目录就是宿主的日记与跟踪项目录',
    (lang) => {
      const text = skillMd(lang)
      expect(text).toContain('`YYYY-MM-DD.md`')
      const shape = new RegExp(
        '^' +
          'YYYY-MM-DD.md'
            .replace('YYYY', '\\d{4}')
            .replace('MM', '\\d{2}')
            .replace('DD', '\\d{2}')
            .replace('.md', '\\.md') +
          '$'
      )
      for (const day of ['2026-01-05', '2026-10-24', '2024-02-29']) {
        expect(isDayKey(day), day).toBe(true)
        expect(dailyFileName(day), day).toMatch(shape)
        expect(dayOfDailyFile(dailyFileName(day)), day).toBe(day)
      }

      const expand = (dir: string): string => join(homedir(), dir.replace(/^~\//, ''))
      expect(text).toContain('`~/.shuvix/daily/`')
      expect(text).toContain('~/.shuvix/tracking/')
      expect(getDefaultDailyDir()).toBe(expand('~/.shuvix/daily'))
      expect(getDefaultTrackingDir()).toBe(expand('~/.shuvix/tracking'))
    }
  )
})
