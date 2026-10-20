/**
 * 会话权限表的派生行 —— 按会话**此刻**的设置算出来的那几行（workdir / document / system / knowledge / skill）。
 * 对账（index.ts 的 sync）拿它与表里已有的派生行比，补上缺的、删掉过时的。
 *
 * 跟着会话里勾的东西走，不是要人维护的白名单。读不到（库扫描失败之类）就少给 —— 多问，不放行。
 */
import type { DerivedAclSource, PathAccess } from '@shuvix/chat-protocol/sessionAcl'
import { createLogger } from '../../logger'
import { getBuiltinSkillsDir } from '../../utils/paths'
import { resolveToCwd } from '../../utils/toolUtils/pathUtils'
import { enabledTargets } from '../knowledge/sessionBundle'
import { sessionOwnDirsView, settingDirForAcl } from '../sandbox'
import { sessionRecords } from '../sessionRecords'
import { sessionWorkingDirectory } from './workdir'

const log = createLogger('Acl')

/**
 * 用户启用的技能目录（skillService.enabledSkillRoots）—— 由主进程启动时注入：本目录是独立模块，按分层规则
 * 不反向依赖 services/ 根目录的 skillService。没注入 = 只有内置技能目录（单测默认如此）。
 */
let enabledSkillRoots: () => readonly string[] = () => []

export function setAclSkillRoots(source: () => readonly string[]): void {
  enabledSkillRoots = source
}

export interface DerivedPathEntry {
  source: DerivedAclSource
  sourceKey: string
  target: string
  access: PathAccess
}

/** 一条会话此刻应有的派生行（顺序即界面上的顺序：工作目录、笔记本文档、会话目录、知识库、技能） */
export function derivePathEntries(sessionId: string): DerivedPathEntry[] {
  const workingDirectory = sessionWorkingDirectory(sessionId)
  const own = sessionOwnDirsView(sessionId, workingDirectory)
  // 坏会话 id / 算不出会话目录：一行都不派生（多问）
  if (!own) return []
  const out: DerivedPathEntry[] = []
  if (own.workdir) {
    out.push({ source: 'workdir', sourceKey: '', target: own.workdir, access: 'write' })
  }

  // 笔记本会话自己的那份文档（doc_* 读写它）：缺省可写 —— 打开笔记本就是要和 agent 一起改它。它可能在
  // 工作目录以外（侧栏里打开的 agent / 策略 md），所以单列一行，用户能在权限表里改成只读
  const notebookPath = sessionRecords.pickSettings(sessionId, ['notebookPath'])?.notebookPath
  if (notebookPath) {
    const doc = settingDirForAcl(resolveToCwd(notebookPath, workingDirectory))
    if (doc) out.push({ source: 'document', sourceKey: '', target: doc, access: 'write' })
  }
  out.push(
    { source: 'system', sourceKey: 'tmp', target: own.tmp, access: 'write' },
    { source: 'system', sourceKey: 'artifacts', target: own.artifacts, access: 'write' },
    { source: 'system', sourceKey: 'toolResults', target: own.toolResults, access: 'write' }
  )

  // 勾选的知识库（项目库隐式在内）：可读写 —— 知识库的每次改动都提交进它自己的 git，可以回退；
  // 只读的内置库只读
  try {
    for (const { name, target } of enabledTargets(sessionId)) {
      const dir = settingDirForAcl(target.dir)
      if (!dir) continue
      out.push({
        source: 'knowledge',
        sourceKey: name,
        target: dir,
        access: target.readonly ? 'read' : 'write'
      })
    }
  } catch (err) {
    log.warn(`knowledge dirs unavailable: ${(err as Error).message}`)
  }

  // 技能目录（内置 + 用户启用的）：只读 —— 技能是 agent 自己要遵守的指令，改它照旧询问
  try {
    const roots = [getBuiltinSkillsDir(), ...enabledSkillRoots()]
    for (const root of roots) {
      const dir = settingDirForAcl(root)
      if (dir) out.push({ source: 'skill', sourceKey: dir, target: dir, access: 'read' })
    }
  } catch (err) {
    log.warn(`skill dirs unavailable: ${(err as Error).message}`)
  }

  // 同一来源的同一行只留一份（唯一索引的口径）
  const seen = new Set<string>()
  return out.filter((e) => {
    const key = derivedKey(e)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 派生行的身份：来源 + 来源键 + 目标（与表上唯一索引同口径） */
export function derivedKey(e: Pick<DerivedPathEntry, 'source' | 'sourceKey' | 'target'>): string {
  return `${e.source}\u0000${e.sourceKey}\u0000${e.target}`
}
