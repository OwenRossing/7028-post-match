/*
 * Picks the database:
 *   MONGODB_URI set  -> MongoDB (your hosted database, or mongodb://localhost:27017/scouting)
 *   otherwise        -> local JSON file for testing (DATA_FILE, default data/local-db.json)
 */
'use strict';
var path = require('path');

module.exports = function openDb(env) {
  env = env || process.env;
  if (env.MONGODB_URI) return require('./mongo')(env.MONGODB_URI, env.MONGODB_DB || 'frc_scout');
  var file = env.DATA_FILE || path.join(__dirname, '..', '..', 'data', 'local-db.json');
  return require('./local')(path.resolve(file));
};
