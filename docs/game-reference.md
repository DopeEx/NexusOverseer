# Nexus Legacy Game Reference

Working reference for game mechanics, rules and reference values used during
development and strategy planning. It is not a complete or official game manual.

Endpoints, request/response fields, WebSocket formats and addon integration
behavior belong in the [API integration reference](./api-reference.md).
This page describes their gameplay meaning rather than duplicating schemas.

## Contents

- [Fleet operations](#fleet-operations)
- [Galaxy and colonies](#galaxy-and-colonies)
- [Resources](#resources)
- [Ships](#ships)
- [Zone security types](#zone-security-types)
- [Universe rules (s0)](#universe-rules-s0)
- [Reference calculations](#reference-calculations)
- [Official guide findings and open differences](#official-guide-findings-and-open-differences)

## Evidence and freshness

Live mission observations date from October 2026. The resource, ship and formula
tables below were inherited from the 20 July 2026 reference and have not all
been revalidated. Treat their numbers as dated reference values, not universal
limits or a replacement for current server-calculated costs, rates and estimates.
Unverified behavior is identified explicitly.

---

## Fleet operations

### Mission phases and timing

Observed phases include outbound travel, surveying, mining, exploring,
patrolling and returning. An on-site phase is not a return flight, and the end
of a mining cycle is not the end of the entire operation. A market-delivery
fleet with a docking option is not already docked while still outbound.

Patrol and expedition timers can describe the end of the on-site activity
rather than outbound arrival. When no return has been scheduled, a return ETA
cannot safely be inferred from the outbound duration.

The addon presents countdowns for the next confirmed event and refreshes data
after a deadline rather than assuming the game has changed phase. For exact
status/timestamp fields and display implementation, see
[missions and fuel estimates](./api-reference.md#missions-and-fuel-estimates).

### Fleet slots and patrol capacity

Patrols use separate patrol capacity, not normal fleet slots. Expeditions use
normal fleet slots; the addon also enforces a two-expedition concurrency cap,
confirmed by the player on 19 October 2026. That cap is an additional launch
constraint, not a normal-slot exemption.

The [official patrol guide](https://s0.nexuslegacy.space/guide/de/combat.html#patrols)
explicitly separates patrol capacity from normal fleet slots. The
[expedition guide](https://s0.nexuslegacy.space/guide/de/pve.html#expeditions)
does not establish a normal-slot exemption or document the two-expedition cap.
Keep the player-confirmed limit distinct from an officially documented rule.

### Mining duration and escort retreat

The mine-until-full option allows mining beyond the usual ten cycles until the
hold is full or the field is depleted. Mining progress bars describe the current
cycle, not progress toward a full hold.

The game offers escort-retreat thresholds of 30%, 50% and 70%. When escort damage
exceeds the selected threshold, the fleet returns early and mining stops;
pirates may still steal cargo. For the request representation and mining
metadata, see [mission fields](./api-reference.md#mission-field-reference).

### Pirate scouting and combat

Scouting reveals a camp's fleet composition and records a snapshot of its health
and tier. The snapshot may be outdated after a camp changes or respawns.
Destroyed camps can have a scheduled respawn.

Five successful scout reports observed on 20 October 2026 each expire exactly
24 hours after creation. This is the observed report expiry window, not a
guarantee that the camp remains unchanged for 24 hours. What happens to expired
or saved reports is not yet verified.
See [scout report fields](./api-reference.md#pirate-camp-scout-reports).

Observed pirate battles can last several rounds. Reported ship losses include
both damaged and destroyed ships. A defeat can produce debris and damage the
opponent even when no loot is received.
See [pirate camps](./api-reference.md#pirate-camps) and
[pirate reports](./api-reference.md#pirate-reports) for the technical data.

### Expedition outcomes

Expeditions target sectors and have an exploration phase before returning.
An observed pirate-patrol evasion caused ship losses and cargo to be jettisoned;
the returned fleet composition reflected those losses.
See the [expedition report example](./api-reference.md#expedition-reports).

## Galaxy and colonies

### System contents

A system can contain planets, asteroid fields and moons. A moon is associated
with a parent planet. Different entity groups can be absent from a system
response; an empty group is not by itself a failed request.
For the data structure, see
[galaxy map and system contents](./api-reference.md#galaxy-map-and-system-contents).

### Live state notifications

Observed `galaxy:delta` notifications with `type: "colonized"` report that a
particular system contains colonies (`hasColonies: true`). They do not reveal
which planet or player is involved, how many colonies exist, or when the
colonization actually happened. The same state can be reported repeatedly;
notification counts must not be interpreted as counts of new colonies.

Other delta types, delivery scope and exact triggers remain unverified.
Galaxy Scout passively persists the verified system-level colony hint even
with diagnostic recording disabled. It does not infer planet ownership:
for known systems with full saved visibility, a new hint prompts a targeted,
rate-limited HTTP refresh of the real system contents. Unknown or partially
visible systems are not queried. A newer explicit catalog flag can replace the
hint, including reporting no colonies; the event is not proof of current
occupancy.
For the observed wire format, diagnostic recording behavior and integration
constraints, see [Galaxy delta events](./api-reference.md#galaxy-delta-galaxydelta).

### Colony and moon limits

Research can grant colony and moon slots. The researched contribution is the sum
of each relevant effect's slots per level multiplied by the researched level.
Relevant research includes Colonization Technology, Colonial/Advanced Governance,
Genetic Adaptation, Terraforming, Megastructure Engineering and Lunar
Operations/Expansion/Mastery.

Observed colony-status data returned a limit of six with three researched colony
slots, implying a base of three in that sample. Moon-status data matched the
researched moon-slot total, implying a base of zero. Use the server-returned
limits for current availability rather than inferring a base from the research
catalogue alone. The effect fields and status endpoints are listed in the
[API data endpoint index](./api-reference.md#data-endpoints).

### Construction and research

The observed planetary construction queue holds up to three jobs including the
running job. Older notes reported no corresponding moon queue, but the guide
documents moon buildings: the moon queue mechanism still needs verification.
Shipyards have
separate planetary, orbital and moon queues, each observed with up to three
jobs. Waiting jobs do not yet have an end time. Current returned queue limits
remain authoritative.

Research can increase capacity, storage and production or unlock ships and
buildings. Costs and durations depend on the next level; historical base costs
are not a substitute for the current server-calculated next-level values.
See [research integration](./api-reference.md#research).

## Resources

### Population growth

Population growth is expressed per hour in the game, confirmed by the player
on 20 October 2026. The Dashboard uses the same hourly unit without conversion.
For the API field and population limit, see
[planet detail](./api-reference.md#planet-detail).

### Basic Resources (4)

Current resource production rates returned by the API are hourly values,
confirmed against the Dashboard by the player on 20 October 2026. The addon
does not convert them from per-minute rates. The historical per-level production
figures below have not been revalidated by that confirmation.
See [planet resource fields](./api-reference.md#planet-detail).

| Resource | Production | Storage | Use Case |
|----------|------------|---------|----------|
| **Ore** | Ore Mine (+30/level) | 415,975 | Ships, buildings, alloys |
| **Silicates** | Silicate Mine (+20/level) | 415,975 | Research, buildings |
| **Hydrogen** | Hydrogen Processor (+15/level) | 415,975 | Fleet fuel, alloy production |
| **Alloys** | Alloy Foundry (+10/level) | 404,475 | High-end ships, buildings |

### Rare Resources (6)

The current Storage Complex description says each level adds 5,000 capacity
per rare resource, up to 200,000 after bonuses. A level-15 planet in the
20 October 2026 capture returns `rareResourceStorage: 160000`.
This supersedes the old reference table that attributed capacity solely to
Expanded Warehousing and claimed a 20,000 maximum. Research may still contribute
bonuses, but its exact contribution is not established by this capture.
The returned limit is per rare resource, not a single combined inventory pool.

### Storage Complex capacity

The supplied level table matches `floor(10000 * 1.5^level)` for its basic
storage column: 15,000 at level 1, 4,378,938 at level 15, and 6,568,408 at
level 16. These are building-table values, not necessarily the final capacity
of every resource on the planet.

At level 15 the captured planet has 8,777,876 capacity each for ore, silicates
and hydrogen, and 8,767,876 for alloys. These happen to equal twice the displayed
level-15 value plus 20,000 or 10,000 respectively. The response does not establish
which bonuses or base capacities cause that relationship; do not hardcode it as
a universal formula. Prefer the API's final per-resource storage fields.
See [Storage Complex observations](./api-reference.md#storage-complex-observations).

### Rare resource sources

| Resource | Source |
|----------|--------|
| **Plasma Core** | Asteroid mining, Plasma fields |
| **Cryo Ice** | Cryo planets, Ice Drill ships |
| **Quantum Dust** | Gas Collector ships, missions |
| **Bio Extract** | Bio Complex; Terra +100% output |
| **Dark Matter** | Ice Drill ships, rare missions |
| **Antimatter** | Deep-space activities; some artifacts can grant passive income. The resource guide explicitly says no building produces it directly |

---

## Ships

The July 2026 reference described a catalogue of 31 ships. The tables below are
a selection, not a complete current catalogue. Build availability depends on
research and shipyard requirements; use current returned values for costs and
availability. Repair cost was described as approximately 50% of build cost,
and population cost as applying to capital ships; both are dated observations.
For field names, see [shipyard definitions](./api-reference.md#shipyard-definitions).

### Mining Ships

| Ship | Cost | Capacity | Speed | Specialty |
|------|------|----------|-------|-----------|
| **Mining Vessel** | 546O, 273S, 91H, 91A | 300 mining | 6 | Ore 50/cycle, Plasma 25/cycle |
| **Excavator** | 1365O, 910S, 455H, 455A | 500 mining | 3 | **+20% yield bonus** |
| **Gas Collector** | 455O, 364S, 182H, 91A | 400 mining | 5 | Gas 15/cycle, Quantum Dust 3/cycle |
| **Ice Drill** | 728O, 455S, 273H, 182A | 300 mining (guide) | 4 | Ice 20, Dark Matter 3/cycle (guide; supersedes legacy Ice 25) |

### Escort Ships

| Ship | Cost | HP/Shield/ATK | Speed | Specialty |
|------|------|---|---|---|
| **Interceptor** | 819O, 455S, 182H, 182A | 200/50/35 | 18 | Fighter x4 RF, Scout x5 RF (guide) |
| **Cruiser** | 1820O, 910S, 455H, 228A | 700/200/65 | 8 | Fighter x4 RF, Scout x5 RF, Interceptor x2 RF (guide) |

### Other Notable Ships

| Ship | Cost | Speed | Notes |
|------|------|-------|-------|
| **Probe** | 46O, 228S | 25 | System exploration and automatic return; not the fastest (Spy Probe is 28 in the guide) |
| **Tanker** | 364O, 182S, 91H, 137A | 6 | Extends fleet range |
| **Freighter** | 273O, 91S, 46A | 5 | Standard transport |

---

## Zone security types

The descriptions below are inherited shorthand, not a complete permissions
matrix. In particular, "full PvP" and "special ships required" must not override
the current universe's protection flags or per-activity origin requirements.
See the captured [s0 rules](#universe-rules-s0) for more precise configuration.

| Zone Type | Risk Level | Rules |
|-----------|---|---|
| **Sentinel** | Low | Capital systems, limited PvP, NPC enforcement |
| **Open** | High | Lawless frontier, full PvP enabled |
| **Dead Space** | Restricted | Special ships required (Stealth, Hacker) |
| **Rift Space** | Very High | Quantum Synthesizer production, dangerous |

## Universe rules (s0)

Source: a player-supplied `GET /api/game-config` response on 20 October 2026,
ruleset `s0-2026-10-station-operations-v1`. These values apply to that captured
universe/ruleset, not necessarily other servers or future versions.
For exact field names and feature gating, see
[game configuration](./api-reference.md#game-configuration).

### Speeds and economy

- Economy, fleet and mining speed multipliers: **1x**. Galaxy area: **100%**.
- Dead-space ordinary production multiplier: **1.3x**; rare production:
  **1.5x**. The specialized-rare-bonus flag is disabled. The payload does not
  explain how these modifiers combine with individual research/building bonuses.
- Resource trader is enabled, with relative rate values **ore 1, silicates 2,
  hydrogen 2, alloys 7**, and a **5% fee**. Exact conversion and rounding rules
  still require a trade example.
- Dead-origin requirement flags for mining, anomalies, wormholes and pirates
  are all disabled. Outpost mining is enabled. This does not establish all
  other launch or ship requirements.

### Combat and protection

Combat resolution is configured as **instant**; this does not mean combat
reports cannot contain multiple simulated rounds.

| Planet zone | Planetary shield | Shield reinforcement | Defender retreat thresholds | Economic building damage | Defense building damage |
|---|---|---|---|---|---|
| Sentinel | Enabled | Enabled | Empty list | Enabled | Enabled |
| Open | Enabled | Enabled | 30%, 50%, 70% | Disabled | Enabled |
| Dead | Enabled | Disabled | Empty list | Disabled | Enabled |
| Rift | Enabled | Enabled | Empty list | Enabled | Enabled |

These are configuration flags, not proof that an attack is permitted in every
zone. In particular, the separate dead-space planet-combat capability is
**disabled**, while dead-space planet shields are **enabled**. The defender
retreat thresholds here are separate from mining-escort retreat settings.

- Sleep shield is enabled with a configured duration of **8 hours**, activation
  value **24 hours** and change value **7 days**. The exact scheduling semantics
  of the latter two values are not established by this response.
- Score-based PvP protection is enabled with maximum attacker overall-score
  ratio **5x** and retaliation window **24 hours**. Boundary comparisons and
  exceptions are not specified here.
- Alliance war preparation: **24 hours**; duration: **168 hours (7 days)**;
  peace value: **336 hours (14 days)**; maximum outgoing alliance wars: **5**.
  Asteroid-war combat is disabled. The precise meaning of the peace window
  still needs confirmation.
- Leadership is enabled; alliance council is disabled.

### Stations and inactive systems

Station operations are enabled, capture mode is **operation**, capture command
limit is **8000**, and minimum is **500 CP**. Docking configuration supplies a
base of **500**, **500 per level** and maximum level **3**. The exact total
capacity formula is not established by these fields alone.

Station territory is disabled. Its returned activity, deployment and command
limit parameters must not be treated as active rules.

Fleet supply is also disabled. Although its configuration contains **0.02 Bio
Extract per crew per day**, mothballing after **24 unpaid hours** and desertion
after **48 unpaid hours**, this response does not establish active upkeep or
penalties on s0.

---

## Reference calculations

These inherited formulas are not a validated reimplementation of the game.
For actual dispatch decisions, use the server's
[fuel and travel estimate](./api-reference.md#fuel-estimate-response-fields).

### Excavator Mining Bonus
- **+20% fleet mining yield** is confirmed by the ship guide.
- Exact stacking with efficiency research and multiple Excavators is not
  established by that page; the old multiplicative-stacking claim is unverified.

### Travel Time Calculation
```
travelTime(seconds) = distance / effectiveSpeed
effectiveSpeed = baseSpeed × (1 + Impulse Drive + Warp Drive bonuses)
```

### Fuel Consumption
```
fuelCost = baseFuelCost × (1 + tankerBonus) × (1 - Fuel Efficiency bonus)
```

### Cost Scaling Formula

For the Ore Mine, the 20 October 2026 level-table screenshot and API definition
support a 1.4 cost factor through target level 10, followed by 1.5 per further
level; alloy costs start at target level 16. This is a piecewise factor, not an
additional flat 1.5 multiplier on every high-level cost. The current addon
planner already uses this piecewise model, calibrated against earlier live
examples. Exact rounding and other building-specific modifiers still matter.

The same table's production is not simply +30 per level: its rows match
`floor(30 * level * 1.07^level)` for the Ore Mine. This is base hourly output,
not the colony's final net rate after workers, bonuses and consumption.
The table's construction durations match base times, not the much shorter
server-returned next-upgrade duration for the supplied planet.
For parameters, preview values and remaining integration questions, see
[building definitions and upgrade previews](./api-reference.md#building-definitions-and-upgrade-previews).

## Official guide findings and open differences

Reviewed on 20 October 2026:
[resources and energy](https://s0.nexuslegacy.space/guide/de/resources.html),
[buildings](https://s0.nexuslegacy.space/guide/de/buildings.html), and
[galaxy and colonization](https://s0.nexuslegacy.space/guide/de/galaxy.html).
The following is a summary, not a replacement for the guide. Its explicit
Season 0 notes are distinguished from general descriptions; neither replaces
current per-universe configuration or returned API values.

### Economy, energy and population

- Storage capacity grows with building level and can be increased by research;
  production exceeding capacity is lost. This confirms that the historical
  fixed storage figures above are not universal maximum capacities.
- Energy is a supply/demand balance rather than a stockpile. A deficit reduces
  colony resource output. The fusion reactor consumes hydrogen.
- Residential buildings increase population capacity and growth. The medical
  building contributes capacity and growth; the bio complex improves growth
  and produces Bio Extract but does not itself add population capacity.
- Workers assigned to production are unavailable as free crew or passengers.
  The guide describes balanced automatic assignment and manual prioritization,
  unlocked through Workforce Management.
- In Season 0, population transport is between own planets using suitable
  passenger capacity, not to moons or as gifts. Only free population can travel;
  at least 50 people remain at the source.
- Antimatter is not directly produced by buildings; deep-space activities and
  some artifacts are sources. This supersedes the old "rare buildings" claim.

The resource guide describes a 14-day Season 0 starter boost affecting positive
production and personal economic queues, not flight, combat, repairs, activity
timers, cooldowns or mining cycles. Vacation is described as 2-15 days followed
by a 7-day cooldown, with production stopped and queues paused. Fleet activity,
station garrisons and certain outstanding orders can block vacation.
Inactivity penalties occur in stages after 2, 4, 7 and 14 days; the page does not
provide their exact multipliers. It also describes production stopping outside
Sentinel 24 hours after an already inactive player is attacked if they do not
return. Logging back in clears that condition.

### Buildings and planetary specialization

- The guide lists moon-specific buildings and therefore does not support
  interpreting "no moon building queue" as "moons cannot construct buildings".
  The exact moon construction/queue API behavior needs a captured example.
- Moon shipyards build Dreadnoughts and Titans. Jump gates support instant
  transfer between equipped own moons, have cooldowns and can shorten regular
  routes through the network; distance alone is not sufficient for every
  travel-time calculation.
- Megastructures are limited to one of each type per account, not one per colony.
- Demolition takes time and returns part of the build cost; the page does not
  specify a refund formula.
- Ice worlds support Cryo Ice extraction, volcanic worlds Plasma Core extraction.
  Terra doubles Bio Extract output from the bio complex. The galaxy guide lists
  volcanic bonuses of +20% alloys and +30% energy. Their interaction with
  universe modifiers such as the disabled `specializedRareBonus` flag is not
  established by these pages; do not automatically combine all listed bonuses.

### Visibility and colonization

- Galaxy hierarchy is arm, sector, system, planet and moon; the guide describes
  six spiral arms.
- Visibility has four tiers: full, partial, outline and fog. Full system
  visibility does not by itself grant detailed asteroid field intelligence;
  field scans reveal richness, amounts and depletion data.
- Colony ships and lunar shuttles are consumed when founding their respective
  colonies. A moon must orbit an owned planet to be colonized.
- The explicit Season 0 notes permit colonization in Sentinel, Open and Dead
  Space, unlike the generic instructions that mention only Sentinel/Open.
- Abandoning the last planet is forbidden. Missions including hostile arrivals,
  artifacts and certain research/leadership states can block abandonment.
  Local moons, queues and unfinished research are lost; a suitable remaining
  colony can become the homeworld. The guide specifies a 24-hour colonization
  lock in the same system afterward.
- Season 0 notes prohibit new planetary defenses, moon shipyards and defense
  platforms in Sentinel, and prohibit capital ships entering or leaving it.

### Contradictions and remaining gaps

| Topic | What remains unresolved |
|---|---|
| Season 0 zones | The guide says only Sentinel, Open and Dead are used. The configuration also contains a Rift combat object; presence of that object does not prove Rift is accessible |
| Moon construction | The guide documents moon buildings, while older integration notes say moons have no corresponding building queue. Whether this means no multi-job queue or different response fields requires a live moon construction response |
| Planet types | The guide includes rocky worlds, but the legacy API examples list `desert` and omit a rocky identifier. Display names must not be guessed to be wire-format enums |
| Moon types | The guide describes six types (barren, metallic, icy, volcanic, hollow, ancient); legacy API notes list only three example strings. A current response is needed to establish the actual identifiers |
| Terra orbital positions | One paragraph gives positions 2-6, while the orbital summary emphasizes 3-5. Exact generation bounds are not established |
| Tick units | The buildings page describes some megastructure production per tick; this does not redefine the API's confirmed hourly resource-rate fields |
| Historical formulas and tables | These three pages do not validate the exact old ship costs, mining yields, repair fraction, storage research table, fuel formula or level-11 cost scaling; see the subsequent ship-guide findings for partial updates |

### Ship guide findings

The [official ship guide](https://s0.nexuslegacy.space/guide/de/ships.html)
was also reviewed on 20 October 2026. It resolves several legacy claims but is
not a substitute for current API definitions and effective ship values.

- Fleet speed is limited by the slowest ship. Commander and leadership effects
  can affect the displayed travel time; this does not validate the old
  distance/speed formula or its units.
- The regular Probe has guide speed 25, but the Spy Probe has 28. The old
  "fastest" description was incorrect. The guide describes exploration and
  automatic return, not an exhaustive list of all permitted Probe missions.
- The Excavator grants a 20% fleet mining-yield bonus. It directly mines ore,
  ice, gas and plasma; on quantum and dark-matter fields it supports specialist
  miners without extracting those resources itself. The Season 0 note also
  excludes direct mining of biological fields.
- Guide base yields are per ship per cycle, before richness, bonuses,
  diminishing returns and universe mining speed. Available hold capacity and
  field resources can cap output. Ore-field yield splits into 75% ore and
  25% silicates before rounding.
- The Ice Drill has 300 mining capacity and base ice yield 20 per cycle,
  superseding the legacy 25. Gas Collector base yields of 15 on gas and 3 on
  quantum fields agree with the older notes. The current page does not provide
  enough detail to validate the legacy Mining Vessel yield row.
- A Tanker is hydrogen-only cargo support with guide capacity 900. Its range
  benefit does not establish the fuel-estimate API's exact tanker formula.
- The guide's rapid-fire table gives Fighter x4 and Scout x5 for Interceptors
  and Cruisers, not the old blanket "anti-fighter x5".
- A surviving Repair Ship increases the repairable share of combat losses
  according to the explicit Season 0 note. Do not interpret the generic field
  repair description as proof that all losses are restored, or as confirmation
  of a 50% repair-cost rule.
- Capital ships require a moon shipyard. The guide specifies one Titan per
  empire. Exact costs, effective combat values and availability should still
  come from the current API.

The guide publishes weapon/armor and rapid-fire matrices; use it as a gameplay
source, while retaining the official combat simulator for actual predictions.
There are internal inconsistencies: for example, the EW Ship description says
light armor but the armor table lists it as medium. Verify the live
`armorType` rather than resolving that conflict by assumption.

---

**Last Updated:** 2026-10-20 (reorganization and live-event notes; older reference values remain dated above)

**Scope:** Game mechanics reference for development and strategy planning
