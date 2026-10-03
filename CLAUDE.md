# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PitView: a client-side React 19 + TypeScript PWA (Vite) for viewing FRC Driver Station `.dslog` / `.dsevents` files. All parsing happens in the browser; logs never leave the machine. See README.md for features and the file-format notes.

## Commands

```bash
npm run dev          # vite dev server, http://localhost:5173 (honors PORT)
npm test             # vitest run (test/**/*.test.ts only)
npx vitest run test/time.test.ts   # single test file
npm run typecheck    # tsc -b --noEmit
npm run build        # tsc -b && vite build -> dist/
npm run companion    # optional read-only log server for the DS laptop (server/companion.mjs)
```

CI (`.github/workflows/deploy.yml`) runs `npm test` and `npm run build` on push to `master`, then deploys `dist/` to GitHub Pages. Vite `base` is `./` so the build works on sub-paths and from disk.

## Architecture

Data flow: file bytes → `src/lib/dslog.ts` / `dsevents.ts` (binary decoders) → `src/lib/analysis.ts` (modes, matches, comms drops, stats, findings) → UI. Parsing runs in `src/workers/parse.worker.ts` via `workerClient.ts` / `useParsed.ts`, keeping the main thread free.

- A match (`LogEntry`) can carry attached logs (`entry.extras`: roboRIO/CTRE `.wpilog`). They are added any time via `useLibrary.attachExtras` (dropped files pick their matches by the log's own clock, `aggregate.matchesForSpan`; the Viewer's menu targets one match), persisted in IndexedDB (`kv.attachments`, bytes in `files`) and re-applied by key in `setEntries`, so they survive folder rescans. `versionKey` includes them (parse cache); `summaryKeyOf` is DS-only (library summaries). The worker's `describeExtra` (`extras.ts`) reads each one and `alignWPILog` (`aggregate.ts`) finds its offset to the DS timeline: shared console messages, then enabled periods, then `systemTime`. Entry names (`DS:enabled`, `messages`, `systemTime`) come from WPILib's DataLogManager and are unverified against a real robot log. `.hoot` is rejected with conversion instructions (closed format).
- `useLibrary.ts` owns log sources: dropped/uploaded files (persisted in IndexedDB via `idb.ts`), a watched DS folder (File System Access API, `folder.ts`), and the companion server (`companion.ts`), plus background indexing for library summaries.
- `Viewer.tsx` hosts four tabs from `components/viewer/`, all built from folded rows that start closed and are driven by ↑ ↓ Space/Enter: Board (`Board.tsx`, the home screen for a match, with `Inspector.tsx` for the Enter drill-down and `MatchStrip.tsx`), Graphs (`Graphs.tsx`: one row per signal with a `Strip.tsx` of the visible range, unfolding to a uPlot chart; power channels are a folded group; `Moment.tsx` is the sticky card that explains the pinned time), Messages (`EventsView.tsx`) and Info (`Info.tsx`). Each page listens for its keys on `window` in the capture phase and stops the ones it handles, so `Viewer.tsx`'s shortcuts only see the rest. `jumpTo(t, { signal })` opens Graphs with that row unfolded; `showEvents()` opens Messages with a filter. `Compare.tsx` overlays 2–6 logs aligned by match start.
- The Board's rows come from `src/lib/board.ts` (six columns; row ids are stable across matches and double as metric keys). The worker saves `boardMetrics()` into each library summary, and `src/lib/baseline.ts` judges a match against the robot's previous 15 matches (red = 2+ SD on the worse side, needs 5 matches). Only the sample log gets synthetic demo history. `classifyHistory()` picks those matches and gives every library log a used/not-used reason; the Board and the Library panel's "Compared against" card both call it, so the panel shows exactly what is compared. Bump `SUMMARY_VERSION` in `useLibrary.ts` when summaries gain fields or board row ids/definitions change.
- Interpretation rules that are easy to get wrong: 12 V roboRIO rail dropouts count as brownouts (`analysis.rail12`, `railDropouts()`); a "program froze" needs a 100 ms+ gap while enabled and away from a mode change (`STALL_MIN`), because single-packet gaps and the ones at auto/teleop changes are normal.
- Charts are uPlot (`TimeChart.tsx`); `chartGroup.ts` shares zoom/pan/cursor/pin state across charts. `time.ts` / `timefmt.ts` handle the match/log/clock time axes.
- Format quirks (20 ms records, active-low status flags, `0xFFFF` voltage = no comms, PDH/PDP current bit-packing, v4 only) are documented in README.md; the tests in `test/` run against the real sample log in `public/sample/` plus synthetic files.

## Repo gotchas

- `prototypes/` is standalone HTML design mockups (the "Robot map" look the app is being restyled to match). They are not part of the build. `node prototypes/extract.mjs` regenerates `prototypes/sample-data.js` from the sample log by loading `src/lib` through Vite SSR.
- The working tree is CRLF (`core.autocrlf=true`, the repo stores LF). When scripting edits, preserve CRLF or the diff fills with line-ending noise.
- `public/sample/` ships a real team-7028 match log as the demo, so it is published with the site.
