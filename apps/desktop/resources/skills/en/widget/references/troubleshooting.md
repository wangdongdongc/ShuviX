# Troubleshooting

## The build fails

A failed `build` lists esbuild messages with file, line and column. Fix and build again.

- `Could not resolve "<package>"`: the import is outside the closed dependency set (the screen: React, React DOM, React Router, `shuvix/widget`; `api.ts`: `shuvix/widget-api`, `zod`). Write it with what is there: inline SVG icons, `Intl`, `Date`.
- `"shuvix/widget-api" runs on ShuviX's side, not in the widget's screen`: the screen imported `api.ts` (or zod) as a value. Write `import type Api from './api'`.
- `api.ts: …`: the API did not check out: an operation without `description` or `input`, a bad name, a schema agents cannot read (`z.date()`, `z.bigint()`, `z.map()`). The message names it; the screen was not rebuilt either.
- `No loader is configured for ".<ext>" files`: besides code, only `.css`, `.json`, `.txt` and the images `.svg`, `.png`, `.jpg`, `.gif` import. Read other files from disk through `fs/file` (`files.md`).
- `Build already in progress`: another build of the same widget is running; build again.

## The window is blank or shows a message

What the widget's page itself can show:

| On screen                                    | Meaning                                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Build Error** with esbuild output          | the last build failed; the window reloads by itself after the next green build                                                    |
| **Widget did not mount anything to #root.**  | the bundle loaded but nothing rendered: put the mount block back at the end of `index.tsx`                                        |
| **Runtime Error** / **Unhandled Promise Rejection** with a stack | an exception at run time; the stack names the place                                                                 |
| an empty page, no message                    | the app rendered nothing: an empty state with no text, a route that matches nothing, or CSS that hides everything                 |

`preview` shows you the same page and the errors it logged. Before reporting, make sure the code paths you changed cannot throw on empty data (no rows yet, an empty folder, a missing file).

## An operation fails

`call` it yourself to see the whole error, with its `logs`:

| Error                          | Meaning                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `invalid_args`                 | the input did not match the schema shown with it                                                                         |
| `[<code>] <message>`           | the handler called `ctx.fail`: the operation refused on purpose                                                          |
| `Widget operation failed: …`   | the handler threw. `no such table`: the tables were never created (`data.md`). `A read operation cannot change data`: an `op.read` that writes. `Widget operations can only run …` / `cannot use …`: a statement other than a query or a row change (`api.md`) |
| `timeout` / `out_of_memory`    | the handler ran over its limits (`api.md`): a loop that never ends, a query that returns everything                     |
| `no_api` / `unknown_op`        | there is no built API, or no such operation: `build` after editing `api.ts`                                             |
| `changed`                      | the widget was rebuilt between your check and your call; `describe` it again                                            |

In the screen, `WidgetError` carries the same `code` and `message`.

## A fetch fails

- `404 Widget <id> not registered`: the widget is not running (its window was closed and nothing has built it since). `build` starts it.
- `fs/file` 404: the path does not exist or is a directory; 403: ShuviX may not read it. On macOS, Desktop, Documents and Downloads need ShuviX to be allowed in System Settings → Privacy & Security → Files and Folders; the user has to grant it. In `preview`, `fs/` reads only what this conversation may read without asking.
- Works on the desktop, fails from a browser: the code uses an address that only exists on the desktop (`shuvix-media://`, `file://`, `http://127.0.0.1:<port>`). See `files.md`.

## Opening it

`open` fails, or the user does not see the window: ShuviX may be running headless, or the user is on ShuviX's web page from another device. The window opens on the computer running ShuviX; from a browser, the user opens the widget from the Widget panel, which opens it in a new tab.
