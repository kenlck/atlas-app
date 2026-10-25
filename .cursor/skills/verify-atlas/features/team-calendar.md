# Team calendar

A team space has one calendar under Pages. Personal spaces do not. Members add, edit, and delete events from the month view, or from the agenda list when the window is 390px wide.

## Sub-features

- Month view with Today, previous month, and next month.
- One bar for a multi-day event, including an event that crosses a month.
- Side panel to add or edit a title, start, end, all-day flag, and optional note.
- Agenda list at 390px.

## How to get to it (user POV)

Sign in, open a team space, and choose Calendar under Pages. A personal space has no Calendar link. Opening `/s/<personal space id>/calendar` shows Page not found.

## Driving it with Playwright

`pnpm calendar-view` signs up, checks that the personal space has no Calendar link, creates a team, and opens Calendar. It checks the month grid at 1280 and the agenda at 390, adds an all-day event from 2026-10-30 to 2026-11-02, and writes `1280-calendar-empty.png`, `1280-calendar-add-panel.png`, `1280-calendar-month.png`, `1280-calendar-month-bar.png`, and `390-calendar-agenda.png`.

Recipes `5-1`, `5-2`, `5-3`, and `5-4` call the team calendar API on the running app. They read `DATABASE_URL` or `TEST_DATABASE_URL` and exit non-zero when neither is set.

## Gotchas

Timed events are stored as UTC instants. All-day events are stored as dates. The month query takes `timeZone` so a timed event that crosses local midnight is listed in both months.
