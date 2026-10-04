/**
 * 桌面端的模型注册表单例 —— agent-runtime `createModelRegistry` 的宿主接线。
 *
 * - **一份 `Models`**：每个 provider 行恰好一个 pi provider（内置按 slug、自定义按行 id），
 *   凭据经 `providerCredentialPort` 每次请求现读（OAuth 压过 API Key、刷新串行都在模型层的
 *   凭据库里）；请求经 `llmNetwork` 套上作用域（15 分钟 dispatcher + fetch 失败成因链）。
 * - **懒建**：第一次 `getModelRegistry()` 时才建（建的那一刻同步读一遍行）。建之前发生的
 *   provider 变更不需要补：建的时候读到的就是最新的行。
 * - **跟着 `providers.changed` 刷新**：provider / 模型的形状（增删、协议、baseUrl、能力）变了
 *   才需要 `refresh()`；key 与 OAuth 记录不属于 provider 的形状，凭据库每次现读，不必刷新。
 * - **不给 authContext**（Q15）：内置 provider 保留 pi-ai 默认的环境变量兜底（与 0.80 时一致）；
 *   自定义 provider 只读库里的 key，从不碰环境变量（模型层 M5）。
 * - **停用的 provider 照样注册**（Q9）：锁在它上面的会话要能接着跑；选择器与创建 Agent
 *   各自过滤。
 *
 * 测试用 `createDesktopModelRegistry({ port, network, events })` 自己建一个（假端口、假总线），
 * 不碰单例；碰了单例的用 `resetModelRegistry()` 收尾。
 */
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import type { Api, Model } from '@earendil-works/pi-ai'
import {
  createModelRegistry,
  piProviderIdOf,
  type ModelRef,
  type ModelRegistry,
  type ProviderCredentialPort,
  type RuntimeNetwork
} from '@shuvix/agent-runtime'
import type { AppEventBus } from '@shuvix/chat-protocol/appEvents'
import { appEventBus } from '../../utils/appEventBus'
import { createLogger } from '../../logger'
import { llmNetwork } from './llmNetwork'
import { providerCredentialPort } from './providerCredentialPort'

const log = createLogger('ModelRegistry')

let oauthFlowsRegistered = false

/**
 * pi-ai 的 OAuth 流程模块是用**变量说明符的动态 import** 加载的（故意让打包器看不见，
 * 好把 node-only 代码挡在 bundle 外）。而我们在 Electron 主进程里是 inline pi-ai 的，
 * 那个动态 import 到了运行时会照着 out/main/ 去找 ./auth/oauth/xai.js —— 找不到。
 *
 * `registerBunOAuthFlows()` 正是为这种「已经静态打包进去了」的场景准备的注册入口：
 * 它用静态 import 把 xai 等几家的实现塞进 loader 表，动态 import 那条路就不会被走到。
 *
 * 放在注册表建起来之前而不是订阅登录服务里：OAuth 的**刷新**发生在模型层解析请求凭据的
 * 路上（会话发请求时），那条路不经过订阅登录服务。注册失败只该让订阅登录 / 刷新不可用，
 * 不该连累注册表本身（API Key 那条路照常）。
 */
function ensureOAuthFlowsRegistered(): void {
  if (oauthFlowsRegistered) return
  oauthFlowsRegistered = true
  try {
    registerBunOAuthFlows()
  } catch (err) {
    log.error('注册内置 OAuth 流程失败，订阅登录将不可用', err)
  }
}

export interface DesktopModelRegistryOptions {
  port: ProviderCredentialPort
  /** 省略 = 不套请求作用域（测试）；单例传 llmNetwork */
  network?: RuntimeNetwork
  /** 订阅 `providers.changed` 的总线；省略 = 不订阅 */
  events?: Pick<AppEventBus, 'subscribe'>
}

export interface DesktopModelRegistry extends ModelRegistry {
  /** 退订 `providers.changed`（测试收尾 / 单例重置用） */
  dispose(): void
}

/** 建一个注册表并（若给了总线）在 `providers.changed` 上刷新 */
export function createDesktopModelRegistry(
  options: DesktopModelRegistryOptions
): DesktopModelRegistry {
  ensureOAuthFlowsRegistered()
  const registry = createModelRegistry({ port: options.port, network: options.network })
  const unsubscribe = options.events?.subscribe((event) => {
    if (event.type !== 'providers.changed') return
    // refresh 失败（端口抛错）什么也不改，旧的 provider 照用；只留一条日志，不能让一次
    // 广播的派发者（provider 设置的写入口）跟着失败
    registry.refresh().catch((err: unknown) => {
      log.warn(`providers.changed 后刷新模型注册表失败: ${errorText(err)}`)
    })
  })
  return { ...registry, dispose: () => unsubscribe?.() }
}

let singleton: DesktopModelRegistry | undefined

/** 主进程唯一的模型注册表（懒建） */
export function getModelRegistry(): ModelRegistry {
  singleton ??= createDesktopModelRegistry({
    port: providerCredentialPort,
    network: llmNetwork,
    events: appEventBus
  })
  return singleton
}

/** 丢掉单例（退订），下一次 `getModelRegistry()` 重新建 —— 只给测试用 */
export function resetModelRegistry(): void {
  singleton?.dispose()
  singleton = undefined
}

/** 会话设置里的模型选择（`sessions.settings.model`）：provider **行 id** + 模型 id */
export interface ModelSelection {
  provider: string
  modelId: string
}

/**
 * 会话设置里的模型选择 → 模型引用 + pi 模型。
 *
 * `settings.model.provider` 存的是 provider **行 id**（选择器的 `AvailableModel.providerId`，
 * 即 `provider_models.providerId`）—— 内置行在老库上是 slug、在 UUIDv7 迁移之后建的库上是
 * uuid，自定义行是 uuid。pi 侧的 provider id 一律经 `modelRefOf` 换：内置 → slug，自定义 →
 * 行 id。行已删 → undefined；模型 id 不在该 provider 下 → `model` 为 undefined（ref 照给）。
 * 不看启用位（Q9：停用的 provider 照样能解析，拒不拒由调用方定）。
 */
export function resolveModelSelection(
  registry: Pick<ModelRegistry, 'models' | 'modelRefOf'>,
  selection: ModelSelection
): { ref: ModelRef; model: Model<Api> | undefined } | undefined {
  const ref = registry.modelRefOf(selection.provider, selection.modelId)
  if (!ref) return undefined
  return { ref, model: registry.models.getModel(ref.provider, ref.id) }
}

/**
 * 某 provider 行此刻用于请求的 API key（订阅登录过的取 access token，过期先刷新 —— 刷新在
 * 模型层凭据库的串行队列里做）。行不存在 / 没有 pi id / 未配置 → undefined。
 *
 * 给「不经 pi 发请求」的场合用（拉模型列表）；会话请求自己经 `models` 解析凭据，不走这里。
 * 刷新失败照样抛（pi 的 ModelsError "oauth"），调用方决定怎么显示。
 */
export async function resolveRequestApiKey(
  providerRowId: string,
  registry: Pick<ModelRegistry, 'models'> = getModelRegistry(),
  port: Pick<ProviderCredentialPort, 'listProviders'> = providerCredentialPort
): Promise<string | undefined> {
  const row = port.listProviders().find((candidate) => candidate.id === providerRowId)
  const providerId = row ? piProviderIdOf(row) : undefined
  if (!providerId) return undefined
  const result = await registry.models.getAuth(providerId)
  return result?.auth.apiKey || undefined
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
