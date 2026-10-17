# Privacy Policy — Nexus Overseer

**Last updated: 2026-10-11**

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
| Fuel logs | Hydrogen cost per launched mission (type, zone, amount) |
| Player and alliance data | Player identity, alliance details, and ranking data used by the finder |
| Trade and logistics | Market orders and trades, logistics outposts, moons, and related fleet/resource state |
| System activity | System messages and debris data used by exploration and collection features |

The extension does not read or extract the session cookie. It sends API requests through your logged-in game tab, where the browser attaches the game's HttpOnly session cookie. The extension does not write or modify cookies.

---

## 2. How the data is used

All data is used **solely to operate the extension's dashboard** on your own device:

- Build aggregated statistics (resources collected, ships lost, fuel spent, etc.)
- Render charts, history tables, and the tech-tree planner
- Run the offline combat simulator
- Support the planet finder, asteroid scans, fleet logistics, and market views

No data is used for advertising, profiling, or any purpose unrelated to displaying your own game statistics back to you.

---

## 3. Where the data is stored

All data is stored **locally on your device only**, in the browser's `storage.local` area (isolated to this extension). Nothing is uploaded to any server operated by the extension author.

The extension also writes automatic backup files to your `Downloads/NexusOverseer/` folder before destructive operations (reset, import, schema migrations) and as a weekly auto-backup. These files are plain JSON and remain on your device under your control.

---

## 4. Data sharing and third parties

**No data is shared with any third party.** All network communication is exclusively between your browser and `nexuslegacy.space` (the game's own servers). The extension does not contact any analytics service, telemetry endpoint, or server operated by the extension author.

---

## 5. Write operations

The extension reads game data and sends state-changing requests only when you use the corresponding feature. Examples include launching fleet missions, collecting debris or salvage, starting research, and sending resources through logistics. It also sends a `POST /api/fleet/fuel-estimate` request to calculate dispatch requirements; this calculation does not launch a fleet. The game API is authoritative for validating and applying these actions.

---

## 6. Data retention and deletion

Data accumulates in local storage as long as the extension is installed. You can:

- **Export** a full JSON backup at any time under Options > Data in the dashboard.
- **Reset** your recorded stats and reports under Options > Data (a backup is created first; your options are kept).
- **Uninstall** the extension — the browser removes all `storage.local` data on uninstall.

Backup files in your Downloads folder are not deleted automatically; you can delete them manually at any time.

---

## 7. Security

All communication with the game API uses HTTPS. Requests are made through the logged-in game tab, and the browser attaches the game's HttpOnly session cookie. The extension does not read, copy, or expose the session cookie to another origin.

---

## 8. Contact

If you have questions about this policy, open an issue in the [DopeEx/NexusOverseer repository](https://github.com/DopeEx/NexusOverseer/issues).
