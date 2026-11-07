import { formatCents, columns } from './format.js'

/** Totals per category, largest first; ties by name. */
export function summarizeByCategory(transactions) {
  const totals = new Map()
  for (const tx of transactions) {
    totals.set(tx.category, (totals.get(tx.category) ?? 0) + tx.amount)
  }
  return [...totals]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category))
}

export function renderSummary(rows) {
  const total = rows.reduce((sum, r) => sum + r.total, 0)
  return [
    ...rows.map((r) => columns(r.category, formatCents(r.total))),
    columns('TOTAL', formatCents(total))
  ]
}
