# Exporting a widget

`export` with `widget` and `path` writes one .zip: a standalone Vite project in a top-level `<id>/` folder, with the widget's sources but without `widget.json`, `.git` or `node_modules`. `path` is a folder or a `.zip` path; a relative one is inside this conversation's working directory, and writing anywhere else asks the user.

- It never overwrites. On `[TARGET_EXISTS]` pick another name.
- Report the archive path, tell the user to unzip it and run `npm install` and `npm run dev` in the `<id>` folder, and point at the `EXPORT_NOTES.md` inside.

## What does not come along

The exported project is a fork: edits there do not flow back into ShuviX. `EXPORT_NOTES.md` lists how stock Vite differs from ShuviX's build. The ones that change behaviour:

- **The API does not run there.** `api.ts` comes along, but nothing executes it: inside ShuviX its operations run in a sandbox next to the widget's database. `shuvix/widget` resolves to a copy of the client, which sends `POST api/<operation>` and expects `{ "result": … }`; the user needs a backend of their own that answers the same way. Say so when you report the export of a widget with an API.
- **`/w/<id>/fs/…` (and an older widget's `/w/<id>/db/…`) are served by ShuviX** and do not exist there either.
- **The data stays in ShuviX.** The export carries `schema.sql` but no rows. If the user wants the data too, read it with `sql` (for example `SELECT json_group_array(json_object('id', id, 'title', title)) FROM books`) and save it next to the archive.
- Imported images become URLs under Vite instead of inline data URLs. `<img src={x}>` works either way.
