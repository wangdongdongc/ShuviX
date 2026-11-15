/**
 * 会话列表行尾的时间（手机布局的会话列表，照 iOS Mail 的邮件列表）：今天写时分，昨天写「昨天」，
 * 一周之内写星期几，更早写月-日，不是今年再带上年份。
 *
 * `now` 由调用方给（列表挂上那一刻的钟），`yesterday` 是那一种语言里的「昨天」，`locale` 定星期几怎么写。
 */
export function listTimeLabel(
  at: number,
  now: number,
  opts: { yesterday: string; locale?: string }
): string {
  const d = new Date(at)
  const today = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const dayStart = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  // 按日历日算相差几天（夏令时那天一天不是 24 小时，四舍五入）
  const days = Math.round((dayStart(today) - dayStart(d)) / 86_400_000)
  if (days <= 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (days === 1) return opts.yesterday
  if (days < 7) {
    try {
      return new Intl.DateTimeFormat(opts.locale, { weekday: 'short' }).format(d)
    } catch {
      // 认不得的语言标记：落到月-日
    }
  }
  const monthDay = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return d.getFullYear() === today.getFullYear() ? monthDay : `${d.getFullYear()}-${monthDay}`
}
