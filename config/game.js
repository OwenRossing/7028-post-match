/*
 * ============================================================================
 *  GAME CONFIGURATION  -  the only file you edit for a new season.
 * ============================================================================
 *
 *  This is FRC 2026 "REBUILT". Timing and point values match the 2026 game
 *  manual (checked Sept 2026 against the TU22 version); re-check them if a
 *  newer team update changes scoring. A worked example for a game with many
 *  scoring actions (2025 REEFSCAPE) is in config/examples/reefscape-2025.js.
 *
 *  REBUILT note: FUEL only scores in your alliance's ACTIVE hub. Tell scouts
 *  to log fuel that goes into an inactive hub as "missed", so points stay right.
 *
 *  Rules for editing:
 *   - Every phone and the lead laptop must use the SAME version of this file.
 *     The app shows a short "config code" (e.g. cfg 3fa9c1) on every screen;
 *     if the codes differ, a device has an old copy. The lead laptop warns when
 *     it scans data made with a different config.
 *   - `id`s are stored in the scouting data. Keep them short (lowercase letters,
 *     digits, underscore; start with a letter) and don't change them mid-event.
 *     Labels and point values can change at any time - points are recomputed.
 *   - Leave a phase's points out (or set to null) if the action can't happen
 *     in that phase. Use 0 to track something that scores no points.
 *   - After editing, open the app and look for red config errors at the top.
 *     `node tests/run.js` also validates this file.
 */
window.GAME_CONFIG = {
  game: 'REBUILT',
  year: 2026,

  // Match timing, in seconds.
  timing: {
    auto: 20,               // autonomous period length
    teleop: 140,            // teleop length (includes the endgame)
    endgame: 30,            // endgame = the last N seconds of teleop
    autoToTeleopDelay: 3    // pause on the field between auto and teleop
  },

  // Where the robot starts. Shown as buttons before the match.
  startPositions: [
    { id: 'left', label: 'Left' },
    { id: 'center', label: 'Center' },
    { id: 'right', label: 'Right' }
  ],
  startPositionHint: 'Left/right as seen from the robot\'s own driver station.',

  // Scoring actions. Scouts tap one button per attempt as it happens.
  //   auto / teleop : points per success in that phase (omit = not possible)
  //   miss          : show a "missed" button (default true)
  //   counts        : button sizes for game pieces scored in bursts,
  //                   e.g. [1, 5] shows "+1" and "+5" buttons (default [1])
  //   type: 'once'  : a yes/no thing that happens at most once per phase
  //                   (e.g. leaving the start line); shown as a toggle
  //   cycle         : count toward cycle time (default: true if it scores points)
  //   short         : short name for charts and the recent-events strip
  actions: [
    { id: 'fuel', label: 'Fuel into hub', short: 'Fuel', auto: 1, teleop: 1, miss: true, counts: [1, 5, 10] },
    { id: 'pass', label: 'Fuel passed to our zone', short: 'Pass', teleop: 0, miss: false, counts: [1, 5, 10], cycle: false },
    { id: 'aclimb', label: 'Auto climb (Level 1)', short: 'Auto climb', type: 'once', auto: 15 }
  ],

  // Endgame result, picked once near the end of the match.
  endgame: [
    { id: 'none', label: 'None', points: 0 },
    { id: 'l1', label: 'Level 1', points: 10 },
    { id: 'l2', label: 'Level 2', points: 20 },
    { id: 'l3', label: 'Level 3', points: 30 },
    { id: 'fail', label: 'Tried, failed', points: 0 }
  ],

  // Fouls the robot caused. Points go to the other alliance.
  fouls: [
    { id: 'minor', label: 'Minor foul', points: 5 },
    { id: 'major', label: 'Major foul', points: 15 }
  ],

  // One-tap phrases scouts can add to their notes.
  noteTags: [
    'Fast', 'Slow', 'Accurate shooter', 'Inaccurate', 'Great driver',
    'Good defense', 'Hard to defend', 'Jams / drops fuel', 'Good passer', 'Beached on bump'
  ],

  analysis: {
    // Taps closer together than this count as one scoring cycle (a volley of
    // fuel logged as +5, +5, +1 is one cycle, not three).
    cycleMergeSeconds: 3
  }
};
