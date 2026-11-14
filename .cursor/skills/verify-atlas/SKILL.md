---
name: verify-atlas
description: Drive the Atlas web app on localhost and prove sign-up, sign-in, the personal space, nested pages, and the admin reset API. Use when a change needs a live check, an issue 1 fail-condition recipe, or screenshots of the running app.
---

# Verify Atlas

Drive the running Atlas app the way a person does. The recipes shell out to Playwright and curl. They print raw status lines. They do not print `ADMIN_API_SECRET`, passwords, session cookies, or database URLs.

On load, every driver refuses a `BASE_URL` whose scheme is not `http` or whose host is not `localhost`, `127.0.0.1`, or `::1`. The recipe script applies the same host check to `DATABASE_URL` and `TEST_DATABASE_URL` before `psql` or Docker uses them. The scheme has to be `postgres` or `postgresql`.

## Full run

`./scripts/verify-all.sh` is the full check. It installs, migrates, typechecks, tests, builds, starts the app, takes visual shots, runs the autosave flush, lints tokens, builds the Docker image at HEAD, runs every fail-condition recipe, takes screenshots, compares baselines in the pinned Playwright image, and writes the side-by-side set. Proof is `artifacts/<head sha>/`, with `logs/` next to the screenshots. It uses a local Postgres 16 unless `DATABASE_URL` is already set to a local database. It refuses a dirty tree and exits non-zero on the first failure. Throwaway secrets are generated at runtime and are not printed or written to the artifact.

Drive one recipe with the commands below when the app is already running.

## Launch

From the repo root, with Docker available:

```bash
docker build -t atlas-app .
docker run -d --name atlas-verify-pg -e POSTGRES_USER=atlas -e POSTGRES_PASSWORD=atlas -e POSTGRES_DB=atlas -p 127.0.0.1:5432:5432 postgres:16
```

Wait until `docker exec atlas-verify-pg pg_isready -q` exits 0. Export `DATABASE_URL` for that Postgres, `BETTER_AUTH_URL=http://127.0.0.1:3000`, `BASE_URL` to the same origin, `BETTER_AUTH_SECRET` and `ADMIN_API_SECRET` as 32 or more random characters, `ATLAS_IMAGE=atlas-app`, and `ATLAS_CONTAINER=atlas-verify`. Do not print those values. Then:

```bash
docker run --rm --network host -e DATABASE_URL atlas-app node migrate.mjs
docker run -d --name atlas-verify --network host \
  -e DATABASE_URL -e BETTER_AUTH_SECRET -e BETTER_AUTH_URL -e ADMIN_API_SECRET \
  -e HOST=127.0.0.1 -e PORT=3000 atlas-app
```

Ready means `curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/sign-in` prints `200`. A database health check is not enough. The sign-in page has to answer.

`ADMIN_API_SECRET` must be at least 32 characters or the reset route returns an empty 404. Production refuses to boot when it is missing or empty: recipe `5a` expects that exit. Recipe `5e` sets a 12-character secret and a 31-character secret and still returns an empty 404.

Teardown is in Cleanup. Do not point `DATABASE_URL` at a database you need to keep. Recipe `all` drops the `public` schema.

## Doctor

```bash
BASE_URL=http://127.0.0.1:3000 ATLAS_CONTAINER=atlas-verify ./scripts/verify-doctor.sh
```

Require `sign_in_status=200`, a `head_sha` that matches `git rev-parse HEAD`, and `admin_secret=set` or `admin_secret=unset`. The script does not print the secret. Run doctor again before a recipe if a request fails for an unexpected reason.

## Drive

Prefer the recipe script. It is the maintained check for issue 1.

```bash
./scripts/verify-fail-conditions.sh 1
./scripts/verify-fail-conditions.sh 2
./scripts/verify-fail-conditions.sh 3
./scripts/verify-fail-conditions.sh 4
./scripts/verify-fail-conditions.sh 5a
./scripts/verify-fail-conditions.sh 5e
./scripts/verify-fail-conditions.sh 5b
./scripts/verify-fail-conditions.sh 5c
./scripts/verify-fail-conditions.sh 5d
./scripts/verify-fail-conditions.sh 5f
./scripts/verify-fail-conditions.sh 5g
./scripts/verify-fail-conditions.sh 5h
./scripts/verify-fail-conditions.sh forgot-password
./scripts/verify-fail-conditions.sh design-lock
./scripts/verify-fail-conditions.sh 3-1
./scripts/verify-fail-conditions.sh 3-2
./scripts/verify-fail-conditions.sh 3-3
./scripts/verify-fail-conditions.sh 3-4
./scripts/verify-fail-conditions.sh 3-5
./scripts/verify-fail-conditions.sh 6
./scripts/verify-fail-conditions.sh 5-1
./scripts/verify-fail-conditions.sh 5-2
./scripts/verify-fail-conditions.sh 5-3
./scripts/verify-fail-conditions.sh 5-4
./scripts/verify-fail-conditions.sh 4-1
./scripts/verify-fail-conditions.sh 4-2
./scripts/verify-fail-conditions.sh 4-3
./scripts/verify-fail-conditions.sh 4-4
./scripts/verify-fail-conditions.sh 4-5
./scripts/verify-fail-conditions.sh 4-6
./scripts/verify-fail-conditions.sh 4-7
./scripts/verify-fail-conditions.sh 7-1
./scripts/verify-fail-conditions.sh 7-2
./scripts/verify-fail-conditions.sh 7-3
./scripts/verify-fail-conditions.sh 7-4
./scripts/verify-fail-conditions.sh 7-5
./scripts/verify-fail-conditions.sh 7-6
./scripts/verify-fail-conditions.sh 7-7
./scripts/verify-fail-conditions.sh 7-8
./scripts/verify-fail-conditions.sh 7-9
./scripts/verify-fail-conditions.sh 7-10
./scripts/verify-fail-conditions.sh 7-11
./scripts/verify-fail-conditions.sh 7-12
./scripts/verify-fail-conditions.sh 7-13
./scripts/verify-fail-conditions.sh 8-1
./scripts/verify-fail-conditions.sh 8-2
./scripts/verify-fail-conditions.sh 8-3
./scripts/verify-fail-conditions.sh 8-4
./scripts/verify-fail-conditions.sh 8-5
./scripts/verify-fail-conditions.sh 8-6
./scripts/verify-fail-conditions.sh 8-7
./scripts/verify-fail-conditions.sh 8-8
./scripts/verify-fail-conditions.sh 8-9
./scripts/verify-fail-conditions.sh 8-10
./scripts/verify-fail-conditions.sh 8-11
./scripts/verify-fail-conditions.sh 8-12
./scripts/verify-fail-conditions.sh 8-13
./scripts/verify-fail-conditions.sh test-db-guard
./scripts/verify-fail-conditions.sh 10-3
./scripts/verify-fail-conditions.sh 10-4
./scripts/verify-fail-conditions.sh 37-fc1
./scripts/verify-fail-conditions.sh 37-fc2
./scripts/verify-fail-conditions.sh 37-fc3
./scripts/verify-fail-conditions.sh 37-fc4
./scripts/verify-fail-conditions.sh 37-fc5
./scripts/verify-fail-conditions.sh 37-fc7
./scripts/verify-fail-conditions.sh 37-fc8
./scripts/verify-fail-conditions.sh 37-fc9
./scripts/verify-fail-conditions.sh 37-fc10
```

Each recipe prints `START <utc> sha=<head>` and `END <utc> sha=<head>`. A non-zero exit means that check failed. `5d` reads `docker logs` for its own container and greps the full `admin_audit` row. `5f` and `5g` grep that audit row for the secret, the temporary password, and the new password. `5f` also greps `docker logs` of `ATLAS_CONTAINER` for those values. `10-4` expects `missing_origin_status=403`, `mismatched_origin_status=403`, and `malformed_status=400`, each with the page row unchanged, and `matching_origin_status=204`. `5a`, `5e`, `5b`, `5c`, `5d`, `5h`, and `6` start their own containers from `ATLAS_IMAGE` (default `atlas-app`). `5h` uses a fresh process so the in-memory rate limit starts at zero. `5f` performs two resets on the shared app. `5g` performs one more. That stays under the limit of five. Recipe `5b` does not time requests. Constant-time comparison is the unit test `rejects a wrong secret, returns a temp password once, locks the user, and audits` in `tests/admin-reset.test.ts`.

Issue 18 recipes cover invites, in-flight saves, and the settings screen. `18-fc1` expects `fc1_head_status=409`, `fc1_head_rows=1`, and `fc1_ui_alert=Already invited`. `18-fc2` expects `fc2_head_stored=false` and `fc2_head_status=404`. `18-fc3` expects `fc3_head_invited_by=null` and `fc3_rule=set null`. `18-fc4` expects a visible error for send, remove, and delete, with the member row and the settings page kept. `18-fc5` expects the new page to stay put when the flush fails or hangs, and `fc5_hang_timed_out=true`. `18-fc6` expects `fc6_head_tab_left_dialog=false`. `18-fc7` expects `fc7_head_left_aligned=true` and `fc7_head_caret_matches_muted=true`. `18-fc8` expects a `run_step` for `18-fc1` through `18-fc8`. Each planted run exits 1 only when the bug is present (`cond ? 1 : 0`) and logs `fcN_absent_exit=0` from the same check on a setup where that behavior is gone. The flush negative drives the failed save and the hung save through the checked-in copy of the flush at `fb2cfaa`.

Issue 7 recipes cover the team whiteboard. `7-1` expects `whiteboard_created=true` and `sidebar_row_differs=true`. `7-2` expects 404 for an outsider and a removed member by page id, drawing id, and personal token, with the same body as a missing page, and `outsider_search_visible=false`. `7-3` expects `reload_scene_identical=true`. `7-4` expects `flush_hidden_scene_identical=true` after autosave is aborted and the tab is hidden two seconds later. `7-5` expects `stale_status=409`, `stored_unchanged=true`, and `reload_prompt=true`. `7-6` expects `oversize_status=413` and `stored_oversize=false`. `7-7` expects `files_status=400` and `image_status=400`. `7-8` expects `title_visible=true`, `label_visible=true`, and `scene_secret_visible=false`. `7-9` expects `doc_excalidraw_requests=0`, `watermark=absent`, and the library, live collaboration, and image tool hidden. `7-10` expects `read_body=Whiteboard, open in Atlas to view`, `update_status=200`, and `scene_unchanged=true`. `7-11` expects the archived board and its child hidden from the tree, search, MCP, and the drawing endpoint. `7-12` expects `scrollbar_1280=false` and `scrollbar_390=false`. `7-13` expects `retry_banner=true`.

Issue 37 recipes cover View and Edit. `37-fc1` expects `fc1_save_requests=0` and `fc1_text_unchanged=true` after click, double-click, and typing in View. `37-fc2` expects `fc2_rule=true`, `fc2_chip=true`, and `fc2_status=true`. `37-fc3` expects `fc3_persisted=true`. `37-fc4` expects `fc4_stayed=true`, `fc4_discard=0`, and `fc4_retry_saved=true`. `37-fc5` expects `fc5_view=true`. `37-fc7` expects `fc7_title_focused=true`. `37-fc8` expects `fc8_icon_to_edit=true`, `fc8_390_scroll=false`, and `fc8_1280_scroll=false`. `37-fc9` expects `fc9_save_requests=0` and `fc9_scene_unchanged=true`. `37-fc10` expects `fc10_save_status=204`, `fc10_update_status=200`, `fc10_conflict_status=409`, and `fc10_forbidden_status=403`, diffed against `3d03b704`. Each prints `37_fcN=pass`.

Issue 8 recipes cover a diagram block on a doc page. `8-1` expects 404 for an outsider, by page id and drawing id, with a cookie and a personal token, and the same body as a missing page. `8-2` expects `placeholder_link=true`, `drawing_id_kept=true`, and `scene_unchanged=true` after get_page and update_page with the same body. `8-3` expects `block_removed=true` and `drawing_row_kept=true`. `8-4` expects `doc_excalidraw_requests=0` on a page with no diagram. `8-5` expects `label_visible=true`, `scene_secret_visible=false`, and `body_text_has_secret=false`. `8-6` expects `reload_scene_identical=true`, then `retry_banner=true` and `flush_hidden_scene_identical=true` after autosave is aborted and the tab is hidden two seconds later. `8-7` expects `archived_api=true`, `archived_search=false`, and `archived_mcp_status=404`. `8-8` expects a duplicated page and a pasted block to each get a new drawing id with a copied scene, and `original_unchanged=true`. `8-9` expects `before_edit_excalidraw_requests=0`, `saw_spinner=true`, and the library, live collaboration, and image tool hidden after Edit. `8-10` expects script and onload stripped from the stored and served preview. `8-11` expects `foreign_id_rendered=false` and a copied scene owned by the destination page. `8-12` expects `svg_in_drawing_row=true`, `file_storage=false`, and `outsider_status=404`. Each recipe prints `result=pass`. `8-13` expects an outsider save, by the editor body, by create_page, by update_page, and from an archived source page, to copy nothing and to leak nothing. An unknown drawing id and a denied one save the same body and return the same response (`unknown_matches_denied=true`). `test-db-guard` expects `test_db_guard_remote_refused=true`, plus refusals for a comma, a second `@`, and a percent-encoded comma, and acceptance of IPv6 loopback and a percent-encoded local host. It opens no connection.

Issue 4 recipes call `searchVisiblePages`. `4-1` expects `cross_team_visible=false`, `other_personal_visible=false`, `archived_visible=false`, and `archived_child_visible=false`. `4-2` expects `percent_literal=true`, `underscore_literal=true`, and `backslash_literal=true`. `4-3` expects `body_only_visible=true`. `4-4` expects `autosave_visible=true`. `4-5` expects `backfill_body_text=true`. `4-6` expects `table_label_visible=true`, `mention_label_visible=true`, and `date_label_visible=true`. `4-7` hits `GET /api/atlas/search` and expects 200 for `a&b`, `(`, `plan:*`, a quote, a backslash, an emoji, an empty query, and a one-character query. The database URL comes from the environment and is not printed.

Issue 5 recipes hit the team calendar API. `5-1` expects 404 for a non-member on the calendar and event routes, and `other_team_event_visible=false`. `5-2` expects `invalid_range_status=400` and `wrote_invalid=false`. `5-3` expects the stored UTC instant `2026-06-16T01:00:00.000Z`, wall times `kiritimati=2026-06-16 15:00` and `midway=2026-06-15 14:00`, `same_instant=true`, and `all_day_shifted=false`. `5-4` expects `january_contains=true` and `february_contains=true`. Each recipe exits non-zero when `DATABASE_URL` and `TEST_DATABASE_URL` are both unset.

Issue 3 recipes drive the page editor. `3-1` changes rows, columns, a merge, the header, a column width, and a date, then reloads and compares the rendered table and chip. `3-2` checks an 8-column table at 1280 and 390: the page `scrollWidth` stays within `innerWidth`, and the table wrapper scrolls inside the column. `3-3` inserts a date in Pacific/Kiritimati and reads it in Pacific/Midway, with the clock at `2026-03-01T02:00:00Z`. `3-4` pastes a Sheets table and an Excel table and counts rows and cells. `3-5` checks that the table and date baseline files are on disk. `design-lock` prints `tokens_result` from the token lint exit code and `baseline_count` from the PNG files in `tests/visual/baselines`.

Screenshots, one command:

```bash
BASE_URL=http://127.0.0.1:3000 pnpm visual-shots
```

PNGs land in `artifacts/<head sha>/`. Loading shots hold a `_serverFn` request open. Error shots fulfill that request with HTTP 500. The set includes `1280-page-default` and `1280-space-error`. The 390 run opens the drawer, asserts the toolbar overflows (`scrollWidth` greater than `clientWidth`), scrolls it, and prints `scrollWidth` and `innerWidth`. If the toolbar does not overflow, or the page `scrollWidth` is greater than `innerWidth`, the command exits non-zero.

Screenshot baselines use `pnpm verify:baselines` and run only inside `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea` with `ATLAS_PLAYWRIGHT_IMAGE` set to that same reference. The clock is frozen at `2026-01-15T12:00:00Z`, the user is `Ada Baseline`, and animations are disabled. Baseline files live in `tests/visual/baselines`. `design-lock` counts them. The empty-page shot is not one of them. Table and date states are in that directory and in the side-by-side review set.

Stable handles: headings `Create an account`, `Sign in`, `Forgot your password?`, `Set a new password`, `No pages yet`, `Move page`, `Couldn't load this page.`, `Page not found.`. Buttons `Create account`, `Sign in`, `+ New page`, `Open pages`, `Move`, `Archive`, `Retry`, `Try again`, `Save password`. Fields `#name`, `#email`, `#password`, `#confirm`, `#page-title`. Editor `.doc-editor`. Banner `.retry` reads `Couldn't save.` plus `Retry`.

Read `features/README.md` before a journey. A path the map lists and the run did not drive is not verified.

## Evidence

Keep proof in `artifacts/<head sha>/`. `./scripts/verify-all.sh` writes `logs/<recipe>.log` there. Screenshots and `scrollwidth.log` sit next to those logs. Cleanup must not delete this directory.

A proof shows the action and the result. For a page, that is the HTTP status and the following read of the row or the reloaded editor text. For reset, that is the status, `temporaryPassword_len`, the session count, `password_hash_shape`, `user_fields_unchanged`, and the `secret_not_in_logs`, `temp_not_in_logs`, `new_not_in_logs`, and `*_not_in_audit` lines. A screenshot without those lines does not pass a fail condition.

## Cleanup

Stop only the containers this run started:

```bash
docker rm -f atlas-verify atlas-verify-pg atlas-verify-all-pg atlas-5a-unset atlas-5a-empty atlas-5e-short atlas-5e-boundary atlas-5b atlas-5c atlas-5d atlas-5h atlas-fail6-app atlas-fail6-pg
```

Ignore missing names. Do not kill by process name. Leave `artifacts/<head sha>/` in place.

## Helpers

- `./scripts/verify-fail-conditions.sh <recipe>` runs one live check.
- `./scripts/verify-doctor.sh` answers whether this instance is worth driving.
- `pnpm visual-shots` writes the PNG set under `artifacts/<head sha>/`.
- `pnpm lint:tokens` fails on a raw hex color outside the `:root` block in `src/styles.css`, or on a Tailwind arbitrary length. SVG files are skipped.
- `pnpm verify:baselines` compares 1280 screenshots. It exits immediately outside the pinned Playwright image.
- `pnpm exec tsx scripts/baseline-side-by-side.ts` writes old and new PNGs side by side when a committed baseline differs from `origin/main`.

When the app changes, update the feature map with `/maintain-verification-skill`.
