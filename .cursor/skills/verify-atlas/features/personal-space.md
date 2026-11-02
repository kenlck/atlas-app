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
- On an open page, choose `Create page` at the top right, to the left of `Saved`.
- Right-click a page, choose `Move`, then choose the parent.
- Right-click a page and choose `Archive`.

## Driving it with Playwright

Preconditions:

- Doctor reports `sign_in_status=200`.
- `psql` can read `DATABASE_URL`. Recipe `1` compares the page row before and after the other person's save.

- **Create.** Sign up. Choose `+ New page`. The editor shows `#page-title` and `.doc-editor`.
- **Subpage.** On that page, choose `Create page`. The new row's parent is the page that was open, the breadcrumb shows that parent, and the sidebar lists the child under it.
- **Nest.** Create `Parent`, then `Child`. Right-click `Child`, choose `Move`, choose `Parent`. The tree shows a `▾ Parent` link.
- **Other person.** Run `./scripts/verify-fail-conditions.sh 1`. The log shows `404` for the open, the save, and the space, `content_unchanged=true`, and `B_tree_contains_A_title=false`.
- **Cycle and archive.** Run `./scripts/verify-fail-conditions.sh 4`. The log shows `move_under_child_status=400`, `move_under_self_status=400`, and `child_after_archive_status=404`.

## Gotchas

- Both root buttons are named `+ New page`. `Create page` is a different name, so a locator for `+ New page` does not click the header control. While the space is empty, the main-column `+ New page` is the last one.
- The Move dialog does not offer the page or its descendants. The 400 comes from replaying the move request with the ids swapped.
- Archiving the parent hides the child. The child URL then renders `Page not found.`
