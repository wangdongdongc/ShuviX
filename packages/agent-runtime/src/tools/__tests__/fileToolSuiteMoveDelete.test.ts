/**
 * createFileToolSuite 的 move / delete —— 内存 port（带目录）+ 记录型安全桩（enforcePath 是 spy，每次被问时
 * 把盘面拍一张快照：证明「门在动盘之前」）。
 *
 *   MV-1  move 一个文件：路径门问两次、都是 'write'（先源后目标，展示路径照模型写的），问的时候盘面还没动；
 *         挪完源没了、目标在；回执 `Moved a → b`；onFileChange 两次（源 delete、目标 write，带调用 scope）
 *   MV-2  目标的父目录不存在：照样挪过去（port 负责建）
 *   MV-3  目标已存在 / 源不存在 / 源与目标同一路径 / 目录挪进自己里面：拒、门不问、盘不动、不回调
 *   MV-4  任一头是符号链接、任一头宿主拒写：拒、门不问
 *   MV-5  门拒了目标（第二次询问抛错）：盘不动、不回调
 *   MV-6  询问期间目标被别人建出来：拿锁后再判一次 → 拒，源原样
 *   MV-7  挪一个目录：底下的条目跟着走；onFileChange 两条都带 isDirectory: true
 *   MV-8  读过且读后没改过的文件：目标记一笔读取时间（紧接着 edit 不撞「先读」）；读后被改过的不记；
 *         两把锁按固定次序拿
 *   MV-9  port 没有 rename：报不支持，门不问
 *   DEL-1 删一个文件：门问一次 'write'、在删之前；回执 `Deleted x`；onFileChange 一条 delete
 *   DEL-2 删一个空目录：回执说是空目录；事件带 isDirectory: true
 *   DEL-3 非空目录 / 不存在 / 符号链接 / 宿主拒写：拒、门不问、盘不动
 *   DEL-4 读过、读后被改过的文件：守卫的「先重读」原话，门不问、不删
 *   DEL-5 门拒了：不删、不回调；port 没有 remove：报不支持
 */
import { describe, it, expect, vi, type Mock } from 'vitest'
import type { FileGuards, FileSystemPort } from '../../fileTools/port'
import type { AccessMode, EnforceOpts, SecurityContext } from '../../security/types'
import {
  createFileToolSuite,
  DELETE_DESCRIPTION,
  MOVE_DESCRIPTION,
  type FileChangeEvent,
  type FileToolDeps,
  type FileToolSuite
} from '../fileToolSuite'
import { executeTool, failureText, resultText } from '../testing/invokeTool'
import type { ToolCallScope } from '../toolCall'

const ROOT = '/ws'
/** onFileChange 的第二个参数：executeTool 的假 api 缺省在根对话、tool task 1 上 */
const CALL = expect.objectContaining({ conversationId: 1, taskId: 1 })

interface GateCall {
  mode: AccessMode
  path: string
  displayPath?: string
  toolName: string
  /** 被问那一刻盘上的文件（排好序） */
  filesAtAsk: string[]
}

interface Harness {
  suite: FileToolSuite
  files: Map<string, string>
  dirs: Set<string>
  gate: GateCall[]
  enforcePath: Mock<(mode: AccessMode, path: string, opts: EnforceOpts) => Promise<void>>
  onFileChange: Mock<(e: FileChangeEvent, call: ToolCallScope | undefined) => void>
  readTimes: Set<string>
  /** 读后被改过的路径（assertNotModifiedSinceRead 对它们抛） */
  stale: Set<string>
  locks: string[]
}

interface HarnessOptions {
  files?: Record<string, string>
  /** 显式的（空）目录；有文件的目录自动存在 */
  dirs?: string[]
  /** port 路径 → 它是符号链接 */
  links?: Record<string, { target: string; resolved: string }>
  refuseWrite?: (p: string) => string | null
  /** 门：缺省放行；返回 Error 即拒 */
  decide?: (mode: AccessMode, path: string, h: Harness) => Error | void
  withRename?: boolean
  withRemove?: boolean
}

const norm = (p: string): string => p.replace(/\/+$/, '')
const parentOf = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/'

function makeHarness(opts: HarnessOptions = {}): Harness {
  const files = new Map(Object.entries(opts.files ?? {}))
  const dirs = new Set(opts.dirs ?? [])
  const links = opts.links ?? {}
  const isDir = (p: string): boolean => {
    const n = norm(p)
    if (dirs.has(n)) return true
    const prefix = `${n}/`
    return [...files.keys(), ...dirs].some((k) => k.startsWith(prefix))
  }
  const childrenOf = (p: string): string[] => {
    const prefix = `${norm(p)}/`
    const names = new Set<string>()
    for (const k of [...files.keys(), ...dirs]) {
      if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0])
    }
    return [...names]
  }
  const mkdirs = (p: string): void => {
    for (let d = p; d !== '/' && d !== ROOT; d = parentOf(d)) dirs.add(d)
  }

  const port: FileSystemPort = {
    stat: async (p) => {
      const c = files.get(norm(p))
      if (c !== undefined) return { isFile: true, isDirectory: false, size: c.length, mtimeMs: 1 }
      return isDir(p) ? { isFile: false, isDirectory: true, size: 0, mtimeMs: 1 } : null
    },
    readFile: async (p) => {
      const c = files.get(p)
      if (c === undefined) throw new Error(`ENOENT: ${p}`)
      return c
    },
    async *readTextLines(p) {
      const c = files.get(p)
      if (c === undefined) throw new Error(`ENOENT: ${p}`)
      for (const line of c.split('\n')) yield line
    },
    readBytes: () => {
      throw new Error('not used')
    },
    writeFile: async (p, content) => {
      mkdirs(parentOf(p))
      files.set(p, content)
    },
    readdir: async (p) =>
      childrenOf(p).map((name) => ({ name, isDirectory: isDir(`${p}/${name}`) })),
    readLink: async (p) => links[p] ?? null
  }
  if (opts.withRename !== false) {
    port.rename = async (from, to) => {
      if (files.has(to) || isDir(to)) {
        throw Object.assign(new Error(`EEXIST: ${to}`), { code: 'EEXIST' })
      }
      mkdirs(parentOf(to))
      const c = files.get(from)
      if (c !== undefined) {
        files.delete(from)
        files.set(to, c)
        return
      }
      const prefix = `${from}/`
      for (const [k, v] of [...files]) {
        if (!k.startsWith(prefix)) continue
        files.delete(k)
        files.set(`${to}/${k.slice(prefix.length)}`, v)
      }
      for (const d of [...dirs]) {
        if (d !== from && !d.startsWith(prefix)) continue
        dirs.delete(d)
        dirs.add(`${to}${d.slice(from.length)}`)
      }
    }
  }
  if (opts.withRemove !== false) {
    port.remove = async (p) => {
      if (files.delete(p)) return
      if (childrenOf(p).length > 0) {
        throw Object.assign(new Error(`ENOTEMPTY: ${p}`), { code: 'ENOTEMPTY' })
      }
      dirs.delete(p)
    }
  }

  const readTimes = new Set<string>()
  const stale = new Set<string>()
  const locks: string[] = []
  const guards: FileGuards = {
    hasReadTime: (p) => readTimes.has(p),
    assertNotModifiedSinceRead: (p) => {
      if (stale.has(p)) throw new Error(`File ${p} has been modified since it was last read.`)
    },
    recordRead: (p) => void readTimes.add(p),
    withFileLock: (p, fn) => {
      locks.push(p)
      return fn()
    }
  }

  const gate: GateCall[] = []
  const h = {} as Harness
  const enforcePath = vi.fn(async (mode: AccessMode, path: string, o: EnforceOpts) => {
    gate.push({
      mode,
      path,
      displayPath: o.displayPath,
      toolName: o.toolName,
      filesAtAsk: [...files.keys()].sort()
    })
    const denied = opts.decide?.(mode, path, h)
    if (denied) throw denied
  })
  const security = {
    enforcePath,
    enforceUrl: async () => {
      throw new Error('not used')
    }
  } as unknown as SecurityContext

  const onFileChange = vi.fn<(e: FileChangeEvent, call: ToolCallScope | undefined) => void>()
  const deps: FileToolDeps = {
    port,
    guards,
    resolvePath: (p) => (p.startsWith('/') ? p : `${ROOT}/${p}`),
    security,
    labels: { read: 'Read', write: 'Write', edit: 'Edit' },
    descriptions: { read: 'read', write: 'write', edit: 'edit' },
    onFileChange,
    ...(opts.refuseWrite ? { refuseWrite: opts.refuseWrite } : {})
  }
  Object.assign(h, {
    suite: createFileToolSuite(deps),
    files,
    dirs,
    gate,
    enforcePath,
    onFileChange,
    readTimes,
    stale,
    locks
  })
  return h
}

describe('move', () => {
  it('MV-0 名字、缺省标签与描述、parameters 只有 from / to', () => {
    const { suite } = makeHarness()
    expect(suite.move.name).toBe('move')
    expect(suite.move.label).toBe('Move')
    expect(suite.move.description).toBe(MOVE_DESCRIPTION)
    expect(Object.keys(suite.move.parameters.properties).sort()).toEqual(['from', 'to'])
    expect(suite.move.replay).toBe('unsafe')
  })

  it('MV-1 挪一个文件：门问两次 write（源、目标），问时盘未动；挪完源没了目标在；回执与两条回调', async () => {
    const h = makeHarness({ files: { '/ws/a.md': 'A' } })
    const res = await executeTool(h.suite.move, 'm1', { from: 'a.md', to: 'notes/b.md' })

    expect(res.isError).toBeUndefined()
    expect(resultText(res)).toBe('Moved a.md → notes/b.md')
    expect(h.gate).toEqual([
      {
        mode: 'write',
        path: '/ws/a.md',
        displayPath: 'a.md',
        toolName: 'move',
        filesAtAsk: ['/ws/a.md']
      },
      {
        mode: 'write',
        path: '/ws/notes/b.md',
        displayPath: 'notes/b.md',
        toolName: 'move',
        filesAtAsk: ['/ws/a.md']
      }
    ])
    expect([...h.files.entries()]).toEqual([['/ws/notes/b.md', 'A']])
    expect(h.onFileChange.mock.calls).toEqual([
      [{ portPath: '/ws/a.md', kind: 'delete' }, CALL],
      [{ portPath: '/ws/notes/b.md', kind: 'write' }, CALL]
    ])
  })

  it('MV-2 目标的父目录不存在：照样挪过去', async () => {
    const h = makeHarness({ files: { '/ws/a.md': 'A' } })
    await executeTool(h.suite.move, 'm2', { from: '/ws/a.md', to: '/ws/x/y/z.md' })
    expect(h.files.get('/ws/x/y/z.md')).toBe('A')
    expect(h.dirs.has('/ws/x/y')).toBe(true)
  })

  it.each([
    [
      '目标已存在',
      { files: { '/ws/a.md': 'A', '/ws/b.md': 'B' } },
      { from: 'a.md', to: 'b.md' },
      'Not moved: b.md already exists. move never replaces anything'
    ],
    [
      '源不存在',
      { files: {} },
      { from: 'ghost.md', to: 'b.md' },
      'Not moved: ghost.md does not exist.'
    ],
    [
      '同一路径',
      { files: { '/ws/a.md': 'A' } },
      { from: 'a.md', to: '/ws/a.md' },
      'Not moved: a.md and /ws/a.md are the same path.'
    ],
    [
      '目录挪进自己里面',
      { files: { '/ws/d/x.md': 'X' } },
      { from: 'd', to: 'd/sub/d' },
      'Not moved: d/sub/d is inside d — a directory cannot be moved into itself.'
    ]
  ])('MV-3 %s：拒、门不问、盘不动、不回调', async (_label, setup, args, message) => {
    const h = makeHarness(setup)
    const before = [...h.files.entries()]
    const text = await failureText(executeTool(h.suite.move, 'm3', args))
    expect(text).toContain(message)
    expect(h.enforcePath).not.toHaveBeenCalled()
    expect([...h.files.entries()]).toEqual(before)
    expect(h.onFileChange).not.toHaveBeenCalled()
  })

  it('MV-4 任一头是符号链接 / 任一头宿主拒写：拒、门不问', async () => {
    const link = { target: '../secret.md', resolved: '/secret.md' }
    for (const at of ['/ws/a.md', '/ws/b.md']) {
      const h = makeHarness({ files: { '/ws/a.md': 'A' }, links: { [at]: link } })
      const text = await failureText(executeTool(h.suite.move, 'm4', { from: 'a.md', to: 'b.md' }))
      const display = at === '/ws/a.md' ? 'a.md' : 'b.md'
      expect(text).toBe(
        `Not moved: ${display} is a symbolic link to /secret.md (the link says "../secret.md"). ` +
          'Symbolic links are not followed — move /secret.md directly if that is the file you mean.'
      )
      expect(h.enforcePath).not.toHaveBeenCalled()
      expect(h.files.get('/ws/a.md')).toBe('A')
    }
    for (const at of ['/ws/a.md', '/ws/b.md']) {
      const h = makeHarness({
        files: { '/ws/a.md': 'A' },
        refuseWrite: (p) => (p === at ? `refused ${p}` : null)
      })
      const text = await failureText(executeTool(h.suite.move, 'm4', { from: 'a.md', to: 'b.md' }))
      expect(text).toBe(`refused ${at}`)
      expect(h.enforcePath).not.toHaveBeenCalled()
      expect(h.files.get('/ws/a.md')).toBe('A')
    }
  })

  it('MV-5 门拒了目标：盘不动、不回调', async () => {
    const h = makeHarness({
      files: { '/ws/a.md': 'A' },
      decide: (_mode, path) => (path === '/ws/b.md' ? new Error('Denied by the user') : undefined)
    })
    const text = await failureText(executeTool(h.suite.move, 'm5', { from: 'a.md', to: 'b.md' }))
    expect(text).toBe('Denied by the user')
    expect(h.gate.map((g) => g.path)).toEqual(['/ws/a.md', '/ws/b.md'])
    expect([...h.files.keys()]).toEqual(['/ws/a.md'])
    expect(h.onFileChange).not.toHaveBeenCalled()
  })

  it('MV-6 询问期间目标被建出来：拿锁后再判 → 拒，源原样', async () => {
    const h = makeHarness({
      files: { '/ws/a.md': 'A' },
      decide: (_mode, path, harness) => {
        if (path === '/ws/b.md') harness.files.set('/ws/b.md', 'someone else')
      }
    })
    const text = await failureText(executeTool(h.suite.move, 'm6', { from: 'a.md', to: 'b.md' }))
    expect(text).toContain('Not moved: b.md already exists.')
    expect(h.files.get('/ws/a.md')).toBe('A')
    expect(h.files.get('/ws/b.md')).toBe('someone else')
    expect(h.onFileChange).not.toHaveBeenCalled()
  })

  it('MV-7 挪一个目录：底下的条目跟着走，两条回调都带 isDirectory', async () => {
    const h = makeHarness({
      files: { '/ws/d/x.md': 'X', '/ws/d/sub/y.md': 'Y' },
      dirs: ['/ws/d/empty']
    })
    const res = await executeTool(h.suite.move, 'm7', { from: 'd', to: 'e/d2' })
    expect(resultText(res)).toBe('Moved d → e/d2')
    expect([...h.files.entries()].sort()).toEqual([
      ['/ws/e/d2/sub/y.md', 'Y'],
      ['/ws/e/d2/x.md', 'X']
    ])
    expect(h.dirs.has('/ws/e/d2/empty')).toBe(true)
    expect(h.onFileChange.mock.calls).toEqual([
      [{ portPath: '/ws/d', kind: 'delete', isDirectory: true }, CALL],
      [{ portPath: '/ws/e/d2', kind: 'write', isDirectory: true }, CALL]
    ])
  })

  it('MV-8 读取时间：读过且没改过 → 目标记一笔；读后被改过 → 不记；两把锁按固定次序拿', async () => {
    const h = makeHarness({ files: { '/ws/z.md': 'Z', '/ws/q.md': 'Q' } })
    h.readTimes.add('/ws/z.md')
    await executeTool(h.suite.move, 'm8', { from: 'z.md', to: 'a.md' })
    expect(h.readTimes.has('/ws/a.md')).toBe(true)
    // 锁的次序与参数次序无关：先小后大
    expect(h.locks).toEqual(['/ws/a.md', '/ws/z.md'])

    h.readTimes.add('/ws/q.md')
    h.stale.add('/ws/q.md')
    await executeTool(h.suite.move, 'm8b', { from: 'q.md', to: 'r.md' })
    expect(h.files.get('/ws/r.md')).toBe('Q')
    expect(h.readTimes.has('/ws/r.md')).toBe(false)

    // 没读过的不凭空记
    const fresh = makeHarness({ files: { '/ws/n.md': 'N' } })
    await executeTool(fresh.suite.move, 'm8c', { from: 'n.md', to: 'm.md' })
    expect(fresh.readTimes.size).toBe(0)
  })

  it('MV-9 port 没有 rename：报不支持，门不问', async () => {
    const h = makeHarness({ files: { '/ws/a.md': 'A' }, withRename: false })
    const text = await failureText(executeTool(h.suite.move, 'm9', { from: 'a.md', to: 'b.md' }))
    expect(text).toBe('move is not available here: this host cannot move or rename files.')
    expect(h.enforcePath).not.toHaveBeenCalled()
  })
})

describe('delete', () => {
  it('DEL-0 名字、缺省标签与描述、parameters 只有 path', () => {
    const { suite } = makeHarness()
    expect(suite.delete.name).toBe('delete')
    expect(suite.delete.label).toBe('Delete')
    expect(suite.delete.description).toBe(DELETE_DESCRIPTION)
    expect(Object.keys(suite.delete.parameters.properties)).toEqual(['path'])
  })

  it('DEL-1 删一个文件：门问一次 write、在删之前；回执与一条 delete 回调', async () => {
    const h = makeHarness({ files: { '/ws/a.md': 'A', '/ws/keep.md': 'K' } })
    const res = await executeTool(h.suite.delete, 'd1', { path: 'a.md' })
    expect(resultText(res)).toBe('Deleted a.md')
    expect(h.gate).toEqual([
      {
        mode: 'write',
        path: '/ws/a.md',
        displayPath: 'a.md',
        toolName: 'delete',
        filesAtAsk: ['/ws/a.md', '/ws/keep.md']
      }
    ])
    expect([...h.files.keys()]).toEqual(['/ws/keep.md'])
    expect(h.locks).toEqual(['/ws/a.md'])
    expect(h.onFileChange.mock.calls).toEqual([[{ portPath: '/ws/a.md', kind: 'delete' }, CALL]])
  })

  it('DEL-2 删一个空目录：回执说是空目录，事件带 isDirectory', async () => {
    const h = makeHarness({ dirs: ['/ws/empty'] })
    const res = await executeTool(h.suite.delete, 'd2', { path: 'empty' })
    expect(resultText(res)).toBe('Deleted the empty directory empty')
    expect(h.dirs.has('/ws/empty')).toBe(false)
    expect(h.onFileChange.mock.calls).toEqual([
      [{ portPath: '/ws/empty', kind: 'delete', isDirectory: true }, CALL]
    ])
  })

  it('DEL-3 非空目录 / 不存在 / 符号链接 / 宿主拒写：拒、门不问、盘不动', async () => {
    const cases: Array<[HarnessOptions, string, string]> = [
      [
        { files: { '/ws/d/x.md': 'X', '/ws/d/y.md': 'Y' } },
        'd',
        'Not deleted: d is a directory with 2 entries in it. delete removes only files and empty directories — delete or move what is inside first.'
      ],
      [{ files: { '/ws/d/x.md': 'X' } }, 'd', 'Not deleted: d is a directory with 1 entry in it.'],
      [{ files: {} }, 'ghost.md', 'Not deleted: ghost.md does not exist.'],
      [
        {
          files: { '/ws/a.md': 'A' },
          links: { '/ws/a.md': { target: '/elsewhere/a.md', resolved: '/elsewhere/a.md' } }
        },
        'a.md',
        'Not deleted: a.md is a symbolic link to /elsewhere/a.md. Symbolic links are not followed — delete /elsewhere/a.md directly if that is the file you mean.'
      ],
      [{ files: { '/ws/a.md': 'A' }, refuseWrite: () => 'not this one' }, 'a.md', 'not this one']
    ]
    for (const [setup, path, message] of cases) {
      const h = makeHarness(setup)
      const before = [...h.files.entries()]
      const text = await failureText(executeTool(h.suite.delete, 'd3', { path }))
      expect(text, path).toContain(message)
      expect(h.enforcePath, path).not.toHaveBeenCalled()
      expect([...h.files.entries()], path).toEqual(before)
      expect(h.onFileChange, path).not.toHaveBeenCalled()
    }
  })

  it('DEL-4 读过、读后被改过的文件：守卫原话，门不问、不删', async () => {
    const h = makeHarness({ files: { '/ws/a.md': 'A' } })
    h.readTimes.add('/ws/a.md')
    h.stale.add('/ws/a.md')
    const text = await failureText(executeTool(h.suite.delete, 'd4', { path: 'a.md' }))
    expect(text).toBe('File /ws/a.md has been modified since it was last read.')
    expect(h.enforcePath).not.toHaveBeenCalled()
    expect(h.files.get('/ws/a.md')).toBe('A')
  })

  it('DEL-5 门拒了：不删、不回调；port 没有 remove：报不支持，门不问', async () => {
    const denied = makeHarness({
      files: { '/ws/a.md': 'A' },
      decide: () => new Error('Denied by the user')
    })
    expect(await failureText(executeTool(denied.suite.delete, 'd5', { path: 'a.md' }))).toBe(
      'Denied by the user'
    )
    expect(denied.files.get('/ws/a.md')).toBe('A')
    expect(denied.onFileChange).not.toHaveBeenCalled()

    const bare = makeHarness({ files: { '/ws/a.md': 'A' }, withRemove: false })
    expect(await failureText(executeTool(bare.suite.delete, 'd5b', { path: 'a.md' }))).toBe(
      'delete is not available here: this host cannot delete files.'
    )
    expect(bare.enforcePath).not.toHaveBeenCalled()
  })
})
