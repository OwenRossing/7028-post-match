/*
 * Reuses the browser's record model on the server (js/core.js + js/model.js
 * attach to a global FS object), so both sides clean data the same way.
 */
'use strict';
require('../js/core.js');
require('../js/model.js');

var FS = globalThis.FS;
var STATUSES = { picked: 1, declined: 1, dnp: 1 };

/** Clean a submitted record. Returns null if it isn't usable. */
function cleanRecord(r) {
  if (!r || typeof r !== 'object') return null;
  var rec = FS.model.normalizeRecord(r);
  if (!(rec.match > 0) || !(rec.team > 0) || !rec.scout) return null;
  rec.events = rec.events.slice(0, 2000);
  return rec;
}

function cleanSchedule(s) {
  if (!s || typeof s !== 'object' || !s.matches || typeof s.matches !== 'object') return null;
  var matches = {};
  Object.keys(s.matches).forEach(function (k) {
    var m = parseInt(k, 10), teams = s.matches[k];
    if (m > 0 && m < 1000 && Array.isArray(teams) && teams.length === 6) {
      matches[m] = teams.map(function (t) { return parseInt(t, 10) || 0; });
    }
  });
  if (!Object.keys(matches).length) return null;
  return { event: String(s.event || '').trim().toLowerCase().slice(0, 30), matches: matches, updated: Date.now() };
}

function cleanPicklist(p) {
  p = p && typeof p === 'object' ? p : {};
  var out = { order: [], status: {}, notes: {}, updated: Date.now() };
  var seen = {};
  (Array.isArray(p.order) ? p.order : []).forEach(function (t) {
    t = parseInt(t, 10);
    if (t > 0 && !seen[t]) { seen[t] = true; out.order.push(t); }
  });
  Object.keys(p.status || {}).forEach(function (t) {
    if (STATUSES[p.status[t]] && parseInt(t, 10) > 0) out.status[parseInt(t, 10)] = p.status[t];
  });
  Object.keys(p.notes || {}).forEach(function (t) {
    var n = String(p.notes[t] || '').slice(0, 200);
    if (n && parseInt(t, 10) > 0) out.notes[parseInt(t, 10)] = n;
  });
  return out;
}

module.exports = { FS: FS, cleanRecord: cleanRecord, cleanSchedule: cleanSchedule, cleanPicklist: cleanPicklist, recordId: FS.model.recordId };
