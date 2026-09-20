# River levels and flood warnings across England, live

A live dashboard of the Environment Agency's network of river gauging stations,
with rolling-window charts for notable rivers and the flood alerts and warnings
currently in force, built on Lattice Grid loaded by `<script>` tag: no npm
install, no bundler, no build step, no `type="module"`.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-flood-monitoring-umd/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| Grid repository | [toclocoinc/latticegrid](https://github.com/toclocoinc/latticegrid) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |
| The same demo as an ESM package | [lattice-grid-demo-flood-monitoring](https://github.com/toclocoinc/lattice-grid-demo-flood-monitoring) |

It is two live feeds fanned through one data router: the stations feed (one row
per gauging station, its latest level) and the alerts feed (the flood alerts and
warnings the Environment Agency has currently raised). The router partitions
them by `kind`, so the two tables never mix. Four rolling line charts follow
notable rivers over the last two days.

The point of the demo is live, keyless data with a rolling window. The API needs
no key and answers with open cross-origin headers, so the browser reads it
directly; the page polls every fifteen minutes and each new reading lands on its
station's chart, pushing the oldest reading out of the two-day window.

## How the grid gets onto the page

Six tags in `index.html`, and that is the whole of the library setup:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/lattice-grid.min.css">

<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/lattice-grid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/modules/charts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/modules/data-router.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/modules/kpi.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/modules/tabs.min.js"></script>
```

Each file is the package's UMD build and leaves a global behind:

| File | Global | Used here for |
| --- | --- | --- |
| `lattice-grid.min.js` | `LatticeGrid` | `createGrid`, `createHeadlessGrid`, `setLicence` |
| `modules/charts.min.js` | extends `LatticeGrid` | `LatticeGrid.createChart` |
| `modules/data-router.min.js` | `LatticeGridDataRouter` | `createDataRouter` |
| `modules/kpi.min.js` | `LatticeGridKPI` | `createKPI` |
| `modules/tabs.min.js` | `LatticeGridTabs` | `createTabs` |

The charts module folds its exports into the core global rather than defining
one of its own, so its tag must come after the core's. The other three are
self-contained and can go in any order. `main.js` checks that every factory it
needs is actually there before it draws anything.

Every address names the exact release, `1.63.0`, and every tag carries the
`integrity` hash of the file it expects. The hashes are the SHA-384 of the
published files.

The demo's own code is four classic scripts, loaded in order: `src/licence.js`,
`src/ea-feed.js`, `src/dashboard.js`, `main.js`. Each file wraps itself in a
function and puts what it offers on one plain object, `FloodDemo`, for the next
file to read. `src/dashboard.js` is handed the grid's factories as arguments
and never touches a global itself.

## Running it

You need nothing but a browser and a way to serve the folder, because the page
fetches its data with `fetch()` and browsers will not do that from `file://`:

```
node tools/serve.mjs
```

| Address | What you get |
| --- | --- |
| `/` | live, reading the EA flood API and polling every fifteen minutes |
| `/?source=snapshot` | the saved copy in `data/snapshot`, no API needed |

Running a copy on your own machine needs no licence key. Publishing it on a
web address does.

## What it shows

**One stream, two tables.** The stations feed and the alerts feed both carry a
`kind`, and the router splits them into the "River levels" table (one row per
station) and the "Flood warnings" table (one row per alert or warning). A
pushed alert lands in the warnings table and never leaks into the levels table.

**Rolling-window charts.** Four notable rivers — the Severn at Worcester, the
Thames at Kingston, the Trent at Colwick and the Derwent at Derby City — each
get a headless grid holding the last two days of fifteen-minute readings, and a
line chart bound to it. As the feed arrives, new points enter on the right and
old ones leave on the left.

**Figures that follow the table.** The strip of tiles reads the stations table:
gauging stations in view, rivers in view, how many read in the last hour, how
many have gone stale, and catchments in view. Group by river or by catchment and
every figure follows.

**Flood warnings that read as colours.** The warnings table colours each row by
severity — amber for a Flood Alert, orange for a Flood Warning, red for a
Severe Flood Warning. In dry months the table is empty, which is the honest
state: the Environment Agency only raises a warning while a river actually
threatens to flood.

**A feed that can fail.** If a poll cannot reach the Environment Agency the page
says so and keeps showing what it already had. If the API cannot be reached when
the page first opens, it shows the saved copy instead and says so under the
title.

## The data

Everything comes from the Environment Agency flood monitoring API:

- <https://environment.data.gov.uk/flood-monitoring/doc/reference>

The page reads the station list, the latest level at every station, the flood
alerts, and a two-day window of readings for each notable river:

- `https://environment.data.gov.uk/flood-monitoring/id/stations?parameter=level&qualifier=Stage`
- `https://environment.data.gov.uk/flood-monitoring/data/readings?latest&parameter=level&qualifier=Stage`
- `https://environment.data.gov.uk/flood-monitoring/id/floods`
- `https://environment.data.gov.uk/flood-monitoring/id/stations/{ref}/readings`

The API is public, needs no key, and answers with `Access-Control-Allow-Origin: *`,
so the browser reads it directly. The data are published under the Open
Government Licence v3.0 and are free to use.

A few things worth knowing about the data:

- Levels are metres above a **local datum** (`mASD` or `mAOD`), which differs
  between stations. The figures are read station by station — the rolling charts
  each show one river's trend — rather than compared across rivers.
- Readings are published every fifteen minutes, so a two-day window is about 190
  points per station.
- A station can go quiet. A reading older than 24 hours counts as "stale" in the
  tiles, and the "Only stale stations" filter narrows the table to them.
- `riverName` is blank on a small share of stations (about a quarter). They are
  counted as stations but are not attributed to a river.
- Flood alerts and warnings only exist while a river threatens to flood, so the
  warnings table is empty most of the year. The saved copy records an empty
  warnings feed for exactly this reason; the mechanism is the same in a storm.

## Files

```
index.html                page shell, and the six library tags
main.js                   works out where the data comes from, then starts
src/licence.js            the key for this demo's own published address
src/ea-feed.js            the API: stations, readings, alerts, polling, snapshot
src/dashboard.js          the views: router, tables, tiles, rolling charts
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save a real run into data/snapshot
tools/verify.mjs          open it in a real browser and check it
data/snapshot/            a saved run, so the demo works without the API
```

There is no `package.json` and no `node_modules`. The tools need Node 22 or
newer and nothing else.

## Building the saved copy

```
node tools/build-snapshot.mjs
```

It reads the stations, the latest levels, the current alerts and two days of
readings for each notable river, then writes compact arrays to `data/snapshot/`.
Re-run it to refresh the copy.

## Checking it

```
node tools/verify.mjs        # open the page in a real browser and assert
node tools/verify.mjs --all  # also open the live API
```

`tools/verify.mjs` first insists on how the library arrived: no `type="module"`
script anywhere on the page, five script tags pointing at the pinned release on
the CDN, each with an integrity hash, and each leaving the global it documents.
It then recomputes the headline figures from the saved data and compares them
with what the page is showing, checks the four rolling charts drew marks, groups
by river and by catchment, opens the warnings table and pushes an alert through
to prove it lands there and not in the stations table, and finally blocks the
Environment Agency API in the browser and insists the saved copy appears with a
notice saying why. The GitHub Pages workflow runs it before every publish.

## Licence

The demo code is MIT. See `LICENSE`.

The flood monitoring data is from the Environment Agency, published under the
Open Government Licence v3.0.

Lattice Grid itself is a separate commercial product with its own terms. It is
free to use on localhost, with no key and no watermark, so a copy of this
repository runs unrestricted on your own machine. This demo carries a key for
its own published address only, which is why you will find one in the source.
Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).

---
Built with [Lattice Grid](https://www.latticegrid.dev), a JavaScript data grid with a Data Router: one live feed keeps grids, charts, boards, Gantt and KPI tiles in step. [Documentation](https://www.latticegrid.dev/docs/) · [Demos](https://www.latticegrid.dev/demos/) · [Licence](https://www.latticegrid.dev/licence/)
