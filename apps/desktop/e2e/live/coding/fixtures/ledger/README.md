# ledger

Personal finance CLI. Reads the CSV export from the bank and prints reports.

    node bin/ledger.js report data/sample.csv
    node bin/ledger.js months data/sample.csv

The CSV has a header row with the columns `date` (YYYY-MM-DD), `description`, `amount` and
`category`. Amounts are expenses; refunds are negative. Internally every amount is kept as
integer cents (see `src/parse/amount.js`), and only the report layer turns cents back into text.

Layout:

- `bin/ledger.js` — entry point
- `src/cli/` — argument parsing and command dispatch
- `src/parse/` — CSV and amount parsing
- `src/model/` — transaction validation
- `src/store/` — loading a CSV file into transactions
- `src/report/` — totals and text formatting

Run the tests with `npm test`. No dependencies — only Node's built-in test runner.
