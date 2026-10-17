# Football display lines

**Policy:** `football_half_point_v1`. **Code:** `lib/edgedesk_football_lines.js`
(`window.EDFootballLines` in the browser, `require()` in Node; copied into the
two Edge Functions by their inliners). **Tests:** `tools/football/football_lines.test.js`.

EdgeDesk's NFL and college football projections are shown as football lines,
the way a sportsbook prints them. The model's own numbers are not touched.

## 1. Two kinds of number

| | Raw | Display |
|---|---|---|
| What | the projected margin, total, expected team points and probabilities, exactly as the engine produced them | what a reader sees: `Texas Tech −20.5`, `52.5`, `PK`, `Projected score: Texas Tech 37, Arizona State 16` |
| Used by | every gap, EV, cover probability, grade, calibration, record, decision and research classification | printing only |
| Where | the fields every artifact already had (`home_margin`, `fair_spread`, `total_exact`, `fair_total`, `win_prob` …) | new, separately named fields: `model.display` (game snapshot), `fair_text` + `fair_text_precise` (terminal), `fair_spread_text` + `fair_spread_raw_text`, `total` + `total_raw` (briefs) |

No raw field was removed, renamed or re-rounded.

## 2. The rules

1. **Half points.** A fair spread or total is shown at the nearest 0.5.
   Quarter-point ties go away from zero, so both signs round alike:
   20.25 → 20.5, −20.25 → −20.5, 20.75 → 21.0. The raw number is first read at
   hundredths, the precision every football artifact publishes, so a surface
   holding the full-precision engine value and one holding the published value
   always print the same line.
2. **PK.** A displayed spread of zero is `PK`. Where the raw number still
   leans to a side, the details say so ("Shown as PK; the unrounded
   projection leans Florida by 0.20").
3. **No key-number pull.** Nothing is moved toward 3, 7, 10 or 14. A 6.6
   shows 6.5. A 6.8 shows 7.0, because 7.0 is the nearer half point.
4. **Projected score.** Whole points, each side rounded on its own from the
   raw expected points, labelled **Projected score**. The decimal expected
   points stay in the details. The fair spread and total come from their own
   raw outputs, never from the rounded scores. They can differ from the score
   line by a point, and the details say so.
5. **The gap.** Model versus market is the unrounded projection against the
   sportsbook line. It is shown to 0.1 and computed in integer tenths, exactly as
   `EDCalc.spreadComparison` computes it. A printed gap is therefore always
   the gap the research and decision layers classify. It is never the
   difference of the half-point display, so rounding cannot create, inflate or
   hide an edge. When the two printed lines do not reproduce the printed gap,
   the surface shows: *"Fair lines rounded to nearest half-point;
   differences use unrounded projections."*
6. **Sportsbook numbers as received.** A book line or total is printed
   exactly, at least one decimal: `−7.0`, `−6.5`, `−6.75`. Only the model's
   own number is rounded.

## 3. Key numbers

`keyContext()` adds one short note when the model's line and the market's
line sit on opposite sides of a key margin, or one lands exactly on it.

- **Margins.** 3 and 7 are the primary margins for both leagues. Further
  margins are configured per league in `KEY_MARGINS.additional.nfl` /
  `.cfb`, or per call with `{ additional: [...] }`. None ship by default.
- **Team.** The note speaks for one team and states both lines for that team:
  - normally the team both sides favour;
  - when the favourite flips, the team the model favours.
- **Which value is compared.** The model's position is its displayed
  half-point line, so the note always agrees with the line on screen. The
  market's position is its line as received.

| Model | Market | Note |
|---|---|---|
| Indiana −2.5 | Indiana +3.5 | Model favors Indiana outright; market gives Indiana more than a field goal. |
| Fav −8.0 | Fav −6.5 | Market is below 7; model is above 7. |
| Fav −8.5 | Fav −7 | Market sits on 7; model is above 7. |
| Fav −7.0 (raw −6.8) | Fav −6.5 | Market is below 7; model sits on 7. |
| Fav −7.5 | Fav −2.5 | Market is below 3; model is above 7. |

The note describes where the two lines sit and nothing more. It adjusts no
probability, and it makes no frequency claim. How often games land on 3 or 7
differs between the NFL and college football (the engines' learned margin
distributions say so), and nothing here pretends otherwise.

## 4. Where it is applied

| Surface | File(s) | What prints from the utility |
|---|---|---|
| Game research page | `lib/edgedesk_game_view.js` | overview tiles, the projection rows (display beside the unrounded number and the expected points), the market comparison (gap, key number, rounding note), scenarios, live-board note, share text |
| Game snapshot | `lib/edgedesk_game_snapshot.js` | `model.display`, checked by `display_from_raw`; `compareMarket()` from the raw margin; the beginner's lead |
| Share graphic | `lib/edgedesk_game_graphic.js` | spread, total and score panels; the market strip's gaps, from the raw projection, with a "½-point fair lines · gaps unrounded" note |
| Landing page | `lib/edgedesk_home_model.js` | the three real games' rows |
| Home board | `lib/edgedesk_home.js` | the model's fair line and the whole-number projected score; book lines as received |
| Football board, cards, overview, cockpit | `app.html` (`fbFairDisp`, `fbModelLine`, `fbBookLine`, `fbModelTotal`, `fbGxScore`) | every model spread cell; book lines beside them, as received |
| CFB research view | `lib/cfb_research_view.js` | `fair_line_text`, `comparison_line_text`, `market_gap` rounding and key-number notes (`precise_line_text` keeps the 0.1 line) |
| CFB research terminal | `lib/cfb_terminal.js`, `research/cfb/terminal.js` | `fair_text`, `fair_total_text`, `projected_score.display`, `disagreement.rounding_note` / `key_number`; the Read and EV cards are formatted on the page, so the published Read stays byte-identical |
| Decision cards | `lib/edgedesk_decision_ui.js` (`fairText`) | the MODEL FAIR cell, formatted at render time; the decision record is untouched |
| Briefs → articles, editorial, newsletter, presentation layer | `app.html` `fbBriefGame` / `fbNflBriefGame`, `tools/articles/research_host.js` | `fair_spread_text`, `margin`, `total`, `score` (+ `expected`), market `rounding_note` / `key_number`; raw beside them in `fair_spread_raw_text`, `margin_raw`, `total_raw`, `model_raw`, `total_model_raw` |
| Content engine (AI-drafted weekly content) | `lib/content_engine.js` → `supabase/functions/content_engine/index.ts` | the packet's `model.display`, the copy's fair line, total and whole-number score; the gate accepts the packet's own half-point line and whole numbers, and nothing else |
| Newsletter | `tools/newsletter/compose.js`, `render.js`, `validate.js` | model line, rounding and key-number notes; the half-point line is a declared derived figure |
| Press brief (PDF) | `tools/football/press_brief.js` | model line, total, score; book line as received |
| AI desk | `supabase/functions/edgedesk_ai/_desk.js` (+ the inlined utility) | the packet carries `projection.display`; the deep dive prints the fair line, then the unrounded projection |
| Integrity engine | `lib/edgedesk_integrity.js` | `CALC.GAP_RECONCILES` accepts the half-point fair line only with the raw gap, and requires the rounding note when the printed lines do not reproduce it; `PROJ.SCORES` accepts whole-number scores tagged with the policy |

## 5. What grades and records read

- **Grading.** Editorial grading reads `fair_spread_raw_text` and `total_n`.
  `total_n` is now taken from `total_raw` when a brief carries one.
- **Over/under.** The implied over/under side reads `total_n`, not the
  half-point display.
- **Performance.** `tools/performance/build.js` grades the total from
  `total_raw` when present.
- **Old records.** A record built before this policy carries its raw total in
  `total`, and still grades from it.
- **Ledgers.** No history ledger, record or published article is rewritten.
- **Frozen snapshots.** A started game's frozen snapshot, and any history
  spec, has no `display` block and redraws with the numbers it was published
  with.

## 6. Not yet on the policy

These surfaces still print the model's number at 0.1 or as raw values:

- **Machine exports.** The CSV and XLSX board exports carry only raw numerics
  (column-for-column contract with the Collective uploader). They are left
  raw on purpose.
- **Discord.** `supabase/functions/discord_cron/index.ts` `fmtModelLine`.
- **Other AI modules.** `_board.js`, `_pricing.js`, `_analyst.js`,
  `_stake.js`, `_quant.js` and `_intelligence.js` raw `fmtLine`; `_desk.js` is
  done.
- **Read and EV objects.** `lib/edgedesk_read.js` and `lib/edgedesk_ev.js`
  keep their own `fair_spread.text`, but the page formats both cards.
- **Explain notes.** `lib/edgedesk_explain.js` "market aligned" note quotes
  the decision's own text.
- **Other boards.** The card feed (`lib/edgedesk_card_feed.js`), the
  performance pages (`performance/performance.js`), the linemaker desk and the
  CFB v2 shadow display (which has its own half-point `conv.display`).
