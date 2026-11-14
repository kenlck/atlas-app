# View and edit

A page or whiteboard opens in View. Editing starts from the header switch, and a new page opens in Edit with the title focused. The mode stays in this tab only.

## Sub-features

- `view` keeps the editor and the whiteboard from changing when the page is read.
- `edit` shows the accent rule, the Editing chip, and the save status, and typing saves.
- `done` flushes a pending save and returns to View. A failed save stays in Edit with Retry.
- `reload` returns to View.
- `new-page` opens in Edit with the title focused.
- `narrow` collapses the switch to one icon button at 390px without a horizontal scroll.
- `whiteboard` uses Excalidraw view mode until Edit.
- `endpoints` keep `update_page` and `POST /api/pages/save` on the same statuses as `3d03b704`.
- `foreign-diagram` shows a drawing preview in View, including one owned by another page, and copies it on the first switch to Edit.

## How to get to it (user POV)

- Open a page. The header shows View and Edit. The body does not accept typing.
- Choose Edit. A 2px accent line sits on the header, with an Editing chip and Done.
- Choose Done. The page returns to View after the save finishes.
- Create a page with `+ New page`. The title is focused and Edit is already on.
- Narrow the window to 390px. The View | Edit pair becomes one icon button.

## Driving it with Playwright

Preconditions:

- Doctor reports `sign_in_status=200`.
- Drive the instance this run started.

- **Read-only body.** Run `./scripts/verify-fail-conditions.sh 37-fc1`. The log shows `fc1_save_requests=0`, `fc1_text_unchanged=true`, and `37_fc1=pass`.
- **Edit chrome and save.** Run `./scripts/verify-fail-conditions.sh 37-fc2`. The log shows `fc2_rule=true`, `fc2_chip=true`, `fc2_status=true`, and `37_fc2=pass`.
- **Done flushes.** Run `./scripts/verify-fail-conditions.sh 37-fc3`. The log shows `fc3_persisted=true` and `37_fc3=pass`.
- **Failed save.** Run `./scripts/verify-fail-conditions.sh 37-fc4`. The log shows `fc4_stayed=true`, `fc4_discard=0`, `fc4_retry_saved=true`, and `37_fc4=pass`.
- **Reload.** Run `./scripts/verify-fail-conditions.sh 37-fc5`. The log shows `fc5_view=true` and `37_fc5=pass`.
- **New page.** Run `./scripts/verify-fail-conditions.sh 37-fc7`. The log shows `fc7_edit=true`, `fc7_title_focused=true`, and `37_fc7=pass`.
- **390 icon.** Run `./scripts/verify-fail-conditions.sh 37-fc8`. The log shows `fc8_icon_to_edit=true`, `fc8_390_scroll=false`, `fc8_1280_scroll=false`, and `37_fc8=pass`.
- **Whiteboard view.** Run `./scripts/verify-fail-conditions.sh 37-fc9`. The log shows `fc9_save_requests=0`, `fc9_scene_unchanged=true`, and `37_fc9=pass`.
- **Save endpoints.** Run `./scripts/verify-fail-conditions.sh 37-fc10`. The log shows `fc10_save_status=204`, `fc10_update_status=200`, and `37_fc10=pass`.
- **Foreign diagram.** Run `./scripts/verify-fail-conditions.sh 37-fc11`. The log shows `fc11_view_preview_owned=true`, `fc11_view_preview_foreign=true`, `fc11_view_save=0`, `fc11_view_clone=0`, `fc11_edit_clone=1`, `fc11_edit_save=1`, `37_fc11_planted_exit=1`, `37_fc11_planted_skip_exit=1`, and `37_fc11=pass`.

## Gotchas

- The mode is React state. A reload opens View. Nothing is written to storage or the URL.
- Clicking the body does not turn Edit on. Choose the switch or the 390 icon.
- Done is the only way the failed-save banner offers to leave, and it does not leave while the save is still failing. There is no Discard.
- At 1280 the control is a radio group named View and Edit, so the diagram block's Edit button stays a separate button.
