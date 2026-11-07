import { available } from '../domain/items.js'

function fieldValue(item, field) {
  return field === 'available' ? available(item) : item[field]
}

function matchNode(node, item) {
  switch (node.kind) {
    case 'and':
      return node.terms.every((t) => matchNode(t, item))
    case 'or':
      return node.terms.some((t) => matchNode(t, item))
    case 'not':
      return !matchNode(node.term, item)
    case 'text':
      return (
        item.sku.toLowerCase().includes(node.value) || item.name.toLowerCase().includes(node.value)
      )
    case 'match':
      return node.pattern.test(String(fieldValue(item, node.field) ?? ''))
    case 'compare': {
      const v = fieldValue(item, node.field)
      switch (node.op) {
        case '=':
          return v === node.value
        case '>':
          return v > node.value
        case '>=':
          return v >= node.value
        case '<':
          return v < node.value
        case '<=':
          return v <= node.value
      }
      return false
    }
  }
  return false
}

/** Does `item` match a parsed query? (An empty query matches everything.) */
export function matches(query, item) {
  return Array.isArray(query) ? query.every((t) => matchNode(t, item)) : matchNode(query, item)
}
