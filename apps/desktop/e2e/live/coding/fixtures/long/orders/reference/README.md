# stockroom

Inventory service for a small warehouse. Items have stock on hand, reserved stock (promised to an
order but not shipped yet) and a reorder point. Every change is recorded as a movement.

    node scripts/seed.js data 200 2000        # demo data into ./data
    node bin/stockroom.js serve --data data   # HTTP API on 127.0.0.1:3000

## CLI

    stockroom serve [--port 3000]
    stockroom add <sku> <name...> [--category c] [--location l] [--reorder n]
    stockroom receive <sku> <qty> [--cost cents]
    stockroom reserve|release <sku> <qty>
    stockroom ship <sku> <qty> [--from-reservation]
    stockroom order <sku> <qty> --cost cents
    stockroom orders [--status open|closed|cancelled]
    stockroom order-receive <id> <qty>
    stockroom order-cancel <id>
    stockroom query <query>
    stockroom export <file.csv> [--q query]
    stockroom report lowstock|valuation [--now iso-date] [--json]

Every command takes `--data <dir>` (default `$STOCKROOM_DATA` or `./data`).

## HTTP API

| method | path                  | body / query                                                |
| ------ | --------------------- | ----------------------------------------------------------- |
| GET    | `/items`              | `?q=<query>&limit=<n>&cursor=<c>` → `{ items, nextCursor }` |
| POST   | `/items`              | `{ sku, name, category?, location?, reorderPoint? }`        |
| GET    | `/items/:sku`         |                                                             |
| POST   | `/items/:sku/receive` | `{ qty, unitCost }`                                         |
| POST   | `/items/:sku/reserve` | `{ qty }`                                                   |
| POST   | `/items/:sku/release` | `{ qty }`                                                   |
| POST   | `/items/:sku/ship`    | `{ qty, fromReservation? }`                                 |
| POST   | `/orders`             | `{ sku, qty, unitCost }`                                    |
| GET    | `/orders`             | `?status=open\|closed\|cancelled` → `{ orders }`            |
| GET    | `/orders/:id`         |                                                             |
| POST   | `/orders/:id/receive` | `{ qty }`                                                   |
| POST   | `/orders/:id/cancel`  |                                                             |
| GET    | `/reports/lowstock`   | `?now=<iso-date>`                                           |
| GET    | `/reports/valuation`  |                                                             |

Errors are `{ "error": { "code", "message", "details" } }` with 400 / 404 / 409.

Lists are paged: pass `nextCursor` back as `cursor` until it is `null`.

## Query language

Space-separated terms, all of which must match:

- `field:value` — equals, case-insensitive; `*` is a wildcard (`sku:FA-00*`); quote values with
  spaces (`location:"Aisle 3"`, `\"` inside quotes)
- `field>n`, `field>=n`, `field<n`, `field<=n`, `field:n` — numbers
- a bare word — the SKU or the name contains it

Fields: `sku`, `name`, `category`, `location` (text) and `onHand`, `reserved`, `available`,
`reorderPoint` (numbers). `available` is `onHand - reserved`.

## Reports

- **lowstock**: items whose available stock plus what is still to come on open purchase orders
  (`onOrder`) is below their reorder point, with the units shipped in the last 30 days and the days
  of cover at that rate (`null` when nothing shipped). Most urgent first, then by SKU.

## Purchase orders

An order is open until every unit has arrived (closed) or it is cancelled. Receiving against an order
adds stock at the order's unit cost, with a `receive` movement that carries the `orderId`. Orders are
kept in `orders.json` in the data directory.

- **valuation**: stock value per item, first in first out: shipments use up the oldest received
  lots first. Values in cents.
