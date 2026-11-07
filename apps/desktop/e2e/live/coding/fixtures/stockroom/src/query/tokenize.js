import { invalid } from '../errors.js'

/**
 * Split a query into raw terms on whitespace. A double-quoted part ("Aisle 3") stays inside its term,
 * quotes included; inside quotes \" is a literal quote. parse.js takes the quotes off.
 */
export function splitTerms(query) {
  const terms = []
  let current = ''
  let quoted = false
  for (let i = 0; i < query.length; i++) {
    const c = query[i]
    if (quoted) {
      if (c === '\\' && i + 1 < query.length) {
        current += c + query[++i]
        continue
      }
      if (c === '"') quoted = false
      current += c
      continue
    }
    if (c === '"') {
      quoted = true
      current += c
    } else if (/\s/.test(c)) {
      if (current) terms.push(current)
      current = ''
    } else {
      current += c
    }
  }
  if (quoted) throw invalid('unterminated quote in query', { field: 'q' })
  if (current) terms.push(current)
  return terms
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
