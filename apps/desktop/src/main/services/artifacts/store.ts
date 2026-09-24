/**
 * 会话 Artifacts 的存储层 —— 目录即 bundle，没有清单文件。
 *
 * 设计要点（完整论证见 docs/session-artifacts-design.md）：
 *  - **一场会话一个目录**，`~/.shuvix/artifacts/<sessionId>/`，首次写入时才建。
 *    看一眼就结束的图在磁盘上什么都不留 —— 图缺省走 ```svg 围栏，只有需要改时才认领过来。
 *  - **没有 manifest、没有 sidecar**（与用户知识库同策：「每个非隐藏子目录就是一个库，
 *    不需要标记」）。标题从内容里取，所以拷贝出去也不丢。
 *  - **目录跟着会话走，不上溯根会话**（形参就叫 `sessionId`，别改回 root）：子会话是一场
 *    普通会话、有自己的转写，而认领读的正是那份转写 —— 目录跟转写对齐，才不会出现
 *    「看得见的图认领不到、认领到的图看不见」。代价是父会话要展示子会话的产物时得沿
 *    会话树找一层，那一步在 `artifact:read` 里做。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { slugify } from '@shuvix/agent-runtime'
import { SANDBOX_CSP } from '@shuvix/chat-protocol/utils/interactiveFence'
import { getSessionArtifactsDir } from '../../utils/paths'

/** 一件 artifact 的元信息（标题现算，不落盘） */
export interface ArtifactInfo {
  /** 文件名（含扩展名）—— 模型按它寻址 */
  name: string
  /** 人读标题：从内容里取，取不到回落文件名主干 */
  title: string
  /** 绝对路径 —— 交给 `edit` / `read` 用 */
  path: string
}

/**
 * 允许的扩展名。`html` 当初被刻意拿掉（没有渲染器，放行它只会在用户找得到的目录里留下一个
 * 模型手写、可能被双击以 `file://` 源打开的页面）；现在它回来了，两个前提都补上了：
 *  - **渲染器**：```artifact 引用一件 `.html` 时走交互图的沙箱 iframe（chat-ui InteractiveBlock），
 *    与 ```interactive 围栏同一道边界；
 *  - **双击打开**：写盘时在最前面加一行与沙箱同一条的 meta CSP（withStandaloneCsp）。浏览器以
 *    `file://` 打开它时这条策略生效、没有网络出口；在沙箱里它落在 body 里，按规范不生效也不碍事。
 */
const ALLOWED_EXT = new Set(['svg', 'md', 'txt', 'csv', 'json', 'html'])

/** 独立打开时生效的那一行（与沙箱的 SANDBOX_CSP 同一条） */
const STANDALONE_CSP_LINE = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`

/** html artifact 落盘前加上 STANDALONE_CSP_LINE；已经有了就不重复加（adopt 幂等、edit 后再写都安全） */
export function withStandaloneCsp(content: string): string {
  return content.startsWith(STANDALONE_CSP_LINE) ? content : `${STANDALONE_CSP_LINE}\n${content}`
}

/**
 * 标题提取 —— 从内容里取，不搞元数据文件（`readKnowledgeNote` 的既有做法）。
 * SVG 取 `aria-label` 或 `<title>`（提示片段已强制要求写其一），markdown 取首个 `#`。
 */
export function titleOf(content: string, name: string): string {
  // 交互图（html）：开头那个 `<title>`（前面可以有 withStandaloneCsp 加的那行 meta）。**排在 svg 的
  // 两条之前**：那两条不锚开头，块里画的一张 SVG 自带的 aria-label / `<title>` 会抢走整块的名字。
  // 反过来不会误伤 svg：svg 文件以 `<svg` 开头，锚在开头的这一条匹配不上
  const htmlTitle = /^\s*(?:<meta\b[^>]*>\s*)?<title[^>]*>([^<]+)<\/title>/i.exec(content)
  if (htmlTitle?.[1].trim()) return htmlTitle[1].trim()
  const aria = /<svg\b[^>]*\saria-label\s*=\s*"([^"]+)"/i.exec(content)
  if (aria?.[1].trim()) return aria[1].trim()
  // `<title>` 只认**根 svg 的首个子元素**。不锚住的话，给每根柱子写无障碍 tooltip
  // （图表的正常写法）会让第一根柱子的 tooltip 抢走整张图的标题 —— 文件名与模型自以为的
  // 标题就此不一致，list 里那行也看不懂。
  const rootTitle = /<svg\b[^>]*>\s*<title[^>]*>([^<]+)<\/title>/i.exec(content)
  if (rootTitle?.[1].trim()) return rootTitle[1].trim()
  const heading = /^#\s+(.+)$/m.exec(content)
  if (heading) return heading[1].trim()
  return name.replace(/\.[^.]+$/, '')
}

/** 文件名去重 —— 知识库那份 dedupeFileName 把 `.md` 写死了，这里要带任意扩展名 */
function dedupe(stem: string, ext: string, taken: (n: string) => boolean): string {
  if (!taken(`${stem}.${ext}`)) return `${stem}.${ext}`
  for (let i = 2; i < 1000; i++) {
    if (!taken(`${stem}-${i}.${ext}`)) return `${stem}-${i}.${ext}`
  }
  return `${stem}-${Date.now()}.${ext}`
}

/**
 * 会话 id 是否能安全地当作目录名 —— 含路径分隔符或 `..` 一律拒。
 *
 * 今天 id 是 DB 的 uuidv7、不可达；但这是全仓唯一一条对该目录的**递归删除**，而
 * `artifact:read` 的 sessionId 来自**渲染端**。一行守卫换掉一整类事故。
 *
 * **四个入口都要过它** —— 曾经只挡了 listArtifacts / deleteSessionArtifacts，偏偏漏了
 * findArtifact / readArtifact，也就是渲染端真正会抵达的那两个，正好落空了上面这条理由。
 */
function isSafeSessionId(id: string): boolean {
  return !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
}

/** 列出这场会话的 artifact（目录不存在 = 空，不创建） */
export function listArtifacts(sessionId: string): ArtifactInfo[] {
  if (!isSafeSessionId(sessionId)) return []
  const dir = getSessionArtifactsDir(sessionId)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => {
      const path = join(dir, e.name)
      let content = ''
      try {
        content = readFileSync(path, 'utf-8')
      } catch {
        /* 读不到就只用文件名兜标题 */
      }
      return { name: e.name, title: titleOf(content, e.name), path }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 按名字取一件 —— 先按**文件名**直判，命中就不读任何内容。
 *
 * 为什么分两步：`listArtifacts` 要给**每个**文件算标题，也就要把目录里每份都整读一遍。按
 * 文件名命中时只读命中的那一份（标题还是要算的 —— 回执要显示它），所以这条路把 N 次全文读
 * 降到 1 次，**不是降到 0**。原先一条引用要触发 2N+1 次，一场十几件 artifact 的会话滚一下
 * 就是几百次。
 *
 * 标题匹配是回退路径（模型可能在围栏里写标题）：**重名时拒绝而不是猜**，否则取到的是
 * 一个按 localeCompare 排序的产物（`foo-10.svg` 排在 `foo.svg` 前面），既不是最早也不是
 * 最新那件，还会随件数跳变。
 */
export function findArtifact(sessionId: string, name: string): ArtifactInfo | null {
  const wanted = name.trim()
  if (!wanted || !isSafeSessionId(sessionId)) return null
  const dir = getSessionArtifactsDir(sessionId)
  if (!existsSync(dir)) return null

  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
  const byName = files.find((f) => f.toLowerCase() === wanted.toLowerCase())
  if (byName) {
    const path = join(dir, byName)
    let content = ''
    try {
      content = readFileSync(path, 'utf-8')
    } catch {
      /* 读不到就只用文件名兜标题 */
    }
    return { name: byName, title: titleOf(content, byName), path }
  }

  const byTitle = listArtifacts(sessionId).filter(
    (a) => a.title.toLowerCase() === wanted.toLowerCase()
  )
  return byTitle.length === 1 ? byTitle[0] : null
}

/** 读内容（供渲染端的引用围栏与 adopt 回执用） */
export function readArtifact(sessionId: string, name: string): string | null {
  if (!isSafeSessionId(sessionId)) return null
  const found = findArtifact(sessionId, name)
  if (!found) return null
  try {
    return readFileSync(found.path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 写入一件新 artifact —— 文件名由标题 slug 化并去重，**不由模型指定路径**。
 * 让模型自己挑路径等于让它有一天静默覆盖掉上一件（与知识库 `create` 同一个理由）。
 */
export function writeArtifact(params: {
  sessionId: string
  title: string
  ext: string
  content: string
}): ArtifactInfo {
  const ext = params.ext.replace(/^\./, '').toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`Unsupported artifact type ".${ext}" (allowed: ${[...ALLOWED_EXT].join(', ')})`)
  }
  const dir = getSessionArtifactsDir(params.sessionId)
  mkdirSync(dir, { recursive: true })
  const taken = new Set(readdirSync(dir))
  const name = dedupe(slugify(params.title, 'artifact'), ext, (n) => taken.has(n))
  const path = join(dir, name)
  const content = ext === 'html' ? withStandaloneCsp(params.content) : params.content
  writeFileSync(path, content, 'utf-8')
  return { name, title: titleOf(content, name), path }
}

/** 会话删除时的级联 —— 目录整删（挂在 sessionService.delete 上） */
export function deleteSessionArtifacts(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) return
  const dir = getSessionArtifactsDir(sessionId)
  if (!existsSync(dir)) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 删不掉只是留下几个文本文件，不值得让删会话失败 */
  }
}
