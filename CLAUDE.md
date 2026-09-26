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

- `useLibrary.ts` owns log sources: dropped/uploaded files (persisted in IndexedDB via `idb.ts`), a watched DS folder (File System Access API, `folder.ts`), and the companion server (`companion.ts`), plus background indexing for library summaries.
- `Viewer.tsx` hosts four tabs from `components/viewer/`: Summary (`RobotMap.tsx`), Graphs (`Graphs.tsx`, plus `Moment.tsx`, the sticky card that lists problems and explains the pinned time), Power, and Details (`Overview.tsx`, whose collapsed rows include `EventsView.tsx` as Messages). `showEvents()` in `Viewer.tsx` is how anything opens Messages with a filter. `Compare.tsx` overlays 2–6 logs aligned by match start.
- Charts are uPlot (`TimeChart.tsx`); `chartGroup.ts` shares zoom/pan/cursor/pin state across charts. `time.ts` / `timefmt.ts` handle the match/log/clock time axes.
- Format quirks (20 ms records, active-low status flags, `0xFFFF` voltage = no comms, PDH/PDP current bit-packing, v4 only) are documented in README.md; the tests in `test/` run against the real sample log in `public/sample/` plus synthetic files.

## Repo gotchas

- `prototypes/` is standalone HTML design mockups (the "Robot map" look the app is being restyled to match). They are not part of the build. `node prototypes/extract.mjs` regenerates `prototypes/sample-data.js` from the sample log by loading `src/lib` through Vite SSR.
- The working tree is CRLF (`core.autocrlf=true`, the repo stores LF). When scripting edits, preserve CRLF or the diff fills with line-ending noise.
- `public/sample/` ships a real team-7028 match log as the demo, so it is published with the site.
