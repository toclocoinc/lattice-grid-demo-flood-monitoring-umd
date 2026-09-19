/**
 * Save a real run of the Environment Agency flood monitoring API to
 * `data/snapshot/`, so the dashboard can also be opened with no network.
 *
 * Run it with `node tools/build-snapshot.mjs`. It is a development tool:
 * nothing the page loads imports it.
 *
 * The feed code the page uses is a classic script, not a module, so it cannot
 * be imported. It is run here instead, in this process, exactly as the browser
 * runs it: the file leaves its functions on `globalThis.FloodDemo` and they are
 * read from there. One copy of the feed code, used by both.
 *
 * It saves the stations and their latest level, the flood alerts currently in
 * force (usually none outside of flood season), and two days of readings for
 * each of the notable rivers the rolling charts follow.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'snapshot');

const feedFile = join(here, '..', 'src', 'ea-feed.js');
runInThisContext(await readFile(feedFile, 'utf8'), { filename: feedFile });
const { fetchInitial, encodeStation, encodeAlert, CURATED_STATIONS } = globalThis.FloodDemo;

const started = Date.now();
const { stations, alerts, series, curated } = await fetchInitial({
  onProgress: (message) => console.log(`  ${message}`),
});

const stationValues = stations.map(encodeStation);
const alertValues = alerts.map(encodeAlert);
const seriesValues = {};
for (const ref of CURATED_STATIONS) {
  seriesValues[ref] = (series[ref] || []).map((r) => [r.time, r.level]);
}

const seconds = Number(((Date.now() - started) / 1000).toFixed(1));

const meta = {
  fetchedAt: new Date().toISOString(),
  fetchedAtMs: Date.now(),
  seconds,
  stations: stationValues.length,
  alerts: alertValues.length,
  curated,
  source: 'Environment Agency flood monitoring API',
  sourceUrl: 'https://environment.data.gov.uk/flood-monitoring/doc/reference',
  licence: 'Open Government Licence v3.0',
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'stations.json'), JSON.stringify(stationValues));
await writeFile(join(outDir, 'alerts.json'), JSON.stringify(alertValues));
await writeFile(join(outDir, 'series.json'), JSON.stringify(seriesValues));
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(`\nSaved ${stationValues.length} stations and ${alertValues.length} alerts in ${seconds}s.`);
for (const ref of CURATED_STATIONS) {
  console.log(`  ${ref}: ${(series[ref] || []).length} readings`);
}
