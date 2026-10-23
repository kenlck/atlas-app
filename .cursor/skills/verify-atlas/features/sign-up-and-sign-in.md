# Sign up and sign in

A person creates an account with name, email, and password, lands in an empty personal space, and can sign in again. A signed-out visit to a page redirects to sign-in. A signed-out save returns 401.

## Sub-features

- `sign-up` creates an account and opens the personal space.
- `sign-in-error` shows `Email or password is incorrect.` for a bad password.
- `signed-out` redirects pages to `/sign-in` and rejects the save API and a page server function with 401.

## How to get to it (user POV)

- Open `/sign-up` and submit `Create account`.
- Open `/sign-in` and submit `Sign in`.
- Open a space URL with no session cookie.

## Driving it with Playwright

Preconditions:

- Doctor reports `sign_in_status=200` at `http://127.0.0.1:3000`.
- `BETTER_AUTH_URL` is that same origin.

- **Sign up.** Open `/sign-up`. Fill `#name`, `#email`, and `#password` (8 characters or more). Choose `Create account`. The heading `No pages yet` appears.
- **Wrong password.** Open `/sign-in`. Fill a known email and a wrong password. Choose `Sign in`. The banner reads `Email or password is incorrect.`
- **Signed-out gate.** Run `./scripts/verify-fail-conditions.sh 2`. The log shows a page status `307` with location `/sign-in`, and `401` for `POST /api/pages/save` and a page server function.
- **Docker sign-up.** Run `./scripts/verify-fail-conditions.sh 6` against the built image. The log shows `migrate_result=migrations_applied`, `signup_status=200`, and `mustChangePassword=False`.

## Gotchas

- After the session cookie is set, mutating auth calls need `Origin` equal to `BETTER_AUTH_URL`.
- The recipe refuses a non-local `BASE_URL` as soon as the script loads.
- Recipe `6` starts its own Postgres container. It does not reuse the database from Launch.
