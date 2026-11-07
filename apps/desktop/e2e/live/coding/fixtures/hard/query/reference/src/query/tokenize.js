import { invalid } from '../errors.js'

/**
 * Split a query into tokens: '(' , ')' and words. Whitespace separates words; a double-quoted part
 * ("Aisle 3") stays inside its word, quotes included, and parentheses inside quotes are literal.
 * Inside quotes \" is a literal quote. parse.js takes the quotes off.
 */
export function tokenize(query) {
  const tokens = []
  let current = ''
  let quotedWord = false
  let inQuotes = false
  const endWord = () => {
    if (current) tokens.push({ type: 'word', text: current, quoted: quotedWord })
    current = ''
    quotedWord = false
  }
  for (let i = 0; i < query.length; i++) {
    const c = query[i]
    if (inQuotes) {
      if (c === '\\' && i + 1 < query.length) {
        current += c + query[++i]
        continue
      }
      if (c === '"') inQuotes = false
      current += c
      continue
    }
    if (c === '"') {
      inQuotes = true
      quotedWord = true
      current += c
    } else if (c === '(' || c === ')') {
      endWord()
      tokens.push({ type: c, text: c })
    } else if (/\s/.test(c)) {
      endWord()
    } else {
      current += c
    }
  }
  if (inQuotes) throw invalid('unterminated quote in query', { field: 'q' })
  endWord()
  return tokens
}

/** Kept for callers that only need the words. */
export function splitTerms(query) {
  return tokenize(query)
    .filter((t) => t.type === 'word')
    .map((t) => t.text)
}

/** `"Aisle 3"` → `Aisle 3`, `say \"hi\"` → `say "hi"`; unquoted text comes back as is. */
export function unquote(text) {
  if (!text.includes('"')) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\' && text[i + 1] === '"') {
      out += '"'
      i++
    } else if (c !== '"') {
      out += c
    }
  }
  return out
}
