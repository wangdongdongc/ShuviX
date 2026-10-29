import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Globe, Search, X } from 'lucide-react'
import { displayUrlOf, historyQueryWords } from '../../../../shared/browserHistory'
import { SEARCH_ENGINES, type SearchEngineId } from './omnibox'
import type { OmniboxMatch } from './omniboxSuggest'

/**
 * 地址栏下面的建议列表（Chrome 的 omnibox popup）。只管画和鼠标：选中哪一行、键盘怎么走、回车开什么都在
 * Omnibox 里。行上 mousedown 一律 preventDefault —— 焦点留在地址栏，点完才由 Omnibox 决定去哪儿。
 *
 * 它是 DOM 弹层，会落在页面区上方；原生页面画在 DOM 之上，所以开着的时候页面区换成截图（store 的 pageCover，
 * 由 Omnibox 先抓好再打开），与站点信息气泡同一个机制。
 */
export function OmniboxPopup({
  id,
  matches,
  selected,
  text,
  engine,
  onPick,
  onRemove
}: {
  id: string
  matches: OmniboxMatch[]
  selected: number
  /** 用户敲的字（加粗用） */
  text: string
  engine: SearchEngineId
  onPick: (index: number) => void
  onRemove: (index: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const words = historyQueryWords(text)
  return (
    <div
      id={id}
      role="listbox"
      aria-label={t('browser.omnibox.suggestions')}
      className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 py-1.5 rounded-xl bg-bg-primary border border-border-secondary/60 shadow-lg overflow-hidden"
      data-omnibox-popup
    >
      {matches.map((match, index) => (
        <div
          key={match.key}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === selected}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(index)}
          className={`group flex items-center gap-3 h-8 px-3 cursor-default text-[13px] ${
            index === selected ? 'bg-bg-hover' : 'hover:bg-bg-hover/60'
          }`}
          data-omnibox-match={match.kind}
          data-omnibox-key={match.key}
          data-selected={index === selected ? 'true' : undefined}
        >
          <MatchIcon match={match} />
          <span className="flex-1 min-w-0 truncate">
            <MatchText match={match} words={words} text={text} engine={engine} />
          </span>
          {match.kind === 'tab' && (
            <span
              className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full border border-border-secondary/60 text-[11px] text-text-secondary"
              data-omnibox-switch
            >
              {t('browser.omnibox.switchToTab')}
              <ArrowRight size={11} />
            </span>
          )}
          {match.kind === 'history' && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation()
                onRemove(index)
              }}
              className={`flex-shrink-0 p-0.5 rounded-full text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary ${
                index === selected ? '' : 'invisible group-hover:visible'
              }`}
              title={t('browser.omnibox.remove')}
              aria-label={t('browser.omnibox.remove')}
              data-omnibox-remove
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function MatchIcon({ match }: { match: OmniboxMatch }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (match.kind === 'search') {
    return <Search size={14} className="flex-shrink-0 text-text-tertiary" />
  }
  if (match.favicon && !failed) {
    return (
      <img
        src={match.favicon}
        alt=""
        draggable={false}
        className="flex-shrink-0 w-[14px] h-[14px]"
        onError={() => setFailed(true)}
      />
    )
  }
  return <Globe size={14} className="flex-shrink-0 text-text-tertiary" />
}

/** 把 words 在 text 里出现的地方加粗（不分大小写） */
function Highlighted({ text, words }: { text: string; words: string[] }): React.JSX.Element {
  const lower = text.toLowerCase()
  const marks = new Array<boolean>(text.length).fill(false)
  for (const w of words) {
    let from = 0
    for (;;) {
      const i = lower.indexOf(w, from)
      if (i < 0) break
      for (let k = i; k < i + w.length && k < marks.length; k++) marks[k] = true
      from = i + Math.max(1, w.length)
    }
  }
  const parts: Array<{ text: string; bold: boolean }> = []
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1]
    if (last && last.bold === marks[i]) last.text += text[i]
    else parts.push({ text: text[i], bold: marks[i] })
  }
  return (
    <>
      {parts.map((p, i) =>
        p.bold ? (
          <b key={i} className="font-semibold">
            {p.text}
          </b>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}

function MatchText({
  match,
  words,
  text,
  engine
}: {
  match: OmniboxMatch
  words: string[]
  text: string
  engine: SearchEngineId
}): React.JSX.Element {
  const { t } = useTranslation()
  const dash = <span className="text-text-tertiary"> — </span>
  switch (match.kind) {
    case 'search': {
      const query = match.query
      // 搜索建议：照 Chrome，敲过的那段正常、补出来的加粗
      const typed = query.toLowerCase().startsWith(text.trim().toLowerCase())
        ? query.slice(0, text.trim().length)
        : ''
      return (
        <>
          {match.suggested ? (
            <>
              <span>{typed}</span>
              <b className="font-semibold">{query.slice(typed.length)}</b>
            </>
          ) : (
            <span>{query}</span>
          )}
          {!match.suggested && (
            <>
              {dash}
              <span className="text-text-tertiary">
                {t('browser.omnibox.searchWith', { engine: SEARCH_ENGINES[engine].name })}
              </span>
            </>
          )}
        </>
      )
    }
    case 'url':
      return (
        <>
          <span className="text-text-primary">
            <Highlighted text={displayUrlOf(match.url)} words={words} />
          </span>
          {match.title && (
            <>
              {dash}
              <span className="text-text-tertiary">{match.title}</span>
            </>
          )}
        </>
      )
    case 'history':
      return (
        <>
          <span className="text-text-primary">
            <Highlighted text={displayUrlOf(match.url)} words={words} />
          </span>
          {match.title && (
            <>
              {dash}
              <span className="text-text-tertiary">
                <Highlighted text={match.title} words={words} />
              </span>
            </>
          )}
        </>
      )
    case 'tab':
      return (
        <>
          <span className="text-text-primary">
            <Highlighted text={match.title || displayUrlOf(match.url)} words={words} />
          </span>
          {match.title && (
            <>
              {dash}
              <span className="text-text-tertiary">
                <Highlighted text={displayUrlOf(match.url)} words={words} />
              </span>
            </>
          )}
        </>
      )
  }
}
