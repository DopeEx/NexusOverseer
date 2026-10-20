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
- [Traffic limits and central scheduling (2026-10-20)](#traffic-limits-and-central-scheduling-2026-10-20)
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
stalled fetch from holding a background request slot indefinitely.
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
Polite background reads share a per-origin minimum 200 ms start interval, including galaxy
cache misses; cached reads do not wait. Each non-simulator 429 doubles this
shared polite interval, capped at 2000 ms, including if an internal retry later
succeeds. After 60 seconds without another observed 429 it returns to 200 ms.
This adaptive spacing supplements, rather than replaces, Retry-After and budget
gates. A 429 with a matching known `X-RateLimit-Scope` pauses that scope; an
unknown/missing scope pauses gated GET/POST requests for that origin. Cooldowns
are independent of budget headers on other in-flight replies, including after
the final failed retry. Retry-After accepts seconds or an HTTP date;
absent/invalid values use at least five seconds with the existing retry backoff.
An exhausted 429 stops Galaxy Scout search/ownership loops with a visible
message instead of continuing to the next system or owner. Collected matches and
cached data are retained; rerunning reuses saved knowledge.
Game-tab overlays and upgrade planners also route API requests through the
central background scheduler. Native game fetch/XHR starts and allowlisted
budget response headers are observed passively, without delaying the game or
requiring diagnostic recording. This is best-effort observation, not a guarantee
that all traffic from other tabs, devices or transports is known.

Combat simulations from the planner and simulator tab share a per-origin background queue:
central admission allows at most three simulator requests per rolling ten-second
window, with slots retained until ten seconds after response completion plus a
100 ms safety margin. This is based on the captured `combat-simulator` response
scope and `RateLimit-Policy: 3;w=10` (2026-10-20). The server scope is mapped to
the internal `simulator` scope. Conservatively, bootstrap requests share this
local limit until their server-side coverage is verified.
Only one simulation is in flight, initially with a 500 ms pause after each
response. Each HTTP 429 doubles this interval up to two seconds; every ten
consecutive successful responses reduce it by 50 ms back toward 500 ms.
Errors reset this success counter, so a single success after a 429 does not
immediately speed the queue up again. These are adaptive client
settings, not a verified server quota. POST requests also observe the general API
budget. Simulator response headers are tracked separately: a small endpoint
budget must not activate the general API client's fixed 20-request headroom.
Successful simulator replies wait for a reset only when their remaining budget
is zero, not merely below 20. A simulator HTTP 429 pauses the queue and retries
the same simulation up to three times, preserving the current fleet search and
automatic attack pass.
`Retry-After` (seconds or HTTP date) is respected, with a minimum retry pause of
five seconds; without it, retries wait five, ten, then twenty seconds.
An exhausted API budget also waits for
`RateLimit-Reset`. Only four consecutive 429 responses for the same simulation
abort the search and impose a cooldown of at least 30 seconds (longer if server
headers require it). Queued callers then receive an explicit cooldown error
without another simulator request. Automatic pirate attacks stop trying other
planets/camps in that pass and can try again on a later automation pass. Learned
search bounds are retained, so a subsequent search can resume from cached work.

Simulator bootstrap and simulation requests do not enter the serialized
server-storage scope used by report scrapes and other background operations.
They capture the selected game's origin before starting and retain it for all
retries, even if the selected universe changes meanwhile. They still use the
simulator queue and shared API-budget gate. The manual fleet dialog and automatic
pirate attack status show the current ship type, probe quantity and completed
simulation count. Search time includes actual server response times and any
budget/backoff waits, not just the 500 ms client pacing.

## Traffic limits and central scheduling (2026-10-20)

The observations below are based on source inspection and supplied game
screenshots from 20 October 2026. The game's changelog and captured responses
are different evidence sources; neither establishes undocumented server
internals. The central scheduler described here is implemented in
[api-scheduler.js](../nexus-addon/api-scheduler.js).

### Observed limits and response headers

A supplied game-changelog screenshot, under "Notes for Tool Developers", states:

| Scope | Ten-second limit | Minute limit |
|---|---:|---:|
| `fuel-estimate` | 40 | 120 |
| `system-details` | 30 | 180 |

The same note states that HTTP 429 responses expose `X-RateLimit-Scope` and
`Retry-After`, and tools should respect both without immediate retries. Both
time windows must be respected, not just the minute limit. The screenshot does
not specify the window algorithm, quota identity or exact endpoint matching.

Supplied response-header screenshots from `https://s0.nexuslegacy.space` show:

| Request | Status | `RateLimit-Limit` | `RateLimit-Policy` | `RateLimit-Remaining` | `RateLimit-Reset` |
|---|---:|---:|---|---:|---:|
| `GET /api/galaxy/systems/2877/planets` | 304 | 400 | `400;w=60` | 271 | 40 |
| `GET /api/planets/4699` | 200 | 400 | `400;w=60` | 266 | 35 |
| `GET /api/galaxy/systems/786/planets?include=planets,moons,fields` | 200 | 400 | `400;w=60` | 328 | 20 |
| `POST /api/fleet/fuel-estimate` | 200 | 400 | `400;w=60` | 357 | 50 |

These responses establish an advertised 400-request/60-second policy, including
on successful fuel-estimate and system-detail responses. Their headers do not
advertise the smaller scope budgets. Plan conservatively for the general budget
and the applicable scope limits together; do not interpret a large general
remaining value as permission to exceed a scope limit.

The first two responses have server `Date` values of `20:57:25 GMT` and
`20:57:30 GMT` on 20 October 2026. Reset falls from 40 to 35 over those five
seconds, supporting the current interpretation as seconds until reset, not an
epoch timestamp. This does not prove fixed versus sliding windows.

The screenshots list
`Access-Control-Expose-Headers: X-Server-Time,X-RateLimit-Scope,Retry-After`.
That declares cross-origin header accessibility; it does not mean all three
headers are present. No actual `X-RateLimit-Scope` or `Retry-After` field appears
in these successful/304 samples.

A subsequent Galaxy Search screenshot captured an actual 429 for
`GET /api/galaxy/systems/3493/planets`, with server date
`20 October 2026 21:43:37 GMT`. It reports `X-RateLimit-Scope: system-details`,
`RateLimit-Limit: 30`, `RateLimit-Policy: 30;w=10`,
`RateLimit-Remaining: 0`, `RateLimit-Reset: 1` and `Retry-After: 1`.
The JSON body reports `code: RATE_LIMITED` and
`error: Too many system detail requests, slow down`. This confirms that the
scope-specific response can advertise the ten-second budget instead of the
general 400/minute budget. The screenshots alone do not establish which requests
consumed the preceding window.

Regression tests exposed two client-side risks during investigation: rolling
slots could expire relative to background admission before the corresponding
server-receipt window ended, and loading both API bridge implementations could
leave duplicate request listeners. Slots now remain counted for the full window
after transport completion, with an additional 100 ms boundary margin. Both bridge
implementations share one replaceable listener registration. These fixes address
reproducible defects, not proof of the exact cause of the captured incident.

For HTTP semantics, see [RFC 6585 section 4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)
and [Retry-After in RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after).

A 304 is still a network request: it allows reuse of a cached representation,
not avoidance of the server request. It must not be assumed free for client
budget planning. A direct hit in the add-on's own cache can avoid the API request.

A separate `POST /api/security/signal` sample returned 404 with the same general
policy and budget headers. Its payload shape included a web source, component
version, page path and device fingerprint. The fingerprint value is deliberately
not reproduced here. The stack passes through the diagnostic and galaxy XHR
wrappers, which forward the original send; two wrapper frames do not establish
two requests. No caller for this endpoint was found in the add-on code, and the
remaining stack points to game scripts. Its purpose and the reason for the 404
remain unknown; this is not evidence of add-on detection. A 404 is not a
rate-limit response and must not trigger a 429-style retry. Budget headers on
non-success responses are nevertheless relevant observations. These samples
alone do not prove whether the individual 304 or 404 reduced the server counter.

A separate community discussion dated 21 July 2026 described throttling at
about 370/minute against a 400/minute cap, queueing and respecting retry headers.
That is context, not an official recommendation to allocate 370/minute to this
add-on. Game traffic also needs budget, and a queue without rate control does
not enforce a quota.

### Request paths and scheduling

The following inventory is based on source inspection, not a measured traffic
profile. Timer intervals are triggers, not guaranteed request frequencies.

| Producer or path | Current behavior | Scheduling details |
|---|---|---|
| Background reads and fleet actions | `apiFetch` and `gamePost` schedule every attempt centrally | Priorities, bounded concurrency, rolling windows and optional polite spacing |
| Fuel estimation and system details | Local rolling 10-second and 60-second gates | Every actual retry counts; observed native starts count too |
| Game-tab API bridges | Forward retry, scope, limit, policy, remaining and reset headers | Only the transport executes authenticated API fetches |
| 429 handling | Known matching scope pauses that scope; unknown/missing/mismatched scope pauses the origin | Optimistic responses cannot erase the cooldown; explicit general policy distinguishes general budget headers |
| General budget state | Conservative shared local ceiling plus per-origin header observations and scope state | Saved in `storage.session` before dispatch and after observations, surviving worker restarts within a browser session |
| Simulator | Central rolling limit of 3/10 s, plus per-origin serialized queue and adaptive pacing | Captured `combat-simulator` policy `3;w=10`; bootstrap conservatively shares the local window |
| Empire and logistics overlays | GETs and POSTs use `nexusGameApi` through background messages | No direct game API fetches |
| Building, technology and ship upgrade planners; aggregate upgrade planner | Reads use `nexusGameApi` | Share scheduling and pending GET coalescing |
| Research start | Uses scheduled POST and initiates a separate follow-up scrape | Returns the confirmed action result without awaiting the entire scrape |
| Runtime message handling | Network-only reads/actions and explicit-server local galaxy scan/delta reads bypass `withServer`; storage-processing operations retain protected scopes | Request origins are pinned; explicit server storage access protects galaxy-cache migration from another operation's temporary scope |
| Background scrape | 15-minute alarm, installation/update and manual triggers; loads multiple endpoints in parallel and visits open universes | Classify periodic versus explicit work; do not let an entire scrape inherit action-level priority |
| Asteroid live search | Five-minute alarm plus an immediate run when enabled/changed; can examine up to 500 systems depending on filters | Long-running scan needs cancellation and bounded access to scope budget |
| Dashboard overview | Manual/automatic distinction via `polite`; automatic refresh depends on settings and displayed completions | Existing distinction is not a full priority model |
| Dashboard automations | Scouting, pirates and expeditions run sequentially in a shared 15-second cycle, gated by expert mode and feature readiness/switches | Long tasks delay later tasks; no overlapping cycle starts |
| Visible Scouting view | One-second UI timer calls ship availability every ten ticks while the subview is open; mission refresh has a separate due check | Display polling is distinct from executing an automation |
| Realtime report/status observer | Observes successful watched requests and actively re-fetches their pathname at background priority | Additional traffic, not passive response reuse; query parameters are not retained; active add-on transport is excluded |
| Galaxy response observer/cache | Passively relays selected fetch/XHR responses; cache coalesces matching pending system/catalog reads | Reuse existing mechanisms rather than duplicating requests or cache logic |
| Universe catalog | Scheduled request to `https://nexuslegacy.space/api/universes` | Separate origin, conservatively included in the shared local ceiling; its quota relationship is unknown |

Source entry points:
[background request handling and observers](../nexus-addon/background.js),
[server-storage serialization](../nexus-addon/server-storage.js),
[game API bridge](../nexus-addon/game-api-bridge.js),
[sidebar bridge](../nexus-addon/sidebar-inject.js),
[automation scheduler](../nexus-addon/automation-scheduler.js),
[dashboard task registration](../nexus-addon/dashboard.js),
[Scouting UI and automations](../nexus-addon/tabs/scouting.js),
[empire overlay](../nexus-addon/empire-view.js),
[logistics overlay](../nexus-addon/logistics-view.js),
[building planner](../nexus-addon/building-upgrade.js),
[technology planner](../nexus-addon/tech-upgrade.js),
[ship planner](../nexus-addon/ship-upgrade.js),
[aggregate upgrade planner](../nexus-addon/upgrade-queue.js),
[galaxy observer](../nexus-addon/galaxy-fetch-hook.js) and
[galaxy cache](../nexus-addon/galaxy-cache.js).

The realtime observer's three-second host/path debounce reduces repeated
re-fetches but does not make capture passive. It excludes completions matching an
active add-on transport's tab/path, as well as `tabId === -1`, to avoid feeding its
own re-fetches back into the observer. Simultaneous native completions for that
same tab/path may also be suppressed; the add-on request already supplies fresh
data. Passive reuse of report/status response bodies is a candidate for
investigation, not a completed
replacement. The galaxy observer already demonstrates passive response reuse.

Galaxy Search loads saved scans before evaluating individual systems. This local
read must not queue behind a server-storage operation that is waiting for network
capacity; otherwise the UI can remain at "Searching saved data" without issuing a
search API request. Scan/delta reads use their explicit server key independently
of that operation queue. Stopping a search invalidates its generation immediately
and restores the Search button, even while a prior local or network read is still
pending. Late replies cannot replace a newer search's results or status.
Already admitted requests may finish; stopping prevents further work from the old
search rather than undoing sent requests. Saved galaxy knowledge is retained,
and identical settings can be searched again after an interruption or 429.

### Scope and priority model

Every add-on game-API request, including retries, passes a central scheduling
decision. This covers data/action requests, not browser-loaded image assets or
external GitHub downloads. Native game requests remain unmodified:
observe their traffic and budget information without delaying execution.
Treat game and add-on traffic as sharing the available budget;
observing one browser cannot guarantee knowledge of other devices or all traffic.
Same-origin routing provides authentication, not automatic scheduling.

Equivalent manual and automatic dispatches use the same action priority.
Priority follows purpose, rather than automatically demoting automation:

| Work class (rank) | Examples | Scheduling intent |
|---|---|---|
| Action (0) | Manual/automatic dispatch, research start, tagged immediate prerequisite reads | Highest normal priority; no budget or cooldown bypass |
| Interactive (1) | Opening an overlay, changing a fleet input, requesting current data | Prompt service without promoting an entire bulk job |
| Check (2) | Periodic mission readiness and visible ship-availability polling | May wait; not equivalent to an action already ready to execute |
| Bulk (3) | Galaxy search detail reads, repeated combat simulations, remaining market pages | Progress while yielding capacity to actions and interactions |
| Background (4) | Periodic scrape, polite cache fills, observer follow-up refresh | Use remaining capacity |

The scheduler allows at most three in-flight attempts; lower-priority work
normally occupies at most two slots. Queue age improves effective priority by
one rank every 30 seconds, and aged work can use the third slot. The conservative
shared rolling ceiling is 400 starts/minute, with non-action work limited to 380
to leave 20 starts for actions. General header headroom is zero for actions,
20 for other work, or 40 for polite work. These are client safeguards, not
additional server quotas or a guarantee of free capacity when an action arrives.
Rolling-window slots are reserved before dispatch and their timestamps advance
to transport completion (including failures), then remain counted for the full
window plus 100 ms. Completion timestamps are persisted as well. This avoids
releasing capacity early because of tab messaging, transport latency or exact
boundary timing; it deliberately trades a small amount of throughput for margin.

Eligible work can pass a scope-blocked queue item. Matching pending GETs retain
their full path/query and origin when coalesced and can be promoted by a
higher-priority caller. Writes are never coalesced. The content client accepts an
optional AbortSignal to remove a caller's queued work without cancelling another
consumer of the same read; sent actions are not rolled back. Existing callers
without a signal continue to completion. POST retries remain limited to explicit
429 responses; network errors or ambiguous server failures do not replay writes.
When headers explicitly describe a matching endpoint scope rather than the
general policy, an exhausted scope budget also waits for its reset.

### Remaining verification and safeguards

Optional **Record API wait times** in Developer / Debug records scheduler
metadata independently of diagnostic body capture. Fixed source labels follow
Galaxy Search, ownership checks, asteroid/xeno searches, dashboard reads, fleet
actions, simulator calls, empire/logistics overlays and upgrade planners through
retries to central admission. Untagged internal work remains explicitly grouped
as background maintenance; unspecified content callers use content-tool. Coalesced requests retain
the initiating source and list participating source labels, but count one
transport, not one request per consumer.

Each scheduler wait produces a start and terminal event, not an event per
countdown tick. The terminal event includes actual elapsed queue time, all
observed reasons/windows, extended release times, and dispatched/cancelled
outcome. Dispatch and response events provide attempt and 429 counts. Budget
snapshots and per-origin source counts for the preceding minute distinguish
waiting producers from other traffic contributing to congestion, including
passively observed native starts. General local budget spans universes, whereas
these contribution snapshots are per-origin, so they are not a complete
causality attribution. No paths, game IDs, bodies or credentials are logged.

Events are written asynchronously to local diagnostics (1,000 scheduling events,
10 MB shared per server) and exposed in API Wait Times with a per-source summary,
expandable JSON, JSONL export and clear action. Summaries cover retained events
only; they are not lifetime totals. Wait totals count completed central queue
episodes, not producer preparation or retry sleeps before admission. On the next
recorded event after worker recreation, retained unmatched starts are closed as
interrupted with incomplete duration, not an invented elapsed time. Retention
or abrupt termination can lose events; source statistics are diagnostic evidence,
not an exact server ledger. Recording failures are logged without blocking
game requests. Both recording switches default off.

The dashboard polls `GET_API_STATUS` once per second while visible. This reads
the central scheduler directly, bypasses long server-storage operations and
does not dispatch game API requests or persist status snapshots. The same status
element sits above Options in the navigation at widths above 900 px and moves
to the header directly right of the hamburger button in hamburger mode.
Expanded details use compact per-scope budget lines; navigation details have no
inner scrollbar and use only the navigation's scroll area. Header details open
left-aligned below the indicator with space
between the header and content. A breakpoint change preserves the open state
without duplicating polling or IDs. The indicator
shows running/queued central attempts and distinguishes normal budget waits
from server-requested 429 cooldowns. Expand it for the selected origin's general,
system-detail, fuel-estimate and simulator counts. General local counts are
shared across origins; server observations remain origin-specific. Server-reported
remaining values and observation age are separate from conservative local
reservations and can be stale. Simulator counts show the local 3/10 s limit.
The display covers central admission, not every producer's preparatory work or
the simulator's additional response-to-request pacing before central admission.

Galaxy Search requests status for its currently awaited system path and shows
the reason inline after its existing progress, explicitly labelled as API status: request in progress, queued,
request spacing, local/header budget pause or server cooldown, with seconds until
the known release. Inline spacing, budget and server-pause hints are hidden when
at most one second remains, avoiding unreadable flashes; scheduling and the
global API status are unchanged. This is a next-release countdown, not a promised start time
or whole-search ETA. Stops, resets and late replies cannot restore stale hints.
Failures to read status are shown explicitly rather than as "ready". Background
dashboard tabs suspend polling; closing the page removes the timer/listeners.

- Browser-session state survives service-worker restarts, not a full browser
  session reset. Other devices and unobserved requests remain outside local
  accounting. Delayed optimistic headers cannot increase a live window's known
  remaining budget; reset observations are treated conservatively.
  Queued work itself is not persisted: interrupted callers may need to retry
  after a worker restart, while restored counters and cooldowns still apply.
- Storage-processing tasks still serialize where they access shared context;
  network-only action/interaction messages no longer wait behind them. Existing
  automation task order and timer intervals are unchanged.
- Automatic cancellation on every view closure, deadline scheduling and atomic
  reservation of game resources/slots across whole operation chains are not
  implemented. The server still validates actions against actual game state.
- Confirm other scope values and header behavior beyond the captured
  `system-details` 429. Unknown scopes or missing headers must not enable
  immediate retry storms. No deliberate limit-exhaustion experiment is needed.
- Verify exact endpoint coverage for `system-details`, simulator bootstrap and the
  universe catalog. Authentication through the game tab does not establish the
  server's account/IP/session quota identity or authorize automation by itself.

Deterministic coverage includes exact rolling-window thresholds, retry
accounting, scope isolation, priority/concurrency behavior, shared read
cancellation, worker-state restoration, explicit origin/storage isolation and
transport routing in [scheduler tests](../tests/api-scheduler.test.js) and
[routing tests](../tests/api-routing.test.js). Related focused tests include
[API rate limiting](../tests/api-rate-limit.test.js),
[simulation](../tests/simulator-api.test.js),
[automation cycles](../tests/automation-scheduler.test.js),
[server storage](../tests/server-storage.test.js) and
[galaxy caching](../tests/galaxy-cache.test.js).

For future evidence, collect only method/path, status, server time and relevant
rate-limit/retry response headers. Redact device identifiers; do not retain
cookies, authorization values, full HAR exports or copied authenticated commands.

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

Galaxy Scout now consumes this verified payload independently of diagnostic
recording. The existing WebSocket observer forwards only the supported fields
through the isolated galaxy relay as `GALAXY_DELTA`; the background validates
the timestamp, positive integer system ID and game-tab origin and pins storage
to the sender's universe. Direct JSON arrays and Socket.IO `42` event frames,
including namespaces, are accepted on same-host/protocol/port game sockets.
Binary, malformed and unsupported payloads are ignored. With recording disabled,
only candidate galaxy frames up to 4096 characters are parsed.

The cache stores one latest observation per universe/system as `delta:<id>`,
separate from full body snapshots. Duplicate or older capture times do not
overwrite it. Cached and newly fetched map/sector catalog reads overlay the
system-level flag, without inventing unknown systems. A newer explicit catalog
flag wins (including `false`); an omitted flag does not contradict an older
observation. `_galaxyCatalogAt` reports catalog capture time and
`colonyStateObservedAt` identifies an overlaid WebSocket hint. Neither catalog
age nor planet/moon ownership freshness is extended by the hint itself. It
never supplies planet/moon arrays or infers owners or completeness.

A newly stored hint also triggers a targeted background refresh through the
existing polite `GET /api/galaxy/systems/{id}/planets` path if the system is
already known and its latest recorded visibility is `full`. Eligibility is
checked locally against saved system details and map/sector catalogs, without
fetching the map. Unknown, outline and fogged systems retain only the hint.
An existing ownership TTL does not prevent this refresh, but a hint already
covered by both saved ownership-group timestamps does. Concurrent refreshes
share the existing per-system request; identical/older replayed hints do not
start another request. New observations may trigger another refresh. The
runtime message keeps the operation alive and inside the sender's serialized
universe scope until the request completes. Shared budget gates, adaptive
polite spacing, Retry-After and bounded retries remain active.

Only the HTTP response updates body data and ownership clocks, using the
normal complete-group merge including explicit `userId: null` abandonment.
Failures are logged and returned through the relay with their HTTP status;
transport failures do not erase saved contents and there is no additional
unbounded retry loop. A later new hint may retry.

`GET_GALAXY_DELTAS` reads observations locally. A universe-scoped storage
notification lets open dashboards update an existing system overview's
"Colonies reported" hint without changing views, result lists or highlighted
rows. After a successful HTTP refresh, `galaxy_system_revision` separately
notifies open dashboards to reread local scans, update existing search hits,
lists and map result overlays and redraw an open overview while retaining
its originating body highlight. This local reread does not request game data.
There is no dedicated subscription or extra socket.
The MAIN observer buffers the latest hints for up to 100 systems for early
relay startup/replay. Observations are included in galaxy backups and removed
by the selected universe's galaxy-cache clear operation.

Verified on 20 October 2026 against the previously captured payloads above and
the reference addon's `GalaxyDeltaJob`: that job stores the payload and forwards
it unchanged, providing no additional body or owner details. The supported
scope is deliberately system-level only. No abandonment payload or per-planet
WebSocket ownership update is currently verified; HTTP ownership responses
remain authoritative for colonization, abandonment and recolonization.

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
| Galaxy stations | `GET /api/galaxy/station-index` | `stations[]`: station identity, system identity/coordinates, viewer-alliance ownership and owner/capturing alliance tags; observed response documented below |
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

#### Station index (observed 2026-10-20)

A user-supplied successful `GET /api/galaxy/station-index` response contains
`{ stations: [...] }` with 1,096 entries in that particular snapshot. This is
an observed count, not a fixed galaxy-wide limit or proof of complete visibility.
Each observed entry has:

| Field | Observed shape |
|---|---|
| `stationId`, `stationName` | Numeric station ID and display name |
| `systemId`, `systemName` | Numeric containing-system ID and display name |
| `systemX`, `systemY` | Numeric map coordinates |
| `ownedByViewerAlliance` | Boolean, relative to the requesting player |
| `ownerAllianceId` | Numeric alliance ID or `null` |
| `ownerAllianceName`, `ownerAllianceTag` | Strings or `null` |
| `capturingAllianceTag` | Capture-alliance tag field; `null` in the inspected examples |

The index provides enough location data to draw station markers without
per-station or per-system detail requests. Alliance ownership/capture fields
are dynamic, viewer-dependent state and must not be treated as permanent
physical galaxy knowledge. This response does not establish a refresh TTL,
WebSocket update contract, station combat details or complete visibility rules.
Nexus Overseer fetches this index through `GET_STATION_INDEX` only when the
Stations layer is enabled. It shares the universe-separated IndexedDB galaxy
catalog cache, coalesced pending requests and existing polite API transport.
Successful game-page GETs are passively captured too. Physical station identity
and system coordinates are stored separately from alliance ownership/capture
state; catalog observations carry a timestamp and newer snapshots replace
older ones, including explicit null ownership after abandonment. Catalog
freshness is 15 minutes, matching map/dynamic data because capture state can
change; this does not evict the persistent physical data after 15 minutes.
Re-enabling the layer checks freshness, without per-system/station requests.
Failures are reported and do not masquerade as an empty successful catalog.
Backup/restore and universe-specific galaxy clearing include stations.
Station entries omitted by a later response retain their physical data and
last observed status/timestamp: index omissions are not assumed to mean
station destruction or unclaimed ownership. Exported stations carry
`_observedAt` for the latest individual observation.

Station markers are purple hexagons (green for the viewer's alliance), drawn
above stars independently of zone rings. The layer defaults off and resets
on universe changes. Station names/owner tags appear when zoomed in or owned
by the viewer's alliance; clicked systems include last-known station owner
and capture tags. Index-only system locations remain unknown visibility and
never grant permission to scan their contents. The station catalog does not
promote any system to explored/full visibility.
The supplied account-specific payload is not included in the repository.

Marker palette verified against the public game frontend on 2026-10-20
(`GalaxyPage-IYSDV7EB.js` and `GalaxyPage-CFo_cWpP.css`):
moon types use barren `#9ca3af`, metallic `#d97706`, icy `#67e8f9`,
volcanic `#ef4444`, hollow `#a78bfa`, ancient `#fbbf24`.
Planet type labels are neutral in the game, not individually color-coded.
Zones use sentinel `#22c55e`, open `#f59e0b`, dead `#ef4444`, rift `#7c3aed`.
The Galaxy Scout badges reuse these semantic colors within the addon layout;
star thumbnails remain tinted placeholders, not verified game star assets.

Galaxy Scout's map uses this zone palette for rings around star-colored points,
independently of ownership/search overlays. `Zone rings: on/off` toggles all
zone rings only; the default is on, retained during tab changes and reset for
a universe reset. The navigation-marker colors (own cyan `#38bdf8`, saved
alliance green `#7ee787`, search orange `#f0883e`) are addon conventions, not a
claim of exact game-map styling. A fresh CSS check on 2026-10-20 confirmed
sentinel/open/dead breadcrumb colors in `GalaxyPage-CFo_cWpP.css`; its rift
breadcrumb uses `#a855f7`, distinct from the previously verified map palette
and this addon's shared zone token `#7c3aed`.

Star point colors verified in the public
`GalaxyPage-IYSDV7EB.js` renderer and its shared palette imported from
`MiningModal-DVLP-6Zp.js`: yellow `#fbbf24`, red dwarf `#ef4444`, blue giant
`#60a5fa`, orange `#f97316`, white dwarf `#e2e8f0`, neutron `#c084fc`.
Unknown types use a neutral grey. These verified flat marker colors do not
change the provisional thumbnail artwork described above.

Own chevrons, saved-alliance brackets, search rings and hub diamonds render
after the full star/zone layer, so subsequent stars cannot obscure them.
Own systems also use green brackets and the current `GET_AUTH_ME.user.username`
as their green label, followed by saved allied owners when present; the cyan
chevron additionally identifies personal colonies. Unknown usernames retain
an explicit player-ID label. Player/alliance labels start below the system
(below the selection ring when selected); collision alternatives move downward,
never above the chevron. Names that cannot fit remain hidden rather than detached
above their marker. Home uses an accessible house-icon button; the Zone rings
button reuses `zone-toggle zone-sentinel` with `is-selected` and `aria-pressed`
kept in sync, filled when enabled and hollow when disabled.
Zoom/reset controls overlay the top-right map edge;
the legend follows the map surface below it.
Dark outlines and backed labels provide contrast; labels use collision-aware
placement. Star/ring size grows with zoom; navigation symbols use
CSS-pixel coordinates independent of backing resolution. Labels use native
HTML spans in a non-interactive overlay positioned relative to the canvas,
not `fillText`. Their 13px font is rendered by the browser; long names use
ellipsis rather than horizontally compressed glyphs. DOM text is assigned
through `textContent`; all label boxes are measured in a batch before
collision-aware placement at whole CSS-pixel offsets. The overlay is hidden
from assistive technology because the existing lookup and overview provide
accessible navigation. Labels clear on redraw/reset, including empty maps.
The backing buffer
is rounded from the displayed canvas size multiplied by `devicePixelRatio`;
the context transform accounts for rounding on each axis. The active Map view
uses a viewport-height flex layout: the canvas fills the remaining height
after the toolbar and legend, independently of its backing buffer's intrinsic
size. Proportional projection preserves galaxy geometry at every aspect ratio.
The viewport lock applies only when Galaxy Scout and Map are both active;
Search, directories and other tabs keep normal document scrolling. At heights
up to 700 CSS pixels, the footer is hidden, but standard panel padding,
16px inter-panel spacing and legend sizing remain unchanged;
up to 450 pixels, the in-map controls form a horizontal row.
`ResizeObserver` handles container/show-hide changes, window
resize handles viewport changes, and a rearmed resolution media query handles
pixel-density changes. Resizing preserves the world-space center and zoom;
pointer navigation and hover use the same CSS-coordinate space.
Zone toggling does not modify the search,
position, ownership overlays or cached data and issues no network request.

The inspected reference `galaxy-DJr_n2VN.js` provides name/ID navigation,
Home and zoom controls, and derives player/alliance occupancy from saved
planet owners. Nexus Overseer's local lookup adds explicit selection for
ambiguous names, uses the actual `isHomeworld` planet from `GET /api/auth/me`
for Home, and retains proportional x/y scaling. Alliance markers derive from
saved planet **and moon** `userId`/`ownerAllianceTag` values compared with
`GET_ALLIANCE`'s current member IDs/tag, never from a search-only subset.
Unknown/unowned bodies are excluded. This is last-known occupancy, not a new
alliance-wide discovery API or proof of current ownership. Reading local scans
on initialization adds no game API call; navigation and tooltips are local.
The map's combined lookup is an ARIA combobox with a local listbox of up to
50 matching systems, showing plain-text name, ID and zone. Arrow keys update
`aria-activedescendant`; Enter selects the active, exact or unique match.
Ambiguous unselected input never chooses arbitrarily. Escape and focus leaving
the widget close suggestions; the clear icon only resets lookup text.

Map hover and click share the same nearest-system hit test in CSS coordinates,
with an eight-pixel radius independent of HiDPI backing resolution. Hover
explicitly sets `display: block` to override the tooltip's hidden CSS default.
Clicking selects without recentering and opens a non-modal, focusable action
box with star/zone/visibility, saved own/alliance occupancy and body counts
from `finderScans`. Missing body groups say `not saved`, never zero. The action
opens the existing local system overview without fetching data. Names use
plain text. The box is clamped inside the map, scrolls internally if needed,
and closes on Escape, outside click, redraw or view reset. A four-CSS-pixel
drag threshold prevents pan gestures from triggering the click selection.
The reference sizes its canvas to its parent's `clientWidth`/`clientHeight`
on mount/window resize and draws hover text as HTML, not canvas text. Its
inspected renderer does not multiply the backing size by `devicePixelRatio`.
Nexus Overseer additionally handles HiDPI and container-only resizing.

The reference client's image components derive type-based assets using
`/api/images/planets/{planetType}.webp` and `/images/moons/{moonType}.webp`.
Individual image URLs are not documented in the observed system-contents payload.
The local cache stores these derived relative paths with permanent properties;
older entries can derive them at display time. URLs resolve against the selected
universe origin. Asset loading is separate from system-content API requests and
uses browser HTTP caching; the addon does not store image binaries in IndexedDB.

Galaxy Scout does not display temperature, but retains it in cached physical
properties. Planet slot capacity uses a saved `maxBuildingSlots` or `buildingSlots`
when available; otherwise the reference client's base calculation is
`floor(size / 10)`, reduced to `floor(floor(size / 10) * 0.3)` for gas giants.
Calculated values are base capacity, not unused slots or a guarantee of bonuses.
Moon slots continue to use the observed `buildingSlots` without this calculation.

Nexus Overseer caches galaxy reads centrally in a universe-separated local
IndexedDB database. Map, arm and sector responses have a 15-minute TTL. System
responses are split into permanent planet/moon properties, separately timestamped
ownership (one-hour default cache for shared readers, 30 minutes for own dashboard
moons), and dynamic asteroid contents (15 minutes). Galaxy Scout searches saved
physical properties first and only loads missing base data. It never refreshes
ownership or fetches player ranks as part of the base search. Results are rendered
with cached ownership first, then only unknown ownership in matching systems is
checked automatically. Known ownership is retained without time-based expiry in
Galaxy Scout and updated through passive observations or manual checks.

Search availability handling (2026-10-20): the diagnostic
`Galaxy response did not resolve requested static data` is a missing-data error,
not itself HTTP 429. Earlier HTTP 429 attempts for the same system can still have
occurred: API reads retry internally, and a subsequent successful HTTP response
may omit requested groups. An exhausted 429 retains status 429 through the
cache/background/client chain and is not converted to a missing-data error.
The missing-data diagnostic identifies an API response that did not supply the requested
planet or moon group. The response alone does not prove why that group is absent.
Per the official galaxy guide, partial visibility exposes catalog information,
not detailed planet contents. Search therefore uses saved contents at any
visibility but only requests missing contents for systems with full visibility.
Systems without full visibility and without the saved groups needed for the
active search are excluded before scanning, not counted as search issues or
unavailable-detail errors. Saved planet data is sufficient for planet-only
criteria; moon criteria require saved moons only for otherwise matching planets.
Systems with sufficient saved knowledge remain searchable even without current
full visibility. An empty candidate set reports no searchable systems, without
recommending repeated API attempts.
Missing contents remain unknown, never an authoritative empty array.

Moon enrichment requests only the missing moon group; static requests can combine
newly resolved groups with permanent properties already saved in the shared cache.
Ownership refreshes still require freshly resolved ownership and never silently
return stale owners. Unresolved responses expose `GALAXY_DATA_UNAVAILABLE` plus
the missing group names through the background/client bridge. For static requests,
the background cache pauses the same unavailable system/group for 15 minutes,
independently per universe. This pause is in memory and ends on worker restart;
valid passive observations satisfy requests immediately, and explicit force
bypasses the pause. Transport errors and 429s are not cached by this mechanism.

Search reports successfully scanned systems separately from unavailable details
and technical failures. Any skipped details make the saved search incomplete;
Search issues lists affected system IDs and reasons. An exhausted 429 still stops
the search explicitly. These changes do not increase retry counts or bypass the
shared API rate limiter.
Galaxy Scout does not display player ranks or fetch ranking data. Its separate,
optional **Check result ownership** action requests current status once per
matching system, bypassing the ownership TTL, including matches hidden by local
ownership display filters. No unrelated system is checked. Missing/unresolved
groups do not erase previously known data; explicitly resolved empty groups do.
An explicit `userId: null` clears former ownership, including alliance metadata;
an omitted owner ID does not establish that a body is unowned.

Galaxy Scout's zone buttons support multiple selected zones (none means all).
Planet types also use a multi-select with no selection meaning all.
Type options follow the [official galaxy guide](https://s0.nexuslegacy.space/guide/de/galaxy.html),
checked on 2026-10-20. The guide lists six colonizable planet types and six moon types:

| Body | Guide labels (German) | Addon/API type identifiers, same order |
| --- | --- | --- |
| Planet | Felsig, Kristallin, Gasriese, Eis, Terra, Vulkanisch | `rocky`, `crystalline`, `gas_giant`, `ice`, `terra`, `volcanic` |
| Moon | Karg, Metallisch, Eisig, Vulkanisch, Hohl, Antik | `barren`, `metallic`, `icy`, `volcanic`, `hollow`, `ancient` |

Ancient and metallic are not planet types. Saved searches containing unsupported
type selections show an explicit Clear search hint rather than silently broadening
the search. Observed cache data is not rewritten or deleted by this correction.
The initial arm selection is All arms; sector input is disabled until one arm is selected.
Search's More filters adds maximum distance from Origin, minimum planet-slot
capacity (using `planetSlots`) and moon-type multi-select. Distance filtering uses
the same rounded system distance as displayed results, excludes unknown distances
when active and runs before content requests. An active maximum requires a known
origin; invalid/negative/fractional numeric limits report errors without starting
or replacing the saved search. Empty distance means unlimited; zero is valid.
The minimum moon-slot filter requires at least one moon belonging to the matching
planet with `buildingSlots >= minimum` and known `userId: null`; slots are not
summed and colonized moons do not qualify. Missing moon data is loaded only after
planet properties match. Unknown ownership of qualifying moons is checked after
the base search, once per relevant system, requesting both planets and moons.
Selected moon types and a positive slot minimum must match **one and the same
free moon**, including after automatic/manual ownership updates and when projecting
Search results into the Moons list. Moon types without a slot minimum do not
restrict moon ownership. Unrelated, nonmatching planets do not trigger missing
moon reads, including when rejected by the new capacity filter.

`galaxy_last_search` stores the last started search in server-scoped local storage:
versioned criteria, summary, phase, matching system/planet references, sort and
ownership display filters. Physical and ownership data remain in the shared galaxy
cache instead of being duplicated in this record. The snapshot is replaced when
a valid search starts, updated in batches and after ownership checks, and restored
using local scans only on initialization. Restoring never resumes network work;
incomplete snapshots are labelled accordingly. Unsaved input edits do not replace
the last started search. Clear search stops in-flight work, removes this record,
resets filters/results and leaves collected galaxy knowledge intact. Writes are
ordered and explicitly scoped to their original universe; stale replies cannot
restore cleared results. Storage/load errors are shown beside the search controls.

Galaxy Scout's Map, Search, Systems, Planets and Moons views share one search
snapshot. List views project matching planets into unique systems or associated
moons, or browse all saved data. A slot-filtered moon projection includes only
qualifying free moons. Entering list views uses `GET_GALAXY_SCANS` (local database only);
they do not trigger system API requests or ownership checks. List filtering,
sorting and 50-row pagination run locally. Cached observations read on a view
change also update the shared last-known ownership used by map result filters.
Each list retains its own multi-select security-zone filter (empty selection means
all zones), intersected with text and shared-result filters. System overview uses
the same saved snapshot and shows planets, moons, asteroid contents, ownership
and observation times without additional game requests.
Map and Search have separate tab panels. Search filters sit immediately above
results without a canvas in between; Show on map switches to Map and focuses the
selected system. Returning to Search retains filters, sort, ownership filters and
results, without rerunning the search. Searches and ownership checks may continue
while another view is selected, but never switch views automatically. Map remains
the default on entry from another dashboard tab. Source badges read Known galaxy
on Map, Completes missing data on Search and Saved data on directories/overview.
Their tooltips distinguish catalog/account loading during initialization, targeted
missing-data requests during search, passive learning from gameplay, and local-only
directory/overview reads. Search progress distinguishes saved-data processing from
missing system/moon data loading.

Directories also retain independent type multi-select, arm and a single sector
field accepting one number or an inclusive range such as `35` or `33-35`
(reversed endpoints are normalized, matching Search; numbers are within each arm),
distance origin and min/max distance. Systems filter by star type, planet/moon
count and whether any contents have been recorded, including explicitly empty
sections; systems have no ownership status or ownership filter. The planet-count
filter can use a saved map count if no planet contents are recorded; moon counts
remain unknown until moons are recorded. Planet lists filter size, capacity,
moon count, any selected moon type present and a minimum number of slots on one
known-free moon. These two moon conditions are independent and need not refer to
the same moon. Moon lists filter moon type, size, slots and parent planet type.
Planet/moon lists additionally filter last-known ownership. Owner names and
alliance tags are searched through the shared Filter list text field, without
separate advanced inputs. Type toggles share zone-button sizing, and min/max
values use the same labeled toolbar inputs as the other advanced controls,
without enclosing range boxes. Size, slots and planet/moon counts expose only
minimum thresholds; only distance retains a maximum input. Search likewise
filters planet size by minimum only.
Search results use the same type, zone, ownership and alliance badges and
map/overview actions as directories. Overview opens saved contents and highlights
the selected matching planet without fetching game data. Sort headers are buttons;
wide result tables scroll inside their panel rather than widening the page.
Unknown values never satisfy numeric limits, and unknown ownership is not free.
Incomplete/invalid numeric ranges display an explicit error, not an unfiltered
result. All directory filters are local and never resolve missing data or
ownership over the network. Numeric/special filters live under More filters,
whose active count remains visible when collapsed. Reset list filters clears only
the current list's filters and origin, keeping sort, shared search and Show scope.

The page-world galaxy hook also relays successful same-origin GET responses for
these endpoints to the local cache without issuing additional requests or
requiring diagnostic recording. Pending identical reads share one request.
System responses are parsed once for both galaxy-cache and asteroid-field
consumers. Search, directory and overview rendering group moons by parent once
per system instead of repeatedly scanning the full moon list for each planet.
The 15-minute catalog TTL does not expire physical properties or Galaxy Scout's
known ownership. Destructive per-universe cache clearing is in
**Options > Data > Danger zone**, with a warning in the server-specific
confirmation dialog. It is not a normal server lifecycle operation:
new servers use separate databases. This cache is included in regular JSON backups; galaxy
WebSocket deltas still do not invalidate it.

Public galaxy structure uses a separate `public:galaxy` IndexedDB entry per
universe, not `saveSystem` observations. Its strict schema and maintainer workflow
are documented in [Public galaxy datasets](../data/galaxy/README.md).
`EXPORT_PUBLIC_GALAXY` migrates legacy knowledge and reads only the requested
universe through the IndexedDB server index, then creates a whitelisted local
contribution without HTTP or materializing an all-server backup.
The maintainer CLI and addon downloader share the same manifest validation.
`GET_PUBLIC_GALAXY_STATUS` reads installed/check status; `UPDATE_PUBLIC_GALAXY`
downloads only approved manifest-selected data, with opt-out automatic daily
checks and a manual override with a 30-second limit. Game hubs now use the same
15-minute catalog cache so their physical location can enter public exports.
Installed structure supplements map, lists and static searches but never
creates ownership, observed group times or full game visibility. Sufficiently
described public planet/moon groups can satisfy static cache reads while all
ownership/dynamic reads still require actual observations. No building-slot
values are shared; missing moon-slot filters can resolve through the API only
for systems already fully visible in the game.

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
