# NHL data sources: authorisation, reconciliation, contribution

> Registry: `hockey/sources/registry.json` (`node hockey/sources/registry.js`;
> `--check`). The game page's list view shows it under **Data sources**.
> Access requests (drafts, not sent): `docs/engine/access-requests/`.

## The rule

A provider is wired only when its terms permit EdgeDesk's use: a
subscription research product that stores data and fits models on it. When
the data needs the provider's permission, the provider is
**AWAITING_PERMISSION**, with a drafted request. Its published methods may
still be re-implemented independently (**METHODOLOGY_ONLY**); none of its
code or data is used. A dataset never earns weight for its size. What it
contributes is its out-of-sample result in the lab, and the same underlying
events counted twice add nothing.

The environment that built this could not reach any provider's site (egress
policy). Each terms summary is therefore the build's reading of the
provider's published terms, marked `verified: false` until the owner
confirms it. **No provider was wired on an unverified permissive reading.**

## Providers (status computed from the pipeline's own artifacts)

| Provider | Status | Use | Cost |
|---|---|---|---|
| sportsdataverse fastRhockey (public mirror of the NHL's feeds) | **OPERATIONAL** | every production input; box scores for reconciliation and props | free |
| NHL web API (api-web.nhle.com) | **OPERATIONAL** in CI | today's start times and states | free |
| Confirmed starters (manual entry with source and time) | **OPERATIONAL** (manual) | replaces the projected starter | free |
| EdgeDesk NHL Data Pack (ESPN, 2024-25) | RESEARCH_COPY | event-by-event second source | delivered |
| The Odds API via the gateway | **AWAITING_AUTHORISATION** | price comparison only (never a model input) | ≈3 credits a call, ≈24 a day at most |
| Licensed closing-price archive | NOT_AVAILABLE | the market test, the only proof of value | depends on source |
| MoneyPuck | METHODOLOGY_ONLY; data AWAITING_PERMISSION | xG feature set informed ours | by agreement |
| Natural Stat Trick | METHODOLOGY_ONLY; data AWAITING_PERMISSION | scoring-chance definitions | by agreement |
| Evolving-Hockey | METHODOLOGY_ONLY; data AWAITING_PERMISSION | RAPM / GAR / xG write-ups | licence |
| HockeyViz | METHODOLOGY_ONLY | score-and-venue adjustment (in our ratings) | subscription |
| Hockey-Reference (Sports Reference) | AWAITING_PERMISSION (low priority) | pre-2010 history only | licence |
| Sportradar (official NHL distributor) | AWAITING_PERMISSION | a licensed feed incl. injuries and lineups | paid |

**The open licensing question.** The production data is the NHL's own,
compiled by an MIT-licensed open-source mirror. NHL.com's terms restrict
commercial use. This was already flagged ("owner review required before paid
use"); `access-requests/nhl-commercial.md` is the drafted enquiry. Until it
is resolved, the warehouse keeps per-player and per-team statistics away from
public readers (`supabase/nhl_warehouse.sql`).

## Two endpoints of one source, reconciled (`hockey/validation/nhl_crosscheck_box.json`)

The models are built on the play-by-play. The box score is the NHL's own
per-game summary from a different endpoint. Every season 2010-11 to 2026-27
was checked, and both values are kept; neither overwrites the other.

| Quantity | Rows | Agree | Bar |
|---|---|---|---|
| Team goals (box vs official final) | 41,358 | 99.995% | 99.5% |
| Team shots on goal | 41,358 | 99.32% | 97% |
| Power-play goals | 41,358 | 98.20% | 97% |
| Penalty minutes (players' PIM; penalties naming no player excluded) | 41,358 | 97.48% | 97% |
| Goalie shots against | 44,308 | 99.49% | 97% |
| Goalie goals against | 44,308 | 99.99% | 99.5% |
| Starting goalie (box vs goalie in net at the first event) | 41,358 | 100% | 99.5% |
| Skater goals | 744,341 | 99.999% | 99.5% |
| Skater assists | 744,341 | 99.999% | 97% |
| Skater shots on goal | 744,341 | 99.96% | 97% |

**What reconciling penalty minutes found.** The raw agreement was 87.6%. The
play-by-play charges a club for a too-many-men bench minor that names no
player; the box score sums players' PIM. On the box score's own definition
the rate is 97.5%. The residual is in misconduct and served-penalty coding,
and it is reported rather than corrected. Penalty minutes are not a model
input.

## What each dataset adds, measured

| Dataset | Role | Out-of-sample evidence |
|---|---|---|
| Play-by-play (shots, xG, strength, score) | production | the GLM beats Elo by 0.0037 log loss (95% −0.0054 to −0.0021) on 7,945 held-out games |
| Goalie box (starters) | goalie scenarios | projected starter GSAx: −0.0004 (−0.0011 to +0.0003); real but below the 0.001 bar |
| Skater box (lineups) | lineup sensitivity, props | projected lineup −0.0003 (not significant); confirmed lineup −0.0010 (−0.0021 to −0.0000), only at warmups |
| Arenas + schedule (travel, time zones, congestion) | shown, not priced | no measurable benefit, individually or together |
| ESPN pack (second source) | verification | its lagged features add nothing beyond the model (`nhl_pack_features.json`) |
| Box score vs play-by-play | integrity | table above |
| Period goals (`hockey/data/game_periods/`) | first-period markets; the period profile | first-period score likelihood +0.0087/game on confirmation |
| Box score (player outcomes) | prop research | all 13 prop markets beat a fair baseline |

## Refresh cadence

| What | Where | When |
|---|---|---|
| Season in progress (play-by-play, team games, lineups, periods, box) | `nhl.yml` build | every 3 hours |
| Three previous seasons' box scores and play-by-play (props) | `nhl.yml` build | cached; re-fetched at most weekly |
| Every season, xG refit, record, lab, props record, reconciliation | `nhl.yml` validate | weekly (Tuesday 10:23 UTC) |
| Source registry, drift monitor | `nhl.yml` build | every 3 hours |
