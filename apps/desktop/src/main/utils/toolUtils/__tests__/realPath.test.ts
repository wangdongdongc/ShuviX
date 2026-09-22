/**
 * resolveRealPath —— 安全模块判路径策略用的那一个解析（桌面的 SecurityHostProvider.realPath）。
 *
 * 真实临时目录树 + 真符号链接。每条期望都按「内核会打开哪里」写：整条路径都存在的，直接与
 * `realpathSync.native`（内核自己的答案）对照；还不存在的尾段按「建出来会落在哪」写，并在 RP-5 /
 * RP-10b 真的经那条写法建一次文件，看它落在不在预言的位置。
 *
 * macOS 上 tmpdir 本身就在 /var → /private/var 这条系统级链接之下，所以期望一律从
 * `realpathSync.native(root)` 起算（下文的 R），写法一律从 root 起算（下文的 T）。
 * 符号链接在 Windows 上要开发者模式，整份跳过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveRealPath } from '../realPath'

/** 写法（tmpdir 原样）与真实去处（内核给的） */
let T = ''
let R = ''

describe.skipIf(process.platform === 'win32')('resolveRealPath', () => {
  /**
   * 目录树：
   *   top.txt
   *   real/a.txt、real/CaseFile.txt、real/sub/
   *   real/reldang → ../future/f.txt        （相对目标、悬空）
   *   flink → T/real/a.txt                   （绝对目标、文件）
   *   rellink → real/a.txt                   （相对目标、文件）
   *   dlink → T/real                         （目录）
   *   dangling → T/real/not-yet.txt、dangling2 → T/real/created-by-write.txt、dangdir → T/nowhere/sub
   *   c1 → c2 → c3 → T/real；d1 → d2 → T/gone/x                    （链）
   *   loopA ⇄ loopB；self → self                                     （环）
   *   dir → T/real/sub                                               （`..` 走物理父目录，RP-10b）
   */
  beforeAll(() => {
    T = mkdtempSync(join(tmpdir(), 'shuvix-realpath-'))
    R = realpathSync.native(T)
    mkdirSync(join(T, 'real', 'sub'), { recursive: true })
    writeFileSync(join(T, 'top.txt'), 'top')
    writeFileSync(join(T, 'real', 'a.txt'), 'a')
    writeFileSync(join(T, 'real', 'CaseFile.txt'), 'case')
    symlinkSync('../future/f.txt', join(T, 'real', 'reldang'))
    symlinkSync(join(T, 'real', 'a.txt'), join(T, 'flink'))
    symlinkSync('real/a.txt', join(T, 'rellink'))
    symlinkSync(join(T, 'real'), join(T, 'dlink'))
    symlinkSync(join(T, 'real', 'not-yet.txt'), join(T, 'dangling'))
    symlinkSync(join(T, 'real', 'created-by-write.txt'), join(T, 'dangling2'))
    symlinkSync(join(T, 'nowhere', 'sub'), join(T, 'dangdir'))
    symlinkSync(join(T, 'c2'), join(T, 'c1'))
    symlinkSync(join(T, 'c3'), join(T, 'c2'))
    symlinkSync(join(T, 'real'), join(T, 'c3'))
    symlinkSync(join(T, 'd2'), join(T, 'd1'))
    symlinkSync(join(T, 'gone', 'x'), join(T, 'd2'))
    symlinkSync(join(T, 'loopB'), join(T, 'loopA'))
    symlinkSync(join(T, 'loopA'), join(T, 'loopB'))
    symlinkSync(join(T, 'self'), join(T, 'self'))
    symlinkSync(join(T, 'real', 'sub'), join(T, 'dir'))
  })

  afterAll(() => {
    if (T) rmSync(T, { recursive: true, force: true })
  })

  it('RP-1 整条路径都存在：就是内核的答案（realpathSync.native）—— 文件、目录、临时根本身都一样', () => {
    for (const p of [join(T, 'real', 'a.txt'), join(T, 'real'), T]) {
      expect({ p, real: resolveRealPath(p) }).toEqual({ p, real: realpathSync.native(p) })
    }
    expect(resolveRealPath(join(T, 'real', 'a.txt'))).toBe(join(R, 'real', 'a.txt'))
  })

  it('RP-2 指向文件的链接被跟过去：绝对目标与相对目标（相对于链接所在目录）都一样', () => {
    for (const link of ['flink', 'rellink']) {
      const p = join(T, link)
      expect({ link, real: resolveRealPath(p) }).toEqual({ link, real: join(R, 'real', 'a.txt') })
      expect(resolveRealPath(p)).toBe(realpathSync.native(p))
    }
  })

  it('RP-3 路径中段是指向目录的链接：从链接那头接着往下走', () => {
    expect(resolveRealPath(join(T, 'dlink', 'a.txt'))).toBe(join(R, 'real', 'a.txt'))
    expect(resolveRealPath(join(T, 'dlink', 'sub'))).toBe(join(R, 'real', 'sub'))
  })

  it('RP-4 尾段还不存在（写一个新文件）：最近的存在的祖先解析过、其余段照写接上（`.` 与重复斜杠不留痕）', () => {
    expect(resolveRealPath(join(T, 'real', 'missing.txt'))).toBe(join(R, 'real', 'missing.txt'))
    // 祖先经过链接：新目录建在链接那头
    expect(resolveRealPath(join(T, 'dlink', 'new', 'deeper.txt'))).toBe(
      join(R, 'real', 'new', 'deeper.txt')
    )
    expect(resolveRealPath(`${T}/dlink/./new//x.txt`)).toBe(join(R, 'real', 'new', 'x.txt'))
  })

  it('RP-5 悬空链接照样跟过去，落在它将创建的目标上 —— 经它真写一次，文件就在预言的位置', () => {
    expect(resolveRealPath(join(T, 'dangling'))).toBe(join(R, 'real', 'not-yet.txt'))
    // 目标的上级目录也还不存在：一路接上
    expect(resolveRealPath(join(T, 'dangdir', 'x.txt'))).toBe(join(R, 'nowhere', 'sub', 'x.txt'))
    // 相对目标从链接所在目录（real/）起算，不是从进程 cwd
    expect(resolveRealPath(join(T, 'real', 'reldang'))).toBe(join(R, 'future', 'f.txt'))

    // 「写 <link> 就是创建它的目标」：预言在前，写入在后
    const predicted = resolveRealPath(join(T, 'dangling2'))
    expect(predicted).toBe(join(R, 'real', 'created-by-write.txt'))
    expect(existsSync(predicted)).toBe(false)
    writeFileSync(join(T, 'dangling2'), 'via the link')
    expect(existsSync(predicted)).toBe(true)
  })

  it('RP-6 链接链逐跳跟到底：以存在的目录收尾、以悬空目标收尾都一样', () => {
    expect(resolveRealPath(join(T, 'c1', 'a.txt'))).toBe(join(R, 'real', 'a.txt'))
    expect(resolveRealPath(join(T, 'c1', 'a.txt'))).toBe(
      realpathSync.native(join(T, 'c1', 'a.txt'))
    )
    expect(resolveRealPath(join(T, 'd1'))).toBe(join(R, 'gone', 'x'))
  })

  it('RP-7 链接环：不抛、会停，交出一个走到的位置 —— 内核对它是 ELOOP，这个名字放不过任何一次能成功的访问', () => {
    const looped = join(T, 'loopA', 'f')
    expect(() => realpathSync.native(looped)).toThrow(/ELOOP/)

    let result = ''
    expect(() => (result = resolveRealPath(looped))).not.toThrow()
    expect(isAbsolute(result)).toBe(true)
    // 停在哪一跳是实现细节；只要是环上的某个名字（写法或真实去处的前缀都可能）
    const onTheLoop = [T, R].flatMap((base) => [join(base, 'loopA', 'f'), join(base, 'loopB', 'f')])
    expect(onTheLoop).toContain(result)

    // 自己指向自己
    const self = resolveRealPath(join(T, 'self'))
    expect([join(T, 'self'), join(R, 'self')]).toContain(self)
  })

  it('RP-8 相对路径原样返回：它没有「通向哪里」可言（按进程 cwd 解析只会得到一个偶然的目录）', () => {
    for (const p of ['real/a.txt', './dlink/../x', '~/x', '']) {
      expect({ p, real: resolveRealPath(p) }).toEqual({ p, real: p })
    }
  })

  it('RP-9 大小写不敏感的卷上给出盘上的写法（链接、缺尾段一起）—— 卷区分大小写时跳过', (ctx) => {
    // 探一下这个卷：CaseFile.txt 换个大小写还找不找得到
    if (!existsSync(join(T, 'real', 'casefile.txt'))) ctx.skip()

    expect(resolveRealPath(join(T, 'REAL', 'casefile.txt'))).toBe(join(R, 'real', 'CaseFile.txt'))
    // JS 版 realpathSync 不纠正大小写 —— 这正是实现选 .native 的理由
    expect(realpathSync(join(T, 'REAL', 'casefile.txt'))).not.toBe(join(R, 'real', 'CaseFile.txt'))
    // 尾段不存在：存在的祖先照样换成盘上写法，新段照写
    expect(resolveRealPath(join(T, 'REAL', 'New.txt'))).toBe(join(R, 'real', 'New.txt'))
    // 大小写写错的链接名也被认出来、跟过去
    expect(resolveRealPath(join(T, 'DLINK', 'A.TXT'))).toBe(join(R, 'real', 'a.txt'))
  })

  it('RP-10 没有链接时 `..` 就是上一级：存在的与不存在的尾段都一样', () => {
    expect(resolveRealPath(`${T}/real/../top.txt`)).toBe(join(R, 'top.txt'))
    expect(resolveRealPath(`${T}/real/../top.txt`)).toBe(
      realpathSync.native(`${T}/real/../top.txt`)
    )
    expect(resolveRealPath(`${T}/real/../nope.txt`)).toBe(join(R, 'nope.txt'))
  })

  it('RP-10b `..` 按物理父目录走（先跟链接再退一级，同内核）—— 字面折叠会把它判回链接所在的目录', () => {
    // dir → real/sub：dir/.. 是 real，不是 T
    const existing = `${T}/dir/../a.txt`
    expect(resolveRealPath(existing)).toBe(join(R, 'real', 'a.txt'))
    expect(resolveRealPath(existing)).toBe(realpathSync.native(existing))
    // 字面折叠给的是另一个地方 —— 这就是「不能先 path.resolve」的那个坑
    expect(resolve(existing)).toBe(join(T, 'a.txt'))

    // 尾段不存在：同样按物理父目录
    expect(resolveRealPath(`${T}/dir/../new.txt`)).toBe(join(R, 'real', 'new.txt'))
    // 走到第一个不存在的段之后才按字面折叠（不存在的目录底下不会有链接）
    expect(resolveRealPath(`${T}/dir/missing/../../x`)).toBe(join(R, 'real', 'x'))

    // 与内核对账：经同一条写法真建一个文件，它就落在预言的位置，而不是字面折叠的那个
    const written = `${T}/dir/../made-by-kernel.txt`
    const predicted = resolveRealPath(written)
    expect(predicted).toBe(join(R, 'real', 'made-by-kernel.txt'))
    writeFileSync(written, 'k')
    expect(existsSync(predicted)).toBe(true)
    expect(existsSync(join(T, 'made-by-kernel.txt'))).toBe(false)
  })

  it('RP-11 幂等：解析结果再解析一次不变（门面与 inDir 会对同一个位置再解析）', () => {
    const inputs = [
      join(T, 'real', 'a.txt'),
      join(T, 'flink'),
      join(T, 'dlink', 'new', 'deeper.txt'),
      join(T, 'dangling'),
      join(T, 'd1'),
      `${T}/dir/../new.txt`,
      `${T}/dir/missing/../../x`,
      join(T, 'real', 'a.txt', 'child'),
      'relative/p'
    ]
    // 环不在此列：停在环上哪个名字是实现细节（RP-7），那个名字本来就打不开
    for (const p of inputs) {
      const once = resolveRealPath(p)
      expect({ p, twice: resolveRealPath(once) }).toEqual({ p, twice: once })
    }
  })

  it('RP-12 中段不是目录（文件底下再写段）：不抛，解析到那个文件为止，其余段照写接上', () => {
    const under = join(T, 'real', 'a.txt', 'child', 'x')
    // 内核在这里报 ENOTDIR —— 这一条走的是逐段那条路
    expect(() => realpathSync.native(under)).toThrow()
    expect(resolveRealPath(under)).toBe(join(R, 'real', 'a.txt', 'child', 'x'))
    // 经链接到文件再往下写段
    expect(resolveRealPath(join(T, 'flink', 'child'))).toBe(join(R, 'real', 'a.txt', 'child'))
  })
})
