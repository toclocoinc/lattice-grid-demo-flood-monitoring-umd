/**
 * The Environment Agency flood monitoring feeds: reading the gauging stations,
 * their latest levels, the flood alerts and warnings, and a rolling window of
 * readings for a few notable rivers.
 *
 * Nothing here knows about the grid. It produces plain objects and hands them
 * to whoever asked, so the same code feeds the live page and the saved copy.
 *
 * The API is public and needs no key, and it answers with open cross-origin
 * headers, so the browser reads it directly. Level readings are published
 * every fifteen minutes; flood alerts and warnings are raised and lowered as
 * rivers threaten, which is why they are polled more often.
 *
 * This is a classic script, not a module: there is no `import` or `export`
 * anywhere on this page. What this file offers is put on `FloodDemo`, a plain
 * object on the global, and the next script reads it from there. The snapshot
 * tool runs this same file under Node, which is why it looks for `globalThis`
 * rather than `window`.
 */
(function (root) {
  'use strict';

  const BASE = 'https://environment.data.gov.uk/flood-monitoring';

  /**
   * The four gauging stations the rolling charts follow: a spread of well-known
   * flood-prone rivers across England. Their references are stable; the labels
   * and rivers are read back from the station list so they stay accurate.
   */
  const CURATED_STATIONS = ['2642', '3400TH', '4009', '4085'];

  /** How long a reading stays in the rolling window: two days. */
  const WINDOW_MS = 48 * 60 * 60 * 1000;

  /** How often the page asks for fresh levels. The API updates every 15 min. */
  const STATIONS_POLL_MS = 15 * 60 * 1000;

  /** How often the page asks for flood alerts. Warnings change quickly. */
  const FLOODS_POLL_MS = 5 * 60 * 1000;

  /** How many readings per station to pull back: covers two days at 15 min. */
  const SERIES_LIMIT = 250;

  /** The flood alert severities, least to most severe, as the API numbers them. */
  const SEVERITY_LABELS = {
    1: 'Flood Alert',
    2: 'Flood Warning',
    3: 'Severe Flood Warning',
    4: 'Warning no longer in force',
  };

  /** The order the snapshot stores a station row in. */
  const STATION_COLUMNS = ['id', 'name', 'river', 'catchment', 'level', 'unit', 'time'];

  /** The order the snapshot stores an alert row in. */
  const ALERT_COLUMNS = ['id', 'severity', 'severityLabel', 'message', 'area', 'region', 'riverOrSea', 'timeRaised'];

  /** Fetch JSON from the API. The service is a beta with occasional wobbles,
      so a short pause and retry beats giving up. */
  async function requestJson(url, describe, opts = {}) {
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, { signal: opts.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`The ${describe} answered ${response.status}.`);
    }
  }

  /** The part of a measure URL that identifies the measure. */
  function measureIdFrom(url) {
    if (!url) return null;
    return String(url).split('/measures/')[1] || null;
  }

  /**
   * Read every water-level gauging station and its Stage measure.
   *
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<object[]>} `{ ref, label, river, catchment, stageId, unit }`
   */
  async function fetchStations(opts = {}) {
    const body = await requestJson(
      `${BASE}/id/stations?parameter=level&qualifier=Stage&_limit=4000`,
      'stations list',
      opts,
    );
    const stations = [];
    for (const item of body.items || []) {
      const ref = item.stationReference || item.notation;
      if (!ref) continue;
      const stage = (item.measures || []).find((m) => m.parameter === 'level' && m.qualifier === 'Stage');
      stations.push({
        ref,
        label: item.label || ref,
        river: item.riverName || '',
        catchment: item.catchmentName || '',
        stageId: measureIdFrom(stage && stage['@id']),
        unit: (stage && stage.unitName) || '',
      });
    }
    return stations;
  }

  /** Turn one station, plus its latest reading, into a flat row. */
  function toStationRow(station, reading) {
    return {
      kind: 'station',
      id: station.ref,
      name: station.label,
      river: station.river,
      catchment: station.catchment,
      level: reading && typeof reading.value === 'number' ? reading.value : null,
      unit: station.unit,
      time: reading ? Date.parse(reading.dateTime) : null,
      count: 1,
    };
  }

  /**
   * The latest water level at every station, joined to the station's name,
   * river and catchment.
   *
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<object[]>} station rows
   */
  async function fetchLatestStationRows(opts = {}) {
    const [stations, latest] = await Promise.all([
      fetchStations(opts),
      requestJson(`${BASE}/data/readings?latest&parameter=level&qualifier=Stage&_limit=4000`, 'latest readings', opts),
    ]);
    const readingByMeasure = new Map();
    for (const item of latest.items || []) {
      const id = measureIdFrom(item.measure);
      if (id) readingByMeasure.set(id, item);
    }
    const rows = [];
    for (const station of stations) {
      const reading = readingByMeasure.get(station.stageId);
      if (reading) rows.push(toStationRow(station, reading));
    }
    return rows;
  }

  /** Turn one flood alert into a flat row. */
  function toAlertRow(item) {
    const area = item.floodArea || {};
    const severity = Number(item.severityLevel) || 1;
    return {
      kind: 'alert',
      id: String(item.floodAreaID || (item['@id'] || '').split('/').pop()),
      severity,
      severityLabel: SEVERITY_LABELS[severity] || 'Flood Alert',
      message: item.message || '',
      area: item.description || area.label || '',
      region: item.eaRegionName || '',
      riverOrSea: area.riverOrSea || '',
      timeRaised: item.timeRaised ? Date.parse(item.timeRaised) : null,
      count: 1,
    };
  }

  /** The current flood alerts and warnings. */
  async function fetchAlerts(opts = {}) {
    const body = await requestJson(`${BASE}/id/floods`, 'flood alerts feed', opts);
    const rows = [];
    for (const item of body.items || []) {
      const row = toAlertRow(item);
      if (row.id) rows.push(row);
    }
    return rows;
  }

  /**
   * A rolling window of readings for one station, newest first.
   *
   * @param {string} ref the station reference
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<object[]>} reading rows `{ id, station, time, level }`
   */
  async function fetchStationSeries(ref, opts = {}) {
    const body = await requestJson(
      `${BASE}/id/stations/${ref}/readings?_sorted&_limit=${SERIES_LIMIT}`,
      `readings for ${ref}`,
      opts,
    );
    const rows = [];
    for (const item of body.items || []) {
      const time = Date.parse(item.dateTime);
      const level = item.value;
      if (!Number.isFinite(time) || typeof level !== 'number') continue;
      rows.push({ id: `${ref}@${time}`, station: ref, time, level });
    }
    return rows;
  }

  /**
   * Read everything the page starts from: the stations with their latest
   * level, the current alerts, and a two-day window of readings for each
   * curated river.
   *
   * @param {{signal?: AbortSignal, onProgress?: Function}} [opts]
   * @returns {Promise<{stations: object[], alerts: object[], series: object, curated: object[]}>}
   */
  async function fetchInitial(opts = {}) {
    const report = opts.onProgress || (() => {});
    report('Reading the gauging stations...', 0.1);
    const stations = await fetchLatestStationRows(opts);
    report('Reading the flood alerts...', 0.5);
    const alerts = await fetchAlerts(opts);
    report('Reading two days of river levels...', 0.7);

    const series = {};
    for (const ref of CURATED_STATIONS) {
      const rows = await fetchStationSeries(ref, opts);
      rows.reverse(); // oldest first, so the chart reads left to right
      series[ref] = rows;
    }

    const curated = [];
    const byRef = new Map(stations.map((s) => [s.id, s]));
    for (const ref of CURATED_STATIONS) {
      const station = byRef.get(ref);
      curated.push({ ref, label: station ? station.name : ref, river: station ? station.river : '' });
    }

    report('Building the dashboard...', 1);
    return { stations, alerts, series, curated };
  }

  /**
   * Poll for fresh stations and alerts, and report each result.
   *
   * @param {object} opts
   * @param {(result: object) => void} opts.onPoll called with each successful poll
   * @param {(error: Error) => void} [opts.onError] called when a poll fails
   * @param {number} [opts.intervalMs] how often to poll
   * @returns {{stop: Function, pollNow: Function}} a handle that stops the polling
   */
  function startPolling({ onPoll, onError, intervalMs = STATIONS_POLL_MS }) {
    let stopped = false;
    let timer = null;
    const controller = new AbortController();

    const runOnce = async () => {
      if (stopped) return;
      try {
        const stations = await fetchLatestStationRows({ signal: controller.signal });
        const alerts = await fetchAlerts({ signal: controller.signal });
        const series = {};
        for (const ref of CURATED_STATIONS) {
          const rows = await fetchStationSeries(ref, { signal: controller.signal });
          rows.reverse();
          series[ref] = rows;
        }
        if (!stopped) onPoll({ stations, alerts, series, fetchedAt: Date.now() });
      } catch (error) {
        if (!stopped && onError) onError(error);
      }
    };

    timer = setInterval(runOnce, intervalMs);

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
        controller.abort();
      },
      pollNow: runOnce,
    };
  }

  /* ---------------- the snapshot ---------------- */

  /** Pack a station row into its compact array form. */
  function encodeStation(row) {
    return STATION_COLUMNS.map((col) => row[col]);
  }

  /** Pack an alert row into its compact array form. */
  function encodeAlert(row) {
    return ALERT_COLUMNS.map((col) => row[col]);
  }

  /** Unpack a compact station array back into a row. */
  function decodeStation(values) {
    const row = {};
    STATION_COLUMNS.forEach((col, index) => { row[col] = values[index]; });
    row.kind = 'station';
    row.count = 1;
    return row;
  }

  /** Unpack a compact alert array back into a row. */
  function decodeAlert(values) {
    const row = {};
    ALERT_COLUMNS.forEach((col, index) => { row[col] = values[index]; });
    row.kind = 'alert';
    row.count = 1;
    return row;
  }

  /** Read the saved copy that ships with the demo. */
  async function readSnapshot() {
    const [stations, alerts, series, meta] = await Promise.all(
      ['stations', 'alerts', 'series', 'meta'].map(async (name) => {
        const response = await fetch(`./data/snapshot/${name}.json`);
        if (!response.ok) throw new Error(`The saved copy is missing ${name}.json.`);
        return response.json();
      }),
    );
    const decodedSeries = {};
    for (const ref of Object.keys(series)) {
      decodedSeries[ref] = series[ref].map(([time, level]) => ({ id: `${ref}@${time}`, station: ref, time, level }));
    }
    return {
      stations: stations.map(decodeStation),
      alerts: alerts.map(decodeAlert),
      series: decodedSeries,
      meta: { ...meta, live: false },
    };
  }

  root.FloodDemo = Object.assign(root.FloodDemo || {}, {
    BASE,
    CURATED_STATIONS,
    WINDOW_MS,
    STATIONS_POLL_MS,
    FLOODS_POLL_MS,
    SEVERITY_LABELS,
    STATION_COLUMNS,
    ALERT_COLUMNS,
    fetchStations,
    fetchLatestStationRows,
    fetchAlerts,
    fetchStationSeries,
    fetchInitial,
    startPolling,
    toStationRow,
    toAlertRow,
    encodeStation,
    encodeAlert,
    decodeStation,
    decodeAlert,
    readSnapshot,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
