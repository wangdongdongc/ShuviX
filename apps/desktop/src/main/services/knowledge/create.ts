/**
 * 手动维护知识库 —— 侧栏三个「新建」的宿主侧：知识库（用户根下的一个目录）、文件夹（库里的一层目录）、
 * 条目（一份 md）。建库本来整个交给文件系统（设计附录 U），代价是「新建」得离开 ShuviX 去文件管理器；
 * 这里补上最小的三件。**改名与删除仍然交给文件系统** —— 删除不可逆，值得单独一轮配确认框。
 *
 * **写严那一半不打折**：新条目的元数据与 `knowledge` 工具的 `create` 同一套（自述行、键序、归一的
 * type / status），文件名按标题派生并去重，正文留空 —— 内容接着在笔记本里写。新条目走变更管线
 * （git 提交 + `knowledge.changed`）；新建目录没有文件可提交，只广播一次让侧栏重扫。
 *
 * 名字按**最严的那个平台**收（`/ \ : * ? " < > |`、控制字符、前导点、尾随点与空格、`..` 一律不收）：
 * 在 macOS 上建出来的库不该在 Windows 上打不开。重名按大小写不敏感 + NFC 比 —— 大小写不敏感的
 * 文件系统上 `Notes` 会落进 `notes/`，这与 base 解析按目录清单精确匹配的口径是同一件事。
 */
import { mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  buildConceptText,
  dedupeFileName,
  isReservedFile,
  normalizeBundlePath,
  slugify
} from '@shuvix/agent-runtime'
import { KNOWLEDGE_BUILTIN_BASE, KNOWLEDGE_PROJECT_BASE } from '@shuvix/chat-protocol/knowledge'
import { appEventBus } from '../../utils/appEventBus'
import { t } from '../../i18n'
import { recordKnowledgeChange } from './changes'
import {
  bundleDir,
  getUserKnowledgeRoot,
  isBuiltinBundle,
  isValidLibraryName,
  userBundleId
} from './knowledgePaths'
import { invalidateKnowledgeScan, listBundles } from './scan'

/** 手工新建的署名：与 agent 的 `shuvix-<档案>/<模型>` 一眼分得开 */
const HUMAN_ACTOR = 'human'

/** 各平台都能用的文件名 / 目录名：这些字符任一出现即拒（控制字符另按码位判 —— 正则里写不进去） */
const BAD_NAME_CHARS = /[/\\:*?"<>|]/

const NAME_MAX = 100

const hasControlChar = (name: string): boolean =>
  [...name].some((c) => {
    const code = c.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })

export interface KnowledgeCreateResult {
  success: boolean
  /** 新建出来的 id：知识库 / 文件夹是目录 id，条目是条目 id */
  id?: string
  /** 人读的失败原因（已本地化，侧栏直接显示在输入行下面） */
  error?: string
}

/** 目录名 / 文件夹名的形状；合法返回 null */
function nameError(name: string): string | null {
  const bad =
    !name ||
    name.length > NAME_MAX ||
    name === '..' ||
    name.startsWith('.') ||
    name.endsWith('.') ||
    BAD_NAME_CHARS.test(name) ||
    hasControlChar(name)
  return bad ? t('knowledge.errInvalidName') : null
}

/** 这个目录里已经有同名的东西了吗（大小写不敏感 + NFC，与 base 解析同口径） */
function takenIn(dir: string, name: string): boolean {
  const wanted = name.normalize('NFC').toLowerCase()
  try {
    return readdirSync(dir).some((e) => e.normalize('NFC').toLowerCase() === wanted)
  } catch {
    return false
  }
}

/** 这一层里有没有正好叫这个名字的**子目录**（NFC 归一、大小写敏感 —— 与 base 解析同口径） */
function hasSubdirectory(parent: string, name: string): boolean {
  const wanted = name.normalize('NFC')
  try {
    return readdirSync(parent, { withFileTypes: true }).some(
      (e) => e.isDirectory() && e.name.normalize('NFC') === wanted
    )
  } catch {
    return false
  }
}

/** 目录里的名字；读不出（竞态下目录已不在）当空 */
function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 目录变了：没有文件可提交，广播一次让侧栏重扫 */
function announce(): void {
  invalidateKnowledgeScan()
  appEventBus.publish({ type: 'knowledge.changed' })
}

/**
 * 目录 id（bundle id 或它下面的一层）→ 落点。两个名字空间的 bundle id 都是两段
 * （`projects/<projectId>` / `knowledge/<库名>`），所以库那一段直接对磁盘上现存的库清单，深一层的
 * **逐段按目录清单精确匹配**（NFC 归一）而不是拼好路径去 stat —— 大小写不敏感的文件系统上
 * `knowledge/Notes` 会 stat 到 `notes/`，东西落在一处、回给界面的 id 却是另一个写法（`resolveBase`
 * 当初正是为此从 stat 改成清单匹配）。每一段都必须是**目录**：条目文件的路径不是落点。
 *
 * 渲染端只会传清单里的目录，这一道守的是「别凭空造出一个库」。
 */
function resolveDir(dirId: string): { bundle: string; rel: string; abs: string } | null {
  const id = normalizeBundlePath(dirId)
  const segs = id ? id.split('/') : []
  if (segs.length < 2 || segs.some((s) => !s || s.startsWith('.'))) return null
  const bundle = `${segs[0]}/${segs[1]}`
  if (!listBundles().includes(bundle)) return null
  // 只读的内置库在这里就解析不出落点 —— 两个调用方各自先回一句可读的原因（见下），这一道是结构上的
  // 兜底：将来再加一个「新建」忘了那句判断，也拿不到应用包里的路径
  if (isBuiltinBundle(bundle)) return null
  let abs = bundleDir(bundle)
  for (const seg of segs.slice(2)) {
    if (!hasSubdirectory(abs, seg)) return null
    abs = join(abs, seg)
  }
  return { bundle, rel: segs.slice(2).join('/'), abs }
}

/** 新建一个用户知识库：用户根下的一个目录，没有别的 —— 库就是目录 */
export function createKnowledgeBase(rawName: string): KnowledgeCreateResult {
  const name = rawName.trim()
  const bad = nameError(name) ?? (isValidLibraryName(name) ? null : t('knowledge.errInvalidName'))
  if (bad) return { success: false, error: bad }
  // `project` / `shuvix` 是工具里的保留名（项目库 / 内置库）：叫这个名字的用户库工具够不着，
  // 别让人建出一个点不着的库
  if (name === KNOWLEDGE_PROJECT_BASE || name === KNOWLEDGE_BUILTIN_BASE) {
    return { success: false, error: t('knowledge.errReserved', { name }) }
  }

  const root = getUserKnowledgeRoot()
  mkdirSync(root, { recursive: true })
  if (takenIn(root, name)) return { success: false, error: t('knowledge.errNameTaken', { name }) }
  try {
    mkdirSync(join(root, name))
  } catch (e) {
    return {
      success: false,
      error: t('knowledge.errCreateFailed', { error: (e as Error).message })
    }
  }
  announce()
  return { success: true, id: userBundleId(name) }
}

/** 在某个目录（库本身或库里的一层）下新建文件夹 */
export function createKnowledgeFolder(dirId: string, rawName: string): KnowledgeCreateResult {
  const name = rawName.trim()
  const bad = nameError(name)
  if (bad) return { success: false, error: bad }
  // 内置库只读（文件在应用包里）：侧栏不给它新建菜单，这里再守一道。判据必须与 resolveDir 同一套
  // 归一（`isBuiltinBundle` 走 normalizeBundlePath，`./builtin/…` 也剥）—— 两套归一就有一条绕过去的路
  if (isBuiltinBundle(dirId)) return { success: false, error: t('knowledge.errReadOnly') }
  const target = resolveDir(dirId)
  if (!target) return { success: false, error: t('knowledge.errNoSuchDir') }
  if (takenIn(target.abs, name)) {
    return { success: false, error: t('knowledge.errNameTaken', { name }) }
  }
  try {
    mkdirSync(join(target.abs, name))
  } catch (e) {
    return {
      success: false,
      error: t('knowledge.errCreateFailed', { error: (e as Error).message })
    }
  }
  announce()
  const dir = target.rel ? `${target.bundle}/${target.rel}` : target.bundle
  return { success: true, id: `${dir}/${name}` }
}

/**
 * 在某个目录下新建一条条目：元数据由宿主拼（与工具的 `create` 同一套），正文留空。
 * `status` 用 `draft` —— 刚建出来的条目里还什么都没有，`stable` 的意思是「后来的会话可以依赖它」。
 */
export function createKnowledgeEntry(dirId: string, rawTitle: string): KnowledgeCreateResult {
  const title = rawTitle.trim()
  if (!title) return { success: false, error: t('knowledge.errEmptyTitle') }
  if (isBuiltinBundle(dirId)) return { success: false, error: t('knowledge.errReadOnly') }
  const target = resolveDir(dirId)
  if (!target) return { success: false, error: t('knowledge.errNoSuchDir') }

  const existing = new Set(namesIn(target.abs).map((e) => e.normalize('NFC').toLowerCase()))
  // 保留文件名同样算占用：slugify('Index') 正好撞上 OKF 保留的 index.md
  const isTaken = (file: string): boolean =>
    existing.has(file.normalize('NFC').toLowerCase()) || isReservedFile(file)
  const file = dedupeFileName(`${slugify(title)}.md`, isTaken)
  const content = buildConceptText({ type: 'Memory', title, status: 'draft' }, '')
  try {
    writeFileSync(join(target.abs, file), content)
  } catch (e) {
    return {
      success: false,
      error: t('knowledge.errCreateFailed', { error: (e as Error).message })
    }
  }

  const rel = target.rel ? `${target.rel}/${file}` : file
  recordKnowledgeChange({ bundle: target.bundle, path: rel, op: 'Creation', actor: HUMAN_ACTOR })
  return { success: true, id: `${target.bundle}/${rel}` }
}
