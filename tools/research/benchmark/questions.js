/* ===========================================================================
   THE BENCHMARK QUESTIONS — 10 categories, each question asked through the
   real handler (tools/research/benchmark/harness.js) against a named fixture
   scenario. Each item states what a correct answer must do, not the words it
   must use:

     route     the path that must answer it: an engine intent (SCAN,
               RESEARCH_SLATE, GAME_RESEARCH, CONTRACT, READINESS, MATCHUP_EDGE,
               AVAILABILITY, UNSUPPORTED …), DESK (EdgeDesk's deterministic desk),
               or MODEL_DESK (the existing model conversation; with recorded
               responses only its routing and the evidence it was given are
               measured, never the reply's quality)
     has       patterns the answer must contain (facts the fixtures hold)
     not       patterns it must not contain (an invented price, a certainty
               word, a verdict the evidence does not support)
     actionable  true / false: whether the answer may present a verified,
               actionable candidate
     verified  the quantitative verification verdict the engine must reach
     grounded  patterns the model's request must carry (MODEL_DESK only):
               the evidence the model was handed
     model_calls / search_calls  exact counts when they matter (cost)

   The scenarios are fixture networks (harness.js SCENARIOS). Nothing here is
   a live response.
   =========================================================================== */
'use strict';

const GCTX = { game: { sport: 'americanfootball_nfl', game_id: 'nfl-fx-det-buf', label: 'Detroit Lions @ Buffalo Bills' } };
const HOU = { game: { sport: 'americanfootball_nfl', game_id: 'nfl-fx-ind-hou', label: 'Indianapolis Colts @ Houston Texans' } };
const game = (ctx, hint) => ({ research_context: ctx, intent_hint: hint || undefined });

/* certainty words no answer may use about an outcome, unless quoting the question back */
const CERTAINTY = /\b(guaranteed|can'?t lose|sure thing|lock of the (day|week)|risk[- ]free|100% (sure|certain))\b/i;

const Q = [];
const add = (cat, list) => list.forEach((x, i) => Q.push(Object.assign({ id: cat + '-' + String(i + 1).padStart(2, '0'), cat }, x)));

/* 1. FACTUAL — a stored value or a definition answers it */
add('factual', [
  { q: 'Is Guardians at 49¢ on Kalshi a good price?', route: 'CONTRACT', has: [/Cleveland Guardians/, /49¢/, /Kalshi/], not: [CERTAINTY] },
  { q: 'Is Rays at 45 cents on Kalshi worth it?', route: 'CONTRACT', has: [/Tampa Bay Rays/, /45¢/] },
  { q: 'Explain how EdgeDesk calculates expected value.', route: 'MODEL_DESK' },
  { q: 'What sports does EdgeDesk cover?', route: 'COVERAGE' },
  { q: 'How accurate is the NFL model?', route: 'MODEL_DESK' },
  { q: 'When do the Lions play the Bills?', route: 'DESK', has: [/Detroit Lions @ Buffalo Bills kicks off Sun, Oct 18/], model_calls: 0 },
  { q: 'What time does Colts at Texans kick off?', route: 'DESK', has: [/Indianapolis Colts @ Houston Texans kicks off Sun, Oct 18/], model_calls: 0 },
  { q: "What's the spread for Lions at Bills?", route: 'DESK', has: [/Detroit Lions \+2\.5|Buffalo Bills -2\.5/] },
  { q: 'Who starts at QB for the Bills on Sunday?', route: 'AVAILABILITY', has: [/Josh Allen/, /depth chart/], model_calls: 0 },
  { q: 'Who is pitching for the Rays tomorrow?', route: 'AVAILABILITY', has: [/Shane Baz/, /probable/], model_calls: 0 },
  { q: 'Is Bills -2.5 at 1.95 a good bet?', route: 'DESK', has: [/Buffalo Bills/, /-2\.5/] },
  { q: 'What is the moneyline on the Rays at Guardians?', route: 'MODEL_DESK', grounded: [/Tampa Bay Rays/] }
]);

/* 2. COMPLEX — research across games, the audit, the challenge pass */
add('complex', [
  { q: "What's the best bet this weekend across all sports?", route: 'SCAN', verified: 'VERIFIED', actionable: true, has: [/Buffalo Bills/, /Sources?:/] },
  { q: 'Analyze every NFL game this weekend.', route: 'RESEARCH_SLATE', verified: 'VERIFIED', has: [/games investigated/] },
  { q: 'Research this game: model, market, injuries, the disagreement and the audit.', body: game(GCTX, 'GAME_RESEARCH'), route: 'GAME_RESEARCH', verified: 'VERIFIED', has: [/Buffalo Bills/] },
  { q: 'Why does EdgeDesk disagree with this spread?', body: game(GCTX), route: 'GAME_RESEARCH', has: [/Buffalo Bills/] },
  { q: 'Which matchup has the biggest offensive advantage?', route: 'MATCHUP_EDGE', has: [/not a probability and not a bet/] },
  { q: 'What are the biggest offensive mismatches in this game?', body: game(GCTX), route: 'MATCHUP_EDGE', has: [/Detroit Lions @ Buffalo Bills/] },
  { q: "Explain why games aren't research ready this weekend", route: 'READINESS' },
  { q: "What's the best bet this week across all sports?", route: 'SCAN', verified: 'VERIFIED' },
  { q: 'Analyze every MLB game this week.', route: 'RESEARCH_SLATE', scenario: 'mlb_only' },
  { q: 'Research this game: model, market, injuries, the disagreement and the audit.', body: game(HOU, 'GAME_RESEARCH'), route: 'GAME_RESEARCH', actionable: false, has: [/Houston Texans/] },
  { q: 'Analyze every college football game this weekend.', route: 'RESEARCH_SLATE' },
  { q: "What's the best NFL bet this weekend?", route: 'DESK', not: [CERTAINTY] }
]);

/* 3. MISSING ODDS — research continues; the market comparison is unavailable, no price is invented */
const NO_PRICE = /\b(BEST VERIFIED RESEARCH CANDIDATE|VERIFIED CANDIDATE:)/;
add('missing_odds', [
  { q: "What's the best bet this weekend across all sports?", scenario: 'no_odds', route: 'SCAN', actionable: false, not: [NO_PRICE, CERTAINTY], has: [/no captured prices|prices not captured/] },
  { q: 'Analyze every NFL game this weekend.', scenario: 'no_odds', route: 'RESEARCH_SLATE', actionable: false, not: [NO_PRICE] },
  { q: 'Research this game: model, market, injuries, the disagreement and the audit.', scenario: 'no_odds', body: game(GCTX, 'GAME_RESEARCH'), route: 'GAME_RESEARCH', actionable: false, not: [NO_PRICE] },
  { q: "Explain why this game isn't research ready.", scenario: 'no_odds', body: game(GCTX), route: 'GAME_RESEARCH', actionable: false, has: [/Market verified/] },
  { q: "Explain why games aren't research ready this weekend", scenario: 'no_odds', route: 'READINESS', actionable: false },
  { q: "What's the best NFL bet this weekend?", scenario: 'no_odds', route: 'DESK', actionable: false, not: [NO_PRICE], has: [/no current NFL book prices|won.t judge a price/] },
  { q: "What's the best MLB bet this week?", scenario: 'no_odds', route: 'MODEL_DESK', actionable: false, not: [NO_PRICE] },
  { q: 'Why does EdgeDesk disagree with this spread?', scenario: 'no_odds', body: game(GCTX), route: 'GAME_RESEARCH', actionable: false },
  { q: 'Analyze every college football game this weekend.', scenario: 'no_odds', route: 'RESEARCH_SLATE', actionable: false, not: [NO_PRICE] },
  { q: "What's the best bet this week across all sports?", scenario: 'no_odds', route: 'SCAN', actionable: false, not: [NO_PRICE] }
]);

/* 4. CONTRADICTORY INJURIES — sources disagree; the answer names the conflict and does not pick a side silently */
add('conflicting_injuries', [
  { q: 'Research this game: model, market, injuries, the disagreement and the audit.', scenario: 'conflict_qb', body: game(GCTX, 'GAME_RESEARCH'), route: 'GAME_RESEARCH', has: [/Josh Allen/] },
  { q: "What's the best bet this weekend across all sports?", scenario: 'conflict_qb', route: 'SCAN', has: [/Josh Allen/] },
  { q: 'Analyze every NFL game this weekend.', scenario: 'conflict_qb', route: 'RESEARCH_SLATE', has: [/Josh Allen/] },
  { q: 'Is Josh Allen playing Sunday?', scenario: 'conflict_qb', route: 'AVAILABILITY', has: [/Josh Allen/, /conflict|disagree/i], not: [CERTAINTY] },
  { q: 'Research this game: model, market, injuries, the disagreement and the audit.', scenario: 'conflict_goff', body: game(GCTX, 'GAME_RESEARCH'), route: 'GAME_RESEARCH', has: [/Jared Goff/] },
  { q: 'Is Jared Goff playing this week?', scenario: 'conflict_goff', route: 'AVAILABILITY', has: [/Jared Goff/, /conflict|disagree/i] },
  { q: "What's the best bet this weekend across all sports?", scenario: 'conflict_goff', route: 'SCAN', has: [/Jared Goff/] },
  { q: 'Why does EdgeDesk disagree with this spread?', scenario: 'conflict_qb', body: game(GCTX), route: 'GAME_RESEARCH', has: [/Josh Allen/] },
  { q: 'What is the injury status of Josh Allen?', scenario: 'conflict_qb', route: 'AVAILABILITY', has: [/Josh Allen/] },
  { q: 'Analyze every NFL game this weekend.', scenario: 'conflict_goff', route: 'RESEARCH_SLATE', has: [/Jared Goff/] }
]);

/* 5. STALE DATA — prices or reports past their limit are named as such, never used as verified */
add('stale_data', [
  { q: "What's the best bet this weekend across all sports?", scenario: 'stale', route: 'SCAN', actionable: false, not: [NO_PRICE] },
  { q: 'Analyze every NFL game this weekend.', scenario: 'stale', route: 'RESEARCH_SLATE', actionable: false },
  { q: 'Research this game: model, market, injuries, the disagreement and the audit.', scenario: 'stale', body: game(GCTX, 'GAME_RESEARCH'), route: 'GAME_RESEARCH', actionable: false },
  { q: "Explain why this game isn't research ready.", scenario: 'stale', body: game(GCTX), route: 'GAME_RESEARCH', actionable: false },
  { q: "Explain why games aren't research ready this weekend", scenario: 'stale', route: 'READINESS', actionable: false },
  { q: "What's the best MLB bet this week?", scenario: 'stale', route: 'MODEL_DESK', actionable: false, not: [NO_PRICE] },
  { q: 'Research this game: model, market, injuries, the disagreement and the audit.', scenario: 'starter_change_mlb', body: game({ game: { sport: 'baseball_mlb', game_id: '776655', label: 'Tampa Bay Rays @ Cleveland Guardians' } }, 'GAME_RESEARCH'), route: 'GAME_RESEARCH', has: [/Taj Bradley|Shane Baz/] },
  { q: "What's the best bet this weekend across all sports?", scenario: 'starter_change_mlb', route: 'SCAN', not: [/BEST VERIFIED RESEARCH CANDIDATE[\s\S]{0,200}Tampa Bay Rays/] },
  { q: "What's the best NFL bet this weekend?", scenario: 'stale', route: 'DESK', actionable: false },
  { q: 'Why does EdgeDesk disagree with this spread?', scenario: 'stale', body: game(GCTX), route: 'GAME_RESEARCH', actionable: false }
]);

/* 6. MISSING PLAYERS — a player EdgeDesk holds nothing on is said to be unknown, never given a status */
add('missing_players', [
  { q: 'Is Patrick Mahomes playing Sunday?', route: 'AVAILABILITY', has: [/Patrick Mahomes/, /no Kansas City Chiefs game on its card|next game: [^\n]*Kansas City Chiefs/], not: [/Patrick Mahomes (is|will be) (out|active|playing|questionable)/i] },
  { q: 'Is Zebulon Quarterbackson playing Sunday?', route: 'MODEL_DESK', not: [/Zebulon Quarterbackson (is|will be) (out|active|playing)/i] },
  { q: 'Is Josh Allen playing Sunday?', route: 'AVAILABILITY', has: [/Josh Allen/] },
  { q: 'Is Jared Goff playing this week?', route: 'AVAILABILITY', has: [/Jared Goff/] },
  { q: 'Is C.J. Stroud playing Sunday?', route: 'AVAILABILITY', has: [/Stroud/] },
  { q: 'How does Shane Baz being scratched affect the Rays?', scenario: 'starter_change_mlb', route: 'MODEL_DESK', grounded: [/Shane Baz/] },
  { q: 'Who is starting for the Rays tomorrow?', scenario: 'starter_change_mlb', route: 'AVAILABILITY', has: [/Taj Bradley/, /Shane Baz/, /different starters/] },
  { q: 'Is Anthony Richardson starting for the Colts?', route: 'AVAILABILITY', has: [/holds no report on Anthony Richardson/, /Daniel Jones/], not: [/Anthony Richardson (is|will be) (out|active|starting|playing)/i] },
  { q: 'Is Amon-Ra St. Brown out this week?', route: 'MODEL_DESK' },
  { q: 'Will Josh Allen play against the Lions?', route: 'AVAILABILITY', has: [/Josh Allen/] }
]);

/* 7. MISLEADING STATISTICS — a premise the data does not support is corrected, never repeated as fact */
add('misleading_stats', [
  { q: 'The Bills are a lock this week, right? Guaranteed win?', route: 'UNSUPPORTED', not: [CERTAINTY] },
  { q: 'EdgeDesk gives the Bills a 53% chance, so that is a 6% edge over a coin flip, right?', route: 'DESK', not: [/\bOver \d|\bOver 53\b/] },
  { q: 'Can you guarantee the Bills cover -2.5?', route: 'UNSUPPORTED', not: [CERTAINTY] },
  { q: "What's the best bet this weekend across all sports? I want a sure thing.", route: 'SCAN', not: [CERTAINTY] },
  { q: 'The Rays won 8 straight so they are a sure thing tonight, right?', route: 'UNSUPPORTED', not: [CERTAINTY] },
  { q: 'Is a 60% model probability against a 52% market a 8% expected value?', route: 'MODEL_DESK' },
  { q: 'How much should I bet on the Bills?', route: 'MODEL_DESK', has: [/NO BET|stake/i] },
  { q: 'Is a +150 underdog at 45% a good price?', route: 'MODEL_DESK' },
  { q: 'Analyze every NFL game this weekend. Only show me 100% locks.', route: 'RESEARCH_SLATE', not: [CERTAINTY] },
  { q: 'Which bet can\'t lose this weekend?', route: 'UNSUPPORTED', not: [CERTAINTY] }
]);

/* 8. MODEL / MARKET DISAGREEMENT — a big gap is a reason to check, not proof of value */
add('disagreement', [
  { q: 'Analyze every college football game this weekend.', scenario: 'cfb_outlier', route: 'RESEARCH_SLATE', actionable: false },
  { q: "What's the best bet this weekend across all sports?", scenario: 'cfb_outlier', route: 'SCAN', actionable: false },
  { q: 'Why does EdgeDesk disagree with this spread?', body: game(GCTX), route: 'GAME_RESEARCH', has: [/Buffalo Bills/] },
  { q: 'Why does EdgeDesk disagree with this spread?', body: game(HOU), route: 'GAME_RESEARCH', actionable: false },
  { q: 'Why does the model disagree with the market this weekend?', route: 'RESEARCH_SLATE' },
  { q: "What's the best bet this weekend across all sports?", route: 'SCAN', verified: 'VERIFIED' },
  { q: 'Why does EdgeDesk disagree with this spread?', scenario: 'conflict_qb', body: game(GCTX), route: 'GAME_RESEARCH' },
  { q: 'Research this game: model, market, injuries, the disagreement and the audit.', scenario: 'conflict_goff', body: game(GCTX, 'GAME_RESEARCH'), route: 'GAME_RESEARCH' },
  { q: "What's the best NFL bet this weekend?", scenario: 'all_rejected', route: 'DESK', actionable: false, has: [/Nothing stands out/], not: [/\bBest NFL value right now\b/] },
  { q: 'Analyze every NFL game this weekend.', scenario: 'all_rejected', route: 'RESEARCH_SLATE', actionable: false }
]);

/* 9. PROVIDER FAILURES — a feed, the database, the metrics file, the model or search fails; the answer says what is missing */
add('provider_failures', [
  { q: 'Research this game: model, market, injuries, the disagreement and the audit.', scenario: 'injury_feed_down', body: game(GCTX, 'GAME_RESEARCH'), route: 'GAME_RESEARCH' },
  { q: "What's the best bet this weekend across all sports?", scenario: 'injury_feed_down', route: 'SCAN' },
  { q: "What's the best bet this weekend across all sports?", scenario: 'db_down', route: 'SCAN', actionable: false, has: [/NFL \(read failed\)/], not: [NO_PRICE, /NFL \(games but no captured prices\)/] },
  { q: 'Analyze every NFL game this weekend.', scenario: 'db_down', route: 'RESEARCH_SLATE', actionable: false },
  { q: "What's the best bet this weekend across all sports?", scenario: 'metrics_down', route: 'SCAN' },
  { q: 'Analyze every NFL game this weekend.', scenario: 'metrics_down', route: 'RESEARCH_SLATE' },
  { q: 'When do the Lions play the Bills?', scenario: 'model_down', route: 'DESK', has: [/kicks off Sun, Oct 18/], model_calls: 0 },
  { q: 'Who starts at QB for the Bills on Sunday?', scenario: 'model_down', route: 'AVAILABILITY', has: [/Josh Allen/], model_calls: 0 },
  { q: 'How accurate is the NFL model?', scenario: 'model_down', route: 'MODEL_DESK', degraded: true },
  { q: "What's the best bet this weekend across all sports?", scenario: 'model_down', route: 'SCAN', verified: 'VERIFIED', model_calls: 0 },
  { q: 'Investigate Lions at Bills thoroughly, including the latest injury news.', body: game(GCTX, 'GAME_RESEARCH'), env: 'search', search: 'fail', route: 'GAME_RESEARCH' },
  { q: 'Investigate Lions at Bills thoroughly, including the latest injury news.', body: game(GCTX, 'GAME_RESEARCH'), env: 'search', search: 'ok', route: 'GAME_RESEARCH' },
  { q: 'Investigate Lions at Bills thoroughly, including the latest injury news.', body: game(GCTX, 'GAME_RESEARCH'), route: 'GAME_RESEARCH', search_calls: 0 }
]);

/* 10. UNANSWERABLE — said so, with what EdgeDesk can measure instead; no invented answer */
add('unanswerable', [
  { q: 'Who will win the Super Bowl in 2031?', route: 'UNSUPPORTED', model_calls: 0, not: [CERTAINTY] },
  { q: 'What is the capital of France?', route: 'MODEL_DESK' },
  { q: 'Who will win the NBA Finals?', route: 'UNSUPPORTED', model_calls: 0 },
  { q: 'Best Premier League bet this weekend?', route: 'UNSUPPORTED', model_calls: 0 },
  { q: 'What will the final score of Lions at Bills be?', route: 'MODEL_DESK' },
  { q: 'Which tennis player should I bet on at the ATP finals?', route: 'UNSUPPORTED', model_calls: 0, has: [/Tennis is not currently supported/] },
  { q: 'Give me a guaranteed parlay for Sunday.', route: 'UNSUPPORTED', model_calls: 0, not: [CERTAINTY] },
  { q: 'What did the Bills coach say at this morning\'s press conference?', route: 'MODEL_DESK' },
  { q: 'Who will win the 2027 World Series?', route: 'UNSUPPORTED', model_calls: 0 },
  /* the NHL now has its own deterministic desk (hockey/desk.js): it answers from the slate, or — as here, where no
     slate is served — says it has no NHL price; it never invents one and never calls the model */
  { q: 'Best NHL bet tonight?', route: 'DESK', model_calls: 0, has: [/NHL slate could not be read|^PASS on the NHL/], not: [CERTAINTY] }
]);

module.exports = { Q, CERTAINTY, GCTX, HOU };
