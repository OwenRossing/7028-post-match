# PitView: FRC Driver Station log viewer

Open `.dslog` / `.dsevents` files from the FRC Driver Station and get:

- **A plain-English health report**: brownouts, battery sag, resting voltage, comms drops (and whether you were enabled), robot code going unresponsive, roboRIO rail faults, CAN device errors, loop overruns with the slowest step named, NetworkTables/camera disconnects, outdated radio firmware, and more. Every finding links to the moment it happened.
- **Synced, zoomable graphs**: battery, total current, trip time and packet loss, roboRIO CPU and CAN, Wi‑Fi, and per-channel PDH/PDP current. Auto/teleop/no-comms/brownout bands, error markers, a whole-log navigator, and match/log/clock time axes.
- **Messages**: searchable, filterable errors, warnings, prints, DS and FMS messages. Repeats can be grouped, stack traces expanded, and every message jumps to the graphs.
- **Power**: a channel × time current heatmap and per-channel average/peak/charge used. Name your channels once per team and the names show up everywhere.
- **Compare**: overlay 2–6 logs lined up by match start, with a side-by-side stats table.
- **Library**: every log you open is listed and grouped by day and event, with match labels, min voltage and problem counts. Search it and filter by Matches, Enabled, or Issues.
- **Export**: CSV (visible range or whole log), messages CSV, chart PNGs, and a copy-paste summary for Discord or Slack.
- **Works offline**: it's an installable PWA. Once installed, double-click a `.dslog` in Explorer to open it.
- Dark and light themes, keyboard shortcuts (`?`), and it works on phones.

Everything is parsed in your browser (in a Web Worker). Logs never leave your computer.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Try **Open sample log** on the home screen, or drop your own files anywhere on the page. Driver Station logs live in
`C:\Users\Public\Documents\FRC\Log Files`.

```bash
npm test           # parser + analysis tests (includes a real match log)
npm run build      # static site in dist/
```

## Auto-loading the latest match on the DS laptop

Three ways to do it, from least to most setup:

1. **Connect the folder (Chrome/Edge, no install):** click **Connect DS** and pick `C:\Users\Public\Documents\FRC\Log Files`. PitView
   checks it every 2 s, opens each new log as soon as the DS creates it, and keeps redrawing it while the match is being recorded.
   Chrome remembers the folder. Pick "Allow on every visit" when it asks, and it reconnects on its own next time.
2. **Install it:** in Chrome/Edge, use the install icon in the address bar. It then runs offline in the pits and opens `.dslog` files you
   double-click.
3. **Companion server (optional):** for viewing the DS laptop's logs from *other* devices, or from Firefox/Safari:

   ```bash
   npm run build
   npm run companion -- --lan          # defaults to the DS log folder, port 5801
   # other devices on the network: http://<ds-laptop-ip>:5801
   ```

   The server is read-only, has no dependencies, serves only `.dslog`/`.dsevents` files from that folder, and binds to localhost unless
   you pass `--lan`. Options: `--dir <folder>`, `--port <n>`. A hosted PitView can also connect to it at `http://localhost:5801` from
   the **Connect DS** menu.

No server is *needed* for any of the above. Parsing a match takes a few milliseconds in the browser.

## Deploying

`.github/workflows/deploy.yml` tests, builds and publishes to GitHub Pages on every push to `main`. In the repo settings, set
**Pages → Source** to **GitHub Actions**. The build uses relative paths, so it works under any sub-path, from the companion, or on any
static host.

> `public/sample/` holds a real Qualification 22 log from MNST (team 7028) as the demo. It ships with the site, so remove it or swap it
> out before publishing if you'd rather not share it.

## Project layout

```
src/lib/dslog.ts        .dslog decoder (v4: status flags, REV PDH / CTRE PDP currents)
src/lib/dsevents.ts     .dsevents decoder: message splitting, classification, FMS/team/joystick/rail-fault metadata
src/lib/analysis.ts     modes, matches, comms drops, code stalls, stats, findings, library summaries
src/workers/            parsing off the main thread
src/lib/useLibrary.ts   uploads (saved to IndexedDB), watched DS folder, companion, background indexing
src/lib/chartGroup.ts   shared zoom/pan/cursor/pin state across uPlot charts
src/components/         UI (Viewer tabs, Compare, Library, Navigator, TimeChart…)
server/companion.mjs    optional zero-dependency log server for the DS laptop
test/                   tests against the sample log and synthetic files
```

## Notes on the file format

- Records are every 20 ms. Status flags are active-low. The DS writes voltage `0xFFFF` when it hears nothing from the robot. PitView
  treats that as "no comms", and a connected robot that reports no mode bits as "code not responding".
- PDH currents are 10-bit values packed LSB-first, 3 per 32-bit word, plus 4 small channels. PDP currents are 10-bit values packed
  MSB-first, 6 per 64 bits.
- Only format v4 (2022 and later) is supported.

Format references: [AdvantageScope](https://github.com/Mechanical-Advantage/AdvantageScope),
[orangelight/DSLOG-Reader](https://github.com/orangelight/DSLOG-Reader), and [frcture](https://frcture.readthedocs.io).
