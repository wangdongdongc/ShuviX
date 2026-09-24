# sandbox-libs

Libraries an ```interactive figure may load inside its sandbox, served by the
`shuvix-lib://` protocol (`apps/desktop/src/main/services/customProtocols.ts`).
The name → file table is `SANDBOX_LIBS` in
`packages/chat-protocol/src/utils/interactiveFence.ts`; a file here that is not in
that table is never served.

They ship with the app instead of coming from a CDN for two reasons: a figure must
work offline, and the sandbox's CSP allows no network origin at all — a CDN would be
an egress path out of the frame.

| file | upstream | version | license |
|---|---|---|---|
| `chart.umd.min.js` | npm `chart.js`, `dist/chart.umd.min.js` | 4.5.1 | MIT (`LICENSE-chart.js.md`) |
| `d3.min.js` | npm `d3`, `dist/d3.min.js` | 7.9.0 | ISC (`LICENSE-d3.txt`) |

Both are the upstream files byte for byte except the trailing `//# sourceMappingURL=`
line, removed so DevTools does not ask the protocol for a map it will never serve.

To upgrade: replace the file, update this table, and keep the name in `SANDBOX_LIBS`
unchanged — agents are taught the name, not the version.
