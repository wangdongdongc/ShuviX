/**
 * bot 文件写入回执里的排期预演（file 工具的 `writtenNote` 缝，doc_* 也拿它）：每条 `timer.fired` 绑定接下来几次
 * 什么时候触发、一次都不触发、`project` 对不上项目 —— 文字与规则在 agent-runtime 的 botScheduleNote，这里只认
 * 「这是不是一份 bot 文件」、给出此刻与项目查找。
 *
 * 为什么放在回执里（2026-10-31 真模型演练）：`event.local.weekday == 'Sunday'` 解析得过、却永远不触发；另一个
 * 模型为了确认自己写对了，翻数据库找项目、写了一堆测试文件。回执是 agent 写完当场一定会读的地方。
 */
import { basename, dirname, resolve } from 'path'
import { botScheduleNote, parseBotDefinitionFile, type BotBinding } from '@shuvix/agent-runtime'
import { detectShuvixMarker } from '@shuvix/chat-protocol/shuvixMdContract'
import { getDefaultBotsDir } from '../utils/paths'

let projectMatches: ((name: string) => number) | undefined

/**
 * main 启动时注入项目查找（`projectService.projectsNamed(name).length`）。刻意不静态 import projectService：
 * 这个模块挂在 file 工具的 writtenNote 上，静态引入会把数据库拖进 file 工具的依赖图（单测里就加载不起来）。
 * 没注入就不查项目名
 */
export function setBotScheduleProjectLookup(lookup: ((name: string) => number) | undefined): void {
  projectMatches = lookup
}

/** 一份 bot 文件的绑定 → 回执那一段；没有 timer 绑定 / 解析不过（解析器已经说了原因）回 null */
export function botScheduleNoteFor(text: string, fileName: string): string | null {
  const parsed = parseBotDefinitionFile(text, fileName.replace(/\.md$/i, ''))
  const bindings: BotBinding[] = parsed?.bindings ?? []
  if (bindings.length === 0) return null
  const lookup = projectMatches
  return botScheduleNote(bindings, {
    now: new Date(),
    env: { host: 'desktop', platform: process.platform },
    // 查不了项目就不说项目那一行（回 1 = 对得上），排期照给
    projectMatches: lookup
      ? (name) => {
          try {
            return lookup(name)
          } catch {
            return 1
          }
        }
      : undefined
  })
}

/**
 * 刚写下的是一份 bot 文件 → 那一段；否则 null。认法与扫描一致：bots 目录顶层的 md（标记可以不写），
 * 或者 frontmatter 的标记是 `shuvix: bot`（与解析器、doc_* 同一个 detectShuvixMarker —— 写在别处的 bot 文件
 * 也给预演，它可能正要被挪进 bots 目录）。归档目录（bots/archived，同 botService 的 ARCHIVED_DIR_NAME）里的
 * 不给：归档的 bot 不触发
 */
export function botScheduleHint(path: string, text: string): string | null {
  try {
    if (!/\.md$/i.test(path)) return null
    const botsDir = resolve(getDefaultBotsDir())
    const dir = resolve(dirname(path))
    if (dir === resolve(botsDir, 'archived')) return null
    if (dir !== botsDir && detectShuvixMarker(text)?.type !== 'bot') return null
    return botScheduleNoteFor(text, basename(path))
  } catch {
    return null
  }
}
