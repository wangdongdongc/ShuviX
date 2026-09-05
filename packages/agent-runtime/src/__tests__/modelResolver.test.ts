/**
 * resolveModel 的 contextWindow / maxTokens 归一 —— 自定义提供商与「注册表查不到的内置模型」
 * 两条动态构造路径共用的 resolveTokenLimits（私有，只能经 resolveModel 观察）。
 *
 * 为什么值得测：能力数据来自 litellm 目录或用户在能力对话框里手填，其中 maxOutputTokens 有
 * 一整类根本不可信 —— 随包目录 1976 条 chat 模型里 751 条 max_output == max_input，xai 整族
 * 如此（官方从没公布过那样的输出上限），另有少数 max_output > max_input。一个大于等于窗口的
 * 输出上限在任何请求里都兑现不了：原样交给 pi 会作为 max_tokens 发给 provider（pi 只夹到窗口，
 * 有的 provider 会打回）、压缩阈值被 reserve 吃空。规则：contextWindow = maxInputTokens ?? 128000；maxTokens 只在
 * maxOutputTokens「大于 0 且严格小于窗口」时采用，否则（缺失 / null / 0 / 负数 / ≥ 窗口）
 * 回落默认 16384。
 *
 * 两条路径各自持有一份字面量，所以阈值用例（A 组）在两条路径上各跑一遍 —— 只测一条挡不住
 * 另一条被单独改回去。注册表能查到的内置模型整个对象直接采用注册表值，不经过这条规则（D 组
 * 对照）。不 mock pi-ai：直接读真 getBuiltinModel，「grok-4.6 不在注册表」用前置断言钉住，
 * pi-ai 升级后若收录了会显式炸而不是悄悄换到已知路径。
 */
import { describe, it, expect } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import { resolveModel, type ResolveModelProviderInfo } from '../modelResolver'
import type { RuntimeEnv } from '../types'

/** 与实现里的两个默认值对齐（实现未导出；这里写死是有意的 —— 默认值改了测试就该响） */
const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_TOKENS = 16384

const env: RuntimeEnv = { setApiKey: () => {} }

const CUSTOM_PROVIDER: ResolveModelProviderInfo = {
  id: 'p1',
  name: 'My Proxy',
  isBuiltin: false,
  baseUrl: 'http://localhost:1234/v1',
  apiProtocol: 'openai-completions'
}
const XAI_PROVIDER: ResolveModelProviderInfo = { id: 'xai', name: 'xai', isBuiltin: true }
const OPENAI_PROVIDER: ResolveModelProviderInfo = { id: 'openai', name: 'openai', isBuiltin: true }

/** pi-ai 注册表查不到的 xai 型号（前置断言钉住） */
const UNKNOWN_XAI_MODEL = 'grok-4.6'
/** 注册表里 maxTokens == contextWindow 的型号（500000 / 500000）—— 正是规则会砍掉的形态；失效换 grok-build-0.1 */
const KNOWN_XAI_MODEL = 'grok-4.5'

type Limits = { contextWindow: number; maxTokens: number }

/**
 * 读注册表。参数类型照 modelResolver 的做法取形参类型（pi-ai 的 KnownProvider 比 getBuiltinModel
 * 实际接受的联合更宽），查不到时运行时返回 undefined —— 声明类型没写这一支，这里补上。
 */
function registryEntry(provider: string, model: string): Model<Api> | undefined {
  return getBuiltinModel(
    provider as Parameters<typeof getBuiltinModel>[0],
    model as Parameters<typeof getBuiltinModel>[1]
  )
}

function limitsFor(
  providerInfo: ResolveModelProviderInfo | null,
  model: string,
  capabilities: ModelCapabilities
): Limits {
  const resolved = resolveModel({
    provider: providerInfo?.id ?? 'unknown',
    model,
    capabilities,
    providerInfo,
    env
  })
  return { contextWindow: resolved.contextWindow, maxTokens: resolved.maxTokens }
}

/** 三种输入形状 + 一个对照：只返回被测的两个数 */
type Shape = 'custom' | 'custom-null' | 'unknown-builtin' | 'known-builtin'

function limitsOf(shape: Shape, capabilities: ModelCapabilities): Limits {
  switch (shape) {
    case 'custom':
      return limitsFor(CUSTOM_PROVIDER, 'local-model', capabilities)
    case 'custom-null':
      // 宿主查不到提供商 → 按自定义处理
      return limitsFor(null, 'local-model', capabilities)
    case 'unknown-builtin':
      // 先钉住「注册表确实查不到」，否则 pi-ai 收录后这一形状会悄悄变成已知路径
      expect(registryEntry(XAI_PROVIDER.name, UNKNOWN_XAI_MODEL)).toBeUndefined()
      return limitsFor(XAI_PROVIDER, UNKNOWN_XAI_MODEL, capabilities)
    case 'known-builtin':
      return limitsFor(XAI_PROVIDER, KNOWN_XAI_MODEL, capabilities)
  }
}

/** 修复改的是两个分支各自的字面量 —— 阈值用例在两条动态构造路径上各跑一次 */
const DUAL_PATHS: Shape[] = ['custom', 'unknown-builtin']

/** 能力对话框 Number(value) 得 NaN、JSON 落库变 null —— 类型上写不出来，白盒绕过 */
const nullCaps = (caps: Record<string, number | null>): ModelCapabilities =>
  caps as unknown as ModelCapabilities

describe('resolveModel token limits — 前置', () => {
  it('xai/grok-4.6 不在 pi-ai 注册表（unknown-builtin 形状的前提）', () => {
    expect(registryEntry('xai', UNKNOWN_XAI_MODEL)).toBeUndefined()
  })
})

describe('resolveModel token limits — A 阈值边界（custom / unknown-builtin 各跑一次）', () => {
  it.each(DUAL_PATHS)('A1 [%s] 输出上限严格小于窗口 → 采用', (shape) => {
    expect(limitsOf(shape, { maxInputTokens: 200000, maxOutputTokens: 32000 })).toEqual({
      contextWindow: 200000,
      maxTokens: 32000
    })
  })

  it.each(DUAL_PATHS)('A2 [%s] 输出上限等于窗口（litellm grok 形态）→ 视为未知', (shape) => {
    expect(limitsOf(shape, { maxInputTokens: 500000, maxOutputTokens: 500000 })).toEqual({
      contextWindow: 500000,
      maxTokens: DEFAULT_MAX_TOKENS
    })
  })

  it.each(DUAL_PATHS)('A3 [%s] 输出上限大于窗口 → 视为未知', (shape) => {
    expect(limitsOf(shape, { maxInputTokens: 131072, maxOutputTokens: 262144 })).toEqual({
      contextWindow: 131072,
      maxTokens: DEFAULT_MAX_TOKENS
    })
  })

  it.each(DUAL_PATHS)('A4 [%s] 窗口 − 1 的精确边界 → 采用', (shape) => {
    expect(limitsOf(shape, { maxInputTokens: 500000, maxOutputTokens: 499999 })).toEqual({
      contextWindow: 500000,
      maxTokens: 499999
    })
  })
})

describe('resolveModel token limits — B 缺失组合（custom 路径）', () => {
  it('B1 都缺 → 全默认', () => {
    expect(limitsOf('custom', {})).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS
    })
  })

  it('B2 只有窗口、缺输出 → 输出回落默认', () => {
    expect(limitsOf('custom', { maxInputTokens: 1000000 })).toEqual({
      contextWindow: 1000000,
      maxTokens: DEFAULT_MAX_TOKENS
    })
  })

  it('B3 缺窗口、输出小于默认窗口 → 与 128000 比较后采用', () => {
    expect(limitsOf('custom', { maxOutputTokens: 65536 })).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: 65536
    })
  })

  it.each([128000, 200000])('B4 缺窗口、输出 %i ≥ 默认窗口 → 视为未知', (maxOutputTokens) => {
    expect(limitsOf('custom', { maxOutputTokens })).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS
    })
  })
})

describe('resolveModel token limits — C 白盒：null 值', () => {
  it.each<[Record<string, number | null>, Limits]>([
    [
      { maxInputTokens: 200000, maxOutputTokens: null },
      { contextWindow: 200000, maxTokens: DEFAULT_MAX_TOKENS }
    ],
    [
      { maxInputTokens: null, maxOutputTokens: null },
      { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS }
    ]
  ])('C1 null 等同缺失：%o', (caps, expected) => {
    expect(limitsOf('custom', nullCaps(caps))).toEqual(expected)
  })
})

describe('resolveModel token limits — E 非正数', () => {
  it.each([0, -5])('E1 输出上限 %i → 视为未知（0 原样交给 pi 会变成 max_tokens: 0）', (n) => {
    expect(limitsOf('custom', { maxInputTokens: 200000, maxOutputTokens: n })).toEqual({
      contextWindow: 200000,
      maxTokens: DEFAULT_MAX_TOKENS
    })
  })
})

describe('resolveModel token limits — D 路径与对照', () => {
  it('D1 providerInfo === null 走自定义路径、同样归一', () => {
    expect(limitsOf('custom-null', { maxInputTokens: 500000, maxOutputTokens: 500000 })).toEqual({
      contextWindow: 500000,
      maxTokens: DEFAULT_MAX_TOKENS
    })
  })

  it('D2 注册表可查到的内置模型不走能力数据、也不被本规则砍（xai/grok-4.5）', () => {
    const registry = registryEntry(XAI_PROVIDER.name, KNOWN_XAI_MODEL)
    // 前置：注册表对象存在，且正是 maxTokens ≥ contextWindow 的形态 —— 失效说明 pi-ai 改了数据，换 grok-build-0.1
    expect(registry).toBeDefined()
    expect(registry!.maxTokens).toBeGreaterThanOrEqual(registry!.contextWindow)

    // 能力数据故意与注册表冲突
    expect(limitsOf('known-builtin', { maxInputTokens: 1000, maxOutputTokens: 1 })).toEqual({
      contextWindow: registry!.contextWindow,
      maxTokens: registry!.maxTokens
    })
  })

  it('D3 常规形状的注册表模型同样忽略 caps（openai/gpt-5）', () => {
    const registry = registryEntry(OPENAI_PROVIDER.name, 'gpt-5')
    expect(registry).toBeDefined()

    expect(
      limitsFor(OPENAI_PROVIDER, 'gpt-5', { maxInputTokens: 500, maxOutputTokens: 100 })
    ).toEqual({ contextWindow: registry!.contextWindow, maxTokens: registry!.maxTokens })
  })
})
