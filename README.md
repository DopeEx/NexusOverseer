# Nexus Overseer

<p align="center">
  <img src="docs/assets/nexus-overseer-logo.png" alt="Nexus Overseer" width="240">
</p>

Browser extension (Firefox and Chrome) for [Nexus Legacy](https://nexuslegacy.space): statistics, mining, logistics and planning tools in one dashboard.

## Screenshots

All screenshots use the real dashboard with entirely fictional demo data.
No player account, actual coordinates or real economy data is shown.

![Empire dashboard with fictional demo data](docs/assets/screenshots/dashboard.png)

<details>
<summary>All screenshots: statistics, exploration, fleets, simulator, market and options</summary>

### Statistics

![Statistics with fictional demo data](docs/assets/screenshots/statistics.png)

### Asteroid fields

![Asteroid fields with fictional demo data](docs/assets/screenshots/asteroids.png)

### Galaxy Scout

![Galaxy Scout with a fictional galaxy](docs/assets/screenshots/galaxy-scout.png)

### Pirates

![Pirate camps with fictional demo data](docs/assets/screenshots/pirates.png)

### Fleet templates

![Fleet templates with fictional demo data](docs/assets/screenshots/fleet-templates.png)

### Combat simulator

![Combat simulator with fictional fleets and intel](docs/assets/screenshots/combat-simulator.png)

### Market

![Market with fictional offers and trades](docs/assets/screenshots/market.png)

### Tech Tree

![Tech Tree with fictional research progress](docs/assets/screenshots/tech-tree.png)

### Options

![Options in the isolated demo](docs/assets/screenshots/options.png)

### User Guide

![User Guide in the isolated demo](docs/assets/screenshots/user-guide.png)

</details>

## Features

- **Dashboard**: default tab with total resources and hourly production across planets and moons, active missions, research, and per-colony queues and fleets.
- **Statistics**: survey, pirate, mining, battle, debris, expedition, xeno and wormhole reports with all-time, daily, hourly and yesterday views, charts and loss/rebuild costs.
- **Galaxy Scout**: scan systems and arms to find targets.
- **Asteroid Fields**: search by zone and resource type, start mining fleets, and use escort templates.
- **Fleet Templates**: reusable fleet compositions, including escort templates for mining.
- **Market**: browse and track trades.
- **Tech Tree and upgrades**: research overview plus building, ship and tech upgrade queues.
- **Logistics (Quartermaster)**: resource transfers and outpost collections with selectable transport ships.
- **Combat Simulator**: integrated directly into the dashboard, using the game's official combat calculator. Fleet inputs, intel imports, and battle results stay in the same tab.
- **Multiple universes**: data is kept separately for each universe.
- **Backups**: JSON export and import of your data and options (Options > Data).

## How it works

The add-on sends requests through your logged-in game tab, and the browser attaches the game's HttpOnly session cookie. No credentials need to be entered.

Game data is stored locally in `browser.storage.local`. The add-on communicates
directly with the game API; it does not upload data to a server operated by the
add-on author.

## Installation

Download the latest package from the [Releases](https://github.com/DopeEx/NexusOverseer/releases) page:

- **Firefox**: the `.xpi` file
- **Chrome / Edge, manual installation on Windows**: the
  `nexus-overseer-<version>-windows-manual.zip` asset. Extract it to a permanent,
  writable folder, enable developer mode at `chrome://extensions` (Edge:
  `edge://extensions`), and load **only its `addon` subfolder** as an unpacked
  extension. Do not move that folder afterwards.
- **Other manual Chromium installations**: the plain `nexus-overseer-<version>.zip`
  contains only extension files, without the Windows updater.

### Windows manual updates

Double-click `Update-Nexus.bat` in the manual Windows package, then reload the
extension in your browser. No Git or Python installation is needed. Stable
releases are the default; testers can optionally select `master`.

<details>
<summary>Update instructions, backups, troubleshooting and publishing</summary>

Double-click `Update-Nexus.bat` in the extracted manual package. No Git, Python,
Node.js or administrator access is normally needed; Windows PowerShell 5.1
(included with Windows 10/11) is required. The window stays open on completion
or failure. Managed devices may block scripts; system policies are not changed.

The default installs the latest **stable GitHub release**. Testers can explicitly
select **master**, with a warning and confirmation. The updater resolves a
specific commit before downloading it, and records the channel, revision and
installation time in `addon/.nexus-install.json`. Release remains the default
on every run, including after installing master. There is no automatic fallback
to a different channel.

After updating, click **Reload** for the extension on the browser's extensions
page, then reload open game pages. **Do not uninstall the extension.** Keeping
the same loaded path preserves its identity; export data under **Options > Data**
before channel switches or downgrades. Older releases may not understand newer
data formats. File backups do **not** back up browser storage.

File backups and the error log are kept under `.update/backups` and
`.update/updater.log`. Backups are not automatically removed. Interrupted file
replacements are rolled back on the next start. A newer updater is offered
separately and **only from stable releases**, even when testing master.
Self-updates require confirmation and take effect on the next launch. The small
protocol-1 batch starter is intentionally not self-updated: a future incompatible
starter requires re-extracting the manual package while retaining the loaded
`addon` path. SHA-256 checks detect damaged/mismatched payloads; they are not an
independent publisher signature.

For migration from an existing unpacked installation, retain the existing
extension directory and its exact path. If it is named `addon`, place the new
starter and `updater.ps1` in its parent directory. Otherwise a one-time
installation-path change and data export/import may be necessary. See
the included `Installation.txt` for recovery and migration instructions.

Store packages do not contain this updater. Firefox's signed/store installation
uses a different update mechanism; the Windows manual updater is for Chromium.

#### Building and publishing manual packages

`python nexus-addon/build.py --manual` builds only the Windows manual ZIP;
the normal build also generates it alongside both store payloads. The release
workflow attaches all three assets and first runs the Windows updater tests.
The latest stable release must contain the new `*-windows-manual.zip` asset
before release updates or updater checks can work. Older releases are not
retroactively changed. A missing asset is reported explicitly; it never causes
an automatic switch to master.

The shared file list in `tools/windows-updater/addon-files.json` controls both
store packaging and which files a master update copies. When adding extension
files, update that list. Increment `$script:UpdaterVersion` in
`tools/windows-updater/updater.ps1` for updater changes that existing users
should receive. Publish them in a new stable release. Protocol-1 starters
expect a single replaceable `updater.ps1` and the documented recovery markers;
incompatible changes require a new launcher protocol and manual migration.
The old source-tree `update-nexus-addon.bat` is not included in this package;
use the new `Update-Nexus.bat` entry point for the supported manual workflow.

</details>

## Usage

1. Log in to [Nexus Legacy](https://nexuslegacy.space)
2. Click the Nexus Overseer toolbar icon to open the dashboard
3. Use **Scrape Now** to fetch data immediately

## Documentation

- [Local screenshot demo](docs/screenshot-demo.md): run the dashboard with fictional data, without a game account.
- [API integration reference](docs/api-reference.md): API routes used by the add-on, request handling, and observed response shapes.
- [Game reference](docs/game-reference.md): game systems and reference data.
- [Privacy policy](docs/privacy-policy.md): data access, storage, and API actions.
- [Changelog](nexus-addon/CHANGELOG.md)

## License

[Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/)

## Origin

This project started as a fork of [Verroq/NexusAccounting](https://github.com/Verroq/NexusAccounting)
and has since been developed independently. See [NOTICE.md](NOTICE.md) for copyright and attribution details.
