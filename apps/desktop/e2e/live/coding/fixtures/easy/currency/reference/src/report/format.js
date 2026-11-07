const CURRENCIES = {
  USD: { symbol: '$', thousands: ',', decimal: '.', digits: 2 },
  EUR: { symbol: '€', thousands: '.', decimal: ',', digits: 2 },
  JPY: { symbol: '¥', thousands: ',', decimal: '', digits: 0 }
}

export const CURRENCY_CODES = Object.keys(CURRENCIES)

/** Format integer cents in one of CURRENCY_CODES: 123456 → "$1,234.56" / "€1.234,56" / "¥1,235". */
export function formatMoney(cents, currency = 'USD') {
  const spec = CURRENCIES[currency]
  if (!spec) {
    throw new Error(`unknown currency "${currency}" (supported: ${CURRENCY_CODES.join(', ')})`)
  }
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  if (spec.digits === 0) {
    return `${sign}${spec.symbol}${groupThousands(String(Math.round(abs / 100)), spec.thousands)}`
  }
  const [whole, frac] = (abs / 100).toFixed(2).split('.')
  return `${sign}${spec.symbol}${groupThousands(whole, spec.thousands)}${spec.decimal}${frac}`
}

/** Format integer cents as dollars: 123456 → "$1,234.56", -435 → "-$4.35". */
export function formatCents(cents) {
  return formatMoney(cents, 'USD')
}

/** "1234567" → "1,234,567" */
export function groupThousands(digits, separator = ',') {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator)
}

/** Left-align `label` and right-align `value` in a line `width` characters wide. */
export function columns(label, value, width = 28) {
  const gap = Math.max(1, width - label.length - value.length)
  return label + ' '.repeat(gap) + value
}
