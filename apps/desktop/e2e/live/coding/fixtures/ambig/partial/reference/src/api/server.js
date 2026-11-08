import { createServer } from 'node:http'
import { notFound } from '../errors.js'
import { parseNow } from '../util/time.js'
import { intParam, readJson, sendError, sendJson } from './http.js'
import { router } from './router.js'

/** The HTTP API over an inventory service (services/inventory.js). Call .listen() on the result. */
export function createApp(service) {
  const r = router()

  r.add('GET', '/items', async (req, res, params, url) => {
    const page = await service.listItems({
      q: url.searchParams.get('q') ?? '',
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: intParam(url, 'limit')
    })
    sendJson(res, 200, page)
  })
  r.add('POST', '/items', async (req, res) => {
    sendJson(res, 201, await service.createItem(await readJson(req)))
  })
  r.add('GET', '/items/:sku', async (req, res, params) => {
    sendJson(res, 200, await service.getItem(params.sku))
  })
  r.add('POST', '/items/:sku/receive', async (req, res, params) => {
    const body = await readJson(req)
    sendJson(res, 200, await service.receive(params.sku, body.qty, body.unitCost ?? 0))
  })
  r.add('POST', '/items/:sku/reserve', async (req, res, params) => {
    const body = await readJson(req)
    sendJson(
      res,
      200,
      await service.reserve(params.sku, body.qty, { partial: body.partial === true })
    )
  })
  r.add('POST', '/items/:sku/release', async (req, res, params) => {
    const body = await readJson(req)
    sendJson(res, 200, await service.release(params.sku, body.qty))
  })
  r.add('POST', '/items/:sku/ship', async (req, res, params) => {
    const body = await readJson(req)
    const fromReservation = body.fromReservation === true
    sendJson(res, 200, await service.ship(params.sku, body.qty, { fromReservation }))
  })
  r.add('GET', '/reports/lowstock', async (req, res, params, url) => {
    sendJson(res, 200, await service.lowStock({ now: parseNow(url.searchParams.get('now')) }))
  })
  r.add('GET', '/reports/valuation', async (req, res) => {
    sendJson(res, 200, await service.valuation())
  })

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      const hit = r.match(req.method, url.pathname)
      if (!hit) throw notFound(`route ${req.method} ${url.pathname}`)
      await hit.handler(req, res, hit.params, url)
    } catch (err) {
      sendError(res, err)
    }
  })
}
