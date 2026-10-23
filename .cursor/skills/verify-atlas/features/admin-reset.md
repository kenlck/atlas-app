# Admin reset

`POST /api/admin/reset-password` sets a temporary password when the request carries `ADMIN_API_SECRET`. The person signs in with that password, lands on `/set-password`, and cannot use the rest of the app until they save a new password. The reset route stays hidden when the secret is unset, empty, or shorter than 32 characters.

## Sub-features

- `hidden` returns an empty 404 when the secret is unset, empty, 12 characters, or 31 characters.
- `unauthorized` returns 401 for a missing, short, or long wrong bearer. Constant-time comparison is the unit test, not a live timing run.
- `sessions` ends every session for the user.
- `logs` leaves the secret, the temporary password, and the new password out of the container log and out of every `admin_audit` column.
- `reset` ignores a caller-supplied password, returns a temporary password once, stores a scrypt hash, and leaves other user fields unchanged.
- `locked` signs in to `/set-password` first, then returns 403 from a GET server function, a mutating server function, the save API, and `update-user`.
- `limited` returns 429 on the sixth wrong bearer even when each request sends a different `X-Forwarded-For`.

## How to get to it (user POV)

- There is no reset form. `/forgot-password` tells the person to ask whoever runs Atlas.
- After a reset, sign-in opens `Set a new password`.
- `Save password` stores the new password. `Sign out` returns to `/sign-in`.

## Driving it with Playwright

Preconditions:

- `ATLAS_IMAGE` is the image built from this head.
- `ADMIN_API_SECRET` in the main container is at least 32 characters.
- Run `5h` against its own container. The main container's rate limit is a separate counter.
- `5c` and `5d` also use their own containers so their resets do not consume the shared limit.

- **Unset or empty secret.** Run `./scripts/verify-fail-conditions.sh 5a`. The log shows `status_unset=404`, `status_empty=404`, and `body_bytes_*=0`.
- **Short secret.** Run `./scripts/verify-fail-conditions.sh 5e`. The log shows `status_short=404`, `status_boundary=404`, and `body_bytes_*=0`. `boundary` is 31 characters.
- **Wrong bearer.** Run `./scripts/verify-fail-conditions.sh 5b`. The log shows `401` for the missing, short, and long bearers, `bearer_bodies_match=true`, and `constant_time_unit_test` naming `tests/admin-reset.test.ts`.
- **Sessions.** Run `./scripts/verify-fail-conditions.sh 5c`. The log shows `session_count=0` and `sessions_ended=true`.
- **Logs and audit.** Run `./scripts/verify-fail-conditions.sh 5d`. The log shows `secret_not_in_logs=true`, `temp_not_in_logs=true`, `new_not_in_logs=true`, and the same three `*_not_in_audit=true`.
- **Supplied password.** Run `./scripts/verify-fail-conditions.sh 5f`. The log shows `supplied_password_field=ignored`, `supplied_password_verifies=false`, `second_temporary_differs=true`, `password_hash_shape=true`, `user_fields_unchanged=true`, `audit_rows=2`, and `*_not_in_audit=true`.
- **Lock.** Run `./scripts/verify-fail-conditions.sh 5g`. The log shows `first_path=/set-password` before any other navigation, `locked_get_server_fn=403`, `locked_post_server_fn=403`, `403` for the save API and `update-user`, and `name_after_update_user=Lock Name`.
- **Forgot password.** Run `./scripts/verify-fail-conditions.sh forgot-password`. The log prints the note and `form_count=0`.
- **Rate limit.** Run `./scripts/verify-fail-conditions.sh 5h`. The log shows `attempt_1` through `attempt_5` as `401` and `attempt_6=429`.

## Gotchas

- Do not print the secret, the temporary password, or the new password. The recipes write them to mode `0600` files and delete those files.
- An unknown email on a configured server is a JSON 404. That is a different response from the empty 404 in `5a` and `5e`.
- `5f` performs two resets on the shared app and `5g` performs one. `5c` and `5d` use other processes. `5h` would consume a whole window, so it uses another container.
- Recipe `6` publishes Postgres on `127.0.0.1` only. It waits until the log says the server is ready twice, then checks that published port, before migrate. The app container uses host networking so it can reach that port.
- Recipe `all` is not this check. It calls the handler in-process and then Vitest drops the schema.
