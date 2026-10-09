/**
 * 提供商订阅登录（OAuth）—— xAI、Kimi Code、OpenAI（Sign in with ChatGPT）三家。
 *
 * 背景：消费端订阅（SuperGrok / X Premium、Kimi Code 会员、ChatGPT 订阅）**不含 API 额度**，
 * 填 API Key 那条路复用不到。能复用的是各家给 CLI / 第三方 agent 用的 OAuth：登录后拿到的
 * access token 打同一个 API，但走订阅配额而不是 API 信用额。
 *
 * 两种流程，界面都要接得住：
 * - **设备码**（xAI、Kimi Code）：pi 推 `device_code`（用户码 + 验证链接），在浏览器里批准即可。
 * - **浏览器回调**（OpenAI）：pi 在本机起回调端口、推 `auth_url`，同时用 `manual_code` 提问
 *   与回调赛跑 —— 浏览器回不到本机时（比如在另一台机器上登录）用户把最后停下的地址粘回来。
 *   提问经 `prompt` 事件推给界面、`answerPrompt` 回答；回调先到时 pi 中止那个提问，界面收
 *   `prompt_closed` 收起输入框。
 *
 * pi 1.0 起凭据的存、刷、给都归模型层（services/models → agent-runtime 的 DB 凭据库）：
 * 登录是 `models.login(slug, 'oauth', …)`（流程是 pi-ai 内置 provider 自己的，凭据经凭据库
 * 加密落库）、退出是 `models.logout(slug)`、刷新由 `Models` 在解析请求凭据时于凭据库的
 * 逐 provider 串行队列里做（xAI 会轮换 refresh token，两个并发刷新会把彼此的换废）。
 * 这里只剩宿主自己的事：**哪一行能登录**、**同一时刻只跑一个登录且能取消**、**登录中的提问**、
 * **状态给界面看**、以及变更后广播 `providers.changed`。
 *
 * 用不用订阅登录、各家条款允不允许，是用户自己的判断（与 pi 同一立场）：界面只写清计费事实。
 */
import { randomUUID } from 'crypto'
import type { AuthEvent, AuthPrompt, Models } from '@earendil-works/pi-ai'
import { piProviderIdOf, type ProviderCredentialPort } from '@shuvix/agent-runtime'
import { getModelRegistry, providerCredentialPort } from './models'
import { settingsDao } from '../dao/settingsDao'
import { appEventBus } from '../utils/appEventBus'
import { createLogger } from '../logger'

const log = createLogger('ProviderOAuth')

/**
 * 支持订阅登录的内置 provider（pi slug）。
 *
 * pi-ai 还内置了 anthropic / github-copilot / openrouter 等几家的流程，加进来就是加一项 ——
 * 外加界面上那家的说明文字（`settings.oauthProviders.<slug>`）。
 */
const OAUTH_PROVIDER_SLUGS: ReadonlySet<string> = new Set(['xai', 'kimi-coding', 'openai'])

/** 本机安装的稳定 ID（OpenAI 把它当作 agent host ID）：第一次登录时生成，之后一直用同一个 */
const DEVICE_ID_KEY = 'provider.oauthDeviceId'

/** 登录中向用户要的一段输入（浏览器登录回不来时粘贴的地址；`secret` 要遮住） */
export type ProviderOAuthPromptInput = 'manual_code' | 'text' | 'secret'

/**
 * 登录过程中推给界面的事件：pi 的原样事件（设备码、授权页地址、进度、说明），加上宿主自己的
 * 提问开 / 关 —— 提问必须能被用户回答，所以不能像别的事件那样只是一行文字。
 */
export type ProviderOAuthEvent =
  | AuthEvent
  | {
      type: 'prompt'
      promptId: string
      input: ProviderOAuthPromptInput
      message: string
      placeholder?: string
    }
  | { type: 'prompt_closed'; promptId: string }

export interface ProviderOAuthStatus {
  /** 该提供商是否支持订阅登录 */
  supported: boolean
  /** 支持时是哪一家（pi slug）—— 界面按它挑那家的说明文字；不支持时省略 */
  slug?: string
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
  /** 本机安装的稳定 ID（UUID）：只有要它的流程才会调（OpenAI），每次必须答同一个 */
  deviceId: () => string
}

/** 设置表里的安装 ID；没有就生成一个存下（只在本机，配置分享不导出设置表） */
function persistentDeviceId(): string {
  const stored = settingsDao.findByKey(DEVICE_ID_KEY)
  if (stored) return stored
  const id = randomUUID()
  settingsDao.upsert(DEVICE_ID_KEY, id)
  return id
}

const defaultDeps: ProviderOAuthDeps = {
  models: () => getModelRegistry().models,
  port: () => providerCredentialPort,
  publishChanged: () => appEventBus.publish({ type: 'providers.changed' }),
  deviceId: persistentDeviceId
}

/** 进行中的提问：答案经 `answerPrompt` 回来，或被流程自己中止 */
interface PendingPrompt {
  id: string
  resolve: (value: string) => void
  /** 收起：拒掉 pi 那边的 Promise，并告诉界面收起输入框 */
  close: (reason: Error) => void
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
  /** 进行中的提问（每个登录同一时刻至多一个），按 pi slug */
  private prompts = new Map<string, PendingPrompt>()

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
      slug,
      connected,
      expiresAt: connected ? expiresOf(this.deps.port().readOAuth(providerRowId)) : null,
      pending: this.logins.has(slug)
    }
  }

  /**
   * 走一遍登录并落库（落库由模型层的凭据库做，与刷新共用一条串行队列）。
   *
   * `notify` 收到 pi 的事件 —— 设备码流程是 `device_code`（用户码 + 验证链接），浏览器流程是
   * `auth_url` —— 调用方负责显示并打开浏览器；流程要用户输入时收到 `prompt`，答案经
   * `answerPrompt` 送回，不再需要时收到 `prompt_closed`。同一 provider 只允许一个登录在跑。
   *
   * 用户自己取消的那次带 `cancelled: true`：界面不该把 pi 的「Login cancelled」当成失败报红。
   */
  async login(
    providerRowId: string,
    notify: (event: ProviderOAuthEvent) => void
  ): Promise<{ success: boolean; error?: string; cancelled?: boolean }> {
    const slug = this.oauthSlugOf(providerRowId)
    if (!slug) return { success: false, error: `提供商 ${providerRowId} 不支持订阅登录` }
    if (this.logins.has(slug)) return { success: false, error: '该提供商已有登录流程在进行' }

    const controller = new AbortController()
    this.logins.set(slug, controller)
    try {
      await this.deps.models().login(
        slug,
        'oauth',
        {
          signal: controller.signal,
          notify,
          prompt: (p: AuthPrompt) => this.openPrompt(slug, p, notify)
        },
        { getDeviceId: this.deps.deviceId }
      )
      log.info(`${slug} 订阅登录成功`)
      // 列表里的登录状态要跟着变（与 providerService 各 mutator 同一条广播）
      this.deps.publishChanged()
      return { success: true }
    } catch (err) {
      const message = errorText(err)
      if (controller.signal.aborted) {
        log.info(`${slug} 订阅登录已取消`)
        return { success: false, error: message, cancelled: true }
      }
      log.warn(`${slug} 订阅登录失败: ${message}`)
      return { success: false, error: message }
    } finally {
      this.logins.delete(slug)
      // pi 自己会在收尾时中止它的提问；这里兜底，免得界面上留一个答了也没人收的输入框
      this.prompts.get(slug)?.close(new Error('登录已结束'))
    }
  }

  /**
   * 把 pi 的一次提问交给界面。只接「要一段文字」的三种：选择题（`select`）没有流程会问 ——
   * 真问了说明 pi-ai 换了流程，必须显式失败而不是给出一个界面答不了的问题、静默卡住。
   */
  private openPrompt(
    slug: string,
    prompt: AuthPrompt,
    notify: (event: ProviderOAuthEvent) => void
  ): Promise<string> {
    if (prompt.type === 'select') {
      return Promise.reject(new Error('订阅登录不支持选择题（收到 select 提问）'))
    }
    if (prompt.signal?.aborted) return Promise.reject(new Error('提问已取消'))
    // 同一登录不会并发提问；真有就让旧的那个让位，界面只显示最新的
    this.prompts.get(slug)?.close(new Error('提问已被新的提问取代'))

    return new Promise<string>((resolve, reject) => {
      const id = randomUUID()
      const onAbort = (): void => pending.close(new Error('提问已取消'))
      const settle = (): boolean => {
        if (this.prompts.get(slug) !== pending) return false
        this.prompts.delete(slug)
        prompt.signal?.removeEventListener('abort', onAbort)
        notify({ type: 'prompt_closed', promptId: id })
        return true
      }
      const pending: PendingPrompt = {
        id,
        resolve: (value) => {
          if (settle()) resolve(value)
        },
        close: (reason) => {
          if (settle()) reject(reason)
        }
      }
      this.prompts.set(slug, pending)
      prompt.signal?.addEventListener('abort', onAbort, { once: true })
      notify({
        type: 'prompt',
        promptId: id,
        input: prompt.type,
        message: prompt.message,
        ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {})
      })
    })
  }

  /**
   * 回答进行中的提问。提问已经不在（回调先到了、登录结束了、id 对不上）→ false，什么也不做：
   * 晚到的答案不能被当成下一个提问的答案。
   */
  answerPrompt(providerRowId: string, promptId: string, value: string): boolean {
    const slug = this.oauthSlugOf(providerRowId)
    const pending = slug ? this.prompts.get(slug) : undefined
    if (!pending || pending.id !== promptId) return false
    pending.resolve(value)
    return true
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
