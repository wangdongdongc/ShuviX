import { invalid } from '../errors.js'
import { tokenize, unquote } from './tokenize.js'

export const FIELDS = {
  sku: 'text',
  name: 'text',
  category: 'text',
  location: 'text',
  onHand: 'number',
  reserved: 'number',
  available: 'number',
  reorderPoint: 'number'
}

const TERM = /^([A-Za-z]+)(>=|<=|:|>|<)(.*)$/s
const KEYWORDS = new Set(['AND', 'OR', 'NOT'])

/**
 * Parse a query into a tree (see evaluate.js):
 *   { kind: 'or' | 'and', terms: [...] }, { kind: 'not', term }
 *   leaves: { kind: 'text', value }, { kind: 'match', field, pattern }, { kind: 'compare', field, op, value }
 *
 *   query := and ('OR' and)*
 *   and   := unary (['AND'] unary)*      (side by side means AND)
 *   unary := 'NOT' unary | '(' query ')' | term
 *
 * AND / OR / NOT are keywords only in upper case and unquoted; anything else is a term.
 */
export function parseQuery(query) {
  const tokens = tokenize(String(query ?? '').trim())
  if (tokens.length === 0) return { kind: 'and', terms: [] }
  let pos = 0
  const peek = () => tokens[pos]
  const isKeyword = (t, word) => t?.type === 'word' && !t.quoted && t.text === word
  const fail = (message) => {
    throw invalid(message, { field: 'q', position: pos })
  }

  function parseOr() {
    const terms = [parseAnd()]
    while (isKeyword(peek(), 'OR')) {
      pos++
      if (!startsUnary(peek())) fail('OR needs a term on both sides')
      terms.push(parseAnd())
    }
    return terms.length === 1 ? terms[0] : { kind: 'or', terms }
  }

  function startsUnary(t) {
    if (!t) return false
    if (t.type === '(') return true
    if (t.type !== 'word') return false
    return t.quoted || !KEYWORDS.has(t.text) || t.text === 'NOT'
  }

  function parseAnd() {
    if (!startsUnary(peek())) fail(peek() ? `unexpected "${peek().text}"` : 'query ends too early')
    const terms = [parseUnary()]
    for (;;) {
      if (isKeyword(peek(), 'AND')) {
        pos++
        if (!startsUnary(peek())) fail('AND needs a term on both sides')
      } else if (!startsUnary(peek())) {
        break
      }
      terms.push(parseUnary())
    }
    return terms.length === 1 ? terms[0] : { kind: 'and', terms }
  }

  function parseUnary() {
    const t = peek()
    if (isKeyword(t, 'NOT')) {
      pos++
      if (!startsUnary(peek())) fail('NOT needs a term after it')
      return { kind: 'not', term: parseUnary() }
    }
    if (t.type === '(') {
      pos++
      if (peek()?.type === ')') fail('empty parentheses')
      const inner = parseOr()
      if (peek()?.type !== ')') fail('missing ")"')
      pos++
      return inner
    }
    pos++
    return parseTerm(t)
  }

  const tree = parseOr()
  if (pos < tokens.length) fail(`unexpected "${peek().text}"`)
  return tree
}

function parseTerm(token) {
  const raw = token.text
  const m = raw.match(TERM)
  if (!m || raw.startsWith('"')) return { kind: 'text', value: unquote(raw).toLowerCase() }
  const [, field, op, rawValue] = m
  const type = FIELDS[field]
  if (!type) throw invalid(`unknown field "${field}"`, { field: 'q', term: raw })
  const value = unquote(rawValue)
  if (type === 'number') {
    const n = Number(value)
    if (value.trim() === '' || !Number.isFinite(n)) {
      throw invalid(`"${field}" needs a number, got "${value}"`, { field: 'q', term: raw })
    }
    return { kind: 'compare', field, op: op === ':' ? '=' : op, value: n }
  }
  if (op !== ':') throw invalid(`"${field}" only supports ":"`, { field: 'q', term: raw })
  return { kind: 'match', field, pattern: globToRegExp(value) }
}

function globToRegExp(glob) {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}$`, 'is')
}
