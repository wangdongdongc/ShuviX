/**
 * 路径真正通向哪里 —— 安全模块判路径策略用的那一个解析（`SecurityHostProvider.realPath`，
 * 见 services/toolContext.ts）。
 *
 * 为什么需要：路径策略比的是位置，工具交来的是写法。工作区里一条 `key -> ~/.ssh/id_rsa`
 * 按写法「在工作区内」，read 会一声不响地把私钥交给模型、upload_file 会交给网页。
 *
 *   - 整条路径都存在：`realpathSync.native` —— 内核自己的答案：符号链接展开，`..` 取的是
 *     **物理**父目录（先跟链接、再退一级），macOS 上还给出**盘上的大小写**（JS 版 realpathSync
 *     不纠正大小写：不区分大小写的卷上 `~/.SSH/id_rsa` 就是私钥，按写法却不在 `~/.ssh` 里）。
 *   - 有段不存在（写一个新文件）、悬空链接、权限不足：逐段照内核的规矩走 —— 存在的段跟链接、
 *     `..` 取物理父目录；走到第一个不存在的段，其后的段按字面折叠接上（不存在的目录底下不会有
 *     链接，建出来的中间目录也是真目录，这时字面折叠就是真实去处）。悬空链接照样跟过去，落在它
 *     将要创建的目标上：`<ws>/x -> ~/.ssh/authorized_keys` 目标还不存在时，写 `<ws>/x` 就是创建它。
 *   - 链接环：跟满 MAX_LINK_HOPS 跳就停，交出走到的位置 —— 真正的访问会以 ELOOP 失败，
 *     判定用这个名字不会放过任何一次能成功的访问。
 *   - 相对路径原样返回：它没有「通向哪里」可言（按进程 cwd 解析只会得到一个偶然的目录）。
 *
 * **不能先 path.resolve**：那会先按字面折叠 `..`，`<ws>/link/../.ssh/id_rsa`（link -> ~/.ssh）就被
 * 判成区内的 `<ws>/.ssh/id_rsa`，而 read 原样打开它、读到的是 link 那头的私钥。
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'

/** 一次解析最多跟多少跳链接（同 Linux 的 MAXSYMLINKS；再多就是环） */
const MAX_LINK_HOPS = 40

/** 路径段分隔符：Windows 两种斜杠都认 */
const SEPARATORS = process.platform === 'win32' ? /[\\/]+/ : /\/+/

export function resolveRealPath(path: string): string {
  if (!isAbsolute(path)) return path
  try {
    return realpathSync.native(path)
  } catch {
    // 有段不存在 / 悬空链接 / 环 / 权限不足 / 中间段不是目录：逐段走
  }
  return walk(path)
}

/** 绝对路径 → 根 + 各段（空段与 `.` 在走的时候跳过） */
function split(path: string): { root: string; parts: string[] } {
  const { root } = parse(path)
  return { root, parts: path.slice(root.length).split(SEPARATORS) }
}

/** 确实存在的真目录 → 盘上的写法（大小写）；取不到就原样 */
function onDisk(dir: string): string {
  try {
    return realpathSync.native(dir)
  } catch {
    return dir
  }
}

function walk(path: string): string {
  let hops = MAX_LINK_HOPS
  const start = split(path)
  // base 恒是一个存在的、不含链接的目录：它的字面父目录就是物理父目录
  let base = start.root
  const pending = start.parts
  while (pending.length > 0) {
    const part = pending.shift() as string
    if (part === '' || part === '.') continue
    if (part === '..') {
      base = dirname(base)
      continue
    }
    const next = join(base, part)
    let link: string | null
    try {
      link = lstatSync(next).isSymbolicLink() ? readlinkSync(next) : null
    } catch {
      // next 不存在（或查不了）：其后的段按字面折叠接上
      return resolve(onDisk(base), part, ...pending)
    }
    if (link === null) {
      base = next
      continue
    }
    if (hops-- <= 0) return resolve(onDisk(base), part, ...pending)
    // 链接目标的各段插到剩余段前面接着走：相对目标从链接所在目录起算，绝对目标从它自己的根起算
    const target = isAbsolute(link) ? split(link) : { root: base, parts: link.split(SEPARATORS) }
    base = target.root
    pending.unshift(...target.parts)
  }
  return onDisk(base)
}
