# The `shuvix widget` CLI

Every command prints JSON to stdout on success and a message to stderr on failure (exit 0 / 1); `db-query` prints a psql-style table instead. Paths you pass resolve against your shell's current directory.

| Command                                                             | What it does                                                                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix widget list`                                                | Active widgets: `id`, `name`, `description`, `projectDir`, timestamps. `--archived` lists the archived ones instead.                                                 |
| `shuvix widget init <id> --name "…" --description "…"`              | Scaffold a new widget and run its first build. Returns `projectDir`, `url`, `files`, `buildSuccess`, optional `buildErrors`.                                         |
| `shuvix widget build <id> [--message "…"]`                          | Rebuild after edits. Returns `id`, `url`, `buildSuccess`, optional `buildErrors`, and `commit` when the build was green and something changed. An open window reloads. |
| `shuvix widget open <id>`                                           | Open the widget in its own window on the computer running ShuviX (focuses it if already open). Only when the user asks you to open it.                                                                       |
| `shuvix widget preview <id> [--size panel,window,phone] [--theme light\|dark]` | Render the widget in a hidden window at those sizes (default all three) and print `images` (`size`, `width`, `height`, `path`) and `errors` the page logged. Nothing opens on screen. `read` the images. See `design.md`, "Check it". |
| `shuvix widget export <id> --to <dir or file.zip>`                  | Package a standalone Vite project into one .zip, inside this conversation's working directory. See `export.md`.                                                      |
| `shuvix widget db-init <id> --file <projectDir>/schema.sql`         | Install or update the widget's schema; whatever applied is written back to `schema.sql`. `--sql "<DDL>"` also works. See `data.md`.                                  |
| `shuvix widget db-query <id> --sql "<SQL>"`                         | Run any SQL inside the widget's own schema: inspection, data fixes, repairs. `--file <path>` also works. Not transactional on its own.                               |

## Details that matter

- **Access**: `init` and `build` give this conversation read and write access to the widget's directory. For an existing widget, run `build` before editing, or every write asks the user first.
- **`buildSuccess: false`** with `buildErrors` is a normal, recoverable outcome: fix and build again.
- **Commits**: after a green build ShuviX commits the whole widget directory, deletions included. `--message` is that commit's subject (default `chore(<id>): build`); write what changed, in one line. Nothing to commit means no `commit` field. You never run git, and you never touch `.git`.
- **`url`** is the widget's address on this computer (`http://127.0.0.1:<port>/w/<id>/`). The port changes when ShuviX restarts, and the address does not exist for someone using ShuviX from a browser, so it never goes into widget code. It is useful from your own shell, e.g. `curl "<url>db/todos?limit=3"` to check the database API.
- **`open`** shows the window on the computer where ShuviX runs. When the user is on ShuviX's web page, or ShuviX runs headless (where `open` fails), tell them to open the widget from the Widget panel instead; it opens in a new browser tab there.
- **Ids** are lowercase ASCII kebab-case with at least one dash; anything else is refused.
- If `shuvix` is not found or cannot reach ShuviX, you are not in a shell ShuviX started or the app is not running: report it rather than working around it.
