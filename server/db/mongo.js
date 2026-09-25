/*
 * MongoDB storage. Collections:
 *   records   - one document per scout per robot per match (_id = event|match|team|scout)
 *   schedule  - a single document {_id: 'current', event, matches}
 *   picklists - one document per event (_id = event code, '' = all events)
 */
'use strict';
var MongoClient = require('mongodb').MongoClient;

function strip(doc) {
  if (!doc) return null;
  var out = Object.assign({}, doc);
  delete out._id;
  return out;
}

module.exports = async function openMongo(uri, dbName) {
  var client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  var db = client.db(dbName || undefined);
  var records = db.collection('records');
  var schedule = db.collection('schedule');
  var picklists = db.collection('picklists');
  await records.createIndex({ event: 1, match: 1 });
  await records.createIndex({ updated: -1 });

  return {
    kind: 'mongodb',

    /** Insert or replace; a record only replaces an older version of itself. */
    upsertRecords: async function (list, idOf) {
      var results = [];
      for (var i = 0; i < list.length; i++) {
        var rec = list[i], id = idOf(rec);
        var doc = Object.assign({ _id: id }, rec);
        try {
          var res = await records.replaceOne({ _id: id, updated: { $lt: rec.updated } }, doc, { upsert: true });
          results.push({ id: id, result: res.upsertedCount ? 'new' : 'updated' });
        } catch (e) {
          // duplicate key: a same-or-newer version is already stored
          if (e && e.code === 11000) results.push({ id: id, result: 'same' });
          else throw e;
        }
      }
      return results;
    },
    listRecords: async function (event) {
      var q = event ? { event: event } : {};
      return (await records.find(q).sort({ match: 1 }).toArray()).map(strip);
    },
    getRecord: async function (id) { return strip(await records.findOne({ _id: id })); },
    /** Replace a record under a (possibly new) id, e.g. after the lead fixes a team number. */
    replaceRecord: async function (oldId, rec, newId) {
      if (oldId !== newId) await records.deleteOne({ _id: oldId });
      await records.replaceOne({ _id: newId }, Object.assign({ _id: newId }, rec), { upsert: true });
    },
    deleteRecord: async function (id) { return (await records.deleteOne({ _id: id })).deletedCount; },
    deleteRecords: async function (event) {
      return (await records.deleteMany(event == null ? {} : { event: event })).deletedCount;
    },

    getSchedule: async function () { return strip(await schedule.findOne({ _id: 'current' })); },
    putSchedule: async function (s) { await schedule.replaceOne({ _id: 'current' }, Object.assign({ _id: 'current' }, s), { upsert: true }); },
    deleteSchedule: async function () { await schedule.deleteOne({ _id: 'current' }); },

    getPicklist: async function (event) { return strip(await picklists.findOne({ _id: event || '' })); },
    putPicklist: async function (event, p) { await picklists.replaceOne({ _id: event || '' }, Object.assign({ _id: event || '' }, p), { upsert: true }); },
    deletePicklists: async function () { await picklists.deleteMany({}); },

    close: function () { return client.close(); }
  };
};
