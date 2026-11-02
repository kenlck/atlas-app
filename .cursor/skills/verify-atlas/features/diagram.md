# Diagram block

A page can hold a drawing. The block shows the saved image. Edit opens the canvas. The scene stays on the drawing row for that page.

## Sub-features

- `insert` adds a column-width block from the Drawing toolbar button. An empty block reads Empty drawing and has Edit.
- `edit` opens the canvas full screen, with a centred spinner until it is ready. Done returns to the image.
- `save` writes the scene on the drawing row. A failed save shows Couldn't save. and Retry. Hiding the tab sends the latest scene.
- `search` finds text labels from drawings on the page.
- `access` follows the page. A person who cannot open the page cannot open the drawing.
- `archive` hides the page and its drawings from the API, search, and agents.
- `copy` gives a duplicated page, and a pasted block, its own drawing with the same scene.

## How to get to it (user POV)

- Open a page. In the toolbar, choose Drawing.
- The block shows Empty drawing. Choose Edit, draw, then Done.
- The block shows the picture. Reload the page and the picture is still there.

## Driving it with Playwright

Preconditions:

- Doctor reports `sign_in_status=200`.
- `DATABASE_URL` points at the local database the app is using.

- **No chunk.** Run `./scripts/verify-fail-conditions.sh 8-4`. The log shows `doc_excalidraw_requests=0`.
- **Edit, flush, retry.** Run `8-6`. The log shows `reload_scene_identical=true`, `retry_banner=true`, and `flush_hidden_scene_identical=true`.
- **Before Edit.** Run `8-9`. The log shows `before_edit_excalidraw_requests=0` and `saw_spinner=true`.
- **Access, agents, search, archive, copy, preview.** Run `8-1`, `8-2`, `8-3`, `8-5`, `8-7`, `8-8`, `8-10`, `8-11`, and `8-12`.

## Gotchas

- The drawing chunk loads when Edit is clicked. A page with no diagram block must not request it.
- There is no separate duplicate control. `duplicatePage` copies the page and gives each block a new drawing. Pasting a block does the same on save.
- An agent sees `[Drawing](atlas://drawing/<id>)`. Updating that line unchanged keeps the id. Deleting the line removes the block and leaves the drawing row.
- The banner for a failed save uses `.retry` inside the full-screen drawing.
