# Screenshot demo

The local demo serves the **actual dashboard HTML, CSS and rendering modules**
with hand-authored, fictional data. It is intended for public screenshots and UI
previews, not gameplay or balance testing.

## Start

Requires Node.js 24 or newer. No additional dependencies or game login are needed.
From the repository root:

```sh
npm run demo
```

Open <http://127.0.0.1:4173/> in a browser. Stop the server with `Ctrl+C`.
On Windows, if PowerShell blocks the npm script wrapper, use `npm.cmd run demo`
or `node tools\demo\server.js`.

The server listens only on `127.0.0.1`. To use another port, set `PORT` before
starting it (for example, `$env:PORT = '4174'` in PowerShell).

## Isolation and limitations

- No account data, backups, credentials or game APIs are read. The fixtures are
  defined in [fixtures.js](../tools/demo/fixtures.js), not anonymized exports.
- The extension's browser API and server-storage scripts are replaced **only in
  the locally served page**. The packaged extension and its source files remain
  unchanged.
- Storage is kept in memory and discarded on reload. It does not use extension
  storage, localStorage, IndexedDB or cookies.
- The page's Content Security Policy blocks external API connections and remote
  images. Resource icons are generated locally as placeholder artwork.
- Import controls are disabled so personal exports cannot accidentally populate
  the demo.
- Read operations use explicit mock responses. Game actions, scraping, backups
  and unsupported messages return a visible error rather than performing an
  action or pretending it succeeded.
- Combat setup and intel imports can be previewed, but **Simulate battle** is
  intentionally unavailable: the demo does not implement the game's calculator.
  Ship definitions, research, costs and fuel estimates are illustrative.
- Time is fixed at `2030-04-12T12:00:00Z`, so countdowns and report ranges do not
  expire. Date formatting follows the browser's locale and time zone.
- The demo covers the eleven regular dashboard tabs listed below.

The universe picker and footer identify the page as a fictional demo.

## Updating screenshots

Save public images in [assets/screenshots/](assets/screenshots/) using descriptive,
lowercase names. Replace the existing file to preserve README links.

Use a consistent desktop browser size, zoom and theme across the series. The
current images are normalized to a common width of 1600 pixels and cropped at
the bottom of the main navigation (about 940-950 pixels high). Content below
that edge is intentionally cut off, like a normal browser viewport screenshot.
Do not resize or compress the content vertically to make it fit. Let charts and
images finish rendering before capturing. Never mix real-account screenshots
into this set.

All eleven regular main tabs are covered:

| View | File | Preparation after opening the demo |
| --- | --- | --- |
| Dashboard | `dashboard.png` | Default view |
| Statistics | `statistics.png` | Global subtab, all time, all zones |
| Asteroids | `asteroids.png` | The fictional cached scan is loaded automatically |
| Galaxy Scout | `galaxy-scout.png` | Demo Arm 1, sectors `1-2`, unowned only; click Search |
| Pirates | `pirates.png` | Camps and battle reports load automatically |
| Fleets | `fleet-templates.png` | Select Demo - Balanced Mining |
| Simulator | `combat-simulator.png` | Load my fleet from Aurora, then select the Demo Frontier spy report |
| Market | `market.png` | Public offers, all trade history |
| Tech Tree | `tech-tree.png` | All branches; the example research queue is prefilled |
| Options | `options.png` | Default demo preferences |
| User Guide | `user-guide.png` | Top of the guide, cropped to the navigation height |

Link images from the repository README using relative paths, for example:

```md
![Empire dashboard with fictional demo data](docs/assets/screenshots/dashboard.png)
```

## Validation

```sh
node --test tests/demo.test.js
```

The tests cover deterministic fixtures, memory-only storage, explicit rejection
of game actions, disabled imports, local placeholder assets and demo-server
isolation from the extension's source files.
