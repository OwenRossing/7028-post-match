/*
 * API tests. Runs every check twice: against the local file database and
 * against a real (temporary, in-memory) MongoDB from mongodb-memory-server.
 *   node tests/server.js            (both)
 *   node tests/server.js --local    (skip MongoDB, e.g. with no internet for the first download)
 */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var server = require('../server/index');
var makeAuth = require('../server/auth');
var openDb = require('../server/db');

var passed = 0, failed = 0;
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) {
  var sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '\n       got:      ' + sa + '\n       expected: ' + sb);
}
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n       ')); }
}

function rec(fields) {
  return Object.assign({
    event: '2026test', match: 1, station: 'R1', team: 254, scout: 'Ana', start: 'center', noShow: false,
    events: [{ t: 5, a: 'fuel', r: 1, n: 5 }, { t: 40.2, a: 'fuel', r: 0, n: 1 }], endgame: 'l3', endgameT: 150.5,
    defPlayed: 1, defRecv: 0, fouls: { minor: 1 }, broke: false, died: false, tipped: false, notes: 'fast | "good" é',
    created: 1000, updated: 1000, cfg: 'abc123'
  }, fields || {});
}

async function suite(label, env) {
  console.log(label);
  var auth = makeAuth({ SCOUT_PASSCODE: 's-code', LEAD_PASSCODE: 'l-code', SESSION_SECRET: 'test-secret' });
  var db = await openDb(env);
  var app = server.createApp(db, auth);
  var srv = await new Promise(function (r) { var s = app.listen(0, function () { r(s); }); });
  var base = 'http://127.0.0.1:' + srv.address().port + '/';
  var tokens = {};
  async function call(method, p, body, who) {
    var headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = 'Bearer ' + tokens[who];
    var res = await fetch(base + p, { method: method, headers: headers, body: body == null ? undefined : JSON.stringify(body) });
    var data = null;
    try { data = await res.json(); } catch (e) { /* not json */ }
    return { status: res.status, data: data };
  }

  await test('health reports the database', async function () {
    var r = await call('GET', 'api/health');
    eq(r.status, 200); ok(r.data.ok && r.data.db, JSON.stringify(r.data));
  });
  await test('sign in: wrong code refused, scout and lead codes give their roles', async function () {
    eq((await call('POST', 'api/login', { passcode: 'nope' })).status, 401);
    var s = await call('POST', 'api/login', { passcode: 's-code' });
    var l = await call('POST', 'api/login', { passcode: 'l-code' });
    eq([s.data.role, l.data.role], ['scout', 'lead']);
    tokens.scout = s.data.token; tokens.lead = l.data.token;
    tokens.forged = s.data.token.replace(/^[^.]+/, Buffer.from(JSON.stringify({ role: 'lead', exp: Date.now() + 1e9 })).toString('base64url'));
  });
  await test('no token or a forged token is refused', async function () {
    eq((await call('POST', 'api/records', { records: [rec()] })).status, 401);
    eq((await call('GET', 'api/records', null, 'forged')).status, 401);
  });
  await test('scout submits; resending is harmless; newer edit replaces; older is ignored', async function () {
    var a = rec(), b = rec({ match: 2, team: 1114, station: 'B2' });
    var r1 = await call('POST', 'api/records', { records: [a, b] }, 'scout');
    eq(r1.data.results.map(function (x) { return x.result; }), ['new', 'new']);
    var r2 = await call('POST', 'api/records', { records: [a, b] }, 'scout');
    eq(r2.data.results.map(function (x) { return x.result; }), ['same', 'same'], 'resend');
    var r3 = await call('POST', 'api/records', { records: [rec({ updated: 2000, notes: 'edited' })] }, 'scout');
    eq(r3.data.results[0].result, 'updated');
    var r4 = await call('POST', 'api/records', { records: [rec({ updated: 1500, notes: 'stale' })] }, 'scout');
    eq(r4.data.results[0].result, 'same', 'older copy ignored');
  });
  await test('unusable records are rejected, not stored', async function () {
    var r = await call('POST', 'api/records', { records: [{ match: 0, team: 5, scout: 'x' }, { team: 5 }, 'junk'] }, 'scout');
    eq([r.data.results.length, r.data.rejected], [0, 3]);
    eq((await call('POST', 'api/records', { records: [] }, 'scout')).status, 400);
  });
  await test('only the lead can read records; data comes back cleaned and intact', async function () {
    eq((await call('GET', 'api/records', null, 'scout')).status, 403);
    var r = await call('GET', 'api/records', null, 'lead');
    eq(r.data.records.length, 2);
    var one = r.data.records.filter(function (x) { return x.match === 1; })[0];
    eq([one.notes, one.updated, one.events, one.fouls, one.endgameT], ['edited', 2000, rec().events, { minor: 1 }, 150.5]);
    eq((await call('GET', 'api/records?event=other', null, 'lead')).data.records.length, 0, 'event filter');
  });
  await test('lead fixes a wrong team number (record moves to its new id)', async function () {
    var id = encodeURIComponent('2026test|2|1114|ana');
    var r = await call('PATCH', 'api/records/' + id, { team: 1678 }, 'lead');
    eq(r.status, 200); eq(r.data.id, '2026test|2|1678|ana');
    var all = (await call('GET', 'api/records', null, 'lead')).data.records;
    eq(all.map(function (x) { return x.team; }).sort(function (a, b) { return a - b; }), [254, 1678]);
    eq((await call('PATCH', 'api/records/' + id, { team: 1 }, 'lead')).status, 404);
    eq((await call('PATCH', 'api/records/' + encodeURIComponent('2026test|2|1678|ana'), { team: 1 }, 'scout')).status, 403);
  });
  await test('delete one, delete an event, delete-all needs to be explicit', async function () {
    await call('POST', 'api/records', { records: [rec({ event: 'demo', match: 5 }), rec({ event: 'demo', match: 6 })] }, 'scout');
    eq((await call('DELETE', 'api/records?event=demo', null, 'lead')).data.deleted, 2);
    eq((await call('DELETE', 'api/records', null, 'lead')).status, 400);
    eq((await call('DELETE', 'api/records/' + encodeURIComponent('2026test|2|1678|ana'), null, 'lead')).data.deleted, 1);
    eq((await call('GET', 'api/records', null, 'lead')).data.records.length, 1);
  });
  await test('schedule: lead saves, scouts read, junk refused', async function () {
    eq((await call('PUT', 'api/schedule', { event: 'X', matches: { 1: [1, 2, 3, 4, 5, 6] } }, 'scout')).status, 403);
    eq((await call('PUT', 'api/schedule', { event: 'X', matches: { 1: [1, 2] } }, 'lead')).status, 400);
    var put = await call('PUT', 'api/schedule', { event: ' 2026Test ', matches: { 1: [1, 2, 3, 4, 5, 6], 2: ['7', 8, 9, 10, 11, 12] } }, 'lead');
    eq(put.status, 200);
    var got = (await call('GET', 'api/schedule', null, 'scout')).data.schedule;
    eq([got.event, got.matches], ['2026test', { 1: [1, 2, 3, 4, 5, 6], 2: [7, 8, 9, 10, 11, 12] }]);
    await call('DELETE', 'api/schedule', null, 'lead');
    eq((await call('GET', 'api/schedule', null, 'scout')).data.schedule, null);
  });
  await test('pick list is stored per event and cleaned', async function () {
    await call('PUT', 'api/picklist?event=2026test', { order: [254, '1114', 254, -3], status: { 254: 'picked', 1114: 'hacked' }, notes: { 254: 'fast' } }, 'lead');
    var p = (await call('GET', 'api/picklist?event=2026test', null, 'lead')).data.picklist;
    eq([p.order, p.status, p.notes], [[254, 1114], { 254: 'picked' }, { 254: 'fast' }]);
    eq((await call('GET', 'api/picklist?event=other', null, 'lead')).data.picklist, null);
    eq((await call('GET', 'api/picklist', null, 'scout')).status, 403);
  });
  await test('only app files are served (never the server code or the database)', async function () {
    var home = await fetch(base);
    ok(home.status === 200 && /Match Scout/.test(await home.text()), 'home page');
    eq((await fetch(base + 'js/scout.js')).status, 200);
    eq((await fetch(base + 'config/game.js')).status, 200);
    for (var p of ['server/index.js', 'server/auth.js', 'data/local-db.json', 'package.json', '.env.example', 'node_modules/express/package.json', 'tests/server.js']) {
      eq((await fetch(base + p)).status, 404, p);
    }
    eq((await call('GET', 'api/nope', null, 'lead')).status, 404);
    var bad = await fetch(base + 'api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    eq(bad.status, 400);
  });
  await test('delete-all empties records and pick lists', async function () {
    eq((await call('DELETE', 'api/records?all=1', null, 'lead')).status, 200);
    eq((await call('GET', 'api/records', null, 'lead')).data.records.length, 0);
    eq((await call('GET', 'api/picklist?event=2026test', null, 'lead')).data.picklist, null);
  });

  await new Promise(function (r) { srv.close(r); });
  await db.close();
}

(async function () {
  await test('production refuses to start without team codes and a secret', function () {
    var threw = false;
    try { makeAuth({ NODE_ENV: 'production', SCOUT_PASSCODE: 'a' }); } catch (e) { threw = true; }
    ok(threw);
  });

  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-db-'));
  var file = path.join(dir, 'db.json');
  await suite('Local file database', { DATA_FILE: file });
  await test('local database survives a restart', async function () {
    var db1 = await openDb({ DATA_FILE: file });
    await db1.upsertRecords([require('../server/shared').cleanRecord(rec({ match: 9 }))], require('../server/shared').recordId);
    var db2 = await openDb({ DATA_FILE: file });
    eq((await db2.listRecords()).map(function (r) { return r.match; }), [9]);
  });

  if (process.argv.indexOf('--local') < 0) {
    var MongoMemoryServer = require('mongodb-memory-server').MongoMemoryServer;
    var mongo = await MongoMemoryServer.create();
    try {
      await suite('MongoDB (temporary in-memory server)', { MONGODB_URI: mongo.getUri(), MONGODB_DB: 'scout_test' });
    } finally {
      await mongo.stop();
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
