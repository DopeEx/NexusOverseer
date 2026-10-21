# Privacy Policy — Nexus Overseer

**Last updated: 2026-10-20**

Nexus Overseer is a browser extension that reads your Nexus Legacy game data and displays it locally as a personal accounting dashboard. This policy describes exactly what data the extension accesses, how it is used, and where it goes.

---

## 1. Data collected

The extension reads the following data from the currently selected Nexus Legacy game server (for example, `s0.nexuslegacy.space`) on your behalf:

| Category | Examples |
|---|---|
| Mission reports | Survey, pirate raid, mining, expedition, wormhole run, and debris collection results |
| Fleet data | Your stationed ships; your own fleet compositions sent on missions |
| Combat intelligence | Enemy fleet and defense data from spy and camp-scout reports you ran in game |
| Research | Your tech tree progress, active research, per-planet lab levels and speed |
| Planets & buildings | Your planets, their buildings (to read lab levels), and stationed fleets |
| Galaxy map | System names, security zones, arm/sector coordinates (for zone tagging and the planet finder) |
| Live galaxy hints | Verified incoming `colonized` WebSocket notifications: system ID, presence-of-colonies flag and local capture time; stored locally per universe independently of diagnostic recording |
| Fuel logs | Hydrogen cost per launched mission (type, zone, amount) |
| Player and alliance data | Player identity, alliance details, and ranking data used by the finder |
| Trade and logistics | Market orders and trades, logistics outposts, moons, and related fleet/resource state |
| System activity | System messages and debris data used by exploration and collection features |
| Optional developer diagnostics | When explicitly enabled: API method/path/status and request/response bodies, incoming text WebSocket messages, and extracted galaxy delta events |
| API traffic control | Native game fetch/XHR start counts, endpoint scope and allowlisted rate-limit/retry response headers, observed independently of diagnostic recording |
| Optional API wait recording | Fixed operation labels, priorities, scope/window budget counts, wait start/end times, outcomes, response status and recent source contribution counts; no paths, identifiers, request or response contents |

Diagnostic recording is off by default. It excludes request/response headers,
URL query strings and authentication endpoints, and redacts recognized secret
fields and token patterns before relaying and storing data. Other private game
data may remain in payloads. Recording is local only and does not upload logs.
Functional galaxy hints are separate from these optional logs: only the
supported system-level fields are retained from the event, without a planet or
player identity. A new hint for a known, fully visible system can trigger a
rate-limited game API request to refresh locally saved planet/moon ownership.
This adds no WebSocket subscription, external upload or community sharing.

Traffic control is separate from diagnostic recording. It observes native game
fetch/XHR timing and selected budget headers without delaying the game's
requests or collecting request/response bodies, query strings, cookies or
authorization headers for this purpose. Rolling request timestamps, budget
values and cooldowns are kept in extension `storage.session` so worker restarts
do not reset the scheduler. This session state contains no request bodies or
device fingerprints and is not part of regular backups.

**Record API wait times**, under Options > Developer / Debug, is a separate
opt-in switch, off by default and independent of payload recording. Scheduling
metadata stays in the local diagnostic database per universe, limited to 5,000
events and sharing the 10 MB per-server diagnostic storage cap. It can be viewed,
exported as JSONL or cleared in API Wait Times. Regular backups exclude it.
Worker-interrupted waits are marked incomplete when recording next resumes;
unknown elapsed time is not invented. Disabling the switch stops new writes,
but retained events remain until cleared or removed by retention.

The extension does not read or extract the session cookie. It sends API requests through your logged-in game tab, where the browser attaches the game's HttpOnly session cookie. The extension does not write or modify cookies.

---

## 2. How the data is used

All data is used **solely to operate the extension's dashboard** on your own device:

- Build aggregated statistics (resources collected, ships lost, fuel spent, etc.)
- Render charts, history tables, and the tech-tree planner
- Run the offline combat simulator
- Support the planet finder, asteroid scans, fleet logistics, and market views
- Diagnose addon behavior using optional, locally recorded developer logs
- Schedule add-on API requests within observed budgets and endpoint limits,
  prioritizing actions and interactions over background maintenance

No data is used for advertising, profiling, or any purpose unrelated to displaying your own game statistics back to you.

---

## 3. Where the data is stored

All data is stored **locally on your device only**, in the browser's `storage.local` area, extension `storage.session` for temporary API scheduling state, or extension-local IndexedDB databases for galaxy knowledge and optional diagnostic traffic. Nothing is uploaded to any server operated by the extension author.

The local galaxy database retains known system, planet and moon properties,
ownership observations and short-lived asteroid snapshots separately for each
universe. It also learns from successful galaxy responses the game loads while
you play, independently of optional diagnostic recording. Physical properties
do not expire automatically. **Options > Data > Danger zone > Clear galaxy
cache** removes the selected universe's saved galaxy knowledge after a warning
and confirmation. Regular JSON backups include this database and installed
public base data. Public datasets are stored separately from personal game
observations and never create ownership, visibility or observation timestamps.

The extension also writes automatic backup files to your `Downloads/NexusOverseer/` folder before destructive operations (reset, import, schema migrations) and as a weekly auto-backup. These files are plain JSON and remain on your device under your control.

---

## 4. Data sharing and third parties

**The extension never uploads game data to a third party.** Game requests are between your browser and `nexuslegacy.space` (the game's own servers). The extension does not contact any analytics service or telemetry endpoint.

### Public galaxy structure

In all addon packages, public galaxy updates default on and can be disabled
under **Options > Data > Public galaxy data**. While a dashboard is open,
the addon can request a public manifest and, when its checksum changes, the
selected universe's public dataset from
`raw.githubusercontent.com/DopeEx/NexusOverseer/master/data/galaxy/`.
Checks run at most once per 24 hours per universe, including failed attempts.
The manual update button can check immediately, with a 30-second repeat limit.
No checks run with all dashboards closed.

These are download-only GET requests containing public repository paths and a
server key, with no game data, credentials, cookies or referrers. GitHub receives
normal connection metadata such as your IP address. Existing local observations
take priority over public structure.

The separate **Export public data** action previews counts and, after your
confirmation, creates a local JSON file from saved data only. A fixed whitelist
includes system names/zones/coordinates, planet and moon physical properties,
station names/locations, hub locations and arms. It excludes player and alliance
identities, ownership, colony names, explored visibility, colony flags,
resources, buildings and upgrade-dependent slot values. It performs no scans
or uploads. **Open contribution issue** opens GitHub; you must explicitly attach
the reviewed file and submit the issue yourself. GitHub issue attachments are
public. Never attach full backups or diagnostic logs to a contribution.
Only maintainer-approved data is published to the repository.

### Addon release checks

In the separate Windows manual package, opening the dashboard can contact
`api.github.com` to check the latest stable release and, for development builds,
compare the installed public commit with that release. Checks are cached locally
for six hours, including failed attempts. The footer's Check for updates button
can request an immediate check, with a 30-second repeat-click cooldown.
No background checks run with the
dashboard closed. These requests contain only public repository references,
omit credentials and referrers, and never include game data. GitHub receives
normal connection information such as your IP address. Store packages do not
make these dashboard update checks. Clicking a release link opens GitHub.
The external Windows updater also downloads public packages from GitHub when
you run it.

---

## 5. Write operations

The extension reads game data and sends state-changing requests only when you use the corresponding feature. Examples include launching fleet missions, collecting debris or salvage, starting research, and sending resources through logistics. It also sends a `POST /api/fleet/fuel-estimate` request to calculate dispatch requirements; this calculation does not launch a fleet. The game API is authoritative for validating and applying these actions.

---

## 6. Data retention and deletion

Data accumulates in local storage as long as the extension is installed. You can:

- **Export** a full JSON backup at any time under Options > Data in the dashboard.
- **Reset** your recorded stats, reports and galaxy cache under Options > Data (a backup is created first; your options are kept).
- **Uninstall** the extension — the browser removes all `storage.local` data on uninstall.

Developer logs are separated by game server and limited to 150 entries per
stream and 10,000,000 UTF-8 bytes of entry JSON per server, excluding container
overhead. Payload and capture-rate limits can discard or truncate entries.
Disable recording to stop new capture; existing logs remain until cleared,
overwritten by newer entries or removed with extension data. Use **Clear logs**
on each stream under **Options > Developer / Debug** without deleting statistics.
Diagnostic logs use a separate local database and are not included in regular
full backups; older storage-based diagnostic logs migrate when recording or
clearing next runs. Optional JSONL exports remain under your
control; review private game data before sharing and delete exported files manually.

Backup files in your Downloads folder are not deleted automatically; you can delete them manually at any time.

---

## 7. Security

All communication with the game API uses HTTPS. Requests are made through the logged-in game tab, and the browser attaches the game's HttpOnly session cookie. The extension does not read, copy, or expose the session cookie to another origin.

---

## 8. Contact

If you have questions about this policy, open an issue in the [DopeEx/NexusOverseer repository](https://github.com/DopeEx/NexusOverseer/issues).
