/* ============================================================================
   THE FIVE DESK GENERATORS — owned data in, a draft in my voice out.

     weekly_clv      my card for the week: number vs close, CLV, record, P&L
     disagreement    where my number sits furthest from the market, and why
     line_movement   the biggest moves from open to close, keys crossed,
                     and whether my side beat the close
     got_wrong       the month's biggest misses and what the audits say
     research_notes  a registered study: status, sample, what it shows and
                     what it does not show yet

   Every number goes through B.n() and every printed fact through B.t(), so
   each one carries the query that produced it (lib/edgedesk_desk.js). A
   generator that cannot find the data it needs throws NotReady with the
   reason; it never fills a gap.

   WHICH CLV. The football model record (record/football/) grades CLV for the
   side my number leaned when it was first recorded, from the market at that
   moment to the close. That is the definition these articles use. The P&L
   ledger's `clv_points` for model rows is NOT used: on 109 of 629 rows it
   pairs the kickoff side with the entry line and carries the opposite sign
   (docs/desk/README.md, "Known data issues"). Units are taken from the
   ledger, because they are computed from the locked price and the result,
   which the record and the ledger agree on.
   ========================================================================== */
'use strict';
const D = require('../../lib/edgedesk_desk.js');

class NotReady extends Error { constructor(m) { super(m); this.notReady = true; } }
const Q = (src, path, extra) => Object.assign({ src, path }, extra || {});
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const LEAGUE = { nfl: 'NFL', cfb: 'CFB' };
const LEAGUE_LONG = { nfl: 'NFL', cfb: 'College football' };
const SITE = D.SITE;
const RECORD_LINK = '[My live CLV record](' + SITE + '/record.html)';
/* The football model record is shown inside the signed-in terminal, so a
   public article links the record FILE itself: every game, as committed, the
   same bytes the numbers were read from. */
const modelRecordLink = (sp) => '[the football model record, every game (the raw file)](' + SITE + '/record/football/' + sp + '_2026.json)';
function slugify(s) { return String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function used(B) {
  const ids = new Set();
  const visit = (q) => { if (q.op) q.args.forEach(visit); else ids.add(q.src); };
  B.numbers.forEach(n => visit(n.query)); B.facts.forEach(f => visit(f.query));
  return Array.from(ids).sort();
}
function finish(B, meta) {
  const body = B.md();
  /* the page tracker records an article by the first 70 characters of its
     slug (lib/edgedesk_public.js), so a desk slug never runs longer */
  if (meta.slug) meta.slug = meta.slug.slice(0, 70).replace(/-+$/, '');
  return Object.assign({
    schema: 'edgedesk_desk_draft_v1', generator_version: D.VERSION,
    body_md: body, numbers: B.numbers, facts: B.facts, sources_used: used(B)
  }, meta);
}

/* The record's sides and lines, written from the HOME team's point of view
   so no line is ever negated to print it. */
function teamOf(B, src, base, side, sp, key) {
  if (side !== 'home' && side !== 'away') throw new Error('teamOf: side ' + side);
  const field = sp === 'nfl' ? side + '_code' : side;
  return B.t(key, Q(src, base.concat([field])));
}
function homeLine(B, src, base, linePath, sp, key) {
  return teamOf(B, src, base, 'home', sp, key + '_team') + ' ' + B.n(key, Q(src, base.concat(linePath)), 'line');
}

/* ========================================================== weekly CLV */
function weeklyClv(S, o) {
  const sp = o.sport, LG = LEAGUE[sp], B = new D.Builder(S);
  if (!LG) throw new NotReady('weekly_clv: sport must be nfl or cfb');
  const rec = 'record_' + sp;
  const wk = ['sports', sp, 'weeks', { find: [['week', '=', o.week]] }];
  const row = B.v(Q('record_summary', wk));
  if (!row) throw new NotReady(LG + ' week ' + o.week + ' is not in the football model record');
  if (!row.graded) throw new NotReady(LG + ' week ' + o.week + ' has no graded games yet');
  if (!row.clv || !row.clv.n) throw new NotReady(LG + ' week ' + o.week + ' has no CLV-graded spreads');
  const W = B.n('week', Q('record_summary', wk.concat(['week'])), 'int');
  const season = B.n('season', Q('record_summary', ['season']), 'int');
  const c = (k, f) => B.n('wk_clv_' + k, Q('record_summary', wk.concat(['clv', k])), f || 'int');

  /* ---- the lead: the week's CLV, before anything else */
  const avg = c('avg', 'pts2'), n = c('n'), beat = c('beat'), flat = c('flat'), lost = c('lost');
  const avgV = row.clv.avg;
  const lead = avgV >= 0
    ? 'My ' + LG + ' Week ' + W + ' spread numbers averaged ' + avg + ' points of closing line value across ' + n + ' graded games.'
    : 'My ' + LG + ' Week ' + W + ' spread numbers lost ' + avg + ' points to the close on average across ' + n + ' graded games.';
  B.p('**' + lead + '** ' + beat + ' beat the close, ' + flat + ' closed where I recorded them, and ' + lost + ' lost ground.');

  const a = (k) => B.n('wk_ats_' + k, Q('record_summary', wk.concat(['ats', k])), 'int');
  const u = (k) => B.n('wk_ou_' + k, Q('record_summary', wk.concat(['ou', k])), 'int');
  const atsLine = a('w') + '-' + a('l') + (row.ats.p ? '-' + a('p') : '');
  const ouLine = u('w') + '-' + u('l') + (row.ou.p ? '-' + u('p') : '');
  const be = row.ats.pct != null ? B.v(Q('record_summary', ['sports', sp, 'break_even_pct'])) : null;
  B.p('The results did not have to follow, and this week they '
    + (row.ats.pct != null && be != null && row.ats.pct < be ? 'did not' : 'did')
    + '. Against the spread my side went ' + atsLine + '. On totals it went ' + ouLine + '.'
    + (row.ats.pct != null && be != null && row.ats.pct < be ? ' That is a losing week, and it stays on the record exactly as it happened.' : ''));

  const pending = B.v({ op: 'sub', args: [Q('record_summary', wk.concat(['recorded'])), Q('record_summary', wk.concat(['graded']))] });
  if (pending > 0) {
    B.p(B.n('wk_pending', { op: 'sub', args: [Q('record_summary', wk.concat(['recorded'])), Q('record_summary', wk.concat(['graded']))] }, 'int')
      + ' of my Week ' + W + ' games ' + (pending === 1 ? 'is' : 'are') + ' not graded yet, so ' + (pending === 1 ? 'it is' : 'they are') + ' not in any number here.');
  }

  /* ---- the season, from the same record */
  const se = (k, f) => B.n('season_clv_' + k, Q('record_summary', ['sports', sp, 'clv', 'spread_entry', k]), f || 'int');
  const sa = (k, f) => B.n('season_ats_' + k, Q('record_summary', ['sports', sp, 'ats', 'all', k]), f || 'int');
  const sAts = B.v(Q('record_summary', ['sports', sp, 'ats', 'all']));
  const seasonLine = 'Season to date, my ' + LG + ' spread numbers average ' + se('avg', 'pts2') + ' points of CLV across ' + se('n')
    + ' graded games, and ' + se('beat') + ' of them beat the close (' + se('beat_pct', 'pct1') + ').';
  const atsSeason = 'Against the spread I am ' + sa('w') + '-' + sa('l') + (sAts.p ? '-' + sa('p') : '') + ' (' + sa('pct', 'pct1')
    + '). Break-even at standard juice is ' + B.n('break_even', Q('record_summary', ['sports', sp, 'break_even_pct']), 'pct1') + '.';
  B.h('The season so far');
  B.p(seasonLine + ' ' + atsSeason);
  B.p('Closing line value is the test I hold my numbers to, because it is graded before the game is played. It is evidence, not proof of an edge, and one season is not enough to call it one.');

  /* ---- table A: my number against the close */
  const games = B.v(Q(rec, ['games', { filter: [['week', '=', o.week], ['grade.status', '=', 'GRADED']] }]))
    .sort((x, y) => String(x.kickoff).localeCompare(String(y.kickoff)) || String(x.game_id).localeCompare(String(y.game_id)));
  const rowsA = [], negatives = [];
  games.forEach(g => {
    const base = ['games', g.game_id], id = g.game_id;
    ['spread', 'total'].forEach(mkt => {
      const ce = g.grade.clv_entry && g.grade.clv_entry[mkt];
      if (!ce || ce.pts == null) return;
      const ceP = ['grade', 'clv_entry', mkt];
      const game = teamOf(B, rec, base, 'away', sp, 'a_' + id) + ' @ ' + teamOf(B, rec, base, 'home', sp, 'h_' + id);
      let mine, then, close, leaned;
      if (mkt === 'spread') {
        mine = homeLine(B, rec, base, ['first', 'home_line'], sp, 'first_' + id);
        then = homeLine(B, rec, base, ceP.concat(['market']), sp, 'entry_mkt_' + id);
        close = homeLine(B, rec, base, ceP.concat(['close']), sp, 'entry_close_' + id);
        leaned = teamOf(B, rec, base, ce.side, sp, 'lean_' + id);
      } else {
        mine = B.n('first_total_' + id, Q(rec, base.concat(['first', 'total'])), 'num2');
        then = B.n('entry_total_' + id, Q(rec, base.concat(ceP).concat(['market'])), 'num2');
        close = B.n('close_total_' + id, Q(rec, base.concat(ceP).concat(['close'])), 'num2');
        leaned = cap(B.t('lean_total_' + id, Q(rec, base.concat(ceP).concat(['side']))));
      }
      const pts = B.n('clv_' + mkt + '_' + id, Q(rec, base.concat(ceP).concat(['pts'])), 'pts');
      rowsA.push([game, cap(mkt), mine, then, close, leaned, pts]);
      if (ce.pts < 0) negatives.push({ pts: ce.pts, text: game + ' ' + mkt + ': I leaned ' + leaned + ' against ' + then + ', and it closed ' + close + ' (' + pts + ').' });
    });
  });
  B.h('My number against the close');
  B.p('Every ' + LG + ' Week ' + W + ' number I recorded, the market at the moment I recorded it, and where that market closed. Lines are the home team’s. CLV is in points: positive means the market moved toward the side I leaned.');
  B.table(['Game', 'Market', 'My first number', 'Market then', 'Close', 'I leaned', 'CLV'], rowsA);

  /* ---- what went wrong this week */
  if (negatives.length) {
    B.h('Where the close went against me');
    B.ul(negatives.sort((x, y) => x.pts - y.pts).slice(0, 4).map(x => x.text));
  }
  const flipQ = (m) => Q(rec, ['games', { filter: [['week', '=', o.week], ['grade.status', '=', 'GRADED'], ['grade.clv_entry.' + m + '.side', 'notnull'],
    ['grade.clv_entry.' + m + '.side', '!=', { field: 'grade.' + m + '.side' }]] }], { agg: { fn: 'count' } });
  const flips = ['spread', 'total'].filter(m => B.v(flipQ(m)) > 0).map(m => B.n('wk_flips_' + m, flipQ(m), 'int') + ' ' + m + (B.v(flipQ(m)) === 1 ? '' : 's'));
  if (flips.length) {
    B.p('My number crossed the market between my first number and kickoff on ' + flips.join(' and ') + ', so the side I leaned early is not the side I was graded on at kickoff. The CLV above is for the early side; the results below are for the kickoff side. Both are on the record.');
  }

  /* ---- table B: the verified P&L at the price I locked */
  const L = 'pnl_ledger';
  const verifiedConds = [['league', '=', LG], ['source', '=', 'model_record'], ['week', '=', o.week], ['record_state', '=', 'VERIFIED']];
  const ledgerRows = B.v(Q(L, ['rows', { filter: verifiedConds }]))
    .sort((x, y) => String(x.game_date).localeCompare(String(y.game_date)) || String(x.recommendation_id).localeCompare(String(y.recommendation_id)));
  const highlights = [seasonLine];
  if (ledgerRows.length) {
    const rowsB = [];
    ledgerRows.forEach(r => {
      const rid = r.recommendation_id, gid = r.event_id, rb = ['rows', { find: [['recommendation_id', '=', rid]] }];
      const gb = ['games', gid], lock = ['pick', 'price_lock', r.market_type];
      const game = B.t('ev_' + rid, Q(L, rb.concat(['event_label'])));
      let side, line, close;
      if (r.market_type === 'spread') {
        side = teamOf(B, rec, gb, r.side, sp, 'pside_' + rid);
        line = homeLine(B, rec, gb, lock.concat(['home_line']), sp, 'plock_' + rid);
        close = homeLine(B, rec, gb, ['close', 'home_line'], sp, 'pclose_' + rid);
      } else if (r.market_type === 'total') {
        side = cap(B.t('pside_' + rid, Q(L, rb.concat(['side']))));
        line = B.n('plock_' + rid, Q(rec, gb.concat(lock).concat(['total'])), 'num2');
        close = B.n('pclose_' + rid, Q(rec, gb.concat(['close', 'total'])), 'num2');
      } else {
        side = teamOf(B, rec, gb, r.side, sp, 'pside_' + rid);
        line = 'Moneyline';
        close = B.n('pclose_' + rid, Q(rec, gb.concat(['close', 'prices', r.side + '_ml'])), 'odds');
      }
      const book = r.entry_book_name ? B.t('pbook_' + rid, Q(L, rb.concat(['entry_book_name']))) : B.t('pbook_' + rid, Q(L, rb.concat(['entry_book'])));
      rowsB.push([game, cap(r.market_type), side, line, B.n('pprice_' + rid, Q(L, rb.concat(['entry_odds'])), 'odds') + ' (' + book + ')', close,
        cap(B.t('pres_' + rid, Q(L, rb.concat(['result'])))), B.n('punits_' + rid, Q(L, rb.concat(['profit_units'])), 'units')]);
    });
    const cnt = (res) => B.n('wk_pnl_' + res, Q(L, ['rows', { filter: verifiedConds.concat([['result', '=', res]]) }], { agg: { fn: 'count' } }), 'int');
    const wins = cnt('win'), losses = cnt('loss');
    const pushes = B.v(Q(L, ['rows', { filter: verifiedConds.concat([['result', '=', 'push']]) }], { agg: { fn: 'count' } }));
    const net = B.n('wk_pnl_units', Q(L, ['rows', { filter: verifiedConds }], { agg: { fn: 'sum', field: 'profit_units' } }), 'units');
    B.h('At the price I locked');
    const pnlLine = 'At the prices I locked before kickoff, my ' + LG + ' Week ' + W + ' numbers went ' + wins + '-' + losses
      + (pushes ? '-' + B.n('wk_pnl_push', Q(L, ['rows', { filter: verifiedConds.concat([['result', '=', 'push']]) }], { agg: { fn: 'count' } }), 'int') : '')
      + ' for ' + net + ' at one unit each.';
    B.p(pnlLine + ' A row is here only when my pipeline stored a real price at or before the moment it published the number. Results are graded at the closing line, the way the model record grades them.');
    B.table(['Game', 'Market', 'My side', 'Line locked', 'Price (book)', 'Close', 'Result', 'Units'], rowsB);
    const sv = (k, f) => B.n('season_pnl_' + k, Q('pnl_summary', ['views', sp, 'flat', 'summary', k]), f);
    if (B.v(Q('pnl_summary', ['views', sp, 'flat', 'summary', 'n']))) {
      B.p('Season to date at locked prices: ' + sv('record', 'text') + ' for ' + sv('net_units', 'units') + ', a return of ' + sv('roi_pct', 'pct1') + ' on ' + sv('risked_units', 'num2') + ' units risked.');
      highlights.push('At locked prices my ' + LG + ' game numbers are ' + sv('record', 'text') + ' this season for ' + sv('net_units', 'units') + '.');
    }
    highlights.unshift(pnlLine);
  }
  highlights.splice(1, 0, 'Against the spread my side went ' + atsLine + ' this week.');

  /* ---- prop bets, when there were any */
  const propConds = [['league', '=', LG], ['source', '=', 'player_props'], ['rec_class', '=', 'BET'], ['week', '=', o.week], ['record_state', '=', 'VERIFIED']];
  const props = B.v(Q(L, ['rows', { filter: propConds }], { agg: { fn: 'count' } }));
  if (props > 0) {
    const pc = (res) => B.n('props_' + res, Q(L, ['rows', { filter: propConds.concat([['result', '=', res]]) }], { agg: { fn: 'count' } }), 'int');
    B.h('Prop bets');
    B.p('I placed ' + B.n('props_n', Q(L, ['rows', { filter: propConds }], { agg: { fn: 'count' } }), 'int') + ' ' + LG + ' prop bets in Week ' + W + ' at verified prices. They went '
      + pc('win') + '-' + pc('loss') + ' for ' + B.n('props_units', Q(L, ['rows', { filter: propConds }], { agg: { fn: 'sum', field: 'profit_units' } }), 'units')
      + ' at the stakes I recorded. Their line CLV averaged ' + B.n('props_clv', Q(L, ['rows', { filter: propConds.concat([['clv_points', 'notnull']]) }], { agg: { fn: 'avg', field: 'clv_points' } }), 'pts2') + ' points.');
  }

  /* ---- how it is graded */
  B.h('How this is graded');
  B.ul([
    'My number is the projection my ' + LG + ' model published before kickoff (' + B.t('src_projection', Q('record_summary', ['sources', sp, 'projection'])) + '). Only numbers published before kickoff are recorded.',
    'The market is ' + B.t('src_market', Q('record_summary', ['sources', sp, 'market'])) + '. The close is ' + B.t('src_close', Q('record_summary', ['sources', sp, 'close'])) + '.',
    'CLV is the distance the market moved toward the side I leaned, from the quote recorded with my number to the close, from the same source. Nothing is estimated: no close, no grade.',
    'Moneylines carry no CLV grade in my pipeline. Their prices are shown and nothing is computed from them.',
    RECORD_LINK + ' and ' + modelRecordLink(sp) + ' carry every row behind this page.'
  ]);

  return finish(B, {
    type: 'weekly_clv', sport: LG, season: Number(season), week: o.week, period: season + '-w' + String(o.week).padStart(2, '0'),
    article_key: 'weekly_clv:' + sp + ':' + season + ':w' + String(o.week).padStart(2, '0'),
    slug: sp + '-week-' + o.week + '-' + season + '-clv-report',
    title: LG + ' Week ' + W + ' CLV report: ' + avg + ' points against the close, ' + atsLine + ' against the spread',
    description: 'My ' + LG + ' Week ' + W + ' numbers against the closing line: ' + avg + ' points of CLV on ' + n + ' spreads, ' + atsLine + ' against the spread, every result shown.',
    lead: lead, highlights: highlights.slice(0, 3),
    reddit_title: 'I grade every number I publish against the close. ' + LG + ' Week ' + W + ': ' + avg + ' points of CLV, ' + atsLine + ' ATS.',
    record_link: SITE + '/record.html'
  });
}

/* ======================================================= disagreement */
const TIER_TEXT = {
  LEAN: 'my graded history at gaps this size cleared break-even, which is not the same as a profit',
  RESEARCH: 'my graded history does not back gaps in this market yet, so this is a question, not a position'
};
function disagreement(S, o) {
  if (o.sport !== 'nfl') throw new NotReady('disagreement: only the NFL slate publishes a model-vs-market gap; the CFB slate does not join a market ("NOT JOINED IN THIS BUILD")');
  const B = new D.Builder(S), sp = 'nfl';
  const season = B.n('season', Q('nfl_slate', ['season']), 'int');
  const weekGames = B.v(Q('nfl_slate', ['games', { filter: [['week', '=', o.week]] }])) || [];
  if (!weekGames.length) throw new NotReady('NFL week ' + o.week + ' is not on the slate');
  const nowMs = Date.parse(o.now || new Date().toISOString());
  const ids = new Set(weekGames.filter(g => !(Date.parse(g.kickoff) <= nowMs)).map(g => g.game_id));
  const rows = (B.v(Q('nfl_slate', ['pricing', 'rows'])) || [])
    .filter(r => ids.has(r.game_id) && r.edge_pp > 0 && r.gap_points != null)
    .sort((x, y) => y.gap_points - x.gap_points || String(x.game_id).localeCompare(String(y.game_id)))
    .slice(0, o.limit || 5);
  if (!rows.length) throw new NotReady('NFL week ' + o.week + ': no upcoming game has a model-vs-market row');
  const W = B.n('week', Q('nfl_slate', ['games', { find: [['game_id', '=', rows[0].game_id]] }, 'week']), 'int');
  const rq = (r) => ['pricing', 'rows', { find: [['game_id', '=', r.game_id], ['side', '=', r.side]] }];

  const top = rows[0], tq = rq(top);
  const topSel = B.t('top_sel', Q('nfl_slate', tq.concat(['selection'])));
  const topGap = B.n('top_gap', Q('nfl_slate', tq.concat(['gap_points'])), 'num1');
  const lead = 'My biggest NFL Week ' + W + ' disagreement is ' + topGap + ' points: I have the ' + topSel + ' at '
    + B.n('top_model', Q('nfl_slate', tq.concat(['model_line'])), 'line') + ', and the market has them at '
    + B.n('top_market', Q('nfl_slate', tq.concat(['market_line'])), 'line') + '.';
  B.p('**' + lead + '**');
  B.p('Below are the games where my number sits furthest from the market this week. For each one: what is in my number, what is not, and how much weight my record says a gap like it can carry. None of this is a bet. It is where I am looking hardest, and the record at the bottom says how much these gaps have been worth so far.');
  B.note('The market number is the ' + B.t('market_source', Q('nfl_slate', tq.concat(['market_source']))) + '. My lines are for the side named.');

  const highlights = [];
  rows.forEach((r, i) => {
    const q = rq(r), gid = r.game_id;
    const away = B.t('away_' + gid, Q('nfl_slate', q.concat(['away']))), home = B.t('home_' + gid, Q('nfl_slate', q.concat(['home'])));
    const sel = B.t('sel_' + gid, Q('nfl_slate', q.concat(['selection'])));
    B.h(away + ' at ' + home);
    const gap = B.n('gap_' + gid, Q('nfl_slate', q.concat(['gap_points'])), 'num1');
    const line = 'I have the ' + sel + ' at ' + B.n('model_' + gid, Q('nfl_slate', q.concat(['model_line'])), 'line') + '. The market has them at '
      + B.n('market_' + gid, Q('nfl_slate', q.concat(['market_line'])), 'line') + '. That is ' + gap + ' points apart.';
    B.p(line + ' Kickoff ' + B.n('kick_' + gid, Q('nfl_slate', q.concat(['kickoff'])), 'date') + '.');
    if (i > 0 && highlights.length < 2) highlights.push(away + ' at ' + home + ': my number is ' + gap + ' points off the market.');

    const gr = ['games', { find: [['league', '=', 'nfl'], ['game_id', '=', gid]] }];
    const drivers = B.v(Q('game_research', gr.concat(['drivers', 'rows'])));
    if (drivers && drivers.length) {
      B.h3('What is in my number');
      B.table(['Component', 'Points', 'Favors'], drivers.map((d, j) => [
        B.t('drv_' + gid + '_' + j, Q('game_research', gr.concat(['drivers', 'rows', j, 'label']))),
        B.n('drvp_' + gid + '_' + j, Q('game_research', gr.concat(['drivers', 'rows', j, 'points'])), 'num2'),
        B.t('drvf_' + gid + '_' + j, Q('game_research', gr.concat(['drivers', 'rows', j, 'favors_team'])))
      ]));
      if (B.v(Q('game_research', gr.concat(['drivers', 'reconciles']))) === false) {
        B.p('These are the largest terms in my number, not all of them, so they do not add up to my line on their own.');
      }
    } else {
      B.p('My research snapshot for this game carries no component breakdown, so I am not listing one.');
    }
    const unpriced = B.v(Q('game_research', gr.concat(['drivers', 'unpriced'])));
    B.h3('What is not in my number');
    if (unpriced && unpriced.length) B.ul(unpriced.map((u, j) => B.t('unp_' + gid + '_' + j, Q('game_research', gr.concat(['drivers', 'unpriced', j])))));
    else B.p('My NFL model does not publish a list of what it leaves out, so I cannot tell you which of those the market is pricing and I am not.');

    const g = ['games', { find: [['game_id', '=', gid]] }];
    const rng = B.v(Q('nfl_slate', g.concat(['outcome_range'])));
    const bits = [];
    if (rng && rng.p10 != null && rng.p90 != null) {
      bits.push('Four in five of my modelled outcomes for the ' + B.t('rng_home_' + gid, Q('nfl_slate', g.concat(['home_team']))) + ' margin fall between '
        + B.n('p10_' + gid, Q('nfl_slate', g.concat(['outcome_range', 'p10'])), 'int') + ' and '
        + B.n('p90_' + gid, Q('nfl_slate', g.concat(['outcome_range', 'p90'])), 'int') + ' points. One game can land anywhere in that range, whoever is right about the line.');
    }
    const conf = B.v(Q('game_research', gr.concat(['confidence', 'label'])));
    if (conf) bits.push(B.t('conf_' + gid, Q('game_research', gr.concat(['confidence', 'label']))) + '.');
    const tier = B.t('tier_' + gid, Q('nfl_slate', q.concat(['tier'])));
    bits.push('Validation tier: ' + tier + '. That means ' + (TIER_TEXT[tier] || 'my pipeline has not described this tier') + '.');
    B.h3('How much weight this gap can carry');
    B.ul(bits);
  });

  /* ---- what the record says about gaps like these */
  const lean = (k, f) => B.n('lean_' + k, Q('record_summary', ['sports', sp, 'clv', 'spread_entry_lean', k]), f || 'int');
  const leanAts = (k, f) => B.n('lean_ats_' + k, Q('record_summary', ['sports', sp, 'ats', 'lean', k]), f || 'int');
  const la = B.v(Q('record_summary', ['sports', sp, 'ats', 'lean']));
  B.h('What my record says about gaps like these');
  const recLine = 'When my NFL number sat at least ' + B.n('lean_threshold', Q('record_summary', ['sports', sp, 'lean_threshold']), 'int')
    + ' points off the market this season, the close moved my way by ' + lean('avg', 'pts2') + ' points on average across ' + lean('n')
    + ' games, and ' + lean('beat_pct', 'pct1') + ' of them beat the close.';
  B.p(recLine + ' Against the spread those games went ' + leanAts('w') + '-' + leanAts('l') + (la.p ? '-' + leanAts('p') : '') + ' (' + leanAts('pct', 'pct1') + ').');
  B.p('My pricing validation puts the NFL spread in the ' + B.t('spread_tier', Q('nfl_slate', ['pricing', 'tier'])) + ' tier at gaps of '
    + B.n('required_edge', Q('nfl_slate', ['pricing', 'required_edge_points']), 'num1') + ' points or more. That is break-even history, not an edge, and I am not going to call it one until the closing line says so for longer.');
  highlights.push(recLine);
  B.p(RECORD_LINK + ' grades every one of these after the close, and ' + modelRecordLink(sp) + ' shows each game.');

  return finish(B, {
    type: 'disagreement', sport: 'NFL', season: Number(season), week: o.week, period: season + '-w' + String(o.week).padStart(2, '0'),
    article_key: 'disagreement:nfl:' + season + ':w' + String(o.week).padStart(2, '0'),
    slug: 'nfl-week-' + o.week + '-' + season + '-where-my-number-disagrees',
    title: 'NFL Week ' + W + ': where my number disagrees with the market, led by ' + topGap + ' points on the ' + topSel,
    description: 'Where my NFL Week ' + W + ' numbers sit furthest from the market, what is inside each one, and what my CLV record says gaps like these are worth.',
    lead: lead, highlights: highlights.slice(0, 3),
    reddit_title: 'My model vs the market, NFL Week ' + W + ': the biggest gap is ' + topGap + ' points. Here is what is inside each number.',
    record_link: SITE + '/record.html'
  });
}

/* ====================================================== line movement */
/* Which key margins a spread passed on its way from open to close, as the
   home team's line. "through": it was on one side and finished on the other.
   "onto": it finished on the key. "off": it started on the key and left it.
   A favorite flip passes through zero, so the keys on BOTH sides of it count. */
function crossings(o, c, keys) {
  const ao = Math.abs(o), ac = Math.abs(c), out = [];
  const flip = (o < 0 && c > 0) || (o > 0 && c < 0);
  keys.forEach(k => {
    if (flip) {
      if ((k < ao) || (k < ac)) out.push({ k, how: 'through' });
      else if (k === ac) out.push({ k, how: 'onto' });
      else if (k === ao) out.push({ k, how: 'off' });
    } else if (ao !== ac) {
      const lo = Math.min(ao, ac), hi = Math.max(ao, ac);
      if (lo < k && k < hi) out.push({ k, how: 'through' });
      else if (k === ac) out.push({ k, how: 'onto' });
      else if (k === ao) out.push({ k, how: 'off' });
    }
  });
  return { flip, keys: out };
}
function lineMovement(S, o) {
  if (o.sport !== 'nfl') throw new NotReady('line_movement: the CFB opener ledger for 2026 is not complete enough (football/pricing/openers_cfb.json is season 2025); NFL only for now');
  const B = new D.Builder(S), sp = 'nfl', OP = 'openers_nfl', rec = 'record_nfl';
  const games = (B.v(Q(OP, ['games', { filter: [['week', '=', o.week], ['closed', '=', true], ['open.home_line', 'notnull'], ['close.home_line', 'notnull']] }])) || []);
  if (!games.length) throw new NotReady('NFL week ' + o.week + ' has no closed games in the opener ledger');
  const allWeek = B.v(Q(OP, ['games', { filter: [['week', '=', o.week]] }])) || [];
  if (allWeek.length !== games.length && !o.allowPartial) throw new NotReady('NFL week ' + o.week + ': ' + (allWeek.length - games.length) + ' game(s) have not closed yet');
  const ids = Object.keys(B.v(Q(OP, ['games']))).filter(id => games.indexOf(B.v(Q(OP, ['games', id]))) >= 0);
  const season = B.n('season', Q(rec, ['season']), 'int');
  const W = B.n('week', Q(OP, ['games', ids[0], 'week']), 'int');
  const KQ = ['leagues', 'NFL', 'key_numbers'];
  const prim = B.v(Q('key_numbers', KQ.concat(['primary']))), sec = B.v(Q('key_numbers', KQ.concat(['secondary'])));
  const keyDisp = (k) => {
    const pi = prim.indexOf(k);
    return pi >= 0 ? B.n('key_p' + pi, Q('key_numbers', KQ.concat(['primary', pi])), 'int') : B.n('key_s' + sec.indexOf(k), Q('key_numbers', KQ.concat(['secondary', sec.indexOf(k)])), 'int');
  };
  const moveQ = (id, m) => ({ op: 'abs_sub', args: [Q(OP, ['games', id, 'close', m]), Q(OP, ['games', id, 'open', m])] });
  const moved = ids.map(id => {
    const g = B.v(Q(OP, ['games', id]));
    return { id, g, spread: Math.abs(g.close.home_line - g.open.home_line), total: (g.close.total != null && g.open.total != null) ? Math.abs(g.close.total - g.open.total) : null };
  }).sort((x, y) => y.spread - x.spread || String(x.id).localeCompare(String(y.id)));

  const toward = (id, g) => g.close.home_line < g.open.home_line ? B.t('tw_' + id, Q(OP, ['games', id, 'home'])) : B.t('tw_' + id, Q(OP, ['games', id, 'away']));
  const top = moved[0];
  const lead = top.spread > 0
    ? 'The biggest NFL Week ' + W + ' line move was ' + B.n('top_move', moveQ(top.id, 'home_line'), 'num1') + ' points: ' + B.t('top_home', Q(OP, ['games', top.id, 'home'])) + ' opened '
      + B.n('top_open', Q(OP, ['games', top.id, 'open', 'home_line']), 'line') + ' and closed ' + B.n('top_close', Q(OP, ['games', top.id, 'close', 'home_line']), 'line') + '.'
    : 'No NFL Week ' + W + ' spread moved between the open and the close.';
  B.p('**' + lead + '** Below is every Week ' + W + ' game from the open my pipeline first saw to the close, which side the line moved toward, the key numbers it crossed, and whether the side my number leaned beat the close.');

  const keyHits = [];
  const rows = moved.map(m => {
    const id = m.id, g = m.g, gb = ['games', id];
    const game = B.t('away_' + id, Q(OP, gb.concat(['away']))) + ' @ ' + B.t('home_' + id, Q(OP, gb.concat(['home'])));
    const home = B.t('hl_' + id, Q(OP, gb.concat(['home'])));
    const open = home + ' ' + B.n('open_' + id, Q(OP, gb.concat(['open', 'home_line'])), 'line');
    const close = home + ' ' + B.n('close_' + id, Q(OP, gb.concat(['close', 'home_line'])), 'line');
    const mv = m.spread > 0 ? B.n('mv_' + id, moveQ(id, 'home_line'), 'num1') + ' toward ' + toward(id, g) : 'No move';
    const cx = crossings(g.open.home_line, g.close.home_line, prim.concat(sec).sort((a, b) => a - b));
    const kText = (cx.flip ? ['favorite flipped'] : []).concat(cx.keys.map(z => z.how + ' ' + keyDisp(z.k))).join(', ') || 'None';
    if (cx.keys.some(z => prim.indexOf(z.k) >= 0 && z.how !== 'off')) keyHits.push(game);
    const changes = B.n('chg_' + id, Q(OP, gb.concat(['moves'])), 'int');
    const ce = (B.v(Q(rec, ['games', id, 'grade', 'clv_entry', 'spread'])) || null);
    let mine = 'Not graded', clv = '';
    if (ce && ce.pts != null) {
      mine = (ce.side === 'home' ? B.t('mh_' + id, Q(rec, ['games', id, 'home_code'])) : B.t('ma_' + id, Q(rec, ['games', id, 'away_code'])));
      clv = B.n('clv_' + id, Q(rec, ['games', id, 'grade', 'clv_entry', 'spread', 'pts']), 'pts');
    }
    return [game, open, close, mv, changes, kText, mine, clv];
  });
  B.h('Every move, open to close');
  B.table(['Game', 'Open', 'Close', 'Net move', 'Changes seen', 'Key numbers', 'My early side', 'My CLV'], rows);
  B.p('Lines are the home team’s. The open is the first line my opener ledger saw for the game, the close is the consensus at kickoff, and "changes seen" counts every time the ledger saw the line change in between. A line can finish where it opened and still travel: my CLV is measured from the market at the moment I recorded my number, not from the open, so a flat row can carry CLV. "My early side" is the side my first recorded number leaned, from ' + modelRecordLink(sp) + '.');

  B.h('Key numbers');
  B.p('In the NFL the margins that matter most are ' + prim.map(keyDisp).join(' and ') + ', then ' + sec.map(keyDisp).join(' and ')
    + ', measured from ' + B.n('key_n_games', Q('key_numbers', ['leagues', 'NFL', 'n_games']), 'int') + ' final margins since '
    + B.n('key_since', Q('key_numbers', ['leagues', 'NFL', 'seasons', 0]), 'int') + '. '
    + (keyHits.length ? 'This week a line went through or onto ' + prim.map(keyDisp).join(' or ') + ' in: ' + keyHits.join('; ') + '.' : 'This week no line went through or onto ' + prim.map(keyDisp).join(' or ') + '.'));

  const totals = moved.filter(m => m.total != null && m.total > 0).sort((x, y) => y.total - x.total || String(x.id).localeCompare(String(y.id))).slice(0, 3);
  if (totals.length) {
    B.h('The totals that moved most');
    B.ul(totals.map(m => {
      const gb = ['games', m.id];
      return B.t('tg_' + m.id, Q(OP, gb.concat(['away']))) + ' @ ' + B.t('tgh_' + m.id, Q(OP, gb.concat(['home']))) + ': '
        + B.n('topen_' + m.id, Q(OP, gb.concat(['open', 'total'])), 'num1') + ' to ' + B.n('tclose_' + m.id, Q(OP, gb.concat(['close', 'total'])), 'num1')
        + ', ' + B.n('tmv_' + m.id, moveQ(m.id, 'total'), 'num1') + ' points.';
    }));
  }

  /* ---- did my side beat the close, from the record's own week row */
  const wk = ['sports', sp, 'weeks', { find: [['week', '=', o.week]] }];
  const wrow = B.v(Q('record_summary', wk));
  const highlights = [];
  B.h('Did my side beat the close');
  if (wrow && wrow.clv && wrow.clv.n) {
    const c = (k, f) => B.n('wk_clv_' + k, Q('record_summary', wk.concat(['clv', k])), f || 'int');
    const s = 'Across ' + c('n') + ' graded Week ' + W + ' spreads, the close moved toward my early side in ' + c('beat') + ', away from it in ' + c('lost')
      + ', and not at all in ' + c('flat') + '. Average CLV: ' + c('avg', 'pts2') + ' points.';
    B.p(s + ' When the line moves and my number does not, the market is either telling me something I missed or reacting to something I already priced. This table is how I tell the two apart over time.');
    highlights.push(s);
  } else {
    B.p('My model record has not graded Week ' + W + ' against the close yet, so I am not saying whether my side beat it.');
  }
  if (keyHits.length) highlights.push('Lines went through or onto ' + prim.map(keyDisp).join(' or ') + ' in: ' + keyHits.slice(0, 3).join('; ') + (keyHits.length > 3 ? '; and more' : '') + '.');
  B.p(RECORD_LINK + ' has the full grading.');

  /* the count in that highlight is a fact about this table, not a source number */
  const out = finish(B, {
    type: 'line_movement', sport: 'NFL', season: Number(season), week: o.week, period: season + '-w' + String(o.week).padStart(2, '0'),
    article_key: 'line_movement:nfl:' + season + ':w' + String(o.week).padStart(2, '0'),
    slug: 'nfl-week-' + o.week + '-' + season + '-line-movement',
    title: 'NFL Week ' + W + ' line movement: ' + (top.spread > 0 ? 'the biggest move was ' + B.numbers.find(n => n.key === 'top_move').display + ' points' : 'no spread moved') + ', and where my side stood',
    description: 'Every NFL Week ' + W + ' spread from open to close, the key numbers crossed, and whether the side my number leaned beat the close.',
    lead: lead, highlights: highlights.slice(0, 3),
    reddit_title: 'NFL Week ' + W + ' open-to-close line moves, key numbers crossed, and whether my model’s side beat the close',
    record_link: SITE + '/record.html'
  });
  return out;
}

/* ========================================================== got wrong */
function monthBounds(m) {
  const mm = /^(\d{4})-(\d{2})$/.exec(m || '');
  if (!mm) throw new NotReady('got_wrong: month must be YYYY-MM');
  const y = Number(mm[1]), mo = Number(mm[2]);
  const start = new Date(Date.UTC(y, mo - 1, 1)).toISOString(), end = new Date(Date.UTC(y, mo, 1)).toISOString();
  return { start, end };
}
const CLAIM_CATEGORY = { market: 'the market', scoring: 'scoring', passing: 'passing', rushing: 'rushing', QB: 'the quarterbacks', model_baseline: 'the baseline rating', explosiveness: 'explosive plays', variance: 'variance', efficiency: 'efficiency' };
function gotWrong(S, o) {
  const { start, end } = monthBounds(o.month);
  const B = new D.Builder(S);
  const sections = [], allMisses = [];
  ['nfl', 'cfb'].forEach(sp => {
    const rec = 'record_' + sp, LG = LEAGUE[sp];
    const conds = [['grade.status', '=', 'GRADED'], ['kickoff', '>=', start], ['kickoff', '<', end], ['grade.error.model_margin_err', 'notnull']];
    const games = B.v(Q(rec, ['games', { filter: conds }])) || [];
    if (!games.length) return;
    sections.push({ sp, LG, rec, conds, games });
    games.forEach(g => allMisses.push({ sp, rec, g }));
  });
  if (!sections.length) throw new NotReady('got_wrong: no graded games kicked off in ' + o.month);

  /* WHAT I GOT WRONG IS WHERE THE MARKET KNEW BETTER. Ranked by how much
     closer the close was to the final than my number, so a blowout the
     market missed just as badly does not crowd out a game where it did not. */
  const behind = (g) => g.grade.error.model_margin_err - g.grade.error.close_margin_err;
  const byBehind = (x, y) => behind(y.g || y) - behind(x.g || x) || String((x.g || x).game_id).localeCompare(String((y.g || y).game_id));
  const ranked = allMisses.filter(z => z.g.grade.error.close_margin_err != null).sort(byBehind);
  if (!ranked.length) throw new NotReady('got_wrong: no graded game in ' + o.month + ' has a close to compare against');
  const worst = ranked[0];
  const wb = ['games', worst.g.game_id];
  const behindQ = (rec, gb) => ({ op: 'sub', args: [Q(rec, gb.concat(['grade', 'error', 'model_margin_err'])), Q(rec, gb.concat(['grade', 'error', 'close_margin_err']))] });
  /* the month is printed from the worst game's own kickoff, so the year on
     the page is a fact of the data, not of the request */
  const label = B.n('month', Q(worst.rec, wb.concat(['kickoff'])), 'month');
  const wAway = B.t('w_away', Q(worst.rec, wb.concat(['away']))), wHome = B.t('w_home', Q(worst.rec, wb.concat(['home'])));
  const wErr = B.n('w_behind', behindQ(worst.rec, wb), 'num1');
  const lead = 'My worst number in ' + label + ' was ' + wAway + ' at ' + wHome + ': I had ' + wHome + ' ' + B.n('w_line', Q(worst.rec, wb.concat(['pick', 'home_line'])), 'line')
    + ', the market closed ' + wHome + ' ' + B.n('w_close', Q(worst.rec, wb.concat(['close', 'home_line'])), 'line') + ', and the close finished ' + wErr + ' points nearer the final than I did.';
  B.p('**' + lead + '**');
  B.p('This is the monthly post where I go looking for my worst numbers on purpose. Every game below was graded against the final and the close by my model record, and where I wrote a pregame thesis, the postgame audit says which parts of it the game contradicted.');

  const highlights = [];
  sections.forEach(sec => {
    const { sp, LG, rec, conds } = sec;
    const cq = (extra, agg) => Q(rec, ['games', { filter: conds.concat(extra || []) }], { agg: agg || { fn: 'count' } });
    B.h(LEAGUE_LONG[sp] + ': the month in numbers');
    const n = B.n(sp + '_n', cq(), 'int');
    const mine = B.n(sp + '_mae', cq(null, { fn: 'avg', field: 'grade.error.model_margin_err' }), 'num2');
    const mkt = B.n(sp + '_close_mae', cq([['grade.error.close_margin_err', 'notnull']], { fn: 'avg', field: 'grade.error.close_margin_err' }), 'num2');
    const closer = B.n(sp + '_close_better', cq([['grade.error.close_margin_err', 'notnull'], ['grade.error.model_margin_err', '>', { field: 'grade.error.close_margin_err' }]]), 'int');
    const w = B.n(sp + '_ats_w', cq([['grade.spread.result', '=', 'win']]), 'int'), l = B.n(sp + '_ats_l', cq([['grade.spread.result', '=', 'loss']]), 'int');
    const s = 'I graded ' + n + ' ' + LG + ' games. My number missed the final margin by ' + mine + ' points on average; the closing line missed by ' + mkt
      + '. The close was nearer the final than I was in ' + closer + ' of them. Against the spread my side went ' + w + '-' + l + '.';
    B.p(s);
    highlights.push(s.split('. ').slice(1, 3).join('. ') + '.');

    const misses = sec.games.filter(g => g.grade.error.close_margin_err != null).sort(byBehind).slice(0, o.limit || 3);
    B.h3('Where the close beat me by the most');
    misses.forEach(g => {
      const gb = ['games', g.game_id], id = g.game_id;
      const away = B.t('ma_' + id, Q(rec, gb.concat(['away']))), home = B.t('mh_' + id, Q(rec, gb.concat(['home'])));
      const err = B.n('merr_' + id, Q(rec, gb.concat(['grade', 'error', 'model_margin_err'])), 'num1');
      const cerr = g.grade.error.close_margin_err != null ? B.n('mcerr_' + id, Q(rec, gb.concat(['grade', 'error', 'close_margin_err'])), 'num1') : null;
      const myLine = home + ' ' + B.n('mline_' + id, Q(rec, gb.concat(['pick', 'home_line'])), 'line');
      const closeLine = g.close && g.close.home_line != null ? home + ' ' + B.n('mclose_' + id, Q(rec, gb.concat(['close', 'home_line'])), 'line') : null;
      const fin = away + ' ' + B.n('mas_' + id, Q(rec, gb.concat(['final', 'away_score'])), 'int') + ', ' + home + ' ' + B.n('mhs_' + id, Q(rec, gb.concat(['final', 'home_score'])), 'int');
      const res = g.grade.spread && g.grade.spread.result ? B.t('mres_' + id, Q(rec, gb.concat(['grade', 'spread', 'result']))) : null;
      let p = '**' + away + ' at ' + home + '.** I had ' + myLine + (closeLine ? ', it closed ' + closeLine : '') + ', and it finished ' + fin + '. My number missed by ' + err
        + (cerr ? ' points; the close missed by ' + cerr + ', so the market was ' + B.n('mbehind_' + id, behindQ(rec, gb), 'num1') + ' points nearer.' : ' points.')
        + (res ? ' My side ' + (res === 'win' ? 'still covered' : res === 'loss' ? 'lost' : 'pushed') + '.' : '');
      B.p(p);

      /* what the audit says, when there is one */
      const file = LG + '_' + id + '.json';
      const aud = B.v(Q('editorial_audits', ['files', file]));
      if (!aud) {
        /* the CFB Lab classifies its own misses; used only when the review is
           of the same model version that published this number */
        const MR = 'cfb_miss_reviews', mq = ['rows', { find: [['game_id', '=', String(id)], ['model_version', '=', g.model_version]] }];
        const mr = sp === 'cfb' && S.cfb_miss_reviews ? B.v(Q(MR, mq)) : null;
        if (mr && mr.classification && mr.classification !== 'UNKNOWN') {
          B.p('My CFB Lab classified this one as ' + B.t('mrc_' + id, Q(MR, mq.concat(['classification']))).replace(/_/g, ' ').toLowerCase() + ': ' + B.t('mrr_' + id, Q(MR, mq.concat(['rationale']))) + '.');
        } else if (mr) {
          B.p('My CFB Lab reviewed this miss and could not establish a cause from the evidence it had, and there is no postgame audit, so I am not going to guess at why.');
        } else {
          B.p('There is no postgame audit on file for this game, so I am not going to guess at why.');
        }
        return;
      }
      const ab = ['files', file];
      const graded = B.v(Q('editorial_audits', ab.concat(['tally', 'graded'])));
      const failed = (aud.audit || []).map((x, j) => ({ x, j })).filter(z => z.x.evaluation === 'NOT CONFIRMED' && z.x.why && !/EdgeDesk/.test(z.x.why));
      const lines = [];
      if (graded) {
        lines.push('The audit could grade ' + B.n('ag_' + id, Q('editorial_audits', ab.concat(['tally', 'graded'])), 'int') + ' of my '
          + B.n('at_' + id, Q('editorial_audits', ab.concat(['tally', 'total'])), 'int') + ' pregame claims, and '
          + B.n('anc_' + id, Q('editorial_audits', ab.concat(['tally', 'counts', 'NOT CONFIRMED'])), 'int') + ' of them did not hold up.');
      } else {
        lines.push('The audit could not grade any of my ' + B.n('at_' + id, Q('editorial_audits', ab.concat(['tally', 'total'])), 'int') + ' pregame claims from the statistics published for this game, so it is a miss without a lesson.');
      }
      failed.slice(0, 3).forEach(z => {
        lines.push('On ' + (CLAIM_CATEGORY[z.x.category] || 'that claim') + ': ' + B.t('aw_' + id + '_' + z.j, Q('editorial_audits', ab.concat(['audit', z.j, 'why']))) + '.');
      });
      B.ul(lines);
    });
  });

  /* ---- the pattern across every audit so far */
  const M = 'editorial_memory';
  const cats = (B.v(Q(M, ['categories'])) || []).map((c, i) => ({ c, i })).filter(z => z.c.contradiction_rate != null)
    .sort((x, y) => y.c.contradiction_rate - x.c.contradiction_rate || y.c.lessons - x.c.lessons).slice(0, 3);
  B.h('The pattern so far');
  const qd = (k) => B.n('quad_' + k, Q(M, ['quadrants', k]), 'int');
  B.p('Across ' + B.n('mem_games', Q(M, ['graded_games']), 'int') + ' audited games this season, my number landed while the game contradicted my reasoning '
    + qd('right_wrong') + ' times, and my reasoning held up while the number lost ' + qd('wrong_right') + ' times. Both were right '
    + qd('right_right') + ' times and both were wrong ' + qd('wrong_wrong') + ' times. The rest could not be graded from the published statistics.');
  if (cats.length) {
    B.ul(cats.map(z => 'Claims about ' + (CLAIM_CATEGORY[z.c.category] || B.t('cat_' + z.i, Q(M, ['categories', z.i, 'category']))) + ' were contradicted '
      + B.n('catc_' + z.i, Q(M, ['categories', z.i, 'contradicted']), 'int') + ' of ' + B.n('catl_' + z.i, Q(M, ['categories', z.i, 'lessons']), 'int') + ' times.'));
  }
  B.p('Those counts measure my own process, not a betting record. No model weight changes because of one game; a contradicted claim opens a review, and I close reviews by hand.');
  B.p(RECORD_LINK + ' and ' + modelRecordLink('nfl') + ' carry every graded game.');

  const season = B.v(Q('record_summary', ['season']));
  return finish(B, {
    type: 'got_wrong', sport: 'ALL', season: Number(season), week: null, period: o.month,
    article_key: 'got_wrong:all:' + o.month,
    slug: 'what-i-got-wrong-' + slugify(label),
    title: 'What I got wrong in ' + label + ': the close beat my number by ' + wErr + ' points on ' + wAway + ' at ' + wHome,
    description: 'My biggest football misses of ' + label + ', graded against the final and the close, and what my postgame audits say went wrong.',
    lead: lead, highlights: highlights.slice(0, 3),
    reddit_title: 'I publish my worst numbers every month. ' + label + ': the closing line beat me by ' + wErr + ' points on ' + wAway + ' at ' + wHome + '.',
    record_link: SITE + '/record.html'
  });
}

/* ===================================================== research notes */
const GATE_TEXT = {
  G1_mae_ci_below_zero: 'margin error clearly better (the interval sits below zero)',
  G2_brier_not_worse: 'win probability no worse (Brier)',
  G3_ece_within_001: 'calibration within tolerance',
  G4_coverage80_in_band: 'its middle ranges hold about four results in five, as they claim to',
  G5_tail_not_worse: 'its worst misses no worse',
  G6_weekly_stability: 'better week after week, not just on average'
};
function latestEvent(rows, id) {
  return rows.map((r, i) => ({ r, i })).filter(z => z.r.experiment_id === id)
    .sort((a, b) => String(a.r.created_at).localeCompare(String(b.r.created_at)) || a.i - b.i).pop();
}
function researchNotes(S, o) {
  const B = new D.Builder(S), X = 'cfb_experiments', P = 'cfb_promotion', MT = 'cfb_maturity';
  const rows = B.v(Q(X, ['rows'])) || [];
  const ev = latestEvent(rows, o.study);
  if (!ev) throw new NotReady('research_notes: no registered study ' + o.study);
  const xb = ['rows', ev.i], r = ev.r;
  const evals = B.v(Q(P, ['evaluations'])) || [];
  const ei = evals.findIndex(e => e.challenger === r.challenger_model && e.champion === r.baseline_model);
  if (r.status !== 'RUNNING' || ei < 0) throw new NotReady('research_notes: ' + o.study + ' is ' + r.status + ' with no published head-to-head evaluation, so there is nothing to report yet');
  const pb = ['evaluations', ei];
  const name = B.t('name', Q(X, xb.concat(['experiment_name'])));
  const sid = B.t('study_id', Q(X, xb.concat(['experiment_id'])));
  /* the maturity file names each model in words; the version ids are the fallback */
  const mods = B.v(Q(MT, ['modules'])) || [];
  const named = (ver, key, fieldKey) => {
    const i = mods.findIndex(m => m.version === ver);
    return i >= 0 ? B.t(key, Q(MT, ['modules', i, 'model'])) : B.t(key, Q(X, xb.concat([fieldKey])));
  };
  const challenger = named(r.challenger_model, 'challenger', 'challenger_model'), champ = named(r.baseline_model, 'baseline', 'baseline_model');
  const n = B.n('n', Q(P, pb.concat(['n'])), 'int'), minN = B.n('min_n', Q(P, pb.concat(['min_n'])), 'int');
  const maeC = B.n('mae_ch', Q(P, pb.concat(['challenger_stats', 'mae'])), 'fix3'), maeB = B.n('mae_champ', Q(P, pb.concat(['champion_stats', 'mae'])), 'fix3');
  const e = evals[ei];
  const better = e.mae_diff < 0;
  const lead = 'After ' + n + ' live college games, ' + challenger + ' misses the final margin by ' + maeC + ' points on average, against ' + maeB
    + ' for ' + champ + ', the model that prices my games now. ' + (better ? 'That is better, but not yet by enough to prove it.' : 'The challenger is not ahead.');
  B.p('**' + lead + '**');
  B.note('Experimental. This is a registered study running beside my published numbers. Nothing in it moves a number I publish until it passes every gate below and I promote it by hand.');

  B.h('The study');
  B.ul([
    'Study: ' + sid + ', ' + name + '.',
    'Status: ' + B.t('status', Q(X, xb.concat(['status']))) + ' since ' + B.n('start', Q(X, xb.concat(['start_date'])), 'date') + '.',
    'What it tests: ' + B.t('change', Q(X, xb.concat([Array.isArray(r.change) ? 'scope' : 'change']))) + '.',
    'The hypothesis, as I registered it on ' + B.n('registered', Q(X, xb.concat(['start_date'])), 'date') + ': ' + B.t('hypothesis', Q(X, xb.concat(['hypothesis']))),
    'Evaluation window: ' + B.t('window', Q(X, xb.concat(['evaluation_window']))) + '.'
  ]);

  B.h('What it shows so far');
  const st = (who, k, f) => B.n(who + '_' + k, Q(P, pb.concat([who === 'ch' ? 'challenger_stats' : 'champion_stats', k])), f);
  B.table(['Measure', challenger, champ], [
    ['Average margin miss (MAE)', maeC, maeB],
    ['Root mean square miss', st('ch', 'rmse', 'fix3'), st('cb', 'rmse', 'fix3')],
    ['Win probability error (Brier)', st('ch', 'brier', 'fix4'), st('cb', 'brier', 'fix4')],
    ['Calibration error (ECE)', st('ch', 'ece', 'fix4'), st('cb', 'ece', 'fix4')],
    ['Bad-game miss (one game in twenty is worse)', st('ch', 'p95_ae', 'num2'), st('cb', 'p95_ae', 'num2')]
  ]);
  const lo = B.n('ci_lo', Q(P, pb.concat(['mae_diff_ci', 0])), 'pts3'), hi = B.n('ci_hi', Q(P, pb.concat(['mae_diff_ci', 1])), 'pts3');
  const lower = (k) => e.challenger_stats[k] < e.champion_stats[k];
  const wins = [['brier', 'win probability'], ['ece', 'calibration'], ['p95_ae', 'its worst misses']].filter(z => lower(z[0])).map(z => z[1]);
  const and = (xs) => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  if (wins.length) B.p('So the challenger is ' + (better ? 'ahead' : 'behind') + ' on average margin error and ahead on ' + and(wins) + '. A model can be better calibrated and still miss the margin by more.');
  B.p('The difference in margin error is ' + B.n('mae_diff', Q(P, pb.concat(['mae_diff'])), 'pts3') + ' points (challenger minus champion), and its interval runs from ' + lo + ' to ' + hi + '. '
    + (e.mae_diff_ci[0] < 0 && e.mae_diff_ci[1] > 0 ? 'That interval includes zero, so on margin error this sample cannot tell the two models apart.' : 'That interval does not include zero.'));
  B.p('Across ' + B.n('weeks', Q(P, pb.concat(['weeks'])), 'int') + ' weeks the challenger won ' + B.n('win_share', Q(P, pb.concat(['weekly_win_share'])), 'prob0') + ' of the weekly comparisons. Its middle ranges, meant to hold four results in five, held '
    + B.n('cov80', Q(P, pb.concat(['challenger_stats', 'coverage_80'])), 'prob1') + ' of results.');

  B.h('The gates');
  const gates = B.v(Q(P, pb.concat(['gates']))) || {};
  B.ul(Object.keys(gates).sort().map(k => (GATE_TEXT[k] || k) + ': ' + (gates[k] ? 'passed' : 'not passed') + '.'));
  B.p('The sample reached the ' + minN + '-game minimum at ' + n + ' games, so the promotion check ran. Its answer: ' + B.t('decision', Q(P, pb.concat(['decision']))).replace(/_/g, ' ').toLowerCase() + '.');

  B.h('What it does not show yet');
  const mi = mods.findIndex(m => m.version === r.challenger_model);
  const notYet = ['Whether ' + challenger + ' is more accurate than ' + champ + ' on margin. The interval above says this sample cannot answer that.'];
  if (mi >= 0) {
    notYet.push('Whether it beats the closing line. My pipeline’s CLV status for it: ' + B.t('clv_status', Q(MT, ['modules', mi, 'clv_status'])) + '.');
    notYet.push('Its maturity: ' + B.t('maturity', Q(MT, ['modules', mi, 'status_label'])) + '.');
  }
  notYet.push('Anything about betting. This study grades forecasts, not prices.');
  B.ul(notYet);
  B.p('What changes because of it today: nothing. My ' + named(B.v(Q(P, ['champion'])), 'champion', 'baseline_model') + ' still prices every college number I publish, and the study keeps running.');
  B.p('[My CFB Model Lab record](' + SITE + '/record.html#cfb-model-lab) grades the lab\u2019s numbers in public as the games finish, and ' + RECORD_LINK.replace('My live', 'my live') + ' carries everything I publish.');

  const planned = rows.map((x, i) => ({ x, i })).filter(z => z.x.status === 'PLANNED');
  if (planned.length) {
    B.h('Next on the list');
    B.ul(planned.map(z => B.t('pl_' + z.i, Q(X, ['rows', z.i, 'experiment_id'])) + ', ' + B.t('pln_' + z.i, Q(X, ['rows', z.i, 'experiment_name'])) + ': '
      + B.t('plh_' + z.i, Q(X, ['rows', z.i, 'hypothesis'])) + ' Not built yet.'));
  }

  const bucket = Math.floor(e.n / 50) * 50;
  const season = B.v(Q('record_summary', ['season']));
  return finish(B, {
    type: 'research_notes', sport: 'CFB', season: Number(season), week: null, period: o.study.toLowerCase() + '-n' + bucket,
    article_key: 'research_notes:cfb:' + o.study + ':' + e.decision + ':n' + bucket,
    slug: 'research-note-' + o.study.toLowerCase() + '-' + slugify(r.experiment_name) + '-' + bucket + '-games',
    title: 'Research note: ' + name + ' after ' + n + ' live games',
    description: 'A registered study of my college football model: ' + name + '. The sample, what it shows so far and what it does not show yet. Experimental.',
    lead: lead, highlights: ['The difference in margin error is ' + B.numbers.find(x => x.key === 'mae_diff').display + ' points, with an interval from ' + lo + ' to ' + hi + '.',
      'Nothing changes today: ' + champ + ' still prices every college number I publish.'],
    reddit_title: 'I ran a registered test of my new college football model against the old one. After ' + n + ' live games, the new one is not ahead.',
    record_link: SITE + '/record.html#cfb-model-lab'
  });
}

const GENERATORS = { weekly_clv: weeklyClv, disagreement: disagreement, line_movement: lineMovement, got_wrong: gotWrong, research_notes: researchNotes };

/* One call: build, then hold the result to the voice and to its sources. */
function generate(type, S, o) {
  const fn = GENERATORS[type];
  if (!fn) throw new Error('desk: unknown type ' + type);
  const d = fn(S, o || {});
  d.voice = D.voiceCheck([d.title, d.lead, (d.highlights || []).join('\n'), d.description, d.body_md].join('\n\n'));
  d.verify = D.verifyDraft(d, S);
  return d;
}

module.exports = { generate, GENERATORS, NotReady, Q, crossings, monthBounds };
