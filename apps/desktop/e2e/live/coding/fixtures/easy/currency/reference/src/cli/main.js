import { parseArgs } from './args.js'
import { loadTransactions } from '../store/load.js'
import { summarizeByCategory, renderSummary } from '../report/summary.js'
import { groupByMonth, renderMonths } from '../report/months.js'
import { CURRENCY_CODES } from '../report/format.js'

const USAGE = [
  'usage: ledger <command> <file.csv> [options]',
  '',
  'commands:',
  '  report   totals per category (--currency USD|EUR|JPY)',
  '  months   totals per month'
]

/**
 * Run one CLI invocation. `io.stdout` / `io.stderr` take one line each.
 * Returns the process exit code.
 */
export function run(argv, io) {
  const { positionals, flags } = parseArgs(argv)
  const [command, file] = positionals
  if (flags.help) {
    USAGE.forEach((line) => io.stdout(line))
    return 0
  }
  if (!command) {
    USAGE.forEach((line) => io.stderr(line))
    return 1
  }
  if (!file) {
    io.stderr(`ledger ${command}: missing <file.csv>`)
    return 1
  }

  const currency = flags.currency === undefined ? 'USD' : String(flags.currency).toUpperCase()
  if (!CURRENCY_CODES.includes(currency)) {
    io.stderr(
      `ledger: unknown currency "${flags.currency}" (supported: ${CURRENCY_CODES.join(', ')})`
    )
    return 1
  }

  let transactions
  try {
    transactions = loadTransactions(file)
  } catch (err) {
    io.stderr(`ledger: ${err.message}`)
    return 1
  }

  switch (command) {
    case 'report':
      renderSummary(summarizeByCategory(transactions), currency).forEach((line) => io.stdout(line))
      return 0
    case 'months':
      renderMonths(groupByMonth(transactions), currency).forEach((line) => io.stdout(line))
      return 0
    default:
      io.stderr(`ledger: unknown command "${command}"`)
      return 1
  }
}
