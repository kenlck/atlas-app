# Page search

Search finds page titles and page text the signed-in user can open. It matches any case-insensitive substring. `%` and `_` in the query are literal characters.

## Sub-features

- Search row at the top of the sidebar, and Ctrl K or Command K from any screen.
- Results grouped into Titles and Content, with a short snippet on content matches.
- Empty state when nothing matches.

## How to get to it (user POV)

Sign in, open a space, and choose Search in the sidebar or press Ctrl K. Type at least two characters. Choose a result to open that page.

## Driving it with Playwright

Open the panel from the Search button. Type a title that exists and read the Titles group. Type a term that is not on any visible page and read `No pages match`. Type a query that contains `%` and confirm the row that literally contains `%`.

Recipes `4-1` through `4-7` run from `./scripts/verify-fail-conditions.sh`. They read `DATABASE_URL` or `TEST_DATABASE_URL` from the environment and do not print it. `4-7` also needs `BASE_URL` on the running app.

## Gotchas

Queries shorter than two characters return no rows. Archived pages, pages under an archived parent, another person's personal pages, and another team's pages stay out of the results. The same `searchVisiblePages` function serves the panel and `GET /api/atlas/search`.
