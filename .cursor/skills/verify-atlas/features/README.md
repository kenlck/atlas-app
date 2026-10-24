# Atlas verification map

This directory is the maintained source for verifying Atlas. Read it before driving the app, then use the matching feature file.

## Baseline preconditions

- Launch Atlas at `http://127.0.0.1:3000` with a disposable Postgres database.
- `BETTER_AUTH_URL` equals `BASE_URL`.
- `ADMIN_API_SECRET` is set to at least 32 characters, except for recipes `5a` and `5e`.
- `./scripts/verify-doctor.sh` reports `sign_in_status=200` and the expected head SHA.
- Drive only the instance this run started.

## Driving conventions

- Run the full check with `./scripts/verify-all.sh`. It writes `artifacts/<head sha>/`.
- Start every recipe from a fresh sign-up unless its preconditions say otherwise.
- Prefer roles and accessible names over coordinates.
- Run issue 1 checks through `./scripts/verify-fail-conditions.sh`.
- Run screenshots through `pnpm visual-shots`.
- Keep `artifacts/<head sha>/` after cleanup.

## Proof and skip reporting

- Record the command, the HTTP status, and the state after the action.
- A journey that cannot run reports the command and the missing precondition.
- Do not mark a skipped entry point as verified through a different one.

## Feature entry contract

Each feature file has an H1, one paragraph, then these H2 sections in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with Playwright`, `Gotchas`.

## Features

- [Sign up and sign in](./sign-up-and-sign-in.md) covers account creation, bad credentials, and the signed-out gate.
- [Personal space and nested pages](./personal-space.md) covers the private space, creating a page, and nesting it.
- [Admin reset](./admin-reset.md) covers the reset route, the lock, and the log grep.
- [Failed save](./failed-save.md) covers reload and the Retry banner.
- [Tables and dates](./tables-and-dates.md) covers editor tables, date chips, and paste from Sheets or Excel.
