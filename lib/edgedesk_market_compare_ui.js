/* ===========================================================================
   EdgeDesk MARKET COMPARISON — DraftKings | Novig | Better price, on the
   football game cards (window.fbNovigHTML, beside window.fbKalshiHTML).

   What a line actually costs at each venue, for the stake the reader picks:
     A  side-by-side odds (the same side, the same line, the same period)
     B  price disadvantage: what the worse price costs on a win at the stake
     C  EV difference: only against a validated, versioned model probability
        for this exact market; otherwise the reason no EV is stated
     D  hold: DraftKings' margin on its complete two-way market (and its
        no-vig estimate); Novig's cost to cross both sides, named for what it is
     E  liquidity and effective price: size at the top, the fill at the stake,
        VWAP, and whether the top price is achievable at that size
     F  line movement at both venues (on request), with the lead-lag summary
     G  the better venue, in one line
   READS public.novig_access() and public.novig_compare() (supabase/
   novig_market_data.sql) as the reader. The database decides who sees
   anything: until Novig's display permission is on record only an operator
   does, and this section renders NOTHING for anyone else — no placeholder,
   no change to the card. Novig being down or not deployed is the same:
   nothing, for readers; a plain note, for the operator.
   Every number is computed by lib/edgedesk_venue_compare.js from the stored
   book; nothing is estimated in place of a missing price.
   =========================================================================== */
(function (root) {
  'use strict';
  if (root.__edNovigCompare) return;
  root.__edNovigCompare = true;

  /* defense in depth: the database's novig_config.public_display decides; this only ever narrows */
  var NOVIG_PUBLIC_DISPLAY_ENABLED = false;
  var TTL = 60e3;
  var STAKES = [25, 50, 100, 250, 500];
  var S = { access: null, publicDisplay: 'off', st: 'unread', err: null, at: 0, p: null, by: {}, stake: {}, custom: {}, open: {}, hist: {}, msg: {} };
  var V = function () { return root.EDVENUE; };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function am(a) { a = num(a); if (a == null) return '—'; var r = Math.round(a); if (r === -100) r = 100; return (r > 0 ? '+' : '') + r; }
  function money(x) { x = num(x); return x == null ? '—' : (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function pct(x, d) { x = num(x); return x == null ? '—' : (100 * x).toFixed(d == null ? 1 : d) + '%'; }
  function pp(x) { x = num(x); if (x == null) return '—'; return (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(2) + ' pp'; }
  function int(n) { n = num(n); return n == null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function etText(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '—';
    try { var o = { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }; if (Math.abs(Date.now() - t) > 20 * 3600e3) { o.weekday = 'short'; o.month = 'short'; o.day = 'numeric'; } return new Date(t).toLocaleString('en-US', o) + ' ET'; }
    catch (_) { return String(iso); }
  }
  function ago(iso) { var t = Date.parse(iso); if (!isFinite(t)) return ''; var m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 120 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; }
  var STATE = { LIVE: ['Live', 'nvc-ok'], RECENT: ['Recently updated', 'nvc-ok'], STALE: ['Stale', 'nvc-warn'], SUSPENDED: ['Suspended', 'nvc-warn'], NO_LIQUIDITY: ['No liquidity', 'nvc-warn'],
    MISMATCH: ['Market mismatch', 'nvc-warn'], UNSUPPORTED: ['Unsupported market', 'nvc-mut'], AWAITING: ['Awaiting data', 'nvc-mut'] };
  var TIP = {
    implied: 'Implied probability: the win rate a price breaks even at. +A: 100/(A+100); −A: |A|/(|A|+100). For an exchange contract it is the price itself.',
    hold: 'Hold: the margin built into a complete set of a book\'s prices (sum of implied probabilities minus one). It is the book\'s margin across all outcomes, not what any one bettor is certain to lose.',
    novig: 'No-vig: a book\'s two prices scaled so they sum to 100%. An estimate of the market\'s view, not a true probability.',
    liq: 'Liquidity: the contracts resting on the other side of Novig\'s book. A stake larger than the top level walks to worse prices; one larger than the book cannot be filled at all.',
    ev: 'EV per $1 = p × net win per $1 − (1 − p). Stated only with a validated, versioned model probability for this exact market; a better price alone is not a positive-EV bet.',
    spread: 'Exchange spread: buying BOTH sides at Novig\'s best asks costs this much over the $1 that pays out. It is the cost of crossing the book, not a sportsbook hold.'
  };
  function chip(state, extra) { var s = STATE[state] || [state, 'nvc-mut']; return '<span class="nvc-chip ' + s[1] + '"' + (extra ? ' title="' + esc(extra) + '"' : '') + '>' + esc(s[0]) + '</span>'; }
  function tip(key, label) { return '<span class="nvc-tip" tabindex="0" title="' + esc(TIP[key]) + '">' + esc(label) + '</span>'; }

  /* ------------------------------------------------------------ styles (once) */
  function styles() {
    if (!root.document || document.getElementById('nvc-styles')) return;
    var st = document.createElement('style'); st.id = 'nvc-styles';
    st.textContent = '.nvc-wrap{margin-top:12px;border:1px solid var(--border,#332a1b);border-radius:var(--rad-s,11px);background:var(--surface,#191510)}'
      + '.nvc-wrap>summary{cursor:pointer;padding:10px 12px;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;list-style:none}.nvc-wrap>summary::-webkit-details-marker{display:none}'
      + '.nvc-body{padding:0 12px 12px}.nvc-h{font-weight:700}.nvc-m{color:var(--dim,#aa9c87);font-size:12px}.nvc-int{background:rgba(226,96,68,.12);color:var(--neg,#e26044);border-radius:8px;padding:6px 8px;font-size:12px;margin:8px 0}'
      + '.nvc-chip{display:inline-block;font-size:11px;border-radius:999px;padding:1px 8px;border:1px solid currentColor;white-space:nowrap}.nvc-ok{color:var(--pos,#76bd3e)}.nvc-warn{color:var(--warn,#d99a2b)}.nvc-mut{color:var(--faint,#958a7a)}'
      + '.nvc-stakes{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0}.nvc-stakes button{font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--border,#332a1b);background:var(--surface2,#221c15);color:var(--text,#f1ebdf);cursor:pointer}'
      + '.nvc-stakes button[aria-pressed="true"]{background:var(--accent,#2fa79a);color:var(--on-accent,#042320);border-color:var(--accent,#2fa79a)}.nvc-stakes input{width:84px;font:inherit;font-size:12px;padding:3px 6px;border-radius:8px;border:1px solid var(--border,#332a1b);background:var(--bg,#100e0a);color:var(--text,#f1ebdf)}'
      + '.nvc-tbl{width:100%;border-collapse:collapse;font-size:13px}.nvc-tbl th{text-align:left;color:var(--dim,#aa9c87);font-weight:600;font-size:11px;padding:6px 4px;border-bottom:1px solid var(--border,#332a1b)}'
      + '.nvc-tbl td{padding:7px 4px;border-bottom:1px solid var(--border,#332a1b);vertical-align:top}.nvc-tbl .mono{font-family:"JetBrains Mono",ui-monospace,monospace}.nvc-better{color:var(--pos,#76bd3e);font-weight:700}'
      + '.nvc-sec{margin-top:10px}.nvc-sec h4{margin:0 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--dim,#aa9c87)}.nvc-sec p{margin:2px 0;font-size:13px}'
      + '.nvc-tip{border-bottom:1px dotted currentColor;cursor:help}.nvc-act{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.nvc-act button{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid var(--border,#332a1b);background:var(--surface2,#221c15);color:var(--text,#f1ebdf);cursor:pointer}'
      + '.nvc-act select{font:inherit;font-size:12px;border-radius:8px;background:var(--bg,#100e0a);color:var(--text,#f1ebdf);border:1px solid var(--border,#332a1b)}'
      + '@media (max-width:640px){.nvc-tbl .nvc-hide{display:none}.nvc-tbl{font-size:12px}}';
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------ the reads (as the reader) */
  function rpc(fn, body) {
    if (typeof root.SB_URL === 'undefined' && typeof SB_URL === 'undefined') return Promise.reject(new Error('no database configured'));
    var url = (typeof SB_URL !== 'undefined' ? SB_URL : root.SB_URL), key = (typeof SB_KEY !== 'undefined' ? SB_KEY : root.SB_KEY);
    var tok = (typeof edToken === 'function') ? Promise.resolve().then(edToken).catch(function () { return key; }) : Promise.resolve(key);
    return tok.then(function (t) {
      return fetch(url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: key, authorization: 'Bearer ' + (t || key), 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    }).then(function (r) {
      if (r.ok) return r.json();
      return r.text().then(function (b) { var e = new Error('HTTP ' + r.status); e.status = r.status; e.notDeployed = r.status === 404 || /PGRST20[0-9]|42883|does not exist|Could not find/.test(b || ''); throw e; });
    });
  }
  var repaintT = null;
  function repaint() {
    if (repaintT) return;
    repaintT = setTimeout(function () { repaintT = null; try { if (typeof root.renderFootball === 'function') root.renderFootball(); } catch (_) { /* the board repaints itself */ } }, 60);
  }
  function load(force) {
    if (S.p || (!force && S.at && Date.now() - S.at < TTL)) return S.p;
    S.p = rpc('novig_access').then(function (a) {
      S.access = a && a.access || 'none'; S.publicDisplay = a && a.public_display || 'off';
      if (S.access === 'none') { S.by = {}; return null; }
      return rpc('novig_compare', { p_sport: null }).then(function (rows) {
        S.by = {};
        (rows || []).forEach(function (r) { (S.by[r.odds_event_id] = S.by[r.odds_event_id] || []).push(r); });
      });
    }).then(function () { S.st = 'ok'; S.err = null; }, function (e) { S.err = e; S.st = e && e.notDeployed ? 'not_deployed' : 'error'; if (S.access == null) S.access = 'none'; })
      .then(function () { S.at = Date.now(); S.p = null; repaint(); });
    return S.p;
  }
  /** may this reader see Novig prices at all? (the database's answer, narrowed by the local switch) */
  function visible() {
    if (S.access === 'operator') return true;
    return S.access === 'subscriber' && S.publicDisplay === 'on' && NOVIG_PUBLIC_DISPLAY_ENABLED;
  }
  function internal() { return S.publicDisplay !== 'on' || !NOVIG_PUBLIC_DISPLAY_ENABLED; }

  /* ------------------------------------------------------------ the model (EV only when it passes the gate) */
  function footballModel(sport, opts, row) {
    var pred = opts && opts.pred, meta = null;
    try { meta = root.EDFootball && root.EDFootball.meta ? root.EDFootball.meta() : null; } catch (_) { meta = null; }
    if (!pred || !pred.model || !meta || row.book_market !== 'h2h') return null;
    var hp = num(pred.model.home_win_prob);
    if (hp == null) return null;
    /* the football model's own published record (fbModelCard): it does not beat the close. Research tier: it may not price a market */
    return { p_win: row.side === row.home_team ? hp : 1 - hp, model_version: meta.model_version, tier: 'RESEARCH', frozen_at: meta.built_at,
      market: { kind: 'h2h', period: 'game', line: null, side: row.side }, note: 'EdgeDesk\'s football model is research-tier: its published record does not beat the close' };
  }

  /* ------------------------------------------------------------ one selection, at the chosen stake */
  function bookOf(r) { return r.novig && r.novig.depth ? { orders: r.novig.depth } : null; }
  function novigQuote(r, stake) {
    var E = V(), n = r.novig || {};
    if (!E || !n.observed_at) return null;
    var std = STAKES.indexOf(stake) >= 0 && n.exec && n.exec[String(stake)];
    var ids = n.outcome_ids || [];
    if (std) {
      var x = n.exec[String(stake)], top = n.top || {};
      var topM = top.ask != null ? E.milli(top.ask) : null;
      var row = x[0] === 'FILLED' || x[0] === 'PARTIAL' ? { stake_dollars: stake, status: x[0], contracts: x[1], total: x[2], payout: x[3], unspent: x[4], vwap: x[5],
        effective_decimal: num(x[3]) / num(x[2]), effective_implied: num(x[2]) / num(x[3]) } : { stake_dollars: stake, status: x[0] };
      if (row.effective_decimal) row.effective_american = E.decimalToAmerican(row.effective_decimal);
      if (row.vwap != null && topM != null) row.top_not_achievable = Math.round(num(row.vwap) * 1000) > topM;
      return { ok: true, top: topM != null ? { price: top.ask, contracts: top.ask_qty, decimal: 1000 / topM, american: E.decimalToAmerican(1000 / topM), implied: topM / 1000 } : null, stakes: [row], from: 'stored' };
    }
    var b = bookOf(r);
    if (!b || !ids.length) return null;
    var q = E.executableQuote(b, n.outcome_id, ids, { fee: n.fee, eventStatus: n.event_status, stakes: [stake] });
    if (q && q.ok) q.from = 'depth';
    return q;
  }
  function compareRow(r, stake, model) {
    var E = V(), n = r.novig || {}, d = r.draftkings || {};
    var q = novigQuote(r, stake);
    var c = E.compareSelection({
      stakes: [stake], market: { kind: r.book_market, period: r.period, line: r.point, side: r.side },
      book: d.price_dec ? { decimal: num(d.price_dec), observed_at: d.observed_at } : null,
      novig: n.observed_at ? { quote: q, observed_at: n.observed_at, source: n.source === 'ws_book' ? 'ws' : 'rest', suspended: n.state === 'SUSPENDED' ? 'the market is closed or suspended' : null } : null,
      model: model
    });
    /* the server's state wins where it knows more (suspended, no liquidity on this side) */
    if (n.state === 'SUSPENDED' || n.state === 'NO_LIQUIDITY') { c.novig_state = n.state; c.comparable = false; }
    return { r: r, q: q, c: c, row: c.rows[0] };
  }
  function label(r) {
    var line = r.point == null ? '' : (Number(r.point) > 0 && /spreads/.test(r.book_market) ? '+' : '') + Number(r.point);
    return { sel: r.side, line: line, both: (r.side + ' ' + line).trim(), mk: r.book_market === 'h2h' ? 'Moneyline' : /^spreads/.test(r.book_market) ? 'Spread' : /^totals/.test(r.book_market) ? 'Total' : r.book_market, period: r.period === 'first_half' ? '1st half' : '' };
  }

  /* ------------------------------------------------------------ the section */
  function sectionHTML(sport, g, t, ev, opts) {
    var E = V();
    var eid = null; try { eid = ev && ev.rows && ev.rows[0] && ev.rows[0].event_id; } catch (_) { eid = null; }
    var rows = eid ? S.by[eid] : null;
    if (!S.access || S.access === 'none') return '';
    if (S.st !== 'ok') return S.access === 'operator' ? '<div class="nvc-wrap"><div class="nvc-body"><b>Novig</b> <span class="nvc-m">' + esc(S.st === 'not_deployed' ? 'not deployed (supabase/novig_market_data.sql)' : S.st === 'error' ? 'could not be read: ' + (S.err && S.err.message || 'error') : 'loading…') + '</span></div></div>' : '';
    if (!visible()) return '';
    if (!E) return '';
    if (!rows || !rows.length) return S.access === 'operator' ? '<div class="nvc-wrap"><div class="nvc-body"><b>DraftKings vs Novig</b> <span class="nvc-m">no Novig market matched to this game on teams, date, market, line and side — nothing is shown in its place</span></div></div>' : '';
    var stake = S.stake[eid] || 100;
    var model = function (r) { return sport === 'nfl' || sport === 'cfb' ? footballModel(sport, opts, r) : null; };
    var cmp = rows.map(function (r) { return compareRow(r, stake, model(r)); });
    var anyCmp = cmp.filter(function (x) { return x.c.comparable; });
    var better = anyCmp.filter(function (x) { return x.row && x.row.comparable; });
    var nB = better.filter(function (x) { return x.row.better === 'NOVIG'; }).length, dB = better.filter(function (x) { return x.row.better === 'DRAFTKINGS'; }).length;
    var head = '<span class="nvc-h">DraftKings vs Novig</span>'
      + (better.length ? '<span class="nvc-m">' + better.length + ' comparable at $' + stake + ': Novig better ' + nB + ', DraftKings better ' + dB + ', ties ' + (better.length - nB - dB) + '</span>' : '<span class="nvc-m">no current comparison at $' + stake + '</span>');
    var body = '';
    if (internal()) body += '<div class="nvc-int"><b>Internal preview.</b> Novig prices are visible to operators only until Novig\'s permission to display them is on record (docs/novig/README.md §Data rights). Graphics are watermarked and not for distribution.</div>';
    body += '<div class="nvc-stakes" role="group" aria-label="Comparison stake">' + STAKES.map(function (s) { return '<button type="button" data-nvc-stake="' + s + '" data-nvc-ev="' + esc(eid) + '" aria-pressed="' + (s === stake) + '">$' + s + '</button>'; }).join('')
      + '<label class="nvc-m">custom $<input type="number" min="1" max="100000" step="1" inputmode="numeric" data-nvc-custom="' + esc(eid) + '" value="' + (STAKES.indexOf(stake) < 0 ? stake : '') + '" aria-label="Custom stake in dollars"></label></div>';
    /* A: side by side */
    body += '<table class="nvc-tbl"><thead><tr><th scope="col">Selection</th><th scope="col">DraftKings</th><th scope="col">Novig</th><th scope="col">Better at $' + stake + '</th></tr></thead><tbody>'
      + cmp.map(function (x) {
        var lb = label(x.r), d = x.r.draftkings || {}, n = x.r.novig || {}, row = x.row || {};
        var dk = d.price_dec ? '<span class="mono">' + am(E.decimalToAmerican(num(d.price_dec))) + '</span> ' + chip(x.c.book_state, x.c.book_freshness && x.c.book_freshness.why) + '<div class="nvc-m">' + esc(ago(d.observed_at)) + '</div>' : chip('AWAITING', 'no DraftKings price for this side and line');
        var nq = row.novig, top = x.q && x.q.top;
        var nv = top ? '<span class="mono">' + am(top.american) + '</span> ' + chip(x.c.novig_state, x.c.novig_freshness && x.c.novig_freshness.why)
          + '<div class="nvc-m">' + (nq && nq.status === 'FILLED' ? 'at $' + stake + ': <span class="mono">' + am(nq.effective_american) + '</span>' + (nq.top_not_achievable ? ' (walks the book)' : '') : nq && nq.status === 'PARTIAL' ? 'cannot fill $' + stake : nq && nq.status === 'NO_LIQUIDITY' ? 'no liquidity at $' + stake : '') + ' · ' + esc(ago(n.observed_at)) + '</div>'
          : chip(n.state || 'AWAITING');
        var bt = row.comparable ? (row.better === 'TIE' ? '<span class="nvc-m">tie</span>' : '<span class="nvc-better">' + (row.better === 'NOVIG' ? 'Novig' : 'DraftKings') + '</span><div class="nvc-m">' + money(row.cost_of_worse_price) + ' more on a win</div>')
          : '<span class="nvc-m">' + esc(row.why || (x.c.notes[0] || 'not comparable now')) + '</span>';
        return '<tr><td><b>' + esc(lb.sel) + '</b> ' + esc(lb.line) + '<div class="nvc-m">' + esc(lb.mk + (lb.period ? ' · ' + lb.period : '')) + (x.r.match_confidence === 'medium' ? ' · match: medium' : '') + '</div></td><td>' + dk + '</td><td>' + nv + '</td><td>' + bt + '</td></tr>';
      }).join('') + '</tbody></table>';
    /* B: the cost of the worse price */
    body += '<div class="nvc-sec"><h4>Cost of the worse price</h4>' + (better.length ? better.map(function (x) {
      var lb = label(x.r), row = x.row;
      return '<p>' + esc(lb.both) + ': at $' + stake + ', DraftKings pays ' + money(row.book.payout) + ' on a win; Novig pays ' + money(num(row.novig.payout) + num(row.novig.unspent)) + ' (' + int(row.novig.contracts) + ' contracts at ' + esc(row.novig.vwap) + ' VWAP' + (num(row.novig.unspent) >= 0.005 ? ', ' + money(row.novig.unspent) + ' unspent' : '') + '). '
        + (row.better === 'TIE' ? 'Effectively the same price.' : 'Taking ' + (row.better === 'NOVIG' ? 'DraftKings' : 'Novig') + ' costs ' + money(row.cost_of_worse_price) + ' of payout (' + Math.abs(row.implied_gap_pp).toFixed(2) + ' pp of ' + tip('implied', 'implied probability') + ').') + '</p>';
    }).join('') : '<p class="nvc-m">No current, simultaneous comparison at this stake: nothing is claimed.</p>') + '</div>';
    /* C: EV */
    var evRows = better.filter(function (x) { return x.row.ev && x.row.ev.state !== 'INSUFFICIENT_DATA'; });
    var why = (better[0] && better[0].row.ev && better[0].row.ev.reasons) || (cmp[0] && cmp[0].c.model && cmp[0].c.model.reasons) || ['no model probability for these markets'];
    body += '<div class="nvc-sec"><h4>' + tip('ev', 'Estimated EV difference') + '</h4>' + (evRows.length ? evRows.map(function (x) {
      var e = x.row.ev, lb = label(x.r);
      return '<p>' + esc(lb.both) + ': DraftKings ' + (e.book_per_dollar * 100).toFixed(1) + '¢ per $1, Novig ' + (e.novig_per_dollar * 100).toFixed(1) + '¢ per $1 (' + money(e.delta_dollars) + ' at $' + stake + '). ' + esc(E.EV_STATE_LABEL[e.state]) + '.</p>';
    }).join('') : '<p class="nvc-m">No EV is stated: ' + esc(why.join('; ')) + '. Price differences above are price differences, not proof of positive EV.</p>') + '</div>';
    /* D: hold */
    body += '<div class="nvc-sec"><h4>' + tip('hold', 'Market hold') + ' / ' + tip('spread', 'exchange spread') + '</h4>' + holdHTML(rows) + '</div>';
    /* E: liquidity */
    body += '<div class="nvc-sec"><h4>' + tip('liq', 'Liquidity and effective price') + '</h4>' + cmp.filter(function (x) { return x.q && x.q.top; }).map(function (x) {
      var lb = label(x.r), q = x.q, s = x.row && x.row.novig;
      return '<p>' + esc(lb.both) + ': top ' + esc(q.top.price) + ' for ' + int(q.top.contracts) + ' contracts (' + money(num(q.top.price) * num(q.top.contracts) / 100) + ')'
        + (s ? ' · $' + stake + ' → ' + (s.status === 'FILLED' ? int(s.contracts) + ' contracts, VWAP ' + esc(s.vwap) + (s.top_not_achievable ? ', <b>top price not achievable at this size</b>' : ', at the top price') : s.status === 'PARTIAL' ? '<b>not fillable</b> (the book holds less)' : 'no liquidity') : '')
        + ' · fee ' + esc((x.r.novig.fee && x.r.novig.fee.charged_now) ? 'charged now (in play)' : 'none now (pregame; taker fee only in play)') + '</p>';
    }).join('') + '</div>';
    /* F: movement (on request) */
    var h = S.hist[eid];
    body += '<div class="nvc-sec"><h4>Line movement</h4>' + (h ? historyHTML(h) : '<button type="button" class="nvc-mvbtn" data-nvc-hist="' + esc(eid) + '">Show movement at both venues</button>') + '</div>';
    /* G: best venue */
    body += '<div class="nvc-sec"><h4>Best available venue</h4><p>' + (better.length ? better.map(function (x) { var lb = label(x.r); return esc(lb.both) + ': ' + (x.row.better === 'TIE' ? 'either' : x.row.better === 'NOVIG' ? 'Novig' : 'DraftKings'); }).join(' · ') : '<span class="nvc-m">none comparable now</span>') + '</p></div>';
    /* graphics */
    body += '<div class="nvc-act"><label class="nvc-m">Graphic <select data-nvc-tpl="' + esc(eid) + '">' + ['price_gap', 'worse_price_cost', 'book_hold', 'edge_upgrade', 'market_movement', 'why_shopping'].map(function (k) { return '<option value="' + k + '">' + k.replace(/_/g, ' ') + '</option>'; }).join('') + '</select></label>'
      + '<button type="button" data-nvc-gfx="' + esc(eid) + '">Generate comparison graphic</button><span class="nvc-m" data-nvc-msg="' + esc(eid) + '">' + esc(S.msg[eid] || '') + '</span></div>';
    body += '<p class="nvc-m">Sources: DraftKings — The Odds API via EdgeDesk\'s odds gateway; Novig — its exchange order book (' + esc((rows[0].novig || {}).environment || 'production') + '), read every few minutes (not live). Comparisons are pregame, same side and line; Novig settles a voided market at fair value where a sportsbook refunds. Research only.</p>';
    return '<details class="nvc-wrap" id="nvc-' + esc(eid) + '"' + (S.open[eid] ? ' open' : '') + ' data-nvc-open="' + esc(eid) + '"><summary>' + head + '</summary><div class="nvc-body">' + body + '</div></details>';
  }
  function holdHTML(rows) {
    var E = V(), out = [];
    var groups = {};
    rows.forEach(function (r) { var k = r.book_market + '|' + (r.line == null ? '' : r.line); (groups[k] = groups[k] || []).push(r); });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.length !== 2) return;
      var lb = label(g[0]).mk;
      var d0 = g[0].draftkings || {}, d1 = g[1].draftkings || {};
      if (d0.price_dec && d1.price_dec && d0.observed_at === d1.observed_at && E.actionable(E.freshness('book', d0.observed_at).state)) {
        var hh = E.noVig([{ implied: 1 / num(d0.price_dec) }, { implied: 1 / num(d1.price_dec) }], { expected: 2 });
        if (hh.ok) out.push('<p>' + esc(lb + (g[0].line != null ? ' ' + g[0].line : '')) + ': DraftKings holds ' + pct(hh.hold, 2) + ' · ' + tip('novig', 'no-vig') + ' ' + esc(g[0].side) + ' ' + pct(hh.probabilities[0]) + ', ' + esc(g[1].side) + ' ' + pct(hh.probabilities[1]) + ' (estimate)</p>');
      } else out.push('<p class="nvc-m">' + esc(lb) + ': no DraftKings hold — both sides were not captured together and current</p>');
      var a0 = g[0].novig && g[0].novig.top && g[0].novig.top.ask, a1 = g[1].novig && g[1].novig.top && g[1].novig.top.ask;
      if (a0 != null && a1 != null && g[0].novig.snapshot_id === g[1].novig.snapshot_id) out.push('<p>' + esc(lb) + ': buying both sides at Novig\'s best asks costs ' + pct(num(a0) + num(a1) - 1, 1) + ' over the $1 payout (exchange spread, not a hold)</p>');
    });
    return out.join('') || '<p class="nvc-m">No complete market to measure.</p>';
  }
  function historyHTML(h) {
    if (h.err) return '<p class="nvc-m">Movement could not be read: ' + esc(h.err) + '</p>';
    var L = root.EDLeadLag; if (!L) return '';
    var ml = (h.rows || []).filter(function (x) { return x.book_market === 'h2h'; });
    var sides = ml.map(function (x) { return x.side; }).filter(function (s, i, a) { return a.indexOf(s) === i; });
    var st = L.study(ml);
    var spark = sides.map(function (side) {
      var pts = function (v) { return L.series(ml.filter(function (x) { return x.side === side && x.venue === v; })); };
      var n = pts('novig'), d = pts('draftkings'), all = n.concat(d);
      if (all.length < 2) return '';
      var t0 = Math.min.apply(null, all.map(function (x) { return x.t; })), t1 = Math.max.apply(null, all.map(function (x) { return x.t; }));
      var p0 = Math.min.apply(null, all.map(function (x) { return x.p; })), p1 = Math.max.apply(null, all.map(function (x) { return x.p; }));
      var X = function (t) { return 4 + 292 * (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)); }, Y = function (p) { return 56 - 52 * (p1 === p0 ? 0.5 : (p - p0) / (p1 - p0)); };
      var pl = function (s, c) { return s.length ? '<polyline fill="none" stroke="' + c + '" stroke-width="2" points="' + s.map(function (x) { return X(x.t).toFixed(1) + ',' + Y(x.p).toFixed(1); }).join(' ') + '"/>' : ''; };
      return '<div class="nvc-m">' + esc(side) + ' · implied ' + pct(p0) + '–' + pct(p1) + '</div><svg viewBox="0 0 300 60" width="100%" height="60" role="img" aria-label="' + esc(side) + ' implied probability over time at DraftKings and Novig">' + pl(d, '#5fae55') + pl(n, '#c79bf2') + '</svg>';
    }).join('');
    var sh = st.novig_first_share;
    return spark + '<p class="nvc-m">Green: DraftKings · purple: Novig, each at its own observation times. Moves ≥ 1 pp: Novig first ' + st.tally.novig_first + ', DraftKings first ' + st.tally.dk_first + ', undetermined ' + st.undetermined + ' (sampling intervals overlap)'
      + (sh.n ? ' · Novig-first share ' + pct(sh.p, 0) + ' (95% CI ' + pct(sh.low, 0) + '–' + pct(sh.high, 0) + ', n=' + sh.n + ')' : '') + '. ' + esc(st.note) + '</p>';
  }

  /* ------------------------------------------------------------ the graphic payloads (real data only) */
  function payload(tpl, eid) {
    var E = V(), rows = S.by[eid] || [], stake = S.stake[eid] || 100;
    if (!rows.length) return null;
    var r0 = rows[0], game = r0.away_team + ' @ ' + r0.home_team;
    var cmps = rows.map(function (r) { return compareRow(r, stake, null); });
    var best = cmps.filter(function (x) { return x.row && x.row.comparable; }).sort(function (a, b) { return Math.abs(b.row.implied_gap_pp) - Math.abs(a.row.implied_gap_pp); })[0] || cmps[0];
    var base = { internal: internal(), game: game, novig_environment: (r0.novig || {}).environment };
    var sel = function (x) { var lb = label(x.r); return { selection: lb.sel, line: lb.line || null, market_label: lb.mk, dk_observed_at: x.r.draftkings.observed_at, novig_observed_at: x.r.novig.observed_at, novig_source: x.r.novig.source }; };
    if (tpl === 'price_gap') return Object.assign(base, sel(best), { comparable: !!(best.row && best.row.comparable), why: best.row && best.row.why, dk_american: best.c.top && best.c.top.book_american, novig_american: best.c.top && best.c.top.novig_american,
      better: best.row && best.row.better, implied_gap_pp: best.row && best.row.implied_gap_pp, stake: stake, payout_diff: best.row && best.row.payout_diff, novig_effective_american: best.row && best.row.novig && best.row.novig.effective_american, top_not_achievable: best.row && best.row.novig && best.row.novig.top_not_achievable });
    if (tpl === 'worse_price_cost') return Object.assign(base, sel(best), { comparable: best.c.comparable, stakes: STAKES.map(function (s) { var x = compareRow(best.r, s, null).row || {}; return { stake: s, dk_payout: x.book && num(x.book.payout), novig_payout: x.novig && num(x.novig.payout) + num(x.novig.unspent), novig_status: x.novig && x.novig.status, diff: x.payout_diff }; }) });
    if (tpl === 'book_hold') {
      var h2 = rows.filter(function (r) { return r.book_market === 'h2h'; });
      if (h2.length !== 2 || !h2[0].draftkings.price_dec || !h2[1].draftkings.price_dec || h2[0].draftkings.observed_at !== h2[1].draftkings.observed_at) return Object.assign(base, { reason_missing: 'the two DraftKings moneyline prices were not captured together' });
      var nv = E.noVig([{ implied: 1 / num(h2[0].draftkings.price_dec) }, { implied: 1 / num(h2[1].draftkings.price_dec) }], { expected: 2 });
      return Object.assign(base, { market_label: 'Moneyline', dk_observed_at: h2[0].draftkings.observed_at, hold_pct: nv.hold * 100, sides: h2.map(function (r, i) { return { name: r.side, american: E.decimalToAmerican(num(r.draftkings.price_dec)), implied: 1 / num(r.draftkings.price_dec), no_vig: nv.probabilities[i] }; }) });
    }
    if (tpl === 'edge_upgrade') return Object.assign(base, sel(best), { comparable: best.c.comparable, model: { gate_ok: false, reasons: (best.c.model && best.c.model.reasons) || ['no validated model probability'] } });
    if (tpl === 'market_movement') {
      var h = S.hist[eid]; if (!h || !h.rows) return Object.assign(base, { reason_missing: 'open "Show movement" first' });
      var side = best.r.side, L = root.EDLeadLag, ml = h.rows.filter(function (x) { return x.book_market === best.r.book_market && x.side === side; });
      var st = L.study(ml);
      return Object.assign(base, sel(best), { series: { novig: L.series(ml.filter(function (x) { return x.venue === 'novig'; })), draftkings: L.series(ml.filter(function (x) { return x.venue === 'draftkings'; })) },
        lead_lag: 'Moves ≥ 1 pp: Novig first ' + st.tally.novig_first + ', DraftKings first ' + st.tally.dk_first + ', undetermined ' + st.undetermined + '.' });
    }
    if (tpl === 'why_shopping') return Object.assign(base, { as_of: new Date().toISOString(), examples: cmps.filter(function (x) { return x.row && x.row.comparable; }).map(function (x) { var lb = label(x.r); return { comparable: true, observed: true, selection: lb.sel, line: lb.line || null, game: game, dk_american: x.c.top.book_american, novig_american: x.c.top.novig_american, better: x.row.better, implied_gap_pp: x.row.implied_gap_pp }; }) });
    return base;
  }

  /* ------------------------------------------------------------ events (delegated, once) */
  function rerender(eid) {
    if (!root.document) return;
    var el = document.getElementById('nvc-' + eid);
    if (!el) { repaint(); return; }
    var tmp = document.createElement('div');
    var g = S.ctx[eid];
    tmp.innerHTML = g ? sectionHTML(g.sport, g.g, g.t, g.ev, g.opts) : '';
    if (tmp.firstChild) el.replaceWith(tmp.firstChild);
  }
  S.ctx = {};
  function wire() {
    if (!root.document || root.__edNovigWired) return;
    root.__edNovigWired = true;
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-nvc-stake],[data-nvc-hist],[data-nvc-gfx]');
      if (!b) return;
      if (b.hasAttribute('data-nvc-stake')) { S.stake[b.getAttribute('data-nvc-ev')] = Number(b.getAttribute('data-nvc-stake')); S.open[b.getAttribute('data-nvc-ev')] = true; rerender(b.getAttribute('data-nvc-ev')); }
      else if (b.hasAttribute('data-nvc-hist')) {
        var id = b.getAttribute('data-nvc-hist'); b.disabled = true; b.textContent = 'loading…';
        rpc('novig_history', { p_odds_event_id: id }).then(function (rows) { S.hist[id] = { rows: rows || [] }; }, function (err) { S.hist[id] = { err: err.message }; }).then(function () { S.open[id] = true; rerender(id); });
      } else if (b.hasAttribute('data-nvc-gfx')) {
        var eid = b.getAttribute('data-nvc-gfx'), sel = document.querySelector('[data-nvc-tpl="' + eid + '"]'), tpl = sel ? sel.value : 'price_gap';
        var C = root.EDCompareCards, d = payload(tpl, eid);
        if (!C || !d) return;
        if (d.reason_missing) { S.msg[eid] = d.reason_missing; S.open[eid] = true; rerender(eid); return; }
        C.download(tpl, d).then(function (r) { S.msg[eid] = r.ok ? 'downloaded ' + r.file : 'not drawn: ' + r.reason; S.open[eid] = true; rerender(eid); });
      }
    });
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-nvc-custom')) {
        var v = Math.round(Number(t.value));
        if (v >= 1 && v <= 100000) { S.stake[t.getAttribute('data-nvc-custom')] = v; S.open[t.getAttribute('data-nvc-custom')] = true; rerender(t.getAttribute('data-nvc-custom')); }
      }
    });
    document.addEventListener('toggle', function (e) { var t = e.target; if (t && t.getAttribute && t.getAttribute('data-nvc-open')) S.open[t.getAttribute('data-nvc-open')] = t.open; }, true);
  }

  /** the card hook: '' for every reader who may not see Novig prices */
  function fbNovigHTML(sport, g, t, ev, opts) {
    try {
      if ((sport !== 'nfl' && sport !== 'cfb') || !g) return '';
      styles(); wire(); load();
      var eid = null; try { eid = ev && ev.rows && ev.rows[0] && ev.rows[0].event_id; } catch (_) { eid = null; }
      if (eid) S.ctx[eid] = { sport: sport, g: g, t: t, ev: ev, opts: opts };
      return sectionHTML(sport, g, t, ev, opts);
    } catch (_) { return ''; }
  }
  root.fbNovigHTML = fbNovigHTML;
  root.EDMarketCompareUI = { fbNovigHTML: fbNovigHTML, _state: S, _load: load, _payload: payload, _section: sectionHTML, STAKES: STAKES, NOVIG_PUBLIC_DISPLAY_ENABLED: NOVIG_PUBLIC_DISPLAY_ENABLED };
})(typeof globalThis !== 'undefined' ? globalThis : this);
