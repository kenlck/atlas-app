# Team whiteboard

A team member creates a whiteboard from the sidebar. It uses the full width, shows a pen on its row, and autosaves. Agents see a placeholder. An archived board disappears with its children.

## Sub-features

- `create` adds a Page or Whiteboard from `+ New page` in the team sidebar. The whiteboard row has a pen.
- `save` writes the scene, shows Saving and Saved, and shows `Couldn't save.` with Retry when the save fails.
- `flush` sends the latest scene when the tab is hidden.
- `conflict` answers a stale version with 409 and `board changed, reload`.
- `search` finds the title and text labels.
- `access` returns 404 to anyone outside the space.
- `archive` hides the board from the tree, search, and agents.

## How to get to it (user POV)

- Open a team space. In the sidebar, choose `+ New page`, then `Whiteboard`.
- Draw on the canvas. The top bar says Saving, then Saved.
- A phone-width window shows the board without the drawing tools.

## Driving it with Playwright

Preconditions:

- Doctor reports `sign_in_status=200`.
- `DATABASE_URL` points at the local database the app is using.

- **Create.** Run `./scripts/verify-fail-conditions.sh 7-1`. The log shows `whiteboard_created=true` and `sidebar_row_differs=true`.
- **Access, save, search, agents, archive.** Run `7-2`, `7-3`, `7-5`, `7-6`, `7-7`, `7-8`, `7-10`, and `7-11`.
- **Flush, chunk, scroll, retry.** Run `7-4`, `7-9`, `7-12`, and `7-13` in a browser.

## Gotchas

- The drawing chunk loads only after a whiteboard page mounts. A doc page must not request it.
- `+ New page` opens a menu. Choose `Page` to create a doc.
- The banner for a failed save and the banner for a stale board both use `.retry`.
