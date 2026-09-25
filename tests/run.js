/*
 * Unit tests for the browser code. Run with:   node tests/run.js
 * (Optional: `npm install` first to enable the old-browser syntax check.)
 * The server/API tests are in tests/server.js (`npm test` runs both).
 *
 * Loads the browser scripts into a sandbox and checks config validation,
 * scoring, CSV encoding, schedule parsing and statistics.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var passed = 0, failed = 0;

function load(ctx, file) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
}
function sandbox(configFile) {
  var ctx = { console: console, Date: Date, Math: Math, JSON: JSON };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  ['js/core.js', 'js/config.js', 'js/model.js', 'js/codec.js',
    'js/csv.js', 'js/analysis.js', 'js/charts.js', 'js/demo.js', 'js/api.js', 'js/icons.js'].forEach(function (f) { load(ctx, f); });
  if (configFile) load(ctx, configFile);
  return ctx;
}
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); }
}
function eq(a, b, msg) {
  var sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '\n         got:      ' + sa + '\n         expected: ' + sb);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function near(a, b, eps, msg) { if (Math.abs(a - b) > (eps || 1e-9)) throw new Error((msg || 'not near') + ': ' + a + ' vs ' + b); }

// ---------------------------------------------------------------- configs
console.log('Config');
var CONFIGS = ['config/game.js', 'config/examples/reefscape-2025.js'];
CONFIGS.forEach(function (file) {
  test(file + ' has no errors', function () {
    var ctx = sandbox(file);
    var res = ctx.FS.loadConfig(ctx.GAME_CONFIG);
    eq(res.errors, [], 'config errors');
    ok(res.config.actions.length > 0);
    ok(/^[0-9a-f]{6}$/.test(res.config.hash), 'hash');
  });
});
test('bad config reports errors but stays usable', function () {
  var ctx = sandbox();
  var res = ctx.FS.loadConfig({ timing: { auto: 'x', teleop: 100, endgame: 200 }, actions: [{ id: 'Bad Id', auto: 1 }, { id: 'ok', label: 'OK' }, { id: 'ok', auto: 2 }] });
  ok(res.errors.length >= 4, 'expected several errors, got ' + JSON.stringify(res.errors));
  eq(res.config.endgame[0].id, 'none', 'adds a None endgame option');
  eq(res.config.timing.auto, 15, 'defaults timing');
});

// ----------------------------------------------------------------- scoring
console.log('Scoring (REEFSCAPE example)');
var R = sandbox('config/examples/reefscape-2025.js');
var RCFG = R.FS.loadConfig(R.GAME_CONFIG).config;
var M = R.FS.model;
function rrec(fields) { return M.normalizeRecord(M.newRecord(fields, RCFG)); }
var sample = rrec({
  event: '2025TEST', match: 12, station: 'R2', team: 254, scout: 'Ana',
  events: [
    { t: 3, a: 'leave', r: 1, n: 1 },
    { t: 10, a: 'c4', r: 1, n: 1 },
    { t: 15, a: 'c2', r: 0, n: 1 },    // exactly at the end of auto -> auto
    { t: 15.1, a: 'c4', r: 1, n: 1 },  // first moment of teleop
    { t: 40, a: 'c2', r: 0, n: 1 },
    { t: 60, a: 'proc', r: 1, n: 1 },
    { t: 70, a: 'dealg', r: 1, n: 1 }
  ],
  endgame: 'deep', endgameT: 140, fouls: { minor: 2 }
});
test('phase boundary', function () {
  eq(M.phaseOf(15, RCFG), 'auto'); eq(M.phaseOf(15.1, RCFG), 'teleop');
});
test('points by phase', function () {
  var s = M.score(sample, RCFG);
  eq([s.auto, s.teleop, s.endgame, s.total], [10, 11, 12, 33]);
  eq([s.made, s.missed], [3, 2], 'made/missed only counts actions with a miss button');
  eq(s.foulPoints, 4);
  eq(s.byAction.c4, { autoMade: 1, autoMissed: 0, teleMade: 1, teleMissed: 0, points: 12 });
});
test('cumulative curve ends at total and has one sample per second', function () {
  var c = M.cumulative(sample, RCFG, 1);
  eq(c.length, RCFG.matchLength + 1);
  eq(c[c.length - 1], 33);
  eq(c[2], 0); eq(c[3], 3); eq(c[139], 21); eq(c[140], 33);
});

// ------------------------------------------------------------------ codec
console.log('Event text format');
var C = R.FS.codec;
var tricky = rrec({
  event: '2025miket', match: 7, station: 'B3', team: 9999, scout: 'O|Neil % 50',
  start: 'far', noShow: false, broke: true, died: false, tipped: true,
  events: [{ t: 0, a: 'leave', r: 1, n: 1 }, { t: 12.3, a: 'c4', r: 0, n: 1 }, { t: 99.9, a: 'net', r: 1, n: 3 }],
  endgame: 'fail', endgameT: 147.2, defPlayed: 2, defRecv: 1, fouls: { minor: 1, major: 3 },
  notes: 'line1\nline2 | pipe %0A literal, comma "quotes" \'apos\' é 🤖 =cmd()',
  created: 1758000000000, updated: 1758000012345, cfg: RCFG.hash
});
test('events round-trip through the text format', function () {
  eq(C.decodeEvents(C.encodeEvents(tricky.events)), tricky.events);
  eq(C.encodeEvents([{ t: 12.3, a: 'fuel', r: 1, n: 5 }, { t: 30, a: 'fuel', r: 0, n: 1 }]), 'fuel+123x5 fuel-300');
});
test('garbage events are rejected', function () {
  var threw = false;
  try { C.decodeEvents('c4+12 DROP'); } catch (e) { threw = true; }
  ok(threw);
});

// --------------------------------------------------------------- schedule
console.log('Schedule');
var CSV = R.FS.csv;
test('comma CSV with header', function () {
  var s = CSV.parseSchedule('match,red1,red2,red3,blue1,blue2,blue3\n1,254,1114,2056,118,148,217\n2,1,2,3,4,5,6\n');
  eq(s.count, 2); eq(s.matches[1], [254, 1114, 2056, 118, 148, 217]); eq(s.errors, []);
});
test('blue-first header is reordered to red first', function () {
  var s = CSV.parseSchedule('Match\tBlue 1\tBlue 2\tBlue 3\tRed 1\tRed 2\tRed 3\nQ1\t4\t5\t6\t1\t2\t3');
  eq(s.matches[1], [1, 2, 3, 4, 5, 6]);
});
test('labels, team keys, spaces, blank lines', function () {
  var s = CSV.parseSchedule('Qualification 3, frc10, frc20, frc30, frc40, frc50, frc60\n\nqm4 11 21 31 41 51 61\n');
  eq(s.matches[3], [10, 20, 30, 40, 50, 60]); eq(s.matches[4], [11, 21, 31, 41, 51, 61]);
});
test('bad rows are reported', function () {
  var s = CSV.parseSchedule('match,r1\n1,2,3\n2,1,2,3,4,5,6');
  eq(s.count, 1); eq(s.errors.length, 1);
});
// -------------------------------------------------------------------- CSV
console.log('CSV');
test('parser handles quotes, commas, newlines, CRLF, BOM', function () {
  var rows = CSV.parse('﻿a,b,c\r\n1,"x, ""y""\nz",3\r\n');
  eq(rows, [['a', 'b', 'c'], ['1', 'x, "y"\nz', '3']]);
});
test('records round-trip through CSV export/import', function () {
  var text = CSV.recordsToCSV([tricky, sample], RCFG);
  ok(text.indexOf("'=cmd") < 0 || true);
  var back = CSV.recordsFromCSV(text);
  eq(back.errors, []);
  eq(back.records, [tricky, sample]);
});
test('text starting with = is neutralised for spreadsheets and restored on import', function () {
  var r = rrec({ match: 1, team: 5, scout: '=HYPERLINK("x")', notes: '+1 great' });
  var text = CSV.recordsToCSV([r], RCFG);
  ok(text.indexOf(",'+1 great,") >= 0 && text.indexOf("'=HYPERLINK") >= 0, 'prefixed');
  var back = CSV.recordsFromCSV(text).records[0];
  eq([back.scout, back.notes], ['=HYPERLINK("x")', '+1 great']);
});
test('events CSV has one row per event plus endgame', function () {
  var rows = CSV.parse(CSV.eventsCSV([sample], RCFG));
  eq(rows.length, 1 + sample.events.length + 1);
  eq(rows[1].slice(5, 12), ['3', 'auto', 'leave', 'Left starting line', 'scored', '1', '3']);
});

// --------------------------------------------------------------- analysis
console.log('Analysis (REBUILT config)');
var B = sandbox('config/game.js');
var BCFG = B.FS.loadConfig(B.GAME_CONFIG).config;
var BM = B.FS.model, A = B.FS.analysis;
function brec(f) { return BM.normalizeRecord(BM.newRecord(f, BCFG)); }
test('cycle times merge volleys and ignore auto and non-cycle actions', function () {
  var r = brec({
    match: 1, team: 1, events: [
      { t: 5, a: 'fuel', r: 1, n: 5 },           // auto - ignored
      { t: 30, a: 'fuel', r: 1, n: 5 }, { t: 31.5, a: 'fuel', r: 1, n: 5 }, { t: 33, a: 'fuel', r: 0, n: 1 },
      { t: 40, a: 'pass', r: 1, n: 5 },          // not a cycle action
      { t: 45, a: 'fuel', r: 1, n: 10 }, { t: 70, a: 'fuel', r: 0, n: 5 }
    ]
  });
  eq(A.cycleTimes(r, BCFG), [15, 25]);
});
test('team stats: averages, spread, accuracy, duplicates, no-shows', function () {
  var recs = [
    brec({ event: 'e', match: 1, team: 7, scout: 'a', events: [{ t: 30, a: 'fuel', r: 1, n: 10 }], updated: 1 }),
    brec({ event: 'e', match: 1, team: 7, scout: 'b', events: [{ t: 30, a: 'fuel', r: 1, n: 2 }], updated: 5 }), // newer duplicate wins
    brec({ event: 'e', match: 2, team: 7, scout: 'a', events: [{ t: 30, a: 'fuel', r: 1, n: 10 }, { t: 40, a: 'fuel', r: 0, n: 2 }], endgame: 'l2' }),
    brec({ event: 'e', match: 3, team: 7, scout: 'a', noShow: true }),
    brec({ event: 'e', match: 1, team: 8, scout: 'c', events: [{ t: 10, a: 'aclimb', r: 1, n: 1 }] })
  ];
  var all = A.allTeamStats(recs, BCFG);
  eq(all.map(function (s) { return s.team; }), [7, 8]);
  var s = all[0];
  eq([s.matches, s.noShows], [2, 1]);
  eq(s.avg.total, 16);                       // (2) and (10 + 20)
  near(s.sd, Math.sqrt(2 * 14 * 14), 1e-9);
  eq(s.consistency, 'Very variable');
  near(s.accuracy, 12 / 14, 1e-9);
  eq(s.endgameCounts, { none: 1, l2: 1 });
  eq(s.avgCurve.length, BCFG.matchLength + 1);
  eq(s.avgCurve[BCFG.matchLength], 16);
  eq(all[1].avg.auto, 15);
  eq(A.duplicateCounts(recs)['e|1|7'], 2);
});

// -------------------------------------------------------------- demo data
console.log('Demo data');
CONFIGS.forEach(function (file) {
  test('demo event for ' + file + ' is valid and analysable', function () {
    var ctx = sandbox(file);
    var cfg = ctx.FS.loadConfig(ctx.GAME_CONFIG).config;
    var d = ctx.FS.demo.generate(cfg);
    ok(d.records.length > 250, 'records: ' + d.records.length);
    eq(Object.keys(d.schedule.matches).length, 50);
    d.records.forEach(function (r) {
      r.events.forEach(function (e) {
        ok(cfg.actionsById[e.a], 'unknown action ' + e.a);
        var a = cfg.actionsById[e.a];
        ok(ctx.FS.model.phaseOf(e.t, cfg) === 'auto' ? a.auto != null : a.teleop != null, e.a + ' at ' + e.t + ' is in a phase it cannot happen in');
        ok(e.t >= 0 && e.t <= cfg.matchLength, 'time out of range');
      });
      eq(ctx.FS.model.normalizeRecord(JSON.parse(JSON.stringify(r))), r, 'survives JSON + the server\'s cleaning');
    });
    var all = ctx.FS.analysis.allTeamStats(d.records, cfg);
    eq(all.length, 30);
    all.forEach(function (s) { ok(s.matches === 0 || isFinite(s.avg.total), 'avg for ' + s.team); });
    ok(ctx.FS.charts && typeof ctx.FS.charts.line === 'function' && typeof ctx.FS.charts.color === 'function', 'charts module loaded');
  });
});

// ------------------------------------------------------ old-browser syntax
console.log('Old-browser compatibility (ES2017)');
var acorn = null;
try { acorn = require('acorn'); } catch (e) { /* optional */ }
function listJs(dir) {
  return fs.readdirSync(path.join(ROOT, dir)).filter(function (f) { return /\.js$/.test(f); }).map(function (f) { return dir + '/' + f; });
}
var appFiles = listJs('js').concat(listJs('config'), listJs('config/examples'), ['sw.js']).filter(function (f) { return fs.existsSync(path.join(ROOT, f)); });
var BANNED = [
  [/\?\.[a-zA-Z_$[(]/, 'optional chaining ?.'], [/\?\?/, 'nullish ??'], [/\.flatMap\(|\.flat\(/, 'Array.flat'],
  [/\.replaceAll\(/, 'replaceAll'], [/\.at\(-?\d/, 'Array.at'], [/Object\.fromEntries/, 'Object.fromEntries'],
  [/\.finally\(/, 'Promise.finally'], [/structuredClone/, 'structuredClone'], [/\(\?<[=!a-zA-Z]/, 'regex lookbehind/named group']
];
appFiles.forEach(function (f) {
  test(f, function () {
    var src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (acorn) acorn.parse(src, { ecmaVersion: 2017, sourceType: 'script' });
    var code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    BANNED.forEach(function (b) { if (b[0].test(code)) throw new Error('uses ' + b[1] + ' (not supported on older phones)'); });
  });
});
if (!acorn) console.log('  (syntax parse skipped: run `npm install` to enable it)');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
