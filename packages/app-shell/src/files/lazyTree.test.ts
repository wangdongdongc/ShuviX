/**
 * 文件树懒加载的纯逻辑：目录推导 / 键互转 / 请求去重 / 已加载分片账本。
 *
 * LoadedSlices 的关键语义：scanDir 只扫一层，分片互不相交（每个路径至多属于一个分片）；
 * 唯一的多来源是搜索注入 —— 注入路径后来成为分片内容时归属转移给分片，
 * removeInjected 不再清它。
 */
import { describe, expect, it } from 'vitest'
import {
  LoadedSlices,
  LazyLoadTracker,
  deriveDirPaths,
  dirKeyOf,
  dirParamOf,
  parentDirKey
} from './lazyTree'

describe('deriveDirPaths', () => {
  it('文件给出全部祖先目录（不含自身）', () => {
    expect(deriveDirPaths(['a/b/c.ts'])).toEqual(new Set(['a/', 'a/b/']))
  })

  it('显式目录条目含自身', () => {
    expect(deriveDirPaths(['a/b/'])).toEqual(new Set(['a/', 'a/b/']))
  })

  it('顶层文件没有祖先目录', () => {
    expect(deriveDirPaths(['x.ts'])).toEqual(new Set())
  })

  it('反斜杠路径归一为 forward-slash', () => {
    expect(deriveDirPaths(['a\\b\\c.ts'])).toEqual(new Set(['a/', 'a/b/']))
  })
})

describe('目录键互转', () => {
  it('parentDirKey', () => {
    expect(parentDirKey('a/b/c.ts')).toBe('a/b/')
    expect(parentDirKey('x.ts')).toBe('')
    expect(parentDirKey('a\\b.ts')).toBe('a/')
  })

  it('dirKeyOf / dirParamOf 互转', () => {
    expect(dirKeyOf('')).toBe('')
    expect(dirKeyOf('a/b')).toBe('a/b/')
    expect(dirKeyOf('a/b/')).toBe('a/b/')
    expect(dirParamOf('')).toBe('')
    expect(dirParamOf('a/b/')).toBe('a/b')
  })
})

describe('LazyLoadTracker', () => {
  it('同一目录在途期间只放行一次请求', () => {
    const t = new LazyLoadTracker()
    expect(t.shouldRequest('a/')).toBe(true)
    expect(t.shouldRequest('a/')).toBe(false)
  })

  it('失败后可重试（清在途、不标已加载）', () => {
    const t = new LazyLoadTracker()
    t.shouldRequest('a/')
    t.markFailed('a/')
    expect(t.isLoaded('a/')).toBe(false)
    expect(t.shouldRequest('a/')).toBe(true)
  })

  it('加载成功后不再请求', () => {
    const t = new LazyLoadTracker()
    t.shouldRequest('a/')
    t.markLoaded('a/')
    expect(t.isLoaded('a/')).toBe(true)
    expect(t.shouldRequest('a/')).toBe(false)
  })
})

describe('LoadedSlices — 加载与已知判定', () => {
  it('load 后 isKnown（小写）为真，dirKeys 含该分片', () => {
    const s = new LoadedSlices()
    s.load('', ['a/', 'a/f.ts', 'top.ts'])
    expect(s.dirKeys()).toEqual([''])
    expect(s.isKnown('a/f.ts')).toBe(true)
    expect(s.isKnown('missing.ts')).toBe(false)
  })
})

describe('LoadedSlices — planChange（files.changed 增量）', () => {
  it('write 新文件且父目录已加载 → add', () => {
    const s = new LoadedSlices()
    s.load('', ['a/'])
    s.load('a/', ['a/f.ts'])
    expect(s.planChange(['a/new.ts'], 'write')).toEqual({ add: ['a/new.ts'], remove: [] })
    expect(s.isKnown('a/new.ts')).toBe(true)
  })

  it('write 新文件但父目录未加载 → 不动（展开时自然会扫到）', () => {
    const s = new LoadedSlices()
    s.load('', ['a/'])
    expect(s.planChange(['a/new.ts'], 'write')).toEqual({ add: [], remove: [] })
    expect(s.isKnown('a/new.ts')).toBe(false)
  })

  it('write/edit 已知路径 → 不动（纯内容变更）', () => {
    const s = new LoadedSlices()
    s.load('', ['top.ts'])
    expect(s.planChange(['top.ts'], 'edit')).toEqual({ add: [], remove: [] })
  })

  it('delete 已知路径 → remove；delete 未知路径 → 不动', () => {
    const s = new LoadedSlices()
    s.load('', ['top.ts'])
    expect(s.planChange(['top.ts'], 'delete')).toEqual({ add: [], remove: ['top.ts'] })
    expect(s.isKnown('top.ts')).toBe(false)
    expect(s.planChange(['ghost.ts'], 'delete')).toEqual({ add: [], remove: [] })
  })
})

describe('LoadedSlices — planRefresh（分片刷新 diff）', () => {
  it('新增路径 → add；消失路径 → remove', () => {
    const s = new LoadedSlices()
    s.load('', ['a/', 'old.ts'])
    const ops = s.planRefresh('', ['a/', 'new.ts'])
    expect(ops.add).toEqual(['new.ts'])
    expect(ops.remove).toEqual(['old.ts'])
  })

  it('刷新新增的路径若已是搜索注入内容：只转移归属，不发 add', () => {
    const s = new LoadedSlices()
    s.load('', ['a/'])
    // 搜索注入把 'a/f.ts' 提前放进了模型
    s.addInjected(['a/f.ts', 'deep/x.ts'])
    // 之后 'a/' 展开/刷新，'a/f.ts' 成为分片内容
    const ops = s.planRefresh('a/', ['a/f.ts'])
    expect(ops).toEqual({ add: [], remove: [] }) // 模型里已有，不产生 add
    // 归属已转移：搜索结束后它留在树上，纯注入的 'deep/x.ts' 被清回
    expect(s.removeInjected()).toEqual(['deep/x.ts'])
    expect(s.isKnown('a/f.ts')).toBe(true)
  })

  it('目录条目被移除时级联丢弃子分片账本，但不发子树 remove（树组件整棵移除）', () => {
    const s = new LoadedSlices()
    s.load('', ['a/'])
    s.load('a/', ['a/b/'])
    s.load('a/b/', ['a/b/h.ts'])
    const ops = s.planRefresh('', [])
    expect(ops.remove).toEqual(['a/'])
    // 子分片账本被丢弃：独有路径不再已知，但不产生 remove 操作
    expect(ops.remove).not.toContain('a/b/h.ts')
    expect(s.isKnown('a/b/h.ts')).toBe(false)
    expect(s.dirKeys()).toEqual([''])
  })
})

describe('LoadedSlices — 搜索注入与清回', () => {
  it('注入未知路径返回 add，已知的跳过', () => {
    const s = new LoadedSlices()
    s.load('', ['top.ts'])
    expect(s.addInjected(['top.ts', 'deep/x.ts'])).toEqual(['deep/x.ts'])
    expect(s.isKnown('deep/x.ts')).toBe(true)
  })

  it('removeInjected 保留已成分片内容的路径，只移除纯注入的', () => {
    const s = new LoadedSlices()
    s.load('', ['a/'])
    s.addInjected(['a/f.ts', 'deep/x.ts'])
    // 之后 'a/' 展开加载，'a/f.ts' 成为分片内容
    s.load('a/', ['a/f.ts'])
    expect(s.removeInjected()).toEqual(['deep/x.ts'])
    expect(s.isKnown('a/f.ts')).toBe(true)
    expect(s.isKnown('deep/x.ts')).toBe(false)
  })

  it('纯注入路径被 delete 事件移除后，removeInjected 不再重复移除', () => {
    const s = new LoadedSlices()
    s.load('', [])
    s.addInjected(['deep/x.ts'])
    s.planChange(['deep/x.ts'], 'delete')
    expect(s.removeInjected()).toEqual([])
  })
})

describe('LoadedSlices — 大小写', () => {
  it('isKnown 小写不敏感，对外操作保留原始大小写', () => {
    const s = new LoadedSlices()
    s.load('', ['Src/A.ts'])
    expect(s.isKnown('src/a.ts')).toBe(true)
    expect(s.planChange(['src/a.ts'], 'delete').remove).toEqual(['Src/A.ts'])
  })
})
