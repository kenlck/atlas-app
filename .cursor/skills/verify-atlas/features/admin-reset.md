# Admin reset

`POST /api/admin/reset-password` sets a temporary password when the request carries `ADMIN_API_SECRET`. The person signs in with that password, lands on `/set-password`, and cannot use the rest of the app until they save a new password. The reset route stays hidden when the secret is unset, empty, or shorter than 32 characters.

## Sub-features

- `hidden` returns an empty 404 when the secret is unset, empty, or short.
- `unauthorized` returns 401 for a missing, short, or long wrong bearer.
- `reset` returns one temporary password, ends sessions, and leaves the secret and both passwords out of the container log.
- `locked` returns 403 from the save API and `update-user` while `must_change_password` is set. Change-password and sign-out still succeed.
- `limited` returns 429 on the sixth wrong bearer even when each request sends a different `X-Forwarded-For`.

## How to get to it (user POV)

- There is no reset form. `/forgot-password` tells the person to ask whoever runs Atlas.
- After a reset, sign-in opens `Set a new password`.
- `Save password` stores the new password. `Sign out` returns to `/sign-in`.

## Driving it with Playwright

Preconditions:

- `ATLAS_IMAGE` is the image built from this head.
- `ATLAS_CONTAINER` is the app container for recipe `5f`.
- `ADMIN_API_SECRET` in the main container is at least 32 characters.
- Run `5h` against its own container. The main container's rate limit is a separate counter.

- **Hidden secret.** Run `./scripts/verify-fail-conditions.sh 5e`. The log shows `status_unset=404`, `status_empty=404`, `status_short=404`, and `body_bytes_*=0`.
- **Wrong bearer.** Run `./scripts/verify-fail-conditions.sh 5b`. The log shows `401` for the missing, short, and long bearers, and `bearer_bodies_match=true`.
- **Reset and logs.** Run `./scripts/verify-fail-conditions.sh 5f`. The log shows `reset_status=200`, `temporaryPassword_len=24`, `session_count=0`, `secret_not_in_logs=true`, `temp_not_in_logs=true`, and `new_not_in_logs=true`.
- **Lock.** Run `./scripts/verify-fail-conditions.sh 5g`. The log shows `403` for the locked save and `update-user`, `name_after_update_user=Lock Name`, a path other than `/set-password` after `Save password`, and a null session after sign-out.
- **Rate limit.** Run `./scripts/verify-fail-conditions.sh 5h` before `5f` if they would share a process. The log shows `attempt_1` through `attempt_5` as `401` and `attempt_6=429`.

## Gotchas

- Do not print the secret, the temporary password, or the new password. The recipes write them to mode `0600` files and delete those files.
- An unknown email on a configured server is a JSON 404. That is a different response from the empty 404 in `5e`.
- `5f` and `5g` each perform a real reset. Two resets from one IP fit under the limit of five. `5h` would consume the whole window, so it uses another container.
- Recipe `all` is not this check. It calls the handler in-process and then Vitest drops the schema.
