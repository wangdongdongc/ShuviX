/**
 * botService —— bot 注册表（宿主层）。
 *
 * `~/.shuvix/bots/<name>.md` 纯 md 驱动：文件存在且解析得过就是活的 —— 没有启用开关、
 * 没有旁路配置、没有数据库表、也不内置任何 bot。**编辑不经过本服务**（打开一份 bot 就是打开
 * 它的笔记本会话，改名迁移挂在笔记本写入的回执上），于是本文件按剩下的职责分组：
 *
 *   PSv-1…8   **扫描与解析**：目录里有什么、坏文件去哪、一条会话绑的是谁；
 *   PSv-19    **原子写**：新建落盘不给扫描读到半份文件的机会；
 *   PSv-20…26 **增删与按文件名寻址**：新建的文件名派生、删除的边界、文件名白名单、广播。
 *
 * **fs 是真的** —— 扫描扫的是真目录，换成假 fs 一条也测不到。
 * `readFileSync` / `existsSync` 只是套了一层可数的壳（同
 * instruction/__tests__/instructionInjector.test.ts 的手法）：前者给 PSv-6 造一次读失败，
 * 后者给 PSv-24 证明「白名单排在任何 fs 调用之前」。
 *
 * mock 面：sessionDao / 广播 / logger / electron。`appEventBus` 保持**真实** ——
 * PSv-26 数的就是真事件。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

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

  it('PSv-4 同名两份文件：先到者胜，后者静默跳过且不报 invalid', () => {
    // 身份是 frontmatter 的 `name`，而文件名可以任意 —— 两份文件写同一个名字是做得到的。
    // 现状是**静默丢弃**：第二份既不在 valid 里、也不在 invalid 里，侧栏上完全看不见它，
    // 只有日志里有一句。钉住它，是因为这是唯一能发现这个行为的地方
    put('a-scout', md('scout', { body: '第一份' }))
    put('z-scout', md('scout', { body: '第二份' }))

    const { valid, invalid } = botService.listWithInvalid()
    expect(valid).toHaveLength(1)
    expect(invalid).toEqual([])
    // 胜者是目录枚举序里靠前的那个（服务与本用例看到的是同一次枚举）
    const first = readdirSync(dirs.bots).filter((n) => n.endsWith('.md'))[0]
    expect(valid[0].basePath).toBe(join(dirs.bots, first))
    // 丢弃只在日志里留痕
    expect(mocks.warn.mock.calls.flat().join(' ')).toContain('重复')
  })

  it('PSv-5 目录不存在 → 空清单、不抛，且不创建目录', () => {
    // 首次启动时这个目录不存在。顺手 mkdir 会在用户还没建过任何 bot 时就往 ~/.shuvix
    // 里撒一个空目录 —— 纯 md 驱动的纪律是「用户建了才有」
    rmSync(dirs.bots, { recursive: true, force: true })
    expect(() => botService.listWithInvalid()).not.toThrow()
    expect(botService.listWithInvalid()).toEqual({ valid: [], invalid: [] })
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
    // 身份是名字。放行会得到两份同名文件，而扫描只认先到的那一份（PSv-4）——
    // 用户会看到「新建成功」然后列表里什么都没多
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
