import { parseArgs } from './args.js'
import { loadTransactions } from '../store/load.js'
import { summarizeByCategory, renderSummary } from '../report/summary.js'
import { groupByMonth, renderMonths } from '../report/months.js'
import { loadBudgets, latestMonth, computeBudget, renderBudget } from '../report/budget.js'

const USAGE = [
  'usage: ledger <command> <file.csv> [options]',
  '',
  'commands:',
  '  report   totals per category',
  '  months   totals per month',
  '  budget   <file.csv> <budgets.json> [--month YYYY-MM]   spending against budgets'
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

  let transactions
  try {
    transactions = loadTransactions(file)
  } catch (err) {
    io.stderr(`ledger: ${err.message}`)
    return 1
  }

  switch (command) {
    case 'report':
      renderSummary(summarizeByCategory(transactions)).forEach((line) => io.stdout(line))
      return 0
    case 'months':
      renderMonths(groupByMonth(transactions)).forEach((line) => io.stdout(line))
      return 0
    case 'budget': {
      const budgetsFile = positionals[2]
      if (!budgetsFile) {
        io.stderr('ledger budget: missing <budgets.json>')
        return 1
      }
      let budgets
      try {
        budgets = loadBudgets(budgetsFile)
      } catch (err) {
        io.stderr(`ledger: ${err.message}`)
        return 1
      }
      const month = typeof flags.month === 'string' ? flags.month : latestMonth(transactions)
      renderBudget(computeBudget(transactions, budgets, month)).forEach((line) => io.stdout(line))
      return 0
    }
    default:
      io.stderr(`ledger: unknown command "${command}"`)
      return 1
  }
}
