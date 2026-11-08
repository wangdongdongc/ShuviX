import { available } from '../domain/items.js'

function fieldValue(item, field) {
  return field === 'available' ? available(item) : item[field]
}

function matchTerm(term, item) {
  switch (term.kind) {
    case 'text':
      return (
        item.sku.toLowerCase().includes(term.value) || item.name.toLowerCase().includes(term.value)
      )
    case 'tag':
      return (item.tags ?? []).some((tag) => term.pattern.test(tag))
    case 'match':
      return term.pattern.test(String(fieldValue(item, term.field) ?? ''))
    case 'compare': {
      const v = fieldValue(item, term.field)
      switch (term.op) {
        case '=':
          return v === term.value
        case '>':
          return v > term.value
        case '>=':
          return v >= term.value
        case '<':
          return v < term.value
        case '<=':
          return v <= term.value
      }
      return false
    }
  }
  return false
}

/** Does `item` match every term of a parsed query? (An empty query matches everything.) */
export function matches(terms, item) {
  return terms.every((term) => matchTerm(term, item))
}
