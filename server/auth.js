/*
 * Two shared team passcodes, no individual accounts:
 *   SCOUT_PASSCODE - scouts can submit matches and read the schedule
 *   LEAD_PASSCODE  - the lead can also read all data, edit, and run the pick list
 * Logging in returns a signed token (HMAC with SESSION_SECRET) that the app
 * sends with every request. Changing SESSION_SECRET signs everyone out.
 */
'use strict';
var crypto = require('crypto');

var DAY = 24 * 3600 * 1000;

module.exports = function makeAuth(env) {
  var prod = env.NODE_ENV === 'production';
  var scoutCode = env.SCOUT_PASSCODE || (prod ? '' : 'scout');
  var leadCode = env.LEAD_PASSCODE || (prod ? '' : 'lead');
  var secret = env.SESSION_SECRET || (prod ? '' : 'dev-only-secret');
  if (prod && (!scoutCode || !leadCode || !secret)) {
    throw new Error('Set SCOUT_PASSCODE, LEAD_PASSCODE and SESSION_SECRET before running in production.');
  }
  var usingDefaults = !env.SCOUT_PASSCODE || !env.LEAD_PASSCODE;

  function sign(body) { return crypto.createHmac('sha256', secret).update(body).digest('base64url'); }
  function same(a, b) {
    var x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  function login(passcode) {
    var role = same(passcode, leadCode) ? 'lead' : same(passcode, scoutCode) ? 'scout' : null;
    if (!role) return null;
    var body = Buffer.from(JSON.stringify({ role: role, exp: Date.now() + 30 * DAY })).toString('base64url');
    return { role: role, token: body + '.' + sign(body) };
  }

  function verify(token) {
    var parts = String(token || '').split('.');
    if (parts.length !== 2 || !same(sign(parts[0]), parts[1])) return null;
    try {
      var data = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      return data.exp > Date.now() ? data.role : null;
    } catch (e) { return null; }
  }

  /** Express middleware: require('scout') lets scouts and the lead in; require('lead') only the lead. */
  function require_(role) {
    return function (req, res, next) {
      var m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
      var have = m && verify(m[1]);
      if (!have) return res.status(401).json({ error: 'Please sign in again.' });
      if (role === 'lead' && have !== 'lead') return res.status(403).json({ error: 'Only the lead scout can do that.' });
      req.role = have;
      next();
    };
  }

  return { login: login, verify: verify, require: require_, usingDefaults: usingDefaults };
};
