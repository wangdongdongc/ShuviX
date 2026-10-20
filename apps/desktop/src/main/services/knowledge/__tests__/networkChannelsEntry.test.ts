/**
 * 内置知识库的 `network-channels` 条目（远程访问策略的通道清单，2026-10-19）—— 三种语言的清单逐字相同，且恰是
 * 通道表此刻的样子：每条请求通道都在、归在它的命名空间下、标着 `channelAccess.ts` 给它的访问级别；没有多余的。
 * 清单夹在 `<!-- channels:begin -->` 与 `<!-- channels:end -->` 之间；改了通道表或标签，这里先红 ——
 * `NETWORK_CHANNELS_WRITE=1` 跑一次本文件按通道表重写三份清单。
 *
 *   NCE-1 三种语言的清单 = 按通道表生成的那一份（逐字）
 *   NCE-2 生成的清单覆盖 CHANNEL_ACCESS 的每一条、每条恰出现一次
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHANNEL_ACCESS, type ChannelAccess } from '../../../../shared/channelAccess'
import { channelGroupOf } from '../../../frontend/network/policyGate'

const DIR = join(__dirname, '../../../../../resources/knowledge/shuvix')
const BEGIN = '<!-- channels:begin -->'
const END = '<!-- channels:end -->'
const ORDER: ChannelAccess[] = ['read', 'write', 'admin']

/** 按通道表生成的清单（命名空间按首次出现的先后；每组 read / write / admin 各一行，通道按字母） */
function generated(): string {
  const groups = new Map<string, Map<ChannelAccess, string[]>>()
  for (const [channel, access] of Object.entries(CHANNEL_ACCESS)) {
    const group = channelGroupOf(channel) || channel.split(':')[0]
    let byAccess = groups.get(group)
    if (!byAccess) {
      byAccess = new Map()
      groups.set(group, byAccess)
    }
    const list = byAccess.get(access) ?? []
    list.push(channel)
    byAccess.set(access, list)
  }
  const out: string[] = []
  for (const [group, byAccess] of groups) {
    out.push(`### \`${group}\``, '')
    for (const access of ORDER) {
      const list = byAccess.get(access)
      if (!list) continue
      out.push(
        `- ${access}: ${list
          .sort()
          .map((c) => `\`${c}\``)
          .join(', ')}`
      )
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

  it('NCE-2 覆盖每一条、每条恰一次', () => {
    const listed = [...generated().matchAll(/`([^`\s]+:[^`\s]+)`/g)].map((m) => m[1])
    expect(listed.sort()).toEqual(Object.keys(CHANNEL_ACCESS).sort())
  })
})
