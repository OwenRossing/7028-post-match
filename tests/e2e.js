/*
 * End-to-end tests in a real browser (Chrome or Edge, driven by puppeteer-core).
 *   npm install          (once)
 *   node tests/e2e.js    (set CHROME_PATH if Chrome/Edge is somewhere unusual)
 *
 * Covers: a scout scouting a whole match on a small phone, the lead laptop
 * reading the scout's QR codes through a (fake) webcam, a phone scanning the
 * schedule QR from the laptop, the analysis pages and pick list, CSV
 * export/import, and loading the app with the server switched off (offline).
 * Screenshots go to tests/screenshots/.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var os = require('os');
var childProcess = require('child_process');
var puppeteer = require('puppeteer-core');

var ROOT = path.join(__dirname, '..');
var SHOTS = path.join(__dirname, 'screenshots');
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frc-scout-e2e-'));
var PORT = 8093;
var BASE = 'http://localhost:' + PORT + '/';
var passed = 0, failed = 0;

function findChrome() {
  var c = [process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (var i = 0; i < c.length; i++) if (c[i] && fs.existsSync(c[i])) return c[i];
  throw new Error('Chrome/Edge not found - set CHROME_PATH');
}
var CHROME = findChrome();

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) {
  var sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '\n     got:      ' + sa + '\n     expected: ' + sb);
}
async function step(name, fn) {
  var t0 = Date.now();
  try { await fn(); passed++; console.log('  ok   ' + name + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)'); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
}

// ------------------------------------------------------------ server
var server = null;
function startServer(env) {
  return new Promise(function (resolve, reject) {
    server = childProcess.spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js'), String(PORT)], { env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.once('data', function () { resolve(); });
    server.once('error', reject);
  });
}
function stopServer() {
  return new Promise(function (resolve) {
    if (!server) { resolve(); return; }
    server.once('exit', function () { server = null; resolve(); });
    server.kill();
  });
}

// ---------------------------------------------------- app code in node
function appSandbox(configFile) {
  var ctx = { console: console };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ['vendor/qrcode.js', 'js/core.js', 'js/config.js', 'js/model.js', 'js/codec.js', 'js/csv.js', 'js/qr.js', 'js/demo.js', configFile || 'config/game.js']
    .forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }); });
  return ctx;
}

/** Write a Y4M video that shows each QR text for `holdFrames` frames (Chrome plays it as a webcam). */
function makeQRVideo(texts, file, opts) {
  opts = opts || {};
  var FS = appSandbox().FS;
  var W = 640, H = 480, fps = 10, hold = opts.hold || 12;
  var out = [Buffer.from('YUV4MPEG2 W' + W + ' H' + H + ' F' + fps + ':1 Ip A1:1 C420jpeg\n')];
  var uv = Buffer.alloc(W * H / 2, 128);
  texts.forEach(function (t, idx) {
    var m = FS.qr.matrix(t, 'M');
    var modules = m.size + 8;
    var px = Math.floor((opts.size || 380) / modules);
    var size = modules * px, ox = Math.floor((W - size) / 2) + (idx % 2 ? 6 : -6), oy = Math.floor((H - size) / 2);
    var y = Buffer.alloc(W * H, 70);   // grey "room" around a white phone screen
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        var mr = Math.floor(r / px) - 4, mc = Math.floor(c / px) - 4;
        var dark = mr >= 0 && mc >= 0 && mr < m.size && mc < m.size && m.dark(mr, mc);
        var noise = (r * 7 + c * 13) % 9 - 4;   // a little sensor noise
        y[(oy + r) * W + ox + c] = (dark ? 35 : 225) + noise;
      }
    }
    for (var k = 0; k < hold; k++) { out.push(Buffer.from('FRAME\n')); out.push(y); out.push(uv); }
  });
  fs.writeFileSync(file, Buffer.concat(out));
  return file;
}

// ------------------------------------------------------------- browser
async function launch(extraArgs) {
  return puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'].concat(extraArgs || [])
  });
}
function watchErrors(page, errors) {
  // the scout page asks "Leave site?" during a live match - a real user would confirm
  page.on('dialog', function (d) { page._sawDialog = d.type(); d.accept(); });
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  page.on('console', function (m) {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
  });
}
async function clickText(page, text, sel) {
  var ok2 = await page.evaluate(function (text, sel) {
    var els = Array.prototype.slice.call(document.querySelectorAll(sel || 'button, a'));
    var el = els.filter(function (b) { return b.offsetParent !== null && b.textContent.replace(/\s+/g, ' ').trim().indexOf(text) >= 0; })[0];
    if (!el) return false;
    el.click();
    return true;
  }, text, sel);
  if (!ok2) throw new Error('no visible button with text "' + text + '"');
  await sleep(60);
}
async function tap(page, selector) {
  var el = await page.waitForSelector(selector, { visible: true, timeout: 5000 });
  await el.tap();
  await sleep(40);
}
async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
async function noHorizontalScroll(page, where) {
  var w = await page.evaluate(function () { return [document.documentElement.scrollWidth, window.innerWidth]; });
  ok(w[0] <= w[1] + 1, where + ': page is wider than the screen (' + w[0] + ' > ' + w[1] + ')');
}
/** Read the QR code(s) shown on the phone screen (decodes the rendered SVG with jsQR). */
async function readQRFrames(page) {
  return page.evaluate(async function () {
    await FS.qr.loadDecoder();
    async function read() {
      var svg = document.querySelector('.qr-svg');
      var n = +svg.getAttribute('viewBox').split(' ')[2], sc = 4;
      var c = document.createElement('canvas'); c.width = c.height = n * sc;
      var img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
      await new Promise(function (r) { img.onload = r; });
      var ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, c.width, c.height);
      var code = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      return code ? code.data : null;
    }
    var frames = [], first = await read();
    frames.push(first);
    var next = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (b) { return b.textContent === '›'; })[0];
    var guard = 0;
    while (next && guard++ < 40) {
      next.click();
      await new Promise(function (r) { setTimeout(r, 30); });
      var t = await read();
      if (t === first) break;
      frames.push(t);
    }
    return frames;
  });
}
function storage(page, key) { return page.evaluate(function (k) { return JSON.parse(localStorage.getItem(k)); }, key); }

// ================================================================ tests
(async function main() {
  console.log('Browser: ' + CHROME);
  await startServer();
  var phoneFrames = null, phoneRecord = null;

  // ---------------------------------------------------------- scout phone
  var browser = await launch();
  await step('scout: setup, schedule, full match on a 320x568 phone, review, QR', async function () {
    var page = await browser.newPage();
    var errors = [];
    watchErrors(page, errors);
    await page.setViewport({ width: 320, height: 568, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(BASE + '?speed=8', { waitUntil: 'load' });
    await shot(page, 'phone-01-setup');
    await page.type('#f-name', 'Riley');
    await clickText(page, 'Blue 3', '.seg-btn');
    await clickText(page, 'Save');
    await clickText(page, 'Load schedule');
    await page.type('textarea', 'match,red1,red2,red3,blue1,blue2,blue3\n1,11,12,13,14,15,16\n2,21,22,23,24,25,2056\n3,31,32,33,34,35,36\n');
    await clickText(page, 'Load pasted text');
    // match 1 -> step to match 2
    await tap(page, '[aria-label="Next match"]');
    var team = await page.$eval('.team-big', function (e) { return e.textContent; });
    eq(team, '2056', 'team from schedule for match 2, Blue 3');
    await noHorizontalScroll(page, 'home');
    await shot(page, 'phone-02-home');
    await clickText(page, 'Scout this match');
    await clickText(page, 'Center', '.seg-btn');
    await shot(page, 'phone-03-prematch');
    await tap(page, '.btn-start');

    // auto (20 s of match time = 2 s real at speed 10)
    await tap(page, '[aria-label="Fuel into hub scored 5"]');
    await tap(page, '[aria-label="Fuel into hub missed"]');
    await shot(page, 'phone-04-auto');
    var headBg = await page.$eval('.live', function (e) { return e.getAttribute('data-phase'); });
    eq(headBg, 'auto');
    // keep the auto-climb button, then tap it just after teleop has started:
    // it must still count as auto (the scout saw an auto button)
    await page.evaluate(function () { window.__climb = document.querySelector('.abtn-once'); });
    await page.waitForFunction(function () { return document.querySelector('.live').getAttribute('data-phase') === 'teleop'; }, { timeout: 8000 });
    await page.evaluate(function () { window.__climb.click(); });
    var climb = (await storage(page, 'fs.scout.current')).rec.events.filter(function (e) { return e.a === 'aclimb'; });
    eq(climb.map(function (e) { return e.t; }), [20], 'late tap on an auto-only button is logged at the end of auto');

    // teleop
    await tap(page, '[aria-label="Fuel into hub scored 10"]');
    await sleep(200);
    await tap(page, '[aria-label="Fuel into hub scored 10"]');
    await sleep(200);
    await tap(page, '[aria-label="Fuel into hub scored"]');
    await tap(page, '[aria-label="Fuel passed to our zone scored 5"]');
    var before = (await storage(page, 'fs.scout.current')).rec.events.length;
    await clickText(page, 'Undo');
    var after = (await storage(page, 'fs.scout.current')).rec.events.length;
    eq(after, before - 1, 'undo removes the last event');
    ok(/Removed Pass/.test(await page.$eval('.strip-msg', function (e) { return e.textContent; })), 'undo feedback shown in the strip');
    // fix a mistake from the recent strip: newest chip -> mark as missed
    await tap(page, '.recent .chip');
    await clickText(page, 'Missed', '.sheet .seg-btn');
    await clickText(page, 'Save', '.sheet button');
    var evs = (await storage(page, 'fs.scout.current')).rec.events;
    eq(evs[evs.length - 1].r, 0, 'edited event is now a miss');
    await noHorizontalScroll(page, 'live');
    await shot(page, 'phone-05-teleop');

    // reload in the middle of the match: nothing is lost, clock keeps running
    await page.reload({ waitUntil: 'load' });
    eq(page._sawDialog, 'beforeunload', 'leaving mid-match asks for confirmation');
    await page.waitForSelector('.live');
    eq((await storage(page, 'fs.scout.current')).rec.events.length, evs.length, 'events survive a reload');

    await page.waitForFunction(function () { return document.querySelector('.live').getAttribute('data-phase') === 'endgame'; }, { timeout: 15000 });
    await clickText(page, 'Level 3', '.endgame-live .seg-btn');
    await shot(page, 'phone-06-endgame');
    await page.waitForFunction(function () { return document.querySelector('.live').getAttribute('data-phase') === 'over'; }, { timeout: 8000 });
    await clickText(page, 'Finish');

    // review
    await page.waitForSelector('.summary');
    await tap(page, '[aria-label="Increase Minor foul"]');
    await clickText(page, 'Died / stopped', '.toggle');
    await clickText(page, '+ Fast', '.tag');
    await page.type('textarea', ' | shoots from far, "quick" 100% é');
    await shot(page, 'phone-07-review');
    var total = await page.$eval('.sum-total b', function (e) { return +e.textContent; });
    // auto: 5 fuel + 15 climb; teleop: 10 + 10 fuel (the +1 was changed to a miss, the pass was undone); endgame L3 30
    eq(total, 5 + 15 + 10 + 10 + 30, 'review total');
    await clickText(page, 'Save & show QR');
    await page.waitForSelector('.qr-svg');
    await shot(page, 'phone-08-qr');
    phoneFrames = await readQRFrames(page);
    ok(phoneFrames.length >= 1 && phoneFrames.every(Boolean), 'QR frames readable: ' + JSON.stringify(phoneFrames));
    var recs = await storage(page, 'fs.scout.records');
    var ids = Object.keys(recs);
    eq(ids.length, 1);
    phoneRecord = recs[ids[0]];
    eq([phoneRecord.match, phoneRecord.team, phoneRecord.station, phoneRecord.scout, phoneRecord.endgame, phoneRecord.died, phoneRecord.fouls.minor],
      [2, 2056, 'B3', 'Riley', 'l3', true, 1]);
    var sb = appSandbox();
    eq(sb.FS.model.score(phoneRecord, sb.FS.loadConfig(sb.GAME_CONFIG).config).total, total, 'total on review screen matches saved record');
    await clickText(page, 'Lead got it');
    eq(await page.$eval('.match-input', function (e) { return e.value; }), '3', 'advanced to the next match');
    eq(errors, [], 'no JS errors');
    await page.close();
  });

  await step('scout: practice match and no-show are handled', async function () {
    var page = await browser.newPage();
    var errors = [];
    watchErrors(page, errors);
    await page.setViewport({ width: 375, height: 667, isMobile: true, hasTouch: true });
    await page.goto(BASE + '?speed=20', { waitUntil: 'load' });
    // no-show for match 3
    await clickText(page, 'Scout this match');
    await page.click('#f-noshow');
    await clickText(page, 'Save no-show');
    await clickText(page, 'Save & show QR');
    await page.waitForSelector('.qr-svg');
    await clickText(page, 'Not now');
    var recs = await storage(page, 'fs.scout.records');
    eq(Object.keys(recs).length, 2);
    ok(Object.keys(recs).some(function (k) { return recs[k].noShow && recs[k].match === 3; }), 'no-show saved');
    // practice match is not saved
    await clickText(page, 'Practice match');
    await tap(page, '.btn-start');
    await tap(page, '[aria-label="Fuel into hub scored 5"]');
    await clickText(page, 'Finish');
    await clickText(page, 'Tap again');
    await clickText(page, 'None', '.seg-btn');
    await clickText(page, 'Finish practice');
    eq(Object.keys(await storage(page, 'fs.scout.records')).length, 2, 'practice not saved');
    // "send all" produces one QR sequence holding both records
    await clickText(page, 'Send 1 to lead');
    await page.waitForSelector('.qr-svg');
    eq(errors, [], 'no JS errors');
    await page.close();
  });
  await browser.close();

  // ----------------------------------------------- lead scans via webcam
  var multi = appSandbox();
  var cfgR = multi.FS.loadConfig(multi.GAME_CONFIG).config;
  var demo = multi.FS.demo.generate(cfgR);
  var batch = demo.records.slice(0, 8);
  var batchFrames = multi.FS.codec.makeFrames('R', batch.map(multi.FS.codec.encodeRecord).join('\n'), 250);
  if (!phoneFrames) throw new Error('scout test failed - cannot continue');
  var video = makeQRVideo(phoneFrames.concat(batchFrames), path.join(TMP, 'scouts.y4m'));
  await step('lead: reads single and multi-part QR codes from the webcam (' + (phoneFrames.length + batchFrames.length) + ' codes)', async function () {
    var b = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + video]);
    var page = await b.newPage();
    var errors = [];
    watchErrors(page, errors);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(BASE + 'lead.html#scan', { waitUntil: 'load' });
    await clickText(page, 'Start camera');
    await page.waitForFunction(function (n) {
      var r = JSON.parse(localStorage.getItem('fs.lead.records') || '{}');
      return Object.keys(r).length >= n;
    }, { timeout: 60000 }, 1 + batch.length);
    await shot(page, 'lead-01-scan');
    var recs = await storage(page, 'fs.lead.records');
    var mine = Object.keys(recs).map(function (k) { return recs[k]; }).filter(function (r) { return r.scout === 'Riley'; })[0];
    eq(mine, phoneRecord, 'record received by the lead is identical to the one on the phone');
    var got = batch.every(function (r) { return recs[multi.FS.model.recordId(r)]; });
    ok(got, 'all records of the multi-part batch arrived');
    var log = await page.$$eval('.log-row', function (rows) { return rows.length; });
    ok(log >= 9, 'received list shows the records');
    await clickText(page, 'Stop camera');
    eq(errors, [], 'no JS errors');
    await b.close();
  });

  // ------------------------------------------- phone scans the schedule
  var sched = { event: '2026test', matches: {} };
  for (var m = 1; m <= 72; m++) sched.matches[m] = [1000 + m, 2000 + m, 3000 + m, 4000 + m, 5000 + m, 6000 + m];
  var schedFrames = multi.FS.codec.makeFrames('S', multi.FS.codec.encodeSchedule(sched), 600);
  var schedVideo = makeQRVideo(schedFrames, path.join(TMP, 'schedule.y4m'), { size: 440, hold: 15 });
  await step('scout: scans a ' + schedFrames.length + '-part schedule QR from the lead laptop with the phone camera', async function () {
    var b = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + schedVideo]);
    var page = await b.newPage();
    var errors = [];
    watchErrors(page, errors);
    await page.setViewport({ width: 375, height: 667, isMobile: true, hasTouch: true });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.evaluate(function () { localStorage.setItem('fs.scout.settings', JSON.stringify({ name: 'Sam', station: 'R1', match: 5 })); });
    await page.reload({ waitUntil: 'load' });
    await clickText(page, 'Load schedule');
    await clickText(page, 'Scan it from the lead');
    await page.waitForFunction(function () { return !!localStorage.getItem('fs.schedule'); }, { timeout: 60000 });
    var s = await storage(page, 'fs.schedule');
    eq(Object.keys(s.matches).length, 72);
    eq(s.event, '2026test');
    eq(await page.$eval('.team-big', function (e) { return e.textContent; }), '1005', 'home shows match 5 Red 1 from the scanned schedule');
    eq(errors, [], 'no JS errors');
    await b.close();
  });

  // --------------------------------------------- lead analysis & pick list
  browser = await launch();
  await step('lead: demo data, every tab renders, charts have tooltips', async function () {
    var page = await browser.newPage();
    var errors = [];
    watchErrors(page, errors);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(BASE + 'lead.html#settings', { waitUntil: 'load' });
    await clickText(page, 'Load demo data');
    await page.waitForSelector('.tbl-hover');
    await shot(page, 'lead-02-teams');
    // sort by accuracy
    await clickText(page, 'Accuracy', 'th');
    var first = await page.$eval('.tbl-hover tbody tr td:nth-child(2)', function (e) { return e.textContent; });
    await page.click('.tbl-hover tbody tr .team-link');
    await page.waitForSelector('.tiles');
    var lines = await page.$$eval('.ch-line', function (ls) { return ls.length; });
    ok(lines >= 5, 'match lines + average drawn: ' + lines);
    var box = await (await page.$('.ch-hit')).boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    var tip = await page.$eval('.ch-tip', function (e) { return getComputedStyle(e).display + '|' + e.textContent; });
    ok(/^block\|.*Average/.test(tip), 'tooltip shows values: ' + tip.slice(0, 80));
    await shot(page, 'lead-03-team');
    await page.evaluate(function () { window.scrollTo(0, 900); });
    await shot(page, 'lead-04-team-tables');
    await page.evaluate(function () { window.scrollTo(0, 0); });
    await clickText(page, '+ Compare');
    await page.goto(BASE + 'lead.html#compare');
    await clickText(page, 'Top 3');
    var cmp = await page.$$eval('.ch-line', function (ls) { return ls.length; });
    ok(cmp >= 3, 'compare draws one line per team: ' + cmp);
    await shot(page, 'lead-05-compare');
    for (var t of ['data', 'schedule', 'scan', 'settings']) {
      await page.goto(BASE + 'lead.html#' + t);
      await sleep(150);
      await shot(page, 'lead-06-' + t);
    }
    ok(first, 'sorted');
    eq(errors, [], 'no JS errors');
    await page.close();
  });

  await step('lead: pick list drag-reorder, move buttons, picked/declined marks', async function () {
    var page = await browser.newPage();
    var errors = [];
    watchErrors(page, errors);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(BASE + 'lead.html#picklist', { waitUntil: 'load' });
    var order0 = (await storage(page, 'fs.lead.picklist')).order.slice(0, 4);
    // drag row 3 above row 1
    var handles = await page.$$('.pick-row .drag');
    var from = await handles[2].boundingBox(), to = await handles[0].boundingBox();
    await page.mouse.move(from.x + 5, from.y + 5);
    await page.mouse.down();
    await page.mouse.move(to.x + 5, to.y + 2, { steps: 8 });
    await page.mouse.up();
    await sleep(100);
    var order1 = (await storage(page, 'fs.lead.picklist')).order.slice(0, 4);
    eq(order1.slice(0, 3), [order0[2], order0[0], order0[1]], 'dragged team moved to the top');
    // move buttons
    await page.click('.pick-row:nth-child(2) .mv-up');
    var order2 = (await storage(page, 'fs.lead.picklist')).order.slice(0, 2);
    eq(order2, [order0[0], order0[2]]);
    // mark the top team picked -> "best available" moves to the next one
    await page.click('.pick-row:nth-child(1) .st-picked');
    var best = await page.$eval('.pick-row.is-best', function (e) { return +e.getAttribute('data-team'); });
    eq(best, order0[2], 'best available skips the picked team');
    await page.click('.pick-row.is-best .st-declined');
    await page.click('#f-hide');
    var shown = await page.$$eval('.pick-row', function (r) { return r.map(function (x) { return +x.getAttribute('data-team'); }); });
    ok(shown.indexOf(order0[0]) < 0 && shown.indexOf(order0[2]) < 0, 'picked and declined teams hidden');
    await page.click('#f-hide');
    await shot(page, 'lead-07-picklist');
    eq(errors, [], 'no JS errors');
    await page.close();
  });

  await step('lead: CSV export -> import into a fresh laptop gives the same data', async function () {
    var page = await browser.newPage();
    var dl = path.join(TMP, 'dl');
    fs.mkdirSync(dl, { recursive: true });
    var cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(BASE + 'lead.html#data', { waitUntil: 'load' });
    var before = await storage(page, 'fs.lead.records');
    await clickText(page, 'Export match CSV');
    await clickText(page, 'Export events CSV');
    var file = null, events = null;
    for (var i = 0; i < 80 && !(file && events); i++) {
      await sleep(100);
      var names = fs.readdirSync(dl);
      file = names.filter(function (f) { return /^match-records.*\.csv$/.test(f); })[0];
      events = names.filter(function (f) { return /^scoring-events.*\.csv$/.test(f); })[0];
    }
    ok(file, 'match CSV downloaded');
    ok(events, 'events CSV downloaded');
    var evRows = fs.readFileSync(path.join(dl, events), 'utf8').trim().split(/\r?\n/).length;
    ok(evRows > 1000, 'events CSV has one row per logged event (' + evRows + ' rows)');
    var ctx = await browser.createBrowserContext();   // a "different laptop" with empty storage
    var p2 = await ctx.newPage();
    await p2.goto(BASE + 'lead.html#data', { waitUntil: 'load' });
    var chooser = await Promise.all([p2.waitForFileChooser(), clickText(p2, 'Import CSV')]);
    await chooser[0].accept([path.join(dl, file)]);
    await p2.waitForFunction(function () { return Object.keys(JSON.parse(localStorage.getItem('fs.lead.records') || '{}')).length > 0; });
    var after = await storage(p2, 'fs.lead.records');
    eq(Object.keys(after).length, Object.keys(before).length, 'same number of records');
    Object.keys(before).forEach(function (k) { eq(after[k], before[k], 'record ' + k); });
    await ctx.close();
    await page.close();
  });

  await step('offline: after one visit both pages open with the server switched off', async function () {
    var page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'load' });
    await page.evaluate(function () { return navigator.serviceWorker.ready; });
    await page.goto(BASE + 'lead.html', { waitUntil: 'load' });
    await page.waitForFunction(function () { return !!navigator.serviceWorker.controller; });
    await sleep(500);
    await stopServer();
    await page.goto(BASE + '?speed=5', { waitUntil: 'load' });
    ok(await page.$('.screen'), 'scout page renders offline');
    await page.goto(BASE + 'lead.html#teams', { waitUntil: 'load' });
    await page.waitForSelector('.tbl-hover');
    // the camera library is loaded on demand on phones - it must be cached too
    var hasDecoder = await page.evaluate(function () { return caches.open('frc-scout-v1').then(function (c) { return c.match(new URL('vendor/jsQR.js', location.href).href); }).then(Boolean); });
    ok(hasDecoder, 'QR decoder cached for offline use');
    await page.close();
    await startServer();
  });
  await browser.close();

  // ------------------------------------------------ another game config
  await stopServer();
  await startServer({ GAME_CONFIG: 'config/examples/reefscape-2025.js' });
  browser = await launch();
  await step('REEFSCAPE example config: 8 actions fit a 320x568 phone and score correctly', async function () {
    var page = await browser.newPage();
    var errors = [];
    watchErrors(page, errors);
    await page.setViewport({ width: 320, height: 568, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(BASE + '?speed=10', { waitUntil: 'load' });
    await page.evaluate(function () { localStorage.setItem('fs.scout.settings', JSON.stringify({ name: 'Kai', station: 'R1', match: 1 })); });
    await page.reload({ waitUntil: 'load' });
    await page.type('.team-input', '254');
    await clickText(page, 'Scout this match');
    await tap(page, '.btn-start');
    await tap(page, '.abtn-once');                               // leave: 3
    await tap(page, '[aria-label="Coral L4 scored"]');           // 7
    await tap(page, '[aria-label="Coral L4 scored"]');           // accidental double tap: ignored
    await tap(page, '[aria-label="Coral L1 (trough) missed"]');
    eq((await storage(page, 'fs.scout.current')).rec.events.filter(function (e) { return e.a === 'c4'; }).length, 1, 'double tap guard');
    var sizes = await page.$$eval('.abtn', function (bs) { return bs.map(function (b) { var r = b.getBoundingClientRect(); return [Math.round(r.height), Math.round(r.bottom)]; }); });
    var bodyBottom = await page.$eval('.live-body', function (e) { return e.getBoundingClientRect().bottom; });
    ok(sizes.every(function (s) { return s[0] >= 44; }), 'every button at least 44 px tall: ' + JSON.stringify(sizes));
    ok(sizes.every(function (s) { return s[1] <= bodyBottom + 1; }), 'all buttons visible without scrolling: ' + JSON.stringify(sizes) + ' body ends at ' + bodyBottom);
    await noHorizontalScroll(page, 'live (REEFSCAPE)');
    await shot(page, 'phone-09-reefscape-auto');
    await page.waitForFunction(function () { return document.querySelector('.live').getAttribute('data-phase') === 'teleop'; }, { timeout: 8000 });
    await tap(page, '[aria-label="Coral L4 scored"]');           // 5
    await tap(page, '[aria-label="Algae in net scored"]');       // 4
    await shot(page, 'phone-10-reefscape-teleop');
    await clickText(page, 'Finish');
    await clickText(page, 'Tap again');
    await clickText(page, 'Deep cage', '.seg-btn');              // 12
    var total = await page.$eval('.sum-total b', function (e) { return +e.textContent; });
    eq(total, 3 + 7 + 5 + 4 + 12, 'REEFSCAPE points');
    eq(errors, [], 'no JS errors');
    await page.close();
  });
  await browser.close();
  await stopServer();

  console.log('\n' + passed + ' passed, ' + failed + ' failed.  Screenshots: ' + SHOTS);
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error(e);
  stopServer().then(function () { process.exit(1); });
});
