import { formatCents, columns } from './format.js'

/** "YYYY-MM" for a transaction date */
function monthOf(date) {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Totals per calendar month ("YYYY-MM"), oldest first. */
export function groupByMonth(transactions) {
  const totals = new Map()
  for (const tx of transactions) {
    const month = monthOf(tx.date)
    totals.set(month, (totals.get(month) ?? 0) + tx.amount)
  }
  return [...totals]
    .map(([month, total]) => ({ month, total }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

export function renderMonths(rows) {
  return rows.map((r) => columns(r.month, formatCents(r.total)))
}
