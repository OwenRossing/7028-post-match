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
- **A `.hoot`** is kept with its match like any other robot log (CTRE puts the event and match in the file name during a field match, and PitView uses that to find the match), but its signals are not read yet: CTRE does not publish the format. Its card has **Copy hoot diagnostics**, a short text description of the file (first bytes, readable text, how compressed it looks) that can be pasted to work out the layout without sending the file. Or convert it to `.wpilog` with CTRE's Owlet (`owlet -f wpilog in.hoot out.wpilog`) or Tuner X and add that. A hoot shows as an amber `CTRE hoot` chip until it can be read. **The [desktop app](#desktop-app) runs Owlet for you**, on every hoot in its robot-log folder.

Robot logs are lined up with the match, kept with it, and charted: see [Per-motor use](#per-motor-use). Judging them against earlier matches comes next.

## Desktop app

The desktop app is PitView with an engine inside it that does what a browser cannot: it watches the Driver Station folder **and a robot-log folder**, and runs CTRE's [Owlet](https://docs.ctr-electronics.com/cli-tools) on every `.hoot` that lands there. Copy the logs off the roboRIO (or its USB stick) into the robot-log folder; the `.wpilog` files are used as they are, each `.hoot` is converted in the background, and every log finds its match by itself.

- **Get it:** GitHub → **Actions → Build desktop app → Run workflow**, then take `PitView-Setup-<version>.exe` (installer) or `PitView-Portable-<version>.exe` (no install) from the **desktop-latest** release. It is not code-signed, so Windows SmartScreen asks once: *More info → Run anyway*.
- **Dropping files works too:** drop or choose `.dslog`, `.dsevents`, `.wpilog` and `.hoot` files together. The Driver Station logs and `.wpilog` files are opened as usual; each `.hoot` is copied into the robot-log folder (your original is left alone), converted, and joins its match by itself. A hoot is placed by its name and clock, so it cannot be added to a match you pick by hand.
- **Owlet is not bundled**: it is CTRE's program, and CTRE sets its licence terms. **⋯ menu → Get Owlet from CTRE…** (also under **Help**) opens CTRE's download page. Unzip it anywhere. If it ends up in your **Downloads** folder (loose, or in an unzipped folder with `owlet` in its name), PitView notices it and asks *"Use this as Owlet?"*, naming the exact file, when you add a hoot or from the ⋯ menu. It never runs a program from Downloads without that yes, because anything saved there could be named `owlet.exe`. Otherwise use **Locate Owlet…**, or put `owlet.exe` in `Documents\PitView`, next to PitView, or on your `PATH` (those are used without asking). A hoot waits until Owlet is found and then converts by itself. If Owlet refuses a file, the log's card and a notice show Owlet's own words, and it is tried again when Owlet changes or from **⋯ → Try the failed conversions again**.
- **Folders:** the DS folder defaults to `C:\Users\Public\Documents\FRC\Log Files` and the robot-log folder to `Documents\PitView\Robot logs`. Change either from the ⋯ menu, which also opens them.
- **The whole hoot, or nothing.** A conversion is only used after the `.wpilog` Owlet wrote has been read back from start to end: it must be a complete file, with signals in it, ending exactly on a record. A cut-off or empty result is rejected with the reason, and nothing partial is ever kept or shown. Owlet gets time in proportion to the file (at least 15 minutes, 20 seconds per MB), and what it prints is shown on the log's card. The card says how many signals came out and how much time they cover. A 240 MB converted log of 16 million records checks in about 4 seconds.
- **What Owlet will not export is CTRE's call.** Owlet only exports the signals your device licences allow (a limited free set otherwise), and CTRE's licence check reads only the start of a long log unless a Deep Scan is run (Phoenix Tuner X has one). If a signal you expect is missing from the converted log, that is the likely reason. PitView does not work around it.
- **Your library stays put:** the app serves itself on a fixed local port (7028, or the next free one), so the logs saved in it are there next time. Nothing leaves the machine.

Run it from source with `npm run build`, then `cd desktop && npm install && npm start`.

## Which motor is using the power

On the Graphs page, **Who drew the power** finds the moment the battery was lowest while the robot was enabled and ranks every power channel and motor current by what it drew **at that moment**, by its **peak**, and by the **total** it used (amp-hours). Click a row for its chart at that moment; **Go there** jumps to the low point. Clicking any time on a chart also says what was drawing then (*Drawing then: …*).

- It uses the Driver Station's power distribution channels (named with your own channel names) and the motor currents of attached robot logs. For a motor with a **supply current** it uses that, because it is what the battery supplies; a **stator current** is the torque current and can be much higher, so a motor that only has one is listed with a *stator* warning.
- **If there is nothing to rank, it says why**: what the Driver Station log recorded (no board at all, a board type PitView does not decode, or a board that never drew a full amp) and what to do. The Board's Power column says *Channels: not recorded* in the same case.
- **A board the roboRIO could not read is not graphed as zeros.** Some logs have a PDH in every record whose reading never changes: the same bytes, every channel 0 A, temperature 255 °C, through a brownout. A live board never holds still like that, so PitView treats it as a placeholder (five seconds or more of identical all-zero readings), leaves the channels out and says so (*Channels: board not answering*), with what to check: the PDH's CAN ID against the robot's `PowerDistribution(<id>, ModuleType.kRev)`, its CAN wiring, and the number of *CAN … stale* messages in the log. Per-motor use then has to come from the robot logs.
- The Driver Station only records the channels of a REV PDH when it can read the board, which in practice needs the robot's code to create a `PowerDistribution` object (`new PowerDistribution(1, ModuleType.kRev)`; `(0, ModuleType.kCTRE)` for a PDP). If a log that used to have channels does not, check the robot code first.

## Per-motor use

The **Channels** group on the Graphs page is the power distribution board's currents, and it comes from the **Driver Station log only**: the DS records them when the robot's code reads the PDH/PDP (WPILib's `PowerDistribution`) and the board is on the CAN bus. If your code does not, there is nothing to show there (the page says so). Attaching a robot log does not feed that group.

Per-motor use comes from the robot logs instead. Every numeric signal of an attached roboRIO log or converted Phoenix log is put on the match's timeline, so it lines up with the auto/teleop bands, the Driver Station's own signals and its error markers:

- **Motors** (Graphs): the signals that are motor currents (`…/StatorCurrent`, `…/SupplyCurrent`, `…/OutputCurrent`, and power channel arrays such as `PowerDistribution/ChannelCurrent[3]`, which AdvantageKit-style logging writes) as heat strips on one shared scale, busiest first. Open a row for its chart. Motors that never drew a full amp are folded into **Idle**. Limits and settings (`StatorCurrentLimit`) are not mistaken for use.
- **Robot logs** (Graphs, below): every other signal, grouped by device and folded.
- **How a log gets on the timeline:** the roboRIO log by the usual evidence (messages, enabled periods, clock). A Phoenix log has none of those, so it is lined up with the roboRIO log **of the same boot** (they began within 90 s of each other and ran about as long), which is good to a second or two and says so on its Info card. A log that cannot be lined up is named on the Graphs page with the reason, and its signals stay on the Info page.
- A robot log bigger than 400 MB is not put on the graphs (it is listed on the Info page).
- If the motors you expect are missing, press **Copy diagnostics** on the Info page: it lists what was taken for a motor current and the names of every signal, so the detection can be fixed from the names.

## Events

The library groups matches by **event**, newest first, and each event folds away.

- **Found from the logs.** A Driver Station log says which event it was recorded at (the field names it), so those matches group into `MNST 2026`, `WIMI 2026` and so on by themselves. Matches with no field (shop practice) group into sessions, and a match with no field name on the days of an event (a pit test) goes with that event.
- **Matches that have not been read yet** wait in a *Reading logs…* group instead of being guessed into an event and moved: dropping hundreds of logs at once is fine.
- **Make your own events** with **+ Event**, rename any event from its **⋯** menu, move matches into one from **Manage → Move to event…**, and delete an event with its matches from the same menu. What you decide is remembered.
- **Add logs to an event** with the **+** on its header. Those logs are only matched against that event's matches, which is what keeps events apart when their match numbers collide (every event has a Qualification 22). Dropping files anywhere still works: they find their event by themselves where the evidence is clear.

## How robot logs find their match

Every robot log (a roboRIO `.wpilog`, or a Phoenix `.hoot` once converted) is weighed against the matches, best evidence first, and only a clear answer is acted on. The rest are kept as robot-log-only matches rather than guessed.

- **The field's own name for the match** (event, type, number) is trusted whatever the clocks say. A name with no event (a log's file name, or a hoot's) is only trusted when the clock agrees, or the number exists at only one event, or the log was added to an event. A name taken from a *file name* only says where the run began, so it never rules out the matches after it.
- **Both machines' clocks** place a log on every match it overlaps, so one run that spans several matches goes on all of them.
- **Shared console messages** can place a log with no clock and no names.
- **The shape of the enabled periods alone never places a log**: the field makes every match look the same.
- **A Phoenix log of the same boot** as a roboRIO log (it began within 90 s and ran for about as long) goes wherever that log went. This is how a hoot gets onto all the matches of its run when its name only mentions the first.

On a synthetic pool (`test/matching.test.ts`: 240 matches at three events with colliding numbers plus shop days, and 158 robot logs of the kinds above) the old rules put 48% of what they placed on the right match, with 295 wrong placements. These rules put 100% on the right match, with none wrong, and find 93% of the right placements (94% when logs are added to their event). That pool is made up from how the formats are documented, not real logs, so how it holds up on yours is the thing to check.

## Managing logs

Open the library (the **Logs** button) and press **Manage**.

- **Pick matches** with the checkboxes (a day's checkbox picks the whole day, **All** picks everything shown) and press **Delete**. You are asked first, and told exactly what happens.
- **Clear the whole library…** empties it in one go.
- **Saved matches** (opened by dropping or choosing files) are removed from this browser, with the robot logs attached to them.
- **Matches from a watched folder or the companion are hidden, not deleted.** PitView only ever reads those folders, so their files are never touched, and a match you deleted stays hidden through rescans and restarts. Matches that arrive from now on still appear. **Show hidden** (in Manage, or at the bottom of the library) brings back everything hidden, including robot-folder logs you took off a match.
- A single match can also be removed from the **⋯** menu while it is open.
- Adding a match by hand (dropping its files) always shows it, even if it was hidden before.

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

   The server is read-only, has no dependencies, serves only `.dslog`/`.dsevents` files from that folder (and the `.wpilog` files it has listed from the robot-log folder), and binds to localhost unless
   you pass `--lan`. Options: `--dir <folder>`, `--port <n>`, `--robot-dir <folder>` and `--owlet <path>` to watch robot logs and convert hoots, `--convert-dir <folder>` for where converted logs are kept. A hosted PitView can also connect to it at `http://localhost:5801` from
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
src/lib/manage.ts      what deleting matches removes and what it only hides, and the words that ask first
src/lib/hoot.ts         CTRE .hoot: describes a file (the layout is not published); where a decoder goes
src/lib/diagnostics.ts  the text summaries behind Copy diagnostics
src/lib/analysis.ts     modes, matches, comms drops, code stalls, stats, findings, library summaries
src/workers/            parsing off the main thread
src/lib/useLibrary.ts   uploads (saved to IndexedDB), watched DS folder, companion, background indexing
src/lib/chartGroup.ts   shared zoom/pan/cursor/pin state across uPlot charts
src/components/         UI (Viewer tabs, Compare, Library, Navigator, TimeChart…)
server/companion.mjs    the engine: log server for the DS laptop, also the desktop app's core
server/robot.mjs        the robot-log folder: lists logs, converts hoots in the background, serves what was checked
server/owlet.mjs        finds and runs CTRE's Owlet; keeps a conversion only if it is whole
server/wpilog-check.mjs reads a whole .wpilog from disk to see that it is complete (streams, any size)
desktop/                Electron shell around the engine (npm start; the workflow builds the Windows installer)
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
