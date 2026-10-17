/**
 * 内置浏览器的网站数据（services/browser/siteData.ts，2026-10-16）—— 设置页网站列表、站点详情与删除的主进程一侧。
 *
 *   SD-U2   siteOfHost：可注册域名（tldts，含私有后缀）；github.io 本身 / IP / localhost / [::1] / 单标签 → 主机名本身；
 *           去掉前导点、转小写；
 *   SD-U3   siteOfUrl：http(s) → 分组键（带用户名密码、IPv6 也认）；file / about / shuvix / data / blob / 乱码 / 空串 → null；
 *   SD-U4   只有 Cookie：按 Cookie 的域分组，cookieBytes = Σ(名 + 值)，域为空的 Cookie 丢掉；一个来源都没有时不建临时 view；
 *   SD-U5   配额库（WebStorage/QuotaManager 的 buckets）：分区键 `a^0top` 只认 a；同一来源取最大的 last_accessed；
 *           NULL / 0 → 没有 lastAccessed；端口保留；非 http(s) 与乱码跳过；只读打开、用完关掉；
 *   SD-U6   发现失败不让列表失败：配额库不存在 / 不是 SQLite / 没有 buckets 表 / getStoragePath 回 null；
 *   SD-U7   IndexedDB 目录名兜底（`<scheme>_<host>_<port>.indexeddb.(leveldb|blob)`，端口 0 = 缺省，https 的 443 归一）；
 *   SD-U8   本地存储：.log 里类型 1 的写入、.ldb 里任何一次出现都算；MANIFEST / LOG / CURRENT 不读；两字节 varint 键长也认；
 *   SD-U9   本地存储不误报：值里的 `_https://…`（后面没有 \0\x01，或前面不是一条操作）不算；写了又删的键不算 ——
 *           同一个 .log 里、或编号更大的 .log 里（按文件编号、不按文件名的字典序）；删了又写回来的算；
 *   SD-U10  占用查询的临时 view：每次调用一个（偏好、拒绝弹窗、about:blank、attach '1.3'）、每个来源一次
 *           Storage.getUsageAndQuota（并发、每批 6 个）、计时器用完就清、detach + close 各一次，下一次调用新建一个；
 *   SD-U11  占用的映射：usageBytes = 回包的 usage（不是分项之和）；分项 indexeddb / cache_storage / service_workers →
 *           三类，其余 → other；缺的字段当 0；
 *   SD-U12  失败 / 永不回答的来源（3 s 超时）当 0、不拖住别的来源；loadURL 失败 → 列表照回，close 了、没 attach 就不 detach；
 *   SD-U13  siteDetails 的形状：来源按字符串排、Cookie 按域再按名字排，Cookie 的映射（过期毫秒、会话 Cookie 没有 expires、
 *           sameSite 缺省 'unspecified'、path 缺省 '/'）；只查这个网站的来源；
 *   SD-U14  空的不列：只有一个 0 占用、没有本地存储、没有 Cookie 的网站不列、详情回 null；0 占用的来源从详情里拿掉、
 *           网站因为 Cookie 留着；不认识的网站 → null，连 view 都不建；
 *   SD-U15  clearSite：每条 Cookie 按 `<https|http>://<去点的域><path>` + 名字删，然后一次 clearData（七类、
 *           存过数据的来源 ∪ 每个 Cookie 主机的 http / https，去重）；先删 Cookie 再清；删一条失败不影响其余；
 *   SD-U16  clearSite 的边：不认识的网站什么也不做；只有 Cookie 的网站照清这些主机的存储；只有存储的网站不删 Cookie；
 *           不建临时 view；
 *   SD-U17  clearSiteCategory：cookies 只删 Cookie；其余各一次 clearData（对应的 dataTypes）、不碰 Cookie；
 *           不认识的类别（含原型上的键 'toString' / 'constructor'）什么也不做、连 Cookie 都不读；
 *   SD-U18  clearOrigin：只认恰好是一个来源的串（允许一个结尾斜杠）→ 七类 clearData，从不碰 Cookie；别的忽略；
 *   SD-U19  removeCookie：用一条同名同域同路径、已过期的 Cookie 覆盖（域 Cookie 带 domain、只限主机的不带）；
 *           覆盖被拒才退回 cookies.remove(url, name)；不合法的输入什么也不做。
 *
 * electron 是替身（session.fromPartition 回一个假分区：cookies.get / remove / set、clearData、getStoragePath →
 * 每条用例一个新的临时目录；WebContentsView 记下构造参数，webContents 的 loadURL / setWindowOpenHandler /
 * debugger.* / close 都是间谍，debugger.sendCommand 按每个来源的表作答）。better-sqlite3 在 node 版 vitest 里
 * 载不进来（编给 Electron 的 ABI），换成 node:sqlite 上的一层薄壳；配额库夹具也用 node:sqlite 写。
 * Chromium 的时间（1601 起的微秒）超过 MAX_SAFE_INTEGER，所以壳按 BigInt 读、再转 number（与 better-sqlite3 缺省一样）。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

interface FakeCookie {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  hostOnly?: boolean
  session?: boolean
  expirationDate?: number
  sameSite?: string
}

type UsageAnswer =
  | { usage?: number; usageBreakdown?: Array<{ storageType: string; usage: number }> }
  | 'reject'
  | 'hang'

interface FakeView {
  opts: unknown
  webContents: {
    loadURL: Mock<(url: string) => Promise<void>>
    setWindowOpenHandler: Mock<(fn: () => unknown) => void>
    isDestroyed: Mock<() => boolean>
    close: Mock<() => void>
    debugger: {
      attach: Mock<(version?: string) => void>
      isAttached: Mock<() => boolean>
      detach: Mock<() => void>
      sendCommand: Mock<(method: string, params?: { origin?: string }) => Promise<unknown>>
    }
  }
}

const state = vi.hoisted(() => {
  const s = {
    storagePath: '' as string | null,
    cookies: [] as FakeCookie[],
    usage: {} as Record<string, UsageAnswer>,
    /** 为真时 sendCommand 一律挂起，由用例逐个放行（看并发批次） */
    deferUsage: false,
    deferred: [] as Array<{ origin: string; resolve: (v: unknown) => void }>,
    loadFails: false,
    views: [] as FakeView[],
    sqliteOpens: [] as Array<{ file: string; opts: unknown }>,
    sqliteCloses: 0,
    fromPartition: vi.fn(),
    cookiesGet: vi.fn(),
    cookiesRemove: vi.fn(),
    cookiesSet: vi.fn(),
    clearData: vi.fn(),
    getStoragePath: vi.fn()
  }
  s.cookiesGet.mockImplementation(async () => s.cookies.map((c) => ({ ...c })))
  s.cookiesRemove.mockImplementation(async () => undefined)
  s.cookiesSet.mockImplementation(async () => undefined)
  s.clearData.mockImplementation(async () => undefined)
  s.getStoragePath.mockImplementation(() => s.storagePath)
  s.fromPartition.mockImplementation(() => ({
    cookies: { get: s.cookiesGet, remove: s.cookiesRemove, set: s.cookiesSet },
    clearData: s.clearData,
    getStoragePath: s.getStoragePath
  }))
  return s
})

function makeView(opts: unknown): FakeView {
  let destroyed = false
  let attached = false
  const view: FakeView = {
    opts,
    webContents: {
      loadURL: vi.fn(async () => {
        if (state.loadFails) throw new Error('ERR_FAILED')
      }),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: vi.fn(() => destroyed),
      close: vi.fn(() => {
        destroyed = true
      }),
      debugger: {
        attach: vi.fn(() => {
          attached = true
        }),
        isAttached: vi.fn(() => attached),
        detach: vi.fn(() => {
          attached = false
        }),
        sendCommand: vi.fn(async (_method: string, params?: { origin?: string }) => {
          const origin = params?.origin ?? ''
          if (state.deferUsage) {
            return new Promise((resolve) => state.deferred.push({ origin, resolve }))
          }
          const answer = state.usage[origin]
          if (answer === 'reject') throw new Error('Storage.getUsageAndQuota failed')
          if (answer === 'hang') return new Promise(() => undefined)
          return answer ?? { usage: 0, usageBreakdown: [] }
        })
      }
    }
  }
  state.views.push(view)
  return view
}

vi.mock('electron', () => ({
  session: { fromPartition: (partition: string) => state.fromPartition(partition) },
  WebContentsView: class {
    constructor(opts: unknown) {
      return makeView(opts)
    }
  }
}))

// better-sqlite3 → node:sqlite 上的薄壳（只读打开；整数按 BigInt 读再转 number）
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync: Sync } = await import('node:sqlite')
  class Database {
    private db: InstanceType<typeof Sync>
    constructor(file: string, opts?: unknown) {
      state.sqliteOpens.push({ file, opts })
      this.db = new Sync(file, { readOnly: true })
    }
    prepare(sql: string): { all: () => Array<Record<string, unknown>> } {
      const stmt = this.db.prepare(sql)
      stmt.setReadBigInts(true)
      return {
        all: () =>
          (stmt.all() as Array<Record<string, unknown>>).map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
            )
          )
      }
    }
    close(): void {
      state.sqliteCloses++
      this.db.close()
    }
  }
  return { default: Database }
})

// mock 路径按**测试文件**解析：被测模块在 services/browser/，测试在其 __tests__/ 下
vi.mock('../browserViewService', () => ({ BROWSER_PARTITION: 'persist:shuvix-browser' }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))

import {
  clearOrigin,
  clearSite,
  clearSiteCategory,
  listSites,
  removeCookie,
  siteDetails,
  siteOfHost,
  siteOfUrl
} from '../siteData'

const PARTITION = 'persist:shuvix-browser'
const ALL_TYPES = [
  'localStorage',
  'indexedDB',
  'cache',
  'serviceWorkers',
  'fileSystems',
  'webSQL',
  'backgroundFetch'
]

let storage = ''

beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), 'shuvix-sitedata-'))
  state.storagePath = storage
  state.cookies = []
  state.usage = {}
  state.deferUsage = false
  state.deferred = []
  state.loadFails = false
  state.views = []
  state.sqliteOpens = []
  state.sqliteCloses = 0
  state.fromPartition.mockClear()
  state.cookiesGet.mockClear()
  state.cookiesRemove.mockReset()
  state.cookiesRemove.mockImplementation(async () => undefined)
  state.cookiesSet.mockReset()
  state.cookiesSet.mockImplementation(async () => undefined)
  state.clearData.mockClear()
  state.getStoragePath.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(storage, { recursive: true, force: true })
})

// ─── 夹具 ───

const ck = (over: Partial<FakeCookie> & { name: string; domain: string }): FakeCookie => ({
  value: 'v',
  path: '/',
  secure: false,
  httpOnly: false,
  hostOnly: !over.domain.startsWith('.'),
  session: false,
  ...over
})

/** Unix 毫秒 → Chromium 的时间（1601-01-01 起的微秒） */
const chromeTime = (ms: number): bigint => (BigInt(ms) + 11644473600000n) * 1000n

/** 写配额库：`buckets(storage_key, last_accessed)` */
function quotaDb(rows: Array<[string | null, bigint | number | null]>): void {
  mkdirSync(join(storage, 'WebStorage'), { recursive: true })
  const db = new DatabaseSync(join(storage, 'WebStorage', 'QuotaManager'))
  db.exec('CREATE TABLE buckets(storage_key TEXT, last_accessed INTEGER)')
  const insert = db.prepare('INSERT INTO buckets (storage_key, last_accessed) VALUES (?, ?)')
  for (const [key, at] of rows) insert.run(key, at)
  db.close()
}

function idbDir(name: string): void {
  mkdirSync(join(storage, 'IndexedDB', name), { recursive: true })
}

function lsFile(name: string, ...parts: Buffer[]): void {
  const dir = join(storage, 'Local Storage', 'leveldb')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), Buffer.concat(parts))
}

function varint(n: number): Buffer {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return Buffer.from(out)
}

/** 本地存储的一个键：`_<origin>\0\x01<键>` */
const lsKey = (origin: string, key = 'k'): Buffer =>
  Buffer.from(`_${origin}\x00\x01${key}`, 'latin1')
/** 写前日志里一批操作的头（校验和 / 长度 / 类型 + 序号 / 条数）—— 内容无关紧要 */
const batchHeader = (): Buffer => Buffer.alloc(19, 0xab)
/** 一条写入：类型 1、varint 键长、键、varint 值长、值 */
const put = (key: Buffer, value = 'v'): Buffer => {
  const v = Buffer.from(value, 'latin1')
  return Buffer.concat([Buffer.from([1]), varint(key.length), key, varint(v.length), v])
}
/** 一条删除：类型 0、varint 键长、键 */
const del = (key: Buffer): Buffer => Buffer.concat([Buffer.from([0]), varint(key.length), key])

const views = (): FakeView[] => state.views
const queried = (): string[] =>
  state.views.flatMap((v) =>
    v.webContents.debugger.sendCommand.mock.calls.map(([, params]) => String(params?.origin))
  )
const sorted = (xs: string[]): string[] => [...xs].sort()
const siteNames = async (): Promise<string[]> => (await listSites()).map((s) => s.site)

describe('分组键（SD-U2 / SD-U3）', () => {
  it.each([
    ['www.github.com', 'github.com'],
    ['gist.github.com', 'github.com'],
    ['github.com', 'github.com'],
    ['.github.com', 'github.com'],
    ['WWW.GitHub.COM', 'github.com'],
    ['a.b.example.co.uk', 'example.co.uk'],
    ['foo.github.io', 'foo.github.io'],
    ['bar.foo.github.io', 'foo.github.io'],
    ['github.io', 'github.io'],
    ['127.0.0.1', '127.0.0.1'],
    ['192.168.1.10', '192.168.1.10'],
    ['localhost', 'localhost'],
    ['[::1]', '[::1]'],
    ['intranet', 'intranet']
  ])('SD-U2 siteOfHost(%j) = %j', (host, site) => {
    expect(siteOfHost(host)).toBe(site)
  })

  it.each([
    ['https://www.github.com/x?y=1', 'github.com'],
    ['http://127.0.0.1:5173/app', '127.0.0.1'],
    ['http://localhost:3000/', 'localhost'],
    ['http://[::1]:8080/', '[::1]'],
    ['https://user:pw@www.github.com/', 'github.com'],
    ['HTTPS://WWW.GITHUB.COM/', 'github.com'],
    ['https://foo.github.io/page', 'foo.github.io']
  ])('SD-U3 siteOfUrl(%j) = %j', (url, site) => {
    expect(siteOfUrl(url)).toBe(site)
  })

  it.each([
    ['file:///Users/me/a.html'],
    ['about:blank'],
    ['shuvix://settings'],
    ['data:text/html,hi'],
    ['blob:https://a.test/0f7c'],
    ['ftp://files.example.com/'],
    ['not a url'],
    ['']
  ])('SD-U3 siteOfUrl(%j) = null', (url) => {
    expect(siteOfUrl(url)).toBeNull()
  })
})

describe('只有 Cookie（SD-U4）', () => {
  it('SD-U4 按 Cookie 的域分组成网站；cookieBytes = Σ(名 + 值)；域为空的丢掉；不建临时 view', async () => {
    state.cookies = [
      ck({ name: 'sid', value: 'abcdef', domain: '.github.com' }),
      ck({ name: 'pref', value: 'x', domain: 'www.github.com', path: '/x' }),
      ck({ name: 'lang', value: 'en', domain: 'gist.github.com' }),
      ck({ name: 'one', value: '1', domain: 'a.test' }),
      ck({ name: 'ghost', value: 'no-domain', domain: '' }),
      { name: 'ghost2', value: 'undefined-domain', path: '/' }
    ]
    const sites = await listSites()
    expect(sites).toEqual([
      {
        site: 'a.test',
        cookieCount: 1,
        cookieBytes: 4,
        usageBytes: 0,
        localStorage: false,
        originCount: 0
      },
      {
        site: 'github.com',
        cookieCount: 3,
        cookieBytes: 'sid'.length + 6 + 'pref'.length + 1 + 'lang'.length + 2,
        usageBytes: 0,
        localStorage: false,
        originCount: 0
      }
    ])
    expect(sites[0]).not.toHaveProperty('lastAccessed')
    expect(state.fromPartition).toHaveBeenCalledWith(PARTITION)
    expect(state.cookiesGet.mock.calls).toEqual([[{}]])
    expect(views()).toEqual([])
  })

  it('SD-U4 什么都没有：空列表、不建 view', async () => {
    expect(await listSites()).toEqual([])
    expect(views()).toEqual([])
  })
})

describe('配额库（SD-U5）', () => {
  const T0 = 1_700_000_000_000
  const T1 = 1_760_000_000_000
  const T2 = 1_750_000_000_000
  const T3 = 1_740_000_000_000

  beforeEach(() => {
    quotaDb([
      ['https://q.test/', chromeTime(T1)],
      ['https://q.test/', chromeTime(T0)],
      ['https://embed.test/^0https://top.test', chromeTime(T2)],
      ['https://nul.test/', null],
      ['https://zero.test/', 0],
      ['http://127.0.0.1:5173/', chromeTime(T3)],
      ['chrome-extension://abcdefgh/', chromeTime(T1)],
      ['file:///', chromeTime(T1)],
      ['garbage', chromeTime(T1)],
      ['', chromeTime(T1)],
      [null, chromeTime(T1)]
    ])
    for (const o of [
      'https://q.test',
      'https://embed.test',
      'https://nul.test',
      'https://zero.test',
      'http://127.0.0.1:5173'
    ]) {
      state.usage[o] = { usage: 10, usageBreakdown: [{ storageType: 'indexeddb', usage: 10 }] }
    }
  })

  it('SD-U5 分区键只认前面的来源；同一来源取最大的 last_accessed；NULL / 0 没有 lastAccessed；端口保留；别的跳过', async () => {
    const sites = await listSites()
    expect(sites.map((s) => s.site)).toEqual([
      '127.0.0.1',
      'embed.test',
      'nul.test',
      'q.test',
      'zero.test'
    ])
    const by = Object.fromEntries(sites.map((s) => [s.site, s]))
    expect(by['q.test'].lastAccessed).toBe(T1)
    expect(by['embed.test'].lastAccessed).toBe(T2)
    expect(by['127.0.0.1'].lastAccessed).toBe(T3)
    expect(by['nul.test']).not.toHaveProperty('lastAccessed')
    expect(by['zero.test']).not.toHaveProperty('lastAccessed')
    for (const s of sites) expect(s).toMatchObject({ originCount: 1, usageBytes: 10 })

    // 查的正是这几个来源（端口保留、非 http(s) 与乱码没进来）
    expect(sorted(queried())).toEqual(
      sorted([
        'https://q.test',
        'https://embed.test',
        'https://nul.test',
        'https://zero.test',
        'http://127.0.0.1:5173'
      ])
    )
  })

  it('SD-U5 来源级的 lastAccessed 也在详情里；配额库只读打开、用完关掉', async () => {
    const details = await siteDetails('q.test')
    expect(details?.origins).toEqual([
      {
        origin: 'https://q.test',
        usageBytes: 10,
        usage: { indexedDB: 10, cacheStorage: 0, serviceWorkers: 0, other: 0 },
        localStorage: false,
        lastAccessed: T1
      }
    ])
    expect(state.sqliteOpens.length).toBeGreaterThan(0)
    for (const open of state.sqliteOpens) {
      expect(open.file).toBe(join(storage, 'WebStorage', 'QuotaManager'))
      expect(open.opts).toMatchObject({ readonly: true })
    }
    expect(state.sqliteCloses).toBe(state.sqliteOpens.length)
  })
})

describe('发现失败不让列表失败（SD-U6）', () => {
  beforeEach(() => {
    state.cookies = [ck({ name: 'c', domain: 'cookie.test' })]
    idbDir('https_idb.test_0.indexeddb.leveldb')
    state.usage['https://idb.test'] = { usage: 7, usageBreakdown: [] }
  })

  it('SD-U6 配额库不存在：不打开，其余来源照列', async () => {
    expect(await siteNames()).toEqual(['cookie.test', 'idb.test'])
    expect(state.sqliteOpens).toEqual([])
  })

  it('SD-U6 配额库不是 SQLite：读失败吞掉，其余照列', async () => {
    mkdirSync(join(storage, 'WebStorage'), { recursive: true })
    writeFileSync(join(storage, 'WebStorage', 'QuotaManager'), 'this is not a database at all')
    expect(await siteNames()).toEqual(['cookie.test', 'idb.test'])
    expect(state.sqliteOpens).toHaveLength(1)
    expect(state.sqliteCloses).toBe(1)
  })

  it('SD-U6 配额库里没有 buckets 表：读失败吞掉，其余照列', async () => {
    mkdirSync(join(storage, 'WebStorage'), { recursive: true })
    const db = new DatabaseSync(join(storage, 'WebStorage', 'QuotaManager'))
    db.exec('CREATE TABLE meta(key TEXT, value TEXT)')
    db.close()
    expect(await siteNames()).toEqual(['cookie.test', 'idb.test'])
    expect(state.sqliteCloses).toBe(1)
  })

  it('SD-U6 getStoragePath 回 null：只有 Cookie 的网站，不建 view', async () => {
    state.storagePath = null
    expect(await siteNames()).toEqual(['cookie.test'])
    expect(views()).toEqual([])
  })
})

describe('IndexedDB 目录兜底（SD-U7）', () => {
  it('SD-U7 目录名里的来源：端口 0 = 缺省端口，https 的 443 归一；blob 目录也认；别的名字跳过', async () => {
    idbDir('https_idb.test_0.indexeddb.leveldb')
    idbDir('http_127.0.0.1_8080.indexeddb.blob')
    idbDir('https_idb2.test_443.indexeddb.leveldb')
    idbDir('ftp_files.test_0.indexeddb.leveldb')
    idbDir('https_odd.test_0.indexeddb.other')
    idbDir('README')
    writeFileSync(join(storage, 'IndexedDB', 'https_file.test_0.indexeddb.leveldb.txt'), 'x')
    for (const o of ['https://idb.test', 'http://127.0.0.1:8080', 'https://idb2.test']) {
      state.usage[o] = { usage: 5, usageBreakdown: [{ storageType: 'indexeddb', usage: 5 }] }
    }
    expect(await siteNames()).toEqual(['127.0.0.1', 'idb.test', 'idb2.test'])
    expect(sorted(queried())).toEqual(
      sorted(['https://idb.test', 'http://127.0.0.1:8080', 'https://idb2.test'])
    )
  })

  it('SD-U7 配额库里已经有的来源：目录不覆盖它的 lastAccessed', async () => {
    const T = 1_765_000_000_000
    quotaDb([['https://idb.test/', chromeTime(T)]])
    idbDir('https_idb.test_0.indexeddb.leveldb')
    state.usage['https://idb.test'] = { usage: 5, usageBreakdown: [] }
    const [site] = await listSites()
    expect(site).toMatchObject({ site: 'idb.test', originCount: 1, lastAccessed: T })
    expect(queried()).toEqual(['https://idb.test'])
  })
})

describe('本地存储（SD-U8 / SD-U9）', () => {
  it('SD-U8 .log 里的写入、.ldb 里的出现都算；两字节 varint 键长也认；MANIFEST / LOG / CURRENT 不读', async () => {
    lsFile('000003.log', batchHeader(), put(lsKey('https://ls.test')))
    lsFile(
      '000004.log',
      batchHeader(),
      put(lsKey('http://127.0.0.1:5173', 'x'.repeat(200)), 'value'),
      put(lsKey('http://[::1]:8080', 'k'))
    )
    // 压实后的表：键可能被前缀压缩，前面的字节什么都可能是 —— 出现过就算
    lsFile('000005.ldb', Buffer.from('\x07\x09junk'), lsKey('https://tbl.test'), Buffer.from('zz'))
    lsFile('MANIFEST-000001', put(lsKey('https://manifest.test')))
    lsFile('LOG', put(lsKey('https://logfile.test')))
    lsFile('CURRENT', put(lsKey('https://current.test')))

    const sites = await listSites()
    // localeCompare：标点在数字前
    expect(sites.map((s) => s.site)).toEqual(['[::1]', '127.0.0.1', 'ls.test', 'tbl.test'])
    for (const s of sites) {
      expect(s).toMatchObject({
        localStorage: true,
        originCount: 1,
        usageBytes: 0,
        cookieCount: 0
      })
    }
    const details = await siteDetails('127.0.0.1')
    expect(details?.origins).toEqual([
      {
        origin: 'http://127.0.0.1:5173',
        usageBytes: 0,
        usage: { indexedDB: 0, cacheStorage: 0, serviceWorkers: 0, other: 0 },
        localStorage: true
      }
    ])
    expect(details?.localStorage).toBe(true)
  })

  it('SD-U8 本地存储的来源也在占用表里查一次；有占用的来源同时标本地存储', async () => {
    quotaDb([['https://both.test/', chromeTime(1_760_000_000_000)]])
    state.usage['https://both.test'] = { usage: 100, usageBreakdown: [] }
    lsFile('000003.log', batchHeader(), put(lsKey('https://both.test')))
    const [site] = await listSites()
    expect(site).toMatchObject({
      site: 'both.test',
      usageBytes: 100,
      localStorage: true,
      originCount: 1
    })
    expect(queried()).toEqual(['https://both.test'])
  })

  it('SD-U9 值里的 `_https://…`：后面没有 \\0\\x01、或前面不是一条操作，都不算', async () => {
    lsFile(
      '000003.log',
      batchHeader(),
      put(lsKey('https://ok.test'), '_https://evil.test/path?x=1'),
      put(lsKey('https://ok2.test'), `xy_https://evil2.test\x00\x01k`)
    )
    expect(await siteNames()).toEqual(['ok.test', 'ok2.test'])
  })

  it('SD-U9 同一个 .log 里写了又删的键不算；同一来源还有别的键活着就算', async () => {
    lsFile(
      '000003.log',
      batchHeader(),
      put(lsKey('https://gone.test', 'a')),
      put(lsKey('https://kept.test', 'a')),
      put(lsKey('https://kept.test', 'b')),
      batchHeader(),
      del(lsKey('https://gone.test', 'a')),
      del(lsKey('https://kept.test', 'a'))
    )
    expect(await siteNames()).toEqual(['kept.test'])
  })

  it('SD-U9 按文件编号（不是文件名字典序）重放：9.log 写、10.log 删 → 不算；9.log 删、10.log 写 → 算', async () => {
    lsFile(
      '9.log',
      batchHeader(),
      put(lsKey('https://later-deleted.test')),
      del(lsKey('https://rewritten.test'))
    )
    lsFile(
      '10.log',
      batchHeader(),
      del(lsKey('https://later-deleted.test')),
      put(lsKey('https://rewritten.test'))
    )
    expect(await siteNames()).toEqual(['rewritten.test'])
  })
})

describe('占用查询的临时 view（SD-U10 / SD-U11 / SD-U12）', () => {
  const ORIGINS = ['https://a.test', 'https://b.test', 'http://127.0.0.1:5173']

  beforeEach(() => {
    for (const o of ORIGINS) {
      const host = new URL(o).hostname
      idbDir(`${o.split(':')[0]}_${host}_${new URL(o).port || '0'}.indexeddb.leveldb`)
      state.usage[o] = { usage: 1, usageBreakdown: [] }
    }
  })

  it('SD-U10 每次调用一个 view：偏好、拒绝弹窗、about:blank、attach 1.3、每个来源查一次、detach + close 各一次；计时器清掉', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await listSites()
    expect(views()).toHaveLength(1)
    const [v] = views()
    expect(v.opts).toEqual({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false
      }
    })
    expect(v.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    const handler = v.webContents.setWindowOpenHandler.mock.calls[0][0]
    expect(handler()).toEqual({ action: 'deny' })
    expect(v.webContents.loadURL.mock.calls).toEqual([['about:blank']])
    expect(v.webContents.debugger.attach.mock.calls).toEqual([['1.3']])
    const calls = v.webContents.debugger.sendCommand.mock.calls
    expect(calls.map(([method]) => method)).toEqual(ORIGINS.map(() => 'Storage.getUsageAndQuota'))
    expect(sorted(calls.map(([, p]) => String(p?.origin)))).toEqual(sorted(ORIGINS))
    expect(v.webContents.debugger.detach).toHaveBeenCalledTimes(1)
    expect(v.webContents.close).toHaveBeenCalledTimes(1)
    expect(v.webContents.debugger.detach.mock.invocationCallOrder[0]).toBeLessThan(
      v.webContents.close.mock.invocationCallOrder[0]
    )
    // 每个来源的超时计时器都清掉了
    expect(vi.getTimerCount()).toBe(0)

    // 下一次调用新建一个
    await listSites()
    expect(views()).toHaveLength(2)
    expect(views()[1]).not.toBe(v)
    expect(views()[1].webContents.close).toHaveBeenCalledTimes(1)
  })

  it('SD-U10 并发、每批 6 个：8 个来源先发 6 个，那一批回完才发剩下的 2 个', async () => {
    const more = [
      'https://c.test',
      'https://d.test',
      'https://e.test',
      'https://f.test',
      'https://g.test'
    ]
    for (const o of more) idbDir(`https_${new URL(o).hostname}_0.indexeddb.leveldb`)
    state.deferUsage = true
    const p = listSites()
    await vi.waitFor(() => expect(state.deferred).toHaveLength(6))
    await new Promise((r) => setTimeout(r, 20))
    expect(state.deferred).toHaveLength(6)
    for (const d of state.deferred.splice(0)) d.resolve({ usage: 1, usageBreakdown: [] })
    await vi.waitFor(() => expect(state.deferred).toHaveLength(2))
    for (const d of state.deferred.splice(0)) d.resolve({ usage: 1, usageBreakdown: [] })
    const sites = await p
    expect(sites).toHaveLength(8)
    expect(sorted(queried())).toEqual(sorted([...ORIGINS, ...more]))
  })

  it('SD-U11 usageBytes 取回包的 usage（不是分项之和）；分项归三类，其余进 other', async () => {
    state.usage['https://a.test'] = {
      usage: 1000,
      usageBreakdown: [
        { storageType: 'indexeddb', usage: 300 },
        { storageType: 'cache_storage', usage: 200 },
        { storageType: 'service_workers', usage: 100 },
        { storageType: 'file_systems', usage: 50 },
        { storageType: 'websql', usage: 25 },
        { storageType: 'indexeddb', usage: 5 },
        { storageType: 'shader_cache', usage: 0 }
      ]
    }
    const details = await siteDetails('a.test')
    expect(details?.origins).toEqual([
      {
        origin: 'https://a.test',
        usageBytes: 1000,
        usage: { indexedDB: 305, cacheStorage: 200, serviceWorkers: 100, other: 75 },
        localStorage: false
      }
    ])
    expect(details?.usageBytes).toBe(1000)
  })

  it('SD-U11 缺的字段当 0：没有 usageBreakdown → 分项全 0；没有 usage → 0', async () => {
    state.usage['https://a.test'] = { usage: 42 }
    state.usage['https://b.test'] = { usageBreakdown: [{ storageType: 'indexeddb', usage: 9 }] }
    // b.test 有本地存储，占用 0 也留在详情里，看得见它的分项
    lsFile('000003.log', batchHeader(), put(lsKey('https://b.test')))
    expect((await siteDetails('a.test'))?.origins[0]).toMatchObject({
      usageBytes: 42,
      usage: { indexedDB: 0, cacheStorage: 0, serviceWorkers: 0, other: 0 }
    })
    expect((await siteDetails('b.test'))?.origins[0]).toMatchObject({
      usageBytes: 0,
      usage: { indexedDB: 9, cacheStorage: 0, serviceWorkers: 0, other: 0 },
      localStorage: true
    })
  })

  it('SD-U12 一个来源失败、一个永不回答（3 s 超时）：都当 0，别的来源照查到', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    state.usage['https://a.test'] = 'reject'
    state.usage['https://b.test'] = 'hang'
    state.usage['http://127.0.0.1:5173'] = { usage: 77, usageBreakdown: [] }
    // 两个出问题的来源有本地存储，好在详情里看见它们的 0
    lsFile('000003.log', batchHeader(), put(lsKey('https://a.test')), put(lsKey('https://b.test')))
    let done = false
    const p = listSites().then((r) => {
      done = true
      return r
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(sorted(queried())).toEqual(sorted(ORIGINS))
    await vi.advanceTimersByTimeAsync(2999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const sites = await p
    expect(sites).toEqual([
      expect.objectContaining({ site: '127.0.0.1', usageBytes: 77, originCount: 1 }),
      expect.objectContaining({ site: 'a.test', usageBytes: 0, localStorage: true }),
      expect.objectContaining({ site: 'b.test', usageBytes: 0, localStorage: true })
    ])
    const [v] = views()
    expect(v.webContents.debugger.detach).toHaveBeenCalledTimes(1)
    expect(v.webContents.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('SD-U12 loadURL 失败：列表照回（全当 0），close 了；没 attach 就不 detach', async () => {
    state.loadFails = true
    state.cookies = [ck({ name: 'c', domain: 'a.test' })]
    const sites = await listSites()
    // 三个来源都当 0、又没有本地存储 → 只剩有 Cookie 的那个网站
    expect(sites).toEqual([
      expect.objectContaining({ site: 'a.test', cookieCount: 1, usageBytes: 0, originCount: 0 })
    ])
    const [v] = views()
    expect(v.webContents.debugger.attach).not.toHaveBeenCalled()
    expect(v.webContents.debugger.sendCommand).not.toHaveBeenCalled()
    expect(v.webContents.debugger.detach).not.toHaveBeenCalled()
    expect(v.webContents.close).toHaveBeenCalledTimes(1)
  })
})

describe('站点详情（SD-U13 / SD-U14）', () => {
  const T = 1_762_000_000_000

  beforeEach(() => {
    quotaDb([
      ['https://www.github.com/', chromeTime(T)],
      ['https://github.com/', chromeTime(T - 60_000)],
      ['https://other.test/', chromeTime(T)]
    ])
    lsFile('000003.log', batchHeader(), put(lsKey('https://gist.github.com')))
    state.usage['https://www.github.com'] = {
      usage: 300,
      usageBreakdown: [{ storageType: 'indexeddb', usage: 300 }]
    }
    state.usage['https://github.com'] = {
      usage: 100,
      usageBreakdown: [{ storageType: 'cache_storage', usage: 100 }]
    }
    state.usage['https://other.test'] = { usage: 50, usageBreakdown: [] }
    state.cookies = [
      ck({ name: 'b', value: 'bb', domain: '.github.com' }),
      ck({ name: 'a', value: 'aaa', domain: 'www.github.com', session: true, expirationDate: 1 }),
      ck({
        name: 'a',
        value: 'token',
        domain: '.github.com',
        secure: true,
        httpOnly: true,
        expirationDate: 1_800_000_000.5,
        sameSite: 'lax'
      }),
      { name: 'z', value: '', domain: 'gist.github.com', hostOnly: true },
      ck({ name: 'o', domain: 'other.test' })
    ]
  })

  it('SD-U13 来源按字符串排、Cookie 按域再按名字排；Cookie 的映射；汇总字段；只查这个网站的来源', async () => {
    const d = await siteDetails('github.com')
    expect(d).toEqual({
      site: 'github.com',
      cookieCount: 4,
      cookieBytes: 1 + 2 + 1 + 3 + 1 + 5 + 1 + 0,
      usageBytes: 400,
      localStorage: true,
      originCount: 3,
      lastAccessed: T,
      origins: [
        {
          origin: 'https://gist.github.com',
          usageBytes: 0,
          usage: { indexedDB: 0, cacheStorage: 0, serviceWorkers: 0, other: 0 },
          localStorage: true
        },
        {
          origin: 'https://github.com',
          usageBytes: 100,
          usage: { indexedDB: 0, cacheStorage: 100, serviceWorkers: 0, other: 0 },
          localStorage: false,
          lastAccessed: T - 60_000
        },
        {
          origin: 'https://www.github.com',
          usageBytes: 300,
          usage: { indexedDB: 300, cacheStorage: 0, serviceWorkers: 0, other: 0 },
          localStorage: false,
          lastAccessed: T
        }
      ],
      cookies: [
        {
          name: 'a',
          value: 'token',
          domain: '.github.com',
          path: '/',
          secure: true,
          httpOnly: true,
          hostOnly: false,
          sameSite: 'lax',
          expires: 1_800_000_000_500,
          size: 6
        },
        {
          name: 'b',
          value: 'bb',
          domain: '.github.com',
          path: '/',
          secure: false,
          httpOnly: false,
          hostOnly: false,
          sameSite: 'unspecified',
          size: 3
        },
        {
          name: 'z',
          value: '',
          domain: 'gist.github.com',
          path: '/',
          secure: false,
          httpOnly: false,
          hostOnly: true,
          sameSite: 'unspecified',
          size: 1
        },
        {
          name: 'a',
          value: 'aaa',
          domain: 'www.github.com',
          path: '/',
          secure: false,
          httpOnly: false,
          hostOnly: true,
          sameSite: 'unspecified',
          size: 4
        }
      ]
    })
    // 会话 Cookie 带着 expirationDate 也不给 expires；没有 expirationDate 的也不给
    expect(d!.cookies[2]).not.toHaveProperty('expires')
    expect(d!.cookies[3]).not.toHaveProperty('expires')
    // 只查了这个网站的三个来源（other.test 没查）
    expect(views()).toHaveLength(1)
    expect(sorted(queried())).toEqual(
      sorted(['https://gist.github.com', 'https://github.com', 'https://www.github.com'])
    )
  })

  it('SD-U14 不认识的网站 → null，不建 view', async () => {
    expect(await siteDetails('nope.test')).toBeNull()
    expect(views()).toEqual([])
  })
})

describe('空的不列（SD-U14）', () => {
  it('SD-U14 只有一个 0 占用的来源、没有本地存储、没有 Cookie：列表里没有，详情 null', async () => {
    idbDir('https_empty.test_0.indexeddb.leveldb')
    quotaDb([['https://empty.test/', chromeTime(1_760_000_000_000)]])
    idbDir('https_full.test_0.indexeddb.leveldb')
    state.usage['https://full.test'] = { usage: 3, usageBreakdown: [] }
    expect(await siteNames()).toEqual(['full.test'])
    expect(await siteDetails('empty.test')).toBeNull()
  })

  it('SD-U14 0 占用的来源从详情里拿掉，网站因为 Cookie 留着', async () => {
    idbDir('https_c.test_0.indexeddb.leveldb')
    state.cookies = [ck({ name: 'k', value: 'vv', domain: 'c.test' })]
    const sites = await listSites()
    expect(sites).toEqual([
      {
        site: 'c.test',
        cookieCount: 1,
        cookieBytes: 3,
        usageBytes: 0,
        localStorage: false,
        originCount: 0
      }
    ])
    const d = await siteDetails('c.test')
    expect(d?.origins).toEqual([])
    expect(d?.originCount).toBe(0)
    expect(d?.cookies.map((c) => c.name)).toEqual(['k'])
  })
})

describe('删除整个网站（SD-U15 / SD-U16）', () => {
  beforeEach(() => {
    idbDir('https_github.com_0.indexeddb.leveldb')
    idbDir('https_www.github.com_0.indexeddb.leveldb')
    idbDir('https_other.test_0.indexeddb.leveldb')
    state.cookies = [
      ck({ name: 'sid', domain: '.github.com', secure: true }),
      ck({ name: 'pref', domain: 'www.github.com', path: '/x' }),
      { name: 'nopath', value: 'v', domain: 'gist.github.com', secure: true },
      ck({ name: 'keep', domain: 'other.test' })
    ]
  })

  it('SD-U15 每条 Cookie 按地址 + 名字删，然后一次 clearData（七类，存过数据的来源 ∪ Cookie 主机的 http / https，去重）', async () => {
    await clearSite('github.com')
    expect(state.cookiesRemove.mock.calls).toEqual([
      ['https://github.com/', 'sid'],
      ['http://www.github.com/x', 'pref'],
      ['https://gist.github.com/', 'nopath']
    ])
    expect(state.clearData).toHaveBeenCalledTimes(1)
    const [{ dataTypes, origins }] = state.clearData.mock.calls[0] as [
      { dataTypes: string[]; origins: string[] }
    ]
    expect(dataTypes).toEqual(ALL_TYPES)
    expect(new Set(origins).size).toBe(origins.length)
    expect(sorted(origins)).toEqual(
      sorted([
        'https://github.com',
        'http://github.com',
        'https://www.github.com',
        'http://www.github.com',
        'https://gist.github.com',
        'http://gist.github.com'
      ])
    )
    // 先删 Cookie，最后清存储
    const lastRemove = Math.max(...state.cookiesRemove.mock.invocationCallOrder)
    expect(state.clearData.mock.invocationCallOrder[0]).toBeGreaterThan(lastRemove)
    // 别的网站的 Cookie 没碰；不建临时 view
    expect(state.cookiesRemove.mock.calls.map(([, name]) => name)).not.toContain('keep')
    expect(views()).toEqual([])
  })

  it('SD-U15 删一条失败：其余照删、存储照清，整个调用不失败', async () => {
    state.cookiesRemove.mockImplementation(async (_url: string, name: string) => {
      if (name === 'sid') throw new Error('locked')
    })
    await expect(clearSite('github.com')).resolves.toBeUndefined()
    expect(state.cookiesRemove.mock.calls.map(([, name]) => name)).toEqual([
      'sid',
      'pref',
      'nopath'
    ])
    expect(state.clearData).toHaveBeenCalledTimes(1)
  })

  it('SD-U16 不认识的网站：什么也不做', async () => {
    await clearSite('nope.test')
    expect(state.cookiesRemove).not.toHaveBeenCalled()
    expect(state.clearData).not.toHaveBeenCalled()
  })

  it('SD-U16 只有 Cookie 的网站：删 Cookie，照清那些主机的存储', async () => {
    state.cookies = [ck({ name: 'only', domain: 'cookie.test' })]
    await clearSite('cookie.test')
    expect(state.cookiesRemove.mock.calls).toEqual([['http://cookie.test/', 'only']])
    expect(state.clearData.mock.calls).toEqual([
      [{ dataTypes: ALL_TYPES, origins: ['https://cookie.test', 'http://cookie.test'] }]
    ])
  })

  it('SD-U16 只有存储的网站：不删 Cookie，清它存过数据的来源', async () => {
    state.cookies = state.cookies.filter((c) => c.name !== 'keep')
    await clearSite('other.test')
    expect(state.cookiesRemove).not.toHaveBeenCalled()
    expect(state.clearData.mock.calls).toEqual([
      [{ dataTypes: ALL_TYPES, origins: ['https://other.test'] }]
    ])
  })
})

describe('按类别删除（SD-U17）', () => {
  beforeEach(() => {
    idbDir('https_www.github.com_0.indexeddb.leveldb')
    state.cookies = [
      ck({ name: 'sid', domain: '.github.com', secure: true }),
      ck({ name: 'keep', domain: 'other.test' })
    ]
  })

  const ORIGINS = ['https://www.github.com', 'https://github.com', 'http://github.com']

  it('SD-U17 cookies：只删 Cookie，不 clearData', async () => {
    await clearSiteCategory('github.com', 'cookies')
    expect(state.cookiesRemove.mock.calls).toEqual([['https://github.com/', 'sid']])
    expect(state.clearData).not.toHaveBeenCalled()
  })

  it.each([
    ['localStorage', ['localStorage']],
    ['indexedDB', ['indexedDB']],
    ['cacheStorage', ['cache']],
    ['serviceWorkers', ['serviceWorkers']],
    ['other', ['fileSystems', 'webSQL', 'backgroundFetch']]
  ] as const)('SD-U17 %s → 一次 clearData(%j)，不碰 Cookie', async (category, dataTypes) => {
    await clearSiteCategory('github.com', category)
    expect(state.cookiesRemove).not.toHaveBeenCalled()
    expect(state.clearData).toHaveBeenCalledTimes(1)
    const [arg] = state.clearData.mock.calls[0] as [{ dataTypes: string[]; origins: string[] }]
    expect(arg.dataTypes).toEqual(dataTypes)
    expect(sorted(arg.origins)).toEqual(sorted(ORIGINS))
  })

  it.each([['toString'], ['constructor'], ['hasOwnProperty'], ['__proto__'], ['bogus'], ['']])(
    'SD-U17 不认识的类别 %j：什么也不做，连 Cookie 都不读',
    async (category) => {
      await clearSiteCategory('github.com', category as never)
      expect(state.cookiesGet).not.toHaveBeenCalled()
      expect(state.cookiesRemove).not.toHaveBeenCalled()
      expect(state.clearData).not.toHaveBeenCalled()
    }
  )

  it('SD-U17 不认识的网站：什么也不做', async () => {
    await clearSiteCategory('nope.test', 'indexedDB')
    await clearSiteCategory('nope.test', 'cookies')
    expect(state.cookiesRemove).not.toHaveBeenCalled()
    expect(state.clearData).not.toHaveBeenCalled()
  })
})

describe('删除一个来源（SD-U18）', () => {
  it.each([
    ['https://a.test', 'https://a.test'],
    ['https://a.test/', 'https://a.test'],
    ['http://127.0.0.1:5173', 'http://127.0.0.1:5173'],
    ['http://[::1]:8080/', 'http://[::1]:8080']
  ])(
    'SD-U18 clearOrigin(%j) → 七类 clearData，origins [%j]，不碰 Cookie',
    async (input, origin) => {
      await clearOrigin(input)
      expect(state.clearData.mock.calls).toEqual([[{ dataTypes: ALL_TYPES, origins: [origin] }]])
      expect(state.cookiesGet).not.toHaveBeenCalled()
      expect(state.cookiesRemove).not.toHaveBeenCalled()
      expect(state.cookiesSet).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['https://a.test/path'],
    ['https://a.test//'],
    ['https://a.test?x=1'],
    ['HTTPS://A.TEST'],
    ['https://a.test:443'],
    ['https://user@a.test'],
    ['file:///Users/me'],
    ['about:blank'],
    ['shuvix://settings'],
    ['a.test'],
    ['garbage'],
    ['']
  ])('SD-U18 clearOrigin(%j)：不是恰好一个来源 → 什么也不做', async (input) => {
    await clearOrigin(input)
    expect(state.clearData).not.toHaveBeenCalled()
    expect(state.cookiesRemove).not.toHaveBeenCalled()
  })
})

describe('删除一条 Cookie（SD-U19）', () => {
  it('SD-U19 域 Cookie：用同名、同域、同路径、已过期的一条覆盖（带 domain）；不走 remove', async () => {
    await removeCookie({ name: 'sid', domain: '.github.com', path: '/', secure: true })
    expect(state.fromPartition).toHaveBeenCalledWith(PARTITION)
    expect(state.cookiesSet.mock.calls).toEqual([
      [
        {
          url: 'https://github.com/',
          name: 'sid',
          value: '',
          path: '/',
          secure: true,
          httpOnly: true,
          domain: '.github.com',
          expirationDate: 1
        }
      ]
    ])
    expect(state.cookiesRemove).not.toHaveBeenCalled()
  })

  it('SD-U19 只限主机的 Cookie：覆盖时不带 domain 键，地址按 http + 路径', async () => {
    await removeCookie({ name: 'pref', domain: 'www.github.com', path: '/x', secure: false })
    expect(state.cookiesSet).toHaveBeenCalledTimes(1)
    const [arg] = state.cookiesSet.mock.calls[0] as [Record<string, unknown>]
    expect(arg).toEqual({
      url: 'http://www.github.com/x',
      name: 'pref',
      value: '',
      path: '/x',
      secure: false,
      httpOnly: true,
      expirationDate: 1
    })
    expect(arg).not.toHaveProperty('domain')
    expect(state.cookiesRemove).not.toHaveBeenCalled()
  })

  it('SD-U19 覆盖被拒：退回 cookies.remove(url, name)', async () => {
    state.cookiesSet.mockRejectedValueOnce(new Error('EXCLUDE_INVALID_DOMAIN'))
    await removeCookie({ name: 'sid', domain: '.github.com', path: '/', secure: true })
    expect(state.cookiesSet).toHaveBeenCalledTimes(1)
    expect(state.cookiesRemove.mock.calls).toEqual([['https://github.com/', 'sid']])
  })

  it.each([
    [null],
    [undefined],
    ['sid'],
    [{ name: 1, domain: '.github.com', path: '/', secure: true }],
    [{ name: 'sid', path: '/', secure: true }],
    [{ name: 'sid', domain: 42, path: '/', secure: true }]
  ])('SD-U19 不合法的输入 %j：什么也不做', async (input) => {
    await removeCookie(input as never)
    expect(state.cookiesSet).not.toHaveBeenCalled()
    expect(state.cookiesRemove).not.toHaveBeenCalled()
  })
})
