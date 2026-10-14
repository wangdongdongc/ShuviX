/**
 * 类型层守卫（server mode phase A §5）：由通道表建出来的 `window.api`（`DesktopApi`）与渲染端看到的类型面
 * `ShuviXAPI`（preload/index.d.ts）对得上。`ShuviXAPI` 只在 tsconfig.web 下可见，所以放在渲染层、由
 * `npm run typecheck:web -w shuvix` 核对；运行时只有一条恒真的样本让 vitest 收得到本文件。
 *
 *   TT-1 `DesktopApi` 能赋给 `ShuviXAPI`
 *   TT-2 键一致：`keyof DesktopApi` 与 `keyof ShuviXAPI` 相同；每个命名空间的成员键相同（不一致的 `ns.member` 收成 never）
 *   TT-3 种类：表里每个成员在 `ShuviXAPI` 里 —— invoke 回 `Promise<…>`；send 回的恰是 `void`；
 *        event 恰一个参数且是函数、回 `() => void`（不合的 `ns.member` 收成 never）
 *   TT-4 参数个数：invoke / send 的最大参数个数 = 表里的 `args`；event 回调的最大参数个数 = `args`
 *   TT-5 override：`knowledge.baseOptions` / `liveDoc.respond` / `events` / `sync` 在 `ShuviXAPI` 里的类型与
 *        `DesktopApiOverrides` 的声明恰好相同；`DesktopApiOverrides` 的命名空间与 `API_OVERRIDE_CHANNELS` 相同，
 *        每个命名空间的**必有**成员与 `API_OVERRIDE_CHANNELS[ns]` 的键相同（`SyncLinkChannel` 的 onDown / onUp /
 *        isUp 是可选的）。`app.platform` 只单向：`ShuviXAPI` 多一个 'web'，桌面 override 收窄。
 *
 * 失败时编译器报「Type '"ns.member"' does not satisfy the constraint 'never'」—— 直接点名哪个成员。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { API_OVERRIDE_CHANNELS, API_TABLE } from '../../../../shared/apiTable'
import type { DesktopApi, DesktopApiOverrides } from '../../../../shared/buildApi'

// ─── 类型小工具 ───

/** 严格相等（`<X>() => X extends A ? 1 : 2` 的恒等技巧：可选 / 只读 / any 都分得清） */
type Eq<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type MustBeTrue<T extends true> = T
type MustBeNever<T extends never> = T
type AnyFn = (...args: any[]) => any
/** 最大参数个数（可选参数也算） */
type MaxArity<F extends AnyFn> = Required<Parameters<F>>['length']
/** 必有的键（`{}` 满足不了它那一列 Pick 的键） */
type ReqKeys<O> = {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` 正是「什么都不要求」
  [K in keyof O]-?: {} extends Pick<O, K> ? never : K
}[keyof O]

type Table = typeof API_TABLE
type OverrideChannels = typeof API_OVERRIDE_CHANNELS
type Api = ShuviXAPI

/** `ShuviXAPI[NS][K]`（取不到 → never） */
type ApiMemberOf<NS, K> = NS extends keyof Api
  ? K extends keyof Api[NS]
    ? Api[NS][K]
    : never
  : never

type Name<NS, K> = `${NS & string}.${K & string}`

// ─── TT-1 ───

/** 只在编译期：`DesktopApi` 能赋给 `ShuviXAPI` */
function _desktopApiIsShuviXApi(built: DesktopApi): ShuviXAPI {
  return built
}

// ─── TT-2 ───

type TT2Namespaces = MustBeTrue<Eq<keyof DesktopApi, keyof Api>>

/** 成员键不一致的命名空间 */
type BadNamespaces = {
  [NS in keyof Api]: NS extends keyof DesktopApi
    ? Eq<keyof DesktopApi[NS], keyof Api[NS]> extends true
      ? never
      : NS
    : NS
}[keyof Api]
type TT2BadNamespaces = MustBeNever<BadNamespaces>

/** 只在一边出现的 `ns.member`（两个方向） */
type OnlyInBuilt = {
  [NS in keyof DesktopApi]: NS extends keyof Api
    ? {
        [K in keyof DesktopApi[NS]]-?: K extends keyof Api[NS] ? never : Name<NS, K>
      }[keyof DesktopApi[NS]]
    : Name<NS, '*'>
}[keyof DesktopApi]
type OnlyInDeclared = {
  [NS in keyof Api]: NS extends keyof DesktopApi
    ? {
        [K in keyof Api[NS]]-?: K extends keyof DesktopApi[NS] ? never : Name<NS, K>
      }[keyof Api[NS]]
    : Name<NS, '*'>
}[keyof Api]
type TT2OnlyInBuilt = MustBeNever<OnlyInBuilt>
type TT2OnlyInDeclared = MustBeNever<OnlyInDeclared>

// ─── TT-3 ───

type KindOk<M, F> = M extends { readonly kind: 'invoke' }
  ? F extends AnyFn
    ? ReturnType<F> extends Promise<unknown>
      ? true
      : false
    : false
  : M extends { readonly kind: 'send' }
    ? F extends AnyFn
      ? Eq<ReturnType<F>, void>
      : false
    : M extends { readonly kind: 'event' }
      ? F extends AnyFn
        ? Parameters<F> extends [infer C]
          ? C extends AnyFn
            ? Eq<ReturnType<F>, () => void>
            : false
          : false
        : false
      : false

type KindFailures = {
  [NS in keyof Table]: {
    [K in keyof Table[NS]]: KindOk<Table[NS][K], ApiMemberOf<NS, K>> extends true
      ? never
      : Name<NS, K>
  }[keyof Table[NS]]
}[keyof Table]
type TT3 = MustBeNever<KindFailures>

// ─── TT-4 ───

type ArityOk<M, F> = M extends { readonly kind: 'invoke' | 'send'; readonly args: infer N }
  ? F extends AnyFn
    ? Eq<MaxArity<F>, N>
    : false
  : M extends { readonly kind: 'event'; readonly args: infer N }
    ? F extends AnyFn
      ? Parameters<F>[0] extends infer C
        ? C extends AnyFn
          ? Eq<MaxArity<C>, N>
          : false
        : false
      : false
    : false

type ArityFailures = {
  [NS in keyof Table]: {
    [K in keyof Table[NS]]: ArityOk<Table[NS][K], ApiMemberOf<NS, K>> extends true
      ? never
      : Name<NS, K>
  }[keyof Table[NS]]
}[keyof Table]
type TT4 = MustBeNever<ArityFailures>

// ─── TT-5 ───

type TT5BaseOptions = MustBeTrue<
  Eq<Api['knowledge']['baseOptions'], DesktopApiOverrides['knowledge']['baseOptions']>
>
type TT5Respond = MustBeTrue<
  Eq<Api['liveDoc']['respond'], DesktopApiOverrides['liveDoc']['respond']>
>
type TT5Events = MustBeTrue<Eq<Api['events'], DesktopApiOverrides['events']>>
type TT5Sync = MustBeTrue<Eq<Api['sync'], DesktopApiOverrides['sync']>>
type TT5OverrideNamespaces = MustBeTrue<Eq<keyof DesktopApiOverrides, keyof OverrideChannels>>

/** 必有成员与 API_OVERRIDE_CHANNELS[ns] 的键对不上的命名空间 */
type BadOverrideNamespaces = {
  [NS in keyof OverrideChannels]: NS extends keyof DesktopApiOverrides
    ? Eq<ReqKeys<DesktopApiOverrides[NS]>, keyof OverrideChannels[NS]> extends true
      ? never
      : NS
    : NS
}[keyof OverrideChannels]
type TT5OverrideMembers = MustBeNever<BadOverrideNamespaces>

/** `app.platform`：桌面 override 的值能赋给声明（单向；声明多一个 'web'） */
type TT5Platform = MustBeTrue<
  DesktopApiOverrides['app']['platform'] extends Api['app']['platform'] ? true : false
>

/** 上面每一条检查在这里各被引用一次（noUnusedLocals；任何一条不成立，它自己那行就编译不过） */
type TypeChecks = [
  TT2Namespaces,
  TT2BadNamespaces,
  TT2OnlyInBuilt,
  TT2OnlyInDeclared,
  TT3,
  TT4,
  TT5BaseOptions,
  TT5Respond,
  TT5Events,
  TT5Sync,
  TT5OverrideNamespaces,
  TT5OverrideMembers,
  TT5Platform
]

describe('TT 通道表与 ShuviXAPI 的类型对照', () => {
  it('TT-1..TT-5 都在编译期（typecheck:web）；这里只确认失败清单是 never', () => {
    expectTypeOf<TypeChecks>().toEqualTypeOf<
      [true, never, never, never, never, never, true, true, true, true, true, never, true]
    >()
    expectTypeOf<KindFailures>().toBeNever()
    expectTypeOf<ArityFailures>().toBeNever()
    expectTypeOf<BadNamespaces>().toBeNever()
    expectTypeOf<BadOverrideNamespaces>().toBeNever()
    expect(typeof _desktopApiIsShuviXApi).toBe('function')
  })
})
