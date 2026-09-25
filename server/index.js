/*
 * FRC Scout server: serves the app and a small JSON API backed by MongoDB
 * (or a local file database for testing - see server/db/index.js).
 *
 *   npm start                       -> http://localhost:3000, local test database
 *   MONGODB_URI=... npm start       -> MongoDB
 *
 * Environment: PORT, MONGODB_URI, MONGODB_DB, DATA_FILE, SCOUT_PASSCODE,
 * LEAD_PASSCODE, SESSION_SECRET, NODE_ENV (see README / .env.example).
 */
'use strict';
var path = require('path');
var express = require('express');
var openDb = require('./db');
var makeAuth = require('./auth');
var shared = require('./shared');

var ROOT = path.join(__dirname, '..');
var MAX_BATCH = 500;

function wrap(fn) {
  return function (req, res, next) { Promise.resolve(fn(req, res, next)).catch(next); };
}

function createApp(db, auth) {
  var app = express();
  app.disable('x-powered-by');
  app.use(function (req, res, next) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // ------------------------------------------------------------- API
  var api = express.Router();
  api.use(function (req, res, next) { res.set('Cache-Control', 'no-store'); next(); });
  api.use(express.json({ limit: '5mb' }));

  api.get('/health', function (req, res) { res.json({ ok: true, db: db.kind }); });

  api.post('/login', function (req, res) {
    var s = auth.login(req.body && req.body.passcode);
    if (!s) return res.status(401).json({ error: 'That team code is not right.' });
    res.json(s);
  });

  var scout = auth.require('scout'), lead = auth.require('lead');

  /** Submit matches. Safe to repeat: the same record sent twice is stored once. */
  api.post('/records', scout, wrap(async function (req, res) {
    var list = req.body && req.body.records;
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'No records sent.' });
    if (list.length > MAX_BATCH) return res.status(413).json({ error: 'Send at most ' + MAX_BATCH + ' records at a time.' });
    var clean = [], rejected = 0;
    list.forEach(function (r) { var c = shared.cleanRecord(r); if (c) clean.push(c); else rejected++; });
    var results = await db.upsertRecords(clean, shared.recordId);
    res.json({ results: results, rejected: rejected });
  }));

  api.get('/records', lead, wrap(async function (req, res) {
    res.json({ records: await db.listRecords(req.query.event ? String(req.query.event) : null), at: Date.now() });
  }));

  /** Fix a record's match / team / station / event (the scout typed it wrong). */
  api.patch('/records/:id', lead, wrap(async function (req, res) {
    var rec = await db.getRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Record not found.' });
    var b = req.body || {};
    var fixed = shared.cleanRecord(Object.assign(rec, {
      match: b.match != null ? b.match : rec.match, team: b.team != null ? b.team : rec.team,
      station: b.station != null ? b.station : rec.station, event: b.event != null ? b.event : rec.event,
      updated: Date.now()
    }));
    if (!fixed) return res.status(400).json({ error: 'Match and team must be numbers above 0.' });
    var newId = shared.recordId(fixed);
    await db.replaceRecord(req.params.id, fixed, newId);
    res.json({ id: newId, record: fixed });
  }));

  api.delete('/records/:id', lead, wrap(async function (req, res) {
    res.json({ deleted: await db.deleteRecord(req.params.id) });
  }));

  /** Delete many: ?event=demo removes one event, ?all=1 removes everything. */
  api.delete('/records', lead, wrap(async function (req, res) {
    if (req.query.all === '1') {
      var n = await db.deleteRecords(null);
      await db.deletePicklists();
      return res.json({ deleted: n });
    }
    if (req.query.event == null) return res.status(400).json({ error: 'Say which event (?event=...) or ?all=1.' });
    res.json({ deleted: await db.deleteRecords(String(req.query.event)) });
  }));

  api.get('/schedule', scout, wrap(async function (req, res) { res.json({ schedule: await db.getSchedule() }); }));
  api.put('/schedule', lead, wrap(async function (req, res) {
    var s = shared.cleanSchedule(req.body);
    if (!s) return res.status(400).json({ error: 'The schedule has no valid matches.' });
    await db.putSchedule(s);
    res.json({ schedule: s });
  }));
  api.delete('/schedule', lead, wrap(async function (req, res) { await db.deleteSchedule(); res.json({ ok: true }); }));

  api.get('/picklist', lead, wrap(async function (req, res) {
    res.json({ picklist: await db.getPicklist(String(req.query.event || '')) });
  }));
  api.put('/picklist', lead, wrap(async function (req, res) {
    var p = shared.cleanPicklist(req.body);
    await db.putPicklist(String(req.query.event || ''), p);
    res.json({ picklist: p });
  }));

  api.use(function (req, res) { res.status(404).json({ error: 'Unknown API address.' }); });
  api.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Too much data in one request.' });
    console.error(err);
    res.status(500).json({ error: 'Server problem - try again.' });
  });
  app.use('/api', api);

  // ---------------------------------------------------- the app files
  // Only the public folders are served (never server/, data/ or node_modules/).
  var noCache = { etag: true, lastModified: true, setHeaders: function (res) { res.set('Cache-Control', 'no-cache'); } };
  ['css', 'js', 'config', 'icons'].forEach(function (dir) { app.use('/' + dir, express.static(path.join(ROOT, dir), noCache)); });
  ['index.html', 'lead.html', 'sw.js', 'manifest.webmanifest'].forEach(function (f) {
    app.get('/' + f, function (req, res) { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(ROOT, f)); });
  });
  app.get('/', function (req, res) { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(ROOT, 'index.html')); });
  app.get('/lead', function (req, res) { res.redirect('/lead.html'); });
  return app;
}

async function start(env) {
  env = env || process.env;
  var auth = makeAuth(env);
  var db = await openDb(env);
  var app = createApp(db, auth);
  var port = parseInt(env.PORT || '3000', 10);
  return new Promise(function (resolve) {
    var server = app.listen(port, function () {
      console.log('FRC Scout running at http://localhost:' + port + '/  (lead: /lead.html)');
      console.log('Database: ' + db.kind);
      if (auth.usingDefaults) console.log('Team codes: scout = "' + (env.SCOUT_PASSCODE || 'scout') + '", lead = "' + (env.LEAD_PASSCODE || 'lead') + '" (defaults - set SCOUT_PASSCODE / LEAD_PASSCODE)');
      resolve({ server: server, db: db, app: app });
    });
  });
}

module.exports = { createApp: createApp, start: start };

if (require.main === module) {
  start().catch(function (e) { console.error(e.message || e); process.exit(1); });
}
