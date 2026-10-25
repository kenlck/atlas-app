---
name: verify-atlas
description: Drive the Atlas web app on localhost and prove sign-up, sign-in, the personal space, nested pages, and the admin reset API. Use when a change needs a live check, an issue 1 fail-condition recipe, or screenshots of the running app.
---

# Verify Atlas

Drive the running Atlas app the way a person does. The recipes shell out to Playwright and curl. They print raw status lines. They do not print `ADMIN_API_SECRET`, passwords, session cookies, or database URLs.

On load, every driver refuses a `BASE_URL` whose scheme is not `http` or whose host is not `localhost`, `127.0.0.1`, or `::1`. The recipe script applies the same host check to `DATABASE_URL` before `psql` or Docker uses it. The scheme has to be `postgres` or `postgresql`.

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
```

Each recipe prints `START <utc> sha=<head>` and `END <utc> sha=<head>`. A non-zero exit means that check failed. `5d` reads `docker logs` for its own container and greps the full `admin_audit` row. `5f` and `5g` grep that audit row for the secret, the temporary password, and the new password. `5a`, `5e`, `5b`, `5c`, `5d`, `5h`, and `6` start their own containers from `ATLAS_IMAGE` (default `atlas-app`). `5h` uses a fresh process so the in-memory rate limit starts at zero. `5f` performs two resets on the shared app. `5g` performs one more. That stays under the limit of five. Recipe `5b` does not time requests. Constant-time comparison is the unit test `rejects a wrong secret, returns a temp password once, locks the user, and audits` in `tests/admin-reset.test.ts`.

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
