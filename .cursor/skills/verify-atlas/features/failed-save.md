# Failed save

After a person types, a reload shows the same text. When the save returns 500, the editor keeps the typed text and shows `Couldn't save.` with a `Retry` button.

## Sub-features

- `reload` saves text and shows that same text after a reload.
- `retry` shows the Retry banner when the save server function returns 500, and keeps the typed text.
- `flush` keeps text when the person reloads or leaves during the 800ms debounce. The unload request to `POST /api/pages/save` sends `Origin`. A body over 64 KB skips that flush and stays on the debounced save.
- `new-page` stops a hung or failed flush before creating another page. The banner says `Couldn't save. The new page was not created.` The typed text and the open URL stay. A hung flush ends within five seconds.
- `conflict` shows the same `.retry` strip when a save returns 409. The text is `Someone else changed this page since you opened it.` The only button is `Reload`. The unsaved text stays on screen and the editor is read-only.
- `too-big` shows that same error-soft `.retry` strip when a save returns 413. The text is `This page is too big to save (over 1 MB). Move some content to a sub-page.` There is no Retry button. The typed text and the session draft stay, and the save status reads `Not saved`.

## How to get to it (user POV)

- Open a page, click the editor, and type.
- Wait until the top bar says `Saved`, then reload.
- If the save fails, the banner `Couldn't save.` appears above the editor with `Retry`.
- With unsaved text, choose `+ New page`, then `Page`. If the save fails or hangs, stay on this page.

## Driving it with Playwright

Preconditions:

- Doctor reports `sign_in_status=200`.
- The page route can load. The 500 is produced in the browser with `page.route`, not by stopping the server.

- **Reload and Retry.** Run `./scripts/verify-fail-conditions.sh 3`. The log shows `reload_exact_match=true`, `retry_banner=Couldn't save. Retry`, `text_kept=true`, and a second exact match from the flush script. `pnpm autosave-flush` also shows `unload_origin_matches=true` and `unload_save_accepted=true`. A body over 64 KB is the unit test `flushes a body at the 64 KB cap and skips a larger one` in `tests/autosave-leave.test.ts`.
- **Screenshot of the banner.** Run `pnpm visual-shots`. `artifacts/<head sha>/1280-page-autosave-retry.png` is the banner. The recipe log is the pass condition. The PNG is the picture of it.
- **New page after a failed or hung save.** Run `./scripts/verify-fail-conditions.sh 18-fc5`. The log shows `fc5_fail_text_kept=true`, `fc5_fail_url_kept=true`, `fc5_hang_timed_out=true`, and `fc5_hang_text_kept=true`. The planted run exits non-zero.
- **Someone else saved.** Run `./scripts/verify-fail-conditions.sh 50-fc3`. The log shows `50_fc3_head_banner=true`, `50_fc3_head_reload=1`, `50_fc3_head_retry=0`, `50_fc3_head_readonly=true`, and `50_fc3_head_text_visible=true`. Screenshots are `50-fc3-conflict-1280.png` and `50-fc3-conflict-390.png`.
- **Body over 1 MB.** Run `./scripts/verify-fail-conditions.sh 57-fc1`. A forced 413 shows the too-big copy, no Retry, the typed text, a kept draft, and `Not saved`. The log shows `57_fc1_head_exact=true`, `57_fc1_head_retry=false`, `57_fc1_head_status=true`, `57_fc1_planted_exit=1`, and `57_fc1_head_exit=0`.
- **Several autosaves.** Run `./scripts/verify-fail-conditions.sh 50-fc6`. One person types three times. The log shows `50_fc6_head_statuses=200,200,200` and `50_fc6_head_banner=false`.

## Gotchas

- The flush path posts to `POST /api/pages/save`. The 500 route in the recipe matches the save server function, not that beacon.
- The banner text is split across a div and a button. The recipe reads `.retry` and expects it to contain `Retry`.
- Do not wait a fixed time to catch the loading skeleton. Hold the server-function request.
