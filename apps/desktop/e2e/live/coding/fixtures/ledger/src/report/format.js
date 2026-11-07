/** Format integer cents as dollars: 123456 → "$1,234.56", -435 → "-$4.35". */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const [whole, frac] = (Math.abs(cents) / 100).toFixed(2).split('.')
  return `${sign}$${groupThousands(whole)}.${frac}`
}

/** "1234567" → "1,234,567" */
export function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Left-align `label` and right-align `value` in a line `width` characters wide. */
export function columns(label, value, width = 28) {
  const gap = Math.max(1, width - label.length - value.length)
  return label + ' '.repeat(gap) + value
}
