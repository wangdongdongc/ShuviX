import { readFileSync } from 'node:fs'
import { parseCsv } from '../parse/csv.js'
import { parseAmount } from '../parse/amount.js'
import { makeTransaction } from '../model/transaction.js'

const COLUMNS = ['date', 'description', 'amount', 'category']

/** Read a bank CSV export (with a header row) into transactions. */
export function loadTransactions(file) {
  return parseTransactions(readFileSync(file, 'utf8'), file)
}

export function parseTransactions(text, source = '<input>') {
  const [header, ...rows] = parseCsv(text)
  if (!header) return []
  const index = {}
  header.forEach((name, i) => (index[name.trim().toLowerCase()] = i))
  for (const col of COLUMNS) {
    if (index[col] === undefined) throw new Error(`${source}: missing column "${col}"`)
  }
  return rows.map((row, n) => {
    try {
      return makeTransaction({
        date: row[index.date],
        description: row[index.description],
        amount: parseAmount(row[index.amount]),
        category: row[index.category]
      })
    } catch (err) {
      throw new Error(`${source}:${n + 2}: ${err.message}`)
    }
  })
}
