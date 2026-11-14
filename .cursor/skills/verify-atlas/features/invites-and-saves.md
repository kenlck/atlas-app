# Invites and saves

A team owner sends one pending invite to an account. A save that is still in flight when that member is removed is not stored. Deleting the sender keeps the invite and clears who sent it. Team settings shows an error when send, remove, or delete fails.

## Sub-features

- `one-invite` stores one pending invite when two sends race, and the second response is 409 `Already invited`. The settings card stays on screen.
- `in-flight-save` does not store a save that is waiting when the member row is removed.
- `former-sender` keeps the invite when the sender is deleted and shows `A former member`.
- `settings-error` shows an error for a failed send, remove, or delete, and does not clear the row or leave settings.
- `create-team-focus` keeps Tab inside the create-team dialog.
- `space-error-layout` left-aligns the space error. The switcher caret uses the muted color.

## How to get to it (user POV)

- Open a team space, then Team settings. Look up an email and choose Send invite.
- Choose Remove on a member, or Delete team, then confirm.
- Open the space switcher and choose Create team.
- A space that fails to load shows `Couldn't load this space.`

## Driving it with Playwright

Preconditions:

- Doctor reports `sign_in_status=200`.
- `DATABASE_URL` points at the local database the app is using.

- **Invite race and the settings message.** Run `./scripts/verify-fail-conditions.sh 18-fc1`. The log shows `fc1_head_status=409`, `fc1_head_message=Already invited`, `fc1_head_rows=1`, `fc1_ui_alert=Already invited`, and `fc1_ui_card_kept=true`.
- **Save in flight.** Run `./scripts/verify-fail-conditions.sh 18-fc2`. The log shows `fc2_head_stored=false` and `fc2_head_status=404`.
- **Deleted sender.** Run `./scripts/verify-fail-conditions.sh 18-fc3`. The log shows `fc3_head_invite_kept=true`, `fc3_head_invited_by=null`, and `fc3_rule=set null`.
- **Settings errors.** Run `./scripts/verify-fail-conditions.sh 18-fc4`. The log shows `fc4_send_alert=Already invited`, `fc4_remove_status=500`, `fc4_remove_row_kept=true`, `fc4_delete_status=409`, and `fc4_delete_stayed=true`.
- **Focus and layout.** Run `./scripts/verify-fail-conditions.sh 18-fc6` and `18-fc7`. The logs show `fc6_head_tab_left_dialog=false` and `fc7_head_caret_matches_muted=true`.

## Gotchas

- The planted half of each recipe exits non-zero on purpose. The head half has to exit 0.
- `invited_by` uses `ON DELETE SET NULL`. The invite row stays.
- Do not compare the planted half with `origin/main`. The fixture and the planted schema are in the repo.
