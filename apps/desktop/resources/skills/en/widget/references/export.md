# Exporting a widget

`shuvix widget export <id> --to <dir or file.zip>` writes one .zip: a standalone Vite project in a top-level `<id>/` folder, with the widget's sources but without `widget.json`, `.git` or `node_modules`.

- The target must be inside this conversation's working directory; anything else is refused (there is no approval prompt on this path).
- It never overwrites. On `[TARGET_EXISTS]` pick another name.
- Report the archive path, tell the user to unzip it and run `npm install` and `npm run dev` in the `<id>` folder, and point at the `EXPORT_NOTES.md` inside.

## What does not come along

The exported project is a fork: edits there do not flow back into ShuviX. `EXPORT_NOTES.md` lists how stock Vite differs from ShuviX's build. The ones that change behaviour:

- **`/w/<id>/db/…` and `/w/<id>/fs/…` are served by ShuviX** and do not exist in the exported project. Code that calls them needs a backend of the user's own answering the same paths, or another data source. Say so when you report the export of a widget that uses either.
- The widget's data stays in ShuviX's database; the export carries `schema.sql` but no rows. If the user wants the data too, dump it with `db-query` (for example `SELECT json_agg(t) FROM todos t`) and save it next to the archive.
- Imported images become URLs under Vite instead of inline data URLs. `<img src={x}>` works either way.
