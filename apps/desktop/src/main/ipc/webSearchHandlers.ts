import { defineHandler } from './registry'
import {
  deleteWebSearchKey,
  setWebSearchKey,
  testWebSearchProvider,
  webSearchConfig
} from '../services/webSearchApiService'

/**
 * `web_search` 的搜索方式设置（设置 → LLM 工具 → web_search）。选哪种方式是普通设置项（`webSearch.provider`，
 * 经 settings:set）；这里管的是密钥：只进不出，交回界面的只有「存没存」和末四位。
 */
export function registerWebSearchHandlers(): void {
  defineHandler('webSearch:config', () => webSearchConfig())
  defineHandler('webSearch:setKey', (_ctx, params: { provider: string; apiKey: string }) =>
    setWebSearchKey(params?.provider, params?.apiKey)
  )
  defineHandler('webSearch:deleteKey', (_ctx, provider: string) => deleteWebSearchKey(provider))
  /** 用存着的密钥真的搜一次（花一次额度） */
  defineHandler('webSearch:test', (_ctx, provider: string) => testWebSearchProvider(provider))
}
