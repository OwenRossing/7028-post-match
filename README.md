# PitView: FRC Driver Station log viewer

Open `.dslog` / `.dsevents` files from the FRC Driver Station and get:

- **The Board**: one screen per match, built for the DS laptop plugged into a pit TV. Power, Network, RIO, Code, Devices and Performance columns, down to each PDH channel, CAN device and message. Every number is compared with the robot's last 15 matches, and anything 2+ standard deviations worse turns red. Everything starts folded; arrow keys move, <kbd>Space</kbd> unfolds, <kbd>Enter</kbd> opens the detail (history, the moment in the match, related messages), <kbd>J</kbd>/<kbd>K</kbd> jump between red cells and <kbd>X</kbd> ticks one off.
- **Your own numbers**: print `[pv] Flywheel/Spinup = 0.42 s` from robot code and it becomes a Performance row, compared across matches like everything else.
- **A plain-English health report**: brownouts, battery sag, resting voltage, comms drops (and whether you were enabled), robot code going unresponsive, roboRIO rail faults, CAN device errors, loop overruns with the slowest step named, NetworkTables/camera disconnects, outdated radio firmware, and more. Every finding links to the moment it happened.
- **Synced, zoomable graphs**: battery, total current, trip time and packet loss, roboRIO CPU and CAN, Wi‑Fi, and every PDH/PDP channel, each as a one-line strip that unfolds into a full chart. The channels together read as a current heatmap; name them once per team (<kbd>N</kbd>) and the names show up everywhere. Auto/teleop/no-comms/brownout bands, error markers, a whole-log navigator, and match/log/clock time axes.
- **Robot logs**: add the roboRIO's `.wpilog` (DataLogManager) to a match, now or any time later. PitView lines it up with the Driver Station log (by shared console messages, then enabled periods, then the robot's clock), tells you which method it used and how sure it is, and keeps it with the match. A log that covers several matches is added to all of them. CTRE Phoenix `.hoot` logs have to be converted to `.wpilog` first (CTRE Owlet, or export from Phoenix Tuner X); then add the `.wpilog` the same way. See [Robot logs](#robot-logs).
- **Messages**: searchable, filterable errors, warnings, prints, DS and FMS messages. Repeats are grouped, stack traces expand, and every message jumps to the graphs.
- **Info**: event, match, robot code and roboRIO versions, controllers, enabled periods and the files behind the log.
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

## Robot logs

A match is the Driver Station's `.dslog` + `.dsevents` plus any robot logs (`.wpilog`) that belong to it. Drop as many files as you like, in any order, from any number of days: PitView sorts them into matches, and the Library groups the matches by day.

- **Chips show what a match holds.** `DS`, `Msgs`, `Rio`, `CTRE` in the Library, and next to the title of the open match. A dashed chip is something that is not there yet.
- **How a robot log finds its match**, best evidence first: the field's own name for the match (event, type and number, from the robot's FMSInfo or the file name), then both machines' wall clocks, then the shape of what happened (shared console messages, enabled periods). A log is only added automatically when that is clear. When one robot run holds several look-alike matches and nothing tells them apart, it is not guessed.
- **A robot log that fits no match starts a match of its own** ("Robot log only"), in the right day. When the Driver Station log that belongs to it is added, whenever that is, the two join and the robot-only match goes away.
- **A log that covers several matches** (one run of robot code often spans several DS logs) is added to all of them.
- **Add to a specific match** with the download-arrow menu → **Add robot logs**.
- **Info → Robot logs** shows each log, how it lined up with the Driver Station log (and how sure that is), and every signal in it. **Remove** takes one off, and it will not be added back by itself.
- Everything is saved in this browser (unless you turned saving off). There is no limit in PitView; the browser's own storage is the limit, and the Library shows how much is in use.
- A `.hoot` is not read directly: it is a closed format. Convert it to `.wpilog` with CTRE's Owlet (or Tuner X's export) and add that. A converted CTRE log shows as a `CTRE` chip.

Today the robot logs are lined up, matched and kept with the match. Charting their signals and judging them against earlier matches comes next.

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

`.github/workflows/deploy.yml` tests, builds and publishes to GitHub Pages on every push to `master`. In the repo settings, set
**Pages → Source** to **GitHub Actions**. The build uses relative paths, so it works under any sub-path, from the companion, or on any
static host.

> `public/sample/` holds a real Qualification 22 log from MNST (team 7028) as the demo. It ships with the site, so remove it or swap it
> out before publishing if you'd rather not share it.

## Project layout

```
src/lib/dslog.ts        .dslog decoder (v4: status flags, REV PDH / CTRE PDP currents)
src/lib/dsevents.ts     .dsevents decoder: message splitting, classification, FMS/team/joystick/rail-fault metadata
src/lib/wpilog.ts       WPILib DataLog (.wpilog) decoder: roboRIO logs, and CTRE logs after conversion
src/lib/aggregate.ts    lining a robot log up with the DS timeline; which matches a log belongs to
src/lib/extras.ts       reading one attached log: role, signals, alignment
src/lib/robotLogs.ts   which robot logs are on which match; robot-only matches; saved between visits
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
