# Changelog

## Unreleased

## 1.4.0 — 2026-04-12

- query: numeric comparisons (`onHand>10`, `available<=5`)
- report: lowstock shows the units shipped in the last 30 days and the days of cover
- api: lists are paged; pass `nextCursor` back as `cursor`

## 1.3.0 — 2026-03-02

- export: `stockroom export` writes the matching items as CSV
- store: writes go to a temp file first and are renamed into place
- cli: every command takes `--data <dir>`

## 1.2.0 — 2026-01-19

- report: valuation uses the oldest lots first
- domain: shipments can come from a reservation (`fromReservation`)
