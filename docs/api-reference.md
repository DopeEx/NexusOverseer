# Nexus Legacy API integration

This page documents game API routes, observed payloads and Nexus Overseer's
integration behavior. It is a practical technical reference, not a complete or
official specification of the Nexus Legacy API. Routes and response fields can
change without notice. Gameplay rules, reference values and calculations belong
in the [game reference](./game-reference.md).

The add-on sends requests to the currently selected game server, for example
`https://s0.nexuslegacy.space`, using paths under `/api`.

## Contents

- [Authentication and request handling](#authentication-and-request-handling)
- [Observed WebSocket events](#observed-websocket-events)
- [Data endpoints](#data-endpoints)
- [Response shapes used by the add-on](#response-shapes-used-by-the-add-on)
- [Actions initiated by the add-on](#actions-initiated-by-the-add-on)
- [Further endpoint notes](#further-endpoint-notes)

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

## Observed WebSocket events

These observations come from captured traffic, not an official protocol
specification. HTTP responses and WebSocket events are separate data sources.

### Galaxy delta: `galaxy:delta`

Observed Socket.IO text frame:

```text
42["galaxy:delta",{"type":"colonized","systemId":5047,"hasColonies":true}]
```

The decoded event is an array containing the event name and its payload:

| Field | Observed meaning |
|---|---|
| `type` | `"colonized"` in the available samples; other types are not yet verified |
| `systemId` | ID of the affected galaxy system |
| `hasColonies` | `true` in the available samples; reports that the system contains colonies |

An inspected reference-addon export contains nine delta entries for six systems
between 3 and 20 October 2026. Four identical payloads for one system occurred
within about 41 seconds. These are repeated state notifications, not sufficient
evidence of four separate colonizations. The payload does not identify a planet,
owner or colony count, and contains no action timestamp or unique event ID.
Export wrapper IDs and timestamps are added by the recording addon; they are not
fields supplied in this game payload. Capture time must not be treated as the
verified time of colonization.

Live capture in Nexus Overseer also confirmed this payload shape. When recording
is enabled, the same incoming message is stored in the general WebSocket stream
and as a separate galaxy diagnostic entry. This is not a second network receipt.
Capture is passive; no dedicated subscription is sent, and opening the map or
selecting a system does not guarantee an event. The exact server-side trigger
and delivery scope remain unverified. No connection to the reference addon's
separate community-sharing HTTP flow was found.

These diagnostics do not currently modify Galaxy Scout data. A future consumer
could apply the system-level flag idempotently or mark the system for a targeted
refresh through `GET /api/galaxy/systems/{systemId}/planets`, rather than infer
planet ownership or increment a colony counter.

## Data endpoints

This index includes observed endpoints not yet requested by the addon.

| Feature | Method and route | Use |
|---|---|---|
| Universe configuration | `GET /api/game-config` | Universe/ruleset identity, typed rule rows, feature capabilities and speed multipliers; see [game configuration](#game-configuration). Currently documented from a supplied capture, not fetched by Nexus Overseer |
| Player | `GET /api/auth/me` | Current player identity and account details |
| Planets | `GET /api/planets` | Own planets only (no moons) in the in-game order: `planets[]` with `id`, `name`, `planetType`, `isHomeworld`, `colonizedAt`, `sortOrder` (0-based, configurable in the game), `systemId`, `position`, `systemName` |
| Planets | `GET /api/planets/{planetId}` | `planet` (also `sortOrder`, `populationGrowthRate`, `maxPopulation`, resource stock, rates and storage; see [planet detail](#planet-detail)), `systemInfo.systemName`, `buildings[]` (`isUpgrading`, `upgradeEndsAt`, `definition`, and for queued upgrades `queueId`, `queueStatus` such as `pending`, `queueTargetLevel`; pending entries have no end time), and `buildQueueCount`/`buildQueueMax` |
| Fleets | `GET /api/planets/{planetId}/fleet` | Ships stationed at a planet. Top level: `fleet[]`, `cargoBonus`, `shuttleCargoBonus`, `miningCargoBonus` (research bonuses as fractions), `resources` (the planet's stock incl. rare goods as snake_case keys such as `cryo_ice`) and `resourceSnapshot` (`locationType`, `locationId`, `revision`, `serverNow`, `resourcesUpdatedAt`, `resources`, `productionRates`, `storage`, `energy`, `productionRateVersion`, `productionMultiplier`, `starterProductionMultiplier`). Each `fleet[]` entry: `id`, `planetId`, `shipDefId`, `quantity` (all hangar ships), `damagedQuantity` (the damaged part of `quantity`; for mining vessels this is the broken drills; undamaged = `quantity - damagedQuantity`) and `definition` (`key`, `name`, `description`, `shipClass` such as `recon`/`utility`, costs `costOre`/`costSilicates`/`costHydrogen`/`costAlloys`/`rareCosts`, `buildTime`, `hp`, `shieldHp`, `attack`, `speed`, `cargoCapacity`, `miningCargoCapacity`, `hangarCapacity`, `requiredShipyardLevel`, `requirements[]`, `fuelRate`, `shipSize`, `weaponType`, `armorType`, `sortOrder`, `populationCost`, `populationCargoCapacity`, `allowedCargo`, and research-adjusted values `effectiveHp`/`effectiveShieldHp`/`effectiveAttack`/`effectiveDamageReduction`/`effectiveCargoCapacity`/`effectiveMiningCargoCapacity`/`displaySpeed`/`effectiveFuelRate`, plus `baseMiningRates`/`effectiveMiningRates` per resource per cycle, e.g. `{"ore":40,"plasma":15}`). The Dashboard lists `damagedQuantity` > 0 under "Needs attention" |
| Shipyard | `GET /api/planets/{planetId}/shipyard` | Ship definitions and planet availability, plus the build queues (`planetaryQueueAll`, `orbitalQueueAll`: `shipName`, `quantity`, `completed`, `isRepair`, `status`, `endsAt`; waiting jobs have `status: "pending"` and `endsAt: null`). Queue capacity is returned as `maxQueueSize`; see [construction rules](./game-reference.md#construction-and-research) |
| Research | `GET /api/research?planetId={planetId}` | Research catalogue (`research[]` with current `level`) and `activeResearches[]` across all planets (`name`, `planetId`, `planetName`, `endsAt`; no level, the target level is `level + 1`). Each `research[]` entry has `effects[]`, including `{"type":"colony_slots","value":n}` and `{"type":"moon_slots","slots":n}`; the catalogue returns no base colony/moon limit. Other effect types seen: `fleet_slots`, `storage_bonus`, `rare_storage_bonus`, `production_bonus`, `unlock_ship`, `unlock_building`. Top-level extras: `researchSpeedMult`, `s0RiftClosed`, `precursorFragmentEffectBonus`, `activeResearch`. See [colony and moon rules](./game-reference.md#colony-and-moon-limits) |
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
| Moon colonization | `GET /api/moons/colony-status` | `colonizedMoons`, `maxMoons`, `canColonize`, `hasLunarOperations`, `shuttleSources[]` (`planetId`, `planetName`, `planetType`, `systemName`, `quantity` of lunar shuttles). The Dashboard uses `maxMoons`. `GET /api/galaxy/colony-status` is the colony counterpart: `currentColonies`, `maxColonies`, `canColonize`, `hasColonizationTech`, `colonyShipSources[]` (`planetId`, `planetName`, `planetType`, `systemName`, `quantity`, `tankerQuantity`), `colonyShipDefId`, `tankerShipDefId`. The Dashboard uses `maxColonies`; see [observed limit rules](./game-reference.md#colony-and-moon-limits) |
| Leadership | `GET /api/leadership` | Leadership vessel state (large response, ~440 KB mostly from `definitions`). Top level: `enabled`, `unlocked`, `universeKey`, `creditBalance`, `levelCap`. `vessel` (`callsign`, `level`, `experience`, `unspentTalentPoints`, `hullIntegrity`/`maxHullIntegrity`, `status` such as `ready`, command stats `commandAttack`/`commandDefense`/`commandLogistics`/`commandInsight`, current location ids `currentPlanetId`/`currentMoonId`/`currentStationId`/`currentOutpostId`, `destination*` ids and `travelStartedAt`/`travelEndsAt`/`recoveryEndsAt` while moving, `assignedMissionId`), `combatStats` (`currentHull`, `maxHull`, `shield`, `attack`, `weaponType`, `damageReduction`, `evasion`, `repairPerRound`, `rapidFireByTarget`), `progress` (`xpIntoLevel`, `xpRequiredForNext`, `percent`), `location` (`type`, `id`, `label`), `destinations[]` (`type`, `id`, `label`, `systemId`, `systemName`, `parentPlanetId`, `distance`, `travelTime`), `repair` (`available`, `missingHull`, `durationSeconds`, `cost`, `endsAt`), `modules[]` (owned items: `slot` such as `weapon`, `shield`, `armor`, `engine`, `sensor`, `auxiliary`, `specialization`, `crew_1`..`crew_7` or `crew_pool` when unassigned; `key`, `rarity`, `level`, `equipped`, `vesselId`, crew entries carry `metadata.role`/`grade`/`effects[]`), `effectiveEquippedEffects[]` (`moduleId` plus `effects[]` of the equipped items; each effect has `label`, `value`, `unit` as `percent` or `flat`, `scope` as `self`, `local_fleet`, `local_operation` or `local_planet`, and a `selfStat`, `researchEffect` or `leaderBonus` key), `talents[]` (`key`, `rank`), `xpEvents[]` (`source` such as `research_completed`, `wormhole_complete`, `pirate_base_won`, `amount`, `grantedAt`), `xpDiminishing` (`resetsAt`, `multipliers`, `buckets`), `respec` (`canResetFree`, `canResetPaid`, `priceCredits`, `totalTalentPoints`) and `definitions` (`lanes[]`, `talents[]` with `maxRank`/`effects[]`, `modules[]` catalogue with `swapDurationSeconds`, `crew[]` catalogue, `commanderPerks` by leader type such as `warlord` with `unlockLevel`) |

Paged report and trade feeds may accept `page` and `limit` query parameters.
The exact parameters and response envelope depend on the endpoint.

## Response shapes used by the add-on

These are abbreviated shapes, not exhaustive schemas. Optional properties,
empty collections, and fields available to a player can vary.

### Game configuration

`GET /api/game-config` was captured on `s0` on 20 October 2026 with
`rulesetId: "s0-2026-10-station-operations-v1"`. This is a per-universe,
versioned configuration snapshot, not a universal set of constants.

| Field | Observed shape / meaning |
|---|---|
| `universeKey`, `rulesetId` | Universe and ruleset identifiers, also repeated inside `rules` |
| `rules.schemaVersion` | `1` in this capture |
| `rules.sections[]` | Sections identified by `id`: `speeds`, `galaxy`, `economy`, `deadSpace`, `combat`, `council`, `fleet`, `stations` |
| `rules.sections[].rows[]` | Rows with `id`, `kind`, `value` and optional `unit`; observed kinds: `number`, `flag`, `choice`, `limit` |
| `capabilities` | Structured feature flags, limits and nested configuration objects |
| `gameSpeed`, `fleetSpeed`, `miningSpeed` | Top-level multipliers, all `1`; the economy speed row is named `economySpeed` |
| `dynamicApiEnabled` | `false`; the exact behavior controlled by this flag is not established |

Selected capability structures and exact field names:

| Capability | Captured values |
|---|---|
| `resourceTrader` | `enabled: true`, `rates: { ore: 1, silicates: 2, hydrogen: 2, alloys: 7 }`, `feePercent: 5` |
| `combatResolution`, `stationCapture` | `"instant"`, `"operation"` |
| `allianceCouncil` | `false` |
| `deadSpacePlanetShield`, `deadSpacePlanetCombat` | `true`, `false` respectively; do not conflate shield presence and combat availability |
| `fleetSupply` | `enabled: false`, `bioExtractPerCrewPerDay: 0.02`, `mothballAfterUnpaidHours: 24`, `desertAfterUnpaidHours: 48`, `vacationRecoveryHours: 0` |
| `pvpProtection` | `enabled: true`, `maxAttackerOverallScoreRatio: 5`, `retaliationHours: 24`, `allianceWarPreparationHours: 24`, `allianceWarDurationHours: 168`, `allianceWarPeaceHours: 336`, `asteroidWarCombatEnabled: false`, `maxOutgoingAllianceWars: 5` |
| `stationOperations`, `stationCaptureCommandLimit`, `stationCaptureMinimum` | `true`, `8000`, `500` |
| `stationTerritory` | `enabled: false`; see dormant parameters below |
| `planetCombatByZone` | Objects keyed by `sentinel`, `open`, `dead`, `rift`, each containing `planetaryShieldEnabled`, `shieldReinforcementEnabled`, `defenderRetreatThresholdPercents`, `economicBuildingDamageEnabled`, `defenseBuildingDamageEnabled` |

Dormant `stationTerritory` parameters are `activityWindowDays: 7`,
`recalculationHours: 24`, `membersPerSupportedSector: 5`,
`minimumActiveMembers: 5`, `capitalDeploymentHours: 72`,
`priorityChangeDelayHours: 72`, `capitalDeploymentStationCount: 5`,
`capitalRetentionStationCount: 3`, `capitalCommandLimit: 8000`,
`supportedCommandLimit: 7000`, `unsupportedCommandLimit: 5000`.
Their presence does not enable territory mechanics.

Additional rule rows supply values not repeated in these capability objects:
`galaxy.area: 100` (`percent`); `economy.deadOrdinaryProduction: 1.3` and
`deadRareProduction: 1.5` (`multiplier`), `specializedRareBonus: false`;
`deadSpace.deadMiningOrigin`, `deadAnomalyOrigin`, `deadWormholeOrigin`,
`deadPirateOrigin` all `false`, with `outpostMining: true`;
`combat.sleepShield: true`, `sleepHours: 8`, `sleepActivation: 24`
(both in hours), `sleepChange: 7` (days), `leadership: true`;
`stations.stationDockBase: 500`, `stationDockPerLevel: 500`,
`stationDockMaxLevel: 3` (all `count`), with `stationMinimum: 500` (`cp`).

Do not activate a feature just because its numeric parameters exist: inspect
its enable flag first. Empty retreat-threshold arrays do not establish the
reason thresholds are unavailable. Names such as `sleepActivation` and
`stationDockBase` supply values and units, but not a complete scheduling or
capacity formula. Likewise, trader weights alone do not establish fee rounding
or conversion order. Where rules and capabilities overlap, this capture does
not define precedence for a future disagreement.

For the captured gameplay rules, including the per-zone combat matrix, see
[universe rules](./game-reference.md#universe-rules-s0).
Nexus Overseer does not currently fetch or apply this configuration automatically.

### Survey reports

The survey feed is an object with a `reports` array and `unreadCount`. A report
can include its system and event, resource `loot`, ship losses, timestamps,
investigation status, and combat or anomaly details. Treat resource keys and
event-specific details as data-driven rather than assuming every report has the
same fields. Spy-report payloads have also evolved: newer reports can put
tiered scan data in `intel` rather than the legacy `fleetData`, `buildingData`,
`defenseData`, and `resourceData` fields.

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

### Expedition reports

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

### Missions and fuel estimates

The missions feed returns `{ "missions": [...], "maxFleetSlots": number }`.
Missions identify their type and status and can include fleet composition,
source and target, travel timing, cargo, and mining-specific fields.

#### Mission field reference

| Field | Technical meaning |
|---|---|
| `missionType` | Operation identifier, e.g. `survey`, `mine`, `raid`, `patrol`, `expedition`, `attack_pirates`, `market_pickup`, `market_deliver`, `relocate_outpost` |
| `status` | Explicit phase; takes precedence over timestamp-based inference |
| `fleetComposition[]` | Ship quantities and properties |
| `distance`, `speed`, `travelTime` | Galaxy distance, effective fleet speed and travel time in seconds |
| `arrivesAt` | Outbound arrival, or end of exploration/patrol in those on-site phases |
| `returnDepartsAt`, `returnArrivesAt` | Return departure and home arrival; either can be `null` while on site |
| `cargo` | Resource quantities plus operation metadata; underscore-prefixed keys are not resources |
| `cargo._nextCycleAt` | Next mining cycle, not a return ETA |
| `targetFieldType` | Mining field type, e.g. `ore`, `hydrogen`, `plasma`, `cryo_ice`; `null` for non-mining missions |
| `miningEfficiencyPercent` | Mining efficiency at dispatch; can exceed 100 |
| `mineUntilFull` | Optional dispatch flag; echoed as `cargo._mineUntilFull` in observed missions |
| `escortRetreatThreshold` | Dispatch fraction (`0.3`, `0.5`, `0.7`); echoed as `cargo._escortRetreatThreshold` |
| `patrolCoverage`, `patrolMode`, `patrolCapacityUsed`, `patrolMetrics` | Patrol scope (observed `"system"`), mode, used patrol capacity and operation counters |
| `raidParams.dockAfterDelivery` | Delivery docking option, not a phase indicator |
| `isProbeFleet` | Boolean probe-fleet flag |
| `maxFleetSlots` | Feed-level normal fleet-slot limit |

For the gameplay rules behind phases, slot usage and mining options, see
[fleet operations](./game-reference.md#fleet-operations).

#### Observed phase payloads

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

#### Addon mission display integration

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
departures are excluded. Expedition returns are included; patrols are excluded
from normal slot usage and the next-slot-return summary according to the
[fleet capacity rules](./game-reference.md#fleet-slots-and-patrol-capacity).
If no qualifying return is known, it shows
`-` rather than estimating a return. Mission-group rows retain their own
phase-specific countdowns.
The same slot-counting helpers are used by Scouting, Asteroids, Pirates, Xeno
and Expeditions, including launch/automation checks and the additional
two-expedition concurrency check.
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

#### Fuel estimate response fields

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

| Response field | Meaning |
|---|---|
| `fuelCost`, `baseFuelCost` | Estimated hydrogen cost after modifiers and base cost before modifiers |
| `fuelBonus`, `tankerBonus` | Fuel-efficiency and tanker modifiers |
| `distance`, `travelTime` | Calculated distance and flight time in seconds |
| `hydrogenAvailable`, `sufficient` | Current source supply and whether it covers the estimate |
| `totalCargoCapacity` | Combined cargo capacity |
| `antimatterCost` | Antimatter required for applicable missions |
| `maxRange`, `inRange` | Fleet range and target reachability |
| `hasDamagedShips` | Damaged-ship indicator relevant to the calculation |

The legacy field notes describe `fuelBonus` as a fractional modifier. Prefer the
server-calculated result over reconstructing it from historical formulas.

### Planet detail

`GET /api/planets/{planetId}` returns planet stock, production, storage,
population, energy, shields and buildings. See the endpoint index above for the
`planet`, `buildings`, `systemInfo` and construction-queue envelope.

| Planet field(s) | Meaning |
|---|---|
| `ore`, `silicates`, `hydrogen`, `alloys` | Basic resource stock |
| `cryoIce`, `quantumDust`, `plasmaCore`, `bioExtract`, `darkMatter`, `antimatter` | Rare resource stock; note camelCase naming |
| `<resource>Rate` | Resource production per hour, passed directly to the Dashboard without a minute/hour conversion |
| `<resource>Storage`, `rareResourceStorage` | Returned storage limits; do not hardcode the historical reference capacities |
| `energyProduced`, `energyConsumed` | Energy supply and demand relevant to production |
| `population`, `maxPopulation`, `populationGrowthRate` | Population, limit and population growth per hour |
| `shieldHp`, `shieldMaxHp`, `shieldRegenRate` | Shield state and regeneration |
| `usedBuildingSlots`, `maxBuildingSlots` | Occupied and available building slots |
| `resourceRevision` | Resource-state revision counter |

The official resource guide describes level- and research-dependent storage,
not universal fixed capacities. Its building-production "per tick" descriptions
must not be used to reinterpret these API rate units.

Resource-rate units were confirmed on 20 October 2026: the background copies
planet and moon resource-rate fields unchanged, and the Dashboard formats them
as `/h` (or sums them for totals), without multiplying or dividing by 60.
The player confirmed that these displayed hourly resource rates are correct.
The older per-minute description for these resource fields is superseded.

`populationGrowthRate` is also hourly: on 20 October 2026 the player confirmed
that the game displays population growth as `/h`. The Dashboard uses the API
value unchanged for its `/h` display and population-full estimate. The legacy
per-minute population note is superseded.
Historical capacities and resource sources remain in the
[game resource reference](./game-reference.md#resources).

### Building definitions and upgrade previews

A supplied `GET /api/planets/{planetId}` capture on 20 October 2026 includes
`buildings[].definition`, `previewUpgradeCost`, `previewBuildTimeSeconds` and
`demolishPreview` (`oneLevel` and `allLevels`, each with `targetLevel`,
`timeSeconds` and resource `refund`). This provides inputs for a level table
without establishing that the game has a separate table endpoint.

For an Ore Mine at level 26, the definition contains:

| Parameter | Value |
|---|---|
| `maxLevel` | 30 |
| `baseCostOre`, `baseCostSilicates`, `baseCostHydrogen`, `baseCostAlloys` | 60, 15, 0, 5 |
| `costFactor`, `highLevelFactor`, `costDoubleAfter` | 1.4, 1.5, 0 |
| `alloysFromLevel` | 16 |
| `baseBuildTime`, `buildTimeFactor` | 107 seconds, 1.4 |
| `productionPerLevel`, `productionResource`, `energyPerLevel` | 30, `"ore"`, -8 |

For target level N, the screenshot costs match flooring
`baseCost * costFactor^min(N-1,9) * highLevelFactor^max(0,N-10)`;
alloys are omitted below `alloysFromLevel`. The level-27 server preview is
`{ ore: 1221391, silicates: 305347, hydrogen: 0, alloys: 101782 }`.
The existing addon planners use rounding rather than flooring, so their
extrapolated costs can differ by one unit. This capture does not validate
rounding or extra modifiers for every building.

Screenshot production and energy rows match truncation toward zero of
`productionPerLevel * N * 1.07^N` and `energyPerLevel * N * 1.07^N`:
level 26 gives 4529 ore/hour and -1207 energy, level 27 gives 5033 and -1342.
The 1.07 factor is inferred from these observations, not explicitly supplied
in the definition; do not generalize it to all building types.

The table's level-27 duration (187h 14m 41s) matches the unmodified
`baseBuildTime * buildTimeFactor^(N-1)` to displayed-second precision.
The response instead returns `previewBuildTimeSeconds: 65454` for the next
upgrade (18h 10m 54s), consistent to approximately one second with multiplying
that base duration by top-level `buildSpeedMult: 0.09709970523726377`.
Dividing by that field would not reproduce this preview. Existing research-lab
planner code divides by its build-speed argument; its handling of this API
field needs separate verification before relying on extrapolated durations.

Top-level `productionBreakdown.breakdown` supplies per-resource `base`,
`workers`, `consumption`, `research`, `race`, `planetType`, `temperature`,
`zone`, `station`, `artifact`, `energy`, `final`, `gross` and
`effectiveConsumption` in this capture. Ore has `base: 4529`,
`gross: 10043.510400000001`, `effectiveConsumption: 1160`, `final: 8883`,
while `planet.oreRate` is 8883.511. Thus the table base, truncated breakdown
final and precise net planet rate are not interchangeable.
Top-level `productionMultiplier` is 1 and `starterProductionMultiplier` is
1.5034587499842322; their presence alone does not establish the full stacking
formula.

#### Storage Complex observations

The same 20 October 2026 planet response contains a level-15 `storage_complex`.
Its definition supplies `storagePerLevel: 10000`, `storageResource: "all"`,
`maxLevel: 20`, `energyPerLevel: -5`, base costs of 150 ore, 100 silicates,
0 hydrogen and 50 alloys, `costFactor: 1.8`, `highLevelFactor: 1.5`,
`costDoubleAfter: 0`, `alloysFromLevel: 1`, `baseBuildTime: 428` seconds and
`buildTimeFactor: 1.8`.

The supplied screenshot's basic storage column matches
`floor(storagePerLevel * 1.5^N)` for target level N, not a linear
`storagePerLevel * N`. The displayed level-15 capacity is 4,378,938.
Energy rows match truncation toward zero of `-5 * N * 1.07^N`, giving -206
at level 15 and -386 at level 20.

The next-upgrade preview (15 to 16) is
`{ ore: 338915, silicates: 225943, hydrogen: 0, alloys: 112971 }`.
This matches the screenshot and the piecewise cost formula with the
building-specific factors. The screenshot's level-16 base time is 802h 6m 2s;
the API preview is `280383` seconds (77h 53m 3s), within about two seconds of
multiplying base time by the planet's
`buildSpeedMult`, rather than dividing.

Final `planet` capacity fields are 8,777,876 for `oreStorage`,
`silicatesStorage`, `hydrogenStorage`, 8,767,876 for `alloysStorage`, and
160,000 for `rareResourceStorage`. These differ from the building-table value;
the full storage bonus/base-capacity calculation is not supplied.
The current definition description explicitly states +5,000 capacity per rare
resource per level and a maximum of 200,000 after bonuses. The final 160,000
value does not independently establish how research, base capacity and other
bonuses combine.

### Shipyard definitions

`GET /api/planets/{planetId}/shipyard` returns ship definitions, availability and
the build queues listed in the endpoint index. The July 2026 reference described
31 ship types; this is not a fixed schema limit.

| Ship field(s) | Meaning |
|---|---|
| `available`, `researchMet`, `shipyardMet` | Availability; legacy notes describe `available` as `researchMet && shipyardMet` |
| `currentShipyardLevel` | Source planet's shipyard level |
| `costOre`, `costSilicates`, `costHydrogen`, `costAlloys`, `rareCosts` | Per-unit resource costs, with rare costs in an object |
| `buildTime` | Per-unit build time in seconds |
| `hp`, `shieldHp`, `attack` | Combat values |
| `speed`, `effectiveSpeed` | Base and modified speed in the legacy shipyard notes; other endpoints expose names such as `displaySpeed` |
| `cargoCapacity`, `miningCargoCapacity`, `hangarCapacity` | Cargo, mining and hangar capacities |
| `repairCostPerUnit` | Returned repair cost |
| `allowedCargo` | `null` or a list of permitted cargo types |
| `populationCost` | Population consumed per unit |

Selected dated ship values and gameplay notes belong in the
[game ship reference](./game-reference.md#ships).
The official ship guide supplies base-yield and role information, but includes
internal inconsistencies such as the EW Ship's armor class. Use current
definition fields (`armorType`, mining rates, cargo restrictions and effective
stats) for integration rather than inferring them from prose. See
[ship guide findings](./game-reference.md#ship-guide-findings).

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
`GET /api/fleet/camp-scout-reports`, documented below.

### Pirate camp scout reports

`GET /api/fleet/camp-scout-reports` returned `{ "reports": [...] }` in a
20 October 2026 capture (HTTP 200, five reports ordered newest first). There was
no `unreadCount` or pagination metadata in this sample; do not assume the
combat-report envelope applies to this endpoint.

| Field | Observed meaning |
|---|---|
| `id`, `missionId`, `userId`, `campId` | Report, scouting mission, player and camp identifiers |
| `outcome` | `"success"` in all five samples; other outcomes are not yet verified |
| `fleetData[]` | Scouted pirate fleet, not the player's scouting ships: `key`, `name`, `quantity`, `shipDefId` |
| `tierData`, `hpPercent` | Scouted tier and camp health snapshot; tiers observed: `scavenger`, `raider`; health was 100 in all samples |
| `createdAt`, `expiresAt` | ISO-8601 timestamps; expiry is exactly 24 hours after creation in all five samples |
| `campName`, `campTier` | Camp name and tier metadata; `campTier` matches `tierData` in these samples, but its freshness is not established |
| `campSystemId`, `systemName` | Camp location; note the `campSystemId` name rather than `systemId` |
| `isRead`, `isSaved` | Read and saved flags; both read states were observed, all samples were unsaved |

Abbreviated report example:

```json
{
  "reports": [
    {
      "id": 77763,
      "missionId": 17220471,
      "campId": 2281,
      "outcome": "success",
      "fleetData": [
        { "key": "scout", "name": "Scout", "quantity": 9, "shipDefId": 4 },
        { "key": "fighter", "name": "Fighter", "quantity": 3, "shipDefId": 5 }
      ],
      "tierData": "scavenger",
      "hpPercent": 100,
      "createdAt": "2026-10-20T01:04:42.673Z",
      "expiresAt": "2026-10-21T01:04:42.673Z",
      "campName": "Void Fang Station",
      "campTier": "scavenger",
      "campSystemId": 13062,
      "systemName": "Z27-12",
      "isRead": true,
      "isSaved": false
    }
  ]
}
```

Expiry does not guarantee that the fleet snapshot remains accurate until then.
The response does not establish whether expired reports are deleted, hidden or
retained, or whether saving changes expiry behavior.

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

Abbreviated illustrative system-contents response (not an exhaustive schema):

```json
{
  "planets": [
    {
      "id": 74062,
      "systemId": 5752,
      "name": "Homeworld",
      "position": 3,
      "planetType": "terra",
      "size": 220,
      "temperature": 24,
      "userId": 1234,
      "isHomeworld": true,
      "colonizedAt": "2026-07-20T12:00:00Z",
      "ownerName": "Commander"
    }
  ],
  "asteroidFields": [
    {
      "id": 11748,
      "systemId": 5752,
      "name": "G21-52-AF1",
      "position": 9,
      "fieldType": "ore",
      "richness": 3,
      "totalResources": 100000,
      "remainingResources": 85000
    }
  ],
  "moons": [
    {
      "id": 8102,
      "planetId": 74062,
      "systemId": 5752,
      "name": "Homeworld Moon",
      "moonType": "rocky",
      "size": 50,
      "buildingSlots": 8,
      "userId": 1234
    }
  ]
}
```

Legacy reference values include planet types `terra`, `crystalline`, `gaseous`,
`volcanic`, `desert`, `ice`; field types `ore`, `hydrogen`, `plasma`, `cryo_ice`,
`bio`; moon types `rocky`, `icy`, `volcanic`; and field richness from 1 to 5.
These are dated examples, not guaranteed exhaustive enums or validated bounds.
The current guide describes rocky planets and six moon types, which do not
match this legacy example list one-to-one. Do not translate those labels into
API enum strings without a current payload. The guide also distinguishes full
system visibility from detailed field-scan intelligence; do not assume all
field data is present merely because a system is visible.
Ownership is represented by fields such as `userId` and `ownerName`; a moon's
`planetId` identifies its parent. The `colonizedAt` value is an ISO-8601 timestamp.

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

Official guides reviewed on 20 October 2026 provide gameplay context, not
endpoint schemas:

- [Resources and energy](https://s0.nexuslegacy.space/guide/de/resources.html)
- [Buildings](https://s0.nexuslegacy.space/guide/de/buildings.html)
- [Galaxy and colonization](https://s0.nexuslegacy.space/guide/de/galaxy.html)
- [Ships and weapons](https://s0.nexuslegacy.space/guide/de/ships.html)

See the [guide findings and open differences](./game-reference.md#official-guide-findings-and-open-differences)
for Season 0 exceptions, moon construction and type-label discrepancies.
In particular, the guide's moon buildings mean the older "no moon building
queue" observation must not be interpreted as a blanket ban on moon construction.
The moon building queue schema remains to be verified from live traffic.

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
