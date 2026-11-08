import { createApp } from '../api/server.js'
import { AppError, invalid } from '../errors.js'
import { exportItems } from '../export/exportItems.js'
import { inventory } from '../services/inventory.js'
import { openStore } from '../store/index.js'
import { parseNow } from '../util/time.js'
import { parseArgs } from './args.js'

const USAGE = [
  'usage: stockroom <command> [args] [--data dir]',
  '',
  '  serve [--port 3000]',
  '  add <sku> <name...> [--category c] [--location l] [--reorder n] [--price cents]',
  '  price <sku> <cents>',
  '  receive <sku> <qty> [--cost cents]',
  '  reserve <sku> <qty> | release <sku> <qty>',
  '  ship <sku> <qty> [--from-reservation]',
  '  query <query>',
  '  export <file.csv> [--q query] [--with-price]',
  '  report lowstock|valuation|retail [--now iso-date] [--json]'
]

const intArg = (text, name) => {
  const n = Number(text)
  if (text === undefined || !Number.isInteger(n)) throw invalid(`${name} must be an integer`)
  return n
}

const pad = (text, width) => String(text).padEnd(width)

const money = (cents) => `$${(cents / 100).toFixed(2)}`

/** Run one CLI invocation; resolves to the exit code (`serve` keeps running). */
export async function run(argv, io) {
  const { positionals, flags } = parseArgs(argv)
  const [command, ...rest] = positionals
  if (!command || flags.help) {
    USAGE.forEach((line) => (command ? io.stdout(line) : io.stderr(line)))
    return command ? 0 : 1
  }
  const dataDir = typeof flags.data === 'string' ? flags.data : process.env.STOCKROOM_DATA || 'data'

  try {
    const service = inventory(await openStore(dataDir))
    switch (command) {
      case 'serve': {
        const port = flags.port === undefined ? 3000 : intArg(flags.port, '--port')
        const server = createApp(service)
        await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
        io.stdout(`listening on http://127.0.0.1:${server.address().port}`)
        return new Promise(() => {})
      }
      case 'add': {
        const [sku, ...name] = rest
        const item = await service.createItem({
          sku,
          name: name.join(' '),
          category: flags.category,
          location: flags.location,
          reorderPoint: flags.reorder === undefined ? 0 : intArg(flags.reorder, '--reorder'),
          price: flags.price === undefined ? null : intArg(flags.price, '--price')
        })
        io.stdout(`added ${item.sku}`)
        return 0
      }
      case 'receive':
      case 'reserve':
      case 'release':
      case 'ship': {
        const [sku, qtyText] = rest
        const qty = intArg(qtyText, 'qty')
        let item
        if (command === 'receive') {
          item = await service.receive(
            sku,
            qty,
            flags.cost === undefined ? 0 : intArg(flags.cost, '--cost')
          )
        } else if (command === 'ship') {
          item = await service.ship(sku, qty, {
            fromReservation: flags['from-reservation'] === true
          })
        } else {
          item = await service[command](sku, qty)
        }
        io.stdout(`${item.sku}: onHand ${item.onHand}, reserved ${item.reserved}`)
        return 0
      }
      case 'price': {
        const [sku, priceText] = rest
        const item = await service.updateItem(sku, { price: intArg(priceText, 'price') })
        io.stdout(`${item.sku}: price ${money(item.price)}`)
        return 0
      }
      case 'query': {
        const [q = ''] = rest
        for (const item of await service.listAllItems({ q })) io.stdout(item.sku)
        return 0
      }
      case 'export': {
        const [file] = rest
        if (!file) throw invalid('usage: stockroom export <file.csv>')
        const n = await exportItems(service, file, {
          q: typeof flags.q === 'string' ? flags.q : '',
          withPrice: flags['with-price'] === true
        })
        io.stdout(`exported ${n} items to ${file}`)
        return 0
      }
      case 'report': {
        const [kind] = rest
        if (kind === 'lowstock') {
          const rows = await service.lowStock({ now: parseNow(flags.now) })
          if (flags.json) {
            io.stdout(JSON.stringify(rows))
          } else {
            io.stdout(
              `${pad('SKU', 14)}${pad('AVAILABLE', 11)}${pad('REORDER', 9)}${pad('SHIPPED', 9)}COVER`
            )
            for (const r of rows) {
              const cover = r.daysOfCover === null ? '-' : `${r.daysOfCover}d`
              io.stdout(
                `${pad(r.sku, 14)}${pad(r.available, 11)}${pad(r.reorderPoint, 9)}${pad(r.shippedLast30, 9)}${cover}`
              )
            }
          }
          return 0
        }
        if (kind === 'valuation') {
          const report = await service.valuation()
          if (flags.json) {
            io.stdout(JSON.stringify(report))
          } else {
            for (const r of report.rows)
              io.stdout(`${pad(r.sku, 14)}${pad(r.onHand, 8)}${money(r.value)}`)
            io.stdout(`${pad('TOTAL', 22)}${money(report.total)}`)
          }
          return 0
        }
        if (kind === 'retail') {
          const report = await service.retail()
          if (flags.json) {
            io.stdout(JSON.stringify(report))
          } else {
            io.stdout(`${pad('SKU', 14)}${pad('ONHAND', 8)}${pad('PRICE', 12)}RETAIL`)
            for (const r of report.rows) {
              const price = r.price === null ? '-' : money(r.price)
              io.stdout(
                `${pad(r.sku, 14)}${pad(r.onHand, 8)}${pad(price, 12)}${money(r.retailValue)}`
              )
            }
            io.stdout(`${pad('TOTAL', 34)}${money(report.total)}`)
          }
          return 0
        }
        throw invalid(`unknown report "${kind}" (lowstock, valuation, retail)`)
      }
      default:
        throw invalid(`unknown command "${command}"`)
    }
  } catch (err) {
    io.stderr(`stockroom: ${err.message}`)
    return err instanceof AppError && err.code === 'INVALID' ? 2 : 1
  }
}
