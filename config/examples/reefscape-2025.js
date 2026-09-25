/*
 * Example game config: FRC 2025 REEFSCAPE.
 * To use it, copy this file over config/game.js (see README "New season").
 */
window.GAME_CONFIG = {
  game: 'REEFSCAPE',
  year: 2025,

  timing: {
    auto: 15,
    teleop: 135,
    endgame: 20,            // REEFSCAPE has no official endgame; barge climbs happen in the last ~20 s
    autoToTeleopDelay: 3
  },

  startPositions: [
    { id: 'proc', label: 'Processor side' },
    { id: 'mid', label: 'Center' },
    { id: 'far', label: 'Far side' }
  ],
  startPositionHint: 'Processor side = the side of the field with that alliance\'s processor.',

  actions: [
    { id: 'leave', label: 'Left starting line', short: 'Leave', type: 'once', auto: 3 },
    { id: 'c1', label: 'Coral L1 (trough)', short: 'L1', auto: 3, teleop: 2 },
    { id: 'c2', label: 'Coral L2', short: 'L2', auto: 4, teleop: 3 },
    { id: 'c3', label: 'Coral L3', short: 'L3', auto: 6, teleop: 4 },
    { id: 'c4', label: 'Coral L4', short: 'L4', auto: 7, teleop: 5 },
    { id: 'proc', label: 'Algae in processor', short: 'Proc', auto: 6, teleop: 6 },
    { id: 'net', label: 'Algae in net', short: 'Net', auto: 4, teleop: 4 },
    { id: 'dealg', label: 'Algae knocked off reef', short: 'Dealgae', auto: 0, teleop: 0, miss: false, cycle: false }
  ],

  endgame: [
    { id: 'none', label: 'None', points: 0 },
    { id: 'park', label: 'Park', points: 2 },
    { id: 'shallow', label: 'Shallow cage', points: 6 },
    { id: 'deep', label: 'Deep cage', points: 12 },
    { id: 'fail', label: 'Tried, failed', points: 0 }
  ],

  fouls: [
    { id: 'minor', label: 'Minor foul', points: 2 },
    { id: 'major', label: 'Major foul', points: 6 }
  ],

  noteTags: [
    'Fast', 'Slow', 'Great driver', 'Good defense', 'Hard to defend',
    'Drops coral', 'Ground intake', 'Station only', 'L4 specialist', 'Algae specialist'
  ],

  analysis: {
    cycleMergeSeconds: 1
  }
};
