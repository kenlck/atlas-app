# Atlas

Personal space and nested pages. One Docker image.

## Environment

The app is configured only by:

- `DATABASE_URL` — Postgres connection string (direct URL for migrations)
- `BETTER_AUTH_SECRET` — auth signing secret
- `BETTER_AUTH_URL` — public origin, e.g. `http://localhost:3000`
- `ADMIN_API_SECRET` — optional. If unset or shorter than 32 characters, `POST /api/admin/reset-password` always returns 404

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
