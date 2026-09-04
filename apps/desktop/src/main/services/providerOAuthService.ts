/**
 * 提供商订阅登录（OAuth）—— 目前只有 xAI 一家。
 *
 * 背景：SuperGrok / X Premium 这类**消费端订阅不含 API 额度**，填 API Key 那条路复用不到。
 * 能复用的是官方 CLI 用的设备码 OAuth：登录后拿到的 access token 打同一个 api.x.ai，
 * 但走订阅配额而不是 API 信用额。
 *
 * 流程实现直接用 pi-ai 自带的（`xaiProvider().auth.oauth`）—— 端点、client id、scope、
 * 轮询与刷新语义都在那里，我们只负责三件宿主的事：**存**（加密落库）、**刷**（串行、
 * 到点即换）、**给**（`getApiKey` 每次请求现取）。
 */
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import type { AuthEvent, AuthPrompt, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import { providerDao } from '../dao/providerDao'
import type { ProviderOAuthCredential } from '../dao/types'
import { appEventBus } from '../utils/appEventBus'
import { createLogger } from '../logger'

const log = createLogger('ProviderOAuth')

/**
 * pi-ai 的 OAuth 流程模块是用**变量说明符的动态 import** 加载的（故意让打包器看不见，
 * 好把 node-only 代码挡在 bundle 外）。而我们在 Electron 主进程里是 inline pi-ai 的，
 * 那个动态 import 到了运行时会照着 out/main/ 去找 ./auth/oauth/xai.js —— 找不到。
 *
 * `registerBunOAuthFlows()` 正是为这种「已经静态打包进去了」的场景准备的注册入口：
 * 它用静态 import 把 xai 等四家的实现塞进 loader 表，动态 import 那条路就不会被走到。
 */
try {
  registerBunOAuthFlows()
} catch (err) {
  // 注册失败只该让订阅登录不可用，不该连累整个模块的加载 —— providerHandlers 依赖它，
  // 一个顶层抛错会把所有 provider IPC 一起带走，症状会离病因非常远。
  log.error('注册内置 OAuth 流程失败，订阅登录将不可用', err)
}

/**
 * 支持订阅登录的提供商表：provider slug → pi-ai 的 OAuth 流程。
 *
 * 只列 xAI。pi-ai 同样内置了 anthropic / github-copilot / openai-codex 三家的流程，
 * 加进来就是加一行 —— 但每加一家都要配套 UI 与凭据语义，所以按需再加。
 */
const OAUTH_PROVIDERS: Record<string, () => OAuthAuth> = {
  xai: () => {
    const oauth = xaiProvider().auth.oauth
    if (!oauth) throw new Error('pi-ai 的 xai provider 未声明 OAuth 流程')
    return oauth
  }
}

/** 登录过程中推给界面的事件（设备码、进度、提示） */
export type ProviderOAuthEvent = AuthEvent

export interface ProviderOAuthStatus {
  /** 该提供商是否支持订阅登录 */
  supported: boolean
  /** 是否已登录（有凭据） */
  connected: boolean
  /** 当前 access token 的到期时间（毫秒），未登录为 null */
  expiresAt: number | null
  /** 登录流程是否正在进行 */
  pending: boolean
}

function toStored(credential: OAuthCredential): ProviderOAuthCredential {
  return { access: credential.access, refresh: credential.refresh, expires: credential.expires }
}

function toPi(credential: ProviderOAuthCredential): OAuthCredential {
  return { type: 'oauth', ...credential }
}

export class ProviderOAuthService {
  /** 每个 provider 一条串行链：xAI 会轮换 refresh token，两个并发刷新会把彼此的换废 */
  private chains = new Map<string, Promise<unknown>>()
  /** 进行中的登录（设备码轮询可长达数分钟，用户要能取消） */
  private logins = new Map<string, AbortController>()
  private flows = new Map<string, OAuthAuth>()

  /** 串行化同一 provider 上的凭据读写，语义同 pi 的 `CredentialStore.modify` */
  private enqueue<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(providerId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    // 链条只用来排队，失败不能让后续操作一起挂掉
    this.chains.set(
      providerId,
      next.catch(() => undefined)
    )
    return next
  }

  /**
   * provider 行 id → pi-ai slug。
   *
   * 内置 provider 的 id **不一定**等于 slug：历史上有过一次「提供商 ID 迁移至 UUIDv7」
   * (7eb9d83)，那之后建的库里内置行的 id 是 uuid、只有 name 是 slug，而且没有迁回的迁移 ——
   * 于是同一个版本在新库上 id='xai'、在老库上 id='0193…'。所以凡是「这是哪一家」的判断都
   * 必须看 name，`modelResolver` 里的 `providerInfo.name.toLowerCase()` 同源。
   *
   * 凭据仍按 id 读写：那是行的主键，与它叫什么无关。
   */
  private slugOf(providerId: string): string | undefined {
    const name = providerDao.pick(providerId, ['name'])?.name
    return name ? name.toLowerCase() : undefined
  }

  private flow(providerId: string): OAuthAuth | undefined {
    const slug = this.slugOf(providerId)
    if (!slug) return undefined
    const factory = OAUTH_PROVIDERS[slug]
    if (!factory) return undefined
    let cached = this.flows.get(slug)
    if (!cached) {
      cached = factory()
      this.flows.set(slug, cached)
    }
    return cached
  }

  supports(providerId: string): boolean {
    const slug = this.slugOf(providerId)
    return !!slug && slug in OAUTH_PROVIDERS
  }

  status(providerId: string): ProviderOAuthStatus {
    const supported = this.supports(providerId)
    const credential = supported ? providerDao.readOAuth(providerId) : undefined
    return {
      supported,
      connected: !!credential,
      expiresAt: credential?.expires ?? null,
      pending: this.logins.has(providerId)
    }
  }

  /**
   * 走一遍设备码登录并落库。
   *
   * `notify` 会先收到 `device_code`（用户码 + 验证链接），之后是轮询进度；调用方负责
   * 把它显示出来并打开浏览器。同一 provider 只允许一个登录在跑。
   */
  async login(
    providerId: string,
    notify: (event: ProviderOAuthEvent) => void
  ): Promise<{ success: boolean; error?: string }> {
    const flow = this.flow(providerId)
    if (!flow) return { success: false, error: `提供商 ${providerId} 不支持订阅登录` }
    if (this.logins.has(providerId)) return { success: false, error: '该提供商已有登录流程在进行' }

    const controller = new AbortController()
    this.logins.set(providerId, controller)
    try {
      const credential = await flow.login({
        signal: controller.signal,
        notify,
        // 设备码流程不问任何问题；真要问了说明 pi-ai 换了流程，那必须显式炸而不是静默卡住
        prompt: (p: AuthPrompt) =>
          Promise.reject(new Error(`订阅登录不支持交互输入（收到 ${p.type} 提问）`))
      })
      await this.enqueue(providerId, async () => {
        providerDao.saveOAuth(providerId, toStored(credential))
      })
      log.info(`${providerId} 订阅登录成功`)
      // 列表里的登录状态要跟着变（与 providerService 各 mutator 同一条广播）
      appEventBus.publish({ type: 'providers.changed' })
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`${providerId} 订阅登录失败: ${message}`)
      return { success: false, error: message }
    } finally {
      this.logins.delete(providerId)
    }
  }

  /** 取消进行中的登录（设备码还没被批准时用户改主意） */
  cancelLogin(providerId: string): void {
    this.logins.get(providerId)?.abort()
  }

  /** 退出订阅登录：清凭据。API Key 不动，清完就自动退回用 Key（如果填了）。 */
  async logout(providerId: string): Promise<void> {
    this.cancelLogin(providerId)
    await this.enqueue(providerId, async () => {
      providerDao.clearOAuth(providerId)
    })
    appEventBus.publish({ type: 'providers.changed' })
    log.info(`${providerId} 已退出订阅登录`)
  }

  /**
   * 取当前可用的 access token；到期就先刷新再返回。未登录返回 undefined（调用方回退到 API Key）。
   *
   * 刷新失败**保留**旧凭据（pi 的语义：重新登录可修），只把错误抛给调用方 —— 静默清掉
   * 会让一次网络抖动看起来像「登录掉了」。
   */
  async getAccessToken(providerId: string): Promise<string | undefined> {
    const flow = this.flow(providerId)
    if (!flow) return undefined
    return this.enqueue(providerId, async () => {
      const stored = providerDao.readOAuth(providerId)
      if (!stored) return undefined
      let credential = toPi(stored)
      if (credential.expires <= Date.now()) {
        credential = await flow.refresh(credential)
        providerDao.saveOAuth(providerId, toStored(credential))
        log.debug(`${providerId} access token 已刷新`)
      }
      const auth = await flow.toAuth(credential)
      // 我们的注入口只有 apiKey 一个字段（modelsAdapter 的 streamSimple 选项）。
      // 若哪天 pi-ai 把 xAI 改成走订阅代理（会带 baseUrl/headers），这里必须先看见再动，
      // 否则请求会照旧打 api.x.ai —— 那是另一份额度，静默走错比报错难查得多。
      if (auth.baseUrl || auth.headers) {
        log.warn(
          `${providerId} 的 OAuth 认证带了 baseUrl/headers，当前注入通道只支持 apiKey，已忽略`
        )
      }
      return auth.apiKey
    })
  }
}

export const providerOAuthService = new ProviderOAuthService()
