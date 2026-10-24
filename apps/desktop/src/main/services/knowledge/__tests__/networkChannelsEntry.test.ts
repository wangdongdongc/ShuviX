/**
 * 内置知识库的 `network-channels` 条目（远程访问策略的通道清单，2026-10-19；按 scope 分节，2026-10-23）—— 三种语言的
 * 清单逐字相同，且恰是通道表此刻的样子：每条请求通道都在、归在它的 scope 下、标着 `channelAccess.ts` 给它的访问级别；
 * 每节另列它含的分组（`object.group`）、HTTP 路由、按 key 定的设置项。没有多余的。
 * 清单夹在 `<!-- channels:begin -->` 与 `<!-- channels:end -->` 之间；改了通道表或标签，这里先红 ——
 * `NETWORK_CHANNELS_WRITE=1` 跑一次本文件按通道表重写三份清单。
 *
 *   NCE-1 三种语言的清单 = 按通道表生成的那一份（逐字）
 *   NCE-2 生成的清单在 read / write / admin 行里覆盖 CHANNEL_ACCESS 的每一条、每条恰出现一次；每个 scope 一节
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_ACCESS,
  CHANNEL_SCOPES,
  SETTING_KEY_FACTS,
  channelCallFactsOf,
  channelGroupOf,
  channelScopeOf,
  type ChannelAccess
} from '../../../../shared/channelAccess'
import { requestFactsOf, type RequestRoute } from '../../../frontend/network/policyGate'

const DIR = join(__dirname, '../../../../../resources/knowledge/shuvix')
const BEGIN = '<!-- channels:begin -->'
const END = '<!-- channels:end -->'
const ORDER: ChannelAccess[] = ['read', 'write', 'admin']
const ROUTES: RequestRoute[] = [
  'page',
  'asset',
  'lib',
  'socket',
  'media',
  'preview',
  'download',
  'widget'
]
const code = (items: string[]): string => items.map((item) => `\`${item}\``).join(', ')

/**
 * 按通道表生成的清单：scope 按词表的先后，每节依次是分组、HTTP 路由、read / write / admin 各一行（通道按字母）、
 * 按 key 定的设置项（前缀写成 `x.*`），以及按这一次调用定的例外
 */
function generated(): string {
  const remember = [{ response: { extra: { remember: true } } }]
  const out: string[] = []
  for (const scope of CHANNEL_SCOPES) {
    const channels = Object.keys(CHANNEL_ACCESS).filter((c) => channelScopeOf(c) === scope)
    const groups = [...new Set(channels.map((c) => channelGroupOf(c) || c.split(':')[0]))].sort()
    const routes = ROUTES.filter((route) => requestFactsOf(route, 'GET').scope === scope)
    out.push(`### \`${scope}\``, '')
    if (groups.length > 0) out.push(`- group: ${code(groups)}`)
    if (routes.length > 0) out.push(`- route: ${code(routes)}`)
    for (const access of ORDER) {
      const list = channels.filter((c) => CHANNEL_ACCESS[c] === access).sort()
      if (list.length > 0) out.push(`- ${access}: ${code(list)}`)
    }
    for (const access of ORDER) {
      const keys = Object.entries(SETTING_KEY_FACTS)
        .filter(([, facts]) => facts.scope === scope && facts.access === access)
        .map(([key]) => (key.endsWith('.') ? `${key}*` : key))
        .sort()
      if (keys.length > 0) out.push(`- \`settings:set\` ${access}: ${code(keys)}`)
    }
    const answer = channelCallFactsOf('agent:respondToInput', remember)
    if (answer.scope === scope) {
      out.push(`- \`agent:respondToInput\` + \`remember\`: ${answer.access}`)
    }
    out.push('')
  }
  return out.join('\n').trimEnd()
}

function sectionOf(text: string): string | undefined {
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (start < 0 || end < start) return undefined
  return text.slice(start + BEGIN.length, end).trim()
}

const LANGS = ['en', 'zh', 'ja'] as const

describe('network-channels 条目', () => {
  if (process.env.NETWORK_CHANNELS_WRITE === '1') {
    for (const lang of LANGS) {
      const file = join(DIR, lang, 'network-channels.md')
      const text = readFileSync(file, 'utf-8')
      const start = text.indexOf(BEGIN)
      const end = text.indexOf(END)
      writeFileSync(
        file,
        `${text.slice(0, start + BEGIN.length)}\n\n${generated()}\n\n${text.slice(end)}`,
        'utf-8'
      )
    }
  }

  it.each(LANGS)('NCE-1 %s 的清单 = 按通道表生成的那一份', (lang) => {
    const text = readFileSync(join(DIR, lang, 'network-channels.md'), 'utf-8')
    expect(sectionOf(text), `${lang}: 跑一次 NETWORK_CHANNELS_WRITE=1 重写`).toBe(generated())
  })

  it('NCE-2 read / write / admin 行覆盖每一条、每条恰一次；每个 scope 一节', () => {
    const lines = generated()
      .split('\n')
      .filter((line) => /^- (read|write|admin): /.test(line))
    const listed = lines.flatMap((line) => [...line.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]))
    expect(listed.sort()).toEqual(Object.keys(CHANNEL_ACCESS).sort())
    const headings = [...generated().matchAll(/^### `([a-z]+)`$/gm)].map((m) => m[1])
    expect(headings).toEqual([...CHANNEL_SCOPES])
  })
})
