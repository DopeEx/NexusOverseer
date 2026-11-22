# Project structure

Use this page as a codebase index. Place changes where the behavior belongs,
not merely in whichever module happens to call it.

```text
NexusOverseer/
|-- .github/workflows/
|   |-- test.yml                    # Lint and test workflow
|   `-- release.yml                 # Release packaging and publishing
|-- LICENSE                         # Project license
|-- NOTICE.md                       # Third-party notices and attribution
|-- data/galaxy/                    # Reviewed, public galaxy datasets
|-- docs/
|   |-- api-reference.md            # Observed game API and addon integration
|   |-- game-reference.md           # Game rules and values used by the addon
|   |-- privacy-policy.md           # Privacy information
|   |-- screenshot-demo.md          # Isolated screenshot/demo information
|   `-- structure.md                # This codebase index
|-- nexus-addon/                    # Browser extension source and manifest
|   |-- manifest.json               # Extension entry points and permissions
|   |-- background-sw.js            # Service-worker module entry point
|   |-- background.js               # Background coordination and scheduled API helpers
|   |-- api-scheduler.js             # Central API admission, limits and scheduling
|   |-- game-api-client.js           # Scheduled API client for content scripts and views
|   |-- game-api-bridge.js           # Existing game-tab request transport
|   |-- dashboard.html               # Main dashboard document
|   |-- dashboard.js                 # Main dashboard behavior
|   |-- dashboard.css                # Main dashboard styles
|   |-- tabs/                        # Dashboard tab/page implementations
|   |-- galaxy-*.js                  # Galaxy cache, lookup, sharing and public-data modules
|   |-- diagnostics*.js              # Diagnostics collection, storage and display
|   |-- *-upgrade.js                 # Building, technology and ship upgrade features
|   |-- icons/                       # Extension icons
|   |-- CHANGELOG.md                 # Unreleased changes and release history
|   `-- build.py                     # Store and manual-install package builder
|-- reference/                       # Reference CSS and captured game assets
|-- tests/                           # Node.js tests, grouped by feature/subsystem
|   `-- helpers.js                   # Shared browser and test helpers
|-- tools/
|   |-- demo/                        # Isolated UI demo
|   |-- Import-Galaxy-Data.*         # Public galaxy data import entry points
|   |-- galaxy-data.js               # Galaxy dataset validation and merge tool
|   `-- windows-updater/              # Windows updater and packaged-file list
|-- eslint.config.js                 # Lint configuration
|-- package.json                     # Root lint and test commands
|-- package-lock.json                # Locked npm development dependencies
|-- README.md                        # Project overview and user-facing behavior
`-- ...
```

The add-on is currently organized as a mostly flat set of modules rather than
an application `src/` tree. Keep that layout unless a clear ownership or reuse
boundary justifies creating a directory; do not move files just to make the
tree look more layered.

## Shared dashboard badges

Passive dashboard badges share the `.badge` presentation in `dashboard.css`.
Neutral classifications and information, such as zones, types, alliances,
survey event types, trade directions, active mining markers and diagnostic
request methods, are outlined. Evaluated outcomes and statuses needing attention
use a tinted fill.
The Dashboard's Needs attention badges use the same text size as dashboard
mission rows, a lighter font weight and more padding for readability; other
badges retain the compact default.
Color remains independent of fill: a green zone identifies a category, not a
success. Use `badge-outline` with a semantic color variant when an informational
badge needs that color, and use the shared helpers in `common.js` for repeated
values such as zones and combat outcomes. Format category identifiers with
`formatBadgeLabel`: replace underscores with spaces and capitalize the first
letter. Preserve player and alliance names, diagnostic identifiers and
technical acronyms as supplied. Combat results use Victory, Defeat or Draw
from the player's perspective; missing or unrecognized results stay neutral
instead of being inferred as a defeat. A non-viable Xeno simulation remains a
warning even when the combat itself was won. Interactive filters and mission
progress indicators retain their own controls.

Dashboard report tables use the shared pagination helpers in `pagination.js`.
The General setting controls the page size, and filtering or changing that
setting must keep the current page within the available results.

## Testing large backups

Load the add-on in a separate profile. Import a legacy full backup,
use **Options > Data > Create full backup**, then import the
resulting `.nexus-backup.gz` and check for the same reports and galaxy entries
across universes. Also try importing a truncated copy: validation should
reject it without replacing anything. Keep the original backup unchanged.
If an earlier build saved the compressed backup as `.nexus-backup.txt`,
rename it to `.nexus-backup.gz` before selecting it in the import picker.
Do not decompress it first.

## Conventions and boundaries

- **File and folder names:** Use lowercase `kebab-case` for JavaScript,
  HTML/CSS, Markdown, and new directory names; keep single-word names
  lowercase. Place Node.js tests in `tests/` as `<feature>.test.js`, with a
  kebab-case feature name. Python tests follow `unittest` discovery naming
  (`test_<module>.py` in `snake_case`), and PowerShell scripts use the
  `Verb-Noun` naming convention in PascalCase. Keep canonical names such as
  `README.md`, `CHANGELOG.md`, and `LICENSE`; GitHub's `ISSUE_TEMPLATE`
  directory; upstream reference assets; and the Windows manual package files
  `Update-Nexus.bat` and `Installation.txt`, which the existing updater
  validates by name. Do not rename these for cosmetic consistency.
- **Manifest and packaging:** `nexus-addon/manifest.json` declares the browser
  entry points, permissions and web-accessible resources. The packaged-file
  list in `tools/windows-updater/addon-files.json` also controls which add-on
  files go into release packages. Update both when adding a packaged file.
  `nexus-addon/build.py` builds the ZIP, XPI and Windows manual package.
- **Background and page contexts:** `background-sw.js` loads the polyfill,
  storage shim and background module in order. Game-page scripts and dashboard
  pages run in different contexts; use their existing message and client
  interfaces instead of assuming they share background globals.
- **Game API traffic:** all add-on-initiated game API requests go through the
  central scheduler in `nexus-addon/api-scheduler.js`. Content scripts and
  views use `globalThis.nexusGameApi`; background code uses the scheduled
  helpers in `background.js`. Do not add a direct game API fetch/XHR path or an
  independent queue. Keep retries, priorities, budgets and cooldowns within
  the existing scheduling path.
- **Feature ownership:** keep dashboard UI with its existing dashboard or
  `tabs/` feature modules. Game-page integrations belong with the relevant
  content-script modules. Reusable calculations and state handling belong in
  their existing focused modules rather than being duplicated between views.
- **Galaxy data:** local observations and caches are handled by the galaxy
  modules in `nexus-addon/`. `data/galaxy/` is only for reviewed, public,
  non-personal datasets; follow its [contribution and format guide](../data/galaxy/README.md).
- **Vendored assets:** `nexus-addon/chart.umd.js` is the browser build of
  Chart.js. Preserve its upstream provenance when updating it.
- **Tests:** add regression coverage in the nearest existing
  `tests/*.test.js` file and use `tests/helpers.js` for shared browser stubs.
  API routing and scheduler changes should also cover the central-routing
  boundary in `api-routing.test.js` and `api-scheduler.test.js`.
- **Changelog:** add user-visible changes to the `Unreleased` section of
  `nexus-addon/CHANGELOG.md`. Keep the existing Keep a Changelog format and
  category order.
- **Generated packages:** the ZIP/XPI files at the repository root are build
  outputs. Change source files and rebuild packages; do not edit an archive
  directly.

## Commit and branch naming

For new work, use `<type>(<scope>): <imperative subject>` for commit subjects.
Write in English, start with a lowercase imperative verb, omit a trailing
period, and keep the full subject concise (ideally no more than 72 characters).
Omit the scope for project-wide changes.

| Type | Use |
| --- | --- |
| `feat` | New or substantially changed user-facing behavior |
| `fix` | Correct faulty behavior |
| `refactor` | Internal restructuring without intentional behavior changes |
| `chore` | Repository or dependency maintenance |
| `docs` | Documentation-only changes |
| `test` | Test-only changes |
| `ci` | CI and release workflow changes |

Prefer scopes that identify the main area, such as `api`, `asteroids`,
`dashboard`, `diagnostics`, `galaxy`, `logistics`, `market`, `pirates`,
`upgrades`, or `release`. Keep unrelated outcomes separate; supporting tests
and documentation may stay with their implementation.

Use `<type>/<scope>-<short-description>` for new branch names, in lowercase
kebab-case (for example, `fix/galaxy-cache` or `docs/project-structure`).
These conventions apply to new work; do not rewrite existing commits or rename
existing branches just to normalize them.

## Documentation and validation

- [`README.md`](../README.md): project overview, features, and user-facing behavior.
- [`CHANGELOG.md`](../nexus-addon/CHANGELOG.md): release notes and unreleased changes.
- [`api-reference.md`](./api-reference.md): game API behavior and integration details.
- [`game-reference.md`](./game-reference.md): game rules and reference values.
- [`privacy-policy.md`](./privacy-policy.md): privacy information.
- [`screenshot-demo.md`](./screenshot-demo.md): isolated demo and screenshot notes.
- [`data/galaxy/README.md`](../data/galaxy/README.md): public galaxy data workflow and schema.

Run `npm run check` from the repository root to lint and run the test suite. To
build distribution packages, run `python build.py` from `nexus-addon/`.
