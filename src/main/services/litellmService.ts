import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { ModelCapabilities } from '../types'
import { createLogger } from '../logger'
import { getDataDir } from '../utils/paths'
const log = createLogger('LiteLLM')

/** LiteLLM 模型条目（仅提取需要的字段） */
interface LiteLLMModelEntry {
  litellm_provider?: string
  mode?: string
  max_input_tokens?: number
  max_output_tokens?: number
  max_tokens?: number
  input_cost_per_token?: number
  output_cost_per_token?: number
  supports_vision?: boolean
  supports_function_calling?: boolean
  supports_reasoning?: boolean
  supports_audio_input?: boolean
  supports_audio_output?: boolean
  supports_pdf_input?: boolean
  supported_output_modalities?: string[]
}

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const FETCH_TIMEOUT = 10_000

/** 常见 baseUrl 域名 → LiteLLM provider slug 映射 */
const BASE_URL_SLUG_MAP: Record<string, string> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'gemini',
  'api.deepseek.com': 'deepseek',
  'api.groq.com': 'groq',
  'api.mistral.ai': 'mistral',
  'api.together.xyz': 'together_ai',
  'api.fireworks.ai': 'fireworks_ai',
  'api.perplexity.ai': 'perplexity',
  'api.cohere.ai': 'cohere',
  'dashscope.aliyuncs.com': 'aliyun',
  'open.bigmodel.cn': 'zhipu',
  'api.moonshot.cn': 'moonshot',
  'api.minimax.chat': 'minimax',
  'api.siliconflow.cn': 'siliconflow',
  'ark.cn-beijing.volces.com': 'volcengine',
  'api.lingyiwanwu.com': 'yi'
}

/**
 * LiteLLM 模型数据缓存服务
 * 数据加载优先级：远程拉取 → 本地缓存 → 内置兜底文件
 */
class LiteLLMService {
  /** 内存中的模型数据（key → entry），仅保留 mode=chat 的条目 */
  private data: Map<string, LiteLLMModelEntry> = new Map()
  /** 反向索引：modelId（去除 provider/ 前缀后）→ 首个匹配的 entry */
  private modelIdIndex: Map<string, LiteLLMModelEntry> = new Map()
  private ready = false

  /** 本地缓存文件路径 */
  private get cachePath(): string {
    return join(getDataDir(), 'litellm-models.json')
  }

  /** 应用启动时调用，异步拉取 + 缓存（不阻塞主流程） */
  async init(): Promise<void> {
    try {
      const raw = await this.fetchFromRemote()
      this.parseAndLoad(raw)
      // 拉取成功，写入缓存
      this.writeCache(raw)
      log.info(`远程拉取成功，已加载 ${this.data.size} 个 chat 模型`)
    } catch (err) {
      log.warn(`远程拉取失败，尝试加载本地缓存: ${(err as Error).message}`)
      if (!this.loadFromCache()) {
        this.loadFromBundled()
      }
    }
    this.ready = true
  }

  /** 是否已加载数据 */
  isReady(): boolean {
    return this.ready
  }

  /**
   * 根据 modelId 查找模型能力
   * 四级匹配链：
   *   1) 直接匹配 modelId
   *   2) providerSlug + modelId 前缀匹配
   *   3) baseUrl 推断 slug + modelId 前缀匹配
   *   4) 反向索引后缀匹配（兜底）
   */
  getModelCapabilities(modelId: string, providerSlug?: string, baseUrl?: string): ModelCapabilities | null {
    // 策略 1：直接匹配
    let entry = this.data.get(modelId)

    // 策略 2：providerSlug 前缀匹配
    if (!entry && providerSlug) {
      entry = this.data.get(`${providerSlug}/${modelId}`)
    }

    // 策略 3：baseUrl 推断 slug 后前缀匹配
    if (!entry && baseUrl) {
      const inferredSlug = this.inferSlugFromBaseUrl(baseUrl)
      if (inferredSlug && inferredSlug !== providerSlug) {
        entry = this.data.get(`${inferredSlug}/${modelId}`)
      }
    }

    // 策略 4：反向索引后缀匹配（兜底）
    if (!entry) {
      entry = this.modelIdIndex.get(modelId)
    }

    if (!entry) return null

    return this.entryToCapabilities(entry)
  }

  /** 从 baseUrl 推断 LiteLLM provider slug */
  private inferSlugFromBaseUrl(baseUrl: string): string | null {
    try {
      const hostname = new URL(baseUrl).hostname
      // 精确匹配
      if (BASE_URL_SLUG_MAP[hostname]) return BASE_URL_SLUG_MAP[hostname]
      // 模糊匹配：检查域名是否包含某个已知关键字
      for (const [domain, slug] of Object.entries(BASE_URL_SLUG_MAP)) {
        if (hostname.includes(domain.split('.')[0])) return slug
      }
    } catch { /* 无效 URL */ }
    return null
  }

  /** 将 LiteLLM 条目转换为 ModelCapabilities */
  private entryToCapabilities(entry: LiteLLMModelEntry): ModelCapabilities {
    const caps: ModelCapabilities = {}

    if (entry.supports_vision != null) caps.vision = entry.supports_vision
    if (entry.supports_function_calling != null) caps.functionCalling = entry.supports_function_calling
    if (entry.supports_reasoning != null) caps.reasoning = entry.supports_reasoning
    if (entry.supports_audio_input != null) caps.audioInput = entry.supports_audio_input
    if (entry.supports_audio_output != null) caps.audioOutput = entry.supports_audio_output
    if (entry.supports_pdf_input != null) caps.pdfInput = entry.supports_pdf_input

    // 图像输出：检查 supported_output_modalities 是否包含 'image'
    if (entry.supported_output_modalities?.includes('image')) {
      caps.imageOutput = true
    }

    // token 限制
    if (entry.max_input_tokens != null) caps.maxInputTokens = entry.max_input_tokens
    if (entry.max_output_tokens != null) {
      caps.maxOutputTokens = entry.max_output_tokens
    } else if (entry.max_tokens != null) {
      caps.maxOutputTokens = entry.max_tokens
    }

    // 定价
    if (entry.input_cost_per_token != null) caps.inputCostPerToken = entry.input_cost_per_token
    if (entry.output_cost_per_token != null) caps.outputCostPerToken = entry.output_cost_per_token

    return caps
  }

  /** 从远程拉取 JSON 原始文本 */
  private async fetchFromRemote(): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
    try {
      const res = await fetch(LITELLM_URL, { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } finally {
      clearTimeout(timer)
    }
  }

  /** 解析 JSON 文本并加载到内存（仅保留 mode=chat），同时构建反向索引 */
  private parseAndLoad(raw: string): void {
    const json = JSON.parse(raw) as Record<string, LiteLLMModelEntry>
    this.data.clear()
    this.modelIdIndex.clear()
    for (const [key, entry] of Object.entries(json)) {
      if (key === 'sample_spec') continue
      // 仅保留 chat 模式的模型
      if (entry.mode === 'chat') {
        this.data.set(key, entry)
        // 构建反向索引：提取 provider/modelId 中的 modelId 部分
        const slashIdx = key.indexOf('/')
        const bareModelId = slashIdx >= 0 ? key.slice(slashIdx + 1) : key
        // 仅保留首次出现（优先级最高的条目）
        if (!this.modelIdIndex.has(bareModelId)) {
          this.modelIdIndex.set(bareModelId, entry)
        }
      }
    }
  }

  /** 写入本地缓存文件 */
  private writeCache(raw: string): void {
    try {
      writeFileSync(this.cachePath, raw, 'utf-8')
    } catch (err) {
      log.warn(`写入缓存失败: ${(err as Error).message}`)
    }
  }

  /** 内置兜底文件路径（resources/litellm-models.json） */
  private get bundledPath(): string {
    if (is.dev) {
      // 开发模式：项目根目录 resources/
      return join(app.getAppPath(), 'resources', 'litellm-models.json')
    }
    // 生产模式：打包后 process.resourcesPath
    return join(process.resourcesPath, 'litellm-models.json')
  }

  /** 从本地缓存文件加载，成功返回 true */
  private loadFromCache(): boolean {
    try {
      if (!existsSync(this.cachePath)) {
        log.warn('无本地缓存文件')
        return false
      }
      const raw = readFileSync(this.cachePath, 'utf-8')
      this.parseAndLoad(raw)
      log.info(`从本地缓存加载 ${this.data.size} 个 chat 模型`)
      return true
    } catch (err) {
      log.warn(`加载缓存失败: ${(err as Error).message}`)
      return false
    }
  }

  /** 从内置兜底文件加载 */
  private loadFromBundled(): void {
    try {
      const path = this.bundledPath
      if (!existsSync(path)) {
        log.warn(`内置兜底文件不存在: ${path}`)
        return
      }
      const raw = readFileSync(path, 'utf-8')
      this.parseAndLoad(raw)
      log.info(`从内置兜底文件加载 ${this.data.size} 个 chat 模型`)
    } catch (err) {
      log.warn(`加载内置文件失败: ${(err as Error).message}`)
    }
  }
}

export const litellmService = new LiteLLMService()
