/* ===========================================================================
   EdgeDesk plans — the ONE written map of what is free, what is Full Access
   and what is still being built, and which door serves each.

   lib/edgedesk_pricing.js says what the offer COSTS and lists what Full
   Access includes (FEATURES). This file says what a reader gets WITHOUT
   paying, which server check stands in front of each paid feature, and what
   is planned — so no page can advertise a planned feature as available, and
   no free page can quietly start reading a paid one.

     FREE      live today, no account and no card. Each item names its page
               and the door it reads through: a client-side calculation, a
               static file, or an ANONYMOUS PUBLIC-SUBSET database function.
     FULL      exactly EDPricing.FEATURES, in its order, each with the check
               that enforces it. Read the `gate` honestly: some paid research
               is still committed as static JSON (docs/product-led-growth/
               PLAN.md §2, Phase 2b), and the gate says so.
     PLANNED   in development. Never printed as available; a planned item
               names the UI flag (lib/edgedesk_flags.js) that will switch it on
               once it ships.
     DOORS     every database door the free surfaces call, by who may call
               it: `anon` (public data, granted to anon in supabase/*.sql) or
               `account` (needs a signed-in token; owner rows only). The
               terminal's own doors are not listed — free pages never call them.

   tools/site/free_access.test.js holds this file to the pages and to the SQL.

   Browser: window.EDPlans. Node: require('./edgedesk_plans.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EDPlans = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var X = {};

  /* label: what the landing page's Free column prints, in this order */
  X.FREE = [
    { key: 'articles', label: 'Published research on NFL and college games', href: '/articles/', door: 'static' },
    { key: 'today', label: 'Today’s games, with EdgeDesk’s public read', href: '/today/', door: 'rpc:public_home_board' },
    { key: 'model_vs_market', label: 'A live model-vs-market sample', href: '/tools/model-vs-market/', door: 'rpc:public_home_board' },
    { key: 'no_vig', label: 'No-vig and fair odds calculators', href: '/tools/', door: 'client' },
    { key: 'sample', label: 'A full sample game', href: '/research/sample/', door: 'rpc:public_sample_research' },
    /* the landing page's #model: up to three of the week's editorially featured
       games (already free in the articles), Layer A only, no sportsbook price */
    { key: 'featured_research', label: 'This week’s featured games, researched in full', href: '/', door: 'static' },
    { key: 'record', label: 'The graded public record', href: '/record.html', door: 'view:public_proof_gate' },
    { key: 'newsletter', label: 'The weekly research email', href: '/newsletter/', door: 'function:newsletter' }
  ];

  /* EDPricing.FEATURES, each with what enforces it (held equal by test) */
  X.FULL = [
    { label: 'Model-first NFL and college football research', gate: 'terminal paywall (app.html PAYWALL_LIVE) + game_research_state RLS (edp_entitled); boards and football/game_research also committed as static JSON (Phase 2b)' },
    { label: 'Fair lines, win probabilities and matchup graphics', gate: 'terminal paywall; signals / model_predictions RLS in production paywall.sql (not in this repo); slates also committed as static JSON (Phase 2b)' },
    { label: 'Compare your number with the model', gate: 'terminal paywall + owner-only RLS (research_journal); the game page price check reads committed probability sheets (Phase 2b)' },
    { label: 'Live market comparison and EdgeDesk EV', gate: 'terminal paywall + game_research_state RLS (edp_entitled); CFB EV also committed as static JSON (Phase 2b)' },
    { label: 'Player props', gate: 'terminal paywall; prop boards also committed as static JSON (Phase 2b)' },
    { label: 'Bet journal with CSV and bet slip import', gate: 'terminal paywall + owner-only RLS (research_journal, portfolio)' },
    { label: 'Profit, ROI and closing-line value', gate: 'terminal paywall + owner-only RLS' },
    { label: 'Process Coach and the weekly Film Room', gate: 'terminal paywall + owner-only RLS (portfolio_journal)' }
  ];
  /* not on the price card (it is not a FEATURES line) but paid, and enforced
     on the server: the AI desk refuses an anon token and a non-subscriber */
  X.FULL_SERVER = [
    { label: 'EdgeDesk Intelligence', gate: 'edgedesk_ai subscriptionGate: anon refused, 401/403 refused, 402 without an entitling row' }
  ];

  /* the Process Coach, the Weekly Film Room and the calendar left this list
     when they shipped (CHANGELOG 2026-10-04/05; Portfolio schema deployed
     2026-10-14) */
  X.PLANNED = [
    { key: 'connections', label: 'Sportsbook and exchange account connections' },
    { key: 'free_dashboard', label: 'A weekly dashboard for free accounts', flag: 'free_accounts' },
    { key: 'free_saves', label: 'Saved research on a free account', flag: 'free_saved_research' }
  ];

  X.DOORS = {
    anon: {
      rpc: ['public_home_board', 'public_slate_live', 'public_sample_list', 'public_sample_research', 'acq_track_visit', 'affiliate_track_click', 'affiliate_offer', 'ed_track'],
      /* read-only public views; defined in production (paywall.sql), not in this repo */
      view: ['public_proof_gate', 'public_proof_clv', 'model_calibration', 'model_brier']
    },
    account: {
      rpc: ['acq_claim', 'affiliate_claim', 'my_billing_access'],
      table: ['billing_consents', 'referrals', 'subscriptions'],
      fn: ['create_checkout_session', 'sync_subscription']
    }
  };

  /* is this door callable without an account? */
  X.isAnonDoor = function (kind, name) {
    var a = X.DOORS.anon[kind];
    return !!(a && a.indexOf(name) >= 0);
  };

  return X;
});
