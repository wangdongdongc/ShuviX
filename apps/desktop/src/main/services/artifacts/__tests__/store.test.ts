/**
 * 会话 Artifacts 的存储层（services/artifacts/store.ts）—— 真实临时目录，只把
 * `getSessionArtifactsDir` 指到 tmp。设计见 docs/session-artifacts-design.md。
 *
 * 钉在这里的都是「换个写法就会静默变坏」的那几条：
 *  - **标题锚在根元素上**：`<title>` 只认根 `<svg>` 的首个子元素。不锚住的话，给每根柱子写
 *    无障碍 tooltip（图表的正常写法）会让第一根柱子的 tooltip 抢走整张图的标题 —— 文件名
 *    与模型自以为的标题就此不一致。
 *  - **源码逐字节原样落盘**：认领这条路的全部价值是「模型一个字都不用重发」，所以落盘的
 *    必须是转写里那一份，不是被谁重新排版过的一份。
 *  - **文件名由标题 slug 化 + 去重，不由模型指定**：让模型挑路径等于让它有一天静默覆盖掉
 *    上一件。去重要保证第一件的字节不动 —— 那才是「不覆盖」的实质。
 *  - **白名单恰是六项**（`html` 曾被移出：那时没有渲染器，放行它只会留下一个模型手写、可能被
 *    双击以 `file://` 打开的页面。交互图沙箱补上了渲染器，落盘时又加了一行 CSP，它才回来）。
 *  - **目录不存在就是空**，读侧一律不创建目录：看一眼就结束的图在磁盘上什么都不留。
 *  - **`findArtifact` 先按文件名直判**，标题匹配是回退且**重名时拒绝而不是猜**。
 *  - **会话 id 守卫**：这是全仓唯一一条对该目录的递归删除，而 `artifact:read` 的 sessionId
 *    来自渲染端。
 *  - **html 落盘带一行 CSP**（AS-29…34，交互图认领后的样子）：双击用浏览器以 `file://` 打开时
 *    这一行生效、没有网络出口；它必须排在最前（前面不能有 BOM 或 doctype），其余字节原样。
 *    标题取**开头**那个 `<title>`（前面可以有那行 meta），而且先于 svg 的两条判 —— 块里画的一张
 *    SVG 自带的 aria-label / `<title>` 不锚开头，排在前面就会抢走整块的名字。
 *    （用例清单里这一组编号是 AS-17…22；本文件那几个号早已占用，顺延为 AS-29…34。）
 *
 * 顶桩纪律：凡是（直接或间接）import 了 store.ts 的测试文件都必须顶掉
 * `utils/paths` 的 `getSessionArtifactsDir` —— 漏一条的表现是**往真实 home 写盘**，
 * 所以文件末尾还有一道真实 home 哨兵（不靠人肉审查）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))

// 纯 factory，不走 importActual：utils/paths 顶层 `import { app } from 'electron'`，
// 展开会把 electron 拖进单测
vi.mock('../../../utils/paths', () => ({
  getSessionArtifactsDir: (sessionId: string) => `${state.root}/${sessionId}`
}))

import { SANDBOX_CSP } from '@shuvix/chat-protocol/utils/interactiveFence'
import {
  deleteSessionArtifacts,
  findArtifact,
  listArtifacts,
  readArtifact,
  titleOf,
  withStandaloneCsp,
  writeArtifact
} from '../store'

/** 真实 home 的 artifacts 根 —— 哨兵盯的就是它（不存在记 null） */
const HOME_ARTIFACTS = join(homedir(), '.shuvix', 'artifacts')
const homeSnapshot = (): string[] | null => {
  try {
    return readdirSync(HOME_ARTIFACTS).sort()
  } catch {
    return null
  }
}
let homeBefore: string[] | null = null

/** 每个用例一个新会话目录 —— 去重用例按目录实况探测，共用会污染出「为什么第一个就 -2 了」 */
let seq = 0
const newSession = (): string => `s${++seq}`

/** 目录里的全部条目（字典序）；目录不在给 null —— 「不该创建目录」一律比它 */
const entries = (sessionId: string): string[] | null => {
  try {
    return readdirSync(join(state.root, sessionId)).sort()
  } catch {
    return null
  }
}

beforeAll(() => {
  homeBefore = homeSnapshot()
  // realpath：macOS 的 /var/folders 是 /private/var 的符号链接，而 recordRead 按路径
  // **字符串**做键；两侧算出不同字符串时测的是符号链接，不是不变式
  state.root = join(realpathSync(mkdtempSync(join(tmpdir(), 'shuvix-artifacts-'))), 'artifacts')
})

afterAll(() => {
  // 哨兵：整个文件跑完，真实 home 的内容必须与开跑前逐项相等
  expect(homeSnapshot()).toEqual(homeBefore)
  rmSync(join(state.root, '..'), { recursive: true, force: true })
})

describe('titleOf —— 标题从内容里取，没有元数据文件', () => {
  it('AS-1 aria-label 优先于根 <title>（片段强制要求写其一，两个都有时取 aria-label）', () => {
    const svg = '<svg viewBox="0 0 4 4" aria-label="Requests by tier"><title>Fallback</title></svg>'
    expect(titleOf(svg, 'x.svg')).toBe('Requests by tier')
  })

  it('AS-2 根 <svg> 的首个子元素 <title> 命中（属性、换行、缩进都不妨碍）', () => {
    const svg = ['<svg viewBox="0 0 4 4">', '  <title id="t">Latency p99</title>', '</svg>'].join(
      '\n'
    )
    expect(titleOf(svg, 'x.svg')).toBe('Latency p99')
  })

  it('AS-3 嵌套的 per-bar tooltip 抢不走整张图的标题（回落文件名，而不是「bar 1」）', () => {
    // 给每根柱子写无障碍 tooltip 是图表的正常写法；没锚在根元素上的话，第一根柱子的
    // tooltip 就成了整张图的标题，文件名与模型自以为的标题就此不一致
    const svg = [
      '<svg viewBox="0 0 100 40">',
      '  <g>',
      '    <rect x="0" width="10" height="20"><title>bar 1</title></rect>',
      '    <rect x="20" width="10" height="30"><title>bar 2</title></rect>',
      '  </g>',
      '</svg>'
    ].join('\n')
    expect(titleOf(svg, 'by-tier.svg')).toBe('by-tier')
  })

  it('AS-4 markdown 取首个 `#`（后面的标题不参与）', () => {
    const md = ['前言一行', '', '# 迁移方案', '', '## 第一步', ''].join('\n')
    expect(titleOf(md, 'note.md')).toBe('迁移方案')
  })

  it('AS-5 都取不到 ⇒ 回落文件名主干（只去最后一段扩展名）', () => {
    expect(titleOf('plain text', 'notes.v2.txt')).toBe('notes.v2')
    expect(titleOf('', 'x.svg')).toBe('x')
  })

  it('AS-6 aria-label 是空白 ⇒ 继续往下回落，而不是交出一个空标题', () => {
    const svg = '<svg viewBox="0 0 4 4" aria-label="   "><title>Real title</title></svg>'
    expect(titleOf(svg, 'x.svg')).toBe('Real title')
    // 连 <title> 也空白时一路落到文件名
    expect(titleOf('<svg aria-label=" "><title>  </title></svg>', 'x.svg')).toBe('x')
  })
})

describe('writeArtifact —— 文件名由标题派生，内容原样落盘', () => {
  it('AS-7 源码逐字节原样落盘（CRLF / 制表符 / 尾随空格 / 控制字符 / 无尾换行都不动）', () => {
    // 认领这条路的全部价值是「模型一个字都不用重发」，所以落盘的必须是转写里那一份 ——
    // 任何重新排版都会让后续 `edit` 的 oldText 失配
    const content = '<svg>\r\n\t<rect/>  \n\x00tail-no-newline'
    const made = writeArtifact({
      sessionId: newSession(),
      title: 'Byte exact',
      ext: 'svg',
      content
    })
    expect(readFileSync(made.path)).toEqual(Buffer.from(content, 'utf-8'))
  })

  it('AS-8 目录首次写入才建（写之前不存在）', () => {
    const sid = newSession()
    expect(entries(sid)).toBeNull()
    writeArtifact({ sessionId: sid, title: 'First', ext: 'svg', content: '<svg/>' })
    expect(entries(sid)).toEqual(['first.svg'])
  })

  it('AS-9 中文标题直接当文件名（slug 保留任何语言的字母数字）', () => {
    const sid = newSession()
    const made = writeArtifact({
      sessionId: sid,
      title: '各档请求量 / QPS 对比',
      ext: 'svg',
      content: '<svg/>'
    })
    expect(made.name).toBe('各档请求量-qps-对比.svg')
    expect(entries(sid)).toEqual([made.name])
  })

  it('AS-10 路径穿越被 slug 掉，落点仍在会话目录内', () => {
    const sid = newSession()
    const made = writeArtifact({
      sessionId: sid,
      title: '../../.ssh/x',
      ext: 'txt',
      content: 'nope'
    })
    expect(made.name).toBe('ssh-x.txt')
    expect(made.path).toBe(join(state.root, sid, 'ssh-x.txt'))
    expect(entries(sid)).toEqual(['ssh-x.txt'])
  })

  it('AS-11 纯符号标题回落 `artifact`，不造出 `.svg` 这种隐藏文件', () => {
    const sid = newSession()
    const made = writeArtifact({
      sessionId: sid,
      title: '?!@#$%^&*()',
      ext: 'svg',
      content: '<svg/>'
    })
    expect(made.name).toBe('artifact.svg')
    // 空 stem 会写出一个点开头的文件：listArtifacts 过滤点文件，于是「写成功却列不出来」
    expect(made.name.startsWith('.')).toBe(false)
  })

  it('AS-12 同标题第二次得 `-2`，且第一件的字节一个都没变', () => {
    const sid = newSession()
    const first = writeArtifact({ sessionId: sid, title: 'Chart', ext: 'svg', content: 'ONE' })
    const second = writeArtifact({ sessionId: sid, title: 'Chart', ext: 'svg', content: 'TWO' })
    expect([first.name, second.name]).toEqual(['chart.svg', 'chart-2.svg'])
    // 「不由模型指定路径」买到的就是这一条：上一件不会被静默覆盖
    expect(readFileSync(first.path, 'utf-8')).toBe('ONE')
    expect(readFileSync(second.path, 'utf-8')).toBe('TWO')
    const third = writeArtifact({ sessionId: sid, title: 'Chart', ext: 'svg', content: 'THREE' })
    expect(third.name).toBe('chart-3.svg')
  })

  it('AS-13 同 stem 不同扩展名共存（去重按整个文件名判，不按主干）', () => {
    const sid = newSession()
    const svg = writeArtifact({ sessionId: sid, title: 'Report', ext: 'svg', content: '<svg/>' })
    const md = writeArtifact({ sessionId: sid, title: 'Report', ext: 'md', content: '# Report' })
    expect([svg.name, md.name]).toEqual(['report.svg', 'report.md'])
  })

  it('AS-14 ext 的大小写与点前缀都归一（`.SVG` ⇒ `svg`）', () => {
    const sid = newSession()
    expect(writeArtifact({ sessionId: sid, title: 'A', ext: '.SVG', content: '<svg/>' }).name).toBe(
      'a.svg'
    )
    expect(writeArtifact({ sessionId: sid, title: 'B', ext: 'Md', content: '# B' }).name).toBe(
      'b.md'
    )
  })

  it('AS-15 非法 ext 抛错，且抛错前一个目录都没建', () => {
    const sid = newSession()
    expect(() =>
      writeArtifact({ sessionId: sid, title: 'Page', ext: 'exe', content: 'MZ' })
    ).toThrow(/Unsupported artifact type/)
    // 校验在 mkdirSync 之前：否则一次失败的 create 也会留下一个空目录
    expect(entries(sid)).toBeNull()
  })

  it('AS-16 白名单恰为六项：svg / md / txt / csv / json / html', () => {
    const sid = newSession()
    const allowed = ['svg', 'md', 'txt', 'csv', 'json', 'html']
    for (const ext of allowed) {
      expect(writeArtifact({ sessionId: sid, title: ext, ext, content: 'x' }).name).toBe(
        `${ext}.${ext}`
      )
    }
    // 报错文案就是这份名单的唯一读面（ALLOWED_EXT 是模块私有）—— 顺序与内容一起钉
    let message = ''
    try {
      writeArtifact({ sessionId: sid, title: 'X', ext: 'exe', content: 'x' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toBe(
      'Unsupported artifact type ".exe" (allowed: svg, md, txt, csv, json, html)'
    )
    for (const ext of ['js', 'htm', 'xhtml', '']) {
      expect(() => writeArtifact({ sessionId: sid, title: 'X', ext, content: 'x' })).toThrow(
        /Unsupported artifact type/
      )
    }
    expect(entries(sid)?.sort()).toEqual(allowed.map((e) => `${e}.${e}`).sort())
  })
})

describe('listArtifacts —— 目录不存在就是空，读侧一律不创建目录', () => {
  it('AS-17 目录不存在 ⇒ [] 且不创建目录', () => {
    const sid = newSession()
    expect(listArtifacts(sid)).toEqual([])
    expect(entries(sid)).toBeNull()
  })

  it('AS-18 排除子目录与点文件（第 2 期要在目录里 git init，`.git` 必须不进列表）', () => {
    const sid = newSession()
    writeArtifact({ sessionId: sid, title: 'Beta', ext: 'svg', content: '<svg/>' })
    writeArtifact({ sessionId: sid, title: 'Alpha', ext: 'md', content: '# Alpha title' })
    const dir = join(state.root, sid)
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main')
    writeFileSync(join(dir, '.DS_Store'), 'junk')
    mkdirSync(join(dir, 'nested'))

    const listed = listArtifacts(sid)
    expect(listed.map((a) => a.name)).toEqual(['alpha.md', 'beta.svg'])
    expect(listed[0]).toEqual({
      name: 'alpha.md',
      title: 'Alpha title',
      path: join(dir, 'alpha.md')
    })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'AS-19 单个文件读失败不炸整表（标题退回文件名主干）',
    () => {
      const sid = newSession()
      const ok = writeArtifact({ sessionId: sid, title: 'Readable', ext: 'md', content: '# Fine' })
      const bad = writeArtifact({ sessionId: sid, title: 'Locked', ext: 'svg', content: '<svg/>' })
      chmodSync(bad.path, 0o000)
      try {
        const listed = listArtifacts(sid)
        expect(listed.map((a) => [a.name, a.title])).toEqual([
          ['locked.svg', 'locked'],
          ['readable.md', 'Fine']
        ])
        expect(listed.map((a) => a.path)).toContain(ok.path)
      } finally {
        chmodSync(bad.path, 0o600)
      }
    }
  )

  it('AS-20 不安全的会话 id ⇒ []（不 readdir 目录之外的东西）', () => {
    // 守卫在 listArtifacts 顶部；下面 AS-28 钉的是同一条守卫在删除侧的作用
    for (const id of ['..', '.', 'a/b', 'a\\b', 'x/../../y', '']) {
      expect(listArtifacts(id)).toEqual([])
    }
  })
})

describe('findArtifact —— 文件名直判优先，标题是回退且重名时拒绝', () => {
  it('AS-21 文件名命中先于标题扫描（标题有歧义也照样命中）、且大小写不敏感', () => {
    const sid = newSession()
    // 两件的标题都是 "same"：走标题回退必然拒绝（AS-23）。按名字问还能拿到，
    // 就证明文件名那一步直接短路了标题扫描 —— 原先一条引用要 2N+1 次全文读
    writeArtifact({
      sessionId: sid,
      title: 'target',
      ext: 'svg',
      content: '<svg aria-label="same"/>'
    })
    writeArtifact({
      sessionId: sid,
      title: 'decoy',
      ext: 'svg',
      content: '<svg aria-label="same"/>'
    })
    expect(findArtifact(sid, 'target.svg')?.name).toBe('target.svg')
    expect(findArtifact(sid, 'TARGET.SVG')?.name).toBe('target.svg')
    expect(findArtifact(sid, '  target.svg  ')?.name).toBe('target.svg')
    // 标题仍然算出来了（回执/引用头要显示它）
    expect(findArtifact(sid, 'target.svg')?.title).toBe('same')
  })

  it('AS-22 标题命中（模型可能在围栏里写标题而不是文件名）', () => {
    const sid = newSession()
    const made = writeArtifact({
      sessionId: sid,
      title: 'Requests by tier',
      ext: 'svg',
      content: '<svg aria-label="Requests by tier"/>'
    })
    expect(findArtifact(sid, 'Requests by tier')?.name).toBe(made.name)
    expect(findArtifact(sid, 'requests BY tier')?.name).toBe(made.name)
  })

  it('AS-23 标题重名 ⇒ null（拒绝而不是猜）', () => {
    const sid = newSession()
    writeArtifact({ sessionId: sid, title: 'a', ext: 'svg', content: '<svg aria-label="Dup"/>' })
    writeArtifact({ sessionId: sid, title: 'b', ext: 'svg', content: '<svg aria-label="Dup"/>' })
    // 猜的话取到的是按 localeCompare 排序的产物：既不是最早也不是最新那件，还会随件数跳变
    expect(findArtifact(sid, 'Dup')).toBeNull()
  })

  it('AS-24 查不到 / 空名 / 目录不存在 ⇒ null', () => {
    const sid = newSession()
    writeArtifact({ sessionId: sid, title: 'only', ext: 'svg', content: '<svg/>' })
    expect(findArtifact(sid, 'missing.svg')).toBeNull()
    expect(findArtifact(sid, '')).toBeNull()
    expect(findArtifact(sid, '   ')).toBeNull()
    expect(findArtifact(newSession(), 'anything.svg')).toBeNull()
  })
})

describe('readArtifact —— 现取盘上内容，不缓存', () => {
  it('AS-25 改盘之后拿到的是新内容；查不到回 null', () => {
    const sid = newSession()
    const made = writeArtifact({ sessionId: sid, title: 'Live', ext: 'svg', content: 'v1' })
    expect(readArtifact(sid, made.name)).toBe('v1')
    // `edit` 之后再发一条同名引用就该展示新版 —— 这一步是那条链的底
    writeFileSync(made.path, 'v2', 'utf-8')
    expect(readArtifact(sid, made.name)).toBe('v2')
    expect(readArtifact(sid, 'nope.svg')).toBeNull()
  })
})

describe('deleteSessionArtifacts —— 会话删除时的级联', () => {
  it('AS-26 整个目录删掉（含子目录与点文件）', () => {
    const sid = newSession()
    writeArtifact({ sessionId: sid, title: 'Doomed', ext: 'svg', content: '<svg/>' })
    const dir = join(state.root, sid)
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref')
    deleteSessionArtifacts(sid)
    expect(existsSync(dir)).toBe(false)
  })

  it('AS-27 目录不存在 ⇒ no-op，不抛（多数会话一件都没有）', () => {
    const sid = newSession()
    expect(() => deleteSessionArtifacts(sid)).not.toThrow()
    expect(entries(sid)).toBeNull()
  })

  it('AS-28 不安全的会话 id ⇒ 一律不动手（这是全仓唯一一条对该目录的递归删除）', () => {
    // 哨兵落在 artifacts 根的**父目录**里：`'..'` 若被放行，rmSync 会把它连根删掉
    const outside = join(state.root, '..', 'must-survive.txt')
    writeFileSync(outside, 'keep me', 'utf-8')
    const sid = newSession()
    writeArtifact({ sessionId: sid, title: 'Sibling', ext: 'svg', content: '<svg/>' })
    const nested = join(state.root, 'holder', 'child')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'k.txt'), 'keep', 'utf-8')

    for (const id of ['..', '.', 'holder/child', 'holder\\child', 'holder/../..', '']) {
      deleteSessionArtifacts(id)
    }
    expect(readFileSync(outside, 'utf-8')).toBe('keep me')
    expect(readFileSync(join(nested, 'k.txt'), 'utf-8')).toBe('keep')
    expect(entries(sid)).toEqual(['sibling.svg'])
  })
})

/** html artifact 开头那一行（与沙箱的 SANDBOX_CSP 同一条）—— 按契约自己拼，不从被测模块取 */
const CSP_LINE = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`

describe('html artifact —— 落盘带一行 CSP，标题取开头的 <title>', () => {
  it('AS-29 写 html：文件 = CSP 那一行 + 换行 + 内容（逐字节）；前面没有 BOM、没有 doctype', () => {
    const sid = newSession()
    const content = '<title>Growth</title>\r\n<p>a &amp; b\t中文</p>\n<script>1</script>'
    const made = writeArtifact({ sessionId: sid, title: 'Growth', ext: 'html', content })
    const bytes = readFileSync(made.path)
    expect(bytes.equals(Buffer.from(`${CSP_LINE}\n${content}`, 'utf-8'))).toBe(true)
    expect(bytes[0]).toBe('<'.charCodeAt(0)) // 没有 BOM
    expect(bytes.toString('utf-8').startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(
      true
    )
    expect(made.title).toBe('Growth')
  })

  it('AS-30 ext 先归一再判：HTML / .html / .HTML 都落成 *.html 且带 CSP；别的类型里就算是 html 也原样落盘、不加', () => {
    const sid = newSession()
    for (const [i, ext] of ['HTML', '.html', '.HTML'].entries()) {
      const made = writeArtifact({ sessionId: sid, title: `page ${i}`, ext, content: '<p>x</p>' })
      expect(made.name, ext).toBe(`page-${i}.html`)
      expect(readFileSync(made.path, 'utf-8'), ext).toBe(`${CSP_LINE}\n<p>x</p>`)
    }
    const htmlish = '<title>x</title><script>alert(1)</script>'
    for (const ext of ['svg', 'md', 'txt', 'csv', 'json']) {
      const made = writeArtifact({ sessionId: sid, title: `other ${ext}`, ext, content: htmlish })
      expect(readFileSync(made.path, 'utf-8'), ext).toBe(htmlish)
    }
  })

  it('AS-31 块里画了一张带 <title> / aria-label 的 SVG：整块的名字仍取开头那个 <title>', () => {
    const innerTitle =
      '<title>Dashboard</title><div><svg viewBox="0 0 4 4"><title>Bars</title><rect/></svg></div>'
    expect(titleOf(innerTitle, 'x.html')).toBe('Dashboard')
    const innerAria =
      '<title>Dashboard</title>\n<svg viewBox="0 0 4 4" role="img" aria-label="Bars chart"><rect/></svg>'
    expect(titleOf(innerAria, 'x.html')).toBe('Dashboard')
  })

  it('AS-32 开头的 <title>：前面可以有那行 meta 或空白；不在开头就不算；首尾空白去掉；空的回落文件名主干', () => {
    expect(titleOf('<title>Growth</title><p>x</p>', 'g.html')).toBe('Growth')
    expect(titleOf(`${CSP_LINE}\n<title>Growth</title><p>x</p>`, 'g.html')).toBe('Growth')
    expect(titleOf('\n  \t<title>Growth</title>', 'g.html')).toBe('Growth')
    expect(titleOf('<p>intro</p><title>Growth</title>', 'late.html')).toBe('late')
    expect(titleOf('<title>  G  </title>', 'g.html')).toBe('G')
    expect(titleOf('<title></title><p>x</p>', 'empty.html')).toBe('empty')
    // 反过来不误伤 svg：svg 文件以 <svg 开头，锚在开头的那一条匹配不上，照旧取 aria-label
    expect(titleOf('<svg viewBox="0 0 4 4" aria-label="Svg title"/>', 'x.svg')).toBe('Svg title')
  })

  it('AS-33 withStandaloneCsp 幂等：套两次与套一次相同；已以那行开头的原样；那行在中间或前面多一个换行时再加一行（钉住现状）', () => {
    const x = '<title>T</title><p>x</p>'
    const once = withStandaloneCsp(x)
    expect(once).toBe(`${CSP_LINE}\n${x}`)
    expect(withStandaloneCsp(once)).toBe(once)
    expect(withStandaloneCsp(`${CSP_LINE}<p>no newline</p>`)).toBe(`${CSP_LINE}<p>no newline</p>`)
    // 只认**开头**：出现在中间、或前面多了一个换行，都当作没有 —— 再加一行在最前
    const mid = `<p>x</p>\n${CSP_LINE}\n`
    expect(withStandaloneCsp(mid)).toBe(`${CSP_LINE}\n${mid}`)
    const leadingNewline = `\n${CSP_LINE}\n<p>x</p>`
    expect(withStandaloneCsp(leadingNewline)).toBe(`${CSP_LINE}\n${leadingNewline}`)
  })

  it('AS-34 读侧：list / find 的标题取 <title>（跳过那行 meta），read 回的内容以 CSP 那行开头', () => {
    const sid = newSession()
    const made = writeArtifact({
      sessionId: sid,
      title: 'Whatever',
      ext: 'html',
      content: '<title>Growth chart</title><p>x</p>'
    })
    expect(listArtifacts(sid).map((a) => [a.name, a.title])).toEqual([
      ['whatever.html', 'Growth chart']
    ])
    expect(findArtifact(sid, 'whatever.html')?.title).toBe('Growth chart')
    expect(findArtifact(sid, 'growth chart')?.name).toBe(made.name)
    expect(readArtifact(sid, made.name)?.startsWith(`${CSP_LINE}\n`)).toBe(true)
  })
})
