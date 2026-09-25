/*
 * Local test database: everything in one JSON file (default data/local-db.json).
 * Same interface as mongo.js, so you can try the app with no MongoDB installed.
 * Fine for testing and a single laptop; use MongoDB for the real website.
 */
'use strict';
var fs = require('fs');
var path = require('path');

function copy(x) { return x == null ? null : JSON.parse(JSON.stringify(x)); }

module.exports = async function openLocal(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  var data = { records: {}, schedule: null, picklists: {} };
  if (fs.existsSync(file)) {
    try { data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (e) { throw new Error('Could not read ' + file + ': ' + e.message); }
  }
  function save() {
    // write a temp file then rename, so a crash never leaves half a file
    var tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  return {
    kind: 'local file (' + file + ')',

    upsertRecords: async function (list, idOf) {
      var results = list.map(function (rec) {
        var id = idOf(rec), ex = data.records[id];
        if (!ex) { data.records[id] = copy(rec); return { id: id, result: 'new' }; }
        if (rec.updated > ex.updated) { data.records[id] = copy(rec); return { id: id, result: 'updated' }; }
        return { id: id, result: 'same' };
      });
      save();
      return results;
    },
    listRecords: async function (event) {
      return Object.keys(data.records).map(function (k) { return copy(data.records[k]); })
        .filter(function (r) { return !event || r.event === event; })
        .sort(function (a, b) { return a.match - b.match; });
    },
    getRecord: async function (id) { return copy(data.records[id] || null); },
    replaceRecord: async function (oldId, rec, newId) {
      delete data.records[oldId];
      data.records[newId] = copy(rec);
      save();
    },
    deleteRecord: async function (id) {
      var had = data.records[id] ? 1 : 0;
      delete data.records[id];
      save();
      return had;
    },
    deleteRecords: async function (event) {
      var n = 0;
      Object.keys(data.records).forEach(function (k) {
        if (event == null || data.records[k].event === event) { delete data.records[k]; n++; }
      });
      save();
      return n;
    },

    getSchedule: async function () { return copy(data.schedule); },
    putSchedule: async function (s) { data.schedule = copy(s); save(); },
    deleteSchedule: async function () { data.schedule = null; save(); },

    getPicklist: async function (event) { return copy(data.picklists[event || ''] || null); },
    putPicklist: async function (event, p) { data.picklists[event || ''] = copy(p); save(); },
    deletePicklists: async function () { data.picklists = {}; save(); },

    close: async function () {}
  };
};
