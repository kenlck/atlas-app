# Tables and dates

A writer inserts a table or a date chip from the toolbar. The table tools row appears while the cursor is inside a table. Dates are stored as a calendar day.

## Sub-features

- `insert-table` adds a 3 by 3 table with a header row.
- `table-tools` adds rows and columns, merges cells, toggles the header, resizes a column, and deletes the table.
- `wide-table` scrolls inside the 720px column at 1280 and 390.
- `paste-table` keeps every row and cell from a Sheets or Excel paste.
- `date-chip` inserts today's local date and opens a picker. The stored value is `YYYY-MM-DD`.

## How to get to it (user POV)

- Open a page.
- Choose Table in the toolbar. The tools row sits under the toolbar.
- Choose Date. The chip sits in the current paragraph. Click it to open the picker.

## Driving it with Playwright

Preconditions:

- Doctor reports `sign_in_status=200`.
- The editor shows `#page-title` and `.doc-editor`.

- **Reload.** Run `./scripts/verify-fail-conditions.sh 3-1`. The log shows `reload_exact_match=true`, `doc_shrunk_by_36=true`, and `date_value=2026-01-15`.
- **Overflow.** Run `./scripts/verify-fail-conditions.sh 3-2`. The log shows `ok=true` at 1280 and 390, and the table wrapper `scrollWidth` is greater than `clientWidth`.
- **Time zone.** Run `./scripts/verify-fail-conditions.sh 3-3`. The log shows `same_day=true` and `stored_day_stable=true`.
- **Paste.** Run `./scripts/verify-fail-conditions.sh 3-4`. The log shows `sheets_rows=5`, `excel_rows=5`, and `paste_cells_kept=true`.
- **Baselines.** Run `./scripts/verify-fail-conditions.sh 3-5`. The log lists each table and date baseline with a byte size.

## Gotchas

- The date label is built from the `YYYY-MM-DD` parts. It does not parse the value with `Date`.
- Paste uses the table schema. There is no second HTML walker.
- Merge cells stays disabled until two or more cells are selected.
- At 390 the toolbar check fails unless `scrollWidth` is greater than `clientWidth` before the scroll.
