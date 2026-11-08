import { invalid } from '../errors.js'
import { splitTerms, unquote } from './tokenize.js'

export const FIELDS = {
  sku: 'text',
  name: 'text',
  category: 'text',
  location: 'text',
  onHand: 'number',
  reserved: 'number',
  available: 'number',
  reorderPoint: 'number',
  price: 'number'
}

const TERM = /^([A-Za-z]+)(>=|<=|:|>|<)(.*)$/s

/**
 * Parse a query into a list of terms; an item matches when every term matches (see evaluate.js).
 * Term shapes:
 *   { kind: 'text', value }                    bare word: sku or name contains value
 *   { kind: 'match', field, pattern }          text field equals (with * wildcards)
 *   { kind: 'compare', field, op, value }      number field, op one of = > >= < <=
 */
export function parseQuery(query) {
  return splitTerms(String(query ?? '').trim()).map(parseTerm)
}

function parseTerm(raw) {
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
