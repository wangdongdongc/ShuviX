import { useCallback, useEffect, useState } from 'react'
import type { HistorySuggestion } from '../../../../shared/browserHistory'
import { searchSuggestAllowed, type SearchEngineId } from '../../../../shared/browserSearchEngines'

/** 搜索建议要等用户停手多久再问（每个键都问一次太密） */
const SEARCH_DEBOUNCE_MS = 120

/**
 * 地址栏下拉建议的两路数据：主进程的历史候选（本机，每个键都问）与搜索引擎的建议（停手一小会儿再问，
 * 主进程按设置与输入决定送不送）。`text` 为空 = 不在打字，两路都给空。
 *
 * 回来的结果留到下一次结果到达为止（哪怕是上一段输入的）：组件按当前输入重新过滤、排序
 * （omniboxSuggest.ts），打字时列表不会每个键闪一下空。晚到的旧结果直接丢掉。
 */
export function useOmniboxSuggestions(
  text: string,
  engine: SearchEngineId,
  searchEnabled: boolean
): {
  history: HistorySuggestion[]
  search: string[]
  /** 从历史里删掉一个网址（Shift+Delete / ×）：当场从列表里拿掉，再问一次 */
  removeHistory: (url: string) => void
} {
  const [history, setHistory] = useState<HistorySuggestion[]>([])
  const [search, setSearch] = useState<string[]>([])
  const [nonce, setNonce] = useState(0)
  const query = text.trim()

  useEffect(() => {
    if (!query) return
    let cancelled = false
    void window.api.browserHistory
      .suggest(text)
      .then((rows) => {
        if (!cancelled) setHistory(rows)
      })
      .catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    if (searchEnabled && searchSuggestAllowed(query)) {
      timer = setTimeout(() => {
        void window.api.browserHistory
          .searchSuggest(query, engine)
          .then((items) => {
            if (!cancelled) setSearch(items)
          })
          .catch(() => {})
      }, SEARCH_DEBOUNCE_MS)
    }
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [text, query, engine, searchEnabled, nonce])

  const removeHistory = useCallback((url: string) => {
    setHistory((rows) => rows.filter((r) => r.url !== url))
    void window.api.browserHistory
      .removeUrl(url)
      .catch(() => {})
      .finally(() => setNonce((n) => n + 1))
  }, [])

  return {
    history: query ? history : [],
    search: query && searchEnabled ? search : [],
    removeHistory
  }
}
