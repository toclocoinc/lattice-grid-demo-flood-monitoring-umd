/**
 * Load the demo in a real browser and check that it works.
 *
 * Serves the project and opens the saved copy, so the check never depends on
 * the EA flood API being reachable. It does depend on jsDelivr, because that
 * is where the page gets the grid from.
 *
 * It asserts the things this demo exists to show:
 *
 *   - the library arrived by classic script tag (no type="module", pinned
 *     release, integrity hashes, each file left its global);
 *   - the stations table holds rows and the four rolling charts drew marks;
 *   - grouping by river and by catchment produces group rows;
 *   - narrowing to stale stations moves the tiles and charts;
 *   - the alerts table is a separate dataset (empty when no warnings are in
 *     force) and a pushed alert lands in it, not in the stations table;
 *   - the headline figures agree with the saved data, recomputed here.
 *
 * It then blocks the API in the browser and opens the live page, to prove a
 * visitor gets the saved copy, and is told so, when the EA cannot be reached.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--all] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const all = args.includes('--all');

const GRID_VERSION = '1.66.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@${GRID_VERSION}/`;
const LIBRARY_TAGS = [
  { file: 'lattice-grid.min.js', global: 'LatticeGrid', member: 'createGrid' },
  { file: 'modules/charts.min.js', global: 'LatticeGrid', member: 'createChart' },
  { file: 'modules/data-router.min.js', global: 'LatticeGridDataRouter', member: 'createDataRouter' },
  { file: 'modules/kpi.min.js', global: 'LatticeGridKPI', member: 'createKPI' },
  { file: 'modules/tabs.min.js', global: 'LatticeGridTabs', member: 'createTabs' },
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(`This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`);
  }
}

function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'flood-umd-demo-verify-'));
  const port = await freePort();
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__floodDemo)', 120000, `${label} to load`);
    const state = await evaluate('({ ready: window.__floodDemo.ready, error: window.__floodDemo.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__floodDemo.stationsGrid && window.__floodDemo.stationsGrid.rows.count() > 0', 60000, `${label} rows`);
  };

  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /* =================================================================== */
  /* 1. The saved copy.                                                  */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  /* ---- how the library arrived ---- */

  const delivery = await evaluate(`(() => {
    const scripts = [...document.querySelectorAll('script')];
    const globals = {};
    for (const name of ['LatticeGrid', 'LatticeGridDataRouter', 'LatticeGridKPI', 'LatticeGridTabs']) {
      const value = window[name];
      globals[name] = value ? Object.keys(value).filter((k) => typeof value[k] === 'function').length : 0;
    }
    return {
      moduleScripts: scripts.filter((s) => s.type === 'module').length,
      importmaps: scripts.filter((s) => s.type === 'importmap').length,
      librarySrcs: scripts.map((s) => s.getAttribute('src') || '').filter((src) => /cdn\\.jsdelivr\\.net/.test(src)),
      withIntegrity: scripts.filter((s) => /cdn\\.jsdelivr\\.net/.test(s.src) && s.integrity).length,
      stylesheetSrc: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).href || null,
      globals,
      members: {
        createGrid: typeof (window.LatticeGrid || {}).createGrid,
        createHeadlessGrid: typeof (window.LatticeGrid || {}).createHeadlessGrid,
        setLicence: typeof (window.LatticeGrid || {}).setLicence,
        createChart: typeof (window.LatticeGrid || {}).createChart,
        createDataRouter: typeof (window.LatticeGridDataRouter || {}).createDataRouter,
        createKPI: typeof (window.LatticeGridKPI || {}).createKPI,
        createTabs: typeof (window.LatticeGridTabs || {}).createTabs,
      },
    };
  })()`);
  console.log(`  library tags: ${delivery.librarySrcs.length} from the CDN, ${delivery.withIntegrity} with an integrity hash; module scripts on the page: ${delivery.moduleScripts}`);
  check(delivery.moduleScripts === 0, 'delivery: no type="module" script on the page', `${delivery.moduleScripts}`);
  check(delivery.importmaps === 0, 'delivery: no import map on the page', `${delivery.importmaps}`);
  check(delivery.librarySrcs.length === LIBRARY_TAGS.length, `delivery: ${LIBRARY_TAGS.length} library script tags point at the CDN`, `${delivery.librarySrcs.length}`);
  for (const tag of LIBRARY_TAGS) {
    const wanted = `${CDN_BASE}${tag.file}`;
    check(delivery.librarySrcs.includes(wanted), `delivery: ${tag.file} is loaded from the pinned ${GRID_VERSION} release`, wanted);
    check(delivery.members[tag.member] === 'function', `delivery: ${tag.file} left ${tag.global}.${tag.member} behind`, delivery.members[tag.member]);
  }
  check(delivery.withIntegrity === LIBRARY_TAGS.length, 'delivery: every library tag carries an integrity hash', `${delivery.withIntegrity} of ${LIBRARY_TAGS.length}`);
  check(delivery.stylesheetSrc === `${CDN_BASE}lattice-grid.min.css`, `delivery: the stylesheet is loaded from the pinned ${GRID_VERSION} release`, delivery.stylesheetSrc);
  check(delivery.members.setLicence === 'function', 'delivery: setLicence is on the core global');
  check(delivery.members.createHeadlessGrid === 'function', 'delivery: createHeadlessGrid is on the core global');

  const snap = await evaluate(`(() => {
    const d = window.__floodDemo;
    return {
      rows: d.stationsGrid.rows.count(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      charts: d.charts.length,
      watermark: d.stationsGrid.licence.watermark(),
      licenceState: d.stationsGrid.licence.state(),
      tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      named: document.querySelector('.kpi-named-value').textContent,
      freshness: document.querySelector('.freshness').textContent,
    };
  })()`);
  console.log(`  ${snap.rows} stations, ${snap.painted} painted, ${snap.charts} charts`);
  console.log(`  tiles: ${JSON.stringify(snap.tiles)}`);

  check(snap.rows > 0, 'saved copy: the stations table holds rows', `${snap.rows}`);
  check(snap.painted > 0, 'saved copy: the table painted rows', `${snap.painted}`);
  check(snap.charts === 4, 'saved copy: all four rolling charts were built', `${snap.charts}`);

  const drawn = await evaluate(`(() => window.__floodDemo.charts.map((c, i) => {
    const data = c.data();
    const series = (data && data.series) || [];
    const points = series.reduce((n, s) => n + ((s.points || []).length), 0);
    const withValue = series.reduce((n, s) => n + (s.points || []).filter((p) => p.y != null).length, 0);
    const svg = c.element;
    const marks = svg ? svg.querySelectorAll('path, circle').length : 0;
    return { i, points, withValue, marks };
  }))()`);
  for (const c of drawn) {
    console.log(`  chart ${c.i}: ${c.points} points, ${c.withValue} with a value, ${c.marks} marks`);
    check(c.withValue > 0, `saved copy: chart ${c.i} plotted values rather than empty axes`, `${c.withValue} of ${c.points} points`);
    check(c.marks > 0, `saved copy: chart ${c.i} drew marks`, `${c.marks} marks`);
  }
  check(snap.watermark === false, 'saved copy: no watermark on localhost', `state ${snap.licenceState}`);
  noErrors('saved copy');
  await shoot('01-stations');

  /* Independent recomputation from the saved data. */
  const meta = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8'));
  const stationValues = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'stations.json'), 'utf8'));
  const alertValues = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'alerts.json'), 'utf8'));
  const stationRows = stationValues.map((v) => ({ id: v[0], river: v[2], catchment: v[3], time: v[6] }));

  const expected = {
    stations: stationRows.length,
    rivers: new Set(stationRows.map((r) => r.river).filter(Boolean)).size,
    catchments: new Set(stationRows.map((r) => r.catchment).filter(Boolean)).size,
  };

  check(snap.tiles.stations === expected.stations, 'saved copy: the station count matches the saved data', `tile ${snap.tiles.stations}, expected ${expected.stations}`);
  check(snap.tiles.rivers === expected.rivers, 'saved copy: the river count matches the saved data', `tile ${snap.tiles.rivers}, expected ${expected.rivers}`);
  check(snap.tiles.catchments === expected.catchments, 'saved copy: the catchment count matches the saved data', `tile ${snap.tiles.catchments}, expected ${expected.catchments}`);
  check(typeof snap.tiles.fresh === 'number' && snap.tiles.fresh >= 0, 'saved copy: the fresh-stations tile is a number', `${snap.tiles.fresh}`);
  check(snap.named.length > 2 && snap.named !== 'No data', 'saved copy: the most gauged river is named', snap.named);
  check(alertValues.length === 0, 'saved copy: no flood alerts in force when the snapshot was taken', `${alertValues.length}`);

  /* ---- grouping by river and catchment ---- */

  await evaluate("window.__floodDemo.stationsGrid.columns.group(['river'])");
  await sleep(600);
  const groupedRiver = await evaluate(`(() => {
    const d = window.__floodDemo;
    let groups = 0;
    d.stationsGrid.rows.forEach((r) => { if (r && r.group) groups += 1; });
    return { groups };
  })()`);
  check(groupedRiver.groups > 0, 'grouping by river produces group rows', `${groupedRiver.groups} groups`);
  await shoot('02-grouped-by-river');
  await evaluate('window.__floodDemo.stationsGrid.columns.group([])');
  await sleep(400);

  /* ---- the alerts table is a separate dataset ---- */

  await evaluate("window.__floodDemo.tabs.activate('alerts')");
  await waitFor('!!window.__floodDemo.alertsGrid', 30000, 'the alerts table');
  const alertsEmpty = await evaluate('window.__floodDemo.alertsGrid.rows.count()');
  check(alertsEmpty === 0, 'the alerts table is empty when no warnings are in force', `${alertsEmpty}`);

  /* A pushed alert lands in the alerts table, not the stations table. */
  const injected = await evaluate(`(async () => {
    const d = window.__floodDemo;
    const stationsBefore = d.stationsGrid.rows.count();
    d.ingest([{ kind: 'alert', id: 'verify-flood', severity: 2, severityLabel: 'Flood Warning', message: 'River levels are rising', area: 'Test Area', region: 'Test Region', riverOrSea: 'River Test', timeRaised: Date.now(), count: 1 }]);
    await new Promise((r) => setTimeout(r, 400));
    let found = null;
    d.alertsGrid.rows.forEach((r) => { if (r && r.data && r.data.id === 'verify-flood') found = r.data; });
    return { alerts: d.alertsGrid.rows.count(), stations: d.stationsGrid.rows.count(), stationsBefore, severity: found ? found.severityLabel : null };
  })()`);
  console.log(`  injected alert: alerts ${injected.alerts}, stations ${injected.stationsBefore} -> ${injected.stations}`);
  check(injected.alerts === 1, 'a pushed alert lands in the alerts table', `${injected.alerts}`);
  check(injected.stations === injected.stationsBefore, 'the alert did not leak into the stations table', `${injected.stations}`);
  check(injected.severity === 'Flood Warning', 'the alert carries its severity label', injected.severity);
  await shoot('03-alert-injected');
  noErrors('saved copy, after the checks');

  /* =================================================================== */
  /* 2. What a visitor gets when the EA API cannot be reached.           */
  /* =================================================================== */

  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['*environment.data.gov.uk*'] });
  await open(`${origin}/index.html`, 'live page, with the API unreachable');
  const fallback = await evaluate(`(() => {
    const d = window.__floodDemo;
    const notice = document.querySelector('.notice');
    const pill = document.querySelector('.head-note .pill');
    const freshness = document.querySelector('.freshness');
    return {
      rows: d.stationsGrid.rows.totalCount(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      fellBack: !!(d.timings && d.timings.fellBack),
      mode: d.timings && d.timings.mode,
      badge: pill ? pill.textContent.trim() : null,
      notice: notice ? notice.textContent.trim() : null,
      polling: !!d.poller,
    };
  })()`);
  console.log(`  rows ${fallback.rows}, badge "${fallback.badge}", fell back: ${fallback.fellBack}`);
  console.log(`  notice: ${fallback.notice}`);
  check(fallback.rows > 0, 'fallback: the saved copy is on screen', `${fallback.rows} rows`);
  check(fallback.painted > 0, 'fallback: the table painted rows', `${fallback.painted}`);
  check(fallback.fellBack, 'fallback: the page recorded that it fell back to the saved copy');
  check(fallback.mode === 'live', 'fallback: the page ran in the live default, not snapshot mode', `mode ${fallback.mode}`);
  check(fallback.badge === 'Saved copy', 'fallback: the badge reads "Saved copy"', `"${fallback.badge}"`);
  check(!!fallback.notice && /could not be reached/i.test(fallback.notice), 'fallback: the page says the API was unreachable', fallback.notice);
  check(!fallback.polling, 'fallback: no poll is started against an API that could not be reached');
  check(pageErrors.length === 0, 'fallback: no page errors', pageErrors.slice(0, 3).join(' | '));
  await shoot('04-fallback');
  await call('Network.setBlockedURLs', { urls: [] });

  if (all) {
    await open(`${origin}/index.html`, 'live');
    const live = await evaluate(`(() => {
      const d = window.__floodDemo;
      return {
        rows: d.stationsGrid.rows.count(),
        charts: d.charts.length,
        fellBack: !!(d.timings && d.timings.fellBack),
        watermark: d.stationsGrid.licence.watermark(),
        freshness: document.querySelector('.freshness').textContent,
        tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      };
    })()`);
    console.log(`  ${live.rows} stations from the live API; ${live.freshness}`);
    check(live.fellBack === false, 'live: the rows came from the API, not the saved copy');
    check(live.rows > 0, 'live: the table holds rows from the API', `${live.rows}`);
    check(live.charts === 4, 'live: all four rolling charts were built', `${live.charts}`);
    check(live.watermark === false, 'live: no watermark on localhost');
    check(typeof live.tiles.stations === 'number' && live.tiles.stations > 0, 'live: the tiles read the API', `${live.tiles.stations} stations`);
    noErrors('live');
    await shoot('05-live');

    const failed = await evaluate(`(() => {
      const d = window.__floodDemo;
      const before = d.stationsGrid.rows.count();
      d.onPollError(new Error('a deliberate failure, for the check'));
      return { before, after: d.stationsGrid.rows.count(), text: document.querySelector('.freshness').textContent, className: document.querySelector('.freshness').className };
    })()`);
    check(failed.after === failed.before, 'live: a failed poll does not lose the table', `${failed.before} -> ${failed.after}`);
    check(/could not reach/i.test(failed.text), 'live: a failed poll is said out loud', failed.text);
    check(/failed/.test(failed.className), 'live: a failed poll is marked visually', failed.className);
  }

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
