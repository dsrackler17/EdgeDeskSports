# Articles rebuild: audit (5.1), 2026-10-19

Everything below was read from the repository at commit `24d97e75`. The live
database refused this build container (the proxy returns 403 for the Supabase
project), so nothing here is a live traffic number. Where a fact can only be
read from the database, this says so instead of guessing.

## 1. The short version

* **67 articles are published** (37 pregame, 30 postgame), between 2026-09-08
  and 2026-10-19. 578 more records sit unpublished in the store
  (510 `ready`, 36 `draft`, 29 `ready_too_late`, 3 `manual_review`).
* **62 of the 67 were published by a machine with no person in the path.**
  The editorial pipeline (`tools/editorial/run.js`, every 15 minutes plus a
  pg_cron poke every 10) publishes when its checks pass. `auto_publish_pregame`
  and `auto_publish_postgame` are `true`.
* **Every article is about one game.** Pregame pages carry my model's fair
  spread and total, its drivers and a captured market number. Postgame pages
  grade the pregame thesis against the box score. Those are owned numbers, but
  the format is a game preview, which is exactly what an AI overview answers
  without a click.
* **None of them carries the data only I have in a form a reader can't get
  elsewhere:** no weekly card with price taken against the close, no running
  CLV, no "what I got wrong this month", no study write-ups. The CLV record
  exists (`/record.html`, `record/pnl/`, `record/football/`), but no article is
  built on it.
* **No article has a person on it.** The byline is "EdgeDesk Research"; the
  JSON-LD author is an `Organization`. There is no name, photo, bio or
  `Person` anywhere, and no headshot in `assets/`.
* **The voice is third person.** "EdgeDesk prices this game at…" appears 171
  times across the published records; "I" and "my" appear zero times. The only
  "we" is the postgame template ("What We Got Right and What We Learned").
  Rendered pages carry 13 to 67 em dashes each.
* **Traffic per article cannot be ranked by conversions today.** Views are
  recorded (`public_page_view`, entity `article:<slug>`), trials and paid are
  recorded (`growth_customer_facts()`), but the only per-article conversion view
  (`growth_admin_article_funnel`) lists content-engine features, of which none
  are published.

## 2. Published articles

Word counts are the article body only (header, footer and scripts removed).
"Owned data" means numbers my own pipeline produced. Traffic is not in the
repository: the views live in `public.user_events`, which this container
cannot read. The new Article Performance view (section 5.6 of the build)
reads it.

| # | Published | Sport | Type | Words | Em dashes | Title | Owned data on the page |
|---|---|---|---|---:|---:|---|---|
| 1 | 2026-09-08 | CFB | pregame | 2759 | 13 | [Missouri vs. Kansas: EdgeDesk Model Projection, Matchup Analysis an...](/articles/missouri-vs-kansas-2026/) | fair spread/total, drivers, captured market |
| 2 | 2026-09-08 | NFL | pregame | 1552 | 32 | [New England Patriots vs. Seattle Seahawks: EdgeDesk Model Projectio...](/articles/new-england-patriots-vs-seattle-seahawks-2026/) | fair spread/total, drivers, captured market |
| 3 | 2026-09-08 | CFB | pregame | 1261 | 13 | [Norfolk State vs. Virginia: EdgeDesk Model Projection, Matchup Anal...](/articles/norfolk-state-vs-virginia-2026/) | fair spread/total, drivers, captured market |
| 4 | 2026-09-08 | CFB | pregame | 1921 | 13 | [Rutgers vs. Boston College: EdgeDesk Model Projection, Matchup Anal...](/articles/rutgers-vs-boston-college-2026/) | fair spread/total, drivers, captured market |
| 5 | 2026-09-13 | NFL | pregame | 1606 | 36 | [Dallas Cowboys vs. New York Giants: EdgeDesk Model Projection, Matc...](/articles/dallas-cowboys-vs-new-york-giants-2026/) | fair spread/total, drivers, captured market |
| 6 | 2026-09-13 | NFL | pregame | 1597 | 36 | [Green Bay Packers vs. Minnesota Vikings: EdgeDesk Model Projection,...](/articles/green-bay-packers-vs-minnesota-vikings-2026/) | fair spread/total, drivers, captured market |
| 7 | 2026-09-14 | NFL | pregame | 1607 | 36 | [Denver Broncos vs. Kansas City Chiefs: EdgeDesk Model Projection, M...](/articles/denver-broncos-vs-kansas-city-chiefs-2026/) | fair spread/total, drivers, captured market |
| 8 | 2026-09-17 | NFL | pregame | 1685 | 37 | [Detroit Lions vs. Buffalo Bills: EdgeDesk Model Projection, Matchup...](/articles/detroit-lions-vs-buffalo-bills-2026/) | fair spread/total, drivers, captured market |
| 9 | 2026-09-17 | CFB | pregame | 1933 | 13 | [Syracuse vs. Pittsburgh: EdgeDesk Model Projection, Matchup Analysi...](/articles/syracuse-vs-pittsburgh-2026/) | fair spread/total, drivers, captured market |
| 10 | 2026-09-20 | NFL | pregame | 1720 | 36 | [Indianapolis Colts vs. Kansas City Chiefs: EdgeDesk Model Projectio...](/articles/indianapolis-colts-vs-kansas-city-chiefs-2026/) | fair spread/total, drivers, captured market |
| 11 | 2026-09-21 | NFL | pregame | 1705 | 35 | [New York Giants vs. Los Angeles Rams: EdgeDesk Model Projection, Ma...](/articles/new-york-giants-vs-los-angeles-rams-2026/) | fair spread/total, drivers, captured market |
| 12 | 2026-09-24 | NFL | pregame | 1714 | 36 | [Atlanta Falcons vs. Green Bay Packers: EdgeDesk Model Projection, M...](/articles/atlanta-falcons-vs-green-bay-packers-2026/) | fair spread/total, drivers, captured market |
| 13 | 2026-09-24 | CFB | pregame | 1372 | 21 | [Liberty vs. Coastal Carolina: EdgeDesk Model Projection, Matchup An...](/articles/liberty-vs-coastal-carolina-2026/) | fair spread/total, drivers, captured market |
| 14 | 2026-09-25 | CFB | pregame | 1527 | 23 | [Clemson vs. California: EdgeDesk Model Projection, Matchup Analysis...](/articles/clemson-vs-california-2026/) | fair spread/total, drivers, captured market |
| 15 | 2026-09-26 | NFL | pregame | 1673 | 37 | [Houston Texans vs. Indianapolis Colts: EdgeDesk Model Projection, M...](/articles/houston-texans-vs-indianapolis-colts-2026/) | fair spread/total, drivers, captured market |
| 16 | 2026-09-26 | CFB | pregame | 2072 | 13 | [Massachusetts vs. Sacramento State: EdgeDesk Model Projection, Matc...](/articles/massachusetts-vs-sacramento-state-2026/) | fair spread/total, drivers, captured market |
| 17 | 2026-09-26 | CFB | pregame | 1497 | 19 | [Missouri State vs. SMU: EdgeDesk Model Projection, Matchup Analysis...](/articles/missouri-state-vs-smu-2026/) | fair spread/total, drivers, captured market |
| 18 | 2026-09-26 | NFL | pregame | 1658 | 34 | [New England Patriots vs. Jacksonville Jaguars: EdgeDesk Model Proje...](/articles/new-england-patriots-vs-jacksonville-jaguars-2026/) | fair spread/total, drivers, captured market |
| 19 | 2026-09-26 | CFB | pregame | 1605 | 23 | [Oklahoma State vs. West Virginia: EdgeDesk Model Projection, Matchu...](/articles/oklahoma-state-vs-west-virginia-2026/) | fair spread/total, drivers, captured market |
| 20 | 2026-09-27 | NFL | pregame | 1722 | 37 | [Los Angeles Rams vs. Denver Broncos: EdgeDesk Model Projection, Mat...](/articles/los-angeles-rams-vs-denver-broncos-2026/) | fair spread/total, drivers, captured market |
| 21 | 2026-09-28 | NFL | pregame | 1719 | 37 | [Philadelphia Eagles vs. Chicago Bears: EdgeDesk Model Projection, M...](/articles/philadelphia-eagles-vs-chicago-bears-2026/) | fair spread/total, drivers, captured market |
| 22 | 2026-10-01 | NFL | pregame | 1674 | 36 | [Pittsburgh Steelers vs. Cleveland Browns: EdgeDesk Model Projection...](/articles/pittsburgh-steelers-vs-cleveland-browns-2026/) | fair spread/total, drivers, captured market |
| 23 | 2026-10-03 | CFB | pregame | 1574 | 23 | [Indiana vs. Rutgers: EdgeDesk Model Projection, Matchup Analysis an...](/articles/indiana-vs-rutgers-2026/) | fair spread/total, drivers, captured market |
| 24 | 2026-10-04 | NFL | pregame | 1671 | 35 | [Detroit Lions vs. Carolina Panthers: EdgeDesk Model Projection, Mat...](/articles/detroit-lions-vs-carolina-panthers-2026/) | fair spread/total, drivers, captured market |
| 25 | 2026-10-04 | NFL | pregame | 1700 | 35 | [New England Patriots vs. Buffalo Bills: EdgeDesk Model Projection, ...](/articles/new-england-patriots-vs-buffalo-bills-2026/) | fair spread/total, drivers, captured market |
| 26 | 2026-10-05 | NFL | pregame | 1708 | 36 | [Atlanta Falcons vs. New Orleans Saints: EdgeDesk Model Projection, ...](/articles/atlanta-falcons-vs-new-orleans-saints-2026/) | fair spread/total, drivers, captured market |
| 27 | 2026-10-08 | NFL | pregame | 1716 | 36 | [Tampa Bay Buccaneers vs. Dallas Cowboys: EdgeDesk Model Projection,...](/articles/tampa-bay-buccaneers-vs-dallas-cowboys-2026/) | fair spread/total, drivers, captured market |
| 28 | 2026-10-11 | NFL | pregame | 2249 | 38 | [Baltimore Ravens vs. Atlanta Falcons: EdgeDesk Model Projection, Ma...](/articles/baltimore-ravens-vs-atlanta-falcons-2026/) | fair spread/total, drivers, captured market |
| 29 | 2026-10-11 | NFL | pregame | 2251 | 37 | [Chicago Bears vs. Green Bay Packers: EdgeDesk Model Projection, Mat...](/articles/chicago-bears-vs-green-bay-packers-2026/) | fair spread/total, drivers, captured market |
| 30 | 2026-10-11 | NFL | pregame | 2273 | 39 | [San Francisco 49ers vs. Seattle Seahawks: EdgeDesk Model Projection...](/articles/san-francisco-49ers-vs-seattle-seahawks-2026/) | fair spread/total, drivers, captured market |
| 31 | 2026-10-12 | NFL | pregame | 2307 | 39 | [Buffalo Bills vs. Los Angeles Rams: EdgeDesk Model Projection, Matc...](/articles/buffalo-bills-vs-los-angeles-rams-2026/) | fair spread/total, drivers, captured market |
| 32 | 2026-10-15 | NFL | pregame | 2273 | 39 | [Seattle Seahawks vs. Denver Broncos: EdgeDesk Model Projection, Mat...](/articles/seattle-seahawks-vs-denver-broncos-2026/) | fair spread/total, drivers, captured market |
| 33 | 2026-10-17 | CFB | pregame | 2229 | 22 | [Florida State vs. Miami: EdgeDesk Model Projection, Matchup Analysi...](/articles/florida-state-vs-miami-2026/) | fair spread/total, drivers, captured market |
| 34 | 2026-10-17 | NFL | pregame | 2218 | 39 | [Houston Texans vs. Jacksonville Jaguars: EdgeDesk Model Projection,...](/articles/houston-texans-vs-jacksonville-jaguars-2026/) | fair spread/total, drivers, captured market |
| 35 | 2026-10-17 | CFB | pregame | 2259 | 25 | [Kentucky vs. Oklahoma: EdgeDesk Model Projection, Matchup Analysis ...](/articles/kentucky-vs-oklahoma-2026/) | fair spread/total, drivers, captured market |
| 36 | 2026-10-18 | NFL | pregame | 2314 | 39 | [Dallas Cowboys vs. Green Bay Packers: EdgeDesk Model Projection, Ma...](/articles/dallas-cowboys-vs-green-bay-packers-2026/) | fair spread/total, drivers, captured market |
| 37 | 2026-10-18 | NFL | pregame | 2076 | 33 | [New York Jets vs. New England Patriots: EdgeDesk Model Projection, ...](/articles/new-york-jets-vs-new-england-patriots-2026/) | fair spread/total, drivers, captured market |
| 38 | 2026-10-19 | CFB | postgame | 3305 | 27 | [Arkansas Razorbacks vs. Texas A&M Aggies Postgame Analysis: What Ha...](/articles/arkansas-vs-texas-a-and-m-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 39 | 2026-10-19 | NFL | postgame | 4696 | 58 | [Atlanta Falcons vs. Green Bay Packers Postgame Analysis: What Happe...](/articles/atlanta-falcons-vs-green-bay-packers-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 40 | 2026-10-19 | NFL | postgame | 4829 | 64 | [Baltimore Ravens vs. Atlanta Falcons Postgame Analysis: What Happen...](/articles/baltimore-ravens-vs-atlanta-falcons-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 41 | 2026-10-19 | NFL | postgame | 4430 | 57 | [Buffalo Bills vs. Houston Texans Postgame Analysis: What Happened, ...](/articles/buffalo-bills-vs-houston-texans-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 42 | 2026-10-19 | NFL | postgame | 4482 | 58 | [Buffalo Bills vs. Los Angeles Rams Postgame Analysis: What Happened...](/articles/buffalo-bills-vs-los-angeles-rams-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 43 | 2026-10-19 | CFB | postgame | 3252 | 24 | [Clemson Tigers vs. California Golden Bears Postgame Analysis: What ...](/articles/clemson-vs-california-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 44 | 2026-10-19 | NFL | postgame | 4283 | 54 | [Dallas Cowboys vs. Green Bay Packers Postgame Analysis: What Happen...](/articles/dallas-cowboys-vs-green-bay-packers-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 45 | 2026-10-19 | CFB | postgame | 3305 | 25 | [Florida State Seminoles vs. Louisville Cardinals Postgame Analysis:...](/articles/florida-state-vs-louisville-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 46 | 2026-10-19 | CFB | postgame | 3222 | 23 | [Florida State Seminoles vs. Miami Hurricanes Postgame Analysis: Wha...](/articles/florida-state-vs-miami-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 47 | 2026-10-19 | NFL | postgame | 4467 | 58 | [Green Bay Packers vs. Minnesota Vikings Postgame Analysis: What Hap...](/articles/green-bay-packers-vs-minnesota-vikings-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 48 | 2026-10-19 | CFB | postgame | 3355 | 25 | [Hawai'i Rainbow Warriors vs. Arizona State Sun Devils Postgame Anal...](/articles/hawaii-vs-arizona-state-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 49 | 2026-10-19 | CFB | postgame | 3162 | 25 | [Indiana Hoosiers vs. Rutgers Scarlet Knights Postgame Analysis: Wha...](/articles/indiana-vs-rutgers-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 50 | 2026-10-19 | NFL | postgame | 4804 | 57 | [Indianapolis Colts vs. Kansas City Chiefs Postgame Analysis: What H...](/articles/indianapolis-colts-vs-kansas-city-chiefs-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 51 | 2026-10-19 | NFL | postgame | 4529 | 63 | [Los Angeles Rams vs. Denver Broncos Postgame Analysis: What Happene...](/articles/los-angeles-rams-vs-denver-broncos-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 52 | 2026-10-19 | CFB | postgame | 3528 | 27 | [LSU Tigers vs. Kentucky Wildcats Postgame Analysis: What Happened, ...](/articles/lsu-vs-kentucky-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 53 | 2026-10-19 | CFB | postgame | 3311 | 27 | [Miami Hurricanes vs. Clemson Tigers Postgame Analysis: What Happene...](/articles/miami-vs-clemson-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 54 | 2026-10-19 | CFB | postgame | 3040 | 20 | [Miami Hurricanes vs. Wake Forest Demon Deacons Postgame Analysis: W...](/articles/miami-vs-wake-forest-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 55 | 2026-10-19 | CFB | postgame | 3238 | 25 | [Missouri State Bears vs. SMU Mustangs Postgame Analysis: What Happe...](/articles/missouri-state-vs-smu-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 56 | 2026-10-19 | CFB | postgame | 3178 | 24 | [Missouri Tigers vs. Mississippi State Bulldogs Postgame Analysis: W...](/articles/missouri-vs-mississippi-state-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 57 | 2026-10-19 | CFB | postgame | 3488 | 31 | [North Texas Mean Green vs. Tulsa Golden Hurricane Postgame Analysis...](/articles/north-texas-vs-tulsa-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 58 | 2026-10-19 | CFB | postgame | 3555 | 30 | [Oregon Ducks vs. USC Trojans Postgame Analysis: What Happened, What...](/articles/oregon-vs-usc-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 59 | 2026-10-19 | CFB | postgame | 3097 | 24 | [Penn State Nittany Lions vs. Northwestern Wildcats Postgame Analysi...](/articles/penn-state-vs-northwestern-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 60 | 2026-10-19 | NFL | postgame | 4638 | 65 | [Philadelphia Eagles vs. Chicago Bears Postgame Analysis: What Happe...](/articles/philadelphia-eagles-vs-chicago-bears-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 61 | 2026-10-19 | NFL | postgame | 4731 | 64 | [Seattle Seahawks vs. Denver Broncos Postgame Analysis: What Happene...](/articles/seattle-seahawks-vs-denver-broncos-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 62 | 2026-10-19 | CFB | postgame | 3349 | 26 | [Southern Miss Golden Eagles vs. Troy Trojans Postgame Analysis: Wha...](/articles/southern-miss-vs-troy-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 63 | 2026-10-19 | NFL | postgame | 4639 | 59 | [Tampa Bay Buccaneers vs. Dallas Cowboys Postgame Analysis: What Hap...](/articles/tampa-bay-buccaneers-vs-dallas-cowboys-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 64 | 2026-10-19 | CFB | postgame | 3352 | 26 | [Texas Tech Red Raiders vs. Colorado Buffaloes Postgame Analysis: Wh...](/articles/texas-tech-vs-colorado-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 65 | 2026-10-19 | CFB | postgame | 3110 | 21 | [Utah Utes vs. Colorado Buffaloes Postgame Analysis: What Happened, ...](/articles/utah-vs-colorado-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 66 | 2026-10-19 | CFB | postgame | 3071 | 18 | [Washington Huskies vs. USC Trojans Postgame Analysis: What Happened...](/articles/washington-vs-usc-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |
| 67 | 2026-10-19 | CFB | postgame | 3570 | 32 | [Wisconsin Badgers vs. UCLA Bruins Postgame Analysis: What Happened,...](/articles/wisconsin-vs-ucla-2026-postgame-analysis/) | frozen pregame snapshot, thesis audit, result vs process |

Pregame: 37 articles, median 1714 words. Postgame: 30 articles, median 3421 words.

The longest pages are the NFL postgame analyses (4,283 to 4,829 words). They
are also the most generic in shape: a long, careful account of one game that a
search summary can paraphrase.

### Other article-like surfaces

| Surface | State |
|---|---|
| Content engine "EdgeDesk features" (`tools/editorial/feature_model.js`, `edgedesk-features-run.yml`) | Mode `dry_run`; `features/records/` does not exist, so none published. |
| Content engine publisher articles (`/admin/content/`) | Owner-gated in the database; sent to outside publishers, never on this site. |
| Member posts (`/articles/community/`) | Separate table, `noindex`, not in the sitemap. |

## 3. Every job that posts outward

51 of the 112 workflows run on a schedule; 4 of them, plus 5 pg_cron jobs,
lead to content leaving the system. Nothing posts to X, LinkedIn, Reddit,
Bluesky or Threads.

| Job | Where | What it posts | How often (UTC) | Live? | Links to an article? | UTM? |
|---|---|---|---|---|---|---|
| `discord_cron` scorecard | Discord `#clv-results` | Per sport: graded signals, average CLV, beat-the-close %, Brier, from the same query `/record.html` runs | Mon, acts at 10:00 Central (`0,30 15,16 * * 1`) | Reads as live (changelog 10-16 to 10-18); `DISCORD_DRY_RUN` and missing webhooks gate it | No (`/record.html`, `/performance/`) | No |
| `discord_cron` results + slate | Each sport channel and `#clv-results` | Yesterday's finals vs my pregame numbers (misses included), today's lines, open and move, my fair line | Daily 10:00 Central | Same | No (`/performance/`, `/today/`) | No |
| `discord_cron` samples + follow-ups | CFB and NFL channels | Up to two free research samples a slate, then a follow-up with the close and CLV | Every 15 min (`4,19,34,49 * * * *`) | Same | No (`/#pricing`) | No, and a test requires none |
| Newsletter | Email (Resend) | CFB Week Ahead (Mon), NFL Week Ahead (Tue) | Mon/Tue every 20 min, 13:13 to 19:53 | **Off**: `sending_enabled=false`; 0 editions sent, last runs failed `edition_stale` | Yes, to the game's article when published | Yes (`utm_source=newsletter`) |
| Lifecycle email | Email (Resend) | Welcome, day 1, day 3, renewal reminder | Hourly at :17 | **Off by default** (`lifecycle_settings.sending_enabled`) | No | No |
| Outbound prospecting | Email (Resend) | Drafts only on the schedule; sending is an owner button | Every 5 min (drafting) | `automation_enabled=false`, `test_mode=true` | One landing page per prospect | Yes (`utm_source=outbound`) |
| Owner digest (`growth_outbound_digest`) | Owner's email | "N outbound drafts are ready" | Once a morning | Off by default (`digest_enabled=false`) | No (`/admin/growth/`) | No |
| Performance X drafts (`performance.yml`) | A JSON file in the repo | Weekly summary under 280 characters with real numbers, plus three per-game posts | Hourly; one file a week | **Never posted**: `autopost:false`, no X integration | No (`/performance/`) | No |

Two gaps this rebuild has to close:

* **No owner notification for articles.** There is no Discord DM or owner
  channel. `DISCORD_BOT_TOKEN` exists (optional) and is used only to open a
  thread. The only owner notification anywhere is the outbound digest email.
* **Discord and Reddit are not channels.** `acq_classify()` has no `discord`
  or `reddit` source, so a `utm_source=discord` visit is counted as `other` in
  the existing acquisition dashboards. The new per-article view classifies the
  raw `utm_source` itself, so it is right there; the existing dashboards are
  left as they are (see the summary).

## 4. What the rebuild reuses

| Need | Already exists | Used for |
|---|---|---|
| The CLV card | `record/pnl/ledger_2026.json` (price taken, close, `clv_points`, result, units), `record/football/summary.json` (per-week and season CLV, ATS, O/U) | Weekly CLV Report |
| My number vs market | `football/nfl/slate.json` `pricing.rows` (gap, tier), `football/game_research/current.json` drivers (and CFB `unpriced`), CFB Lab checkpoints (`model_market_gap`) | Where My Number Disagrees |
| Opens and closes | `football/pricing/openers_nfl.json`, `football/cfb_lab/ledger/2026/lines.jsonl`, `football/validation/key_numbers.json`, `record/football/{nfl,cfb}_2026.json` `clv_pick` | Line Movement Recap |
| Misses and why | `record/football/*_2026.json` `grade.error`, `articles/data/editorial/audits/*.json`, `memory.json` | What I Got Wrong |
| Studies | `football/cfb_lab/governance/experiments.jsonl`, `football/cfb_validation/maturity.json` | Research Notes |
| Publishing | `tools/articles/build_articles.js` (static pages, sitemap), `article_render.js` (head, chrome, tracking) | The desk pages, one builder |
| Owner auth | `site_article_is_admin()`, `lib/edgedesk_admin_session.js` | The desk admin page |
| Cron | `editorial_cron` pattern: pg_cron, `x-cron-secret` from Vault, workflow_dispatch | `desk_cron` |
| Attribution | `user_events`, `user_event_links`, `user_acquisition`, `growth_customer_facts()`, `subscriptions.referral_code` | Article Performance |

### What does not exist and is not invented

* **"Observed / Estimated / Research" tiers.** My pipeline publishes no such
  label per projection component. What it does publish: the components that
  are *in* the number with their points, CFB's list of factors that are
  *not* priced, and the validation tier of the disagreement itself (NFL spread
  LEAN at 1.5+ points, everything else RESEARCH). The disagreement article
  shows those three and says plainly that per-component labels are not
  published.
* **A "Thursday snapshot."** NFL has open, latest and close
  (`openers_nfl.json`). CFB has checkpoints (OPEN, T72, T48, T24, T12, T6, T2).
  The recap uses open to close.
* **Moneyline CLV.** The ledger grades CLV for spreads and totals only. The
  weekly report prints both moneyline prices and says the pipeline does not
  grade them, rather than computing a number.
* **A single study registry.** The CFB Lab experiment log and the module
  maturity file are the registry today. There is none for NFL, UFC or tennis.
