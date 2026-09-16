/**
 * 侧栏 / 管理页的条目清单 —— 扫描全部 bundle（项目库 + 用户库），每个 md 投影成一行
 * chat-protocol 的 KnowledgeEntry（不含正文）。`path` 与 `bundle` 用两个根共用的名字空间
 * （`projects/<id>/…` / `knowledge/<库名>/…`），所以跨 bundle、跨根都唯一。
 *
 * 这里**不建任何东西**：清单是只读的。
 *
 * **读宽**：库里每个 md 都有一行。合规的 OKF 条目带信任 / 核实 / 过期标注；没有 frontmatter、没有
 * `type`、带别家标记的用户笔记照常列出、点开即开，标题依次取 frontmatter title、正文第一个 `#`
 * 标题、文件名。ShuviX 早先生成的 index.md / log.md 不列 —— 用户自己写的同名笔记照常列出。
 *
 * **目录跟着条目一起下发**（`dirs`）：库本身与库里每一层非隐藏子目录，空的也给 —— 手动新建的知识库
 * 和文件夹第一时间就是空的，清单里不给，侧栏就什么都画不出来。
 *
 * 项目库的**显示名**随清单一起下发：目录名是项目 id，按 id 查项目**当前**的名字 —— 改名即时生效，
 * 不靠任何写在库里的文件。项目已删就查不到，侧栏回落目录名。内置库的显示名按界面语言取
 * （`builtinBaseDisplayName`，与配置卡的 chip 同一个 i18n 键）。
 *
 * 内置库的**绝对目录**也随清单下发（`bundleDirs`）：它不在两个根之下，而且路径里夹着语言那一层
 * （`<库名>/<lang>/…`），侧栏靠两个根拼不出来 —— 「复制路径」要用它。
 */
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import { toKnowledgeEntryFromNote } from '@shuvix/agent-runtime'
import { projectDao } from '../../dao/projectDao'
import {
  PROJECTS_CONTAINER,
  builtinBaseDisplayName,
  bundleDir,
  getShuvixKnowledgeRoot,
  getUserKnowledgeRoot,
  isBuiltinBundle
} from './knowledgePaths'
import { listBundleDirs, scanAllBundles } from './scan'

/** 项目库 bundle id → 项目当前的名字（查不到的不给）；内置库 → 产品名 */
function bundleDisplayNames(bundles: readonly string[]): Record<string, string> {
  const names: Record<string, string> = {}
  for (const bundle of bundles) {
    if (isBuiltinBundle(bundle)) {
      names[bundle] = builtinBaseDisplayName()
      continue
    }
    const [container, id] = bundle.split('/')
    if (container !== PROJECTS_CONTAINER || !id) continue
    const name = projectDao.findById(id)?.name?.trim()
    if (name) names[bundle] = name
  }
  return names
}

/** 两个根拼不出来的 bundle（内置库）→ 绝对目录 */
function builtinBundleDirs(bundles: readonly string[]): Record<string, string> {
  const dirs: Record<string, string> = {}
  for (const bundle of bundles) if (isBuiltinBundle(bundle)) dirs[bundle] = bundleDir(bundle)
  return dirs
}

/** 目录 id：每个库本身 + 它下面每一层非隐藏子目录 */
function dirIds(bundles: readonly string[]): string[] {
  return bundles.flatMap((bundle) => [
    bundle,
    ...listBundleDirs(bundle).map((rel) => `${bundle}/${rel}`)
  ])
}

/** 清单 + 两个根（条目 id 的首段决定相对哪个根：`knowledge/…` 相对用户根，其余相对 knowledge-shuvix） */
export async function listKnowledgeEntries(): Promise<{
  entries: KnowledgeEntry[]
  root: string
  userRoot: string
  /** 库与库内目录的 id（空目录也在其中） */
  dirs: string[]
  /** bundle id → 显示名（项目库：项目当前的名字；内置库：ShuviX） */
  bundleNames: Record<string, string>
  /** bundle id → 绝对目录，只给两个根拼不出来的那些（内置库：目录在应用包里、路径里夹着语言层） */
  bundleDirs: Record<string, string>
}> {
  const scans = await scanAllBundles()
  const now = new Date()
  const bundles = scans.map((scan) => scan.bundle)
  const entries = scans.flatMap((scan) =>
    scan.notes.map((note) => toKnowledgeEntryFromNote(note, { bundle: scan.bundle, now }))
  )
  return {
    root: getShuvixKnowledgeRoot(),
    userRoot: getUserKnowledgeRoot(),
    entries,
    dirs: dirIds(bundles),
    bundleNames: bundleDisplayNames(bundles),
    bundleDirs: builtinBundleDirs(bundles)
  }
}
