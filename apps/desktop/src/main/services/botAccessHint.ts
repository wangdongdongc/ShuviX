/**
 * 写入回执里的 bot 定时运行权限核对（file 工具的 `writtenNote` 缝，doc_* 也拿它）：带定时的 bot 文件写下之后、
 * 点名了 bot 的策略写下之后，回执里说这个 bot 没人在场时能不问就做哪些事 —— 判定与文字在 botAccessCheck /
 * agent-runtime 的 botAccessNote，这里只认「这是不是那种文件」并调主入口注入的核对。
 *
 * 刻意轻：只依赖路径与标记检测。核对要 bot 注册表、项目、策略与安全上下文，静态引入会把数据库拖进 file 工具的
 * 依赖图（同 botScheduleHint 的项目查找）。没注入 = 不核对。出错就不附：它只是附言。
 */
import { basename, dirname, resolve } from 'path'
import { detectShuvixMarker } from '@shuvix/chat-protocol/shuvixMdContract'
import type { BotAccessChecker } from './botAccessCheck'
import { getDefaultPoliciesDir } from '../utils/paths'

let checker: BotAccessChecker | null = null

/** main 启动时注入（botAccessWiring 的 desktopBotAccessChecker） */
export function setBotAccessChecker(next: BotAccessChecker | null): void {
  checker = next
}

/** 一份 bot 文件（path = 它的绝对路径）的权限核对；调用方已经认定它是 bot 文件 */
export function botAccessNoteFor(text: string, path: string): string | null {
  try {
    return checker?.forBotFile(text, path) ?? null
  } catch {
    return null
  }
}

/** 一份策略（fileName = 它在策略目录里的文件名）的权限核对；调用方已经认定它是策略 */
export function policyBotAccessNoteFor(text: string, fileName: string): string | null {
  // 便宜的预筛：没读 subject.bot 的策略与 bot 无关
  if (!/\bsubject\.bot\b/.test(text)) return null
  try {
    return checker?.forPolicyFile(text, fileName) ?? null
  } catch {
    return null
  }
}

/**
 * 刚写下的是一份点名了 bot 的策略 → 那一段；否则 null。认法与策略扫描一致：策略目录顶层的 md（标记可以不写），
 * 或者 frontmatter 的标记是 `shuvix: policy`（写在别处的草稿也按装进去之后算 —— 它可能正要被挪进策略目录）
 */
export function policyBotAccessHint(path: string, text: string): string | null {
  try {
    if (!/\.md$/i.test(path)) return null
    const inPolicies = resolve(dirname(path)) === resolve(getDefaultPoliciesDir())
    if (!inPolicies && detectShuvixMarker(text)?.type !== 'policy') return null
    return policyBotAccessNoteFor(text, basename(path))
  } catch {
    return null
  }
}
