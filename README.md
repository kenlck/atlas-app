# Atlas

Personal space and nested pages. One Docker image.

## Environment

The app is configured only by:

- `DATABASE_URL` — Postgres connection string (direct URL for migrations)
- `BETTER_AUTH_SECRET` — auth signing secret from the environment. Production refuses to boot if it is missing or empty.
- `BETTER_AUTH_URL` — public origin, e.g. `http://localhost:3000`. This is the better-auth base URL. Production refuses to boot if it is missing or empty.
- `ADMIN_API_SECRET` — required in production (the process refuses to boot if it is missing or empty). If it is unset, empty, or shorter than 32 characters, `POST /api/admin/reset-password` returns 404.
- `TRUST_PROXY` — optional. Default off. When `1`, the client IP is the hop `TRUSTED_PROXY_HOPS` from the right of `X-Forwarded-For` (default 1, the rightmost hop). Admin reset and the auth rate limiter use that same address. Otherwise both use the TCP socket peer.
- `TRUSTED_PROXY_HOPS` — optional. Default `1` when unset. A set value must be a positive integer, or production refuses to boot.

## Local

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

`pnpm db:migrate` applies the SQL in `drizzle/` to `DATABASE_URL`.

## Docker

Build:

```bash
docker build -t atlas-app .
```

Migrate (documented command). Uses the same image; pass `DATABASE_URL` only. Use the direct URL, not a pooler. Local Postgres without TLS should include `sslmode=disable`; hosted Postgres should use `sslmode=require`.

```bash
docker run --rm -e DATABASE_URL atlas-app node migrate.mjs
```

Run:

```bash
docker run --rm -p 3000:3000 \
  -e DATABASE_URL \
  -e BETTER_AUTH_SECRET \
  -e BETTER_AUTH_URL \
  -e ADMIN_API_SECRET \
  atlas-app
```

Nitro `node-server` listens on `PORT` (default 3000).

## Admin password reset

`POST /api/admin/reset-password` with `Authorization: Bearer <ADMIN_API_SECRET>` and body `{ "email": "..." }`. The response returns a temporary password once.

Rate limiting and the audit `caller_ip` use the TCP socket peer address (`getRequestIP`) by default. Client-supplied `X-Forwarded-For` is ignored unless `TRUST_PROXY=1`, in which case the client IP is counted from the right of `X-Forwarded-For` (`TRUSTED_PROXY_HOPS`, default 1). The auth rate limiter uses that same address. Do not set `TRUST_PROXY=1` unless every hop in front of the app is a trusted reverse proxy.
