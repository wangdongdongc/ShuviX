/**
 * 提供商订阅登录（OAuth）—— 目前只有 xAI 一家。
 *
 * 背景：SuperGrok / X Premium 这类**消费端订阅不含 API 额度**，填 API Key 那条路复用不到。
 * 能复用的是官方 CLI 用的设备码 OAuth：登录后拿到的 access token 打同一个 api.x.ai，
 * 但走订阅配额而不是 API 信用额。
 *
 * pi 1.0 起凭据的存、刷、给都归模型层（services/models → agent-runtime 的 DB 凭据库）：
 * 登录是 `models.login(slug, 'oauth', …)`（流程是 pi-ai 内置 provider 自己的，凭据经凭据库
 * 加密落库）、退出是 `models.logout(slug)`、刷新由 `Models` 在解析请求凭据时于凭据库的
 * 逐 provider 串行队列里做（xAI 会轮换 refresh token，两个并发刷新会把彼此的换废）。
 * 这里只剩宿主自己的事：**哪一行能登录**、**同一时刻只跑一个登录且能取消**、**状态给界面看**、
 * 以及变更后广播 `providers.changed`。
 */
import type { AuthEvent, AuthPrompt, Models } from '@earendil-works/pi-ai'
import { piProviderIdOf, type ProviderCredentialPort } from '@shuvix/agent-runtime'
import { getModelRegistry, providerCredentialPort } from './models'
import { appEventBus } from '../utils/appEventBus'
import { createLogger } from '../logger'

const log = createLogger('ProviderOAuth')

/**
 * 支持订阅登录的内置 provider（pi slug）。
 *
 * 只列 xAI。pi-ai 同样内置了 anthropic / github-copilot / openai-codex 等几家的流程，
 * 加进来就是加一项 —— 但每加一家都要配套 UI 与凭据语义，所以按需再加（phase 5）。
 */
const OAUTH_PROVIDER_SLUGS: ReadonlySet<string> = new Set(['xai'])

/** 登录过程中推给界面的事件（设备码、进度、提示） */
export type ProviderOAuthEvent = AuthEvent

export interface ProviderOAuthStatus {
  /** 该提供商是否支持订阅登录 */
  supported: boolean
  /** 是否已登录（有可用的 OAuth 凭据） */
  connected: boolean
  /** 当前 access token 的到期时间（毫秒），未登录为 null */
  expiresAt: number | null
  /** 登录流程是否正在进行 */
  pending: boolean
}

/** 服务用到的外部设施 —— 默认接主进程的单例，测试换成假的 */
export interface ProviderOAuthDeps {
  /** 模型集合（桌面：模型注册表装饰过的那份） */
  models: () => Pick<Models, 'login' | 'logout' | 'checkAuth'>
  /** provider 表的端口（找行、读到期时间、清自定义行的残留记录） */
  port: () => Pick<ProviderCredentialPort, 'listProviders' | 'readOAuth' | 'clearOAuth'>
  /** 登录状态变了：provider 列表要跟着刷新 */
  publishChanged: () => void
}

const defaultDeps: ProviderOAuthDeps = {
  models: () => getModelRegistry().models,
  port: () => providerCredentialPort,
  publishChanged: () => appEventBus.publish({ type: 'providers.changed' })
}

/** 存着的 OAuth 记录里的到期时间（毫秒）；读不出来按 0（已过期，下次用时刷新） */
function expiresOf(json: string | undefined): number {
  if (!json) return 0
  try {
    const parsed: unknown = JSON.parse(json)
    const expires = (parsed as { expires?: unknown } | null)?.expires
    return typeof expires === 'number' && Number.isFinite(expires) ? expires : 0
  } catch {
    return 0
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class ProviderOAuthService {
  /** 进行中的登录（设备码轮询可长达数分钟，用户要能取消），按 pi slug */
  private logins = new Map<string, AbortController>()

  constructor(private readonly deps: ProviderOAuthDeps = defaultDeps) {}

  /**
   * provider 行 id → **内置** provider 的 pi-ai slug；自定义 provider 一律 undefined。
   *
   * 为什么不能直接用 id：历史上有过一次「提供商 ID 迁移至 UUIDv7」(7eb9d83)，那之后建的库里
   * 内置行的 id 是 uuid、只有 name 是 slug，而且没有迁回的迁移 —— 同一个版本在新库上 id='xai'、
   * 在老库上 id='0193…'。模型层同源（`piProviderIdOf`：内置按 slug，自定义按行 id）。
   *
   * 为什么还要卡 isBuiltin：问题的正确形式是「这是不是内置的那一家」，不是「这行叫什么」。
   * 今天 name 有 UNIQUE 约束、内置行的 name 也改不动（updateName 带 isBuiltin = 0），所以
   * 单看 name 也不会撞；但那是两条隔了几层的前提，而这里一旦误判，后果是把 xAI 的订阅令牌
   * 交给一个 baseUrl 由用户自填的 provider。多一个条件就不必依赖那两条前提。
   */
  private builtinSlugOf(providerRowId: string): string | undefined {
    const row = this.deps
      .port()
      .listProviders()
      .find((candidate) => candidate.id === providerRowId)
    if (!row?.isBuiltin) return undefined
    return piProviderIdOf(row)
  }

  /** 支持订阅登录的那一家的 slug；不支持 → undefined */
  private oauthSlugOf(providerRowId: string): string | undefined {
    const slug = this.builtinSlugOf(providerRowId)
    return slug && OAUTH_PROVIDER_SLUGS.has(slug) ? slug : undefined
  }

  supports(providerRowId: string): boolean {
    return this.oauthSlugOf(providerRowId) !== undefined
  }

  /**
   * 登录状态。「已登录」= 模型层此刻会用 OAuth 凭据（`checkAuth` 答 oauth：记录在且读得出来，
   * 坏记录读作未登录、退回 API Key）；到期时间取存着的原记录（`checkAuth` 不带它，也不刷新）。
   */
  async status(providerRowId: string): Promise<ProviderOAuthStatus> {
    const slug = this.oauthSlugOf(providerRowId)
    if (!slug) return { supported: false, connected: false, expiresAt: null, pending: false }
    let connected = false
    try {
      connected = (await this.deps.models().checkAuth(slug))?.type === 'oauth'
    } catch (err) {
      log.warn(`${slug} 读取登录状态失败: ${errorText(err)}`)
    }
    return {
      supported: true,
      connected,
      expiresAt: connected ? expiresOf(this.deps.port().readOAuth(providerRowId)) : null,
      pending: this.logins.has(slug)
    }
  }

  /**
   * 走一遍设备码登录并落库（落库由模型层的凭据库做，与刷新共用一条串行队列）。
   *
   * `notify` 会先收到 `device_code`（用户码 + 验证链接），之后是轮询进度；调用方负责
   * 把它显示出来并打开浏览器。同一 provider 只允许一个登录在跑。
   */
  async login(
    providerRowId: string,
    notify: (event: ProviderOAuthEvent) => void
  ): Promise<{ success: boolean; error?: string }> {
    const slug = this.oauthSlugOf(providerRowId)
    if (!slug) return { success: false, error: `提供商 ${providerRowId} 不支持订阅登录` }
    if (this.logins.has(slug)) return { success: false, error: '该提供商已有登录流程在进行' }

    const controller = new AbortController()
    this.logins.set(slug, controller)
    try {
      await this.deps.models().login(slug, 'oauth', {
        signal: controller.signal,
        notify,
        // 设备码流程不问任何问题；真要问了说明 pi-ai 换了流程，那必须显式炸而不是静默卡住
        prompt: (p: AuthPrompt) =>
          Promise.reject(new Error(`订阅登录不支持交互输入（收到 ${p.type} 提问）`))
      })
      log.info(`${slug} 订阅登录成功`)
      // 列表里的登录状态要跟着变（与 providerService 各 mutator 同一条广播）
      this.deps.publishChanged()
      return { success: true }
    } catch (err) {
      const message = errorText(err)
      log.warn(`${slug} 订阅登录失败: ${message}`)
      return { success: false, error: message }
    } finally {
      this.logins.delete(slug)
    }
  }

  /** 取消进行中的登录（设备码还没被批准时用户改主意） */
  cancelLogin(providerRowId: string): void {
    const slug = this.oauthSlugOf(providerRowId)
    if (slug) this.logins.get(slug)?.abort()
  }

  /**
   * 退出订阅登录：清凭据。API Key 不动，清完就自动退回用 Key（如果填了）。
   *
   * 内置行走 `models.logout(slug)`（与刷新同一条串行队列）。没有 slug 的行（自定义）登录不了，
   * 若库里有一条残留的 OAuth 记录（手改过库），直接按行清掉 —— 留着它，凭据库会让它压过这一行
   * 的 API Key。
   */
  async logout(providerRowId: string): Promise<void> {
    this.cancelLogin(providerRowId)
    const slug = this.builtinSlugOf(providerRowId)
    if (slug) {
      await this.deps.models().logout(slug)
    } else {
      this.deps.port().clearOAuth(providerRowId)
    }
    this.deps.publishChanged()
    log.info(`${slug ?? providerRowId} 已退出订阅登录`)
  }
}

export const providerOAuthService = new ProviderOAuthService()
