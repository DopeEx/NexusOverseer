# Public galaxy datasets

This directory holds maintainer-approved, non-personal galaxy structure for
Nexus Overseer. Dataset files are offered under the repository's
[MPL-2.0 license](../../LICENSE), to the extent applicable rights are held.
This does not grant rights in third-party game artwork or other protected
content. No artwork, credentials, player identities or ownership data belongs
here.

## Contributing

1. In the addon, select the correct universe.
2. Open **Options > Data > Public galaxy data > Export public data**.
3. Review the counts and confirm the local download. The export uses only
   already saved knowledge and does not scan or upload anything.
4. Review the JSON. Use **Open contribution issue**, attach the file manually
   and submit the issue. Never attach a regular backup or diagnostic log.
5. The maintainer reviews the contribution. Issue attachments are not consumed
   by the addon or automatically published.

GitHub supports JSON and ZIP issue attachments up to 25 MB. Attachments in this
public repository are publicly accessible. Only the specially whitelisted
public export is suitable.

## Maintainer workflow

First export a file through **Options > Data > Public galaxy data > Export
public data**, or download an attached contribution from an issue. The tool
does not create the input file or download it for you. Extract ZIP attachments
before using the tool.

### Windows: double-click starter (recommended)

Double-click [Import-Galaxy-Data.bat](../../tools/Import-Galaxy-Data.bat) in the
repository's `tools` folder. Requires Node.js 22 or newer, but no npm install.

1. Pick the downloaded public JSON file in the Windows file dialog. Paths with
   spaces and redirected Downloads folders do not require manual quoting.
2. Read the universe, counts, destination and preview in the console.
3. If conflicts exist, the import stops without writing anything and lists
   them for review.
4. Type **MERGE** to apply the additions. Enter or any other answer cancels.
5. The tool validates the updated dataset and checksums, then leaves the window
   open so you can read the result.
6. Review the changes in VS Code Source Control and commit/push manually.

Cancelling the file dialog or confirmation changes nothing. Invalid files and
missing Node.js produce an explicit error, and the window remains open.
The starter never downloads, uploads, commits or pushes. It works independently
of the shell's current working directory and is a repository maintainer tool,
not part of the installed addon/updater package.

### Command line (alternative)

Run these commands in **PowerShell**, from the repository root. The example
uses your Windows profile's Downloads folder, not `C:\Downloads`.
Set `$export` to the file's **actual full path** if your browser saves elsewhere,
Downloads is redirected, or the filename has a suffix such as `(1)`:

```powershell
$export = Join-Path $env:USERPROFILE 'Downloads\nexus-galaxy-public-s0.json'
Test-Path -LiteralPath $export
node tools\galaxy-data.js preview "$export"
```

`Test-Path` must return `True`. If it returns `False`, locate the downloaded
file and correct `$export` before continuing. Review the preview; only then run:

```powershell
node tools\galaxy-data.js merge "$export"
node tools\galaxy-data.js check
git --no-pager diff -- data\galaxy
git --no-pager status --short -- data\galaxy
```

`check` only validates published repository files, not your downloaded input.
It succeeds for an empty manifest too. New dataset files do not appear in
`git diff` until tracked; `git status` also shows newly created files.

`preview` validates and reports added records, filled fields and exact conflicts
without writing anything. `merge` only writes when there are no conflicts;
existing conflicting values are never silently replaced, and omissions do not
delete known entries. Review conflicting fields against reliable game evidence.
Correct the submitted copy (or deliberately correct the established dataset)
before merging again. Do not choose values solely by export date.

Inspect the diff, then commit the affected server file and manifest together
through the normal review process. The tool does not upload, commit or push.
Contributions for other universes cannot merge into an existing server file.
Repeated identical submissions produce no content changes.

CI runs the same `check` command on Linux and Windows to verify schemas and file
checksums. Git attributes preserve LF line endings for JSON files so Windows
checkouts do not change their checksums. Adding
or changing a dataset without updating its manifest checksum fails validation.

## Format (schema version 1)

Root fields are exactly `schemaVersion: 1`, `serverKey`, `systems`, `stations`,
`hubs`, and `arms`. The four collections are arrays with unique positive IDs.
Systems can contain `planets` and `moons`; an omitted group is unknown, whereas
an array comes from a resolved contents group. Body IDs cannot occur under
multiple systems. No per-player visibility is encoded.

Allowed fields:

| Record | Fields |
|---|---|
| System | `id`, `name`, `x`, `y`, `armId`, `sectorId`, `starType`, `securityZone`, optional `planets`/`moons` |
| Planet | `id`, `planetType`, `size`, `temperature`, `position` |
| Moon | `id`, `planetId`, `moonType`, `size`, `position` |
| Station | `stationId`, `stationName`, `systemId`, `systemName`, `systemX`, `systemY` |
| Hub | `id`, optional `systemId`, `name`, `systemX`, `systemY` |
| Arm | `id`, `name`, `sectorCount` |

All other fields are rejected on input, including ownership, colony names,
visibility, colony flags, resources, buildings and building-slot values.
Images are derived from type by the addon. Physical values are included only
when present and valid; unknown fields are not invented. Exported building-slot
values are deliberately excluded because they may reflect development.
For planets the addon already derives base capacity from size when no observed
capacity exists: `floor(size / 10)`, or `floor(floor(size / 10) * 0.3)` for gas
giants. These are base capacities, not free slots or upgrade/bonus-adjusted
capacities. There is no verified size-based formula for moon slots, which
therefore remain unknown when only public data is available.

The manifest maps each published server key to `{ "file": "s0.json",
"sha256": "<64 lowercase hex digits>" }` under `servers`, with
`schemaVersion: 1`. The SHA-256 is over the exact UTF-8 file bytes and also serves
as the dataset version. Server entries are published only after maintainer
review; demo fixtures are never included.

## Download and local merge

The addon makes credential-free GET requests to the fixed
`raw.githubusercontent.com/DopeEx/NexusOverseer/master/data/galaxy/` source.
The manifest selects only the exact `<serverKey>.json` filename; arbitrary
URLs or paths are not followed. Redirects, invalid schemas, wrong universes,
files over 25 MB and checksum mismatches fail explicitly and retain existing
installed data. Files are data only, never executed.

Automatic checks default on and happen when the dashboard opens, then hourly
while it stays open, subject to a persisted 24-hour limit per universe.
Failures are rate-limited too. Manual checks have a 30-second limit.
No checks run with all dashboards closed. Turning automatic downloads off
does not disable the manual button. GitHub receives normal connection metadata,
but no game observations, account information, tokens or referrers.

Installed public data stays separate from direct observations. It fills missing
base properties without replacing observed values, synthesizing ownership or
renewing observation timestamps. A public body list does not make its system
explored. Public-only systems are excluded from ownership discovery unless the
game map already marks them fully visible. Missing slot values remain unknown;
moon-slot searches can fetch details only where game visibility already allows.
Source information is shown in system overview.

Deleting a server's local galaxy knowledge also deletes its installed public
dataset. Disable automatic updates if that shared portion should remain empty.
For a full game-server reset, deliberately remove/replace the published server
dataset and clear local galaxy knowledge. Automatic generation/reset detection
is intentionally not implemented.
