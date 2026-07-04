---
name: replicate-ui-watch
description: One-shot hands-off watcher for /replicate-ui. Waits for the NEXT settled component pick (⌘⇧S → click) in ANY macOS app, then auto-runs the replicate-ui loop on it using the pick-time crop — no IDE interaction needed — pops a desktop notification when the replica is ready, and stops. Use when the user wants to pick a component and walk away. Launch via `/loop /replicate-ui-watch` (dynamic, self-paced).
---

# replicate-ui-watch — pick-and-walk-away auto extraction

You are the per-tick body of a **dynamic `/loop`**. The user starts you with
`/loop /replicate-ui-watch` (no interval), picks a component in any app, and leaves. You
poll `get_selection`, wait out a **10s debounce** (so multi-select finishes), then run the
`replicate-ui` skill on the pick using its **pick-time `crop_path`** (valid even with the app
closed), notify, and **stop** — this is ONE-SHOT.

Requires the `echo` MCP server connected (the `get_selection` tool). If it isn't,
tell the user to start it and **omit** the wakeup (end the loop).

State lives in `.replicate-ui/.watch-state.json` (in the cwd): `{ "baseline": <crop_path|null>,
"polls": <int> }`. `baseline` = the pick that already existed when watching started, which you
must IGNORE so a stale selection never fires.

`age_seconds` from `get_selection` is "time since the last click" — every ⇧+click rewrites the
selection and resets it to 0, so requiring `age_seconds >= 10` naturally waits until the user
has stopped picking (handles multi-select for free).

## Loop control (dynamic /loop)
- To **keep waiting**: call `ScheduleWakeup { delaySeconds: 75, prompt: "/loop /replicate-ui-watch",
  reason: "waiting for a settled component pick" }`, then end your turn.
- To **stop** (after a successful extraction, on give-up, or on error): just **omit**
  `ScheduleWakeup`. The loop ends.

**Pick signature (identity).** Distinguish a NEW pick from the pre-existing one by a SIGNATURE,
not `crop_path` alone (a failed crop is null, and after a binary restart filenames can repeat):
`sig = present ? "<count>|<elements[0].click.x>,<elements[0].click.y>|<elements[0].crop_path>" : "none"`.
The click point is the exact screen coords of the pick, so it changes for any genuinely new pick
even when the crop failed (null) or a filename recurs.

## Procedure (run this every tick)

0. **Self-guard (standalone misuse).** This skill is the body of a dynamic `/loop` and only
   re-arms via `ScheduleWakeup`, which has no effect unless `/loop` is driving it. If you were
   invoked as a bare `/replicate-ui-watch` (no `/loop`), do NOT silently set a baseline and claim
   "watching" — tell the user to relaunch as **`/loop /replicate-ui-watch`** and STOP.

1. **MCP check.** Ensure `get_selection` is available. If not: tell the user to open VibeExtract
   → Start MCP server (and `claude mcp add` if needed), then STOP (omit wakeup).

2. **Read state** `.replicate-ui/.watch-state.json`.
   - **Missing → FIRST TICK (set baseline):** call `get_selection`, compute `baseline = sig`.
     Write `{baseline, polls: 0}` (create `.replicate-ui/` if needed). Tell the user concisely:
     *"Watching — go pick a component in any app (⌘⇧S → click), wait ~10s, and walk away. I'll
     extract it and notify you when the replica's ready."* Then **keep waiting** (ScheduleWakeup)
     and end.
   - **Present → read** `baseline` and `polls`.

3. **Give-up cap.** Increment `polls`. If `polls > 48` (~60 min at 75s): tell the user no pick
   arrived and you're stopping; delete the state file; **STOP** (omit wakeup).

4. **Poll.** Call `get_selection`.
   - If `present` is false, or `age_seconds` is null/`< 10` → not settled yet. Write
     `{baseline, polls}` and **keep waiting** (ScheduleWakeup), end.
   - If `present` and `age_seconds >= 10`: compute `cur = sig`.
     - If `cur == baseline` → still the stale pre-existing pick (or nothing new). Write
       `{baseline, polls}` and **keep waiting**, end.
     - Else → a **NEW settled pick**. Go to step 5. (This fires even when `crop_path` is null —
       a failed crop still has a distinct click point — so a real pick is never missed.)

5. **Extract (trigger once).** Run the replication on the selected element(s):
   - Derive the app slug from `elements[0].app_path` basename, lowercased/sanitized
     (e.g. `Microsoft Excel` → `excel`, `Visual Studio Code` → `vscode`). Output dir
     `.replicate-ui/<app>/`.
   - Invoke the **`replicate-ui`** skill (via the Skill tool) in COMPONENT-ONLY mode on the
     current selection. For a HEALTHY pick (`ax_shallow` false) the app may be CLOSED — use each
     element's `crop_path` PNG as the native reference (Read it; it's the `compare_images`
     `a_path`). Let replicate-ui run its perceive→generate→verify loop to the usual score bar.
   - **Shallow / Electron caveat.** If `elements[0].ax_shallow` is true (or `crop_path` is null),
     there is no usable pick-time crop — replicate-ui must re-resolve via `extract_component` at
     the click point, which needs the app **still running** (and for asset harvest, a debug port).
     If the user has closed an Electron app, note in the final report that fidelity is limited and
     they should re-pick with the app open. The "walk away" promise holds cleanly for native/AX
     apps (Excel, Acrobat — icons come from the crop's pixels); Electron components need the app up.

6. **Notify + STOP.** When extraction completes:
   - Fire a desktop notification:
     `osascript -e 'display notification "Replica ready: <app>" with title "VibeExtract" sound name "Glass"'`.
   - Delete `.replicate-ui/.watch-state.json` (so a future watch run re-baselines).
   - **Omit ScheduleWakeup** (one-shot done). Report the final score + the written
     `.replicate-ui/<app>/index.html` path.

## Notes
- One-shot: ends after the first new settled pick is extracted. The user relaunches
  `/loop /replicate-ui-watch` for the next clone.
- Never fire on the baseline (pre-existing) selection — only on a pick whose `crop_path`
  differs from the baseline recorded on the first tick.
- Keep tick output short while waiting (a one-line status); save the detail for the trigger.
