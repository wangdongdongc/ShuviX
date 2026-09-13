/**
 * botService —— bot 注册表（宿主层）。
 *
 * `~/.shuvix/bots/<name>.md` 纯 md 驱动：文件存在且解析得过就是活的 —— 没有启用开关、
 * 没有旁路配置、没有数据库表、也不内置任何 bot。**编辑不经过本服务**（打开一份 bot 就是打开
 * 它的笔记本会话，改名迁移挂在笔记本写入的回执上），于是本文件按剩下的职责分组：
 *
 *   PSv-1…8   **扫描与解析**：目录里有什么、坏文件去哪、一条会话绑的是谁；
 *   PSv-SH1/2 **同名的几份**：侧栏列出的三拨与按名取（get / forSession）出自同一次同名裁决；
 *   PSv-19    **原子写**：新建落盘不给扫描读到半份文件的机会；
 *   PSv-20…26 **增删与按文件名寻址**：新建的文件名派生、删除的边界、文件名白名单、广播；
 *   PSv-27…40 **改名观察**：笔记本写入的回执（noteWriting / noteWritten）与每一次扫描怎样把
 *              会话绑定从旧名跟到新名、哪些情况必须不迁，以及 `bot.changed` 的合并窗口。
 *
 * **fs 是真的** —— 扫描扫的是真目录，换成假 fs 一条也测不到。
 * `readFileSync` / `existsSync` 只是套了一层可数的壳（同
 * instruction/__tests__/instructionInjector.test.ts 的手法）：前者给 PSv-6 造一次读失败、
 * 给 PSv-36 数「这一笔前有没有重扫」，后者给 PSv-24 证明「白名单排在任何 fs 调用之前」。
 *
 * mock 面：sessionDao / 广播 / logger / electron。`appEventBus` 保持**真实** ——
 * PSv-26 与 PSv-39/40 数的就是真事件。
 *
 * 改名记录（namesByPath）是进程内状态，**不随目录重建而清空** —— 只有扫描发现目录不存在才清。
 * 所以全局 beforeEach 先删目录、扫一次（等于「重启」）、再建目录：否则上一个用例记下的名字
 * 会被下一个用例当成改名的起点。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { basename, join } from 'path'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-botsvc-${process.pid}`
  return { base, bots: `${base}/bots` }
})

const mocks = vi.hoisted(() => ({
  findAll: vi.fn<() => Array<{ id: string; settings?: Record<string, unknown> }>>(),
  pick: vi.fn<(id: string, cols: string[]) => unknown>(),
  updateSettings: vi.fn(),
  broadcast: vi.fn(),
  warn: vi.fn(),
  atomicWrite: vi.fn()
}))

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../../utils/paths', () => ({ getDefaultBotsDir: () => dirs.bots }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    findAll: mocks.findAll,
    pick: mocks.pick,
    updateSettings: mocks.updateSettings
  }
}))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: mocks.broadcast
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
}))
// 原子写保持真实实现（盘上得真有字节），只是外面套一层可数的壳 —— PSv-19 数它
vi.mock('../../utils/atomicWrite', () => ({ writeFileAtomic: mocks.atomicWrite }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: actual,
    readFileSync: vi.fn(actual.readFileSync),
    existsSync: vi.fn(actual.existsSync)
  }
})

import { botService } from '../botService'
import { appEventBus } from '../../utils/appEventBus'

/** 一份最小可解析的 bot md */
function md(
  name: string,
  opts: { body?: string; description?: string; displayName?: string } = {}
): string {
  const lines = ['---', 'shuvix: bot v2', `name: ${name}`]
  if (opts.description !== undefined) lines.push(`description: ${opts.description}`)
  if (opts.displayName) lines.push(`shuvix-displayName: ${opts.displayName}`)
  lines.push('---', '', opts.body ?? `${name} 的人设。`)
  return lines.join('\n')
}

/** 直接往目录里放一份 `<base>.md`（文件名与 name 可以不同） */
function put(fileBase: string, text: string): string {
  return putFile(`${fileBase}.md`, text)
}

/** 直接往目录里放一份文件（文件名逐字照给） */
function putFile(fileName: string, text: string): string {
  mkdirSync(dirs.bots, { recursive: true })
  const filePath = join(dirs.bots, fileName)
  writeFileSync(filePath, text)
  return filePath
}

/** PSv-6 造读失败用：命中这个路径的 readFileSync 抛 EACCES */
let failReadPath: string | null = null

/** 会话表的**可变**替身：updateSettings 真写回去 */
let sessionRows: Array<{ id: string; settings: Record<string, unknown> }> = []

function seedSessions(rows: Array<{ id: string; bot?: string }>): void {
  sessionRows = rows.map((r) => ({ id: r.id, settings: r.bot ? { bot: r.bot } : {} }))
}

const boundBotOfSession = (id: string): unknown =>
  sessionRows.find((r) => r.id === id)?.settings.bot

/** 订阅真 appEventBus，数 bot.changed 落了几次 */
async function countChanged(run: () => void): Promise<number> {
  const { appEventBus } = await import('../../utils/appEventBus')
  let n = 0
  const off = appEventBus.subscribe((e) => {
    if (e.type === 'bot.changed') n++
  })
  try {
    run()
  } finally {
    off()
  }
  return n
}

beforeAll(async () => {
  const realFs = await vi.importActual<typeof import('fs')>('fs')
  const realAtomic =
    await vi.importActual<typeof import('../../utils/atomicWrite')>('../../utils/atomicWrite')
  // 实现装一次、之后只 mockClear（mockReset 会把实现一起抹掉）
  vi.mocked(readFileSync).mockImplementation(((p: string, ...rest: unknown[]) => {
    if (failReadPath !== null && String(p) === failReadPath) {
      throw new Error('EACCES: permission denied')
    }
    return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
  }) as never)
  vi.mocked(existsSync).mockImplementation(realFs.existsSync)
  mocks.atomicWrite.mockImplementation(realAtomic.writeFileAtomic)
})

beforeEach(() => {
  rmSync(dirs.base, { recursive: true, force: true })
  botService.listAll() // scanning a missing dir clears namesByPath ("restart")
  mkdirSync(dirs.bots, { recursive: true })
  failReadPath = null
  for (const m of Object.values(mocks)) m.mockClear()
  vi.mocked(readFileSync).mockClear()
  vi.mocked(existsSync).mockClear()
  sessionRows = []
  mocks.findAll.mockImplementation(() => sessionRows)
  mocks.updateSettings.mockImplementation((id: string, patch: { bot: string }) => {
    const row = sessionRows.find((r) => r.id === id)
    if (row) row.settings.bot = patch.bot
  })
  mocks.pick.mockReturnValue(undefined)
})

afterAll(() => {
  rmSync(dirs.base, { recursive: true, force: true })
})

// ────────────────────── PSv-1…8：扫描与解析 ──────────────────────

describe('PSv-1…8 —— 扫描、解析与「这条会话绑的是谁」', () => {
  it('PSv-1 只扫非点开头的 *.md，跳过目录（后缀大小写不敏感）', () => {
    // 目录被算进来会让整个扫描在 readFileSync(EISDIR) 上抛；点文件是编辑器的临时残留
    // （`.scout.md.swp` 那一族），把它们当 bot 会让列表里凭空多出几个半截 bot
    put('scout', md('scout'))
    put('.hidden', md('hidden'))
    putFile('notes.txt', md('notes'))
    mkdirSync(join(dirs.bots, 'looks-like.md'))
    // `.toLowerCase().endsWith('.md')` —— Windows / macOS 上的 .MD 是同一种文件
    putFile('LOUD.MD', md('loud'))

    const { valid, invalid } = botService.listWithInvalid()
    expect(valid.map((p) => p.file.name).sort()).toEqual(['loud', 'scout'])
    expect(invalid).toEqual([])
  })

  it('PSv-2 解析不过的文件进 invalid 并带解析器理由，绝不进 valid', () => {
    // invalid 那一拨是侧栏琥珀行的来源（点开就是它的笔记本，照着理由修）：丢了理由用户只看到
    // 一个不生效的文件名。更要紧的是**绝不进 valid** —— 半解析的 bot 会被注入
    put('scout', md('scout'))
    put('broken', '这根本不是一份 md')
    put('badyaml', '---\n[unclosed\n---\nbody')

    const { valid, invalid } = botService.listWithInvalid()
    expect(valid.map((p) => p.file.name)).toEqual(['scout'])
    expect(invalid.map((f) => f.fileName).sort()).toEqual(['badyaml.md', 'broken.md'])
    expect(invalid.find((f) => f.fileName === 'broken.md')!.error).toContain(
      'no YAML frontmatter block'
    )
    expect(invalid.find((f) => f.fileName === 'badyaml.md')!.error).toContain('invalid YAML')
  })

  it('PSv-3 一份 agent md 掉进 bots 目录落在 invalid', () => {
    // 解析层那条整份拒绝（botFile 的 PR-4）在服务层的对偶。放行的后果不是「多一个
    // 条目」，而是那份工程提示词被当作某人的人设贴进根 Agent 的系统提示词
    put(
      'coder',
      ['---', 'shuvix: agent v1', 'name: coder', '---', '', 'You write code.'].join('\n')
    )
    const { valid, invalid } = botService.listWithInvalid()
    expect(valid).toEqual([])
    expect(invalid).toHaveLength(1)
    expect(invalid[0].error).toContain('is not a bot file')
  })

  it('PSv-4 同名两份文件：两份都列出 —— 胜者进 valid、另一份进 shadowed 并指向胜者，都不报 invalid；运行时认的是同一份', () => {
    // 身份是 frontmatter 的 `name`，而文件名可以任意 —— 两份文件写同一个名字是做得到的。
    // 输的那份不生效，但侧栏得把它列出来、说清被谁压过：看不见的文件，用户既不知道它存在，
    // 也不知道它为什么不生效。两个文件名都不是名字本身、长度也一样，于是落到码点序 ——
    // 与 readdir 的枚举序无关（故意倒着建）
    put('z-scout', md('scout', { body: '第二份' }))
    put('a-scout', md('scout', { body: '第一份' }))

    const { valid, shadowed, invalid } = botService.listWithInvalid()
    expect(invalid).toEqual([])
    expect(valid.map((b) => b.basePath)).toEqual([join(dirs.bots, 'a-scout.md')])
    expect(shadowed.map((b) => [b.basePath, b.shadowedBy])).toEqual([
      [join(dirs.bots, 'z-scout.md'), 'a-scout.md']
    ])
    // 会话绑定 / 身份胶囊走的 get、listAll 与侧栏出自同一次裁决
    expect(botService.get('scout')?.basePath).toBe(join(dirs.bots, 'a-scout.md'))
    expect(botService.listAll().map((b) => b.basePath)).toEqual([join(dirs.bots, 'a-scout.md')])
  })

  it('PSv-5 目录不存在 → 空清单、不抛，且不创建目录', () => {
    // 首次启动时这个目录不存在。顺手 mkdir 会在用户还没建过任何 bot 时就往 ~/.shuvix
    // 里撒一个空目录 —— 纯 md 驱动的纪律是「用户建了才有」
    rmSync(dirs.bots, { recursive: true, force: true })
    expect(() => botService.listWithInvalid()).not.toThrow()
    expect(botService.listWithInvalid()).toEqual({ valid: [], shadowed: [], invalid: [] })
    expect(botService.listAll()).toEqual([])
    expect(existsSync(dirs.bots)).toBe(false)
  })

  it('PSv-6 读某个文件抛错 → 该条进 invalid，扫描继续', () => {
    // 一份读不动的文件（权限 / 正在被别的进程重写）不该让整个列表变空 —— 侧栏会显示
    // 「一个 bot 都没有」，而用户只是有一份文件出了问题
    put('scout', md('scout'))
    failReadPath = put('locked', md('locked'))

    const { valid, invalid } = botService.listWithInvalid()
    expect(valid.map((p) => p.file.name)).toEqual(['scout'])
    expect(invalid).toHaveLength(1)
    expect(invalid[0].fileName).toBe('locked.md')
    expect(invalid[0].error).toContain('EACCES')
  })

  it('PSv-7 get 按 frontmatter name 匹配而非文件名', () => {
    // 改名只改 frontmatter，文件名不动 —— 于是两者永久分叉，按文件名找会在第一次改名之后
    // 全线失效
    put('scout', md('ranger'))
    expect(botService.get('ranger')?.basePath).toBe(join(dirs.bots, 'scout.md'))
    expect(botService.get('scout')).toBeNull()
  })

  it('PSv-8 forSession：绑定 → 条目；非 bot 会话 → null；md 已被删 → null + warn，不抛', () => {
    // 注入侧的唯一入口。**绑定不存在不该让会话打不开** —— 那是用户删了一个文件，
    // 不是数据损坏；会话照常跑在基座 bot 上，只是没有人设可注入（AG-3 是它的对偶）
    put('scout', md('scout'))

    mocks.pick.mockReturnValue({ settings: { bot: 'scout' } })
    expect(botService.forSession('s1')?.file.name).toBe('scout')
    expect(mocks.warn).not.toHaveBeenCalled()

    for (const settings of [undefined, {}, { bot: '' }, { bot: '  ' }, { bots: ['old'] }]) {
      mocks.pick.mockReturnValue({ settings })
      expect(botService.forSession('s1'), JSON.stringify(settings)).toBeNull()
    }
    // 会话行整个不存在（刚被删）同样只是 null
    mocks.pick.mockReturnValue(undefined)
    expect(botService.forSession('ghost')).toBeNull()
    expect(mocks.warn).not.toHaveBeenCalled()

    mocks.pick.mockReturnValue({ settings: { bot: 'gone' } })
    expect(() => botService.forSession('s1')).not.toThrow()
    expect(botService.forSession('s1')).toBeNull()
    expect(mocks.warn.mock.calls.flat().join(' ')).toContain('gone')
  })
})

// ────────────────────── PSv-SH：同名的几份 ──────────────────────

/**
 * 同名的几份文件：侧栏列出的三拨（listWithInvalid）与按名取（get / listAll / forSession）出自同一次
 * resolveShadowing。夹具让规则的每一级都有人较劲：
 *   scout.md（Scout Canon）  —— 文件名就是名字，胜出
 *   a.md（Scout Short）      —— 更短、码点序更前，输
 *   zz-scout.md              —— 既不短也不靠前，输
 *   ranger copy.md           —— ranger 唯一的一份：不是名字本身也照样生效
 *   broken.md                —— 解析不过
 * 会话 s1 绑着 scout；pick 读的是同一张可变的会话表，删文件之后「绑定没被迁」也看得见。
 */
describe('PSv-SH —— 同名的几份：侧栏列出的与按名取到的是同一次裁决', () => {
  const fileOf = (entry: { basePath: string }): string => basename(entry.basePath)

  function seedShadowFixture(): void {
    put('scout', md('scout', { displayName: 'Scout Canon' }))
    put('a', md('scout', { displayName: 'Scout Short' }))
    put('zz-scout', md('scout'))
    put('ranger copy', md('ranger'))
    put('broken', '不是 md')
    seedSessions([{ id: 's1', bot: 'scout' }])
    mocks.pick.mockImplementation((id: string) => {
      const row = sessionRows.find((r) => r.id === id)
      return row ? { settings: row.settings } : undefined
    })
  }

  it('PSv-SH1 侧栏的三拨与按名取一致：文件名即名字的 scout.md 生效，a.md / zz-scout.md 依次指向它；ranger 唯一的一份照常生效；绑着 scout 的会话拿到的是 scout.md', () => {
    seedShadowFixture()

    const { valid, shadowed, invalid } = botService.listWithInvalid()
    expect(valid.map(fileOf)).toEqual(['ranger copy.md', 'scout.md'])
    expect(shadowed.map((s) => [fileOf(s), s.shadowedBy])).toEqual([
      ['a.md', 'scout.md'],
      ['zz-scout.md', 'scout.md']
    ])
    expect(invalid.map((f) => f.fileName)).toEqual(['broken.md'])
    expect(botService.listAll()).toEqual(valid)
    // 每一份输掉的都恰好对应一份同名的胜者，就是它 shadowedBy 指的那个文件
    for (const s of shadowed) {
      expect(valid.filter((v) => v.file.name === s.file.name).map(fileOf), fileOf(s)).toEqual([
        s.shadowedBy
      ])
    }

    const scout = botService.get('scout')
    expect(scout?.basePath).toBe(join(dirs.bots, 'scout.md'))
    expect(scout?.file.displayName).toBe('Scout Canon')
    expect(botService.get('ranger')?.basePath).toBe(join(dirs.bots, 'ranger copy.md'))
    expect(botService.forSession('s1')?.basePath).toBe(join(dirs.bots, 'scout.md'))
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('PSv-SH2 按文件名删输的那份不动胜者；按名删删的是生效的 scout.md —— a.md 接班，会话跟着拿到它，绑定不迁', () => {
    seedShadowFixture()

    expect(botService.deleteByFile('zz-scout.md')).toEqual({ success: true })
    expect(botService.get('scout')?.basePath).toBe(join(dirs.bots, 'scout.md'))
    expect(botService.listWithInvalid().shadowed.map((s) => [fileOf(s), s.shadowedBy])).toEqual([
      ['a.md', 'scout.md']
    ])

    expect(botService.delete('scout')).toEqual({ success: true })
    expect(readdirSync(dirs.bots).sort()).toEqual(['a.md', 'broken.md', 'ranger copy.md'])
    const next = botService.get('scout')
    expect(next?.basePath).toBe(join(dirs.bots, 'a.md'))
    expect(next?.file.displayName).toBe('Scout Short')
    expect(botService.forSession('s1')?.basePath).toBe(join(dirs.bots, 'a.md'))
    expect(botService.listWithInvalid().shadowed).toEqual([])
    // 名字没变，只是换了一份文件在用 —— 不是改名，没有迁移
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(boundBotOfSession('s1')).toBe('scout')
  })
})

// ────────────────────── PSv-19：原子写 ──────────────────────

describe('PSv-19 —— 新建落盘经 writeFileAtomic', () => {
  it('create 一律原子写（半份文件会让 bot 从列表里消失一瞬）', () => {
    // scanDir 随时可能在读（侧栏重扫、建根 Agent 时的 forSession）。`writeFileSync`
    // 默认 'w' 先截断再写 —— 读者会看到半份文件，于是这个 bot 短暂地变成一条 invalid
    botService.create(md('ranger'))
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(1)
    expect(String(mocks.atomicWrite.mock.calls[0][0]).startsWith(dirs.bots)).toBe(true)
  })
})

// ────────────────────── PSv-20…26：新建、删除、按文件名寻址 ──────────────────────

describe('PSv-20…23 —— 新建与删除', () => {
  it('PSv-20 create 由名字派生文件名并净化，目录不存在时创建，撞名以 -1/-2 去重', () => {
    // 名字是用户随手取的，可能带路径分隔符与 Windows 保留字符 —— 不净化就是一次目录穿越。
    // 去重则是因为**身份是名字、文件名只是容器**：两个不同的名字可以净化成同一个基名
    rmSync(dirs.bots, { recursive: true, force: true })
    expect(botService.create(md("'a/b\\c:d*e?f\"g<h>i|j'")).success).toBe(true)
    expect(existsSync(join(dirs.bots, 'a-b-c-d-e-f-g-h-i-j.md'))).toBe(true)

    // 前导点剥掉（点文件不会被扫描到 —— 建出来就等于建了个隐形 bot）；剥干净了兜底为 bot
    expect(botService.create(md("'..evil'")).success).toBe(true)
    expect(existsSync(join(dirs.bots, 'evil.md'))).toBe(true)
    expect(botService.create(md("'...'")).success).toBe(true)
    expect(existsSync(join(dirs.bots, 'bot.md'))).toBe(true)

    // 三个不同的名字净化成同一个基名 → x-y.md / x-y-1.md / x-y-2.md
    for (const name of ["'x:y'", "'x*y'", "'x?y'"]) {
      expect(botService.create(md(name)).success, name).toBe(true)
    }
    for (const file of ['x-y.md', 'x-y-1.md', 'x-y-2.md']) {
      expect(existsSync(join(dirs.bots, file)), file).toBe(true)
    }
    // 六个不同的名字、六份文件 —— 一份都没被覆盖掉
    expect(botService.listAll()).toHaveLength(6)
  })

  it('PSv-21 create 拒绝重复的 frontmatter 名字，哪怕文件名没被占用', () => {
    // 身份是名字。放行会得到两份同名文件，而同名的几份只有一份生效（PSv-4）—— 新建出来的
    // scout.md 文件名就是名字，会悄无声息地压过用户原有的 some-file.md
    put('some-file', md('scout'))
    const res = botService.create(md('scout'))
    expect(res.success).toBe(false)
    expect(res.error).toContain('already exists')
    expect(existsSync(join(dirs.bots, 'scout.md'))).toBe(false)

    // 文本本身非法同样拒绝（先解析，后建文件）
    expect(botService.create('不是 md').success).toBe(false)
    expect(readdirSync(dirs.bots)).toEqual(['some-file.md'])
  })

  it('PSv-22 newBotTemplate 的产物解析得回、带标记、且正文**非空**', () => {
    // 正文非空是**机制要求**，不是装饰：bot 靠 `edit` 维护自己这份文件，而 `edit` 需要
    // 一段能锚定的既有文本 —— 空正文里它无处下手，于是这个 bot 永远学不会第一件事
    const text = botService.newBotTemplate({ name: 'scout' })
    expect(text.split('\n')[1]).toBe('shuvix: bot v2')

    expect(botService.create(text).success).toBe(true)
    const entry = botService.get('scout')!
    expect(entry.file.name).toBe('scout')
    expect(entry.file.displayName).toBe('scout')
    expect(entry.file.description.length).toBeGreaterThan(0)
    expect(entry.file.body.trim().length).toBeGreaterThan(0)

    // 调用方给的正文与描述压过骨架
    const custom = botService.newBotTemplate({
      name: 'r',
      body: '我的人设',
      description: 'd'
    })
    expect(botService.create(custom).success).toBe(true)
    expect(botService.get('r')!.file.body).toBe('我的人设')
    expect(botService.get('r')!.file.description).toBe('d')
  })

  it('PSv-23 delete 删文件，绑定它的会话原封不动', () => {
    // 会话是用户资产：删一个 md 不该带走对话。那条会话照常打开、照常跑在基座 bot 上，
    // 只是没有人设可注入（forSession → null + warn，见 PSv-8）
    put('scout', md('scout'))
    seedSessions([{ id: 's1', bot: 'scout' }])

    expect(botService.delete('scout')).toEqual({ success: true })
    expect(existsSync(join(dirs.bots, 'scout.md'))).toBe(false)
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(boundBotOfSession('s1')).toBe('scout')

    expect(botService.delete('scout')).toEqual({
      success: false,
      error: 'Bot "scout" not found'
    })
  })
})

describe('PSv-24 —— 按文件名删除（解析不过的文件没有 name）', () => {
  it('PSv-24 文件名白名单：路径穿越 / 非 .md / 点文件一律拒绝，且不碰文件系统', () => {
    // fileName 来自渲染进程。虽然今天只由 listWithInvalid 的返回值填充，仍按不可信入参
    // 处理 —— 这条通道会**删**它指到的文件
    const outside = join(dirs.base, 'outside.md')
    mkdirSync(join(dirs.bots, 'sub'), { recursive: true })
    writeFileSync(outside, md('outside'))
    writeFileSync(join(dirs.bots, 'sub', 'x.md'), md('nested'))

    vi.mocked(readFileSync).mockClear()
    vi.mocked(existsSync).mockClear()
    const bad = [
      '../outside.md',
      '../../.ssh/id_rsa',
      'sub/dir/x.md',
      'sub/x.md',
      '..\\outside.md',
      'x.txt',
      'x',
      '.hidden.md'
    ]
    for (const fileName of bad) {
      expect(botService.deleteByFile(fileName).success, fileName).toBe(false)
    }
    // 白名单排在**任何** fs 调用之前 —— 连 existsSync 都没跑过一次
    expect(existsSync).not.toHaveBeenCalled()
    expect(readFileSync).not.toHaveBeenCalled()
    expect(readFileSync(outside, 'utf-8')).toBe(md('outside'))
    expect(existsSync(join(dirs.bots, 'sub', 'x.md'))).toBe(true)

    // 正控制组：目录里一个真实存在的 .md 文件名删得掉；不存在的合法文件名 → not found
    put('broken', '不是 md')
    expect(botService.deleteByFile('broken.md')).toEqual({ success: true })
    expect(existsSync(join(dirs.bots, 'broken.md'))).toBe(false)
    expect(botService.deleteByFile('nope.md')).toEqual({
      success: false,
      error: 'File "nope.md" not found'
    })
  })
})

describe('PSv-26 —— bot.changed 广播', () => {
  it('三条写通道成功各广播一次；被拒的写一次都不发', async () => {
    // 侧栏「Bots」分组靠这条信号重扫。口径：**落盘成功才广播、不带载荷** ——
    // 被校验拒绝的写入什么都没改，不该让消费者白扫一遍
    expect(
      await countChanged(() => {
        expect(botService.create(md('ranger')).success).toBe(true)
      })
    ).toBe(1)
    expect(
      await countChanged(() => {
        expect(botService.delete('ranger').success).toBe(true)
      })
    ).toBe(1)
    put('broken', '不是 md')
    expect(
      await countChanged(() => {
        expect(botService.deleteByFile('broken.md').success).toBe(true)
      })
    ).toBe(1)

    // 被拒的三种：非法内容 / 目标不存在 / 文件名不合白名单
    expect(
      await countChanged(() => {
        expect(botService.create('not a bot file').success).toBe(false)
        expect(botService.delete('ghost').success).toBe(false)
        expect(botService.deleteByFile('../x.md').success).toBe(false)
      })
    ).toBe(0)
  })
})

// ────────────────────── PSv-27…40：改名观察 ──────────────────────

/**
 * 编辑一份 bot 就是它的笔记本在自动保存：没有「点保存」那一刻可以拿新旧两份文本对照，把 `name`
 * 从 ranger 改成 hunter，盘上依次出现的是 h、hu、hun……所以迁移挂在**扫描**上，一步一步跟过去。
 * 这一组钉的是这条跟随的边界：什么时候迁、迁到哪、什么时候必须不迁。
 *
 * `notebookWrite` 复刻 registryNotes.observeRegistryWrite 包住的那一笔：noteWriting → 落盘 →
 * noteWritten。假时钟只为 `bot.changed` 的 300ms 合并窗口（PSv-39/40）；每个用例结束时把挂着的
 * 定时器跑掉再换回真时钟，不让一个窗口漏进别的用例。
 */
describe('PSv-27…40 —— 改名观察：会话绑定跟着文件里的名字走', () => {
  /** 真 appEventBus 上观察到的全部事件 */
  let events: AppEvent[] = []
  let unsubscribe: () => void = () => {}

  beforeEach(() => {
    vi.useFakeTimers()
    events = []
    unsubscribe = appEventBus.subscribe((e) => {
      events.push(e)
    })
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    unsubscribe()
  })

  const scoutPath = join(dirs.bots, 'scout.md')
  const UNPARSABLE = '---\n[unclosed\n---\nbody'

  /** 笔记本的一笔写入 —— registryNotes.observeRegistryWrite 包住的就是这三步 */
  function notebookWrite(fileBase: string, text: string): void {
    const filePath = join(dirs.bots, `${fileBase}.md`)
    botService.noteWriting(filePath)
    writeFileSync(filePath, text)
    botService.noteWritten()
  }

  /** 用例中途「重启」：与全局 beforeEach 同一个做法，清掉进程内的改名记录 */
  function restart(): void {
    rmSync(dirs.base, { recursive: true, force: true })
    botService.listAll()
    mkdirSync(dirs.bots, { recursive: true })
  }

  /** updateSettings 收到过的 [会话 id, 补丁]（按调用序） */
  const rewrites = (): unknown[][] => mocks.updateSettings.mock.calls
  /** broadcast 收到过的会话 id（按调用序） */
  const broadcasted = (): string[] => mocks.broadcast.mock.calls.map((c) => String(c[0]))

  /** a.md = ranger、b.md = scout，各绑一条会话；记下基线后把 a 改成 scout —— 两份文件同名 */
  function collide(): void {
    put('a', md('ranger'))
    put('b', md('scout'))
    seedSessions([
      { id: 's1', bot: 'ranger' },
      { id: 's2', bot: 'scout' }
    ])
    botService.listAll()
    notebookWrite('a', md('scout'))
  }

  /** a.md = ranger（绑着 s1）记下基线后复制出 a-copy.md —— 同名两份 —— 再扫一遍 */
  function copyThenScan(): void {
    put('a', md('ranger'))
    seedSessions([{ id: 's1', bot: 'ranger' }])
    botService.listAll()
    copyFileSync(join(dirs.bots, 'a.md'), join(dirs.bots, 'a-copy.md'))
    botService.listAll()
  }

  it('PSv-27 任何一次扫描都在观察改名：文件里的名字变了 → 只迁绑着旧名的会话，每条迁过的会话广播一次配置变更', () => {
    // 迁移挂在扫描上，而不只挂在笔记本回执上：外部编辑器、bot 自己的 `edit`、侧栏聚焦重扫，
    // 谁先扫到谁迁。s2 绑的 `scout` 恰好是文件名 —— 身份是 frontmatter name，文件名从来不是
    put('scout', md('ranger'))
    seedSessions([{ id: 's1', bot: 'ranger' }, { id: 's2', bot: 'scout' }, { id: 's3' }])

    botService.listAll() // 进程内第一次见到这份文件：只记基线
    expect(mocks.updateSettings).not.toHaveBeenCalled()

    put('scout', md('hunter'))
    botService.listAll()
    expect(rewrites()).toEqual([['s1', { bot: 'hunter' }]])
    expect(broadcasted()).toEqual(['s1'])
    expect(boundBotOfSession('s1')).toBe('hunter')
    expect(boundBotOfSession('s2')).toBe('scout')
    expect(boundBotOfSession('s3')).toBeUndefined()
  })

  it('PSv-28 打字途中的连环改名：h → hu → hun → hunter 每一步都跟过去，最后停在 hunter，没有会话留在中间名上', () => {
    // 「等名字稳定下来再迁」做不到（没有那一刻）；而漏掉任何一步，会话就留在一个已经没有文件
    // 在用的名字上 —— 记录往前走了，之后的改名只迁记录里的旧名，再也迁不回来
    put('scout', md('ranger'))
    seedSessions([{ id: 's1', bot: 'ranger' }])
    botService.listAll()

    for (const name of ['h', 'hu', 'hun', 'hunter']) notebookWrite('scout', md(name))

    expect(rewrites()).toEqual([
      ['s1', { bot: 'h' }],
      ['s1', { bot: 'hu' }],
      ['s1', { bot: 'hun' }],
      ['s1', { bot: 'hunter' }]
    ])
    expect(sessionRows.map((r) => r.settings.bot)).toEqual(['hunter'])
    expect(botService.get('hunter')?.basePath).toBe(scoutPath)
  })

  it('PSv-29 中途写出一版解析不过的：不迁、记录不丢；修好之后从最后一个合法名字一次迁到位', () => {
    // 删掉 `name:` 重打、YAML 写到一半，都会让某一笔解析不过。把它当成「文件没了」清掉记录，
    // 修好的那一笔就成了第一次见到 —— 迁移随之漏掉
    put('scout', md('ranger'))
    seedSessions([{ id: 's1', bot: 'ranger' }])
    botService.listAll()

    notebookWrite('scout', UNPARSABLE)
    expect(botService.listWithInvalid().invalid.map((f) => f.fileName)).toContain('scout.md')
    expect(boundBotOfSession('s1')).toBe('ranger')
    expect(mocks.updateSettings).not.toHaveBeenCalled()

    notebookWrite('scout', md('hunter'))
    expect(rewrites()).toEqual([['s1', { bot: 'hunter' }]])
  })

  it('PSv-30 进程内第一次见到时就解析不过：没有「上一个名字」可比，修好后的名字只记作基线、不迁', () => {
    // 从没见过它合法的样子：把绑着别的名字的会话迁给第一个合法名字，就是在猜
    put('scout', UNPARSABLE)
    seedSessions([{ id: 's1', bot: 'ranger' }])

    notebookWrite('scout', md('hunter'))
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(boundBotOfSession('s1')).toBe('ranger')
  })

  it('PSv-31 改成另一份文件正在用的名字：不迁（记录停在旧名）；再改成独占的名字才一次迁过去', () => {
    // 迁过去等于把 s1 交给一个说不清是谁的名字：同名两份只有一份生效（PSv-4）。a.md 与 b.md 都不是
    // 名字本身、长度也一样，按码点序 a.md 胜出 —— 胜者是确定的，可「s1 该跟哪份文件」仍然说不清，所以不迁
    collide()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(botService.listAll().map((e) => e.file.name)).toEqual(['scout'])
    expect(botService.get('scout')?.basePath).toBe(join(dirs.bots, 'a.md'))
    expect(boundBotOfSession('s1')).toBe('ranger')
    expect(boundBotOfSession('s2')).toBe('scout')

    notebookWrite('a', md('scout2'))
    expect(rewrites()).toEqual([['s1', { bot: 'scout2' }]])
    expect(boundBotOfSession('s2')).toBe('scout')
  })

  it('PSv-32 撞名解开（另一份被删）：停在旧名上的记录补迁到那个此刻独占的名字', () => {
    collide()
    rmSync(join(dirs.bots, 'b.md'))
    botService.listAll()

    expect(rewrites()).toEqual([['s1', { bot: 'scout' }]])
    expect(boundBotOfSession('s1')).toBe('scout')
    expect(boundBotOfSession('s2')).toBe('scout')
  })

  it('PSv-33 复制出一份再改副本的名字：旧名还有原件在用 → 会话留给原件，不迁', () => {
    // 「复制一份改改看」是做新 bot 最顺手的办法；迁过去等于让原件的会话全部改投副本
    copyThenScan()

    notebookWrite('a-copy', md('hunter'))
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(boundBotOfSession('s1')).toBe('ranger')
    expect(botService.get('ranger')?.basePath).toBe(join(dirs.bots, 'a.md'))
  })

  it('PSv-34 复制出一份再改原件的名字：旧名由副本接着用 → 同样不迁，ranger 此后指向副本', () => {
    // 判据是「旧名此刻还有没有文件在用」，不是「改的是哪一份」—— 两个方向同一个答案
    copyThenScan()

    notebookWrite('a', md('hunter'))
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(boundBotOfSession('s1')).toBe('ranger')
    expect(botService.get('ranger')?.basePath).toBe(join(dirs.bots, 'a-copy.md'))
  })

  it('PSv-35 重启后的第一笔写：noteWriting 先把写入前的名字记成基线，改名照迁；跳过 noteWriting 的同一笔迁不了（对照组）', () => {
    // 改名记录只在进程内。重启后打开 bot 就改名，第一次扫描看到的已经是新名字 —— 写入之前
    // 补的这一次扫描，是「旧名」唯一的来源
    put('scout', md('ranger'))
    seedSessions([{ id: 's1', bot: 'ranger' }])

    botService.noteWriting(scoutPath)
    put('scout', md('hunter'))
    botService.noteWritten()
    expect(rewrites()).toEqual([['s1', { bot: 'hunter' }]])
    expect(boundBotOfSession('s1')).toBe('hunter')

    // 对照组：再「重启」一次，同样的盘面、同样的一笔，只是没有 noteWriting
    restart()
    mocks.updateSettings.mockClear()
    put('scout', md('ranger'))
    seedSessions([{ id: 's1', bot: 'ranger' }])
    put('scout', md('hunter'))
    botService.noteWritten()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(boundBotOfSession('s1')).toBe('ranger')
  })

  it('PSv-36 noteWriting 只为没见过的文件扫描：见过的零读盘；没见过的扫一遍、不抛、不迁', () => {
    // 自动保存每 200ms 一笔：每笔之前都把整个目录重读一遍是白花的 IO —— 基线只在缺的时候补
    put('scout', md('ranger'))
    seedSessions([{ id: 's1', bot: 'ranger' }])
    botService.listAll()

    vi.mocked(readFileSync).mockClear()
    botService.noteWriting(scoutPath)
    expect(readFileSync).not.toHaveBeenCalled()

    expect(() => botService.noteWriting(join(dirs.bots, 'unknown.md'))).not.toThrow()
    expect(readFileSync).toHaveBeenCalled()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('PSv-37 文件删了记录就丢：同一路径再建一份（换个名字）是一个新 bot，不是改名 —— rm 后扫描 / delete / deleteByFile 三种删法都一样', () => {
    // 记录要是留着，新建的 scout.md 会被当成「ranger 改名了」，ranger 的会话全部交给一个毫不
    // 相干的新 bot。delete / deleteByFile 删完**不经扫描**就重建：证明是删除自己清的记录
    const removals: Array<[string, () => void, string]> = [
      [
        'rm + listAll',
        () => {
          rmSync(scoutPath)
          botService.listAll()
        },
        'hunter'
      ],
      ['delete', () => expect(botService.delete('ranger')).toEqual({ success: true }), 'seeker'],
      [
        'deleteByFile',
        () => expect(botService.deleteByFile('scout.md')).toEqual({ success: true }),
        'tracker'
      ]
    ]
    for (const [how, remove, nextName] of removals) {
      restart()
      put('scout', md('ranger'))
      seedSessions([{ id: 's1', bot: 'ranger' }])
      botService.listAll()

      remove()
      put('scout', md(nextName))
      botService.listAll()
      expect(mocks.updateSettings, how).not.toHaveBeenCalled()
      expect(boundBotOfSession('s1'), how).toBe('ranger')
    }
  })

  it('PSv-38 迁移逐会话隔离：一条写失败不拖累其余；会话表整个读不出来，扫描照样返回新名字、不抛', () => {
    // 共用一个 try 的话，s2 一失败 s3 就留在旧名上 —— 而留在旧名上的后果是这个 bot 从那条
    // 会话里消失（forSession → null）。扫描是侧栏与建根 Agent 的必经之路，更不能因为迁移而抛
    put('scout', md('ranger'))
    seedSessions([
      { id: 's1', bot: 'ranger' },
      { id: 's2', bot: 'ranger' },
      { id: 's3', bot: 'ranger' }
    ])
    mocks.updateSettings.mockImplementation((id: string, patch: { bot: string }) => {
      if (id === 's2') throw new Error('SQLITE_BUSY: database is locked')
      const row = sessionRows.find((r) => r.id === id)
      if (row) row.settings.bot = patch.bot
    })
    botService.listAll()

    notebookWrite('scout', md('hunter'))
    expect(boundBotOfSession('s1')).toBe('hunter')
    expect(boundBotOfSession('s2')).toBe('ranger')
    expect(boundBotOfSession('s3')).toBe('hunter')
    expect(broadcasted()).toEqual(['s1', 's3'])

    // 会话表整个读不出来：迁移放弃，扫描本身不受影响
    restart()
    put('scout', md('ranger'))
    botService.listAll()
    mocks.findAll.mockImplementation(() => {
      throw new Error('SQLITE_CORRUPT: database disk image is malformed')
    })
    put('scout', md('hunter'))
    let names: string[] = []
    expect(() => {
      names = botService.listAll().map((e) => e.file.name)
    }).not.toThrow()
    expect(mocks.findAll).toHaveBeenCalled()
    expect(names).toEqual(['hunter'])
  })

  it('PSv-39 bot.changed 合并窗口：迁移同步发生；广播在最后一笔之后满 300ms 才发、只发一次；窗口过后再写一笔再发一次', () => {
    // 自动保存每 200ms 落一次盘：每笔都广播，侧栏分组与每条 bot 会话的身份胶囊就跟着一直重查。
    // 迁移却不能跟着等 —— 开着的那条会话要立刻看到新名字
    put('scout', md('ranger'))
    seedSessions([{ id: 's1', bot: 'ranger' }])
    botService.listAll()

    notebookWrite('scout', md('hunter'))
    expect(boundBotOfSession('s1')).toBe('hunter')
    vi.advanceTimersByTime(100)
    notebookWrite('scout', md('hunter', { body: '第二笔。' }))
    vi.advanceTimersByTime(100)
    notebookWrite('scout', md('hunter', { body: '第三笔。' }))

    vi.advanceTimersByTime(299)
    expect(events).toEqual([])
    vi.advanceTimersByTime(1)
    expect(events).toEqual([{ type: 'bot.changed' }])

    botService.noteWritten()
    vi.advanceTimersByTime(300)
    expect(events).toEqual([{ type: 'bot.changed' }, { type: 'bot.changed' }])
  })

  it('PSv-40 只有 noteWriting（写还没落盘）不广播', () => {
    // 广播说的是「注册表变了」；写之前补的那次基线扫描什么都没改
    put('scout', md('ranger'))
    botService.noteWriting(scoutPath)
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([])
  })
})
