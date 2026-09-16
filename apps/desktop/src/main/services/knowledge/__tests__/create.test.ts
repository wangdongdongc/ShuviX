/**
 * create —— 侧栏三个「新建」的宿主侧：知识库（用户根下一个目录）、文件夹（库本身或库里任意一层下面）、
 * 条目（一份 md）。钉三件事：
 *
 *   **写严那一半不打折** —— 新条目的元数据与 `knowledge` 工具的 `create` 同一套（自述行在最前、固定键序、
 *   归一的 type / status），文件名按标题 slug 派生并去重，正文留空；`generated` 是机器生成那一章，手建的
 *   **不盖**，是谁建的记在 git 的 `Knowledge-Actor: human` 上。
 *
 *   **落点只收清单里已有的目录** —— `resolveDir` 逐段按目录清单精确匹配（大小写敏感 + NFC），容器本身、
 *   隐藏段、`..`、不存在的库、条目文件的路径一律不是落点，且**拒绝就是拒绝**：不抛、不建、不留半个文件。
 *
 *   **名字按最严的平台收** —— 在 macOS 上建出来的库不该在 Windows 上打不开；重名按大小写不敏感 + NFC 比
 *   （与 base 解析同口径），同名的文件也算占用。
 *
 * 变更管线（去抖 300ms + git）换成 spy：这里验的是「记了哪一条」，提交本身在 changes.test.ts 里。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))
/** 变更管线的替身：去抖与 git 在 changes.test.ts 里验，这里只看「记了哪一条」 */
const recordChange = vi.hoisted(() => vi.fn())

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  // 内置库根替身：不存在的兄弟目录 —— 这些用例里没有内置库
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// 失败原因要原样回到界面：替身回 key 本身，带 name 的那条把参数缀在后面 —— 断言里看得见「是哪一个名字重了」
vi.mock('../../../i18n', () => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    vars?.name === undefined ? key : `${key}:${String(vars.name)}`
}))
vi.mock('../changes', () => ({ recordKnowledgeChange: recordChange }))

import { appEventBus } from '../../../utils/appEventBus'
import { createKnowledgeBase, createKnowledgeEntry, createKnowledgeFolder } from '../create'
import { invalidateKnowledgeScan, listBundles } from '../scan'
import {
  builtinRootOf,
  makeTempRoot,
  seedBuiltinConcept,
  seedFile,
  treeOf,
  userRootOf
} from './fixture'

const INVALID = 'knowledge.errInvalidName'
const NO_SUCH_DIR = 'knowledge.errNoSuchDir'
// 保留名的原因带着名字（`project` / `shuvix` 共用一条文案）—— 替身把参数缀在 key 后面
const RESERVED = 'knowledge.errReserved:project'
const RESERVED_BUILTIN = 'knowledge.errReserved:shuvix'
// 内置库只读：文件在应用包里，不带名字（哪个库不重要，只读就是只读）
const READ_ONLY = 'knowledge.errReadOnly'
const EMPTY_TITLE = 'knowledge.errEmptyTitle'
const taken = (name: string): string => `knowledge.errNameTaken:${name}`

/** 本期唯一的内置库 —— bundle id 的首段是保留容器名 `builtin`，磁盘上没有对应目录 */
const BUILTIN = 'builtin/shuvix'

/**
 * 同一个两段 id 的几种写法：归一（`normalizeBundlePath`：反斜杠、前导 `./`、重复斜杠、前导 `/`）
 * 之后都是同一个 id。只读那一道与落点解析必须用**同一套**归一 —— 两套归一之间就有一条绕过去的路。
 */
const spellingsOf = (a: string, b: string): string[] => [
  `./${a}/${b}`,
  `.\\${a}\\${b}`,
  `.//${a}/${b}`,
  `/${a}/${b}`,
  `${a}\\${b}`
]

let root: string
let userRoot: string
let builtinRoot: string
let events: unknown[]
let unsubscribe: () => void

/** 两个根此刻的全貌 —— 「磁盘没有多出东西」一律比它 */
const disk = (): { shuvix: string[]; user: string[] } => ({
  shuvix: treeOf(root),
  user: treeOf(userRoot)
})

/**
 * 种一个**真解析得到**的内置库：只读那一道要拒的是「本来能落进去的落点」，库不存在的话
 * 拒不拒都一样（`errNoSuchDir`），断言就白写了。只种 en 那一版 —— `builtinLanguageDir` 对任何
 * 界面语言都回落到它，语言便与这些用例无关（真正切语言在 entries.test.ts 的 EN-11）。
 */
const seedBuiltinBase = (): void => {
  seedBuiltinConcept(root, 'shuvix/en/guide.md', ['type: Memory', 'title: Guide'])
  seedBuiltinConcept(root, 'shuvix/en/sub/deep.md', ['type: Memory', 'title: Deep'])
}

beforeEach(() => {
  root = makeTempRoot()
  userRoot = userRootOf(root)
  builtinRoot = builtinRootOf(root)
  state.root = root
  invalidateKnowledgeScan()
  recordChange.mockClear()
  events = []
  unsubscribe = appEventBus.subscribe((e) => {
    if (e.type === 'knowledge.changed') events.push(e)
  })
})

afterEach(() => {
  unsubscribe()
  rmSync(root, { recursive: true, force: true })
  rmSync(userRoot, { recursive: true, force: true })
  // 内置根也是 root 的兄弟目录：种过内置库的用例得自己收拾
  rmSync(builtinRoot, { recursive: true, force: true })
})

describe('createKnowledgeEntry', () => {
  it('CR-1 新建条目：文件名按标题 slug 派生，元数据与工具 create 同一套 —— 自述行在最前、type Memory、status draft、正文空、不盖 generated；记一条 Creation 变更，署名 human', () => {
    mkdirSync(join(userRoot, 'notes'), { recursive: true })

    expect(createKnowledgeEntry('knowledge/notes', 'My Note')).toEqual({
      success: true,
      id: 'knowledge/notes/my-note.md'
    })

    const text = readFileSync(join(userRoot, 'notes', 'my-note.md'), 'utf-8')
    // 自述行在最前、键序固定、正文空：属性卡按 `shuvix:` 这一行认条目，少一个键就少一张卡
    expect(text).toBe('---\nshuvix: okf v0.2\ntype: Memory\ntitle: My Note\nstatus: draft\n---\n\n')
    // generated 记的是机器生成 —— 人建的不盖章（谁建的在 git 的 Knowledge-Actor 上）
    expect(text).not.toContain('generated')

    expect(recordChange).toHaveBeenCalledTimes(1)
    expect(recordChange).toHaveBeenCalledWith({
      bundle: 'knowledge/notes',
      path: 'my-note.md',
      op: 'Creation',
      actor: 'human'
    })
    // 广播是变更管线的事（提交落地之后），建条目自己不发
    expect(events).toEqual([])
    expect(disk()).toEqual({ shuvix: [], user: ['notes/', 'notes/my-note.md'] })
  })

  it('CR-8 条目文件名去重：同标题第二条落 -2；slug 撞上保留名 index.md / log.md 直接让开（磁盘上没有也让）', () => {
    mkdirSync(join(userRoot, 'notes'), { recursive: true })

    expect(createKnowledgeEntry('knowledge/notes', 'T').id).toBe('knowledge/notes/t.md')
    expect(createKnowledgeEntry('knowledge/notes', 'T').id).toBe('knowledge/notes/t-2.md')
    // index.md / log.md 是 OKF 的保留名：slugify('Index') 正好撞上，让开一格
    expect(createKnowledgeEntry('knowledge/notes', 'Index').id).toBe('knowledge/notes/index-2.md')
    expect(createKnowledgeEntry('knowledge/notes', 'Log').id).toBe('knowledge/notes/log-2.md')

    expect(disk().user).toEqual([
      'notes/',
      'notes/index-2.md',
      'notes/log-2.md',
      'notes/t-2.md',
      'notes/t.md'
    ])
  })

  it('CR-9 标题不是名字：空标题拒；标题里的非法字符经 slug 归一，文件恒落在目标目录内；纯标点标题回落 entry.md', () => {
    const notes = join(userRoot, 'notes')
    mkdirSync(notes, { recursive: true })

    for (const title of ['', '   ']) {
      expect(createKnowledgeEntry('knowledge/notes', title), title).toEqual({
        success: false,
        error: EMPTY_TITLE
      })
    }
    expect(recordChange).not.toHaveBeenCalled()
    expect(disk()).toEqual({ shuvix: [], user: ['notes/'] })

    // 路径分隔与点段都是 slug 的普通字符：文件恒落在目标目录里，不会「穿出去」
    expect(createKnowledgeEntry('knowledge/notes', '../../etc/passwd')).toEqual({
      success: true,
      id: 'knowledge/notes/etc-passwd.md'
    })
    expect(readdirSync(notes)).toEqual(['etc-passwd.md'])

    expect(createKnowledgeEntry('knowledge/notes', '!!!')).toEqual({
      success: true,
      id: 'knowledge/notes/entry.md'
    })
    expect(disk()).toEqual({
      shuvix: [],
      user: ['notes/', 'notes/entry.md', 'notes/etc-passwd.md']
    })
  })
})

describe('createKnowledgeFolder / createKnowledgeEntry — 落点', () => {
  it('CR-2 落点只收清单里已有的目录：容器本身、不存在的库、隐藏段、`..`、不足两段、大小写对不上的库名、条目文件的路径 —— 一律拒且不抛，磁盘一个目录一个文件都不多', () => {
    mkdirSync(join(root, 'projects', 'p1'), { recursive: true })
    seedFile(userRoot, 'notes/a.md', '# a\n')
    const before = disk()

    const ids = [
      // 容器本身不是 bundle（`projects/<id>` / `knowledge/<库名>` 才是）
      'projects',
      'knowledge',
      // `project` 是工具里项目库的保留名，不是磁盘上的库
      'knowledge/project',
      'knowledge/ghost',
      // 隐藏段不是库的内容
      'projects/p1/.git',
      'knowledge/.hidden',
      'knowledge/notes/..',
      '',
      '/',
      // 大小写敏感：磁盘上是小写 notes，落点写 Notes 就不是同一处
      'knowledge/Notes',
      // 条目文件的路径不是落点：每一段都必须是目录
      'knowledge/notes/a.md'
    ]

    for (const id of ids) {
      expect(createKnowledgeFolder(id, 'x'), `folder @ ${JSON.stringify(id)}`).toEqual({
        success: false,
        error: NO_SUCH_DIR
      })
      expect(createKnowledgeEntry(id, 'X'), `entry @ ${JSON.stringify(id)}`).toEqual({
        success: false,
        error: NO_SUCH_DIR
      })
    }

    expect(recordChange).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(disk()).toEqual(before)
  })
})

describe('createKnowledgeBase', () => {
  it('CR-3 新建知识库：用户根下建出一个空目录（根不存在先建），返回 id knowledge/<名>，广播一次 knowledge.changed，库里什么都不种', () => {
    expect(existsSync(userRoot)).toBe(false)

    expect(createKnowledgeBase('Notes')).toEqual({ success: true, id: 'knowledge/Notes' })

    expect(readdirSync(userRoot)).toEqual(['Notes'])
    // 库就是目录：没有 index.md / log.md / 章程文件，也没有 .git
    expect(readdirSync(join(userRoot, 'Notes'))).toEqual([])
    expect(events).toEqual([{ type: 'knowledge.changed' }])
    expect(recordChange).not.toHaveBeenCalled()
    // 建的是用户库：ShuviX 自己那个根一点没碰
    expect(treeOf(root)).toEqual([])
  })

  it('CR-4 project 是保留名不让建；只有全小写精确命中才算保留，Project 照建', () => {
    expect(createKnowledgeBase('project')).toEqual({ success: false, error: RESERVED })
    // 拒在建根之前：用户根连出现都不该出现
    expect(existsSync(userRoot)).toBe(false)
    expect(events).toEqual([])

    expect(createKnowledgeBase('Project')).toEqual({ success: true, id: 'knowledge/Project' })
    expect(disk()).toEqual({ shuvix: [], user: ['Project/'] })
  })

  /**
   * `shuvix` 是内置库在工具里的保留名 —— 与 `project` 同一条规则、同一条带名字的文案：保留名优先，
   * 叫这个名字的用户库工具够不着，别让人建出一个点不着的库。判据是全小写精确命中，不是「长得像」。
   */
  it('CR-11 shuvix 同样是保留名不让建（文案与 project 同一条，带的是自己的名字）；大小写不同的 Shuvix / SHUVIX 照建', () => {
    expect(createKnowledgeBase('shuvix')).toEqual({ success: false, error: RESERVED_BUILTIN })
    // 拒在建根之前：用户根连出现都不该出现
    expect(existsSync(userRoot)).toBe(false)
    expect(events).toEqual([])

    expect(createKnowledgeBase('Shuvix')).toEqual({ success: true, id: 'knowledge/Shuvix' })
    expect(disk()).toEqual({ shuvix: [], user: ['Shuvix/'] })

    // 重名是另一条规则（CR-5：大小写不敏感）—— 先让开，才看得见 SHUVIX 也不算保留名
    rmSync(join(userRoot, 'Shuvix'), { recursive: true })
    expect(createKnowledgeBase('SHUVIX')).toEqual({ success: true, id: 'knowledge/SHUVIX' })
    expect(disk()).toEqual({ shuvix: [], user: ['SHUVIX/'] })
  })

  it('CR-5 重名按大小写不敏感 + NFC 比；同名的文件也算占用', () => {
    mkdirSync(join(userRoot, 'Notes'), { recursive: true })
    mkdirSync(join(userRoot, 'café'), { recursive: true })
    writeFileSync(join(userRoot, 'readme.md'), '# readme\n')
    const before = disk()

    for (const name of [
      'notes',
      'NOTES',
      // NFD 写法的 café：归一之后与磁盘上的 NFC 目录是同一个名字
      'café',
      // 同名的**文件**同样算占用：目录与文件在一层里共用名字空间
      'readme.md'
    ]) {
      expect(createKnowledgeBase(name), name).toEqual({ success: false, error: taken(name) })
    }

    expect(events).toEqual([])
    expect(disk()).toEqual(before)
  })

  it('CR-6 名字按最严的平台收：一张非法名表全拒、落盘为零；名字先 trim', () => {
    mkdirSync(userRoot, { recursive: true })

    const invalid = [
      '',
      '   ',
      'a/b',
      'a\\b',
      'a:b',
      'a*b',
      'a?b',
      'a"b',
      'a<b',
      'a>b',
      'a|b',
      // 隐藏目录不是库
      '.hidden',
      '..',
      // Windows 上尾随点会被悄悄吃掉
      'name.',
      'a\nb',
      'a\x7fb',
      'a'.repeat(101)
    ]
    for (const name of invalid) {
      expect(createKnowledgeBase(name), JSON.stringify(name)).toEqual({
        success: false,
        error: INVALID
      })
    }
    expect(events).toEqual([])
    expect(readdirSync(userRoot)).toEqual([])

    // 先 trim：两边的空格既不算非法、也不进目录名
    expect(createKnowledgeBase(' notes ')).toEqual({ success: true, id: 'knowledge/notes' })
    expect(disk()).toEqual({ shuvix: [], user: ['notes/'] })
  })
})

describe('createKnowledgeFolder', () => {
  it('CR-7 新建文件夹：库本身、库里更深一层、项目库都收；返回目录 id；广播事件；建出来是空的', () => {
    mkdirSync(join(userRoot, 'notes', 'sub'), { recursive: true })
    mkdirSync(join(root, 'projects', 'p1'), { recursive: true })

    expect(createKnowledgeFolder('knowledge/notes', 'archive')).toEqual({
      success: true,
      id: 'knowledge/notes/archive'
    })
    expect(createKnowledgeFolder('knowledge/notes/sub', 'deep')).toEqual({
      success: true,
      id: 'knowledge/notes/sub/deep'
    })
    expect(createKnowledgeFolder('projects/p1', 'api')).toEqual({
      success: true,
      id: 'projects/p1/api'
    })

    expect(events).toEqual([
      { type: 'knowledge.changed' },
      { type: 'knowledge.changed' },
      { type: 'knowledge.changed' }
    ])
    // 没有文件可提交：目录变更只广播，不进变更管线
    expect(recordChange).not.toHaveBeenCalled()
    expect(disk()).toEqual({
      shuvix: ['projects/', 'projects/p1/', 'projects/p1/api/'],
      user: ['notes/', 'notes/archive/', 'notes/sub/', 'notes/sub/deep/']
    })
  })

  it('CR-10 文件夹重名与非法名：同名目录 / 同名文件都算占用，非法名照样拒；磁盘不变', () => {
    mkdirSync(join(userRoot, 'notes', 'archive'), { recursive: true })
    seedFile(userRoot, 'notes/readme.md', '# readme\n')
    const before = disk()

    expect(createKnowledgeFolder('knowledge/notes', 'archive')).toEqual({
      success: false,
      error: taken('archive')
    })
    expect(createKnowledgeFolder('knowledge/notes', 'readme.md')).toEqual({
      success: false,
      error: taken('readme.md')
    })
    expect(createKnowledgeFolder('knowledge/notes', 'a/b')).toEqual({
      success: false,
      error: INVALID
    })

    expect(events).toEqual([])
    expect(disk()).toEqual(before)
  })
})

/**
 * 内置库只读 —— 文件在应用包里：改了会随下次更新消失，macOS 上还会破坏签名。侧栏不给它新建菜单，
 * 宿主这一道是第二重。它守的是**能解析到的落点**（库真在磁盘上、`listBundles` 认它），所以拒的理由
 * 必须是 `errReadOnly` 而不是 `errNoSuchDir` —— 后者只说明「这一层根本没找到」，换个写法就绕过去了。
 */
describe('createKnowledgeFolder / createKnowledgeEntry —— 内置库只读', () => {
  it('CR-12 库本身不给新建文件夹：回 errReadOnly（不是 errNoSuchDir —— 库确实解析得到），内置根整棵树原样，不广播', () => {
    seedBuiltinBase()
    const before = treeOf(builtinRoot)
    // 前提：它是一个真的 bundle，只读那一道拦掉的正是本来解析得到的落点
    expect(listBundles()).toContain(BUILTIN)

    expect(createKnowledgeFolder(BUILTIN, 'archive')).toEqual({
      success: false,
      error: READ_ONLY
    })

    expect(treeOf(builtinRoot)).toEqual(before)
    expect(events).toEqual([])
    expect(disk()).toEqual({ shuvix: [], user: [] })
  })

  it('CR-13 库本身不给新建条目：回 errReadOnly，不落盘，变更管线零调用（没有提交可记）', () => {
    seedBuiltinBase()
    const before = treeOf(builtinRoot)

    expect(createKnowledgeEntry(BUILTIN, 'My Note')).toEqual({
      success: false,
      error: READ_ONLY
    })

    expect(recordChange).not.toHaveBeenCalled()
    expect(treeOf(builtinRoot)).toEqual(before)
    expect(events).toEqual([])
    expect(disk()).toEqual({ shuvix: [], user: [] })
  })

  it('CR-14 库里更深一层同样拒：builtin/shuvix/sub 的文件夹与条目都回 errReadOnly（判据是首段，不是「正好两段」）', () => {
    seedBuiltinBase()
    const before = treeOf(builtinRoot)

    expect(createKnowledgeFolder(`${BUILTIN}/sub`, 'archive')).toEqual({
      success: false,
      error: READ_ONLY
    })
    expect(createKnowledgeEntry(`${BUILTIN}/sub`, 'My Note')).toEqual({
      success: false,
      error: READ_ONLY
    })

    expect(recordChange).not.toHaveBeenCalled()
    expect(treeOf(builtinRoot)).toEqual(before)
    expect(events).toEqual([])
  })

  /**
   * 只读那一道与落点解析**共用一套归一**：`isBuiltinBundle` 走 `normalizeBundlePath`，`resolveDir`
   * 也走它。两套归一之间就有一条绕过去的路 —— `./builtin/shuvix` 这类写法在只读那一道认不出、
   * 到 `resolveDir` 又剥回同一个库，于是照写不误。
   */
  it('CR-15 绕写法一并拒：前导 ./、反斜杠、重复斜杠、前导 / 五种写法的文件夹与条目都回 errReadOnly，内置根整棵树原样', () => {
    seedBuiltinBase()
    const before = treeOf(builtinRoot)

    for (const id of spellingsOf('builtin', 'shuvix')) {
      expect(createKnowledgeFolder(id, 'archive'), `folder @ ${JSON.stringify(id)}`).toEqual({
        success: false,
        error: READ_ONLY
      })
      expect(createKnowledgeEntry(id, 'My Note'), `entry @ ${JSON.stringify(id)}`).toEqual({
        success: false,
        error: READ_ONLY
      })
    }

    expect(recordChange).not.toHaveBeenCalled()
    expect(treeOf(builtinRoot)).toEqual(before)
    expect(events).toEqual([])
    expect(disk()).toEqual({ shuvix: [], user: [] })
  })

  it('CR-16 对照组：同一批调用打到用户库 / 项目库照常成功 —— 只读守的是内置库，不是把新建关上；五种绕写法在用户库上照常解析到同一个库，记下的 bundle 是归一后的 id', () => {
    seedBuiltinBase()
    mkdirSync(join(userRoot, 'notes'), { recursive: true })
    mkdirSync(join(root, 'projects', 'p1'), { recursive: true })

    expect(createKnowledgeFolder('knowledge/notes', 'archive')).toEqual({
      success: true,
      id: 'knowledge/notes/archive'
    })
    expect(createKnowledgeEntry('knowledge/notes', 'My Note')).toEqual({
      success: true,
      id: 'knowledge/notes/my-note.md'
    })
    expect(createKnowledgeFolder('projects/p1', 'api')).toEqual({
      success: true,
      id: 'projects/p1/api'
    })
    expect(createKnowledgeEntry('projects/p1', 'Doc')).toEqual({
      success: true,
      id: 'projects/p1/doc.md'
    })

    // CR-15 里被内置库拒掉的那五种写法：打到用户库上照常落进同一个库，id 归一后回给界面
    spellingsOf('knowledge', 'notes').forEach((id, i) => {
      expect(createKnowledgeFolder(id, `alt-${i}`), `folder @ ${JSON.stringify(id)}`).toEqual({
        success: true,
        id: `knowledge/notes/alt-${i}`
      })
      expect(createKnowledgeEntry(id, `Alt ${i}`), `entry @ ${JSON.stringify(id)}`).toEqual({
        success: true,
        id: `knowledge/notes/alt-${i}.md`
      })
    })

    // 条目各记一条 Creation，署名 human；bundle 记的是归一后的 id，不是调用时的写法
    expect(recordChange).toHaveBeenCalledTimes(7)
    expect(recordChange).toHaveBeenCalledWith({
      bundle: 'knowledge/notes',
      path: 'my-note.md',
      op: 'Creation',
      actor: 'human'
    })
    expect(recordChange).toHaveBeenCalledWith({
      bundle: 'projects/p1',
      path: 'doc.md',
      op: 'Creation',
      actor: 'human'
    })
    expect(recordChange).toHaveBeenCalledWith({
      bundle: 'knowledge/notes',
      path: 'alt-0.md',
      op: 'Creation',
      actor: 'human'
    })

    expect(disk()).toEqual({
      shuvix: ['projects/', 'projects/p1/', 'projects/p1/api/', 'projects/p1/doc.md'],
      // 目录行带尾随 `/`，`.` 的码位比 `/` 小：同名的 alt-N.md 排在 alt-N/ 前面
      user: [
        'notes/',
        'notes/alt-0.md',
        'notes/alt-0/',
        'notes/alt-1.md',
        'notes/alt-1/',
        'notes/alt-2.md',
        'notes/alt-2/',
        'notes/alt-3.md',
        'notes/alt-3/',
        'notes/alt-4.md',
        'notes/alt-4/',
        'notes/archive/',
        'notes/my-note.md'
      ]
    })
  })
})
