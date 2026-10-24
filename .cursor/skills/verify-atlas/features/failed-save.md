# Failed save

After a person types, a reload shows the same text. When the save returns 500, the editor keeps the typed text and shows `Couldn't save.` with a `Retry` button.

## Sub-features

- `reload` saves text and shows that same text after a reload.
- `retry` shows the Retry banner when the save server function returns 500, and keeps the typed text.
- `flush` keeps text when the person reloads or leaves during the 800ms debounce.

## How to get to it (user POV)

- Open a page, click the editor, and type.
- Wait until the top bar says `Saved`, then reload.
- If the save fails, the banner `Couldn't save.` appears above the editor with `Retry`.

## Driving it with Playwright

Preconditions:

- Doctor reports `sign_in_status=200`.
- The page route can load. The 500 is produced in the browser with `page.route`, not by stopping the server.

- **Reload and Retry.** Run `./scripts/verify-fail-conditions.sh 3`. The log shows `reload_exact_match=true`, `retry_banner=Couldn't save. Retry`, `text_kept=true`, and a second exact match from the flush script.
- **Screenshot of the banner.** Run `pnpm visual-shots`. `artifacts/<head sha>/1280-page-autosave-retry.png` is the banner. The recipe log is the pass condition. The PNG is the picture of it.

## Gotchas

- The flush path posts to `POST /api/pages/save`. The 500 route in the recipe matches the save server function, not that beacon.
- The banner text is split across a div and a button. The recipe reads `.retry` and expects it to contain `Retry`.
- Do not wait a fixed time to catch the loading skeleton. Hold the server-function request.
