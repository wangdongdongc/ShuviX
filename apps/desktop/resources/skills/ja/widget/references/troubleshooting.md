# Troubleshooting

## The build fails

`buildSuccess: false` comes with `buildErrors`, esbuild messages with file, line and column. Fix and build again.

- `Could not resolve "<package>"`: the import is outside the closed dependency set (React, React DOM, React Router; Tailwind comes through `className`, not an import). Write it with what is there: inline SVG icons, `fetch`, `Intl`, `Date`.
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

The user sees these too; you see them only if they tell you. Before reporting, make sure the code paths you changed cannot throw on empty data (no rows yet, an empty folder, a missing file).

## A fetch fails

- `404 Widget <id> not registered`: the widget is not running (its window was closed and nothing has built it since). `shuvix widget build <id>` starts it.
- `db/` answers `{ code, message }`: the message says which table, column or filter is wrong. A missing table usually means `schema.sql` was never installed (`data.md`).
- `fs/file` 404: the path does not exist or is a directory; 403: ShuviX may not read it. On macOS, Desktop, Documents and Downloads need ShuviX to be allowed in System Settings → Privacy & Security → Files and Folders; the user has to grant it.
- Works on the desktop, fails from a browser: the code uses an address that only exists on the desktop (`shuvix-media://`, `file://`, `http://127.0.0.1:<port>`). See `files.md`.

To check an endpoint from your own shell, `curl` the `url` that `build` returned plus the route, with its `token` in the header, e.g. `curl -H "x-shuvix-widget-token: <token>" "<url>db/todos?limit=3"`. A 403 there means the token is missing or from before ShuviX restarted (`build` again for a fresh one); `fs/` always answers 403 to the shell.

## The CLI

- `shuvix` not found, or it cannot reach ShuviX: you are not in a shell ShuviX started, or the app is not running. Report it rather than working around it.
- `open` fails, or the user does not see the window: ShuviX may be running headless, or the user is on ShuviX's web page from another device. The window opens on the computer running ShuviX; from a browser, the user opens the widget from the Widget panel, which opens it in a new tab.
