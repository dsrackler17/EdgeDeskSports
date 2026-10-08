# Publisher-grade article templates and story selection

The templates and the story ranking live in `lib/content_engine.js` (`FORMATS`, `KINDS`,
`discover`, `storyScore`, `storyline`, `sectionsFor`). Every template is
written only from the frozen research packet. The same gate checks every draft, whether it came from the
deterministic writer or from Claude (`validate`, see `RULES.md`). Every export carries the snapshot
it was approved on (`exportCheck`).

## Every template has

| Requirement | How it is met |
|---|---|
| A compelling but factual headline | `seoBrief`: built on a searchable query ("Week 6 predictions", the teams). `no_recommendation` refuses pick, lock and guarantee language. |
| A clear reader value proposition | the standfirst (`standfirstFor`), one sentence on what the reader gets, and always "research, not picks" |
| A strong opening | the `intro` section names the central story first |
| Verified supporting statistics | every number comes from the packet (`numbers_in_evidence`) and belongs to the game it is written about (`numbers_per_game`) |
| Appropriate uncertainty | the `limits` section. Quarterback and injury uncertainty appears only from a sourced report (`qb_claims_sourced`). A dropback split is a measured fact, never a controversy. |
| Natural EdgeDesk attribution | the research credit with the as-of time (`attributionFor`) and the disclaimer, appended by the export, never by the writer |
| Publisher-compatible formatting | Markdown, standalone HTML, Word (.docx) and the email body come from one Markdown source, and all four are read back by `exportCheck` |
| SEO title and description | `seoBrief`: headline, alternatives, slug, meta description of 120–155 characters, keyword, intent, and a demand basis (an estimate unless Search Console shows measured impressions) |
| A correct tracked referral link | every EdgeDesk link is tagged `utm_source=<publisher>&utm_medium=publisher&utm_campaign=ce_<publisher>_<article>`. `EXPORT.REFERRAL` refuses an export without it. |
| Short methodology | `how_to_read` is three or four sentences. The full method stays on EdgeDesk (the attribution link). |

## The eight templates

| Template | `format` | Central story | Sections |
|---|---|---|---|
| College Football Weekly Preview | `cfb_weekly_preview` | the week's strongest storyline (below), with up to five supporting games; the supporting games are kept short | intro, why it matters, how to read, games, upsets, conference, limits, conclusion |
| NFL Weekly Preview | `nfl_weekly_preview` | the same, for the NFL slate | + disagreements, injuries (sourced only) |
| Model vs. Market | `market_discrepancy` | one research-grade disagreement (WORTH RESEARCHING or VERIFIED MAJOR) with a current price. **Never an unverified 7+ gap**: that goes to the internal investigations list. | intro, the gap, why they differ, how to read, the market's case, limits, conclusion |
| Biggest Weekend Storylines | `weekend_storylines` | three to five storylines, each one game and one reason it matters | intro, storylines, how to read, limits, conclusion |
| Individual Game Deep Dive | `game_deep_dive` | one marquee game | intro, the matchup, the numbers, why they differ, what could change, how to read, limits, conclusion |
| Conference Race Analysis | `conference_race` | one conference's race and the games that move it; conference claims are checked against the teams (`conference_claims`) | intro, the race, games, how to read, limits, conclusion |
| Upset Watch | `upset_watch` | underdogs the model gives a real chance (30–46%), framed as "a possible upset is not a bet" | intro, upsets, how to read, limits, conclusion |
| Weekly Model Performance Review | `model_performance_review` | how the model did, from the live-forward record (`PERFORMANCE.md`). It is offered only with 50+ graded games, and the sample label is printed. | intro, the record, where it missed, calibration, how to read, conclusion |

## Story selection: four separate concepts

`storyScore` keeps the four concepts apart and reports each one separately.

| Concept | Measured from | Weight in the story score |
|---|---|---|
| **Editorially interesting** | ranked teams (top 25 / top 10), conference and division games, winning records, how close the projection is | 0.55 |
| **Statistically surprising** | a verified major or research-grade disagreement with a **current** price, a favourite flip, a live underdog | 0.25, multiplied by research reliability ÷ 100: surprise counts only as far as the data can be trusted |
| **Research reliable** | 0.6 × reliability + 0.4 × confidence; −10 for an unresolved, sourced quarterback question | 0.20 |
| **Betting actionable** | the decision class (BET / WATCH / PASS / NO DECISION) | **0: reported beside the score, never scored.** An article is not chosen because a bet exists. |

Rules:

- **The largest gap is never chosen automatically.** A 7+ gap that has not
  cleared the integrity gate is INVESTIGATE. It goes to
  `investigations()`, an internal list for the owner, and never into an article
  as an authoritative prediction.
- **One central storyline.** `storyline()` picks the central game. Supporting
  games are chosen to build the narrative, so a preview is not six repetitive
  summaries.
- **Only publishable games.** A game BLOCKED at the public-brief boundary
  (an unconfirmed kickoff, a future week, a faulted or misjoined market, a gap
  that does not reconcile) is withheld from every article, with the rule that
  withholds it (`snap.cfb.withheld`).
- **Timeliness and search intent.** The opportunity score keeps its seven
  parts. Search demand is labelled an estimate unless it is measured.
