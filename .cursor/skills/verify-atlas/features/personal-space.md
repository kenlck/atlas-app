# Personal space and nested pages

The signed-in person gets one personal space. They create pages and nest one page under another. Another signed-in person who opens that page, saves it, or lists the space gets the same 404 as a missing page.

## Sub-features

- `space` opens `/s/<space id>` after sign-up.
- `create-page` adds a page from `+ New page`.
- `create-subpage` adds a child of the open page from `Create page`.
- `nest-page` moves a page under another page.
- `private` returns 404 to the other account.
- `cycle-and-archive` rejects a move under a child or under itself, and hides children of an archived page.

## How to get to it (user POV)

- Submit sign-up. The app redirects to the personal space.
- Choose `+ New page` in the empty space, or the same button in the sidebar.
- On a wide window, choose `Collapse sidebar` at the top of the sidebar. The rail keeps Search, page icons, Profile, and Sign out. Choose `Expand sidebar` to restore the list. The choice stays for this browser tab, including a reload. Below 900px the sidebar stays the page drawer.
- On an open page, choose `Create page` at the top right, to the left of `Saved`.
- Right-click a page, choose `Move`, then choose the parent.
- Right-click a page and choose `Archive`.

## Driving it with Playwright

Preconditions:

- Doctor reports `sign_in_status=200`.
- `psql` can read `DATABASE_URL`. Recipe `1` compares the page row before and after the other person's save.

- **Create.** Sign up. Choose `+ New page`. The editor shows `#page-title` and `.doc-editor`.
- **Collapse.** At 1280px, choose `Collapse sidebar`. Choose a page icon. The page opens and the rail stays. Reload. The rail is still collapsed. Choose `Expand sidebar`. The page names return.
- **Subpage.** On that page, choose `Create page`. The new row's parent is the page that was open, the breadcrumb shows that parent, and the sidebar lists the child under it.
- **Nest.** Create `Parent`, then `Child`. Right-click `Child`, choose `Move`, choose `Parent`. The tree shows a `▾ Parent` link.
- **Other person.** Run `./scripts/verify-fail-conditions.sh 1`. The log shows `404` for the open, the save, and the space, `content_unchanged=true`, and `B_tree_contains_A_title=false`.
- **Cycle and archive.** Run `./scripts/verify-fail-conditions.sh 4`. The log shows `move_under_child_status=400`, `move_under_self_status=400`, and `child_after_archive_status=404`. Run `./scripts/verify-fail-conditions.sh 10-3` for a move under a descendant. The log shows `grandchild_rows_unchanged=true`, `self_rows_unchanged=true`, `cycle_walk_within_500ms=true`, and `cycle_rows_unchanged=true`.

## Gotchas

- Both root buttons are named `+ New page`. `Create page` is a different name, so a locator for `+ New page` does not click the header control. While the space is empty, the main-column `+ New page` is the last one.
- The Move dialog does not offer the page or its descendants. The 400 comes from replaying the move request with the ids swapped.
- In a team, Move and the drag handle are only on pages the signed-in person can delete: a page they created, or any page when they are the team owner. The personal-space owner can move pages in that space. A refused move snaps the row back and shows `You can't move this page.` Run `./scripts/verify-fail-conditions.sh 49-fc1` through `49-fc6`.
- Archiving the parent hides the child. The child URL then renders `Page not found.`
- The line under the title reads `Edited by <name> · <relative time>` from `last_edited_by` and `last_edited_at`. A null author reads `Edited <relative time>` with no name and no `by`. Text, title, diagram, and token saves update those columns. A diagram save whose scene elements are unchanged does not. Move, lock, and unlock do not. `updatedAt` stays the version stamp. Run `./scripts/verify-fail-conditions.sh 51m-fc1` through `51m-fc7`.
