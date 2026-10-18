# Nexus Overseer

Browser extension (Firefox and Chrome) for [Nexus Legacy](https://nexuslegacy.space): statistics, mining, logistics and planning tools in one dashboard.

> Screenshots are being updated and will be added here.

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
- **Chrome** (and other Chromium browsers): the `.zip` file, extracted and loaded as an unpacked extension via `chrome://extensions` with developer mode enabled

## Usage

1. Log in to [Nexus Legacy](https://nexuslegacy.space)
2. Click the Nexus Overseer toolbar icon to open the dashboard
3. Use **Scrape Now** to fetch data immediately

## Documentation

- [API integration reference](docs/api-reference.md): API routes used by the add-on, request handling, and observed response shapes.
- [Game reference](docs/game-reference.md): game systems and reference data.
- [Privacy policy](docs/privacy-policy.md): data access, storage, and API actions.
- [Changelog](nexus-addon/CHANGELOG.md)

## License

[Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/)

## Origin

This project started as a fork of [Verroq/NexusAccounting](https://github.com/Verroq/NexusAccounting)
and has since been developed independently. See [NOTICE.md](NOTICE.md) for copyright and attribution details.
