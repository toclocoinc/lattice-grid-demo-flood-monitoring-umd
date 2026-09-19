/**
 * The dashboard: two live feeds from the Environment Agency, fanned through
 * one data router into a stations table and an alerts table, with rolling
 * river-level charts drawn from a small set of headless grids.
 *
 * Nothing here fetches anything and nothing here reaches for the grid's
 * globals: every factory is handed in, so this file is the same whether the
 * library arrived by script tag, as it does here, or by import.
 *
 * How the pieces fit together:
 *
 *   the API  ->  the router  ->  the stations grid   ->  the tiles
 *                             ->  the alerts grid          the charts (headless)
 *
 * The stations grid holds one row per gauging station (its latest level); the
 * alerts grid holds the current flood alerts and warnings. Both arrive in one
 * stream carrying a `kind`, and the router partitions them on it. The rolling
 * charts are a separate concern: one headless grid per notable river, each
 * holding the last two days of readings and feeding a line chart.
 *
 * A classic script: it reads the constants from `FloodDemo`, put there by
 * `ea-feed.js`, and adds `buildDashboard` alongside them.
 */
(function (root) {
  'use strict';

  const { WINDOW_MS, SEVERITY_LABELS, CURATED_STATIONS } = root.FloodDemo;

  /** Make an element with a class and optional text, the long way round. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** One number, written the way a reader expects to see it. */
  function commas(value) {
    return Number(value || 0).toLocaleString('en-GB');
  }

  /** A clock time, local to whoever is reading. */
  function clockText(ms) {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /**
   * A reading's time as an instant.
   *
   * The grid holds `time` as epoch milliseconds, but a KPI panel bound to the
   * grid hands a tile the grid's own value for a datetime column, which is its
   * wall-clock text rather than the number. It is read back into milliseconds
   * before anything does arithmetic on it.
   *
   * @param {number|string} value a projected or raw time
   * @returns {number|null} epoch milliseconds, or null when it cannot be read
   */
  function timeOf(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Columns                                                             */
  /* ------------------------------------------------------------------ */

  function stationColumns() {
    return [
      {
        title: 'The station',
        columns: [
          { id: 'name', field: 'name', title: 'Station', filter: { type: 'text' }, layout: { width: 220 } },
          { id: 'river', field: 'river', title: 'River', filter: { type: 'set' }, layout: { width: 180 } },
          { id: 'catchment', field: 'catchment', title: 'Catchment', filter: { type: 'set' }, layout: { width: 200 } },
        ],
      },
      {
        title: 'The reading',
        columns: [
          { id: 'level', field: 'level', title: 'Level (m)', type: 'number', format: { decimals: 2 }, filter: { type: 'number' }, layout: { width: 110 } },
          { id: 'unit', field: 'unit', title: 'Datum', filter: { type: 'set' }, layout: { width: 90, hidden: true } },
          { id: 'time', field: 'time', title: 'Last reading', type: 'datetime', filter: { type: 'date' }, sort: { direction: 'desc' }, layout: { width: 160 } },
        ],
      },
      {
        title: 'Count',
        columns: [
          { id: 'count', field: 'count', title: 'Stations', type: 'number', total: 'sum', groupTotal: 'sum', filter: { type: 'none' }, layout: { width: 90, hidden: true } },
        ],
      },
    ];
  }

  function alertColumns() {
    return [
      {
        title: 'The warning',
        columns: [
          { id: 'severityLabel', field: 'severityLabel', title: 'Severity', filter: { type: 'set' }, layout: { width: 170 } },
          { id: 'area', field: 'area', title: 'Area', filter: { type: 'text' }, layout: { width: 240 } },
          { id: 'riverOrSea', field: 'riverOrSea', title: 'River or sea', filter: { type: 'set' }, layout: { width: 150 } },
          { id: 'region', field: 'region', title: 'Region', filter: { type: 'set' }, layout: { width: 140 } },
        ],
      },
      {
        title: 'What is happening',
        columns: [
          { id: 'message', field: 'message', title: 'Message', filter: { type: 'text' }, layout: { width: 340 } },
          { id: 'timeRaised', field: 'timeRaised', title: 'Raised', type: 'datetime', filter: { type: 'date' }, layout: { width: 160 } },
          { id: 'count', field: 'count', title: 'Warnings', type: 'number', total: 'sum', groupTotal: 'sum', filter: { type: 'none' }, layout: { width: 90, hidden: true } },
        ],
      },
    ];
  }

  /** Traffic lights for the flood alert severity. */
  function severityFormatting() {
    const colours = {
      'Flood Alert': { background: '#f9a825', color: '#1b1b1b' },
      'Flood Warning': { background: '#ef6c00', color: '#ffffff' },
      'Severe Flood Warning': { background: '#b3261e', color: '#ffffff' },
      'Warning no longer in force': { background: '#667085', color: '#ffffff' },
    };
    return {
      severityLabel: Object.entries(colours).map(([label, style]) => ({
        id: `severity-${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
        label,
        when: { op: 'eq', value: label },
        style: { ...style, fontWeight: '600', textAlign: 'center' },
      })),
    };
  }

  function baseGridConfig(title) {
    return {
      rowKey: 'id',
      theme: 'light',
      density: 'compact',
      stripedRows: true,
      columnMenu: true,
      groupPanel: true,
      statusBar: true,
      find: true,
      grandTotalRow: 'bottom',
      groupDefaultExpanded: 0,
      toolPanel: { side: 'right', panels: ['filters', 'columns', 'formatting'] },
      selection: 'multiple',
      highlightOnChange: { colour: '#ffe8a3', duration: 2500 },
      title,
    };
  }

  /* ------------------------------------------------------------------ */
  /* The dashboard                                                       */
  /* ------------------------------------------------------------------ */

  function buildDashboard({
    root: host,
    createGrid,
    createHeadlessGrid,
    createChart,
    createKPI,
    createTabs,
    createDataRouter,
    stations,
    alerts,
    series,
    curated,
    meta,
  }) {
    host.textContent = '';

    const built = {
      stationsGrid: null,
      alertsGrid: null,
      router: null,
      kpi: null,
      charts: [],
      seriesGrids: {},
      tabs: null,
      store: new Map(),
      status: { lastPoll: null, lastError: null, polls: 0, arrivals: 0, revisions: 0, alerts: { 1: 0, 2: 0, 3: 0 } },
    };

    /* ---------------- the masthead ---------------- */

    const header = el('header', 'head');
    const heading = el('div', 'head-text');
    heading.append(el('h1', null, 'River levels and flood warnings across England, live'));
    heading.append(
      el(
        'p',
        'lede',
        'Live water levels from the Environment Agency\u2019s network of gauging stations, updated every fifteen minutes, ' +
          'with the flood alerts and warnings currently in force. The four charts follow notable rivers over the last two days.',
      ),
    );
    if (meta.fellBack) {
      heading.append(
        el(
          'p',
          'notice',
          'The Environment Agency API could not be reached, so this is the saved copy. Reloading the page will try again.',
        ),
      );
    }
    header.append(heading);

    const provenance = el('div', 'head-note');
    const modePill = el('span', 'pill', meta.live ? 'Live' : 'Saved copy');
    const liveDot = el('span', 'dot');
    if (meta.live) modePill.prepend(liveDot);
    const freshness = el('span', 'freshness', 'Waiting for the first update...');
    provenance.append(modePill, freshness);
    header.append(provenance);
    host.append(header);

    /* ---------------- the tiles ---------------- */

    const kpiHost = el('section', 'kpi-strip');
    kpiHost.setAttribute('aria-label', 'Headline figures');
    const panelHost = el('div', 'kpi-panel');
    const namedTile = el('div', 'kpi-named');
    const namedValue = el('div', 'kpi-named-value', 'No data');
    const namedLabel = el('div', 'kpi-named-label', 'Most gauged river in view');
    namedTile.append(namedValue, namedLabel);
    kpiHost.append(panelHost, namedTile);
    host.append(kpiHost);

    /* ---------------- the charts ---------------- */

    const chartHost = el('section', 'chart-wrap');
    chartHost.setAttribute('aria-label', 'River level charts');
    const chartBoxes = [];
    for (let i = 0; i < CURATED_STATIONS.length; i += 1) {
      const box = el('div', 'chart-box');
      chartHost.append(box);
      chartBoxes.push(box);
    }
    host.append(chartHost);

    /* ---------------- the controls ---------------- */

    const actions = el('div', 'actions');
    host.append(actions);

    /* ---------------- the tables ---------------- */

    const tabsHost = el('section', 'tabs-host');
    host.append(tabsHost);

    const tabs = createTabs(tabsHost, {
      createGrid,
      ariaLabel: 'Flood views',
      tabs: [
        {
          id: 'stations',
          label: 'River levels',
          badge: true,
          config: { ...baseGridConfig('Gauging stations and their latest level'), columns: stationColumns(), rows: [] },
        },
        {
          id: 'alerts',
          label: 'Flood warnings',
          badge: true,
          config: { ...baseGridConfig('Flood alerts and warnings currently in force'), columns: alertColumns(), formatting: severityFormatting(), rows: [] },
        },
      ],
    });
    built.tabs = tabs;
    built.stationsGrid = tabs.tab('stations');

    /* ---------------- the router ---------------- */

    /*
     * One stream in, two tables out, split on `kind`. A station row and an
     * alert row never share a value, so the two tables never claim the same
     * record. The counting subscriber below matches every row, which is what
     * the "N new, M revised" readout reads; `overlap: true` lets one row reach
     * both its table and that subscriber.
     */
    const router = createDataRouter({
      key: (row) => row.kind,
      rowKey: 'id',
      overlap: true,
    });
    built.router = router;

    router.attach(built.stationsGrid, 'station');
    router.subscribe(() => true, (change) => {
      built.status.arrivals += (change.add || []).length;
      built.status.revisions += (change.update || []).length;
    });

    const ingest = (incoming) => {
      if (!incoming || !incoming.length) return 0;
      for (const row of incoming) built.store.set(`${row.kind}:${row.id}`, row);
      router.apply(incoming.map((row) => ({ op: 'upsert', row })));
      return incoming.length;
    };

    /* The alerts table is built the first time its tab is opened. */
    const attachAlerts = () => {
      if (built.alertsGrid) return;
      const grid = tabs.tab('alerts');
      if (!grid) return;
      built.alertsGrid = grid;
      router.attach(grid, 'alert');
      router.load([...built.store.values()]);
    };
    tabs.on('tab:changed', (event) => {
      if (event.id === 'alerts') attachAlerts();
    });

    /* The first load. A snapshot is a keyed diff, so calling this again later
       updates what changed rather than repainting everything. */
    for (const row of [...stations, ...alerts]) built.store.set(`${row.kind}:${row.id}`, row);
    router.load([...built.store.values()]);

    /* ---------------- the tiles, bound to the stations table ---------------- */

    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;

    const kpi = createKPI(panelHost, {
      grid: built.stationsGrid,
      rowKey: 'id',
      fields: ['river', 'catchment', 'time', 'name'],
      columns: 5,
      ariaLabel: 'Headline figures',
      tiles: [
        { id: 'stations', label: 'Gauging stations', aggregation: 'count', format: 'number' },
        {
          id: 'rivers',
          label: 'Rivers in view',
          aggregation: 'custom',
          format: 'number',
          compute: (rows) => new Set(rows.map((r) => r.river).filter(Boolean)).size,
        },
        {
          id: 'fresh',
          label: 'Read in the last hour',
          aggregation: 'custom',
          format: 'number',
          compute: (rows) => rows.filter((r) => {
            const t = timeOf(r.time);
            return t != null && Date.now() - t <= HOUR_MS;
          }).length,
        },
        {
          id: 'stale',
          label: 'Stale over 24h',
          aggregation: 'custom',
          format: 'number',
          compute: (rows) => rows.filter((r) => {
            const t = timeOf(r.time);
            return t == null || Date.now() - t > DAY_MS;
          }).length,
        },
        {
          id: 'catchments',
          label: 'Catchments in view',
          aggregation: 'custom',
          format: 'number',
          compute: (rows) => new Set(rows.map((r) => r.catchment).filter(Boolean)).size,
        },
      ],
    });
    built.kpi = kpi;

    /** Name the river that has the most gauging stations in view. */
    const refreshNamedTile = () => {
      const byRiver = new Map();
      /* Read the grid's own rows rather than the panel's projection. Stations
         with no river on the record are skipped, so the "most gauged" reading
         is a real river rather than the empty label. */
      built.stationsGrid.rows.forEach((r) => {
        const row = r && r.data;
        const river = row && row.river;
        if (!river) return;
        byRiver.set(river, (byRiver.get(river) || 0) + 1);
      });
      let best = null;
      for (const [river, n] of byRiver) if (!best || n > best.n) best = { river, n };
      if (!best) {
        namedValue.textContent = 'No data';
        namedLabel.textContent = 'Most gauged river in view';
        return;
      }
      namedValue.textContent = best.river;
      namedLabel.textContent = `Most gauged in view, ${commas(best.n)} stations`;
    };
    kpi.on('change', refreshNamedTile);
    refreshNamedTile();

    /* ---------------- the rolling charts ---------------- */

    const trimWindow = (rows) => rows.filter((row) => Date.now() - row.time <= WINDOW_MS);

    const chartSpecs = curated.map((entry, index) => ({
      box: chartBoxes[index],
      ref: entry.ref,
      title: entry.river || entry.label,
      subtitle: entry.label,
    }));

    for (const spec of chartSpecs) {
      try {
        const grid = createHeadlessGrid({
          rowKey: 'id',
          columns: [
            { id: 'time', field: 'time', type: 'datetime' },
            { id: 'level', field: 'level', type: 'number', format: { decimals: 2 } },
          ],
        });
        built.seriesGrids[spec.ref] = grid;
        const chart = createChart({
          grid,
          container: spec.box,
          type: 'line',
          x: 'time',
          y: 'level',
          title: spec.title,
          axis: { y: 'Level (m)', x: { labels: true } },
          legend: false,
        });
        built.charts.push(chart);
      } catch (error) {
        spec.box.append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
        console.error('[flood demo] chart', spec.ref, error);
      }
    }

    /** Push fresh readings into the rolling charts. */
    const updateSeries = (nextSeries) => {
      for (const spec of chartSpecs) {
        const grid = built.seriesGrids[spec.ref];
        if (!grid) continue;
        const rows = trimWindow((nextSeries && nextSeries[spec.ref]) || []);
        grid.rows.load(rows);
      }
    };
    built.updateSeries = updateSeries;
    updateSeries(series);

    /* ---------------- the controls ---------------- */

    const button = (label, onClick, className) => {
      const node = el('button', className || 'action', label);
      node.type = 'button';
      node.addEventListener('click', onClick);
      return node;
    };

    const group = (ids) => () => built.stationsGrid && built.stationsGrid.columns.group(ids);

    actions.append(el('span', 'actions-label', 'Group by'));
    actions.append(button('River', group(['river'])));
    actions.append(button('Catchment', group(['catchment'])));
    actions.append(button('River, then catchment', group(['river', 'catchment'])));
    actions.append(button('No grouping', group([])));

    actions.append(el('span', 'actions-gap'));
    actions.append(el('span', 'actions-label', 'Order by'));
    actions.append(button('Name A\u2013Z', () => built.stationsGrid && built.stationsGrid.sort.set([{ col: 'name', dir: 'asc' }])));
    actions.append(button('Highest level first', () => built.stationsGrid && built.stationsGrid.sort.set([{ col: 'level', dir: 'desc' }])));
    actions.append(button('Most recent reading', () => built.stationsGrid && built.stationsGrid.sort.set([{ col: 'time', dir: 'desc' }])));

    const staleButton = button('Only stale stations', () => {
      const on = staleButton.getAttribute('aria-pressed') === 'true';
      built.stationsGrid.filters.where('stale', on ? null : (row) => typeof row.time !== 'number' || Date.now() - row.time > DAY_MS);
      staleButton.setAttribute('aria-pressed', String(!on));
      staleButton.classList.toggle('on', !on);
    }, 'action toggle');
    staleButton.setAttribute('aria-pressed', 'false');
    actions.append(el('span', 'actions-gap'));
    actions.append(staleButton);
    built.staleButton = staleButton;

    const showActionsFor = (id) => {
      actions.hidden = id !== 'stations';
    };
    showActionsFor(tabs.activeId);
    tabs.on('tab:changed', (event) => showActionsFor(event.id));

    /* ---------------- the live readout ---------------- */

    const alertSummary = () => {
      const c = built.status.alerts;
      if (!c[1] && !c[2] && !c[3]) return 'No flood warnings in force.';
      const parts = [];
      if (c[3]) parts.push(`${c[3]} severe`);
      if (c[2]) parts.push(`${c[2]} warning${c[2] === 1 ? '' : 's'}`);
      if (c[1]) parts.push(`${c[1]} alert${c[1] === 1 ? '' : 's'}`);
      return `${parts.join(', ')} in force.`;
    };

    const setFreshness = () => {
      if (!meta.live) {
        const saved = new Date(meta.fetchedAt).toLocaleString('en-GB');
        freshness.textContent = `A saved copy of the flood monitoring data, taken on ${saved}.`;
        freshness.className = 'freshness';
        return;
      }
      if (built.status.lastError) {
        freshness.textContent = built.status.lastPoll
          ? `Could not reach the API. Still showing what arrived at ${clockText(built.status.lastPoll)}.`
          : 'Could not reach the API.';
        freshness.className = 'freshness failed';
        return;
      }
      if (!built.status.lastPoll) {
        freshness.textContent = 'Waiting for the first update...';
        freshness.className = 'freshness';
        return;
      }
      freshness.textContent = `Updated ${clockText(built.status.lastPoll)}. ${alertSummary()}`;
      freshness.className = 'freshness';
    };
    built.setFreshness = setFreshness;

    built.onPoll = (result) => {
      built.status.lastPoll = result.fetchedAt || Date.now();
      built.status.lastError = null;
      built.status.polls += 1;
      liveDot.classList.add('beat');
      setTimeout(() => liveDot.classList.remove('beat'), 900);
      ingest([...result.stations, ...result.alerts]);
      const counts = { 1: 0, 2: 0, 3: 0 };
      for (const row of result.alerts) if (counts[row.severity] != null) counts[row.severity] += 1;
      built.status.alerts = counts;
      updateSeries(result.series);
      setFreshness();
    };

    built.onPollError = (error) => {
      built.status.lastError = String((error && error.message) || error);
      setFreshness();
      console.warn('[flood demo] a poll failed:', built.status.lastError);
    };

    built.ingest = ingest;

    /* Seed the alert counts from the opening data. */
    const seedCounts = { 1: 0, 2: 0, 3: 0 };
    for (const row of alerts) if (seedCounts[row.severity] != null) seedCounts[row.severity] += 1;
    built.status.alerts = seedCounts;

    setFreshness();

    /* ---------------- the footer ---------------- */

    const footer = el('footer', 'foot');
    const line = el('p', null, 'River level and flood warning data from the ');
    const link = el('a', null, 'Environment Agency flood monitoring API');
    link.href = 'https://environment.data.gov.uk/flood-monitoring/doc/reference';
    link.rel = 'noopener';
    line.append(link);
    line.append(
      document.createTextNode(
        '. Published under the Open Government Licence v3.0 and free to use. Levels are metres above a local datum, ' +
          'which differs between stations, so figures are read station by station rather than compared across rivers. ' +
          'Flood warnings appear only while a river actually threatens to flood.',
      ),
    );
    footer.append(line);
    host.append(footer);

    built.destroy = () => {
      for (const chart of built.charts) chart.destroy();
      kpi.destroy();
      router.destroy();
      tabs.destroy();
    };

    return built;
  }

  root.FloodDemo.buildDashboard = buildDashboard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
