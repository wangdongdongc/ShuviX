import { formatMoney, columns } from './format.js'

/** Totals per calendar month ("YYYY-MM"), oldest first. Dates are plain YYYY-MM-DD strings. */
export function groupByMonth(transactions) {
  const totals = new Map()
  for (const tx of transactions) {
    const month = tx.date.slice(0, 7)
    totals.set(month, (totals.get(month) ?? 0) + tx.amount)
  }
  return [...totals]
    .map(([month, total]) => ({ month, total }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

export function renderMonths(rows, currency = 'USD') {
  return rows.map((r) => columns(r.month, formatMoney(r.total, currency)))
}
