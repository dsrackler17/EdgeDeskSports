# Useful missing NFL inputs, important first

## P0: Fresh executable bookmaker quotes

Status: No current quotes included.

Fields: Book, event, market, line, period, settlement scope, selection, decimal odds, quote/capture time, availability/limit.

Source/method: Use existing EdgeDesk odds cache or authorized odds provider; no increased paid calls.

Purpose: Required to claim EV or choose a current bet; source spread/total labels are not verified tradable prices.

## P0: Timestamped injury/inactive/QB confirmation history

Status: Weekly injury records included, first publication timestamps missing.

Fields: Report time, status, practice participation, final inactive time, starter confirmation, replacement and snap expectation.

Source/method: Official team/league reports or authorized historical news archive.

Purpose: A season/week injury row is not proof it was known before kickoff.

## P0: Historical source/model availability

Status: Unknown first-publication times and retroactive EPA revisions.

Fields: known_at, revision, model training interval, source model version, original snapshot evidence.

Source/method: Original captured feeds and frozen model releases.

Purpose: Event-lagged research features do not establish strict point-in-time validity.

## P0: Player participation and route opportunities

Status: Targets/carries/snaps included; complete route-by-snap dataset missing.

Fields: play_id, player_id, on-field flag, route run, route type, personnel, position/alignment.

Source/method: Authorized participation/charting source; do not infer routes from targets.

Purpose: Needed for route participation, targets per route, lineups and reliable prop opportunities.

## P0: Canonical player/team identity bridge

Status: GSIS, PFR, ESPN and source identifiers present; full reconciled bridge not built.

Fields: Provider IDs, canonical IDs, effective-date team changes, aliases, duplicate/name collision audits.

Source/method: Roster IDs and verified crosswalk, strict join checks.

Purpose: Never join distinct people solely by name or treat LA/LAR and JAX/JAC as unrelated teams.

## P0: Historical timestamped prices and settlements

Status: Not included.

Fields: Open/decision/close quotes, line movement, actual offered books, stake limits, settlement rules and voids.

Source/method: Authorized historical odds archive and bookmaker rules.

Purpose: No price archive means no certified ROI/CLV backtest.

## P1: Starting OL/DL lineup and blocking matchups

Status: Roster, depth and snaps supplied; full assignment history missing.

Fields: Five starting OL, rotation DL, injuries, projected snaps, pass-protection assignments.

Source/method: Official lineups plus licensed charting.

Purpose: Team sacks/pressure alone do not isolate blocking responsibility.

## P1: Historical forecast weather

Status: PBP observed/context weather may exist; issued forecast archive absent.

Fields: Forecast issued_at, venue, roof status, temperature, wind/gust, precipitation.

Source/method: Authorized historical forecast source and verified venue registry.

Purpose: Later observed weather is not the forecast available when placing a bet.

## P1: Neutral-situation tempo and play selection

Status: Raw drive/clock/state fields present; validated context-adjusted model not built.

Fields: Clock changes, timeouts, kneels/spikes, no-play penalties, neutral filters, score/time state.

Source/method: Own audited reconstruction from PBP.

Purpose: Do not label a naive whole-game clock ratio neutral pace.

## P1: Coverage, blitz, personnel and play-action charting

Status: Game-level PFR pressure measures included; full play-level coverage not supplied.

Fields: Shell/man vs zone, blitz/rushers, personnel, motion, route concept, play action/RPO.

Source/method: Licensed charting or authorized participation feeds.

Purpose: Box-level pressure data does not supply assignments or coverage.

## P1: Replacement-adjusted player impact

Status: Not trained.

Fields: QB/player impact, uncertainty, role/exposure, team strength and replacement scenarios.

Source/method: Own regularized model validated chronologically.

Purpose: Do not turn a player name, depth rank or injury label into an arbitrary point adjustment.

## P1: Current confirmed role/minutes/snaps

Status: Depth snapshots and historical snaps included; future role remains projected.

Fields: Reported depth, confirmed starting role, projected snap/route/carry share, report time.

Source/method: Official current reports plus transparent opportunity model.

Purpose: Historical participation is not a guarantee of next-game usage.

## P2: Raw NFL tracking and pressure timing

Status: NGS public aggregates included; raw tracking is absent.

Fields: Player/ball x-y-time, speed, acceleration, time-to-pressure and receiver defender context.

Source/method: Licensed NFL tracking/provider access.

Purpose: Public NGS averages do not mean all tracking frames are available.

## P2: Detailed officials and scheme tendencies

Status: Not collected as a dedicated audited dataset.

Fields: Referee crew, flags by type/context, coach tendencies, defensive fronts.

Source/method: Authorized official/league and charting sources.

Purpose: Optional after baseline validation; avoid small-sample narrative effects.

