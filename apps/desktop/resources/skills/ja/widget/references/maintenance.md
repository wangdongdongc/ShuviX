# Changing an existing widget

## Finding it

- `shuvix widget list` gives the id and `projectDir`. If it shows only under `--archived`, stop and tell the user to restore it from the Widget panel.
- If it is in neither listing but its directory exists, its `widget.json` is missing or corrupt: report that instead of repairing it.
- Ask which widget the user means when the request fits more than one.

## Before the first edit

Run `shuvix widget build <id> --message "chore: baseline before <task>"`:

- it tells you whether the widget builds as it stands, so you do not take the blame for a break that was already there;
- it gives this conversation access to the widget's directory;
- if it builds, it commits whatever was already in the directory (the user's own edits, a half-finished earlier session), so your change lands as a commit of its own. A widget that predates version control gets its repository here.

If that build fails, nothing is committed and the widget was already broken. Fixing it is part of the job only when the user asked for it or your change cannot land without it; otherwise say so.

Then read `README.md` and every file you are about to change, and follow their conventions: naming, file layout, how state is held.

## Making the change

- Targeted `edit`s, not rewrites. Keep the mount block and its "DO NOT DELETE" comment.
- Table changes follow `data.md` ("Changing tables").
- Add one line to the README's changelog, in the README's language.
- `shuvix widget build <id> --message "<what changed>"`, then `shuvix widget open <id>`.

## Widgets written before this skill

Older widgets were written by a built-in Widget Builder agent that no longer exists, and some use things that break when ShuviX is opened from a browser. When the user asks to update one, or your change touches these parts, bring them in line. First search the widget's `.ts` / `.tsx` files for this pattern:

```
shuvix-media:|file://|127\.0\.0\.1|localhost:|localStorage|sessionStorage|indexedDB|document\.cookie
```

| Found                                                       | Change to                                                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix-media:///abs/path` (or built as `` `shuvix-media://${p}` ``) | `fileUrl('/abs/path')` / `fileUrl(p)` from one URL module (`files.md`); the path inside is what follows `shuvix-media://`, decoded |
| `file:///…`                                                 | the same `fileUrl(…)`                                                                                                             |
| `http://127.0.0.1:<port>/w/<id>/…` or `localhost:<port>`    | the path alone: `/w/<id>/…`                                                                                                       |
| `localStorage` / `sessionStorage` / `IndexedDB` / cookies   | a table in the widget's database (`data.md`). Nothing to migrate: the widget's address changes port on every ShuviX start, so browser storage never outlived a restart |
| a README line saying the design rules live in the Widget Builder agent | a line saying they live in the built-in skill `builtin:widget`                                                    |

A hard-coded home folder (`/Users/<name>/…`) can stay, but `~/…` is better (`files.md`).

Older widgets also predate the home screen: most have no `icon.svg`, and many were laid out for a window of their own. When updating one, draw its icon and check that it works from 320px wide (`design.md`, "Icon" and "Width").

After the change, build, open, and tell the user what you converted, so they can check the widget from a browser too.
