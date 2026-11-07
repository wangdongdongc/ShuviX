const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Validate and normalise one transaction. `amount` is integer cents. */
export function makeTransaction({ date, description, amount, category }) {
  if (!DATE.test(date ?? '')) throw new Error(`bad date: "${date}"`)
  if (!Number.isInteger(amount)) throw new Error(`amount must be integer cents, got ${amount}`)
  return {
    date,
    description: (description ?? '').trim(),
    amount,
    category: (category || 'uncategorized').trim().toLowerCase()
  }
}
