/**
 * Parse an amount as written in the bank export ("12.50", "-3", "$1,204.99") into integer cents.
 * Throws on anything that is not a number with at most two decimals.
 */
const AMOUNT = /^-?\d+(\.\d{1,2})?$/

export function parseAmount(text) {
  const cleaned = String(text).trim().replace(/[$,]/g, '')
  if (!AMOUNT.test(cleaned)) {
    throw new Error(`not an amount: "${text}"`)
  }
  return Math.round(Number(cleaned) * 100)
}
