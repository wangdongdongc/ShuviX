/**
 * BF —— 内置档案的扩展元数据补缺（`BuiltinProfileDeps.fill`，契约见 chat-protocol mdMeta.ts）。
 *
 * 内置 md 里写着自己的 id `agent:builtin:<name>`，构建器把宿主注入的 fill 原样交给解析器：
 *   - 读口收到的是那份 md 里的 id；补上的只是 md 没写的键（md 优先），source / basePath 不受影响；
 *   - 没注入 fill、或 md 没有 id → 不补；
 *   - 补缺值不合法 → 档案照常构建（补缺不能把一份好文件弄坏），经构建器的 `[builtinAgents] <文件名>:`
 *     诊断通道说一句。
 *
 * 机制用桩 reader 钉（BF-1..4），全集用构建期内联的真实 md 钉（BF-5：每份内置都带自己的 id，
 * 读口按份被问到、只改被答到的那一份）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildBuiltinProfile,
  buildBuiltinProfiles,
  BUILTIN_PROFILE_SPECS,
  EXPLORE_SPEC,
  type BuiltinMdReader
} from '../index'
import { createInlineMdReader } from '../inlineSources'

type FillFn = (objectId: string) => Record<string, unknown> | undefined

/** 最小合法内置 md（explore 形状）；idLine 省略 = 不写 id */
const stubMd = (opts: { idLine?: string | null; extra?: string[] } = {}): string =>
  [
    '---',
    'shuvix: agent v1',
    ...(opts.idLine === null ? [] : [opts.idLine ?? 'shuvix-id: agent:builtin:explore']),
    'name: explore',
    'description: stub explore',
    'shuvix-tools: read, grep',
    ...(opts.extra ?? []),
    '---',
    '',
    'Stub body.',
    ''
  ].join('\n')

/** 只认 explore.md 的桩 reader（其余语言版本回 null，构建器回退到它） */
const readerOf =
  (text: string): BuiltinMdReader =>
  (fileName) =>
    fileName === 'explore.md' ? text : null

const mdPath = (fileName: string): string => `/builtin/${fileName}`

/** 记录调用的补缺读口 */
function spyFill(answer: (id: string) => Record<string, unknown> | undefined): {
  fn: FillFn
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    fn: (id) => {
      calls.push(id)
      return answer(id)
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildBuiltinProfile —— fill 依赖', () => {
  it('BF-1 读口收到 md 里的 agent:builtin:explore；档案带上补缺值，source 仍是 builtin、basePath 与不补时相同', () => {
    const readMd = readerOf(stubMd())
    const plain = buildBuiltinProfile(EXPLORE_SPEC, { readMd, mdPath })!
    expect(plain.model).toBeUndefined()
    const fill = spyFill(() => ({ 'shuvix-model': 'p/m', 'shuvix-thinking': 'high' }))
    const filled = buildBuiltinProfile(EXPLORE_SPEC, { readMd, mdPath, fill: fill.fn })!
    expect(fill.calls).toEqual(['agent:builtin:explore'])
    expect(filled).toEqual({ ...plain, model: 'p/m', thinkingLevel: 'high' })
    expect(filled.source).toBe('builtin')
    expect(filled.basePath).toBe(plain.basePath)
    expect(filled.basePath).toBe('/builtin/explore.md')
    expect(filled.objectId).toBe('agent:builtin:explore')
  })

  it('BF-2 没注入 fill → 不补；md 没有 id → 读口从不被问', () => {
    const plain = buildBuiltinProfile(EXPLORE_SPEC, { readMd: readerOf(stubMd()) })!
    expect(plain.model).toBeUndefined()
    expect(plain.thinkingLevel).toBeUndefined()

    const fill = spyFill(() => ({ 'shuvix-model': 'p/m' }))
    const noId = buildBuiltinProfile(EXPLORE_SPEC, {
      readMd: readerOf(stubMd({ idLine: null })),
      fill: fill.fn
    })!
    expect(fill.calls).toEqual([])
    expect(noId.model).toBeUndefined()
    expect(noId.objectId).toBeUndefined()
  })

  it('BF-3 md 写了 shuvix-thinking: off，补缺 high → 仍是 off（md 优先）', () => {
    const profile = buildBuiltinProfile(EXPLORE_SPEC, {
      readMd: readerOf(stubMd({ extra: ['shuvix-thinking: off'] })),
      fill: () => ({ 'shuvix-thinking': 'high' })
    })!
    expect(profile.thinkingLevel).toBe('off')
  })

  it('BF-4 补缺值不合法 → 档案照常构建（不补）；console.warn 恰一次，带 `[builtinAgents] explore.md:` 前缀与 settings not applied', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const profile = buildBuiltinProfile(EXPLORE_SPEC, {
      readMd: readerOf(stubMd()),
      fill: () => ({ 'shuvix-thinking': 'max' })
    })
    expect(profile).not.toBeNull()
    expect(profile!.thinkingLevel).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message.startsWith('[builtinAgents] explore.md: ')).toBe(true)
    expect(message).toContain('ShuviX settings not applied')
  })
})

describe('buildBuiltinProfiles —— 真实内置 md 全集', () => {
  const deps = { readMd: createInlineMdReader(), language: 'en', widgetsRoot: '/w' }

  it('BF-5 每份构建出的内置档案各问一次读口，id 是 agent:builtin:<spec 名>；只答 explore 时只有 explore 变了', () => {
    const plain = buildBuiltinProfiles(deps)
    expect(plain.map((p) => p.name)).toEqual(BUILTIN_PROFILE_SPECS.map((s) => s.name))

    const all = spyFill(() => undefined)
    buildBuiltinProfiles({ ...deps, fill: all.fn })
    expect(all.calls).toEqual(plain.map((p) => `agent:builtin:${p.name}`))

    const onlyExplore = spyFill((id) =>
      id === 'agent:builtin:explore' ? { 'shuvix-model': 'p/m' } : undefined
    )
    const filled = buildBuiltinProfiles({ ...deps, fill: onlyExplore.fn })
    expect(filled.map((p) => p.name)).toEqual(plain.map((p) => p.name))
    for (const [i, profile] of filled.entries()) {
      if (profile.name === 'explore') {
        expect(profile).toEqual({ ...plain[i], model: 'p/m' })
      } else {
        expect(profile, profile.name).toEqual(plain[i])
      }
    }
  })
})
