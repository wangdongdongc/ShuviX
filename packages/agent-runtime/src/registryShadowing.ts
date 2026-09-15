/**
 * 注册表 md 的同名裁决 —— agent / 安全策略 / hook / bot 这几类「文件存在即生效」的注册表里，
 * 同一个名字有好几份时，谁生效、谁被遮蔽。
 *
 * **运行时取生效集与界面列出全部份数，必须经这一个函数、喂同一份候选**：两边各写一遍规则，迟早
 * 会出现「列表上标着生效的，不是真正在跑的那份」。被遮蔽的几份照常列出来（换一种样子显示），
 * 而不是在扫描里悄悄跳过 —— 看不见的文件，用户既不知道它存在，也不知道它为什么不生效。
 *
 * 胜出次序：
 *  1. 用户文件压过内置（同名覆盖是有意设计）；
 *  2. 同为用户文件：文件名就是这个名字的那份优先（与新建时由名字派生文件名的净化规则同一套，
 *     大小写不敏感）—— `scout copy.md` 不该仅仅因为排序靠前，就抢走 `scout.md` 的身份；
 *  3. 其次文件名短的优先（复制品通常是在原文件名上加后缀）；
 *  4. 最后按文件名码点序 —— 不依赖 readdir 的枚举序，每次扫描、每台机器结论都一样。
 * 内置之间不会同名；万一同名（或没有文件名可比），先到者胜。
 */

export interface ShadowCandidate<T> {
  name: string
  source: 'builtin' | 'user'
  /** 用户文件的文件名（同为用户文件时按它排先后）；内置、或没有文件身份的宿主省略 */
  fileName?: string
  value: T
}

/** 压过某一份的那一份 */
export interface ShadowedBy {
  source: 'builtin' | 'user'
  fileName?: string
}

export type ShadowResolved<T> = ShadowCandidate<T> & {
  /** 生效的那一份没有这个字段；被遮蔽的指向压过它的那一份 */
  shadowedBy?: ShadowedBy
}

/** 由名字派生注册表文件名的净化规则（路径分隔 / 保留字符 → `-`，去掉前导点）；新建文件与同名裁决共用 */
export function registryFileBase(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '')
}

/** 这份用户文件的文件名是不是就是它的名字 */
function isCanonicalFile(candidate: ShadowCandidate<unknown>): boolean {
  if (!candidate.fileName) return false
  const stem = candidate.fileName.replace(/\.md$/i, '')
  return stem !== '' && stem.toLowerCase() === registryFileBase(candidate.name).toLowerCase()
}

/** 同名的两份里，a 是否压过 b */
function outranks(a: ShadowCandidate<unknown>, b: ShadowCandidate<unknown>): boolean {
  if (a.source !== b.source) return a.source === 'user'
  if (a.source === 'builtin') return false
  const canonical = isCanonicalFile(a)
  if (canonical !== isCanonicalFile(b)) return canonical
  const fa = a.fileName ?? ''
  const fb = b.fileName ?? ''
  if (fa.length !== fb.length) return fa.length < fb.length
  return fa < fb
}

/**
 * 裁决同名：按输入顺序原样返回每一份，被压过的带上 `shadowedBy`。
 * 生效集就是没有 `shadowedBy` 的那些 —— 调用方过滤，不再另写一遍规则。
 */
export function resolveShadowing<T>(
  candidates: readonly ShadowCandidate<T>[]
): ShadowResolved<T>[] {
  const winners = new Map<string, ShadowCandidate<T>>()
  for (const candidate of candidates) {
    const current = winners.get(candidate.name)
    if (!current || outranks(candidate, current)) winners.set(candidate.name, candidate)
  }
  return candidates.map((candidate) => {
    const winner = winners.get(candidate.name)!
    if (winner === candidate) return { ...candidate }
    return {
      ...candidate,
      shadowedBy: {
        source: winner.source,
        ...(winner.fileName ? { fileName: winner.fileName } : {})
      }
    }
  })
}
