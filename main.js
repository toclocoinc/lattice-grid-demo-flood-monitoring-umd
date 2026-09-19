/**
 * The entry point: work out where the data should come from, fetch it, hand
 * it to the dashboard, and then keep it moving.
 *
 * Two ways to open the page:
 *
 *   (nothing)            live, reading the EA flood API and polling for changes
 *   ?source=snapshot     the saved copy in `data/snapshot`, no API needed
 *
 * When the live API cannot be reached the page opens the saved copy instead
 * and says so at the top, rather than showing an error.
 *
 * This is the script-tag edition. The grid and its modules arrived as classic
 * `<script src>` tags from jsDelivr, ahead of this file, and left globals
 * behind. This file picks the factories off those globals and hands them to
 * the dashboard, which never touches a global itself.
 */
(function (root) {
  'use strict';

  const TITLE = 'River levels and flood warnings across England, live';

  const host = document.querySelector('#app');
  const params = new URLSearchParams(location.search);
  const mode = params.get('source') === 'snapshot' ? 'snapshot' : 'live';

  /** Draw the waiting state, and return a function that updates its message. */
  function showProgress(first) {
    host.textContent = '';
    const panel = document.createElement('div');
    panel.className = 'loading';
    const title = document.createElement('h1');
    title.textContent = TITLE;
    const message = document.createElement('p');
    message.className = 'loading-message';
    message.textContent = first;
    const bar = document.createElement('div');
    bar.className = 'loading-bar';
    const fill = document.createElement('div');
    fill.className = 'loading-fill';
    bar.append(fill);
    panel.append(title, message, bar);
    host.append(panel);
    return (text, fraction) => {
      message.textContent = text;
      fill.style.width = `${Math.round((fraction || 0) * 100)}%`;
    };
  }

  /** Say what went wrong, in words a reader can act on. */
  function showError(error) {
    host.textContent = '';
    const panel = document.createElement('div');
    panel.className = 'loading';
    const title = document.createElement('h1');
    title.textContent = 'The flood monitoring data could not be loaded';
    const message = document.createElement('p');
    message.className = 'loading-message';
    message.textContent = String((error && error.message) || error);
    const hint = document.createElement('p');
    hint.className = 'loading-message';
    hint.textContent = 'You can open the same dashboard from the saved copy by adding ?source=snapshot to the address.';
    panel.append(title, message, hint);
    host.append(panel);
    console.error('[flood demo]', error);
  }

  /**
   * The grid's factories, read off the globals the script tags left behind.
   *
   * @returns {object} the factories and `setLicence`
   */
  function libraryFromGlobals() {
    const missing = [];
    const need = (object, name, what) => {
      const value = object && object[name];
      if (typeof value !== 'function') missing.push(what);
      return value;
    };
    const createGrid = need(root.LatticeGrid, 'createGrid', 'lattice-grid.min.js (LatticeGrid.createGrid)');
    const createHeadlessGrid = need(root.LatticeGrid, 'createHeadlessGrid', 'lattice-grid.min.js (LatticeGrid.createHeadlessGrid)');
    const setLicence = need(root.LatticeGrid, 'setLicence', 'lattice-grid.min.js (LatticeGrid.setLicence)');
    const createChart = need(root.LatticeGrid, 'createChart', 'modules/charts.min.js (LatticeGrid.createChart)');
    const createDataRouter = need(root.LatticeGridDataRouter, 'createDataRouter', 'modules/data-router.min.js (LatticeGridDataRouter.createDataRouter)');
    const createKPI = need(root.LatticeGridKPI, 'createKPI', 'modules/kpi.min.js (LatticeGridKPI.createKPI)');
    const createTabs = need(root.LatticeGridTabs, 'createTabs', 'modules/tabs.min.js (LatticeGridTabs.createTabs)');
    if (missing.length) {
      throw new Error(
        `The grid did not load from the CDN. Missing: ${missing.join('; ')}. ` +
          'Check that the script tags in index.html are reachable and in order, with the core first.',
      );
    }
    return { createGrid, createHeadlessGrid, setLicence, createChart, createDataRouter, createKPI, createTabs };
  }

  async function start() {
    const started = performance.now();
    try {
      const { createGrid, createHeadlessGrid, setLicence, createChart, createDataRouter, createKPI, createTabs } = libraryFromGlobals();
      const { buildDashboard, fetchInitial, readSnapshot, startPolling, STATIONS_POLL_MS } = root.FloodDemo;

      setLicence(DEMO_LICENCE);

      let stations;
      let alerts;
      let series;
      let curated;
      let meta;

      if (mode === 'snapshot') {
        const update = showProgress('Reading the saved copy...');
        const saved = await readSnapshot();
        stations = saved.stations;
        alerts = saved.alerts;
        series = saved.series;
        meta = saved.meta;
        curated = saved.meta.curated;
        update('Building the dashboard...', 1);
      } else {
        const update = showProgress('Reading the Environment Agency flood monitoring API...');
        try {
          const initial = await fetchInitial({ onProgress: update });
          stations = initial.stations;
          alerts = initial.alerts;
          series = initial.series;
          curated = initial.curated;
          meta = { live: true, fetchedAt: Date.now(), curated };
        } catch (liveError) {
          console.warn('[flood demo] the live fetch failed, falling back to the saved copy:', liveError);
          update('The Environment Agency API could not be reached. Opening the saved copy...', 1);
          const saved = await readSnapshot();
          stations = saved.stations;
          alerts = saved.alerts;
          series = saved.series;
          meta = { ...saved.meta, live: false, fellBack: true };
          curated = saved.meta.curated;
        }
      }

      const fetched = performance.now();

      const built = buildDashboard({
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
      });

      let poller = null;
      if (mode === 'live' && meta.live) {
        poller = startPolling({
          intervalMs: STATIONS_POLL_MS,
          onPoll: (result) => built.onPoll(result),
          onError: (error) => built.onPollError(error),
        });
        built.poller = poller;
      }

      const finished = performance.now();
      const timings = {
        mode,
        fellBack: !!meta.fellBack,
        stations: built.stationsGrid ? built.stationsGrid.rows.count() : 0,
        alerts: alerts.length,
        fetchMs: Math.round(fetched - started),
        buildMs: Math.round(finished - fetched),
        totalMs: Math.round(finished - started),
      };

      root.__floodDemo = Object.assign(built, { meta, timings, ready: true });
      console.log('[flood demo] ready', timings);
    } catch (error) {
      root.__floodDemo = { ready: false, error: String((error && error.message) || error) };
      showError(error);
    }
  }

  start();
})(window);
