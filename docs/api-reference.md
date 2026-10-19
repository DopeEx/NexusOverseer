# Nexus Legacy API integration

This page documents the game API routes currently used by Nexus Overseer. It is
a practical integration reference, not a complete or official specification of
the Nexus Legacy API. Routes and response fields can change without notice.

The add-on sends requests to the currently selected game server, for example
`https://s0.nexuslegacy.space`, using paths under `/api`.

## Authentication and request handling

The add-on does not read or extract the session token. It sends requests through
the logged-in game tab, where the browser attaches the game's HttpOnly session
cookie. This keeps requests same-origin with the game. If the bridge content
script is not available, the background service worker attempts to inject it.
Both game-tab bridge listeners abort API requests after 20 seconds, including
response-body reads, and return an explicit network error. This prevents a
stalled fetch from holding the serialized background request queue indefinitely.
Live-search panel errors include the failed message type (such as
`GET_PLANET_SHIPS`) instead of silently treating a failed API response as empty
data. An extension update can still invalidate scripts in already-open game
pages; reload those pages after updating. A closed message channel alone does
not identify whether navigation, an update or a background shutdown caused it.

GET requests are used for loading and refreshing data. POST requests are also
used for actions initiated from the add-on, as well as for the fuel-estimate
calculation. State-changing requests are only sent when the corresponding
feature is used; a periodic report scrape does not launch missions or research.

The background API client observes the server's rate-limit headers, throttles
requests before the remaining budget gets low, and retries transient network,
HTTP 429, and server errors. A 401 means the user needs to log in to the game.
Some API reads are also made directly by the add-on UI in the game tab.

## Data endpoints

| Feature | Method and route | Use |
|---|---|---|
| Player | `GET /api/auth/me` | Current player identity and account details |
| Planets | `GET /api/planets` | Own planets only (no moons) in the in-game order: `planets[]` with `id`, `name`, `planetType`, `isHomeworld`, `colonizedAt`, `sortOrder` (0-based, configurable in the game), `systemId`, `position`, `systemName` |
| Planets | `GET /api/planets/{planetId}` | `planet` (also `sortOrder`, `populationGrowthRate`, `maxPopulation`, `<resource>Storage`, `rareResourceStorage`; stock `ore`, `silicates`, `hydrogen`, `alloys`, `cryoIce`, `quantumDust`, `plasmaCore`, `bioExtract`, `darkMatter`, `antimatter`; hourly rates as `<resource>Rate`; `usedBuildingSlots`/`maxBuildingSlots`, population, storage), `systemInfo.systemName`, `buildings[]` (`isUpgrading`, `upgradeEndsAt`, `definition`, and for queued upgrades `queueId`, `queueStatus` such as `pending`, `queueTargetLevel`; pending entries have no end time), and `buildQueueCount`/`buildQueueMax` (construction queue per planet, max 3 including the running job; moons have none) |
| Fleets | `GET /api/planets/{planetId}/fleet` | Ships stationed at a planet. Top level: `fleet[]`, `cargoBonus`, `shuttleCargoBonus`, `miningCargoBonus` (research bonuses as fractions), `resources` (the planet's stock incl. rare goods as snake_case keys such as `cryo_ice`) and `resourceSnapshot` (`locationType`, `locationId`, `revision`, `serverNow`, `resourcesUpdatedAt`, `resources`, `productionRates`, `storage`, `energy`, `productionRateVersion`, `productionMultiplier`, `starterProductionMultiplier`). Each `fleet[]` entry: `id`, `planetId`, `shipDefId`, `quantity` (all hangar ships), `damagedQuantity` (the damaged part of `quantity`; for mining vessels this is the broken drills; undamaged = `quantity - damagedQuantity`) and `definition` (`key`, `name`, `description`, `shipClass` such as `recon`/`utility`, costs `costOre`/`costSilicates`/`costHydrogen`/`costAlloys`/`rareCosts`, `buildTime`, `hp`, `shieldHp`, `attack`, `speed`, `cargoCapacity`, `miningCargoCapacity`, `hangarCapacity`, `requiredShipyardLevel`, `requirements[]`, `fuelRate`, `shipSize`, `weaponType`, `armorType`, `sortOrder`, `populationCost`, `populationCargoCapacity`, `allowedCargo`, and research-adjusted values `effectiveHp`/`effectiveShieldHp`/`effectiveAttack`/`effectiveDamageReduction`/`effectiveCargoCapacity`/`effectiveMiningCargoCapacity`/`displaySpeed`/`effectiveFuelRate`, plus `baseMiningRates`/`effectiveMiningRates` per resource per cycle, e.g. `{"ore":40,"plasma":15}`). The Dashboard lists `damagedQuantity` > 0 under "Needs attention" |
| Shipyard | `GET /api/planets/{planetId}/shipyard` | Ship definitions and planet availability, plus the build queues (`planetaryQueueAll`, `orbitalQueueAll`: `shipName`, `quantity`, `completed`, `isRepair`, `status`, `endsAt`; waiting jobs have `status: "pending"` and `endsAt: null`). Each yard (planetary, orbital, moon) has its own queue of up to `maxQueueSize` (3) jobs |
| Research | `GET /api/research?planetId={planetId}` | Research catalogue (`research[]` with current `level`) and `activeResearches[]` across all planets (`name`, `planetId`, `planetName`, `endsAt`; no level, the target level is `level + 1`). Each `research[]` entry has `effects[]`; colony and moon limits exist only as effects: `{"type":"colony_slots","value":n}` and `{"type":"moon_slots","slots":n}` (Colonization Technology, Colonial/Advanced Governance, Genetic Adaptation, Terraforming, Megastructure Engineering; Lunar Operations/Expansion/Mastery). The limit is the sum of `value`/`slots` x `level` of researched entries; no base value is returned. Other effect types seen: `fleet_slots`, `storage_bonus`, `rare_storage_bonus`, `production_bonus`, `unlock_ship`, `unlock_building`. Top-level extras: `researchSpeedMult`, `s0RiftClosed`, `precursorFragmentEffectBonus`, `activeResearch` |
| Missions | `GET /api/fleet/missions` | Active and returning fleets |
| Reports | `GET /api/fleet/survey-reports` | Survey results used by accounting and follow-up tools |
| Reports | `GET /api/fleet/survey-cooldowns` | Survey availability |
| Reports | `GET /api/fleet/pirate-reports` | Pirate combat reports |
| Pirates | `GET /api/fleet/pirate-camps` | Visible pirate camps with health, tier, loot tier, and scouting intel |
| Reports | `GET /api/fleet/reports` and `GET /api/fleet/reports/{id}` | Combat report summaries and full details |
| Combat simulator | `GET /api/combat-simulator/bootstrap` | Ship pools, player combat profile, pirate zones, and planetary-defence keys |
| Combat simulator | `POST /api/combat-simulator/simulate` | Runs the game's official combat calculator |
| Reports | `GET /api/fleet/spy-reports`, `GET /api/fleet/camp-scout-reports` | Scouting reports |
| Reports | `GET /api/fleet/mining-reports`, `GET /api/fleet/expedition-reports` | Mining and expedition results |
| Reports | `GET /api/fleet/wormhole-runs`, `GET /api/fleet/wormholes` | Wormhole activity |
| Reports | `GET /api/fleet/system-debris`, `GET /api/messages/system` | Debris and system-message data |
| Galaxy | `GET /api/galaxy/arms` | Galaxy arms |
| Galaxy | `GET /api/galaxy/arms/{armId}/sectors` | Sectors in an arm |
| Galaxy | `GET /api/galaxy/sectors/{sectorId}/systems` | Systems in a sector |
| Galaxy | `GET /api/galaxy/map` | Known systems and coordinates |
| Galaxy | `GET /api/galaxy/systems/{systemId}/planets` | `planets[]` (with `userId`, `ownerName`, `isHomeworld`, `planetType`, `size`, `temperature`; no `sortOrder`), `asteroidFields[]`, and `moons[]` (`planetId`, `moonType`, `size`, `buildingSlots`, `userId`, `ownerName`; a moon with your `userId` is a colonized own moon), plus `visibility` and `included` |
| Trade | `GET /api/market/hubs`, `GET /api/market/orders` | Market hubs and public orders |
| Trade | `GET /api/market/my-trades`, `GET /api/alliance-trade/orders` | Player trades and alliance orders |
| Logistics | `GET /api/outposts`, `GET /api/moons/{moonId}`, `GET /api/moons/{moonId}/shipyard` (`fleet[]` with `quantity` and `definition.shipClass`, build queue in `queueAll[]` like the planet shipyard) and related fleet routes | Logistics destinations and their state. `/api/moons/{id}` returns `moon` (same resource and `<resource>Rate` fields as planets, plus `moonType`, `buildingSlots`, `planetId`), `buildings[]` (flat: `key`, `name`, `level`, `isUpgrading`, `upgradeEndsAt`) and `queue[]`; the Dashboard also reads own moons' resources and fleets |
| Moon colonization | `GET /api/moons/colony-status` | `colonizedMoons`, `maxMoons` (the moon limit, matches the sum of researched `moon_slots`, so the base is 0), `canColonize`, `hasLunarOperations`, `shuttleSources[]` (`planetId`, `planetName`, `planetType`, `systemName`, `quantity` of lunar shuttles). The Dashboard uses `maxMoons`. `GET /api/galaxy/colony-status` is the colony counterpart: `currentColonies`, `maxColonies` (colony limit; with 3 researched `colony_slots` it was 6, so the base is 3), `canColonize`, `hasColonizationTech`, `colonyShipSources[]` (`planetId`, `planetName`, `planetType`, `systemName`, `quantity`, `tankerQuantity`), `colonyShipDefId`, `tankerShipDefId`. The Dashboard uses `maxColonies` |
| Leadership | `GET /api/leadership` | Leadership vessel state (large response, ~440 KB mostly from `definitions`). Top level: `enabled`, `unlocked`, `universeKey`, `creditBalance`, `levelCap`. `vessel` (`callsign`, `level`, `experience`, `unspentTalentPoints`, `hullIntegrity`/`maxHullIntegrity`, `status` such as `ready`, command stats `commandAttack`/`commandDefense`/`commandLogistics`/`commandInsight`, current location ids `currentPlanetId`/`currentMoonId`/`currentStationId`/`currentOutpostId`, `destination*` ids and `travelStartedAt`/`travelEndsAt`/`recoveryEndsAt` while moving, `assignedMissionId`), `combatStats` (`currentHull`, `maxHull`, `shield`, `attack`, `weaponType`, `damageReduction`, `evasion`, `repairPerRound`, `rapidFireByTarget`), `progress` (`xpIntoLevel`, `xpRequiredForNext`, `percent`), `location` (`type`, `id`, `label`), `destinations[]` (`type`, `id`, `label`, `systemId`, `systemName`, `parentPlanetId`, `distance`, `travelTime`), `repair` (`available`, `missingHull`, `durationSeconds`, `cost`, `endsAt`), `modules[]` (owned items: `slot` such as `weapon`, `shield`, `armor`, `engine`, `sensor`, `auxiliary`, `specialization`, `crew_1`..`crew_7` or `crew_pool` when unassigned; `key`, `rarity`, `level`, `equipped`, `vesselId`, crew entries carry `metadata.role`/`grade`/`effects[]`), `effectiveEquippedEffects[]` (`moduleId` plus `effects[]` of the equipped items; each effect has `label`, `value`, `unit` as `percent` or `flat`, `scope` as `self`, `local_fleet`, `local_operation` or `local_planet`, and a `selfStat`, `researchEffect` or `leaderBonus` key), `talents[]` (`key`, `rank`), `xpEvents[]` (`source` such as `research_completed`, `wormhole_complete`, `pirate_base_won`, `amount`, `grantedAt`), `xpDiminishing` (`resetsAt`, `multipliers`, `buckets`), `respec` (`canResetFree`, `canResetPaid`, `priceCredits`, `totalTalentPoints`) and `definitions` (`lanes[]`, `talents[]` with `maxRank`/`effects[]`, `modules[]` catalogue with `swapDurationSeconds`, `crew[]` catalogue, `commanderPerks` by leader type such as `warlord` with `unlockLevel`) |

Paged report and trade feeds may accept `page` and `limit` query parameters.
The exact parameters and response envelope depend on the endpoint.

## Response shapes used by the add-on

These are abbreviated shapes, not exhaustive schemas. Optional properties,
empty collections, and fields available to a player can vary.

### Survey reports

The survey feed is an object with a `reports` array and `unreadCount`. A report
can include its system and event, resource `loot`, ship losses, timestamps,
investigation status, and combat or anomaly details. Treat resource keys and
event-specific details as data-driven rather than assuming every report has the
same fields. Spy-report payloads have also evolved: newer reports can put
tiered scan data in `intel` rather than the legacy `fleetData`, `buildingData`,
`defenseData`, and `resourceData` fields.

Expedition reports are keyed by `sectorId` (not `systemId`) and carry
`missionId`, `sectorDepth`, `explorationDuration` and an event title and
description. Example, an evaded pirate patrol:

```json
{
  "id": 374340,
  "missionId": 16701267,
  "sectorId": 238,
  "eventType": "pirate_patrol_evaded",
  "eventTitle": "Costly Evasion",
  "loot": {},
  "shipsLost": [{ "quantity": 2, "shipDefId": 8 }],
  "explorationDuration": 1000,
  "sectorDepth": 2,
  "combatLog": {
    "outcome": "evaded",
    "lossPercent": 0.0285,
    "evasionChance": 0.25,
    "compositionBand": "dominant"
  },
  "createdAt": "2026-10-15T21:16:53.708Z"
}
```

The report is created at the end of the exploration, the same moment the
mission's `returnDepartsAt` is set, and matches the loss seen in the mission's
`fleetComposition` (30 → 28 Cruisers). `loot` is empty here because the fleet
jettisoned its cargo to escape. `explorationDuration` is 1000 in the sample,
while the observed exploration took about 16 minutes, so its unit is not
confirmed. `combatLog.lossPercent` is a fraction, not a percentage.
Known `eventType` values so far: `pirate_fleet` and `pirate_patrol_evaded`.

### Combat simulator

The addon's simulator uses the game's `/api/combat-simulator/bootstrap` and
`/api/combat-simulator/simulate` endpoints rather than estimating outcomes
locally. The simulation POST must be sent through the logged-in game tab, like
other game POST requests. A successful response wraps a `report`; its losses
and survivors are arrays keyed by `shipDefId`, and losses distinguish destroyed
from damaged ships. The report may include extra negative-id entries for
planetary defenses and the leadership vessel, and debris may contain resource
keys beyond ore, silicates, and alloys.

```json
{
  "reports": [
    {
      "id": 3129005,
      "systemId": 6905,
      "eventType": "pirate_fleet",
      "loot": {
        "ore": 2078,
        "hydrogen": 710,
        "silicates": 1094
      },
      "shipsLost": [],
      "createdAt": "2026-08-26T07:39:20.640Z"
    }
  ],
  "unreadCount": 0
}
```

### Missions and fuel estimates

The missions feed returns `{ "missions": [...], "maxFleetSlots": number }`.
Missions identify their type and status and can include fleet composition,
source and target, travel timing, cargo, and mining-specific fields.

Observed in the 2026-10-19 feed (15 missions, `maxFleetSlots: 18`):

| `missionType` | `status` | Relevant next timestamp |
|---|---|---|
| `attack_pirates`, `relocate_outpost` | `outbound` | `arrivesAt`: arrival |
| `survey` | `surveying` | `returnDepartsAt`: survey ends / return departure; `returnArrivesAt` can still be `null` |
| `mine` | `mining` | `cargo._nextCycleAt`: next mining cycle; both return timestamps can be `null` |
| `patrol` | `patrolling` | `arrivesAt`: patrol ends, not outbound arrival; observed with `patrolMode: "hunt"` |
| `market_pickup`, `expedition` | `returning` | `returnArrivesAt`: home arrival |

A second 2026-10-19 feed (16 missions, `maxFleetSlots: 18`) added no new
status values, but included `missionType: "market_deliver"` with
`status: "outbound"`. Its `arrivesAt` is arrival at the market hub; the observed
flight had `travelTime: 2125` seconds, `cargo: { hydrogen: 500000 }` and
`raidParams: { dockAfterDelivery: true }`, with both return timestamps `null`.
The docking option does not imply that the fleet is already docked, and no
return leg should be invented from the outbound duration. A later payload is
needed to establish the post-delivery state.

The same feed's hunting patrol had `patrolCoverage: "system"` and
`patrolCapacityUsed: 2`. Its `patrolMetrics` included `huntSystemsScanned`,
`huntCampsRevealed`, `huntFurthestDistance`, `huntIntelGained`, `raidsPrevented`,
`minesIntercepted`, `sweepMinesCleared`, `spyDefenseApplications` and
`spyDefensePointsApplied`. These are operation metrics, not additional phases
or countdown timestamps.

All mission displays use the shared `missionProgress()` evaluator in
`nexus-addon/mission-state.js`: the dashboard, Scouting (survey, investigation,
debris and salvage), Expeditions, Pirates, Xeno, asteroid markers and saved
debris runs. The evaluator accepts raw API missions and dashboard summaries
and returns `status`, `label`, `event: { label, at } | null`, `eta` (milliseconds),
`frac` (0..1), `determinate`, colors and `needsRefresh`.

Explicit `status` takes precedence over timestamp-based fallback. Mining,
surveying, exploring and patrolling remain distinct stages. Countdowns are
labeled by event rather than treating every timestamp as an arrival. Mining
progress covers only `_cycleStartedAt` to `_nextCycleAt`, not the whole mining
operation. Missing/invalid timing yields no event or determinate progress;
unknown statuses remain visible without an invented return countdown.

An elapsed deadline requests fresh data instead of changing the reported phase.
Visible transit lists refresh once per elapsed event (at least 5 seconds
between requests, no overlapping refreshes), with periodic 30-second retries.
The dashboard retains its configured refresh interval and refresh-on-expiry.
The Active Missions card highlights **Fleet slots used** (`used / max`) rather
than a combined mission total. Active patrols appear in a separate
**Active patrols (no fleet slot)** row when present.
Its Active Missions summary shows **Next return**: the earliest confirmed
`returning` fleet with a valid `returnArrivesAt`, indicating when a general
fleet slot becomes available. Mining cycles, outbound arrivals and on-site
departures are excluded. Expeditions count toward normal fleet slots and are
included in this summary. Patrols use separate patrol capacity and are excluded
from both normal slot usage and the next-slot-return summary. If no qualifying return is known, it shows
`-` rather than estimating a return. Mission-group rows retain their own
phase-specific countdowns.
The same slot-counting helpers are used by Scouting, Asteroids, Pirates, Xeno
and Expeditions, including launch/automation checks. The Expeditions tab keeps
its existing two-expedition concurrency cap as an additional constraint, not
as an exemption from normal fleet slots.
The [official patrol guide](https://s0.nexuslegacy.space/guide/de/combat.html#patrols)
explicitly separates patrol capacity from normal fleet slots; the
[expedition guide](https://s0.nexuslegacy.space/guide/de/pve.html#expeditions)
does not establish a normal-slot exemption or document the two-expedition cap.
The player confirmed on 2026-10-19 that the cap of two simultaneous expeditions
still applies in addition to normal fleet-slot usage.
Asteroid markers update with their mission fetch; saved debris runs update
when the background processes the missions feed. A collecting fleet's rolling
`returnDepartsAt` is labeled as a collection update, not proof of return.

Additional observed fields: `combinedAssaultId` and `convoyArrivesAt` for a
coordinated pirate attack (its `arrivesAt` matches `convoyArrivesAt`),
`leadershipVessel: { id, callsign, level }` when a command ship accompanies a
fleet, and `fleetComposition[].damagedQuantity` on mining ships. Mining cargo
includes `_cycleStartedAt`, `_cyclesDone`, `_mineUntilFull`,
`_miningCargoCapacity`, `_drillBreakdowns` and other internal metadata; these
underscore-prefixed fields are not resource quantities.

Pirate missions appear with `missionType` `scout_camp` or `attack_pirates`
(status `outbound` while flying) and carry `raidParams.campId`. In this feed the
`fleetComposition` entries are enriched with `shipName` and `shipKey`, and
missions add `sourcePlanetName`, `sourceSystemId`/`sourceSystemName`,
`targetSystemName` and `isProbeFleet` (`true` for spy-probe fleets).

Expedition missions have `missionType: "expedition"` and `status` `outbound`
while flying. They target a sector (`targetSectorId`) rather than a planet or
system, so `targetPlanetName` and `targetSystemName` are `null`. The launch
settings are in `raidParams.expedition` (`{ zone, depth, version }`). Other
useful fields: `fleetComposition` (with `shipName`/`shipKey`), `distance`,
`speed`, `travelTime` (seconds), `departsAt`/`arrivesAt`, `returnDepartsAt`/
`returnArrivesAt` (set once returning), and `cargo` (`_cargoCapacity` plus
`_expeditionCargoBonus` and `_expeditionShuttleBonus`). Many other fields
(`sourceMoonId`, `targetGuildId`, `logisticsRouteId`, `patrolMode`,
`leadershipVessel`, ...) are `null` for expeditions.

Observed expedition statuses: `outbound` (`arrivesAt` = arrival at the target
sector) and `exploring`. Once `exploring`, `arrivesAt` moves to the end of the
exploration, so the real arrival is `departsAt + travelTime` (seconds); in the
sample the exploration lasted about 16 minutes. `returnDepartsAt` and
`returnArrivesAt` were still `null` while exploring. `raidParams` gains
`pirateKingDesertionChecked: 1` at that point.

While `returning`, `returnDepartsAt` equals the end of the exploration
(`arrivesAt`, +25 ms) and `returnArrivesAt` is `returnDepartsAt + travelTime`
(1849 s in the sample, the same as the outbound leg). `fleetComposition` then
reflects losses (30 → 28 Cruisers in the sample) and `cargo` is an empty object
`{}`. The shared evaluator uses `status: "returning"` to select this leg and
the return timestamps to calculate its progress, regardless of `arrivesAt`.

`POST /api/fleet/fuel-estimate` is a calculation endpoint. It accepts a source
planet, target system, and ship quantities; its response includes values such
as `fuelCost`, `distance`, `travelTime`, `sufficient`, and `inRange`.

```json
{
  "sourcePlanetId": 74062,
  "targetSystemId": 5752,
  "ships": [
    {
      "shipDefId": 21,
      "quantity": 1
    }
  ]
}
```

### Pirate camps

`GET /api/fleet/pirate-camps` returns `{ "camps": [...] }`. Each camp carries its
location, tier, health, and scouting state. The `fleetComposition` and
`fleetIntel` arrays stay empty (and `hasFleetIntel` is `false`) until the camp
has been scouted; the `lastScoutedAt`, `scoutHpPercent`, and `scoutTierData`
fields are `null` until then. Destroyed camps set `destroyedAt` and `respawnsAt`.

```json
{
  "camps": [
    {
      "id": 2305,
      "systemId": 10980,
      "systemName": "E32-30",
      "systemX": -277.0858,
      "systemY": 215.12813,
      "securityZone": "open",
      "requiresDeadPlanetOrigin": false,
      "tier": "raider",
      "name": "Red Corsair Haven",
      "currentHpPercent": 100,
      "lootTier": "common",
      "destroyedAt": null,
      "respawnsAt": null,
      "lastSpawnedAt": "2026-10-15T11:35:13.830Z",
      "fleetComposition": [],
      "fleetIntel": [],
      "hasFleetIntel": false,
      "lastScoutedAt": null,
      "scoutHpPercent": null,
      "scoutTierData": null
    }
  ]
}
```

Observed values: `tier` is `scavenger` or `raider` (documentation elsewhere also
lists `corsair`), `lootTier` is `common`, and `securityZone` is `open`.
`requiresDeadPlanetOrigin` indicates whether a fleet must start from a dead
planet to attack the camp.

After a successful scout (see "Scouting a pirate camp") the intel fields are
filled in. `fleetComposition` lists `{ shipDefId, quantity }`, `fleetIntel` adds
`key` and `name` per ship type, `hasFleetIntel` becomes `true`, `lastScoutedAt`
is the arrival time of the scout fleet, `scoutHpPercent` the camp health at that
moment, and `scoutTierData` the tier the intel was taken at:

```json
{
  "fleetComposition": [
    { "shipDefId": 4, "quantity": 7 },
    { "shipDefId": 5, "quantity": 16 },
    { "shipDefId": 6, "quantity": 4 }
  ],
  "fleetIntel": [
    { "key": "scout", "name": "Scout", "quantity": 7, "shipDefId": 4 },
    { "key": "fighter", "name": "Fighter", "quantity": 16, "shipDefId": 5 },
    { "key": "interceptor", "name": "Interceptor", "quantity": 4, "shipDefId": 6 }
  ],
  "hasFleetIntel": true,
  "lastScoutedAt": "2026-10-15T17:40:38.148Z",
  "scoutHpPercent": 100,
  "scoutTierData": "raider"
}
```

The scout intel is stored on the camp itself; the scouted data is a snapshot and
can be outdated once the camp respawns or changes. Scout reports are served by
`GET /api/fleet/camp-scout-reports`; their fields are not yet documented.

### Pirate reports

`GET /api/fleet/pirate-reports` returns `{ "reports": [...], "unreadCount": number }`
(newest first). Each report is one raid on a camp; `campId` maps to
`GET /api/fleet/pirate-camps`, `missionId` to the originating fleet mission.

| Field | Meaning |
|---|---|
| `id`, `missionId`, `userId`, `campId` | Identifiers |
| `attackerFleet[]` | Ships sent: `key`, `name`, `quantity`, `shipDefId` |
| `pirateFleet[]` | Camp fleet faced, same shape as `attackerFleet` |
| `rounds[]` | Per round: `round`, `events[]`, `attackerShieldHp`, `attackerShieldMaxHp`, `defenderShieldHp`, `defenderShieldMaxHp`, `attackerHpPercent`, `defenderHpPercent` |
| `rounds[].events[]` | One entry per `side` (`attacker` / `defender`) with `totalDamage` dealt and `shipsDestroyed[]` (`key`, `name`, `shipDefId`, `lost`) on the opposing side |
| `outcome` | Result: `attacker_won` or `defender_won` |
| `attackerLosses[]` | Own ship losses, same shape as `pirateLosses[]` (empty when nothing was lost) |
| `pirateLosses[]` | Pirate ships: `lost`, `damaged`, `destroyed` per ship type |
| `participantBreakdown[]` | Per-participant breakdown (empty in observed reports) |
| `loot` | Resources taken, e.g. `ore`, `hydrogen`, `silicates` |
| `debris` | Debris field created, e.g. `ore`, `alloys`, `silicates` |
| `isRead`, `isSaved`, `createdAt` | Report state and timestamp |

Observed sample: 10 reports. Nine were `attacker_won` (10 cruisers, 1-5 rounds,
no own losses, loot filled). One was `defender_won`: 2 cruisers against
9 scouts, 13 fighters and 3 interceptors lasted 6 rounds, both cruisers were
lost (`attackerLosses`: `lost: 2, damaged: 0, destroyed: 2`), `loot` was `{}`,
but `debris` was still created and the pirates also took losses. In the last
round `attackerHpPercent` is 0 and `defenderHpPercent` 42.
`lost` is always `damaged + destroyed`. Combat can last several rounds.

```json
{
  "id": 219144,
  "missionId": 16665889,
  "userId": 20747,
  "campId": 2237,
  "attackerFleet": [{ "key": "cruiser", "name": "Cruiser", "quantity": 10, "shipDefId": 8 }],
  "pirateFleet": [
    { "key": "scout", "name": "Scout", "quantity": 9, "shipDefId": 4 },
    { "key": "fighter", "name": "Fighter", "quantity": 5, "shipDefId": 5 }
  ],
  "rounds": [
    {
      "round": 1,
      "events": [
        {
          "side": "attacker",
          "totalDamage": 2150,
          "shipsDestroyed": [
            { "key": "scout", "lost": 9, "name": "Scout", "shipDefId": 4 },
            { "key": "fighter", "lost": 5, "name": "Fighter", "shipDefId": 5 }
          ]
        },
        { "side": "defender", "totalDamage": 248, "shipsDestroyed": [] }
      ],
      "attackerShieldHp": 2330,
      "defenderShieldHp": 0,
      "attackerHpPercent": 100,
      "defenderHpPercent": 0,
      "attackerShieldMaxHp": 2500,
      "defenderShieldMaxHp": 0
    }
  ],
  "outcome": "attacker_won",
  "attackerLosses": [],
  "pirateLosses": [
    { "key": "scout", "lost": 9, "name": "Scout", "damaged": 2, "destroyed": 7, "shipDefId": 4 },
    { "key": "fighter", "lost": 5, "name": "Fighter", "damaged": 1, "destroyed": 4, "shipDefId": 5 }
  ],
  "participantBreakdown": [],
  "loot": { "ore": 320, "hydrogen": 161, "silicates": 219 },
  "debris": { "ore": 578, "alloys": 91, "silicates": 289 },
  "isRead": true,
  "createdAt": "2026-10-15T15:24:39.142Z",
  "isSaved": false
}
```

### Scouting a pirate camp

`POST /api/fleet/scout-camp` sends a fleet to a camp and returns
`{ "mission": {...} }`. The mission appears in `GET /api/fleet/missions` with
`missionType: "scout_camp"` and `status: "outbound"`. Request body:

```json
{
  "sourcePlanetId": 6332,
  "campId": 2305,
  "ships": [{ "shipDefId": 2, "quantity": 1 }]
}
```

Observed response for that request, a single ship (`shipDefId` 2) sent to camp 2305:

- `targetSystemId` is the camp's system; the camp itself is identified by
  `raidParams.campId`. `targetPlanetId`, `targetFieldId` and other targets are `null`.
- `fleetComposition` lists the sent ships as `{ quantity, shipDefId }`.
- `distance`, `speed`, `travelTime` (seconds), `fuelCost`, `departsAt` and
  `arrivesAt` describe the flight; the return fields stay `null` until the
  fleet turns around.
- `raidParams._activityAccounting` carries `activity: "pirates"`, an
  `operation:<uuid>` root, and the `launchFleet`.
- `cargo` is empty; the scouting result is stored on the camp (see "Pirate
  camps": `fleetIntel`, `lastScoutedAt`, `scoutHpPercent`) and may also appear
  in `GET /api/fleet/camp-scout-reports`.

### Attacking a pirate camp

`POST /api/fleet/attack-pirates` sends a combat fleet to a camp. Request body:

```json
{
  "sourcePlanetId": 6332,
  "campId": 2305,
  "ships": [{ "shipDefId": 8, "quantity": 10 }],
  "hangarAssignments": {}
}
```

Unlike `scout-camp`, the response is the mission object itself, not wrapped in
`{ "mission": ... }`. It has the same shape as the scout mission, with
`missionType: "attack_pirates"`, `status: "outbound"`, `raidParams.campId`,
`targetSystemId` and the flight values (`distance`, `speed`, `travelTime`,
`fuelCost`, `departsAt`, `arrivesAt`). Observed for 10 cruisers (`shipDefId` 8)
against camp 2305: `speed` 13, `travelTime` 219 s, `fuelCost` 202, against 1
ship, speed 50, 92 s and 3 fuel for the scout mission to the same camp.
The outcome is delivered later as a pirate report (`GET /api/fleet/pirate-reports`),
whose `missionId` matches the mission `id`.

### Galaxy map and system contents

The map response contains `systems` and may include `userSystemIds`. A system
entry supplies fields such as its ID, coordinates, sector, arm, and security
zone. The system-contents endpoint returns separate `planets`,
`asteroidFields`, and `moons` arrays; `included` indicates which entity groups
were resolved. Any one of these arrays can be empty.

### Research

The research endpoint returns the research catalogue along with player progress
and active research. Entries can include requirements, effects, current level,
status, and server-calculated next-level costs and duration. The UI should use
the returned next-level values rather than treating base costs as current costs.

## Actions initiated by the add-on

The following POST routes are used by interactive features:

| Method and route | Purpose |
|---|---|
| `POST /api/fleet/survey` | Launch a survey |
| `POST /api/fleet/mine` | Launch asteroid mining |
| `POST /api/fleet/investigate` | Investigate a survey result |
| `POST /api/fleet/collect-debris` | Collect system debris |
| `POST /api/fleet/collect-salvage` | Collect report salvage |
| `POST /api/fleet/expedition` | Launch an expedition |
| `POST /api/fleet/scout-camp` | Send a scout fleet to a pirate camp |
| `POST /api/fleet/attack-pirates` | Send an attack fleet to a pirate camp |
| `POST /api/fleet/xeno-survey` | Survey a moon |
| `POST /api/research/{researchId}/start` | Start research on a planet |
| `POST /api/fleet/dispatch` and outpost/moon routes | Send fleets or resources through logistics |
| `POST /api/fleet/fuel-estimate` | Calculate dispatch fuel and travel values; does not itself launch a fleet |

The game validates action requirements and remains authoritative for resulting
state. A successful request should not be treated as proof that every displayed
or cached view has already refreshed.

## Further endpoint notes

The following upstream API notes were reviewed when preparing this page. They
contain additional examples and dated observations; verify details against this
project's current call sites before relying on them:

- [API notes and endpoint index](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/README.md)
- [Survey reports](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/fleet_survey_reports.md)
- [Spy reports](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/fleet_spy_reports.md)
- [Fleet missions](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/fleet_missions.md)
- [Research](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/research.md)
- [Galaxy map](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/galaxy_map.md)
- [System contents](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/galaxy_system_planets.md)
- [Fuel estimate](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/post/fleet_fuel_estimate.md)
- [Planet detail](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/planets_detail.md)
