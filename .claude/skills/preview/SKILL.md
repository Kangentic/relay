---
description: Launch a local preview of the relay's /admin dashboard, seeded with realistic history so the charts actually render. Use when reviewing or changing anything visual in src/http/adminPage.ts, or when you need to see the dashboard live rather than infer it from tests.
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(npx:*), Bash(npm:*), Bash(node:*), mcp__kangentic__kangentic_browser_navigate, mcp__kangentic__kangentic_browser_screenshot, mcp__kangentic__kangentic_browser_console, mcp__kangentic__kangentic_browser_list_panes
argument-hint: [--port 8099] [--days 40] [--no-traffic]
---

# Preview - the /admin dashboard, live

The relay is a headless byte-forwarder with exactly one visual surface: the `/admin` dashboard
in `src/http/adminPage.ts`. Tests can prove the page is served, that its inline script parses,
and that the endpoint sends every field the page reads. **None of that proves it looks right.**
Axis labels collide, a series renders flat because a field is `null`, a chart is empty because
a bucket has no rows. Those are only visible by looking.

The second problem is that a freshly started relay has no history, so every panel renders
"No history in this range yet". A preview of an empty dashboard answers nothing. This skill
seeds a realistic file first.

**Usage:** `/preview [--port 8099] [--days 40] [--pairs 3] [--no-traffic]`

## What it does

`scripts/preview.mjs`:

1. Seeds `.kangentic/preview-history.ndjson` (gitignored) with roughly 11k rows spanning 40
   days, **already tiered** the way a long-running relay's file actually looks: hourly rows
   beyond 30 days, 5-minute rows from 30 days to 48 hours, 1-minute rows for the last 48 hours.
   So the `1h` through `1y` range buttons all have real data behind them.
2. Includes day/night load cycles, occasional bursts, restart markers, and a sprinkle of
   rejects and teardowns, so every chart and the restart rules have something to draw.
3. Starts a real relay in-process with `ADMIN_ENABLED=true` pointed at that file, sampling
   every 10 seconds instead of 60 so new points appear while you watch.
4. Opens a few real WebSocket pairs that keep sending, so the live tiles are not all zeros.

Seeding goes through the relay's own `serializeHistoryRow`, so the preview file is byte-identical
in format to what the recorder writes. If the wire format changes, the preview follows it rather
than drifting into a comfortable lie.

## Steps

1. Ensure dependencies exist (`node_modules` is per-worktree): run `npm install` if missing.
2. Start it in the background, in watch mode:
   ```
   npx tsx watch --clear-screen=false scripts/preview.mjs --port 8099
   ```
   Run it with `run_in_background: true`, then Read the output file for the printed URLs. It
   runs until stopped.

   **Live reload.** `tsx watch` restarts the relay on any source edit, and each start mints a
   fresh recorder instance id that rides on `/admin/data`. The page notices the id changed and
   reloads itself, so editing `adminPage.ts` updates the tab you are already looking at. That
   reload is gated to `127.0.0.1`/`localhost`, so it cannot fire on the production hostname.
3. Confirm the data layer before looking at pixels, so a blank chart is not ambiguous:
   ```
   node -e "fetch('http://127.0.0.1:8099/admin/data?range=172800000').then(r=>r.json()).then(b=>console.log(b.rows.length,'rows',b.meta.servedFrom))"
   ```
   Expect a few thousand rows and `servedFrom file`.
4. **Look at it.** Ask the user to open the task's Browser pane, then drive it:
   - `kangentic_browser_navigate` to `http://127.0.0.1:8099/admin`
   - `kangentic_browser_screenshot` (use `fullPage: true` to catch every panel)
   - `kangentic_browser_console` with `level: "error"` - the page is hand-written inline JS
     with no build step, so a runtime error there is invisible everywhere else
   If no pane is open, `kangentic_browser_list_panes` returns an empty list; ask the user to
   open one rather than guessing at the result.
5. Walk the range buttons (`1h`, `6h`, `48h`, `30d`, `1y`) and the **Table view** toggle. The
   range buttons exercise different retention tiers and different code paths: `1h` and `6h` are
   fine-tier rows, `30d` crosses into aggregated rows where `mean` becomes non-null, and `1y`
   pulls all three tiers at once.
6. Stop the background process when done.

## What to actually check

- Every panel has data. An empty one means either a seeding gap or a field the page reads that
  the endpoint does not send.
- Axis labels and the legend do not collide or overflow at narrow widths.
- Hovering shows the crosshair and tooltip. On `30d`/`1y` the tooltip should read
  `peak (avg N)` for the gauge series; on `1h` it should show only the peak, since raw rows
  carry no mean.
- Restart markers appear as dashed vertical rules.
- Dark mode. The palette has separate light and dark steps, and three light-mode series sit
  below 3:1 contrast, which is why the legend and table view exist. Toggle your OS theme and
  re-screenshot; do not assume the dark values were validated just because the light ones were.
- `Table view` renders and its numbers agree with the charts.

## Scope and limits

This previews **this repo's** relay dashboard only. It is not the cross-repo dev environment the
desktop app and marketing site have; if that is what you want, it is a separate, larger piece of
work and belongs on the board rather than in this skill.

It deliberately does not run behind Cloudflare Access. The production surface is gated at the
edge (see `infra/README.md`), and reproducing that locally would add no signal about the thing
this skill exists to check, which is what the page looks like.
