/**
 * nodeFileSystemPort.readLink —— 文件工具「不跟符号链接」问的那一句（桌面 port，见 fileToolSuite 的
 * refuseSymlink）。
 *
 * 真实临时目录树 + 真符号链接，不打任何桩。readLink 只看路径的**最后一段**是不是链接（lstat 语义：
 * 中间段照常跟、`..` 取物理父目录）：是 → `{ target: 链接里存的原文, resolved: 它最终通向的绝对路径 }`，
 * 不是 / 不存在 → null。resolved 与路径门用的是同一个解析（resolveRealPath），所以期望整条都存在时对照
 * `realpathSync.native`，悬空时按「最近的存在的祖先解析过、其余段照写接上」写。
 *
 * macOS 上 tmpdir 在 /var → /private/var 这条系统级链接之下：写法从 T 起算、期望从
 * R = realpathSync.native(T) 起算（同 realPath.test.ts）。符号链接在 Windows 上要开发者模式，整份跳过。
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
import { isAbsolute, join } from 'node:path'
import { nodeFileSystemPort } from '../nodeFileSystemPort'
import { resolveRealPath } from '../realPath'

/** 写法（tmpdir 原样）与真实去处（内核给的） */
let T = ''
let R = ''

type LinkInfo = { target: string; resolved: string } | null

/** 桌面 port 必须带 readLink（扩展端才省略）；这里拿不到就直接判红 */
function readLink(p: string): Promise<LinkInfo> {
  if (!nodeFileSystemPort.readLink) throw new Error('the desktop port must implement readLink')
  return nodeFileSystemPort.readLink(p)
}

describe.skipIf(process.platform === 'win32')('nodeFileSystemPort.readLink', () => {
  /**
   * 目录树（T 下）：
   *   top.txt
   *   real/a.txt、real/sub/、real/inner → a.txt（相对、文件）、real/reldang → ../future/f.txt（相对、悬空）
   *   flink → T/real/a.txt（绝对、文件）            rellink → real/a.txt（相对、文件）
   *   dlink → T/real（目录）
   *   dangling → T/real/not-yet.txt                 dangdeep → T/nowhere/sub/x.txt（上级目录都不存在）
   *   c1 → c2、c2 → T/c3、c3 → real/a.txt（链，以文件收尾）；d1 → T/d2、d2 → T/gone/x（链，悬空收尾）
   *   dir → T/real/sub（`..` 走物理父目录：dir/.. 是 real，不是 T）
   *   lnk2 → real/a.txt（只在 T 这一层有；real/ 下没有同名条目）
   *   loopA ⇄ loopB、self → self（环）
   */
  beforeAll(() => {
    T = mkdtempSync(join(tmpdir(), 'shuvix-nfp-'))
    R = realpathSync.native(T)
    mkdirSync(join(T, 'real', 'sub'), { recursive: true })
    writeFileSync(join(T, 'top.txt'), 'top')
    writeFileSync(join(T, 'real', 'a.txt'), 'a')
    symlinkSync('a.txt', join(T, 'real', 'inner'))
    symlinkSync('../future/f.txt', join(T, 'real', 'reldang'))
    symlinkSync(join(T, 'real', 'a.txt'), join(T, 'flink'))
    symlinkSync('real/a.txt', join(T, 'rellink'))
    symlinkSync(join(T, 'real'), join(T, 'dlink'))
    symlinkSync(join(T, 'real', 'not-yet.txt'), join(T, 'dangling'))
    symlinkSync(join(T, 'nowhere', 'sub', 'x.txt'), join(T, 'dangdeep'))
    symlinkSync('c2', join(T, 'c1'))
    symlinkSync(join(T, 'c3'), join(T, 'c2'))
    symlinkSync('real/a.txt', join(T, 'c3'))
    symlinkSync(join(T, 'd2'), join(T, 'd1'))
    symlinkSync(join(T, 'gone', 'x'), join(T, 'd2'))
    symlinkSync(join(T, 'real', 'sub'), join(T, 'dir'))
    symlinkSync('real/a.txt', join(T, 'lnk2'))
    symlinkSync(join(T, 'loopB'), join(T, 'loopA'))
    symlinkSync(join(T, 'loopA'), join(T, 'loopB'))
    symlinkSync(join(T, 'self'), join(T, 'self'))
  })

  afterAll(() => {
    if (T) rmSync(T, { recursive: true, force: true })
  })

  it('NFP-1 不是链接一律 null：普通文件、目录、T 本身（中段隔着 /var 也一样）、不存在的、中段不是目录的（ENOTDIR）', async () => {
    expect(typeof nodeFileSystemPort.readLink).toBe('function')
    for (const p of [
      join(T, 'top.txt'),
      join(T, 'real'),
      T,
      R,
      join(T, 'nope'),
      join(T, 'nope', 'deeper'),
      join(T, 'top.txt', 'child')
    ]) {
      expect({ p, link: await readLink(p) }).toEqual({ p, link: null })
    }
  })

  it('NFP-2 指向文件的链接：target 是链接里存的原文（绝对、相对都原样），resolved 是内核的答案', async () => {
    expect(await readLink(join(T, 'flink'))).toEqual({
      target: join(T, 'real', 'a.txt'),
      resolved: join(R, 'real', 'a.txt')
    })
    expect(await readLink(join(T, 'rellink'))).toEqual({
      target: 'real/a.txt',
      resolved: join(R, 'real', 'a.txt')
    })
    for (const name of ['flink', 'rellink']) {
      const p = join(T, name)
      expect({ name, resolved: (await readLink(p))?.resolved }).toEqual({
        name,
        resolved: realpathSync.native(p)
      })
    }
  })

  it('NFP-3 指向目录的链接同样是链接：resolved 是那个目录的真实位置', async () => {
    expect(await readLink(join(T, 'dlink'))).toEqual({
      target: join(T, 'real'),
      resolved: join(R, 'real')
    })
    expect((await readLink(join(T, 'dlink')))?.resolved).toBe(realpathSync.native(join(T, 'dlink')))
  })

  it('NFP-4 悬空链接也是链接：resolved 落在它将创建的目标上（上级目录缺着也照写接上，且一个都不建）；相对原文从链接所在的目录起算，不是进程 cwd', async () => {
    expect(await readLink(join(T, 'dangling'))).toEqual({
      target: join(T, 'real', 'not-yet.txt'),
      resolved: join(R, 'real', 'not-yet.txt')
    })
    expect(await readLink(join(T, 'dangdeep'))).toEqual({
      target: join(T, 'nowhere', 'sub', 'x.txt'),
      resolved: join(R, 'nowhere', 'sub', 'x.txt')
    })
    // 问一句不建任何东西
    expect(existsSync(join(T, 'real', 'not-yet.txt'))).toBe(false)
    expect(existsSync(join(T, 'nowhere'))).toBe(false)

    // real/reldang → ../future/f.txt：从 real/ 起算是 T/future/f.txt
    expect(await readLink(join(T, 'real', 'reldang'))).toEqual({
      target: '../future/f.txt',
      resolved: join(R, 'future', 'f.txt')
    })
    expect(existsSync(join(T, 'future'))).toBe(false)
  })

  it('NFP-5 链接链：target 是第一跳的原文，resolved 是整条链的尽头 —— 以文件收尾、以悬空目标收尾都一样', async () => {
    expect(await readLink(join(T, 'c1'))).toEqual({
      target: 'c2',
      resolved: join(R, 'real', 'a.txt')
    })
    expect(await readLink(join(T, 'd1'))).toEqual({
      target: join(T, 'd2'),
      resolved: join(R, 'gone', 'x')
    })
  })

  it('NFP-6 只看最后一段：经链接目录走到的真文件 / 真目录是 null，走到的链接照样认出；`..` 取物理父目录（先跟链接再退一级）', async () => {
    // 中段是链接、最后一段是真的
    expect(await readLink(join(T, 'dlink', 'a.txt'))).toBeNull()
    expect(await readLink(join(T, 'dlink', 'sub'))).toBeNull()
    // 中段是链接、最后一段也是链接（real/inner → a.txt，原文从它自己的目录 real/ 起算）
    expect(await readLink(join(T, 'dlink', 'inner'))).toEqual({
      target: 'a.txt',
      resolved: join(R, 'real', 'a.txt')
    })

    // dir → real/sub，所以 dir/.. 是 real：dir/../inner 物理上就是 real/inner 这条链接 ——
    // 字面折叠会得到 T/inner，那里什么都没有
    expect(existsSync(join(T, 'inner'))).toBe(false)
    expect(await readLink(`${T}/dir/../inner`)).toEqual({
      target: 'a.txt',
      resolved: join(R, 'real', 'a.txt')
    })
    // 反过来：T/lnk2 是链接，可 dir/../lnk2 物理上是 real/lnk2（不存在）
    expect(await readLink(join(T, 'lnk2'))).not.toBeNull()
    expect(await readLink(`${T}/dir/../lnk2`)).toBeNull()
  })

  it('NFP-7 resolved 与路径门用的是同一个解析（resolveRealPath），且恒为绝对路径', async () => {
    for (const name of [
      'flink',
      'rellink',
      'dlink',
      'dangling',
      'dangdeep',
      join('real', 'reldang'),
      join('dlink', 'inner'),
      'c1',
      'd1',
      'loopA',
      'self'
    ]) {
      const p = join(T, name)
      const got = await readLink(p)
      expect({ name, resolved: got?.resolved }).toEqual({ name, resolved: resolveRealPath(p) })
      expect(isAbsolute(got?.resolved ?? ''), name).toBe(true)
    }
  })

  it('NFP-8 链接环：不抛、不挂，照样答它是链接 —— target 是原文，resolved 是环上的某个名字（停在哪一跳是 resolveRealPath 的细节）', async () => {
    const a = await readLink(join(T, 'loopA'))
    expect(a?.target).toBe(join(T, 'loopB'))
    const onTheLoop = [T, R].flatMap((base) => [join(base, 'loopA'), join(base, 'loopB')])
    expect(onTheLoop).toContain(a?.resolved)

    const self = await readLink(join(T, 'self'))
    expect(self?.target).toBe(join(T, 'self'))
    expect([join(T, 'self'), join(R, 'self')]).toContain(self?.resolved)
  })

  it('NFP-9 大小写不敏感的卷：大小写写错的链接名照样认出是链接（换个写法绕不过去）—— 卷区分大小写时跳过', async (ctx) => {
    if (!existsSync(join(T, 'TOP.TXT'))) ctx.skip()
    expect(await readLink(join(T, 'DLINK'))).toEqual({
      target: join(T, 'real'),
      resolved: join(R, 'real')
    })
    expect(await readLink(join(T, 'FLink'))).toEqual({
      target: join(T, 'real', 'a.txt'),
      resolved: join(R, 'real', 'a.txt')
    })
  })

  it('NFP-10 结尾的 `/`、`/.`（及其重复）不改变最后一段是谁：dlink/、dlink/.、dlink//、dlink/./ 答的都是 dlink 这条链接；dlink/.. 是链接那头的父目录 → null；真目录带结尾斜杠、`/` 本身都是 null', async () => {
    const dlink = await readLink(join(T, 'dlink'))
    expect(dlink).not.toBeNull()
    for (const p of [
      `${T}/dlink/`,
      `${T}/dlink/.`,
      `${T}/dlink//`,
      `${T}/dlink/./`,
      `${T}/dlink/./.`
    ]) {
      expect({ p, link: await readLink(p) }).toEqual({ p, link: dlink })
    }
    // `..` 不在「不改变指向」之列：它是链接那头（real）的父目录，一个真目录
    expect(await readLink(`${T}/dlink/..`)).toBeNull()
    expect(await readLink(`${T}/real/`)).toBeNull()
    expect(await readLink(`${T}/real/.`)).toBeNull()
    // 整条都是分隔符：去掉结尾之后是空串，退回原样去问，不抛
    expect(await readLink('/')).toBeNull()
  })
})
