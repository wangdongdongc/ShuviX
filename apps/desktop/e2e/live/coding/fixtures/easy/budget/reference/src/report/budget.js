import { readFileSync } from 'node:fs'
import { formatCents } from './format.js'

/** Read budgets.json ({ category: dollars }) into a Map of category → cents. Throws on bad input. */
export function loadBudgets(file) {
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file}: ${err.message}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file}: expected an object of category → amount`)
  }
  const budgets = new Map()
  for (const [category, value] of Object.entries(data)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${file}: budget for "${category}" is not a number`)
    }
    budgets.set(category.trim().toLowerCase(), Math.round(value * 100))
  }
  return budgets
}

/** The latest "YYYY-MM" among the transactions, or undefined when there are none. */
export function latestMonth(transactions) {
  return transactions
    .reduce((m, tx) => (m === undefined || tx.date > m ? tx.date : m), undefined)
    ?.slice(0, 7)
}

/** One row per budgeted category (sorted by name) for `month`, all amounts in cents. */
export function computeBudget(transactions, budgets, month) {
  const spent = new Map()
  for (const tx of transactions) {
    if (tx.date.slice(0, 7) !== month) continue
    spent.set(tx.category, (spent.get(tx.category) ?? 0) + tx.amount)
  }
  return [...budgets.keys()].sort().map((category) => {
    const budget = budgets.get(category)
    const used = spent.get(category) ?? 0
    return { category, spent: used, budget, remaining: budget - used }
  })
}

export function renderBudget(rows) {
  const total = rows.reduce(
    (t, r) => ({
      spent: t.spent + r.spent,
      budget: t.budget + r.budget,
      remaining: t.remaining + r.remaining
    }),
    { spent: 0, budget: 0, remaining: 0 }
  )
  const line = (label, r, over) =>
    [
      label.padEnd(14),
      formatCents(r.spent).padStart(12),
      formatCents(r.budget).padStart(12),
      formatCents(r.remaining).padStart(12),
      over ? ' OVER' : ''
    ].join('')
  return [...rows.map((r) => line(r.category, r, r.remaining < 0)), line('TOTAL', total, false)]
}
