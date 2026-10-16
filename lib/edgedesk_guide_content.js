/* ===========================================================================
   EdgeDesk GUIDE — the words. What the introduction says, the tasks a new
   reader can pick, the walkthrough for each one, and the terms explained
   where they appear.

   Data only. The engine that shows it (lib/edgedesk_guide.js) owns the DOM,
   the state and the navigation; nothing in this file runs at load time, so
   tests can require it and check the copy without a browser.

   THE RULES THE COPY KEEPS (README "Honest notes", lib/edgedesk_vocab.js):
     * Research, not picks. Nothing here tells anyone what to bet.
     * An estimate is an estimate. A model number, a confidence score and a
       result are three different things, and no sentence lets one stand in
       for another. High confidence never means a guaranteed result.
     * No edge without a price. Where a fresh, verified market price is
       missing, the copy says EdgeDesk claims no edge and shows no EV.
     * Every walkthrough step points at a control that exists in this build
       (selectors below are the live ones; tools/guide/guide.test.js checks
       each one against app.html and the renderers), and says what to do when
       the data is missing rather than pointing into a dead end.

   Browser: window.EDGuideContent. Node: require (tests).
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDGuideContent = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_guide_content_v1';

  /* ================================================================ INTRO */
  var INTRO = {
    eyebrow: 'Welcome to EdgeDesk',
    title: 'Research, not picks.',
    lede: 'EdgeDesk helps you research a game before you decide anything. It builds its own numbers for each game, puts them beside the prices sportsbooks are offering, and tells you how much to trust the data behind them. The decision is always yours.',
    points: [
      ['Research a game', 'Today’s games in every sport, with the matchup, injuries and EdgeDesk’s own fair line.'],
      ['Understand the numbers', 'What a fair spread, expected value or a confidence score means — and what it doesn’t.'],
      ['Compare prices', 'Where EdgeDesk’s number and the sportsbook’s price disagree, and by how much.'],
      ['Keep score honestly', 'Track what you bet and grade it against the closing line, not just wins and losses.']
    ],
    caution: 'Every number here is an estimate. A high confidence score means the data behind it is solid — not that a result is guaranteed.',
    primary: 'Show me around',
    secondary: 'Explore on my own',
    reopen: 'You can reopen this any time from Help at the top of the screen.',
    chooserTitle: 'What would you like to do?',
    chooserLede: 'Pick one. Each walkthrough is a few short steps on the real screen, and you can skip at any time.',
    toast: 'Help lives here whenever you need it — walkthroughs, and plain-language explanations of every number.',
    legal: 'Research and decision-support tool. EdgeDesk can be wrong. 21+ · Bet responsibly · 1-800-GAMBLER.'
  };

  /* ============================================================= GLOSSARY
     ask    the chip a walkthrough step offers ("What is EV?")
     what   what the number is, in plain words
     use    how a reader might use it
     limits what it cannot tell you
     where  where it appears in this build */
  var GLOSSARY = [
    { id: 'estimate-outcome', group: 'Start here', term: 'Estimates, confidence and results', ask: 'How is an estimate different from a result?',
      short: 'Three different things EdgeDesk keeps apart on purpose.',
      what: 'A model estimate is EdgeDesk’s number — a fair line, a probability, an expected value. Data confidence is how solid the inputs behind that number are. A result is what actually happened in the game. EdgeDesk never lets one stand in for another.',
      use: 'Read them in that order: what does EdgeDesk estimate, how much should I trust the inputs, and later, how did similar calls do over many games (Model performance).',
      limits: 'A good estimate can lose and a bad one can win. High confidence means the inputs were solid, not that the outcome was known. One game, or a short run of games, proves very little either way.',
      where: ['Every research screen', 'More → Model performance'], related: ['confidence', 'data-confidence', 'clv'] },

    { id: 'research-readiness', group: 'Start here', term: 'Research readiness', ask: 'What does readiness mean?',
      aka: 'Model ready · Research available · No research yet · Read: …',
      short: 'Whether EdgeDesk has enough to research a game yet.',
      what: 'Five separate checks: is the game listed, is there enough information for a matchup analysis, does EdgeDesk have a valid projection (model ready), is there a current verified price (market verified), and did anything pass the full check (actionable signal). The line under a game’s Research button shows where it stands; “Read: Investigate” or “Read: Pass” is EdgeDesk’s research read on the matchup.',
      use: 'Start with games that are ready. “No research yet” usually means the model or data for that sport isn’t there yet — not that the game doesn’t matter.',
      limits: 'Ready to research is not ready to bet. A game can be fully researched and still be a PASS at today’s price, and an “Investigate” read is a reason to look closer, not a recommendation.',
      where: ['Research → Today’s Games', 'All games → Details (ⓘ)', 'Football overview'], related: ['decision-classes', 'market-state'] },

    { id: 'decision-classes', group: 'Start here', term: 'BET, LEAN, WATCH, PASS, NO DECISION', ask: 'What do BET, LEAN, WATCH and PASS mean?',
      aka: 'The decision',
      short: 'EdgeDesk’s answer to “does the current price justify action?”',
      what: 'BET: the current verified price clears every decision gate. LEAN: a positive edge, but below EdgeDesk’s threshold — no stake. WATCH: close enough that a realistic change in price or news could change it — don’t bet yet. PASS: the current price doesn’t justify action. NO DECISION: required information, such as a fresh price, is missing.',
      use: 'Treat it as a judgment about the price, not a prediction of who wins. Open the reasoning to see why, and what would change it. PASS is a normal, useful answer.',
      limits: 'The thresholds are conservative defaults that are still being validated against settled results. A BET can lose; the decision is research to weigh, not an instruction.',
      where: ['A game’s research (EdgeDesk decision)', 'Card', 'Player Props'], related: ['edge', 'ev', 'playable-to', 'market-state'] },

    { id: 'fair-line', group: 'Prices', term: 'Fair spread and fair line', ask: 'What is a fair line?',
      aka: 'Model · Model fair · EdgeDesk fair · Fair price · Fair odds',
      short: 'EdgeDesk’s own estimate of where the line should be.',
      what: 'EdgeDesk’s number for a game, built from its model without looking at sportsbook prices. A fair spread of Seattle −1.8 means the model expects Seattle to win by about 1.8 points on average. A fair price is the same idea in odds: the price at which a bet would break even if EdgeDesk’s probability were exactly right.',
      use: 'Put it beside the sportsbook’s line. The gap is where EdgeDesk and the market disagree — a reason to look closer at the matchup, injuries and news.',
      limits: 'It is a model estimate. The market often knows things a model doesn’t — a late injury, weather, a lineup change — and a large gap more often means missing information than a mispriced line.',
      where: ['A game’s research (Model, Model fair)', 'Research → Other → Lines', 'Player Props (Fair)', 'Game details (ⓘ)'], related: ['implied-probability', 'edge', 'estimate-outcome'] },

    { id: 'implied-probability', group: 'Prices', term: 'Implied probability, break-even and no-vig', ask: 'What is implied probability?',
      aka: 'Implied · Break-even · No-vig · Market no-vig',
      short: 'The win chance a price implies.',
      what: 'Every price implies a probability. −110 implies 52.4%; +150 implies 40%. That is also the break-even rate: how often a bet at that price must win just to break even. A sportsbook’s two sides add up to more than 100% because of its margin (the vig); “no-vig” removes that margin to show the market’s own estimate.',
      use: 'Compare it with EdgeDesk’s probability for the same outcome. If EdgeDesk’s is higher than the break-even, the price looks better than fair by EdgeDesk’s estimate — that difference is the edge.',
      limits: 'The no-vig number is the market’s view, not the truth, and removing the vig is itself an estimate. Prices move; one captured an hour ago may be gone.',
      where: ['Player Props (No-vig, Implied, Break-even)', 'A game’s research (Break-even)', 'Portfolio position details'], related: ['fair-line', 'edge', 'ev'] },

    { id: 'edge', group: 'Prices', term: 'Edge (pp)', ask: 'What is edge?',
      short: 'EdgeDesk’s probability minus the price’s break-even.',
      what: 'The difference, in percentage points, between EdgeDesk’s estimated chance a bet wins and the break-even chance at the price on offer. Edge +2.4 pp means EdgeDesk’s estimate is 2.4 points above what the price requires.',
      use: 'A quick way to see how far a price is from EdgeDesk’s estimate. Bigger is more interesting, but check the confidence and the market state beside it.',
      limits: 'It is only as good as the probability behind it. Without a current, verified price there is no real edge to measure, and EdgeDesk won’t claim one. The biggest edges often come from the thinnest data.',
      where: ['Card', 'A game’s research', 'Player Props (Edge filter)'], related: ['ev', 'implied-probability', 'market-state'] },

    { id: 'ev', group: 'Prices', term: 'Expected value (EV)', ask: 'What is EV?',
      aka: 'Calibrated EV · Model-estimated EV · Raw EV',
      short: 'The average return a price would earn if EdgeDesk’s probability were right.',
      what: 'EV estimates the average profit or loss per unit staked at one exact line, price and book, using EdgeDesk’s probability. +3% EV means about +$3 per $100 on average over many similar bets. Calibrated EV uses probabilities checked against past results; model-estimated EV has no calibration yet; raw EV is a diagnostic only.',
      use: 'Compare prices for the same bet, and see whether a price clears EdgeDesk’s bar. The decision always uses the calibrated or model-estimated value, never raw EV.',
      limits: 'EV belongs to one price at one moment. When no fresh, verified price exists, EdgeDesk shows no EV rather than guessing. Positive EV does not mean a bet wins, and it does not guarantee profit.',
      where: ['A game’s research (Price evaluation)', 'Player Props (EV)', 'Card'], related: ['edge', 'calibration', 'market-state'] },

    { id: 'market-state', group: 'Prices', term: 'Market state and verified prices', ask: 'What is market state?',
      aka: 'Live market · Thin · Stale market · No market · Market fault',
      short: 'Whether a real, current sportsbook price exists to compare against.',
      what: 'Market state answers “what prices are actually available?” Live: a current, usable quote. Thin: only one side is priced. Stale: quotes exist but are past the freshness limit. No market: no usable quote. Market fault: the quotes contradict each other.',
      use: 'Only a live market can support a BET. When a price is stale or missing, use EdgeDesk’s fair line as a reference and check your own sportsbook.',
      limits: 'Prices move fast. Even a live quote may have moved by the time you see it — always confirm the price at your book before acting.',
      where: ['A game’s research (Market chip)', 'Player Props status line'], related: ['ev', 'decision-classes'] },

    { id: 'playable-to', group: 'Prices', term: 'Playable to and BET trigger', ask: 'What does “playable to” mean?',
      short: 'The worst price at which a decision still holds — or the price that would make one.',
      what: '“Playable to” is the worst line and price at which EdgeDesk estimates a BET still clears its threshold. The BET trigger is the line or price that would turn a LEAN, WATCH or PASS into a BET, holding the rest of the market where it is.',
      use: 'If your book shows a worse number than “playable to”, the earlier decision no longer applies at your price.',
      limits: 'Both are estimates that move with the market; EdgeDesk re-evaluates when prices change.',
      where: ['A game’s research', 'Card'], related: ['decision-classes', 'ev'] },

    { id: 'confidence', group: 'Confidence and proof', term: 'Decision confidence (0–100)', ask: 'What does confidence measure?',
      aka: 'Confidence · Conf',
      short: 'How solid the whole decision is — not the chance it wins.',
      what: 'A 0–100 score for the complete decision: the model, the market price and the information available (for example, whether starters are confirmed and prices are fresh). For props it is shown as Conf.',
      use: 'Lower confidence means treat the decision more cautiously; it also caps the suggested stake. Filter props by it to focus on better-supported numbers.',
      limits: 'It is not the probability that a bet wins. A 90 can lose and a 40 can win; high confidence means solid inputs, not a guaranteed result.',
      where: ['A game’s decision (Confidence)', 'Player Props (Conf)', 'Card'], related: ['data-confidence', 'estimate-outcome', 'calibration'] },

    { id: 'data-confidence', group: 'Confidence and proof', term: 'Data confidence and reliability', ask: 'What is data confidence?',
      aka: 'Reliability · Data confidence · Confidence (High / Moderate / Low)',
      short: 'How complete and trustworthy the information behind a game’s research is.',
      what: 'Two related measures of the inputs, not the outcome. Confidence on a game’s research summary (high, moderate or low, with a percentage) is information confidence: how much of what EdgeDesk needs it actually has. Reliability (0–100) is how complete and stable the model’s inputs are for that game — enough games played, starters known, sources agreeing.',
      use: 'When it is low, the research is thinner — wait for injury news or treat the numbers as rough.',
      limits: 'It measures the inputs, not whether the prediction is right, and it is not a betting recommendation.',
      where: ['A game’s research summary (Confidence, Reliability)', 'Game decision (Reliability)'], related: ['confidence', 'estimate-outcome'] },

    { id: 'calibration', group: 'Confidence and proof', term: 'Calibrated, partially calibrated, model-estimated', ask: 'What does calibrated mean?',
      aka: 'Probability source · Provisional · Unvalidated model',
      short: 'How well a probability has been checked against real results.',
      what: 'Calibrated: EdgeDesk’s probabilities for this market have been checked against live results and adjusted. Partially calibrated: there is out-of-sample evidence, but less. Model-estimated: no calibration exists yet — it is the model’s raw view.',
      use: 'Give more weight to calibrated numbers. Model-estimated decisions get smaller maximum stakes for exactly this reason.',
      limits: 'Calibration comes from past games; markets and teams change, and a small sample can still mislead.',
      where: ['A game’s research (Probability)', 'Player Props status line', 'Card (Unvalidated model)'], related: ['ev', 'confidence'] },

    { id: 'clv', group: 'Confidence and proof', term: 'Closing line value (CLV)', ask: 'What is CLV?',
      aka: 'Beat the close · Avg CLV · +CLV rate',
      short: 'How the price you got compares with the final price before the game.',
      what: 'The closing line is the market’s last price before the game starts. If you took −2.5 and it closed at −4, you beat the close: you got a better number than the market finally settled on. CLV measures that difference.',
      use: 'Over many bets, consistently beating the close is the best available evidence that a process finds good prices — far better than a short winning or losing run. Portfolio, Process and Model performance grade on it.',
      limits: 'It is measured after the fact and needs a recorded close. It says nothing about whether one bet wins, and it takes a large sample to mean much.',
      where: ['Portfolio → Tracked from EdgeDesk', 'Process', 'More → Model performance'], related: ['estimate-outcome', 'implied-probability'] },

    { id: 'units', group: 'Your bankroll', term: 'Units and bankroll', ask: 'What is a unit?',
      aka: '0.25U · 0.50U · 1.00U',
      short: 'A standard stake size, so decisions compare fairly.',
      what: 'A unit is a standard stake. EdgeDesk defaults 1 unit to 1% of your bankroll; BET decisions are sized from 0.25 to 1.00 units, capped by how well the probability is calibrated.',
      use: 'Set your bankroll and unit in Card → Bankroll & units to see amounts in dollars. Only bet what you can afford to lose.',
      limits: 'Sizes are conservative defaults until each tier has a real settled record. They are not advice about how much you should bet.',
      where: ['Card → Bankroll & units', 'Portfolio'], related: ['decision-classes', 'calibration'] }
  ];
  var GROUPS = ['Start here', 'Prices', 'Confidence and proof', 'Your bankroll'];

  /* the decision layer's own tooltip keys (lib/edgedesk_vocab.js HELP, shown
     by lib/edgedesk_decision_ui.js tip()) → the entry that explains them in
     full. A key not listed keeps its tooltip and opens nothing more. */
  var TIP_KEYS = {
    model_fair: 'fair-line', consensus: 'fair-line', best_current_price: 'market-state', best_price: 'market-state', bet_price: 'market-state',
    cover_probability: 'implied-probability', break_even: 'implied-probability',
    edge: 'edge', calibrated_ev: 'ev', raw_ev: 'ev', model_estimated_ev: 'ev', decision_ev: 'ev',
    market_state: 'market-state', market_quality: 'market-state',
    playable_to: 'playable-to', bet_trigger: 'playable-to',
    decision_confidence: 'confidence', reliability: 'data-confidence', probability_source: 'calibration', validation: 'calibration',
    research_status: 'research-readiness', bet_decision: 'decision-classes',
    unit: 'units', edge_strength: 'units', unit_rule: 'units'
  };

  /* ============================================================== PAGES */
  var PAGE_LABEL = {
    'research:football': 'Research · Football', 'research:pprops': 'Research · Props', 'research:edges': 'Research · Edges',
    'research:lines': 'Research · Lines', 'research:nhl': 'Research · NHL', 'research:nba': 'Research · NBA', 'research:ufc': 'Research · UFC',
    'research:baseball': 'Research · Baseball', 'research:engine': 'Research · Engine', 'research:stats': 'Research · Stats',
    'research:lab': 'Research · Lab', 'research:rdesk': 'Research · Desk',
    games: 'All games', card: 'Card', portfolio: 'Portfolio', process: 'Process', more: 'More', record: 'Model performance',
    settings: 'Settings', setup: 'Setup', terms: 'Terms', faults: 'Faults', news: 'News', collective: 'Collective'
  };
  /* walkthroughs that start on (or are about) a page; research:* covers
     every Research panel, since Today's Games heads all of them */
  var PAGE_TOURS = {
    'research:football': ['game', 'numbers'], 'research:pprops': ['props'], 'research:*': ['game'],
    games: ['game'], card: ['card'], portfolio: ['track'], process: ['track']
  };
  var PAGE_TERMS = {
    'research:football': ['fair-line', 'decision-classes', 'market-state', 'confidence', 'data-confidence', 'research-readiness'],
    'research:pprops': ['fair-line', 'implied-probability', 'ev', 'confidence', 'calibration', 'edge'],
    'research:lines': ['fair-line', 'implied-probability', 'calibration'],
    'research:edges': ['ev', 'edge', 'implied-probability', 'clv'],
    'research:*': ['research-readiness', 'fair-line', 'estimate-outcome'],
    games: ['research-readiness', 'fair-line'],
    card: ['decision-classes', 'edge', 'ev', 'units', 'playable-to', 'calibration'],
    portfolio: ['clv', 'units', 'implied-probability'],
    process: ['clv', 'estimate-outcome'],
    record: ['clv', 'estimate-outcome', 'calibration'],
    '*': ['estimate-outcome', 'fair-line', 'ev', 'clv']
  };

  /* ================================================================ TASKS
     The order the chooser offers them. Every walkthrough is defined below;
     each one is offered only when its screen exists in this build
     (EDGuide checks `needs`). */
  var TASKS = ['game', 'numbers', 'props', 'card', 'track'];

  /* =========================================================== WALKTHROUGHS
     A step:
       target   selector, list of selectors (first visible wins) or a
                function (ctx, $) → element. Resolved again on every frame,
                so a renderer replacing its innerHTML never strands the ring.
       page     the screen the step lives on ('research', 'research:pprops',
                'card' …); used to tell "the data is missing" apart from
                "the reader navigated away".
       go       how to get there: ['research'] · ['research', '<panel>'] ·
                ['view', '<view>'] · a function name on the engine ('openGame')
       wait     ms to wait for the target to appear (loading screens)
       title / body   the words; body may carry <b>, <i>
       adapt    [{ when: RegExp over the target's text | function(target), body }]
                — when the screen shows a known empty or error state, say so
       missing  what to say when the target never appears, and the most
                useful next action
       terms    glossary ids offered as "What is …?" chips
       clickNext  the reader may press the highlighted control themselves;
                the walkthrough follows them to the next step */
  var TOURS = {
    game: {
      id: 'game', title: 'Research a game', line: 'Find today’s games and open EdgeDesk’s research for one.',
      needs: ['#gamesStrip', 'fn:researchGo'],
      next: ['numbers', 'props'],
      steps: [
        { page: 'research', go: ['research'], target: '#gamesStrip', wait: 6000,
          title: 'Today’s games',
          body: 'Every game EdgeDesk lists today, in your time zone. Use the sport chips to narrow it down.',
          adapt: [{ when: function (el) { return !!el.querySelector('.gm-empty.err') && !el.querySelector('.gm-card'); },
            body: 'Today’s schedule didn’t load just now, so there are no games to show — that isn’t a confirmed empty day. Press <b>Try again</b>, or open research from the tabs below.' },
            { when: function (el) { return !!el.querySelector('.gm-empty') && !el.querySelector('.gm-card'); },
              body: 'No games are scheduled today in the sports EdgeDesk lists. <b>View all games</b> shows tomorrow’s slate.' }],
          missing: { body: 'Today’s games aren’t on screen right now. Open <b>Research</b> from the menu and they appear at the top.', action: 'research' } },
        { page: 'research', go: ['research'], target: '#gamesStrip .gm-all',
          title: 'Other days',
          body: '<b>View all games</b> adds yesterday and tomorrow, a date picker, status filters and team search.' },
        { page: 'research', go: ['research'], target: 'gameDetails', wait: 4000,
          title: 'Details first, if you like',
          body: 'The <b>ⓘ</b> button opens a game’s details: start time, EdgeDesk’s fair line where it has one, and five readiness checks. Ready to research is not the same as ready to bet.',
          terms: ['research-readiness', 'fair-line'],
          missing: { body: 'None of the games on screen has a details button right now. When games are listed, each card has one.' } },
        { page: 'research', go: ['research'], target: 'gameResearch', wait: 4000, clickNext: true,
          title: 'Open a game’s research',
          body: 'Tap <b>Research</b> — or press Next and I’ll open this one for you. The small line under it is the game’s readiness: <i>Model ready</i>, <i>Research available</i>, <i>No research yet</i>, or EdgeDesk’s read, such as <i>Read: Investigate</i>.',
          terms: ['research-readiness'],
          missing: { body: 'None of today’s listed games has EdgeDesk research yet. That usually means the model or data for that sport isn’t ready — not that the games don’t matter. <b>View all games</b> shows tomorrow’s slate.', action: 'games' } },
        { page: 'research', go: 'openGame', target: 'openedGame', wait: 9000,
          title: 'The game’s research',
          body: 'At the top is EdgeDesk’s decision for the current price; below it, the evidence — the matchup, availability, and how the model sees the game. Next useful step: learn to read these numbers.',
          adapt: [{ when: function (el) { return !!(el.classList && el.classList.contains('brief-card')); },
            body: 'This game has already started, so EdgeDesk shows the research it stored before kickoff — frozen as it was, so it can be graded honestly afterwards. For a game that hasn’t started, the same research opens live on the board with today’s price.' },
            { when: function (el) { return !(el.closest && el.closest('#v-football')); },
              body: 'This is the game’s research: EdgeDesk’s own fair prices for its markets, the evidence behind them, and the model’s record. Where a sport’s model hasn’t yet been tested against closing prices, EdgeDesk shows its numbers as research and makes no value claim.' }],
          terms: ['decision-classes', 'fair-line'],
          missing: { body: 'This game’s research is still loading or didn’t load. Use the refresh button on the panel, or try another game from <b>Today’s Games</b>.',
            none: { body: 'No game on today’s strip has EdgeDesk research to open right now. <b>View all games</b> shows other days; any game’s <b>Research</b> button opens its research.', action: 'games' } } }
      ]
    },

    numbers: {
      id: 'numbers', title: 'Understand the research numbers', line: 'Read a game’s decision: EdgeDesk’s line, the market’s price, and how far to trust them.',
      needs: ['module:football'],
      next: ['card', 'props'],
      steps: [
        { page: 'research:football', go: 'decisionCard', target: 'card:.edd-verdict', wait: 9000,
          title: 'The decision for today’s price',
          body: 'EdgeDesk’s answer to one question: does the current price justify action? <b>BET</b>, <b>LEAN</b>, <b>WATCH</b>, <b>PASS</b> or <b>NO DECISION</b>. It’s about the price, not a prediction of who wins — and PASS is a normal answer.',
          terms: ['decision-classes'],
          missing: { body: 'No game decision is on screen. The football research may still be loading, or there are no football games on the board right now. Open <b>Research → Football</b>, pick a game, then start this walkthrough again from Help. Every number is also explained in Help’s <b>Terms & numbers</b>.', action: 'glossary' } },
        { page: 'research:football', go: 'decisionCard', target: ['card:.edd-exec', 'card:.edd-f2', 'card:.edd-mini', 'card:.edd-grid', 'card:details.edd-reason > summary'],
          title: 'EdgeDesk’s line vs the market',
          body: '<b>Model</b> (or <i>Model fair</i>) is EdgeDesk’s own fair line, built without looking at sportsbook prices. <b>Consensus</b> is what most books are dealing. The gap is where to look closer — it’s an estimate, and the market often knows things a model doesn’t.',
          terms: ['fair-line', 'implied-probability'] },
        { page: 'research:football', go: 'decisionCard', target: ['card:.edd-layers', 'card:.edd-ms'],
          title: 'Is there a real price?',
          body: 'The market chip says whether a fresh, verified sportsbook price exists. If it’s <b>stale</b> or missing, EdgeDesk shows no expected value and claims no edge — check your own sportsbook before acting on any number.',
          terms: ['market-state', 'ev'] },
        { page: 'research:football', go: 'decisionCard', target: 'card:.edd-levels',
          title: 'Choose how much detail',
          body: '<b>Beginner</b> gives the one-line answer, <b>Research</b> adds the reasoning, <b>Lab</b> shows how it was calculated. Dotted-underlined labels explain themselves — tap one any time.',
          terms: ['confidence', 'calibration'] },
        { page: 'research:football', go: 'decisionCard', target: ['card:details.edd-reason > summary', 'card:.edd-acts'],
          title: 'Why, and what would change it',
          body: '<b>View reasoning</b> shows the prices behind the decision and <b>What changes my mind?</b> — the price, injury or market move that would flip it. <b>View full research</b> opens the matchup evidence.',
          terms: ['playable-to', 'estimate-outcome'] }
      ]
    },

    props: {
      id: 'props', title: 'Explore player props', line: 'Browse NFL and college player props with EdgeDesk’s projections and fair prices.',
      needs: ['module:pprops'],
      next: ['card', 'track'],
      steps: [
        { page: 'research:pprops', go: ['research', 'pprops'], target: '#ppHost .pp-head', wait: 8000,
          title: 'Player props',
          body: 'Pick a league here. Each prop is priced the way a game is: EdgeDesk’s projection, a fair price, the sportsbook’s price, and the expected value at that exact price.',
          terms: ['fair-line'],
          missing: { body: 'The props board hasn’t loaded yet. Give it a moment, or use the refresh button — if it still doesn’t appear, the props data for this week may not be published yet.' } },
        { page: 'research:pprops', go: ['research', 'pprops'], target: '#ppHost .pp-strip',
          title: 'Check the data first',
          body: 'This line shows how current the sportsbook prices and injury report are, and where EdgeDesk’s probabilities come from — <i>model-estimated</i> means not yet calibrated against results. Old prices mean no reliable EV.',
          terms: ['calibration', 'market-state'] },
        { page: 'research:pprops', go: ['research', 'pprops'], target: '#ppHost .pp-modes',
          title: 'Best Value or everything',
          body: '<b>Best Value</b> lists props where a captured price beats EdgeDesk’s fair price. <b>All Props</b> shows every projection, priced or not. <b>My Props</b> holds the ones you save.' },
        { page: 'research:pprops', go: ['research', 'pprops'], target: ['#ppHost .pp-flt', '#ppHost .pp-fbox'],
          title: 'Filter by what matters',
          body: 'Narrow by EV, confidence, edge, sample size and price. Confidence is about the inputs, not the chance a prop hits.',
          terms: ['ev', 'confidence', 'edge'] },
        { page: 'research:pprops', go: ['research', 'pprops'], target: ['#ppHost .pp-main', '#ppHost .pp-body'],
          title: 'Open a prop',
          body: 'Tap any row for the full breakdown: the projection and the distribution behind it, fair odds, the best available price, EV and EdgeDesk’s decision. Hit rates and matchups are context, not probabilities.',
          adapt: [{ when: /not been captured|no prices yet|0 priced/i, body: 'Sportsbook prices haven’t been captured for these games yet, so there is no EV to rank and no edge to claim. Switch to <b>All Props</b> to browse EdgeDesk’s projections and fair prices in the meantime.' }],
          terms: ['implied-probability'] }
      ]
    },

    card: {
      id: 'card', title: 'Read today’s Card', line: 'See which current prices clear EdgeDesk’s bar — and why most don’t.',
      needs: ['#v-card', 'obj:EDDecisionUI'],
      next: ['track', 'numbers'],
      steps: [
        { page: 'card', go: ['view', 'card'], target: ['#eddCardHost .edd-ph', '#eddCardHost .edd-page'], wait: 8000,
          title: 'Today’s Card at a glance',
          body: 'How many current prices qualify as <b>BET</b>, plus <b>Leans</b> and <b>Watching</b>. Expect mostly PASS: the bar is deliberately strict, and its thresholds are conservative defaults still being validated.',
          terms: ['decision-classes'],
          adapt: [{ when: /Loading the latest decisions/i, body: 'The Card is still loading today’s decisions. The counts appear here in a moment.' }],
          missing: { body: 'The Card hasn’t loaded yet. Give it a moment; if it stays empty, the decisions for today may not be built yet.' } },
        { page: 'card', go: ['view', 'card'], target: '#eddCardHost .edc-hero',
          title: 'The top of the card',
          body: 'The most notable decisions right now, each with its price, book, edge and EV. <i>Unvalidated model</i> means treat it as an early estimate.',
          terms: ['edge', 'ev', 'calibration'],
          missing: { body: 'Nothing stands out on the Card right now — that’s a normal day. The full list below still shows every decision and why.' } },
        { page: 'card', go: ['view', 'card'], target: '#eddCardHost .edd-filters',
          title: 'Filter the card',
          body: 'By sport, by decision, or by stake size in units.' },
        { page: 'card', go: ['view', 'card'], target: '#eddCardHost .edd-tools',
          title: 'Make it yours',
          body: '<b>Bankroll &amp; units</b> sets what a unit is worth (1% of bankroll by default). <b>How to read this card</b> is the full explainer. <b>Beginner mode</b> shows the decision first and research on request.',
          terms: ['units'] },
        { page: 'card', go: ['view', 'card'], target: ['#eddCardHost .edd-sec .edc-row', '#eddCardHost .edd-sec .edd-row', '#eddCardHost .edd-sec'],
          title: 'Open a decision',
          body: 'Tap any row for its reasoning, the price it’s playable to, and what would change it.',
          terms: ['playable-to'],
          missing: { body: 'There are no decisions listed yet. When games have prices, each one appears here with its reason.' } }
      ]
    },

    track: {
      id: 'track', title: 'Track your bets', line: 'Record or import what you bet, and see how your prices compare with the close.',
      needs: ['#v-portfolio', 'fn:pfOpen'],
      next: ['card', 'numbers'],
      steps: [
        { page: 'portfolio', go: ['view', 'portfolio'], target: ['#pfoHost .pfo-head', '#pfoHost'], wait: 6000,
          title: 'Add a position',
          body: '<b>+ Add position</b> records a sportsbook bet or a prediction-market position by hand. Nothing syncs automatically yet — EdgeDesk says so rather than pretend.',
          adapt: [{ when: /Sign in to use/i, body: 'Portfolio lives on your EdgeDesk account, and you’re not signed in on this device. Sign in again to use it — tracked prices below still work on this device.' },
            { when: /Could not reach the database/i, body: 'Your portfolio couldn’t load just now. Press <b>Try again</b>; nothing you entered is lost. Tracked prices below are kept on this device.' }],
          missing: { body: 'Portfolio hasn’t loaded yet. Give it a moment, or open <b>Portfolio</b> from the menu.' } },
        { page: 'portfolio', go: ['view', 'portfolio'], target: '#pfoHost .pfo-tabs',
          title: 'Your book, organized',
          body: '<b>Overview</b> answers “am I up or down?”. <b>Import</b> takes a CSV export from your book. <b>History</b> and <b>Analytics</b> break it down by platform, sport and market.' },
        { page: 'portfolio', go: ['view', 'portfolio'], target: ['#pfTracked > summary', '#pfTracked'],
          title: 'Tracked from EdgeDesk',
          body: 'Prices you track from EdgeDesk and bets you place from the Card are graded against the closing line here. Beating the close over many bets is better evidence than a short winning run.',
          terms: ['clv'] },
        { page: '*', go: null, target: '.bottomnav button[data-v="process"]',
          title: 'Then, Process',
          body: '<b>Process</b> grades how you decide — the price you took against the close, your timing and sizing — never whether a bet won. It needs some history before it says anything.',
          terms: ['clv', 'estimate-outcome'] }
      ]
    }
  };

  function glossary(id) { for (var i = 0; i < GLOSSARY.length; i++) if (GLOSSARY[i].id === id) return GLOSSARY[i]; return null; }
  function termForTip(key) { return TIP_KEYS[key] || null; }
  function pageKey(map, page) {
    if (map[page]) return map[page];
    if (/^research:/.test(page) && map['research:*']) return map['research:*'];
    return map['*'] || [];
  }
  function toursFor(page) { return pageKey(PAGE_TOURS, page).slice(); }
  function termsFor(page) { return pageKey(PAGE_TERMS, page).slice(); }
  function pageLabel(page) { return PAGE_LABEL[page] || (/^research:/.test(page) ? 'Research' : 'This page'); }
  function search(q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return GLOSSARY.slice();
    return GLOSSARY.filter(function (g) { return (g.term + ' ' + (g.aka || '') + ' ' + g.short + ' ' + g.what).toLowerCase().indexOf(q) >= 0; });
  }

  return {
    VERSION: VERSION, INTRO: INTRO, GLOSSARY: GLOSSARY, GROUPS: GROUPS, TIP_KEYS: TIP_KEYS,
    PAGE_LABEL: PAGE_LABEL, PAGE_TOURS: PAGE_TOURS, PAGE_TERMS: PAGE_TERMS, TASKS: TASKS, TOURS: TOURS,
    glossary: glossary, termForTip: termForTip, toursFor: toursFor, termsFor: termsFor, pageLabel: pageLabel, search: search
  };
}));
