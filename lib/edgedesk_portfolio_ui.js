/* ===========================================================================
   EDGEDESK PORTFOLIO — the page.
   docs/portfolio-architecture.md

   Overview · Open · History · Analytics · Accounts · Import, inside the app's
   own #portfolio view. It answers one question first — am I up or down? —
   and everything else after it.

   WHAT THIS FILE DOES NOT DO
     - compute money. Every figure is either a column the database derived
       (supabase/portfolio.sql) or EDPortfolio arithmetic over those columns;
       the forms preview with the same EDPortfolio.derive() the database
       mirrors, so the preview is what will be stored;
     - claim a connection. Only an account the server connected through a real
       integration can read "Connected"; today none can;
     - keep money in the browser. Positions are read with the reader's own
       token under row level security and held in memory only — nothing
       financial is written to localStorage;
     - nudge. No streaks, no "win it back", no deposit prompts: factual
       figures, the same way up or down.

   Browser: window.EDPortfolioUI.show(host).   Node: the render functions are
   exported pure, for tools/portfolio/portfolio_ui.test.js.
   =========================================================================== */
(function (root, factory) {
  var req = typeof require === 'function' ? require : null;
  var E = root.EDPortfolio || (req ? req('./edgedesk_portfolio.js') : null);
  var I = root.EDPortfolioImport || (req ? req('./edgedesk_portfolio_import.js') : null);
  var C = root.EDPortfolioConnectors || (req ? req('./edgedesk_portfolio_connectors.js') : null);
  var X = root.EDPortfolioProcess || (req ? req('./edgedesk_portfolio_process.js') : null);
  var J = root.EDPortfolioJournalUI || (req ? req('./edgedesk_portfolio_journal_ui.js') : null);
  var K = root.EDPortfolioConnect || (req ? req('./edgedesk_portfolio_connect_core.js') : null);
  var R = root.EDDecisionRecord || (req ? req('./edgedesk_decision_record.js') : null);
  var api = factory(root, E, I, C, X, J, K, R);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDPortfolioUI = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root, E, I, C, X, J, K, R) {
  'use strict';

  var VERSION = 'portfolio_ui_v2';
  /* the Portfolio page's tabs. The Process Coach is the same controller
     mounted coach-only in the app's Process seat (mount(host, { tabs:
     ['coach'], bare: true, name: 'Process' })): Portfolio is what you hold
     and how it went, Process is how you decide (docs/ia/NAVIGATION_AUDIT.md) */
  var TABS = [['overview', 'Overview'], ['calendar', 'Calendar'], ['journal', 'Journal'], ['open', 'Open'], ['history', 'History'],
    ['analytics', 'Analytics'], ['accounts', 'Accounts'], ['import', 'Import']];
  var TAB_LABEL = { coach: 'Coach' };
  TABS.forEach(function (t) { TAB_LABEL[t[0]] = t[1]; });
  var PERIOD_LABEL = { '7D': 'last 7 days', '30D': 'last 30 days', YTD: 'this year', ALL: 'all time' };
  var PERIODS = [['7D', '7D'], ['30D', '30D'], ['YTD', 'YTD'], ['ALL', 'All']];
  var SPORTS = ['NFL', 'CFB', 'NBA', 'CBB', 'WNBA', 'MLB', 'NHL', 'UFC', 'Soccer', 'Tennis', 'Golf'];
  var WAGER_TYPES = ['MONEYLINE', 'SPREAD', 'TOTAL', 'PLAYER_PROP', 'PARLAY', 'SAME_GAME_PARLAY', 'FUTURE', 'OTHER'];
  var STATUS_LABEL = { OPEN: 'Open', WON: 'Won', LOST: 'Lost', PUSH: 'Push', VOID: 'Void', CASHED_OUT: 'Cashed out', SETTLED: 'Settled' };
  var RESULT_LABEL = { WIN: 'Win', LOSS: 'Loss', PUSH: 'Push', VOID: 'Void', CASHOUT: 'Cash-out' };
  var SOURCE_LABEL = { MANUAL: 'Manual', CSV: 'CSV import', SYNC: 'Synced', EDGEDESK: 'EdgeDesk' };
  var EDGE_LABEL = { EDGEDESK: 'EdgeDesk research', SELF: 'My own read', OTHER: 'Other' };
  var NUMS = ['line', 'odds_decimal', 'stake', 'reported_payout', 'fees', 'current_price', 'settlement_price', 'contracts', 'contracts_bought',
    'contracts_sold', 'average_entry_price', 'average_exit_price', 'sell_proceeds', 'cost_basis', 'open_cost_basis', 'potential_profit',
    'potential_payout', 'current_value', 'gross_payout', 'realized_profit_loss', 'unrealized_profit_loss', 'profit_loss', 'model_probability'];
  /* numeric columns are asked for as text, so no amount ever passes through a float */
  var POSITION_SELECT = ['id', 'platform', 'platform_label', 'platform_type', 'platform_account_id', 'position_type', 'sport', 'league',
    'event_name', 'event_id', 'event_start_at', 'market_name', 'selection', 'side', 'odds_american', 'resolution', 'status', 'result',
    'placed_at', 'settled_at', 'current_price_at', 'source', 'import_id', 'notes', 'edge_source', 'edge_ref_type', 'edge_ref_id',
    'model_version', 'external_position_id', 'created_at', 'updated_at'].concat(NUMS.map(function (c) { return c + '::text'; })).join(',');
  var PAGE = 1000;

  /* ═══ small helpers ═══════════════════════════════════════════════════ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function tone(x) { return 'pfo-' + E.tone(x); }
  /* time-to-value evidence (supabase/funnel.sql): a name and an entity, never a figure */
  function ttv(name, props) { try { if (root.EDTrack && root.EDTrack.event) root.EDTrack.event(name, props || {}); } catch (_) { /* never in the way */ } }
  function signed(x) { return '<span class="pfo-num ' + tone(x) + '">' + esc(E.money(x, { sign: true })) + '</span>'; }
  function dateText(iso, withTime, tz) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '—';
    try {
      var o = { month: 'short', day: 'numeric', year: 'numeric' };
      if (withTime) { o.hour = 'numeric'; o.minute = '2-digit'; }
      if (tz) o.timeZone = tz;
      return new Intl.DateTimeFormat('en-US', o).format(new Date(t));
    } catch (_) { return new Date(t).toISOString().slice(0, withTime ? 16 : 10).replace('T', ' '); }
  }
  /* a datetime-local value, read in the browser's own zone */
  function localInputToIso(v) {
    if (!v) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    return isFinite(d.getTime()) ? d.toISOString() : null;
  }
  function isoToLocalInput(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function isWager(p) { return p.platform_type === 'SPORTSBOOK'; }
  function priceOf(p) {
    if (!isWager(p)) return E.priceText(p.average_entry_price);
    return p.odds_american != null ? E.americanText(p.odds_american) : (p.odds_decimal ? E.americanText(E.decimalToAmerican(p.odds_decimal)) + ' (' + esc(E.dec.str(p.odds_decimal)) + ')' : '—');
  }
  function sel(name, options, value, attrs) {
    return '<select name="' + esc(name) + '"' + (attrs || '') + '>' + options.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
      return '<option value="' + esc(v) + '"' + (String(v) === String(value == null ? '' : value) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('') + '</select>';
  }
  function fld(label, inner, cls, hint) {
    return '<label class="pfo-fld' + (cls ? ' ' + cls : '') + '"><span>' + esc(label) + (hint ? ' <em>' + esc(hint) + '</em>' : '') + '</span>' + inner + '</label>';
  }
  function input(name, value, attrs) { return '<input name="' + esc(name) + '" value="' + esc(value == null ? '' : value) + '"' + (attrs || '') + '>'; }
  function platformOptions(type, value) {
    var opts = E.PLATFORMS.filter(function (p) { return p.type === type; }).map(function (p) { return [p.key, p.label]; });
    if (value && !E.platform(value) && value !== '__other') opts.push([value, E.platformLabel(value)]);
    opts.push(['__other', 'Other…']);
    return [['', 'Choose…']].concat(opts);
  }
  function friendly(err) {
    var b = err && err.pg, msg = b && b.message ? String(b.message) : '', code = b && b.code;
    if (code === '23505' && /fingerprint_once/.test(msg + (b.details || ''))) return { dup: true, text: 'This matches a position you already recorded (same platform, event, pick, price, stake and time).' };
    if (code === '23505' && /external_once/.test(msg + (b.details || ''))) return { text: 'A position with the same platform bet id is already recorded.' };
    if (/^portfolio: /.test(msg)) return { text: msg.replace(/^portfolio: /, '').replace(/^./, function (c) { return c.toUpperCase(); }) + '.' };
    if (code === '23514') return { text: 'That entry did not pass the database’s checks. Review the amounts and dates.' };
    if (code === '42501' || (err && err.status === 401)) return { text: 'Your session does not allow that. Sign in again if this keeps happening.' };
    if (err && err.status === 404) return { text: 'Portfolio is not installed on this database yet (supabase/portfolio.sql).' };
    return { text: 'Could not reach the database' + (err && err.status ? ' (' + err.status + ')' : '') + '. Nothing was changed.' };
  }

  /* ═══ the database, under the reader's own token ═════════════════════ */
  function makeApi(deps) {
    deps = deps || {};
    async function token() {
      if (deps.token) return deps.token();
      try { if (typeof root.edToken === 'function') return await root.edToken(); } catch (_) { /* fall through */ }
      return root.SB_KEY;
    }
    async function call(path, opts) {
      opts = opts || {};
      var url = deps.url || root.SB_URL, key = deps.key || root.SB_KEY, f = deps.fetch || root.fetch;
      if (!url || !f) { var e0 = new Error('no database'); e0.status = 0; throw e0; }
      var h = { apikey: key, authorization: 'Bearer ' + (await token()) };
      if (opts.body !== undefined) h['content-type'] = 'application/json';
      if (opts.prefer) h.prefer = opts.prefer;
      var r = await f(url + '/rest/v1/' + path, { method: opts.method || 'GET', headers: h, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
      var txt = await r.text();
      if (!r.ok) {
        var e = new Error('db ' + r.status); e.status = r.status;
        try { e.pg = JSON.parse(txt); } catch (_) { e.pg = null; }
        throw e;
      }
      return txt ? JSON.parse(txt) : null;
    }
    function rpc(fn, args) { return call('rpc/' + fn, { method: 'POST', body: args }); }
    return {
      call: call,
      /* every open position, and the most recent settled ones for History:
         the dashboard itself is computed on the server, never from a
         downloaded lifetime (older history lives in the Journal's folders) */
      positions: async function () {
        var open = [], off = 0;
        for (;;) {
          var page = await call('portfolio_positions?select=' + POSITION_SELECT + '&status=eq.OPEN&order=placed_at.desc,id.asc&limit=' + PAGE + '&offset=' + off) || [];
          open = open.concat(page);
          if (page.length < PAGE || open.length >= 20000) break;
          off += PAGE;
        }
        var settled = await call('portfolio_positions?select=' + POSITION_SELECT + '&status=neq.OPEN&order=settled_at.desc,id.asc&limit=' + PAGE) || [];
        var all = open.concat(settled);
        all.historyCapped = settled.length >= PAGE;
        return all;
      },
      summary: function (from, to, tz, platform) { return rpc('portfolio_summary', { p_from: from, p_to: to, p_tz: tz, p_platform: platform || null }); },
      cells: function (from, to, tz, platform, segs) { return rpc('portfolio_cells', { p_from: from, p_to: to, p_tz: tz, p_platform: platform || null, p_segments: !!segs }); },
      calendar: function (from, to, tz, platform) { return rpc('portfolio_calendar', { p_from: from, p_to: to, p_tz: tz, p_platform: platform || null }); },
      periods: function (tz, year, platform) { return rpc('portfolio_periods', { p_tz: tz, p_year: year == null ? null : year, p_platform: platform || null }); },
      list: function (from, to, tz, filter, limit, platform) {
        return rpc('portfolio_list', { p_from: from, p_to: to, p_tz: tz, p_filter: filter || {}, p_limit: limit || 100, p_platform: platform || null });
      },
      preBet: function (draft, tz) { return rpc('portfolio_pre_bet', { p: draft, p_tz: tz }); },
      journal: async function (id) { var r = await call('portfolio_journal_entries?select=*&position_id=eq.' + encodeURIComponent(id)); return (r && r[0]) || null; },
      updateJournal: function (id, patch) { return call('portfolio_journal_entries?position_id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: patch, prefer: 'return=minimal' }); },
      rules: function () { return call('portfolio_rules?select=*&order=active_from.desc'); },
      addRule: function (row) { return call('portfolio_rules', { method: 'POST', body: row, prefer: 'return=minimal' }); },
      retireRule: function (id) { return call('portfolio_rules?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: { active_until: new Date().toISOString() }, prefer: 'return=minimal' }); },
      experiments: function () { return call('portfolio_experiments?select=*&order=starts_at.desc'); },
      addExperiment: function (row) { return call('portfolio_experiments', { method: 'POST', body: row, prefer: 'return=minimal' }); },
      endExperiment: function (id) { return call('portfolio_experiments?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: { status: 'ENDED' }, prefer: 'return=minimal' }); },
      accounts: function () { return call('portfolio_account_summary?select=*&order=created_at.asc'); },
      /* automatic connections: what is switched on, each account's schedule, its sync log */
      registry: function () { return call('portfolio_platform_registry?select=platform_key,automatic_enabled,automatic_method,import_verified'); },
      connections: function () { return call('platform_accounts?select=id,next_sync_at,consecutive_failures'); },
      runs: function () { return call('portfolio_sync_runs?select=id,platform_account_id,platform,kind,status,started_at,finished_at,positions_inserted,positions_updated,transactions_inserted,rejected,issues,reconcile,error_code,error_message&order=started_at.desc&limit=40'); },
      isAdmin: function () { return rpc('portfolio_is_admin', {}); },
      adminHealth: function () { return rpc('portfolio_admin_connector_health', { p_hours: 24 }); },
      adminTtv: function () { return rpc('portfolio_admin_ttv', { p_days: 30 }); },
      /* the connector edge function, under the reader's own token; its answer
         (ok or not) always comes back as { ok, reason, message } */
      connectFn: async function (body) {
        var url = deps.url || root.SB_URL, key = deps.key || root.SB_KEY, f = deps.fetch || root.fetch;
        if (!url || !f) return { ok: false, reason: 'no_server', message: 'Automatic connection is not available here.' };
        var r;
        try { r = await f(url + '/functions/v1/portfolio_connect', { method: 'POST', headers: { apikey: key, authorization: 'Bearer ' + (await token()), 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
        catch (_) { return { ok: false, reason: 'offline', message: 'EdgeDesk could not be reached. Nothing was changed.' }; }
        var out = null;
        try { out = await r.json(); } catch (_) { out = null; }
        if (r.status === 404 && !(out && out.reason)) return { ok: false, reason: 'not_deployed', message: 'Automatic connection is not available on this server yet.' };
        return out || { ok: false, reason: 'failed', message: 'Something went wrong. Nothing was changed.' };
      },
      imports: function () { return call('portfolio_imports?select=id,file_name,platform_type,status,rows_total,rows_imported,rows_updated,rows_skipped,rows_failed,created_at,committed_at&order=created_at.desc&limit=10'); },
      /* the last committed import of a file with the same columns: how it was read */
      rememberedImport: async function (signature) {
        if (!signature) return null;
        var r = await call('portfolio_imports?select=importer,column_map,platform,timezone,committed_at&header_signature=eq.' + encodeURIComponent(signature)
          + '&status=eq.COMMITTED&order=committed_at.desc&limit=1');
        return (r && r[0]) || null;
      },
      fills: function (id) {
        return call('portfolio_transactions?select=id,transaction_type,side,quantity::text,price::text,amount::text,fee::text,executed_at,source,external_transaction_id&position_id=eq.' + encodeURIComponent(id) + '&order=executed_at.asc');
      },
      createWager: function (row) { return call('portfolio_positions?select=id', { method: 'POST', body: row, prefer: 'return=representation' }); },
      updatePosition: function (id, patch) { return call('portfolio_positions?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: patch, prefer: 'return=minimal' }); },
      deletePosition: function (id) { return call('portfolio_positions?id=eq.' + encodeURIComponent(id), { method: 'DELETE', prefer: 'return=minimal' }); },
      recordPrediction: function (p) { return rpc('portfolio_record_prediction', { p: p }); },
      /* the Decision Record (supabase/portfolio_decision.sql) */
      snapshot: function (row) { return call('portfolio_decision_snapshots', { method: 'POST', body: row, prefer: 'return=minimal' }); },
      decisionRecord: function (id, tz) { return rpc('portfolio_decision_record', { p_position: id, p_tz: tz }); },
      search: function (q, n) { return rpc('portfolio_search', { p_q: q, p_limit: n || 20 }); },
      classifyOutcomes: function (tz) { return rpc('portfolio_classify_outcomes', { p_tz: tz }); },
      baseline: function (tz) { return rpc('portfolio_baseline', { p_tz: tz }); },
      observeInsight: function (f, from, to, tz) {
        return rpc('portfolio_observe_insight', { p_dim: f.dim, p_key: f.key, p_metric: f.metric, p_kind: f.kind, p_label: f.label, p_from: from, p_to: to, p_tz: tz });
      },
      insightMemory: function () { return rpc('portfolio_insight_memory', {}); },
      experimentEvidence: function (id) { return rpc('portfolio_experiment_evidence', { p_id: id }); },
      concludeExperiment: function (id, test) { return rpc('portfolio_conclude_experiment', { p_id: id, p_test: test }); },
      reflectExperiment: function (id, text) { return call('portfolio_experiments?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: { reflection: text }, prefer: 'return=minimal' }); },
      cardEvent: function (entryId, event, detail) {
        return call('portfolio_card_events', { method: 'POST', body: { entry_id: String(entryId).slice(0, 120), event: event, detail: detail || {} }, prefer: 'return=minimal' });
      },
      dueNotices: function () { return rpc('portfolio_due_notices', {}); },
      exportAll: function () { return rpc('portfolio_export', {}); },
      deleteEverything: function (phrase) { return rpc('portfolio_delete_everything', { p_confirm: phrase }); },
      addFill: function (row) { return call('portfolio_transactions', { method: 'POST', body: row, prefer: 'return=minimal' }); },
      deleteFill: function (id) { return call('portfolio_transactions?id=eq.' + encodeURIComponent(id), { method: 'DELETE', prefer: 'return=minimal' }); },
      createAccount: function (row) { return call('platform_accounts', { method: 'POST', body: row, prefer: 'return=minimal' }); },
      renameAccount: function (id, name) { return call('platform_accounts?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: { display_name: name || null }, prefer: 'return=minimal' }); },
      deleteAccount: function (id) { return call('platform_accounts?id=eq.' + encodeURIComponent(id), { method: 'DELETE', prefer: 'return=minimal' }); },
      createImport: async function (meta) { var r = await call('portfolio_imports?select=id', { method: 'POST', body: meta, prefer: 'return=representation' }); return r && r[0] && r[0].id; },
      stageRows: async function (importId, rows) {
        for (var i = 0; i < rows.length; i += 500) {
          await call('portfolio_import_rows', { method: 'POST', prefer: 'return=minimal', body: rows.slice(i, i + 500).map(function (r) {
            return { import_id: importId, row_number: r.row_number, raw: r.raw, normalized: r.normalized, issues: r.issues };
          }) });
        }
      },
      classify: function (id) { return rpc('portfolio_import_classify', { p_import: id }); },
      importRows: function (id) { return call('portfolio_import_rows?select=id,row_number,classification,issues,normalized,decision,outcome,outcome_message&import_id=eq.' + encodeURIComponent(id) + '&order=row_number.asc&limit=5000'); },
      setDecision: function (id, decision) { return call('portfolio_import_rows?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: { decision: decision }, prefer: 'return=minimal' }); },
      commit: function (id) { return rpc('portfolio_import_commit', { p_import: id, p_max: 1000 }); },
      /* the reader's own EdgeDesk records, to link a position to — best effort:
         a deployment without these tables simply offers no link */
      edgeRecords: async function () {
        var out = [];
        try {
          (await call('stake_recommendations?select=recommendation_id,matchup,selection,odds_american::text,book,model_version,model_probability::text,built_at&order=built_at.desc&limit=25') || [])
            .forEach(function (r) { out.push({ type: 'stake_recommendation', id: r.recommendation_id, label: [r.selection, r.matchup].filter(Boolean).join(' · ') || r.recommendation_id, at: r.built_at, model_version: r.model_version, model_probability: r.model_probability }); });
        } catch (_) { /* not installed */ }
        try {
          (await call('research_journal?select=entry_id,away,home,selection,market_type,created_at&order=created_at.desc&limit=25') || [])
            .forEach(function (r) { out.push({ type: 'research_journal', id: r.entry_id, label: [r.selection, (r.away && r.home) ? r.away + ' @ ' + r.home : null].filter(Boolean).join(' · ') || 'Journal entry', at: r.created_at }); });
        } catch (_) { /* not installed */ }
        return out;
      }
    };
  }

  /* ═══ forms → normalized rows (pure) ═════════════════════════════════ */
  function platformFrom(v, type) {
    if (v.platform === '__other') {
      var label = String(v.platform_other || '').trim().slice(0, 60);
      return { platform: E.customPlatformKey(label), platform_label: label };
    }
    var p = E.platform(v.platform);
    return { platform: v.platform || null, platform_label: p ? p.label : (v.platform_label || E.platformLabel(v.platform)) };
  }
  function blank(x) { return x == null || String(x).trim() === ''; }
  function attribution(v, recs) {
    var o = { edge_source: blank(v.edge_source) ? null : v.edge_source, edge_ref_type: null, edge_ref_id: null };
    if (o.edge_source === 'EDGEDESK' && !blank(v.edge_ref)) {
      var i = String(v.edge_ref).indexOf(':'), type = String(v.edge_ref).slice(0, i), id = String(v.edge_ref).slice(i + 1);
      o.edge_ref_type = type; o.edge_ref_id = id;
      var rec = (recs || []).filter(function (r) { return r.type === type && String(r.id) === id; })[0];
      if (rec && rec.model_version) o.model_version = rec.model_version;
      if (rec && rec.model_probability) o.model_probability = rec.model_probability;
    }
    return o;
  }
  /* the sportsbook form → a portfolio_positions insert */
  function wagerFromForm(v, recs) {
    var pl = platformFrom(v), type = v.position_type || 'OTHER', status = v.status || 'OPEN';
    var row = { platform: pl.platform, platform_label: pl.platform_label, platform_type: 'SPORTSBOOK', position_type: type,
      sport: blank(v.sport) ? null : String(v.sport).trim(), league: blank(v.league) ? null : String(v.league).trim(),
      event_name: String(v.event_name || '').trim(), market_name: String(v.market_name || '').trim() || E.POSITION_TYPE_LABEL[type],
      selection: String(v.selection || '').trim(), line: null, odds_american: null, odds_decimal: null, stake: null,
      status: status, reported_payout: null, fees: '0', placed_at: localInputToIso(v.placed_at), settled_at: null,
      event_start_at: blank(v.event_start_at) ? null : localInputToIso(v.event_start_at), stake_type: v.stake_type === 'BONUS' ? 'BONUS' : 'CASH',
      notes: blank(v.notes) ? null : String(v.notes).trim().slice(0, 2000) };
    var issues = [];
    if (!blank(v.line)) { var ln = I.readNumber(v.line); if (ln.error) issues.push({ level: 'error', code: 'BAD_LINE', message: 'The line is not a number.' }); else row.line = ln.value; }
    var od = I.readOdds(v.odds, v.odds_format === 'decimal');
    if (od.american != null) row.odds_american = od.american; else if (od.decimal) row.odds_decimal = od.decimal;
    var st = I.readMoney(v.stake); if (st.value) row.stake = st.value;
    if (status !== 'OPEN') {
      row.settled_at = localInputToIso(v.settled_at || v.placed_at) || null;
      if (!blank(v.reported_payout)) { var rp = I.readMoney(v.reported_payout); if (rp.value != null) row.reported_payout = rp.value; else issues.push({ level: 'error', code: 'BAD_PAYOUT', message: 'The payout is not an amount.' }); }
    }
    if (!blank(v.fees)) { var fe = I.readMoney(v.fees); if (fe.value != null) row.fees = fe.value; else issues.push({ level: 'error', code: 'BAD_FEES', message: 'Fees are not an amount.' }); }
    var at = attribution(v, recs);
    Object.keys(at).forEach(function (k) { row[k] = at[k]; });
    if (pl.platform == null) issues.push({ level: 'error', code: 'BAD_PLATFORM', message: 'Choose the sportsbook, or name it under Other.' });
    return { row: row, issues: issues.concat(E.validateWager(row)) };
  }
  /* the prediction-market form → the record_prediction payload */
  function predictionFromForm(v, recs) {
    var pl = platformFrom(v), side = v.side === '__other' ? String(v.side_other || '').trim() : (v.side || '');
    var event = String(v.event_name || '').trim();
    var p = { platform: pl.platform, platform_label: pl.platform_label, position_type: v.position_type || 'EVENT_CONTRACT',
      sport: blank(v.sport) ? null : String(v.sport).trim(), league: blank(v.league) ? null : String(v.league).trim(),
      event_name: event, market_name: String(v.market_name || '').trim() || event, side: side, selection: side,
      current_price: null, resolution: null, settled_at: null, event_start_at: blank(v.event_start_at) ? null : localInputToIso(v.event_start_at),
      notes: blank(v.notes) ? null : String(v.notes).trim().slice(0, 2000), fills: [] };
    var issues = [];
    var q = I.readNumber(v.contracts), pr = I.readPrice(v.price), fe = blank(v.fees) ? { value: '0' } : I.readMoney(v.fees);
    var buy = { action: 'BUY', quantity: q.value, price: pr.value, fee: fe.value, executed_at: localInputToIso(v.placed_at) };
    p.fills.push(buy);
    if (fe.error) issues.push({ level: 'error', code: 'BAD_FEES', message: 'Fees are not an amount.' });
    var state = v.state || 'OPEN';
    if (state === 'OPEN' && !blank(v.current_price)) {
      var cp = I.readPrice(v.current_price);
      if (cp.value != null) p.current_price = cp.value; else issues.push({ level: 'error', code: 'BAD_CURRENT_PRICE', message: 'The current price is between $0.00 and $1.00.' });
    }
    if (state === 'RESOLVED') {
      p.resolution = v.resolution === '__side' ? side : (v.resolution || null);
      if (!p.resolution) issues.push({ level: 'error', code: 'NO_RESOLUTION', message: 'Choose how the market resolved.' });
      p.settled_at = localInputToIso(v.settled_at || v.placed_at) || null;
    }
    if (state === 'SOLD') {
      var xp = I.readPrice(v.exit_price), xf = blank(v.exit_fees) ? { value: '0' } : I.readMoney(v.exit_fees);
      var sell = { action: 'SELL', quantity: q.value, price: xp.value, fee: xf.value, executed_at: localInputToIso(v.settled_at) || buy.executed_at };
      if (xp.value == null) issues.push({ level: 'error', code: 'BAD_EXIT_PRICE', message: 'Enter the price you sold at.' });
      p.fills.push(sell);
    }
    var at = attribution(v, recs);
    Object.keys(at).forEach(function (k) { p[k] = at[k]; });
    if (pl.platform == null) issues.push({ level: 'error', code: 'BAD_PLATFORM', message: 'Choose the platform, or name it under Other.' });
    p.fills.forEach(function (f) {
      E.validateFill(Object.assign({ platform: p.platform, event_name: p.event_name, market_name: p.market_name, side: p.side }, f)).forEach(function (x) {
        if (!issues.some(function (y) { return y.code === x.code; })) issues.push(x);
      });
    });
    return { payload: p, issues: issues };
  }
  /* what the form will store, before it is stored: the same derive() */
  function wagerPreview(row) {
    if (!row.stake || (row.odds_american == null && !row.odds_decimal)) return '<div class="pfo-preview pfo-mut">Enter the odds and the stake to see the payout.</div>';
    var d = E.derive(row);
    var h = 'Risk <b>' + esc(E.money(row.stake)) + '</b> · to win <b>' + esc(E.money(d.potential_profit)) + '</b> · payout <b>' + esc(E.money(d.potential_payout)) + '</b>';
    if (d.profit_loss != null) h += '<br>Settled: returned <b>' + esc(E.money(d.gross_payout)) + '</b> · P&amp;L ' + signed(d.profit_loss);
    else if (row.status && row.status !== 'OPEN') h += '<br><span class="pfo-warn">Enter the amount the book paid.</span>';
    return '<div class="pfo-preview" data-r="preview">' + h + '</div>';
  }
  function predictionPreview(p) {
    var d = E.derive({ platform_type: 'PREDICTION_MARKET', side: p.side, resolution: p.resolution, current_price: p.current_price },
      p.fills.filter(function (f) { return f.quantity && f.price != null; }).map(function (f) { return { transaction_type: f.action, quantity: f.quantity, price: f.price, fee: f.fee }; }));
    if (!d.contracts_bought || E.dec.sign(d.contracts_bought) <= 0) return '<div class="pfo-preview pfo-mut">Enter contracts and an entry price to see the cost.</div>';
    var h = 'Cost basis <b>' + esc(E.money(d.cost_basis)) + '</b> · average entry <b>' + esc(E.priceText(d.average_entry_price)) + '</b>';
    if (E.dec.sign(d.fees) > 0) h += ' · fees <b>' + esc(E.money(d.fees)) + '</b>';
    if (d.status === 'OPEN') {
      h += '<br>If it resolves ' + esc(p.side || 'your way') + ': pays <b>' + esc(E.money(d.potential_payout)) + '</b>, profit ' + signed(E.dec.sub(d.potential_profit, d.fees));
      if (d.unrealized_profit_loss != null) h += '<br>At your mark: worth <b>' + esc(E.money(d.current_value)) + '</b> · unrealized ' + signed(d.unrealized_profit_loss);
    } else h += '<br>Settled: returned <b>' + esc(E.money(d.gross_payout)) + '</b> · P&amp;L ' + signed(d.profit_loss);
    return '<div class="pfo-preview" data-r="preview">' + h + '</div>';
  }

  /* ═══ renderers (pure: state in, HTML out) ═══════════════════════════ */
  function shell(S) {
    /* a bare mount (the Process seat) lives under the app's own heading */
    if (S.bare) return '<div data-r="body"></div><div class="pfo-sheet" data-r="sheet" hidden></div>';
    return '<div class="pfo-head"><div class="pfo-title">' + esc(S.name || 'Portfolio') + '</div>'
      + '<button class="pfo-btn" data-act="add">+ Add position</button></div>'
      + '<nav class="pfo-tabs" role="tablist" aria-label="' + esc(S.name || 'Portfolio') + ' sections">' + (S.tabs || TABS).map(function (t) {
        return '<button class="pfo-tab" role="tab" data-act="tab" data-v="' + t[0] + '" aria-selected="' + (S.tab === t[0]) + '">' + t[1] + '</button>';
      }).join('') + '</nav><div data-r="body"></div><div class="pfo-sheet" data-r="sheet" hidden></div>';
  }
  /* Process with no history to read: how to give it some, and nothing invented */
  function emptyProcess() {
    return '<div class="pfo-empty"><b>Nothing to grade yet.</b> Process grades the positions in your Portfolio, so it starts once you have some: '
      + 'connect or import where you bet. Nothing here is sample data.'
      + '<div class="pfo-btns"><button class="pfo-btn" data-act="tab" data-v="accounts">Connect accounts</button>'
      + '<button class="pfo-btn ghost" data-act="tab" data-v="import">Import a CSV</button></div></div>';
  }
  /* An empty book is the first thing a new reader sees on a primary destination
     (docs/ia/NAVIGATION_AUDIT.md), so it says how to build one, not that it is
     empty: connect or import where you bet, or record by hand. */
  function emptyBook() {
    return '<div class="pfo-empty"><b>Build your portfolio.</b> Connect or import where you bet or trade to see your P&amp;L, your history and your performance — or record a sportsbook bet or a prediction-market position by hand. '
      + 'Every figure here is computed from what you record; nothing is sample data.'
      + '<div class="pfo-btns"><button class="pfo-btn" data-act="tab" data-v="accounts">Connect accounts</button>'
      + '<button class="pfo-btn ghost" data-act="tab" data-v="import">Import a CSV</button>'
      + '<button class="pfo-btn ghost" data-act="new-wager">Record a sportsbook bet</button>'
      + '<button class="pfo-btn ghost" data-act="new-prediction">Record a prediction-market position</button></div></div>';
  }
  function chart(series, label) {
    if (!series || series.length < 2) return '<div class="pfo-note">The cumulative line appears once positions have settled on two different days.</div>';
    var W = 640, H = 170, L = 6, R = 6, T = 12, Bm = 12;
    /* plotting only: pixel positions, never money */
    var vals = [0].concat(series.map(function (s) { return Number(s.cumulative); }));
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    var x = function (i) { return L + (W - L - R) * i / (vals.length - 1); };
    var y = function (v) { return T + (H - T - Bm) * (hi - v) / (hi - lo); };
    var pts = vals.map(function (v, i) { return x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ');
    var last = series[series.length - 1];
    return '<svg class="pfo-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label + ': ' + E.money(last.cumulative, { sign: true }) + ' after ' + series.length + ' days with a settlement') + '">'
      + '<line class="ax" x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - Bm) + '" y2="' + (H - Bm) + '"/>'
      + '<line class="zero" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0).toFixed(1) + '" y2="' + y(0).toFixed(1) + '"/>'
      + '<polyline class="ln ' + (E.dec.sign(last.cumulative) < 0 ? 'down' : 'up') + '" points="' + pts + '"/></svg>'
      + '<div class="pfo-chart-x"><span>' + esc(series[0].date) + '</span><span>' + esc(last.date) + ' · <b class="' + tone(last.cumulative) + '">' + esc(E.money(last.cumulative, { sign: true })) + '</b></span></div>';
  }
  function rows(groups, opts) {
    opts = opts || {};
    var list = groups.filter(function (g) { return g.settled > 0 || (opts.withOpen && g.open > 0); });
    if (!list.length) return '<div class="pfo-note">Nothing settled yet.</div>';
    var max = list.reduce(function (m, g) { var v = Math.abs(Number(g.pnl)); return v > m ? v : m; }, 0) || 1;
    return '<div class="pfo-rows">' + list.map(function (g) {
      var w = Math.max(2, Math.round(100 * Math.abs(Number(g.pnl)) / max));
      return '<div class="pfo-row"><div class="pfo-row-n">' + esc(g.label) + '<small>' + g.settled + ' settled' + (g.open ? ' · ' + g.open + ' open' : '')
        + (g.roi != null ? ' · ROI ' + esc(E.pct(g.roi)) : '') + '</small></div>'
        + '<div class="pfo-row-v">' + signed(g.pnl) + '</div>'
        + '<div class="pfo-bar" aria-hidden="true"><i class="' + (E.dec.sign(g.pnl) < 0 ? 'down' : 'up') + '" style="width:' + w + '%"></i></div></div>';
    }).join('') + '</div>';
  }
  function overview(S) {
    var list = S.positions || [];
    if (!list.length) return emptyBook();
    var s = E.summarize(list, { tz: S.tz });
    var g = E.dec.sign(s.pnl), word = g > 0 ? 'Up' : g < 0 ? 'Down' : 'Even';
    var h = '<section class="pfo-hero ' + (g > 0 ? 'up' : g < 0 ? 'down' : '') + '" aria-label="Total profit and loss">'
      + '<div class="pfo-hero-ey">Total P&amp;L · settled positions</div>'
      + '<div class="pfo-big ' + tone(s.pnl) + '">' + esc(E.money(s.pnl, { sign: true })) + '</div>'
      + '<div class="pfo-hero-sub"><b>' + word + (g !== 0 ? ' ' + esc(E.money(E.dec.str(s.pnl).replace(/^-/, ''))) : '') + '</b> across '
      + s.settled + ' settled position' + (s.settled === 1 ? '' : 's') + ' on ' + s.byPlatform.filter(function (x) { return x.settled; }).length + ' platform'
      + (s.byPlatform.filter(function (x) { return x.settled; }).length === 1 ? '' : 's') + '.</div>'
      + '<div class="pfo-kpis">'
      + '<div><div class="pfo-k">ROI</div><div class="pfo-v ' + tone(s.roi) + '">' + esc(s.roi != null ? E.pct(s.roi) : '—') + '</div></div>'
      + '<div><div class="pfo-k">Capital deployed</div><div class="pfo-v">' + esc(E.money(s.capital)) + '</div></div>'
      + '<div><div class="pfo-k">Open exposure</div><div class="pfo-v">' + esc(E.money(s.openExposure)) + ' <small>' + s.open + ' open</small></div></div>'
      + '<div><div class="pfo-k">Record</div><div class="pfo-v">' + esc(E.recordText(s.record)) + (s.record.cashout ? ' <small>+' + s.record.cashout + ' cash-out</small>' : '') + '</div></div>'
      + '</div></section>';
    h += '<div class="pfo-split">' + ['SPORTSBOOK', 'PREDICTION_MARKET'].map(function (k) {
      var t = s.byType[k];
      return '<section class="pfo-sec"><div class="pfo-sec-h">' + (k === 'SPORTSBOOK' ? 'Sportsbook P&amp;L' : 'Prediction-market P&amp;L') + '</div>'
        + '<div class="pfo-split-v ' + tone(t.pnl) + '">' + esc(E.money(t.pnl, { sign: true })) + '</div>'
        + '<div class="pfo-split-s">' + t.settled + ' settled' + (t.roi != null ? ' · ROI ' + esc(E.pct(t.roi)) : '') + ' · ' + t.open + ' open'
        + (t.unrealized != null ? ' · unrealized ' + esc(E.money(t.unrealized, { sign: true })) : '') + '</div></section>';
    }).join('') + '</div>';
    h += '<section class="pfo-sec"><div class="pfo-sec-h">P&amp;L by platform</div>' + rows(s.byPlatform) + '</section>';
    h += '<section class="pfo-sec"><div class="pfo-sec-h">Cumulative P&amp;L</div>' + chart(s.series, 'Cumulative profit and loss') + '</section>';
    if (s.open) {
      h += '<section class="pfo-sec"><div class="pfo-sec-h">Open now<span class="pfo-right"><button class="pfo-btn ghost sm" data-act="tab" data-v="open">See open positions</button></span></div>'
        + '<div class="pfo-note"><b>' + s.open + '</b> open, <b>' + esc(E.money(s.openExposure)) + '</b> at risk at cost.'
        + (s.unrealized != null ? ' Marked to the prices you entered: <b>' + esc(E.money(s.unrealized, { sign: true })) + '</b> unrealized on ' + s.openMarked + '.' : '')
        + (E.dec.sign(s.openRealized) !== 0 ? ' Partial exits so far: <b>' + esc(E.money(s.openRealized, { sign: true })) + '</b> (counted in Total P&amp;L when the position closes).' : '')
        + '</div></section>';
    }
    return h;
  }
  function periodChips(S) {
    return '<div class="pfo-chips" role="group" aria-label="Period">' + PERIODS.map(function (p) {
      return '<button class="pfo-chip" data-act="period" data-v="' + p[0] + '" aria-pressed="' + (S.period === p[0]) + '">' + p[1] + '</button>';
    }).join('') + '</div>';
  }
  /* the Overview from the server's aggregates: P&L, ROI, the Decision Grade,
     then what is working and what is not — never from a downloaded lifetime */
  function overviewServer(S) {
    if (S.positions && !S.positions.length) return emptyBook();
    var h = '<div class="pfo-filters">' + J.platformChips(S.accounts, S.platform) + periodChips(S) + '</div>';
    if (S.sumError) return h + '<div class="pfo-note">' + esc(S.sumError) + '</div>' + overview(S);
    var sm = S.sum;
    if (!sm) return h + '<div class="pfo-empty">Loading your portfolio…</div>';
    if (!(S.positions || []).length && !+sm.settled.n && !+sm.open.n) return emptyBook();
    h += J.hero(sm, PERIOD_LABEL[S.period]);
    h += J.gradeCard(sm.process, { evidence: sm.evidence });
    h += '<div class="pfo-btns"><button class="pfo-btn ghost sm" data-act="tab" data-v="coach">How you decide: open Process ›</button></div>';
    if (S.analysis) h += J.insights(X.headlines(S.analysis));
    var plats = (sm.platforms || []).map(function (x) { return { label: x.label || E.platformLabel(x.platform, x.platform), pnl: String(x.pnl), settled: +x.n,
      roi: +x.staked > 0 ? E.dec.divRound(String(x.pnl), String(x.staked), 6) : null }; });
    if (plats.length) h += '<section class="pfo-sec"><div class="pfo-sec-h">P&amp;L by platform · ' + esc(PERIOD_LABEL[S.period]) + '</div>' + rows(plats) + '</section>';
    if (+sm.open.n) {
      h += '<section class="pfo-sec"><div class="pfo-sec-h">Open now<span class="pfo-right"><button class="pfo-btn ghost sm" data-act="tab" data-v="open">See open positions</button></span></div>'
        + '<div class="pfo-note"><b>' + sm.open.n + '</b> open, <b>' + esc(E.money(String(sm.open.exposure))) + '</b> at risk at cost'
        + (sm.open.unrealized != null ? '; marked to your prices: <b>' + esc(E.money(String(sm.open.unrealized), { sign: true })) + '</b> unrealized on ' + sm.open.marked + '.' : '.') + '</div></section>';
    }
    return h;
  }
  function analyticsServer(S) {
    var h = '<div class="pfo-filters">' + J.platformChips(S.accounts, S.platform) + periodChips(S) + '</div>';
    if (S.sumError || !S.cells) return h + (S.sumError ? analyticsView(S) : '<div class="pfo-empty">Loading…</div>');
    return h + '<div class="pfo-note">Every breakdown counts positions <b>entered</b> in ' + esc(PERIOD_LABEL[S.period]) + ', with the sample size on each figure. Tap a row to list its positions.</div>'
      + kindTable(S.cells) + [['platform', 'By platform'], ['sport', 'By sport'], ['league', 'By league'], ['position_type', 'By market type'], ['odds', 'By price range'],
        ['units', 'By stake size'], ['timing', 'By timing'], ['placed_dow', 'By day entered'], ['event_dow', 'By event day'], ['source', 'By how it was recorded'],
        ['decision_source', 'By decision source'], ['planned', 'Planned vs unplanned'], ['tag', 'By decision tag'], ['stake_type', 'Cash vs bonus'], ['evidence', 'By what EdgeDesk knows']]
        .map(function (d) { return J.breakdownTable(S.cells, d[0], d[1]); }).join('');
  }
  /* sportsbook · prediction market · combined, over the positions entered in the period */
  function kindTable(cells) {
    var by = {};
    (cells || []).forEach(function (c) { if (c.dim === 'platform_type' || c.dim === 'all') by[c.dim === 'all' ? 'ALL' : c.key] = c; });
    if (!by.ALL) return '';
    var cols = ['SPORTSBOOK', 'PREDICTION_MARKET', 'ALL'].map(function (k) {
      var c = by[k] || { n: 0, settled: 0, wins: 0, losses: 0, pnl: '0', staked: '0' }, wl = (+c.wins || 0) + (+c.losses || 0);
      return [signed(String(c.pnl == null ? '0' : c.pnl)), esc(+c.staked > 0 ? E.pct(E.dec.divRound(String(c.pnl), String(c.staked), 6)) : '—'), String(+c.n || 0), String(+c.settled || 0),
        esc((+c.wins || 0) + '-' + (+c.losses || 0)), esc(wl ? E.pct(E.dec.divRound(String(+c.wins || 0), String(wl), 6), 1, { plain: true }) : '—'), esc(E.money(String(c.staked == null ? '0' : c.staked)))];
    });
    var labels = ['P&amp;L', 'ROI', 'Entered', 'Settled', 'Record (W-L)', 'Win rate', 'Staked (settled)'];
    return '<section class="pfo-sec"><div class="pfo-sec-h">Sportsbook · prediction market · combined</div><div style="overflow-x:auto"><table class="pfo-cmp"><thead><tr><th></th><th>Sportsbook</th><th>Prediction</th><th>Combined</th></tr></thead><tbody>'
      + labels.map(function (l, i) { return '<tr><td>' + l + '</td><td>' + cols[0][i] + '</td><td>' + cols[1][i] + '</td><td><b>' + cols[2][i] + '</b></td></tr>'; }).join('')
      + '</tbody></table></div><div class="pfo-note">Win rate counts wins over wins and losses; pushes, voids and cash-outs are left out.</div></section>';
  }
  function liveSlot(p, S) {
    var fn = S && S.live;
    if (typeof fn !== 'function') return '';
    var v = null;
    try { v = fn(p); } catch (_) { v = null; }
    if (!v || v.current == null) return '';
    return '<div class="pfo-live"><span class="pfo-mut">' + esc(v.label || 'Live') + '</span> · current <b class="pfo-num">' + esc(v.current) + '</b>'
      + (v.line != null ? ' · line <b class="pfo-num">' + esc(v.line) + '</b>' : '') + (v.asOf ? ' <span class="pfo-mut">as of ' + esc(dateText(v.asOf, true)) + '</span>' : '') + '</div>';
  }
  function openCard(p, S) {
    var h = '<article class="pfo-card"><div class="pfo-card-top"><span class="pfo-plat">' + esc(p.platform_label) + '</span>'
      + '<span>' + esc([p.sport, E.POSITION_TYPE_LABEL[p.position_type]].filter(Boolean).join(' · ')) + '</span>'
      + '<span style="margin-left:auto">' + esc(dateText(p.placed_at)) + '</span></div>'
      + '<div class="pfo-event">' + esc(p.event_name) + (p.market_name && p.market_name !== p.event_name ? ' · ' + esc(p.market_name) : '') + '</div>';
    if (isWager(p)) {
      h += '<div class="pfo-sel">' + esc(p.selection) + '</div>'
        + '<div class="pfo-line pfo-num">' + esc(E.money(p.stake)) + ' @ ' + esc(priceOf(p)) + '</div>'
        + '<dl class="pfo-dl"><dt>Risk</dt><dd>' + esc(E.money(p.open_cost_basis)) + '</dd><dt>Potential profit</dt><dd>' + esc(E.money(p.potential_profit)) + '</dd>'
        + '<dt>Payout if it wins</dt><dd>' + esc(E.money(p.potential_payout)) + '</dd></dl>';
    } else {
      h += '<div class="pfo-sel">' + esc(p.side || p.selection) + '</div>'
        + '<dl class="pfo-dl"><dt>Contracts</dt><dd>' + esc(E.qtyText(p.contracts)) + '</dd><dt>Average entry</dt><dd>' + esc(E.priceText(p.average_entry_price)) + '</dd>'
        + '<dt>Cost basis</dt><dd>' + esc(E.money(p.open_cost_basis)) + '</dd>'
        + (p.current_value != null ? '<dt>Current value</dt><dd>' + esc(E.money(p.current_value)) + '</dd><dt>Unrealized P&amp;L</dt><dd>' + signed(p.unrealized_profit_loss) + '</dd>'
          : '<dt>Current value</dt><dd class="pfo-mut">no mark entered</dd>')
        + (p.contracts_sold && E.dec.sign(p.contracts_sold) > 0 ? '<dt>Realized so far</dt><dd>' + signed(p.realized_profit_loss) + '</dd>' : '')
        + '</dl>' + (p.current_price_at ? '<div class="pfo-note">Mark of ' + esc(E.priceText(p.current_price)) + ' entered ' + esc(dateText(p.current_price_at, true)) + '.</div>' : '');
    }
    h += liveSlot(p, S);
    return h + '<div class="pfo-card-act"><button class="pfo-btn ghost sm" data-act="edit" data-id="' + esc(p.id) + '">' + (p.source === 'SYNC' ? 'Details' : 'Edit / settle') + '</button></div></article>';
  }
  function filterOpen(S) {
    var f = S.openFilter, now = S.now || Date.now();
    return (S.positions || []).filter(function (p) {
      if (p.status !== 'OPEN') return false;
      if (f.kind !== 'ALL' && p.platform_type !== f.kind) return false;
      if (f.platform && p.platform !== f.platform) return false;
      if (f.sport && String(p.sport || '').toUpperCase() !== f.sport) return false;
      if (f.placed && Date.parse(p.placed_at) < now - (+f.placed) * 86400000) return false;
      return true;
    });
  }
  function distinct(list, fn) {
    var seen = {}, out = [];
    list.forEach(function (p) { var k = fn(p); if (k && !seen[k[0]]) { seen[k[0]] = 1; out.push(k); } });
    return out.sort(function (a, b) { return String(a[1]).localeCompare(String(b[1])); });
  }
  function openView(S) {
    var all = (S.positions || []).filter(function (p) { return p.status === 'OPEN'; });
    if (!all.length) return '<div class="pfo-empty">No open positions. ' + ((S.positions || []).length ? 'Everything you recorded has settled.' : '') + '</div>' + ((S.positions || []).length ? '' : emptyBook());
    var f = S.openFilter, list = filterOpen(S);
    var h = '<div class="pfo-filters"><div class="pfo-chips" role="group" aria-label="Kind">' + [['ALL', 'All'], ['SPORTSBOOK', 'Sportsbook'], ['PREDICTION_MARKET', 'Prediction market']].map(function (k) {
      return '<button class="pfo-chip" data-act="open-kind" data-v="' + k[0] + '" aria-pressed="' + (f.kind === k[0]) + '">' + k[1] + '</button>';
    }).join('') + '</div>'
      + sel('platform', [['', 'All platforms']].concat(distinct(all, function (p) { return [p.platform, p.platform_label]; })), f.platform, ' data-f="open" aria-label="Platform"')
      + sel('sport', [['', 'All sports']].concat(distinct(all, function (p) { return p.sport ? [String(p.sport).toUpperCase(), String(p.sport).toUpperCase()] : null; })), f.sport, ' data-f="open" aria-label="Sport"')
      + sel('placed', [['', 'Any date'], ['1', 'Placed today'], ['7', 'Last 7 days'], ['30', 'Last 30 days']], f.placed, ' data-f="open" aria-label="Placed"') + '</div>';
    var s = E.summarize(list, {});
    h += '<div class="pfo-note"><b>' + list.length + '</b> open · <b>' + esc(E.money(s.openExposure)) + '</b> at risk'
      + (s.unrealized != null ? ' · unrealized <b>' + esc(E.money(s.unrealized, { sign: true })) + '</b> on ' + s.openMarked + ' marked' : '') + '</div>';
    list.sort(function (a, b) { return (Date.parse(a.event_start_at || a.placed_at) || 0) - (Date.parse(b.event_start_at || b.placed_at) || 0); });
    return h + '<div class="pfo-cards" style="margin-top:10px">' + (list.length ? list.map(function (p) { return openCard(p, S); }).join('') : '<div class="pfo-empty">Nothing matches these filters.</div>') + '</div>';
  }
  function filterHistory(S) {
    var f = S.histFilter, q = String(f.q || '').toLowerCase().trim();
    var from = f.from ? Date.parse(f.from + 'T00:00:00') : null, to = f.to ? Date.parse(f.to + 'T23:59:59') : null;
    return (S.positions || []).filter(function (p) {
      if (f.state === 'SETTLED' && p.status === 'OPEN') return false;
      if (f.state === 'OPEN' && p.status !== 'OPEN') return false;
      if (f.platform && p.platform !== f.platform) return false;
      if (f.sport && String(p.sport || '').toUpperCase() !== f.sport) return false;
      if (f.league && String(p.league || '').toUpperCase() !== f.league) return false;
      if (f.type && p.position_type !== f.type) return false;
      if (f.result && p.result !== f.result) return false;
      if (f.source && p.source !== f.source) return false;
      if (f.kind && p.platform_type !== f.kind) return false;
      var t = Date.parse(p.settled_at || p.placed_at);
      if (from != null && t < from) return false;
      if (to != null && t > to) return false;
      if (q && [p.event_name, p.market_name, p.selection, p.side, p.platform_label, p.sport, p.league, p.notes].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return (Date.parse(b.settled_at || b.placed_at) || 0) - (Date.parse(a.settled_at || a.placed_at) || 0); });
  }
  function historyView(S) {
    var all = S.positions || [];
    if (!all.length) return emptyBook();
    var f = S.histFilter, list = filterHistory(S), shown = list.slice(0, S.histLimit || 100);
    var more = ['kind', 'platform', 'sport', 'league', 'type', 'result', 'source', 'from', 'to'].filter(function (k) { return f[k]; }).length;
    var h = '<div class="pfo-filters">' + input('q', f.q, ' type="search" data-f="hist" placeholder="Search event, pick, notes" aria-label="Search"')
      + sel('state', [['SETTLED', 'Settled'], ['OPEN', 'Open'], ['', 'All']], f.state, ' data-f="hist" aria-label="State"') + '</div>'
      + '<details class="pfo-more"' + (more || S.histMore ? ' open' : '') + ' data-r="hist-more"><summary>Filters' + (more ? ' (' + more + ' on)' : '') + '</summary><div class="pfo-filters">'
      + sel('kind', [['', 'Sportsbook + prediction'], ['SPORTSBOOK', 'Sportsbook'], ['PREDICTION_MARKET', 'Prediction market']], f.kind, ' data-f="hist" aria-label="Kind"')
      + sel('platform', [['', 'All platforms']].concat(distinct(all, function (p) { return [p.platform, p.platform_label]; })), f.platform, ' data-f="hist" aria-label="Platform"')
      + sel('sport', [['', 'All sports']].concat(distinct(all, function (p) { return p.sport ? [String(p.sport).toUpperCase(), String(p.sport).toUpperCase()] : null; })), f.sport, ' data-f="hist" aria-label="Sport"')
      + sel('league', [['', 'All leagues']].concat(distinct(all, function (p) { return p.league ? [String(p.league).toUpperCase(), String(p.league).toUpperCase()] : null; })), f.league, ' data-f="hist" aria-label="League"')
      + sel('type', [['', 'All market types']].concat(E.POSITION_TYPES.map(function (t) { return [t, E.POSITION_TYPE_LABEL[t]]; })), f.type, ' data-f="hist" aria-label="Market type"')
      + sel('result', [['', 'Any result']].concat(Object.keys(RESULT_LABEL).map(function (k) { return [k, RESULT_LABEL[k]]; })), f.result, ' data-f="hist" aria-label="Result"')
      + sel('source', [['', 'Any source']].concat(Object.keys(SOURCE_LABEL).map(function (k) { return [k, SOURCE_LABEL[k]]; })), f.source, ' data-f="hist" aria-label="Source"')
      + input('from', f.from, ' type="date" data-f="hist" aria-label="From"') + input('to', f.to, ' type="date" data-f="hist" aria-label="To"') + '</div></details>';
    var s = E.summarize(list.filter(function (p) { return p.status !== 'OPEN'; }), {});
    h += '<div class="pfo-note"><b>' + list.length + '</b> position' + (list.length === 1 ? '' : 's') + ' · settled P&amp;L ' + signed(s.pnl)
      + (s.roi != null ? ' · ROI <b>' + esc(E.pct(s.roi)) + '</b>' : '') + ' · <button class="pfo-btn ghost sm" data-act="export">Export CSV</button></div>';
    if (!list.length) return h + '<div class="pfo-empty">Nothing matches these filters.</div>';
    h += '<div class="pfo-tablewrap pfo-hist-table" style="margin-top:10px"><table class="pfo-table"><thead><tr><th>Date</th><th>Platform</th><th>Event</th><th>Market</th><th>Selection</th>'
      + '<th class="r">Stake / cost</th><th class="r">Odds / entry</th><th>Result</th><th class="r">P&amp;L</th></tr></thead><tbody>'
      + shown.map(function (p) {
        return '<tr data-act="edit" data-id="' + esc(p.id) + '"><td>' + esc(dateText(p.settled_at || p.placed_at)) + '</td><td>' + esc(p.platform_label) + '</td><td>' + esc(p.event_name)
          + '</td><td>' + esc(p.market_name) + '</td><td>' + esc(isWager(p) ? p.selection : (p.side || p.selection) + ' · ' + E.qtyText(p.contracts_bought) + ' ct') + '</td>'
          + '<td class="r pfo-num">' + esc(E.money(p.cost_basis)) + '</td><td class="r pfo-num">' + esc(priceOf(p)) + '</td>'
          + '<td>' + esc(p.status === 'OPEN' ? 'Open' : (RESULT_LABEL[p.result] || STATUS_LABEL[p.status])) + '</td>'
          + '<td class="r">' + (p.profit_loss != null ? signed(p.profit_loss) : '<span class="pfo-mut">—</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    h += '<div class="pfo-hist-cards" style="margin-top:10px">' + shown.map(function (p) {
      return '<button type="button" class="pfo-hcard" data-act="edit" data-id="' + esc(p.id) + '"><span class="t">' + esc(isWager(p) ? p.selection : (p.side || p.selection) + ' · ' + p.event_name) + '</span>'
        + '<span class="v">' + (p.profit_loss != null ? signed(p.profit_loss) : '<span class="pfo-mut">Open</span>') + '</span>'
        + '<span class="s">' + esc([p.platform_label, isWager(p) ? p.event_name : null, dateText(p.settled_at || p.placed_at)].filter(Boolean).join(' · ')) + '</span>'
        + '<span class="s" style="text-align:right">' + esc(E.money(p.cost_basis)) + ' @ ' + esc(priceOf(p)) + '</span></button>';
    }).join('') + '</div>';
    if (list.length > shown.length) h += '<div class="pfo-btns"><button class="pfo-btn ghost" data-act="more">Show ' + Math.min(100, list.length - shown.length) + ' more of ' + (list.length - shown.length) + '</button></div>';
    if (all.historyCapped) h += '<div class="pfo-note">History lists your open positions and your most recent 1,000 settled ones. Older positions are in the <button class="pfo-link" data-act="tab" data-v="journal">Journal</button>, filed by day; every total on the Overview covers your whole record.</div>';
    return h;
  }
  function analyticsView(S) {
    var list = S.positions || [];
    if (!list.length) return emptyBook();
    var range = E.periodRange(S.period, S.now, S.tz), s = E.summarize(list, { from: range.from, to: range.to, tz: S.tz });
    var h = '<div class="pfo-filters"><div class="pfo-chips" role="group" aria-label="Period">' + PERIODS.map(function (p) {
      return '<button class="pfo-chip" data-act="period" data-v="' + p[0] + '" aria-pressed="' + (S.period === p[0]) + '">' + p[1] + '</button>';
    }).join('') + '</div></div>';
    if (!s.settled && !s.positions) return h + '<div class="pfo-empty">Nothing placed or settled in this period.</div>';
    function col(t) {
      return [signed(t.pnl), esc(t.roi != null ? E.pct(t.roi) : '—'), String(t.settled), esc(E.recordText(t.record)),
        esc(t.winRate != null ? E.pct(t.winRate, 1, { plain: true }) : '—'), esc(E.money(t.fees)), esc(E.money(t.capital)), esc(E.money(t.openExposure))];
    }
    var cols = [col(s.byType.SPORTSBOOK), col(s.byType.PREDICTION_MARKET), col(s)];
    var labels = ['P&amp;L', 'ROI', 'Settled', 'Record (W-L-P)', 'Win rate', 'Fees', 'Capital deployed', 'Open exposure (now)'];
    h += '<section class="pfo-sec"><div class="pfo-sec-h">Sportsbook · prediction market · combined</div><div style="overflow-x:auto"><table class="pfo-cmp"><thead><tr><th></th><th>Sportsbook</th><th>Prediction</th><th>Combined</th></tr></thead><tbody>'
      + labels.map(function (l, i) { return '<tr><td>' + l + '</td><td>' + cols[0][i] + '</td><td>' + cols[1][i] + '</td><td><b>' + cols[2][i] + '</b></td></tr>'; }).join('')
      + '</tbody></table></div><div class="pfo-note">ROI is settled P&amp;L over the stake or contract cost of those settled positions. Win rate counts wins over wins and losses; pushes, voids and cash-outs are left out.</div></section>';
    h += '<section class="pfo-sec"><div class="pfo-sec-h">Averages</div><div class="pfo-bw">'
      + '<div><div class="pfo-k">Average stake</div><div class="pfo-v">' + esc(s.averageStake != null ? E.money(s.averageStake) : '—') + '</div></div>'
      + '<div><div class="pfo-k">Average odds</div><div class="pfo-v">' + esc(s.averageOddsAmerican != null ? E.americanText(s.averageOddsAmerican) : '—') + '</div></div>'
      + '<div><div class="pfo-k">Average contract entry</div><div class="pfo-v">' + esc(s.averageEntryPrice != null ? E.priceText(s.averageEntryPrice) : '—') + '</div></div>'
      + '<div><div class="pfo-k">Fees paid</div><div class="pfo-v">' + esc(E.money(s.fees)) + '</div></div></div>'
      + '<div class="pfo-note">Average odds are the stake-weighted mean decimal price, shown as American. Average contract entry is total contract cost over contracts bought.</div></section>';
    function bw(title, x) {
      if (!x.best) return '<div><div class="pfo-k">' + esc(title) + '</div><div class="pfo-mut" style="font-size:13px">Needs two with settled positions</div></div>';
      return '<div><div class="pfo-k">Best ' + esc(title) + '</div><div class="pfo-v" style="font-size:16px">' + esc(x.best.label) + ' ' + signed(x.best.pnl) + ' <small>' + x.best.settled + ' settled</small></div>'
        + '<div class="pfo-k" style="margin-top:8px">Worst ' + esc(title) + '</div><div class="pfo-v" style="font-size:16px">' + esc(x.worst.label) + ' ' + signed(x.worst.pnl) + ' <small>' + x.worst.settled + ' settled</small></div></div>';
    }
    h += '<section class="pfo-sec"><div class="pfo-sec-h">Best and worst</div><div class="pfo-bw">' + bw('platform', s.platform) + bw('sport', s.sport) + bw('market type', s.marketType) + '</div>'
      + '<div class="pfo-note">Small samples move a lot; each figure shows how many settled positions it rests on.</div></section>';
    h += '<section class="pfo-sec"><div class="pfo-sec-h">Cumulative P&amp;L · ' + esc(S.period === 'ALL' ? 'all time' : S.period) + '</div>' + chart(s.series, 'Cumulative profit and loss') + '</section>';
    h += '<section class="pfo-sec"><div class="pfo-sec-h">By platform</div>' + rows(s.byPlatform) + '</section>';
    h += '<section class="pfo-sec"><div class="pfo-sec-h">By sport</div>' + rows(s.bySport) + '</section>';
    h += '<section class="pfo-sec"><div class="pfo-sec-h">By market type</div>' + rows(s.byPositionType) + '</section>';
    h += '<section class="pfo-sec"><div class="pfo-sec-h">By where the idea came from</div>' + rows(s.bySource)
      + '<div class="pfo-note">This is what you recorded on each position. EdgeDesk never infers it from a matching event; a position counts as EdgeDesk research only when you said so.</div></section>';
    return h;
  }
  /* ═══ ACCOUNTS: what is connected, imported or typed — said plainly ═══
     "Connected" appears only for an account the server connected and last
     synced; a quick-import or manual account never reads that way. */
  var STATUS_TEXT = { CONNECTED: 'Connected', SYNCING: 'Syncing', ACTION_REQUIRED: 'Action required', ERROR: 'Sync failing', DISCONNECTED: 'Disconnected',
    IMPORT_ONLY: 'Quick import', MANUAL: 'Manual' };
  function autoOffer(S, platform) {
    var rt = (S.registry || {})[platform];
    return !!(rt && rt.automatic_enabled && rt.automatic_method);
  }
  function runLine(r) {
    var bits = [dateText(r.started_at, true), r.status.toLowerCase()];
    if (r.transactions_inserted) bits.push('+' + r.transactions_inserted + ' trade' + (r.transactions_inserted === 1 ? '' : 's'));
    if (r.positions_updated) bits.push(r.positions_updated + ' updated');
    if (r.rejected) bits.push(r.rejected + ' rejected');
    if (r.reconcile && r.reconcile.ok === false) bits.push('holdings differ from the platform — rebuilding on the next sync');
    else if (r.reconcile && r.reconcile.ok) bits.push('reconciled');
    return '<li>' + esc(bits.join(' · ')) + (r.error_message ? '<div class="pfo-mut">' + esc(r.error_message) + '</div>' : '')
      + ((r.issues || []).length ? '<div class="pfo-mut">' + (r.issues || []).slice(0, 3).map(function (x) { return esc(x.message || x.code); }).join('<br>') + '</div>' : '') + '</li>';
  }
  /* what is already open on the same event, on any platform: the page holds
     every open position, so this needs no request. Matched on the event's
     normalized name (the duplicate check's normalization), nothing fuzzier. */
  function exposureOn(eventName, positions) {
    var k = E.normText(eventName);
    if (!k) return null;
    var list = (positions || []).filter(function (p) { return p.status === 'OPEN' && E.normText(p.event_name) === k; });
    var platforms = [];
    list.forEach(function (p) { var l = p.platform_label || E.platformLabel(p.platform); if (platforms.indexOf(l) < 0) platforms.push(l); });
    return { n: list.length, risk: list.reduce(function (s, p) { return E.dec.add(s, p.open_cost_basis || '0'); }, '0'), platforms: platforms,
      picks: list.map(function (p) { return p.selection || p.side; }).filter(Boolean).slice(0, 4) };
  }
  /* "2 min ago" for a recent sync; the date once it is a day old */
  function ago(t, now) {
    var ms = (now || Date.now()) - Date.parse(t);
    if (!(ms >= 0)) return dateText(t, true);
    var m = Math.floor(ms / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.floor(m / 60) + ' h ago' : dateText(t, true);
  }
  function accountCard(a, S) {
    var auto = a.connection_type === 'API' || a.connection_type === 'OAUTH' || a.connection_type === 'AGGREGATOR';
    var cred = a.credential || null, conn = (S.connections || {})[a.id] || {};
    var method = auto ? (a.ingestion_method === 'PUBLIC_WALLET' ? 'Public wallet' : a.ingestion_method === 'API_KEY' ? 'Read-only API key' : 'Automatic')
      : (a.connection_type === 'CSV' ? 'CSV import' : 'Manual tracking');
    var meta = [a.platform_type === 'SPORTSBOOK' ? 'Sportsbook' : 'Prediction market', method + (cred && cred.hint ? ' ' + cred.hint : ''),
      a.positions + ' position' + (+a.positions === 1 ? '' : 's') + (+a.open_positions ? ' (' + a.open_positions + ' open)' : '')];
    var when;
    if (auto) {
      when = a.status === 'CONNECTED' ? 'Last synced ' + (a.last_success_at ? ago(a.last_success_at, S.now) : 'never') + (conn.next_sync_at ? ' · next ' + dateText(conn.next_sync_at, true) : '')
        : a.status === 'SYNCING' ? (a.last_success_at ? 'Syncing now.' : 'The first sync is running or will run shortly; nothing has synced yet.')
        : a.status === 'ACTION_REQUIRED' ? 'Syncing has stopped until you reconnect.'
        : a.status === 'ERROR' ? 'The last ' + (conn.consecutive_failures || 'few') + ' syncs failed; EdgeDesk keeps retrying' + (conn.next_sync_at ? ' (next ' + dateText(conn.next_sync_at, true) + ')' : '') + '.'
        : a.status === 'DISCONNECTED' ? 'Not syncing. Its history is kept.' : '';
    } else {
      when = (a.connection_type === 'CSV' ? 'Not connected — import a newer file to bring it up to date. ' : '')
        + (a.last_import_at ? 'Last imported ' + dateText(a.last_import_at) + '. ' : '') + (a.last_position_at ? 'Latest position ' + dateText(a.last_position_at) + '.' : '');
    }
    var acts = '';
    if (auto) {
      if (a.status !== 'DISCONNECTED' && a.status !== 'ACTION_REQUIRED' && autoOffer(S, a.platform)) acts += '<button class="pfo-btn ghost sm" data-act="acct-sync" data-id="' + esc(a.id) + '">Sync now</button>';
      if ((a.status === 'ACTION_REQUIRED' || a.status === 'DISCONNECTED') && autoOffer(S, a.platform)) acts += '<button class="pfo-btn sm" data-act="acct-connect" data-platform="' + esc(a.platform) + '">Reconnect</button>';
      if (a.status !== 'DISCONNECTED') acts += '<button class="pfo-btn ghost sm" data-act="acct-disconnect" data-id="' + esc(a.id) + '">Disconnect</button>';
      acts += '<button class="pfo-btn danger sm" data-act="acct-delete-history" data-id="' + esc(a.id) + '">Disconnect and delete synced history</button>';
    } else {
      acts += '<button class="pfo-btn ghost sm" data-act="tab" data-v="import" data-platform="' + esc(a.platform) + '">' + (+a.positions > 0 && a.connection_type === 'CSV' ? 'Import update' : 'Import a file') + '</button>'
        + '<button class="pfo-btn ghost sm" data-act="' + (a.platform_type === 'SPORTSBOOK' ? 'new-wager' : 'new-prediction') + '" data-platform="' + esc(a.platform) + '" data-label="' + esc(a.platform_label) + '">Record a position</button>';
      if (autoOffer(S, a.platform)) acts += '<button class="pfo-btn sm" data-act="acct-connect" data-platform="' + esc(a.platform) + '">Connect automatically</button>';
      if (+a.positions === 0) acts += '<button class="pfo-btn danger sm" data-act="remove-account" data-id="' + esc(a.id) + '">Remove</button>';
    }
    acts += '<button class="pfo-btn ghost sm" data-act="rename-account" data-id="' + esc(a.id) + '">Rename</button>';
    var runs = (S.runs || []).filter(function (r) { return r.platform_account_id === a.id; }).slice(0, 5);
    var status = auto ? a.status : (a.connection_type === 'CSV' ? 'IMPORT_ONLY' : 'MANUAL');
    return '<div class="pfo-acct"><div><div class="pfo-acct-n">' + esc(a.display_name ? a.display_name + ' · ' + a.platform_label : a.platform_label) + '</div>'
      + '<div class="pfo-acct-m">' + esc(meta.join(' · ')) + '</div><div class="pfo-acct-m">' + esc(when) + '</div>'
      + (auto && a.last_error && a.status !== 'CONNECTED' ? '<div class="pfo-acct-m pfo-down">' + esc(a.last_error) + '</div>' : '')
      + (runs.length ? '<details class="pfo-more"><summary>Sync log</summary><ul class="pfo-runs">' + runs.map(runLine).join('') + '</ul></details>' : '') + '</div>'
      + '<span class="pfo-status ' + esc(status) + '">' + esc(STATUS_TEXT[status] || status) + '</span>'
      + '<div class="pfo-acct-act">' + acts + '</div></div>';
  }
  /* SETUP: choose platforms → bring in each one's history → ready. Platforms
     are grouped by how their history can arrive; [Connect] appears only where
     the server has switched automatic connection on. Progress is the reader's
     own accounts and positions, and the ready card the server's own totals;
     nothing is invented. */
  var SETUP_GROUPS = { auto: ['kalshi', 'polymarket'], books: ['draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'bet365'], more: ['betrivers', 'fanatics', 'espnbet'] };
  var PROFILE_READY_AT = 10;   // graded positions before the process profile leaves "Building" (X.confidence)
  function setupVisible(S) {
    var accts = S.accounts || [];
    S.setup = S.setup || { selected: {}, open: false };
    return !!S.setup.open || !(S.positions || []).length || accts.some(function (a) { return +a.positions === 0; });
  }
  function setupChips(keys, have, sel, label) {
    return '<div class="pfo-chips" role="group" aria-label="' + esc(label) + '">' + keys.map(function (k) {
      var p = E.platform(k) || { key: k, label: E.platformLabel(k, k) };
      return '<button class="pfo-chip" data-act="setup-pick" data-v="' + esc(k) + '" aria-pressed="' + (!!have[k] || !!sel[k]) + '"' + (have[k] ? ' disabled' : '') + '>' + esc(p.label) + '</button>';
    }).join('') + '</div>';
  }
  /* where an account's history stands, in words that never overstate it */
  function setupState(a) {
    var n = +a.positions || 0, count = n ? ' · ' + n + ' position' + (n === 1 ? '' : 's') : '';
    if (a.connection_type === 'API' || a.connection_type === 'OAUTH' || a.connection_type === 'AGGREGATOR') return (STATUS_TEXT[a.status] || a.status) + (a.status === 'CONNECTED' ? ' ✓' : '') + count;
    if (!n) return a.connection_type === 'CSV' ? 'Waiting for import' : 'Waiting for a position';
    return (a.connection_type === 'CSV' && a.last_import_at ? 'Imported ✓' : 'Recorded ✓') + count;
  }
  function readyCard(S, accts) {
    var tracked = 0, open = 0;
    accts.forEach(function (a) { tracked += +a.positions || 0; open += +a.open_positions || 0; });
    var life = S.lifetime, st = life && life.settled, proc = life && life.process, graded = proc ? +proc.graded || 0 : null;
    var wait = S.lifetimeError ? '—' : '…';
    var profile = graded == null ? wait : X.confidence(graded) === 'BUILDING' ? 'Building · ' + graded + ' of ' + PROFILE_READY_AT + ' graded' : 'Ready · ' + graded + ' graded';
    return '<div class="pfo-ready" data-r="ready"><div class="pfo-ready-h">3 · Your portfolio is ready</div><dl class="pfo-dl">'
      + '<dt>Tracked positions</dt><dd>' + tracked + '</dd>'
      + '<dt>Total P&amp;L</dt><dd>' + (st ? signed(String(st.pnl)) + ' <small>' + (+st.n || 0) + ' settled</small>' : wait) + '</dd>'
      + '<dt>ROI</dt><dd>' + (st ? (st.roi != null ? esc(E.pct(String(st.roi))) : '—') : wait) + '</dd>'
      + '<dt>Open positions</dt><dd>' + open + '</dd>'
      + '<dt>Process profile</dt><dd>' + esc(profile) + '</dd></dl>'
      + '<div class="pfo-note">' + (S.lifetimeError ? 'The totals could not be loaded here; the Overview has them. '
        : graded ? 'Your Decision Grade covers ' + graded + ' position' + (graded === 1 ? '' : 's') + ' so far. ' : '')
      + (graded ? '' : 'Process insights appear once positions have a price to judge them by (a closing price or a model probability recorded before the event) — EdgeDesk shows none until then. ')
      + 'P&amp;L counts settled positions only, all time.</div>'
      + '<div class="pfo-btns"><button class="pfo-btn" data-act="tab" data-v="overview">View my portfolio</button>'
      + (S.setup.open ? '<button class="pfo-btn ghost" data-act="setup-close">Done</button>' : '') + '</div></div>';
  }
  function setupPanel(S) {
    var accts = S.accounts || [], have = {}, sel = S.setup.selected || {};
    accts.forEach(function (a) { have[a.platform] = a; });
    var withHistory = accts.filter(function (a) { return +a.positions > 0; }).length, total = accts.length;
    var listed = {};
    [].concat(SETUP_GROUPS.auto, SETUP_GROUPS.books, SETUP_GROUPS.more).forEach(function (k) { listed[k] = 1; });
    var others = E.PLATFORMS.filter(function (p) { return !listed[p.key]; }).map(function (p) { return p.key; });
    var on = SETUP_GROUPS.auto.filter(function (k) { return autoOffer(S, k); });
    var h = '<section class="pfo-sec pfo-setup" data-r="setup"><div class="pfo-sec-h">Set up your portfolio<span class="pfo-right pfo-mut">'
      + (total ? withHistory + ' of ' + total + ' platform' + (total === 1 ? '' : 's') + ' with history' : 'step 1 of 3') + '</span></div>'
      + (total ? '<div class="pfo-meter wide" role="progressbar" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + withHistory + '"><i style="width:'
        + Math.round(100 * withHistory / Math.max(1, total)) + '%"></i></div>' : '');
    h += '<div class="pfo-note"><b>1 · Where do you bet or trade?</b> Choose every place — sportsbooks and prediction markets.</div>';
    h += '<div class="pfo-acct-group">Prediction markets · ' + (on.length ? 'automatic' : 'import now, automatic once switched on') + '</div>'
      + setupChips(SETUP_GROUPS.auto, have, sel, 'Prediction markets')
      + '<div class="pfo-note">' + (on.length ? on.map(function (k) { return E.platformLabel(k); }).join(' and ') + ' connect' + (on.length === 1 ? 's' : '') + ' automatically and read-only'
          + (on.length < SETUP_GROUPS.auto.length ? '; the other is imported from a file for now' : '') + '.'
        : 'Automatic connection is built for both and is switched on only after a live end-to-end test; until then, import a file from either.') + '</div>'
      + (on.length ? '<div class="pfo-btns">' + on.map(function (k) { return '<button class="pfo-btn sm" data-act="acct-connect" data-platform="' + esc(k) + '">Connect ' + esc(E.platformLabel(k)) + '</button>'; }).join('') + '</div>' : '');
    h += '<div class="pfo-acct-group">Sportsbooks · import</div>' + setupChips(SETUP_GROUPS.books.concat(SETUP_GROUPS.more), have, sel, 'Sportsbooks')
      + '<div class="pfo-note">Sportsbooks offer no automatic connection for your history: you download it from your account and drop the file here. EdgeDesk never asks for a sportsbook password.</div>';
    h += '<div class="pfo-acct-group">Other</div><details class="pfo-more"><summary>More platforms</summary>' + setupChips(others, have, sel, 'Other platforms') + '</details>'
      + '<div class="pfo-btns"><button class="pfo-btn ghost sm" data-act="tab" data-v="import">Import another platform</button>'
      + '<button class="pfo-btn ghost sm" data-act="add-account">Add manually</button></div>';
    var picked = Object.keys(sel).filter(function (k) { return sel[k] && !have[k]; });
    if (picked.length) h += '<div class="pfo-btns"><button class="pfo-btn" data-act="setup-add">Add ' + picked.length + ' platform' + (picked.length === 1 ? '' : 's') + '</button></div>';
    if (total) {
      var sum = 0;
      h += '<div class="pfo-note"><b>2 · Bring in each one\'s history.</b> A sportsbook is imported from a file you download; '
        + 'a prediction market connects automatically where EdgeDesk has switched that on, or is imported the same way.</div><ul class="pfo-checklist">'
        + accts.map(function (a) {
          var done = +a.positions > 0, auto = a.connection_type === 'API';
          sum += +a.positions || 0;
          return '<li class="' + (done ? 'done' : '') + '"><span>' + esc(a.platform_label) + '</span><span class="pfo-mut">' + esc(setupState(a)) + '</span>'
            + (done ? '' : (autoOffer(S, a.platform) && !auto ? '<button class="pfo-btn sm" data-act="acct-connect" data-platform="' + esc(a.platform) + '">Connect</button>' : '')
              + (auto ? '' : '<button class="pfo-btn ghost sm" data-act="tab" data-v="import" data-platform="' + esc(a.platform) + '">Import a file</button>')) + '</li>';
        }).join('') + '<li class="total"><span>Total</span><span>' + sum + ' position' + (sum === 1 ? '' : 's') + '</span></li></ul>';
    }
    if ((S.positions || []).length) h += readyCard(S, accts);
    return h + '</section>';
  }
  function connectionsGuide(S, K) {
    if (!K) return '';
    return '<section class="pfo-sec"><div class="pfo-sec-h">How each platform comes in</div><div class="pfo-rows">' + K.REGISTRY.map(function (p) {
      var on = autoOffer(S, p.key);
      var how = p.automatic ? (on ? (p.automatic.method === 'API_KEY' ? 'Automatic — read-only API key' : 'Automatic — public wallet address')
        : 'Import a file (automatic connection is built and being tested; it is switched on only after a live end-to-end test)') : 'Import a file — no sportsbook offers customers an API';
      return '<div class="pfo-row"><div class="pfo-row-n">' + esc(p.label) + '<small>' + esc(how) + '</small></div><div class="pfo-row-v">'
        + (on ? '<button class="pfo-btn sm" data-act="acct-connect" data-platform="' + esc(p.key) + '">Connect</button>' : '<button class="pfo-btn ghost sm" data-act="tab" data-v="import" data-platform="' + esc(p.key) + '">Import</button>')
        + '</div></div>';
    }).join('') + '</div><div class="pfo-note">EdgeDesk never asks for a sportsbook password, never reads a site on your behalf, and never places, changes or cancels anything: every connection is read-only.</div></section>';
  }
  function adminPanel(S) {
    if (!S.isAdmin || !S.admin) return '';
    var hl = S.admin.health || {}, ttv = S.admin.ttv || {};
    var num = function (v) { return v == null ? '—' : String(+v); };
    var codes = function (o) { return esc(Object.keys(o || {}).map(function (k) { return k + ' ' + o[k]; }).join(', ') || '—'); };
    var table = function (head, rows, empty) {
      return '<div class="pfo-tablewrap"><table class="pfo-table" style="min-width:640px"><thead><tr>' + head.map(function (x, i) { return '<th' + (i && i < head.length - 1 ? ' class="r"' : '') + '>' + x + '</th>'; }).join('')
        + '</tr></thead><tbody>' + (rows || '<tr><td colspan="' + head.length + '" class="pfo-mut">' + empty + '</td></tr>') + '</tbody></table></div>';
    };
    var syncRows = (hl.platforms || []).map(function (x) {
      return '<tr><td>' + esc(x.platform) + '</td><td class="r">' + num(x.runs) + '</td><td class="r">' + num(x.succeeded) + '</td><td class="r">' + num(x.partial) + '</td><td class="r">' + num(x.failed) + '</td>'
        + '<td class="r">' + num(x.discovered) + '</td><td class="r">' + num(+(x.positions_inserted || 0) + +(x.transactions_inserted || 0)) + '</td><td class="r">' + num(x.positions_updated) + '</td>'
        + '<td class="r">' + num(x.duplicates_rejected) + '</td><td class="r">' + num(x.settlements) + '</td><td class="r">' + num(x.rejected) + '</td>'
        + '<td class="r">' + num(x.reconciled) + (+x.reconcile_mismatches ? ' / ' + x.reconcile_mismatches + ' off' : '') + '</td>'
        + '<td class="r">' + (x.p95_ms != null ? Math.round(x.p95_ms) + ' ms' : '—') + '</td><td>' + codes(x.errors) + (x.last_success ? '<div class="pfo-mut">last OK ' + esc(dateText(x.last_success, true)) + '</div>' : '') + '</td></tr>';
    }).join('');
    var connRows = (hl.connections || []).map(function (x) {
      return '<tr><td>' + esc(x.platform) + '</td><td class="r">' + num(x.attempts) + '</td><td class="r">' + num(x.connected) + '</td><td class="r">' + num(x.failed) + '</td><td class="r">' + num(x.disconnected) + '</td><td>' + codes(x.failures) + '</td></tr>';
    }).join('');
    var impRows = (hl.imports || []).map(function (x) {
      return '<tr><td>' + esc(x.platform) + '</td><td class="r">' + num(x.files) + '</td><td class="r">' + num(x.committed) + '</td><td class="r">' + num(x.failed) + '</td><td class="r">' + num(x.not_finished) + '</td>'
        + '<td class="r">' + num(x.parser_failures) + ' <small>in ' + num(x.files_with_parser_failures) + '</small></td><td>' + (+x.new_layouts ? '<b>' + x.new_layouts + ' new layout' + (+x.new_layouts === 1 ? '' : 's') + '</b> — check the export format' : '—') + '</td></tr>';
    }).join('');
    var pctOrDash = function (v) { return v == null ? '—' : (100 * +v).toFixed(1) + '%'; };
    return '<section class="pfo-sec" data-r="admin"><div class="pfo-sec-h">Operator · connectors, last ' + (hl.window_hours || 24) + ' hours</div>'
      + table(['Platform', 'Runs', 'OK', 'Partial', 'Failed', 'Discovered', 'Inserted', 'Updated', 'Duplicates rejected', 'Settlements', 'Rejected', 'Reconciled', 'p95', 'Errors'], syncRows, 'No sync runs.')
      + '<div class="pfo-sec-h" style="margin-top:12px">Connection attempts</div>'
      + table(['Platform', 'Attempts', 'Connected', 'Failed', 'Disconnected', 'Failure codes'], connRows, 'No connection attempts.')
      + '<div class="pfo-sec-h" style="margin-top:12px">Imports</div>'
      + table(['Platform', 'Files', 'Imported', 'Failed', 'Not finished', 'Rows that could not be read', 'Format changes'], impRows, 'No imports.')
      + '<div class="pfo-note">Switched on: ' + esc(((hl.registry || []).filter(function (g) { return g.automatic_enabled; }).map(function (g) { return g.platform; }).join(', ')) || 'none') + '. Counts only — no reader, credential or position appears here.</div>'
      + '<div class="pfo-sec-h" style="margin-top:12px">Time to value, last 30 days</div><dl class="pfo-dl">'
      + '<dt>Setups started</dt><dd>' + (ttv.onboarding_started != null ? ttv.onboarding_started : '—') + '</dd>'
      + '<dt>Median time to first position</dt><dd>' + (ttv.time_to_first_position_minutes_median != null ? ttv.time_to_first_position_minutes_median + ' min' : '—') + '</dd>'
      + '<dt>Median time to portfolio ready</dt><dd>' + (ttv.time_to_portfolio_ready_minutes_median != null ? ttv.time_to_portfolio_ready_minutes_median + ' min' : '—') + '</dd>'
      + '<dt>Setup abandonment (7+ days)</dt><dd>' + pctOrDash(ttv.onboarding_abandonment) + '</dd>'
      + '<dt>Import failure rate</dt><dd>' + pctOrDash(ttv.import_failure_rate) + '</dd>'
      + '<dt>Connection failure rate</dt><dd>' + pctOrDash(ttv.connection_failure_rate) + '</dd></dl></section>';
  }
  function accountsView(S, k) {
    var accts = S.accounts || [], Kc = k || K;
    var h = setupVisible(S) ? setupPanel(S) : '<div class="pfo-btns"><button class="pfo-btn ghost sm" data-act="setup-open">Add platforms</button></div>';
    var groups = [['Automatic', accts.filter(function (a) { return ['API', 'OAUTH', 'AGGREGATOR'].indexOf(a.connection_type) >= 0; })],
      ['Quick import', accts.filter(function (a) { return a.connection_type === 'CSV'; })], ['Manual', accts.filter(function (a) { return a.connection_type === 'MANUAL'; })]];
    h += '<section class="pfo-sec"><div class="pfo-sec-h">Your platforms<span class="pfo-right"><button class="pfo-btn sm" data-act="setup-open">Add account</button></span></div>';
    if (!accts.length) h += '<div class="pfo-note">No platforms yet. Choose them above, or just record a position: its platform is added here automatically.</div>';
    groups.forEach(function (g) {
      if (!g[1].length) return;
      h += '<div class="pfo-acct-group">' + esc(g[0]) + '</div>' + g[1].map(function (a) { return accountCard(a, S); }).join('');
    });
    h += '</section>' + connectionsGuide(S, Kc) + (J.privacyBlock ? J.privacyBlock(S) : '') + adminPanel(S);
    return h;
  }
  /* SELECT PLATFORM → DROP FILE → REVIEW → DONE. Sportsbooks are imported,
     never "connected": no US sportsbook offers customers an API for their
     history, and EdgeDesk never asks for a sportsbook password. */
  var IMPORT_PLATFORMS = [['', 'Detect automatically'], ['draftkings', 'DraftKings'], ['fanduel', 'FanDuel'], ['betmgm', 'BetMGM'],
    ['williamhill_us', 'Caesars'], ['bet365', 'bet365'], ['kalshi', 'Kalshi'], ['polymarket', 'Polymarket']];
  var HOW_LABEL = { CHOSEN: 'you chose it', COLUMN: 'the file\'s platform column', FILE_NAME: 'the file\'s name', REMEMBERED: 'a layout you imported before' };
  function importView(S) {
    var st = S.imp || {}, r = st.staged, c = st.counts;
    var step = st.result ? 4 : (r ? 3 : 2);
    var h = '<ol class="pfo-flow" aria-label="Import steps">' + ['Platform', 'File', 'Review', 'Done'].map(function (x, i) {
      return '<li class="' + (i + 1 < step ? 'done' : i + 1 === step ? 'now' : '') + '"' + (i + 1 === step ? ' aria-current="step"' : '') + '>' + (i + 1) + ' · ' + x + '</li>';
    }).join('') + '</ol>';
    /* 1 · the platform */
    h += '<section class="pfo-sec"><div class="pfo-sec-h">1 · Where is the file from?</div><div class="pfo-chips" role="group" aria-label="Platform">'
      + IMPORT_PLATFORMS.map(function (p) {
        return '<button class="pfo-chip" data-act="imp-platform" data-v="' + p[0] + '" aria-pressed="' + (String(st.platform || '') === p[0]) + '">' + esc(p[1]) + '</button>';
      }).join('') + '</div><div class="pfo-note">Sportsbooks do not offer an automatic connection for your history, so EdgeDesk imports the file you download from your account '
      + '(a CSV, where your book offers one) — it never asks for your sportsbook password. Kalshi and Polymarket can also connect automatically once EdgeDesk has switched that on.</div></section>';
    /* 2 · the file */
    h += '<section class="pfo-sec"><div class="pfo-sec-h">2 · Drop the file</div>'
      + '<label class="pfo-drop" data-r="drop"><input type="file" name="file" accept=".csv,.txt,text/csv" data-f="imp"><b>' + (st.fileName ? esc(st.fileName) : 'Drop a CSV here, or choose a file') + '</b>'
      + '<span>Read in your browser; nothing is added until you confirm. Up to ' + I.MAX_ROWS + ' rows and 5 MB.</span></label>'
      + (st.readError ? '<div class="pfo-err">' + esc(st.readError) + '</div>' : '')
      + '<details class="pfo-more"' + (st.optionsOpen ? ' open' : '') + '><summary>Reading options</summary><div class="pfo-form" style="margin-top:10px">'
      + fld('Format', sel('adapter', [['', 'Detect automatically']].concat(Object.keys(I.ADAPTERS).map(function (k) { return [k, I.ADAPTERS[k].label]; })), st.adapterChoice || '', ' data-f="imp"'))
      + fld('Times without a zone are in', input('timezone', st.timezone || S.tz || 'UTC', ' data-f="imp" autocomplete="off"'))
      + fld('Dates like 03/04/2026 are', sel('dateOrder', [['MDY', 'Month first (US)'], ['DMY', 'Day first']], st.dateOrder || 'MDY', ' data-f="imp"'))
      + '</div></details></section>';
    if (r) {
      /* 3 · review */
      var detected = r.platform ? E.platformLabel(r.platform) : null, how = st.remembered ? 'REMEMBERED' : r.platformHow;
      h += '<section class="pfo-sec"><div class="pfo-sec-h">3 · Review: check the columns and the counts<span class="pfo-right pfo-mut">' + esc(st.fileName || '') + ' · ' + esc(r.adapterLabel) + '</span></div>';
      var lc = I.localCounts(r.rows), ptype = r.platform && E.platform(r.platform) ? E.platform(r.platform).type : null;
      var unit = ptype === 'SPORTSBOOK' ? 'wager' : ptype === 'PREDICTION_MARKET' ? 'trade' : 'row';
      if (detected) h += '<div class="pfo-detect" data-r="imp-detect">Detected: <b>' + esc(detected) + '</b> · <b>' + lc.total + '</b> ' + unit + (lc.total === 1 ? '' : 's') + ' found'
        + (r.range ? ' · ' + esc(r.range.text) : '') + '<small>Platform from ' + esc(HOW_LABEL[how] || 'the file') + '. Not right? Choose it above.</small></div>';
      else if (r.platformHow === 'MIXED') h += '<div class="pfo-note">The file names more than one platform; each row keeps its own.' + (r.range ? ' Dates: ' + esc(r.range.text) + '.' : '') + '</div>';
      else h += '<div class="pfo-issue warning">EdgeDesk could not tell which platform this file is from. Choose it above.</div>';
      if (st.remembered) h += '<div class="pfo-note">Read the way you imported this layout before (' + esc(dateText(st.remembered, false)) + '). Change any column below if this file differs.</div>';
      h += (r.fileIssues || []).map(function (x) { return '<div class="pfo-issue ' + esc(x.level) + '">' + esc(x.message) + '</div>'; }).join('');
      var unmapped = I.ADAPTERS[r.adapter].fields.filter(function (f) { return f.required && !r.map[f.key]; }).length;
      h += '<details class="pfo-more"' + (unmapped || st.mapOpen ? ' open' : '') + ' data-r="imp-map"><summary>Columns' + (unmapped ? ' (' + unmapped + ' not found)' : ' (all found)') + '</summary>'
        + '<div class="pfo-map" style="margin-top:8px">' + I.ADAPTERS[r.adapter].fields.map(function (f) {
          return fld(f.label + (f.required ? ' *' : ''), sel('map:' + f.key, [['', '— not in file —']].concat(r.headers.map(function (x) { return [x, x]; })), r.map[f.key] || '', ' data-f="imp"'));
        }).join('') + '</div></details>';
      h += '<div class="pfo-counts"><div class="pfo-count"><div class="n">' + (lc.total + (r.mergedRows || 0)) + '</div><div class="l">Rows read</div></div>'
        + (r.mergedRows ? '<div class="pfo-count"><div class="n">' + lc.total + '</div><div class="l">Bets (parlay legs joined)</div></div>' : '')
        + '<div class="pfo-count REVIEW"><div class="n">' + lc.review + '</div><div class="l">To review</div></div>'
        + '<div class="pfo-count INVALID"><div class="n">' + lc.invalid + '</div><div class="l">Cannot import</div></div></div>';
      if (!c) {
        h += previewTable(r.rows.slice(0, 25), null)
          + '<div class="pfo-btns"><button class="pfo-btn" data-act="imp-check"' + (st.busy || (!detected && r.platformHow !== 'MIXED') ? ' disabled' : '') + '>Check against my portfolio</button></div>';
      }
      h += '</section>';
    }
    if (c && st.serverRows) {
      var wanted = st.serverRows.filter(function (x) { return wantRow(x); });
      var importable = wanted.filter(function (x) { return x.classification !== 'UPDATE'; }).length, updates = wanted.length - importable;
      var est = I.estimate(wanted.map(function (x) { return x.normalized; }));
      /* "Update portfolio" once this platform has been imported before; a first file is an "Import" */
      var plat = r && r.platform, known = +c.duplicate || 0;
      var incremental = +c.update > 0 || (S.accounts || []).some(function (a) { return a.platform === plat && a.last_import_at; });
      h += '<section class="pfo-sec"><div class="pfo-sec-h">Before anything is stored</div><div class="pfo-counts">'
        + '<div class="pfo-count"><div class="n">' + c.total + '</div><div class="l">Found</div></div>'
        + '<div class="pfo-count NEW"><div class="n">' + c.new + '</div><div class="l">Ready</div></div>'
        + '<div class="pfo-count UPDATE"><div class="n">' + (c.update || 0) + '</div><div class="l">Updated since</div></div>'
        + '<div class="pfo-count"><div class="n">' + known + '</div><div class="l">Duplicates</div></div>'
        + '<div class="pfo-count REVIEW"><div class="n">' + c.review + '</div><div class="l">Need review</div></div>'
        + '<div class="pfo-count INVALID"><div class="n">' + c.invalid + '</div><div class="l">Cannot import</div></div></div>'
        + (incremental ? '<div class="pfo-note" data-r="imp-incremental"><b>' + c.new + '</b> new position' + (+c.new === 1 ? '' : 's') + ' · <b>' + (c.update || 0) + '</b> updated (a result or payout that changed since)'
          + ' · <b>' + known + '</b> already in your portfolio (or repeated in the file) — left as they are, so nothing is counted twice.</div>' : '')
        + (est.rows ? '<div class="pfo-note" data-r="imp-estimate">If you import these: <b>' + est.settled + '</b> settled, P&amp;L <b>' + signed(est.pnl) + '</b>'
          + (est.roi != null ? ' (ROI ' + esc(E.pct(est.roi)) + ')' : '') + (est.open ? ' · <b>' + est.open + '</b> open, ' + esc(E.money(est.exposure)) + ' at risk' : '')
          + (est.bonus ? ' · ' + est.bonus + ' bonus bet' + (est.bonus === 1 ? '' : 's') : '') + '. An estimate: the stored figures are derived by the database.</div>' : '')
        + '<div class="pfo-note">New rows are imported and updates change the bet already imported (a result the newer file has). Duplicates and rows needing review are skipped unless you tick them; invalid rows are never imported.</div>'
        + previewTable((st.reviewOnly ? st.serverRows.filter(function (x) { return x.classification === 'NEEDS_REVIEW'; })
          : st.serverRows.filter(function (x) { return x.classification !== 'NEW'; }).concat(st.serverRows.filter(function (x) { return x.classification === 'NEW'; }))).slice(0, 200), true)
        + (st.progress ? '<div class="pfo-note" role="status">Importing… <b>' + st.progress.imported + '</b> in, <b>' + st.progress.remaining + '</b> to go.</div>' : '')
        + (st.result ? '' : '<div class="pfo-btns"><button class="pfo-btn" data-act="imp-commit"' + (st.busy || !wanted.length ? ' disabled' : '') + '>'
          + (incremental ? 'Update portfolio · ' + importable + ' new, ' + updates + ' updated' : 'Import ' + importable) + '</button>'
          + (+c.review ? '<button class="pfo-btn ghost" data-act="imp-review" aria-pressed="' + !!st.reviewOnly + '">' + (st.reviewOnly ? 'Show all rows' : 'Review ' + c.review) + '</button>' : '')
          + '<button class="pfo-btn ghost" data-act="imp-reset">Start over</button></div>') + '</section>';
    }
    if (st.result) {
      var x = st.result;
      h += '<section class="pfo-sec"><div class="pfo-sec-h">4 · Done</div><div class="' + (x.failed ? 'pfo-err' : 'pfo-ok') + '"><b>Imported ' + x.imported + '</b>'
        + (x.updated ? ' · <b>updated ' + x.updated + '</b>' : '') + ' · skipped ' + x.skipped + (x.failed ? ' · <b>' + x.failed + ' failed</b> (the reasons are on each row above)' : '') + '.</div>'
        + '<div class="pfo-btns"><button class="pfo-btn" data-act="tab" data-v="overview">See your portfolio</button><button class="pfo-btn ghost" data-act="imp-reset">Import another file</button></div></section>';
    }
    if (st.error) h += '<div class="pfo-err">' + esc(st.error) + '</div>';
    if (S.imports && S.imports.length) {
      h += '<section class="pfo-sec"><div class="pfo-sec-h">Recent imports</div><div class="pfo-rows">' + S.imports.map(function (m) {
        return '<div class="pfo-row"><div class="pfo-row-n">' + esc(m.file_name || 'CSV') + '<small>' + esc(dateText(m.created_at, true)) + ' · ' + esc(m.status.toLowerCase()) + '</small></div>'
          + '<div class="pfo-row-v">' + (m.status === 'COMMITTED' ? m.rows_imported + ' imported<small>' + (m.rows_updated ? m.rows_updated + ' updated, ' : '') + m.rows_skipped + ' skipped' + (m.rows_failed ? ', ' + m.rows_failed + ' failed' : '') + '</small>' : '<small>not imported</small>') + '</div></div>';
      }).join('') + '</div></section>';
    }
    return h;
  }
  function wantRow(x) { return !x.outcome && x.classification !== 'INVALID' && (x.decision ? x.decision === 'IMPORT' : (x.classification === 'NEW' || x.classification === 'UPDATE')); }
  function previewTable(list, server) {
    if (!list.length) return '';
    return '<div class="pfo-tablewrap" style="margin-top:10px"><table class="pfo-table"><thead><tr>' + (server ? '<th>Import</th><th>Check</th>' : '') + '<th>Row</th><th>Date</th><th>Platform</th><th>Event</th><th>Pick</th><th class="r">Amount</th><th>Notes</th></tr></thead><tbody>'
      + list.map(function (r) {
        var n = r.normalized || {}, issues = (r.issues || []).filter(function (x) { return x.message && x.level !== 'info'; });
        var toggle = server ? (r.classification === 'INVALID' || r.classification === 'NEW' ? '<td></td>'
          : '<td><input type="checkbox" aria-label="' + (r.classification === 'UPDATE' ? 'Update the bet from row ' : 'Import row ') + r.row_number + (r.classification === 'UPDATE' ? '' : ' anyway') + '" data-act="imp-decide" data-id="' + esc(r.id) + '"' + (wantRow(r) ? ' checked' : '') + ' style="width:auto"></td>')
          + '<td><span class="pfo-cls ' + esc(r.classification) + '">' + esc(r.classification.replace(/_/g, ' ')) + '</span>' + (r.outcome ? '<div class="pfo-issue' + (r.outcome === 'FAILED' ? ' error' : '') + '">' + esc(r.outcome.toLowerCase() + (r.outcome_message ? ': ' + r.outcome_message.replace(/^portfolio: /, '') : '')) + '</div>' : '') + '</td>' : '';
        var amount = n.kind === 'fill' ? (n.action || '') + ' ' + (n.quantity || '?') + ' @ ' + (n.price != null ? E.priceText(n.price) : '?') : (n.stake ? E.money(n.stake) + ' @ ' + (n.odds_american != null ? E.americanText(n.odds_american) : (n.odds_decimal || '?')) : '?');
        return '<tr>' + toggle + '<td>' + r.row_number + '</td><td>' + esc(dateText(n.placed_at || n.executed_at, true)) + '</td><td>' + esc(n.platform_label || '?') + '</td><td>' + esc(n.event_name || '?')
          + '</td><td>' + esc(n.selection || n.side || '?') + (n.status && n.status !== 'OPEN' ? ' · ' + esc(STATUS_LABEL[n.status] || n.status) : '') + (n.resolution ? ' · resolved ' + esc(n.resolution) : '') + '</td>'
          + '<td class="r pfo-num">' + esc(amount) + '</td><td>' + issues.map(function (x) { return '<div class="pfo-issue ' + esc(x.level) + '">' + esc(x.message) + '</div>'; }).join('') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function attributionFields(v, recs) {
    var h = fld('Where the idea came from', sel('edge_source', [['', 'Not recorded'], ['EDGEDESK', 'EdgeDesk research'], ['SELF', 'My own read'], ['OTHER', 'Other']], v.edge_source || '', ' data-f="form"'), 'full');
    if (v.edge_source === 'EDGEDESK') {
      var opts = [['', 'No specific record']].concat((recs || []).map(function (r) {
        return [r.type + ':' + r.id, (r.type === 'stake_recommendation' ? 'Sizing · ' : 'Journal · ') + r.label + (r.at ? ' · ' + dateText(r.at) : '')];
      }));
      h += fld('Link to the EdgeDesk record', sel('edge_ref', opts, v.edge_ref || '', ' data-f="form"'), 'full', recs && recs.length ? 'only records on your own account' : 'none of your EdgeDesk records were found');
    }
    return h;
  }
  function wagerForm(v, opts) {
    opts = opts || {};
    var status = v.status || 'OPEN', type = v.position_type || 'SPREAD';
    var h = '<form class="pfo-form" data-form="wager" novalidate>'
      + fld('Sportsbook', sel('platform', platformOptions('SPORTSBOOK', v.platform), v.platform || '', ' data-f="form" required'))
      + (v.platform === '__other' ? fld('Sportsbook name', input('platform_other', v.platform_other, ' maxlength="60" data-f="form"')) : fld('Sport', input('sport', v.sport, ' list="pfo-sports" maxlength="30" data-f="form"')))
      + (v.platform === '__other' ? fld('Sport', input('sport', v.sport, ' list="pfo-sports" maxlength="30" data-f="form"')) : '')
      + fld('League', input('league', v.league, ' maxlength="30" data-f="form"'), '', 'optional')
      + fld('Event', input('event_name', v.event_name, ' maxlength="200" placeholder="Chiefs @ Bills" data-f="form"'), 'full')
      + fld('Market type', sel('position_type', WAGER_TYPES.map(function (t) { return [t, E.POSITION_TYPE_LABEL[t]]; }), type, ' data-f="form"'))
      + fld('Market', input('market_name', v.market_name, ' maxlength="200" placeholder="' + esc(E.POSITION_TYPE_LABEL[type]) + '" data-f="form"'), '', 'optional')
      + fld('Selection', input('selection', v.selection, ' maxlength="200" placeholder="Chiefs -2.5" data-f="form"'), 'full')
      + fld('Line', input('line', v.line, ' inputmode="decimal" placeholder="-2.5" data-f="form"'), '', 'optional')
      + fld(v.odds_format === 'decimal' ? 'Decimal odds' : 'American odds', input('odds', v.odds, ' inputmode="decimal" placeholder="' + (v.odds_format === 'decimal' ? '1.91' : '-110') + '" data-f="form"')
        + '<button type="button" class="pfo-btn ghost sm" data-act="odds-format">Use ' + (v.odds_format === 'decimal' ? 'American' : 'decimal') + ' odds</button>')
      + fld('Stake ($)', input('stake', v.stake, ' inputmode="decimal" placeholder="100.00" data-f="form"'))
      + fld('Stake type', sel('stake_type', [['CASH', 'Cash'], ['BONUS', 'Bonus bet (site credit)']], v.stake_type || 'CASH', ' data-f="form"'), '', 'a bonus bet risks no cash and pays only its winnings')
      + fld('Placed', input('placed_at', v.placed_at, ' type="datetime-local" data-f="form"'))
      + fld('Event starts', input('event_start_at', v.event_start_at, ' type="datetime-local" data-f="form"'), '', 'optional — kept apart from when you placed it')
      + fld('Status', sel('status', Object.keys(STATUS_LABEL).map(function (k) { return [k, k === 'SETTLED' ? 'Settled at another payout' : STATUS_LABEL[k]]; }), status, ' data-f="form"'))
      + (status !== 'OPEN' ? fld('Settled', input('settled_at', v.settled_at || v.placed_at, ' type="datetime-local" data-f="form"'))
        + fld('Amount the book paid ($)', input('reported_payout', v.reported_payout, ' inputmode="decimal" data-f="form"'), '', (status === 'CASHED_OUT' || status === 'SETTLED') ? 'required' : 'only if it differs') : '')
      + fld('Fees ($)', input('fees', v.fees, ' inputmode="decimal" placeholder="0" data-f="form"'), '', 'optional')
      + attributionFields(v, opts.recs) + (opts.edit ? '' : decisionFields(v))
      + fld('Notes', '<textarea name="notes" maxlength="2000" data-f="form">' + esc(v.notes || '') + '</textarea>', 'full', 'optional');
    if (type === 'PARLAY' || type === 'SAME_GAME_PARLAY') h += '<div class="pfo-note full">Enter the parlay’s combined odds. If a leg pushed and the book re-priced the ticket, choose “Settled at another payout” and enter what it paid.</div>';
    return h + '</form>';
  }
  function predictionForm(v, opts) {
    opts = opts || {};
    var state = v.state || 'OPEN', side = v.side || 'YES';
    var h = '<form class="pfo-form" data-form="prediction" novalidate>'
      + fld('Platform', sel('platform', platformOptions('PREDICTION_MARKET', v.platform), v.platform || '', ' data-f="form"'))
      + (v.platform === '__other' ? fld('Platform name', input('platform_other', v.platform_other, ' maxlength="60" data-f="form"')) : fld('Sport', input('sport', v.sport, ' list="pfo-sports" maxlength="30" data-f="form"'), '', 'optional'))
      + fld('Event or question', input('event_name', v.event_name, ' maxlength="200" placeholder="Will the Chiefs win Super Bowl LXI?" data-f="form"'), 'full')
      + fld('Market', input('market_name', v.market_name, ' maxlength="200" data-f="form"'), 'full', 'optional — defaults to the question')
      + fld('Side', sel('side', [['YES', 'YES'], ['NO', 'NO'], ['__other', 'Another outcome…']], side, ' data-f="form"'))
      + (side === '__other' ? fld('Outcome held', input('side_other', v.side_other, ' maxlength="80" data-f="form"')) : '<span></span>');
    if (!opts.edit) {
      h += fld('Contracts', input('contracts', v.contracts, ' inputmode="decimal" placeholder="100" data-f="form"'))
        + fld('Average entry price ($)', input('price', v.price, ' inputmode="decimal" placeholder="0.61" data-f="form"'))
        + fld('Fees ($)', input('fees', v.fees, ' inputmode="decimal" placeholder="0" data-f="form"'), '', 'optional')
        + fld('Opened', input('placed_at', v.placed_at, ' type="datetime-local" data-f="form"'))
        + fld('Event starts', input('event_start_at', v.event_start_at, ' type="datetime-local" data-f="form"'), '', 'optional');
    }
    h += fld('Status', sel('state', [['OPEN', 'Open'], ['RESOLVED', 'Resolved']].concat(opts.edit ? [] : [['SOLD', 'Sold before it resolved']]), state, ' data-f="form"'));
    if (state === 'OPEN') h += fld('Current price ($)', input('current_price', v.current_price, ' inputmode="decimal" placeholder="0.68" data-f="form"'), '', 'optional — your own mark');
    if (state === 'RESOLVED') {
      h += fld('Resolved as', sel('resolution', [['', 'Choose…'], ['YES', 'YES'], ['NO', 'NO'], ['VOID', 'Voided / refunded']].concat(side === '__other' ? [['__side', 'The outcome I held']] : []), v.resolution || '', ' data-f="form"'))
        + fld('Resolved', input('settled_at', v.settled_at || v.placed_at, ' type="datetime-local" data-f="form"'));
    }
    if (state === 'SOLD') {
      h += fld('Sold at ($ per contract)', input('exit_price', v.exit_price, ' inputmode="decimal" data-f="form"'))
        + fld('Sold', input('settled_at', v.settled_at || v.placed_at, ' type="datetime-local" data-f="form"'))
        + fld('Fees on the sale ($)', input('exit_fees', v.exit_fees, ' inputmode="decimal" placeholder="0" data-f="form"'), '', 'optional');
    }
    h += attributionFields(v, opts.recs) + (opts.edit ? '' : decisionFields(v))
      + fld('Notes', '<textarea name="notes" maxlength="2000" data-f="form">' + esc(v.notes || '') + '</textarea>', 'full', 'optional');
    return h + '</form>';
  }
  /* the decision, recorded with the position — before the event, so it counts */
  function decisionFields(v) {
    return fld('Planned or not', sel('planned', [['', 'Not recorded'], ['true', 'PLANNED'], ['false', 'UNPLANNED']], v.planned || '', ' data-f="form"'), '', 'optional')
      + fld('Model probability for your side', input('model_probability_j', v.model_probability_j, ' inputmode="decimal" placeholder="0.55" data-f="form"'), '', 'optional, 0–1')
      + fld('Why you are entering', '<textarea name="thesis" maxlength="1000" data-f="form">' + esc(v.thesis || '') + '</textarea>', 'full', 'optional — your thesis, recorded once');
  }
  function decisionPatch(v) {
    var out = {};
    if (v.planned === 'true' || v.planned === 'false') out.planned = v.planned === 'true';
    if (!blank(v.thesis)) out.thesis = String(v.thesis).trim().slice(0, 1000);
    if (!blank(v.model_probability_j) && +v.model_probability_j > 0 && +v.model_probability_j < 1) out.model_probability = String(+v.model_probability_j);
    return out;
  }
  function fillsEditor(fills, readOnly) {
    var h = '<div class="pfo-fills"><div class="pfo-sec-h" style="margin-top:6px">Trades</div>';
    h += (fills || []).map(function (f) {
      var act = f.transaction_type === 'FILL' ? f.side : f.transaction_type;
      return '<div class="pfo-row"><div class="pfo-row-n">' + esc(act) + ' ' + esc(E.qtyText(f.quantity)) + ' @ ' + esc(E.priceText(f.price))
        + '<small>' + esc(dateText(f.executed_at, true)) + (E.dec.sign(f.fee || '0') > 0 ? ' · fee ' + esc(E.money(f.fee)) : '') + ' · ' + esc(SOURCE_LABEL[f.source] || f.source) + '</small></div>'
        + '<div class="pfo-row-v">' + (readOnly || f.source === 'SYNC' ? '' : '<button class="pfo-btn danger sm" data-act="fill-delete" data-id="' + esc(f.id) + '">Delete</button>') + '</div></div>';
    }).join('');
    if (!readOnly) {
      h += '<form class="pfo-fill" data-form="fill" novalidate>'
        + fld('Trade', sel('action', [['BUY', 'Buy'], ['SELL', 'Sell']], 'BUY'))
        + fld('Contracts', input('quantity', '', ' inputmode="decimal"'))
        + fld('Price ($)', input('price', '', ' inputmode="decimal"'))
        + fld('Fee ($)', input('fee', '', ' inputmode="decimal" placeholder="0"'))
        + fld('When', input('executed_at', isoToLocalInput(new Date().toISOString()), ' type="datetime-local"'))
        + '<button class="pfo-btn sm" data-act="fill-add" type="button">Add trade</button></form>';
    }
    return h + '</div>';
  }

  /* ═══ CSV export of the history (the reader's own data) ══════════════ */
  function csvCell(x) {
    var t = String(x == null ? '' : x);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;   /* a spreadsheet never runs a cell as a formula */
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function exportCsv(list) {
    var cols = ['placed_at', 'settled_at', 'platform_label', 'platform_type', 'sport', 'league', 'event_name', 'market_name', 'position_type', 'selection', 'side', 'line',
      'odds_american', 'odds_decimal', 'stake', 'contracts_bought', 'average_entry_price', 'cost_basis', 'fees', 'status', 'result', 'gross_payout', 'profit_loss', 'source', 'edge_source', 'notes'];
    return [cols.join(',')].concat(list.map(function (p) { return cols.map(function (c) { return csvCell(p[c]); }).join(','); })).join('\r\n') + '\r\n';
  }

  /* ═══ the controller ═════════════════════════════════════════════════ */
  function defaults() {
    var tz = 'UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { /* keep UTC */ }
    var month = new Date().toISOString().slice(0, 7);
    try { month = E.localDate(Date.now(), tz).slice(0, 7); } catch (_) { /* keep UTC month */ }
    return { tab: 'overview', positions: null, accounts: null, imports: null, period: 'ALL', tz: tz, histLimit: 100,
      platform: '', sum: null, cells: null, analysis: null, sumError: null,
      cal: { month: month, basis: 'placed', view: 'month', selected: null, days: null, dayList: null },
      jr: { top: null, openYear: null, yearRows: null, day: null, dayList: null, opened: {} },
      coach: { sub: 'overview' }, custom: null, rowById: {}, seq: {},
      setup: { selected: {}, open: false }, registry: null, connections: null, runs: null, isAdmin: false, admin: null,
      openFilter: { kind: 'ALL', platform: '', sport: '', placed: '' },
      histFilter: { q: '', state: 'SETTLED', kind: '', platform: '', sport: '', league: '', type: '', result: '', source: '', from: '', to: '' },
      imp: {}, recs: null, live: null };
  }
  var LIVE = null;
  function registerLiveProvider(fn) { LIVE = typeof fn === 'function' ? fn : null; }

  function mount(host, opts) {
    opts = opts || {};
    var S = defaults(), A = makeApi(opts.deps), doc = host.ownerDocument || root.document;
    S.live = function (p) { return LIVE ? LIVE(p) : null; };
    S.now = opts.now || null;
    /* which tabs this mount shows (the Portfolio page by default; the Process
       seat mounts the coach alone); a tab outside them is routed to the app */
    S.tabs = opts.tabs ? opts.tabs.map(function (k) { return [k, TAB_LABEL[k] || k]; }) : TABS;
    S.tab = S.tabs[0][0]; S.bare = !!opts.bare; S.name = opts.name || 'Portfolio';
    host.classList.add('pfo-root');
    host.innerHTML = shell(S) + (doc.getElementById('pfo-sports') ? '' : '<datalist id="pfo-sports">' + SPORTS.map(function (s) { return '<option value="' + s + '">'; }).join('') + '</datalist>');
    var body = host.querySelector('[data-r="body"]'), sheet = host.querySelector('[data-r="sheet"]');
    var form = null;   /* the sheet's state: { kind, values, edit, id, fills, error, dupRetry } */

    function signedIn() { try { return !!(opts.deps && opts.deps.userId) || !!(root.edUser && root.edUser() && root.edUser().id); } catch (_) { return false; } }
    function paint() {
      host.querySelectorAll('.pfo-tab').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-v') === S.tab)); });
      if (!signedIn()) { body.innerHTML = '<div class="pfo-empty"><b>Sign in to use ' + esc(S.name) + '.</b> Your positions are stored on your EdgeDesk account and only you can read them.</div>'; return; }
      if (S.error) { body.innerHTML = '<div class="pfo-err">' + esc(S.error) + '</div><div class="pfo-btns"><button class="pfo-btn ghost" data-act="reload">Try again</button></div>'; return; }
      if (S.positions == null && (S.tab === 'open' || S.tab === 'history')) { body.innerHTML = '<div class="pfo-empty">Loading your positions…</div>'; return; }
      var v = { overview: overviewServer, open: openView, history: historyView, analytics: analyticsServer, accounts: function () { return accountsView(S); }, import: importView,
        calendar: function () { return '<div class="pfo-filters">' + J.platformChips(S.accounts, S.platform) + '</div>' + (S.cal.days == null ? '<div class="pfo-empty">Loading the calendar…</div>' : J.calendarView(Object.assign({ tz: S.tz }, S.cal))); },
        journal: function () { return '<div class="pfo-filters">' + J.platformChips(S.accounts, S.platform) + '</div>' + (S.jr.top == null ? '<div class="pfo-empty">Loading your journal…</div>' : J.journalView(Object.assign({ tz: S.tz }, S.jr))); },
        coach: function () {
          if (S.positions && !S.positions.length) return emptyProcess();
          return J.processView(Object.assign({}, S.coach, { summary: S.sum, cells: S.cells, analysis: S.analysis, error: S.sumError,
            filter: { chips: filterChips() }, now: S.now || Date.now() }));
        } }[S.tab] || overviewServer;
      body.innerHTML = v(S);
      remember();
      if (S.tab === 'accounts' && S.accounts != null && setupVisible(S)) {
        if (!(S.accounts || []).length && !(S.positions || []).length) ttv('portfolio_onboarding_started');
        if ((S.positions || []).length && body.querySelector('[data-r="ready"]') && S.setup.sawEmpty) ttv('portfolio_ready');
      }
    }
    async function load() {
      if (!signedIn()) { paint(); return; }
      S.error = null; paint();
      try {
        var r = await Promise.all([A.positions(), A.accounts()]);
        var before = S.positions == null ? null : S.positions.length;
        S.positions = r[0] || []; S.accounts = r[1] || [];
        if (!S.positions.length) S.setup.sawEmpty = true;
        if (before === 0 && S.positions.length > 0) ttv('first_position_created');
      } catch (e) { S.error = friendly(e).text; }
      invalidate(); paint(); loadTab();
    }
    /* a newer request for the same thing makes an older answer moot */
    var gen = 0;
    function ticket(k) { var n = ++gen; S.seq[k] = n; return function () { return S.seq[k] === n; }; }
    /* the rows on screen, so the journal editor knows what it is editing */
    function remember() {
      [S.cal.dayList, S.jr.dayList, S.listRows].concat(S.coach.film ? [S.coach.film.best, S.coach.film.worst, S.coach.film.badWins, S.coach.film.goodLosses, S.coach.film.broken,
        S.coach.film.settledList, S.coach.film.placedList] : [])
        .forEach(function (l) { (l || []).forEach(function (x) { S.rowById[x.id] = x; }); });
    }
    function iso(t) { return t == null ? null : new Date(t).toISOString(); }
    function range() {
      if (S.period === 'CUSTOM' && S.custom && S.custom.from && S.custom.to) return { from: iso(localMidnight(S.custom.from)), to: iso(localMidnight(S.custom.to) + 86400000) };
      var r = E.periodRange(S.period, S.now || Date.now(), S.tz); return { from: iso(r.from), to: iso(r.to) };
    }
    function periodName() {
      if (S.period === 'CUSTOM' && S.custom) return J.dayLabel(S.custom.from).replace(/^\w+ /, '') + ' – ' + J.dayLabel(S.custom.to).replace(/^\w+ /, '');
      return PERIOD_LABEL[S.period] || 'all time';
    }
    /* the period as dates, for every WHY */
    function periodText() {
      var r = range(), d = function (x) { return dateText(x, false, S.tz); };
      var today = d(new Date(S.now || Date.now()).toISOString());
      return (r.from ? d(r.from) + ' – ' + (r.to ? d(new Date(Date.parse(r.to) - 1).toISOString()) : today) : 'All time, through ' + today) + ' (' + periodName() + ', your time zone)';
    }
    /* the Process page's Filter: what is applied, as removable chips */
    function platformList() {
      var seen = {}, out = [];
      (S.accounts || []).concat(S.positions || []).forEach(function (a) {
        if (!a || !a.platform || seen[a.platform]) return; seen[a.platform] = 1;
        out.push({ key: a.platform, label: a.platform_label || E.platformLabel(a.platform, a.platform), type: a.platform_type || null });
      });
      return out.sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); });
    }
    function filterChips() {
      var out = [], pl = S.platform || '';
      if (pl) out.push({ k: 'platform', label: pl === 'type:SPORTSBOOK' ? 'Sportsbooks' : pl === 'type:PREDICTION_MARKET' ? 'Prediction markets'
        : (platformList().filter(function (x) { return x.key === pl; })[0] || {}).label || E.platformLabel(pl, pl) });
      if (S.period && S.period !== 'ALL') { var n = periodName(); out.push({ k: 'period', label: n.charAt(0).toUpperCase() + n.slice(1) }); }
      return out;
    }
    function filterValues() {
      var pl = S.platform || '', type = /^type:/.test(pl) ? pl.slice(5) : '', key = type ? '' : pl;
      if (key) type = (platformList().filter(function (x) { return x.key === key; })[0] || {}).type || '';
      return { source: type, platform: key, period: S.period || 'ALL', from: S.custom && S.custom.from, to: S.custom && S.custom.to };
    }
    function applyFilter(v) {
      if (v.period === 'CUSTOM') {
        if (!v.from || !v.to) { form.values.error = 'Choose both dates for a custom range.'; return repaintSheet(); }
        if (v.from > v.to) { form.values.error = 'The start date is after the end date.'; return repaintSheet(); }
      }
      var pl = v.platform || (v.source ? 'type:' + v.source : '');
      S.platform = pl; S.period = v.period || 'ALL'; S.custom = v.period === 'CUSTOM' ? { from: v.from, to: v.to } : null;
      closeSheet(); invalidate(); paint(); loadTab();
    }
    function pad2(x) { return (x < 10 ? '0' : '') + x; }
    async function loadOverview() {
      var ok = ticket('overview'), r = range();
      try {
        var res = await Promise.all([A.summary(r.from, r.to, S.tz, S.platform), A.cells(r.from, r.to, S.tz, S.platform, true)]);
        if (!ok()) return;
        S.sum = res[0]; S.cells = res[1] || []; S.sumError = null;
        S.analysis = X.analyze(S.cells, { period: periodText() });
        var hl = X.headlines(S.analysis);
        if ((S.sum.process && +S.sum.process.graded > 0) || hl.working.length || hl.not_working.length) ttv('first_process_insight_ready');
      } catch (e) {
        if (!ok()) return;
        S.sumError = 'The summary could not be loaded (' + friendly(e).text + ')' + (S.tab === 'coach' ? '.' : ' — showing figures from the positions on this page'
          + ((S.positions || []).historyCapped ? ' (your open positions and the most recent 1,000 settled)' : '') + '.');
      }
      if (['overview', 'analytics', 'coach'].indexOf(S.tab) >= 0) paint();
    }
    function shiftDay(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
    /* the month on screen, widened to the selected week when it crosses a month */
    function calRange(c) {
      var y = +c.month.slice(0, 4), m = +c.month.slice(5, 7), from = c.month + '-01', to = m === 12 ? (y + 1) + '-01-01' : y + '-' + pad2(m + 1) + '-01';
      if (c.view === 'week' && c.selected) { var w0 = mondayOf(c.selected), w1 = shiftDay(w0, 7); if (w0 < from) from = w0; if (w1 > to) to = w1; }
      return { from: from, to: to };
    }
    async function loadCalendar() {
      var c = S.cal, ok = ticket('calendar'), r = calRange(c);
      c.loaded = r; c.loading = c.days != null;   /* a first load has its own placeholder */
      try { var days = await A.calendar(r.from, r.to, S.tz, S.platform) || []; if (!ok()) return; c.days = days; }
      catch (e) { if (!ok()) return; c.days = []; S.error = friendly(e).text; }
      c.loading = false;
      if (S.tab === 'calendar') paint();
    }
    function ensureCalendar() { var c = S.cal, r = calRange(c); if (c.days == null || !c.loaded || r.from < c.loaded.from || r.to > c.loaded.to) loadCalendar(); }
    async function loadDay(target, day) {
      var ok = ticket(target === S.cal ? 'cal-day' : 'jr-day');
      target.selected = day; target.day = day; target.dayList = null; paint();
      var d0 = Date.parse(day + 'T00:00:00Z'), list;
      try { list = await A.list(iso(d0 - 2 * 86400000), iso(d0 + 3 * 86400000), S.tz, { day: day }, 200, S.platform) || []; }
      catch (e) { if (!ok()) return; list = []; S.error = friendly(e).text; }
      if (!ok()) return;
      target.dayList = list; paint();
    }
    async function loadJournal() {
      var ok = ticket('journal'), top;
      try { top = await A.periods(S.tz, null, S.platform) || []; } catch (e) { if (!ok()) return; top = []; S.error = friendly(e).text; }
      if (!ok()) return;
      S.jr.top = top;
      if (S.tab === 'journal') paint();
    }
    async function loadYear() {
      var y = S.jr.openYear, ok = ticket('year'), rows;
      if (y == null) return;
      try { rows = await A.periods(S.tz, y, S.platform) || []; } catch (e) { if (!ok()) return; rows = []; S.error = friendly(e).text; }
      if (!ok() || S.jr.openYear !== y) return;
      S.jr.yearRows = rows;
      if (S.tab === 'journal') paint();
    }
    /* one year open at a time; opening it fetches its months, weeks and days */
    function openYear(y) {
      if (S.jr.openYear === y) return;
      S.jr.openYear = y; S.jr.yearRows = null; paint(); loadYear();
    }
    function mondayOf(dateStr) { var d = new Date(Date.parse(dateStr + 'T00:00:00Z')); d = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000); return d.toISOString().slice(0, 10); }
    function localMidnight(dateStr) { var p = dateStr.split('-'); return E.zonedToUtc(+p[0], +p[1], +p[2], 0, 0, 0, S.tz); }
    async function loadCoach() {
      /* an empty book has nothing to grade: no summary to ask the server for */
      if (S.positions && !S.positions.length) return;
      var c = S.coach, ok = ticket('coach');
      if (!S.sum && !S.sumError) await loadOverview();
      if (!ok()) return;
      var sub = c.sub === 'report' ? 'overview' : c.sub;
      try {
        if (sub === 'outcome' && !c.compare) {
          var now = S.now || Date.now(), r = await Promise.all([A.summary(iso(now - 30 * 86400000), iso(now), S.tz, S.platform), A.summary(iso(now - 60 * 86400000), iso(now - 30 * 86400000), S.tz, S.platform)]);
          c.compare = X.compare(r[0], r[1]);
        }
        if ((sub === 'rules' || sub === 'explore') && c.rules == null) {
          try { c.rules = await A.rules() || []; } catch (e) { if (sub === 'rules') throw e; c.rules = []; }
        }
        /* the Overview's "current experiment", Explore's count and the page itself */
        if ((sub === 'experiments' || sub === 'overview' || sub === 'explore' || sub === 'film') && c.experiments == null) {
          try {
            var exps = await A.experiments() || [], results = {};
            await Promise.all(exps.map(async function (e) {
              if (sub !== 'experiments' && e.status !== 'ACTIVE') return;
              var s0 = Date.parse(e.starts_at), e0 = Math.min(Date.parse(e.ended_at || e.ends_at), S.now || Date.now()), len = Date.parse(e.ends_at) - s0;
              var w = await A.cells(iso(s0), iso(e0), S.tz, S.platform, false), b = await A.cells(iso(s0 - len), iso(s0), S.tz, S.platform, false);
              results[e.id] = X.evaluateExperiment(e, w, b);
            }));
            if (!ok()) return;
            c.experiments = exps; c.expResults = results; c.expAll = sub === 'experiments';
          } catch (e) { if (sub === 'experiments') throw e; c.experiments = []; c.expResults = {}; }
        } else if (sub === 'experiments' && c.experiments && !c.expAll) { c.experiments = null; return loadCoach(); }
        if (sub === 'overview' && R && !c.memoryAt) {
          c.memoryAt = Date.now();
          await loadMemory(ok);
          if (!ok()) return;
        }
        if (sub === 'film') {
          /* the week's settled positions get their outcome class persisted first */
          await A.classifyOutcomes(S.tz).catch(function () { return null; });
          c.week = c.week || mondayOf(E.localDate(S.now || Date.now(), S.tz));
          var from = localMidnight(c.week), to = from + 7 * 86400000, q = function (f, n) { return A.list(iso(from), iso(to), S.tz, Object.assign({ basis: 'placed' }, f), n, S.platform); };
          var res = await Promise.all([A.summary(iso(from), iso(to), S.tz, S.platform), A.summary(iso(from - 28 * 86400000), iso(from), S.tz, S.platform),
            q({ order: 'process_desc', process: 'GOOD' }, 3), q({ order: 'process_asc', process: 'POOR' }, 3), q({ process: 'POOR', result: 'WIN' }, 5),
            q({ process: 'GOOD', result: 'LOSS' }, 5), q({ rules_broken: true }, 5),
            /* what settled this week: the review, and the positions a sparse week shows */
            A.list(iso(from), iso(to), S.tz, { basis: 'settled' }, 30, S.platform), q({}, 10)]);
          c.film = { week: c.week, summary: res[0], prior: res[1], best: res[2], worst: res[3], badWins: res[4], goodLosses: res[5], broken: res[6],
            settledList: res[7], placedList: res[8] };
        }
      } catch (e) { if (ok()) S.error = friendly(e).text; }
      if (ok() && S.tab === 'coach') paint();
    }
    /* PROCESS MEMORY: each surfaced pattern is looked at again (the server
       stores the numbers and the positions), then the remembered patterns,
       the personal baseline and the analysis depth are read back. Optional:
       a database without portfolio_decision.sql shows the page without them. */
    async function loadMemory(ok) {
      var c = S.coach, r = range();
      try {
        var hl = X.headlines(S.analysis || { findings: [], tested: 0, total: 0 }, { limit: 1 });
        var picks = hl.working.slice(0, 1).concat(hl.not_working.slice(0, 1));
        await Promise.all(picks.map(function (f) {
          return A.observeInsight({ dim: f.dim, key: f.key, metric: f.metric, kind: f.kind, label: X.keyLabel(f.dim, f.key) }, r.from, r.to, S.tz).catch(function () { return null; });
        }));
        var got = await Promise.all([A.insightMemory().catch(function () { return null; }), A.baseline(S.tz).catch(function () { return null; }),
          S.period === 'ALL' && !S.platform ? Promise.resolve(S.sum) : A.summary(null, null, S.tz, null).catch(function () { return null; })]);
        if (ok && !ok()) return;
        c.memory = (got[0] || []).map(R.memoryItem);
        c.baselineChange = got[1] ? R.baselineChange(got[1]) : null;
        var life = got[2] && got[2].process;
        c.depth = life ? R.depth(+life.graded || 0) : null;
        c.questions = R.questions(hl, c.memory, J.metricText);
      } catch (e) { /* memory is an addition; the page stands without it */ }
      if (!S.noticesAt) { S.noticesAt = Date.now(); A.dueNotices().catch(function () { return null; }); }
    }
    /* each tab fetches what it shows, when it is shown */
    /* the connection side of Accounts: switched-on platforms, schedules, the
       sync log, and the operator's panel — each optional, quietly absent on a
       database without portfolio_connect.sql */
    async function loadAccountsExtras() {
      /* the ready card's all-time totals come from the server, never from the page's capped rows */
      var wantLife = S.tab === 'accounts' && (S.positions || []).length > 0 && setupVisible(S);
      var got = await Promise.all([A.registry().catch(function () { return null; }), A.connections().catch(function () { return null; }),
        A.runs().catch(function () { return null; }), A.isAdmin().catch(function () { return false; }),
        wantLife ? A.summary(null, null, S.tz, null).then(function (x) { return { ok: x }; }, function () { return { err: true }; }) : null]);
      var reg = {}; (got[0] || []).forEach(function (g) { reg[g.platform_key] = g; });
      var conn = {}; (got[1] || []).forEach(function (c) { conn[c.id] = c; });
      S.registry = reg; S.connections = conn; S.runs = got[2] || []; S.isAdmin = got[3] === true;
      if (got[4]) { S.lifetime = got[4].ok || null; S.lifetimeError = !!got[4].err; }
      if (S.isAdmin) {
        var ad = await Promise.all([A.adminHealth().catch(function () { return null; }), A.adminTtv().catch(function () { return null; })]);
        S.admin = { health: ad[0], ttv: ad[1] };
      }
      if (S.tab === 'accounts') paint();
    }
    function loadTab() {
      if (!signedIn()) return;
      if (S.tab === 'accounts' || S.tab === 'import') loadAccountsExtras();
      if (S.tab === 'overview' || S.tab === 'analytics') { if (!S.sum && !S.sumError) loadOverview(); }
      if (S.tab === 'calendar') { ensureCalendar(); if (S.cal.selected && S.cal.dayList == null) loadDay(S.cal, S.cal.selected); }
      if (S.tab === 'journal') {
        if (S.jr.top == null) loadJournal();
        if (S.jr.openYear != null && S.jr.yearRows == null) loadYear();
        if (S.jr.day && S.jr.dayList == null) loadDay(S.jr, S.jr.day);
      }
      if (S.tab === 'coach') loadCoach();
    }
    /* after a write, or a new platform filter: everything the server summarized is redrawn */
    function invalidate() {
      S.seq = {};
      S.sum = null; S.cells = null; S.analysis = null; S.sumError = null; S.lifetime = null; S.lifetimeError = null;
      S.cal.days = null; S.cal.dayList = null; S.cal.loaded = null;
      S.jr.top = null; S.jr.yearRows = null; S.jr.dayList = null;
      S.coach = { sub: S.coach.sub, week: S.coach.week, expDraft: S.coach.expDraft, reviewDraft: S.coach.reviewDraft };
    }
    /* a new period changes the summary, not the calendar or the journal */
    function invalidatePeriod() { delete S.seq.overview; delete S.seq.coach; S.sum = null; S.cells = null; S.analysis = null; S.sumError = null; }
    async function loadImports() { try { S.imports = await A.imports(); } catch (_) { S.imports = []; } if (S.tab === 'import') paint(); }
    async function recs() { if (S.recs == null) { try { S.recs = await A.edgeRecords(); } catch (_) { S.recs = []; } } return S.recs; }

    /* ── the sheet ── */
    function sheetHTML() {
      if (!form) return '';
      if (form.kind === 'why') return J.whyPanel(form.item);
      if (form.kind === 'filter') return J.filterSheet(form.values, platformList());
      if (form.kind === 'connect') return connectSheet(form);
      var title = form.kind === 'choose' ? 'Add a position' : form.kind === 'account' ? 'Add an account' : form.kind === 'list' ? form.title
        : form.kind === 'journal' ? 'Decision record' + (form.row && form.row.event_name ? ' · ' + form.row.event_name : '')
        : (form.edit ? 'Edit position' : form.card ? 'Record position' : form.kind === 'wager' ? 'Record a sportsbook bet' : 'Record a prediction-market position');
      var h = '<div class="pfo-panel" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="pfo-panel-h"><div class="pfo-panel-t">' + esc(title) + '</div>'
        + '<button class="pfo-x" data-act="close" aria-label="Close">×</button></div>';
      if (form.kind === 'list') {
        if (form.error) return h + '<div class="pfo-err">' + esc(form.error) + '</div></div>';
        if (form.rows == null) return h + '<div class="pfo-note">Loading…</div></div>';
        return h + '<div class="pfo-note">' + (form.rows.length >= 200 ? 'The first 200 positions' : form.rows.length + ' position' + (form.rows.length === 1 ? '' : 's'))
          + ' entered in ' + esc(PERIOD_LABEL[S.period]) + (form.note ? ' · ' + esc(form.note) : '') + '.</div>'
          + (form.rows.length ? form.rows.map(J.journalCard).join('') : '<div class="pfo-empty">None.</div>') + '</div>';
      }
      if (form.kind === 'journal') {
        var x = form.row || {};
        h += '<div class="pfo-note">' + esc([x.platform_label, x.selection || x.side, x.placed_at ? 'entered ' + dateText(x.placed_at, true, S.tz) : null].filter(Boolean).join(' · ')) + '</div>';
        if (form.j == null) return h + (form.error ? '<div class="pfo-err">' + esc(form.error) + '</div>' : '<div class="pfo-note">Loading the decision record…</div>') + '</div>';
        return h + (form.rec ? J.decisionRecordView(form.rec, { ask: !!R }) : '')
          + '<details class="pfo-dr-edit" open><summary>Journal: record what is missing, review the decision</summary>'
          + J.journalEditor(form.j, x) + '</details>' + (form.error ? '<div class="pfo-err">' + esc(form.error) + '</div>' : '')
          + '<div class="pfo-btns"><button class="pfo-btn" data-act="journal-save"' + (form.busy ? ' disabled' : '') + '>Save journal</button>'
          + '<button class="pfo-btn ghost" data-act="' + (form.back ? 'journal-back' : 'close') + '">' + (form.back ? 'Back' : 'Cancel') + '</button></div></div>';
      }
      if (form.kind === 'choose') {
        return h + '<div class="pfo-btns" style="flex-direction:column"><button class="pfo-btn" data-act="new-wager">Sportsbook bet</button>'
          + '<button class="pfo-btn ghost" data-act="new-prediction">Prediction-market position</button>'
          + '<button class="pfo-btn ghost" data-act="tab" data-v="import">Import a CSV instead</button></div></div>';
      }
      if (form.kind === 'account') {
        var v = form.values;
        return h + '<form class="pfo-form" data-form="account" novalidate>'
          + fld('Kind', sel('platform_type', [['SPORTSBOOK', 'Sportsbook'], ['PREDICTION_MARKET', 'Prediction market']], v.platform_type || 'SPORTSBOOK', ' data-f="form"'))
          + fld('Platform', sel('platform', platformOptions(v.platform_type || 'SPORTSBOOK', v.platform), v.platform || '', ' data-f="form"'))
          + (v.platform === '__other' ? fld('Platform name', input('platform_other', v.platform_other, ' maxlength="60" data-f="form"'), 'full') : '')
          + fld('How you will track it', sel('connection_type', [['MANUAL', 'Manual entry'], ['CSV', 'CSV import']], v.connection_type || 'MANUAL', ' data-f="form"'))
          + fld('Nickname', input('display_name', v.display_name, ' maxlength="60" data-f="form"'), '', 'optional')
          + '</form><div class="pfo-note">Automatic sync is not available for any platform yet, so EdgeDesk does not offer to connect one.</div>'
          + (form.error ? '<div class="pfo-err">' + esc(form.error) + '</div>' : '')
          + '<div class="pfo-btns"><button class="pfo-btn" data-act="save-account">Add account</button><button class="pfo-btn ghost" data-act="close">Cancel</button></div></div>';
      }
      var synced = form.position && form.position.source === 'SYNC';
      if (form.kind === 'wager') {
        var w = wagerFromForm(form.values, S.recs);
        /* from the Card: where it came from, then BEFORE YOU ENTER, then the form */
        if (form.card) h += J.cardOriginNote(form.card, S.now || Date.now()) + '<div data-r="prebet">' + prebetHTML(form) + '</div>';
        h += wagerForm(form.values, { recs: S.recs }) + wagerPreview(w.row);
      } else {
        var pr = predictionFromForm(form.values, S.recs);
        if (form.edit) {
          var f2 = (form.fills || []).map(function (f) { return { action: f.transaction_type === 'FILL' ? f.side : f.transaction_type, quantity: f.quantity, price: f.price, fee: f.fee }; });
          h += predictionForm(form.values, { edit: true, recs: S.recs }) + predictionPreview(Object.assign({}, pr.payload, { fills: f2 })) + fillsEditor(form.fills, synced);
        } else h += predictionForm(form.values, { recs: S.recs }) + predictionPreview(pr.payload);
      }
      if (!form.edit && !form.card) h += '<div data-r="prebet">' + prebetHTML(form) + '</div>';
      if (synced) h += '<div class="pfo-note">This position is synced from its platform. Only the notes and where the idea came from can be edited here.</div>';
      if (form.error) h += '<div class="pfo-err">' + esc(form.error) + (form.dupRetry ? '<div class="pfo-btns"><button class="pfo-btn ghost sm" data-act="save-separate">It is a separate bet — record it anyway</button></div>' : '') + '</div>';
      h += '<div class="pfo-btns"><button class="pfo-btn" data-act="save"' + (form.busy ? ' disabled' : '') + '>' + (form.edit ? 'Save changes' : 'Save position') + '</button>'
        + '<button class="pfo-btn ghost" data-act="close">Cancel</button>'
        + (form.edit && !synced ? '<button class="pfo-btn danger" data-act="delete" style="margin-left:auto">Delete</button>' : '') + '</div>';
      return h + '</div>';
    }
    /* CONNECT: a read-only Kalshi key, or a public Polymarket address. What is
       typed here is read from the form at submit and the field is emptied at
       once: it is never kept in this page's state, written to storage, or
       shown again. */
    function connectSheet(f) {
      var info = K && K.platformInfo(f.platform), label = info ? info.label : E.platformLabel(f.platform);
      var h = '<div class="pfo-panel" role="dialog" aria-modal="true" aria-label="Connect ' + esc(label) + '"><div class="pfo-panel-h"><div class="pfo-panel-t">Connect ' + esc(label) + '</div>'
        + '<button class="pfo-x" data-act="close" aria-label="Close">×</button></div>'
        + '<div class="pfo-note" style="margin-top:0">' + esc(info && info.automatic ? info.automatic.what_the_reader_gives : '') + '</div>'
        + '<form class="pfo-form" data-form="connect" novalidate autocomplete="off">';
      if (f.platform === 'kalshi') {
        h += fld('API key id', '<input name="key_id" autocomplete="off" spellcheck="false" maxlength="100">', 'full')
          + fld('Private key', '<textarea name="private_key" autocomplete="off" spellcheck="false" rows="5" placeholder="Paste the private key of a READ-ONLY key"></textarea>', 'full',
            'checked against Kalshi, then encrypted and stored on EdgeDesk\'s server');
      } else {
        h += fld('Wallet address', '<input name="wallet" autocomplete="off" spellcheck="false" maxlength="400" placeholder="0x…">', 'full', 'public address only');
      }
      h += '</form><div class="pfo-note">Read-only: EdgeDesk cannot place, change or cancel anything. Disconnect any time; '
        + (f.platform === 'kalshi' ? 'disconnecting deletes EdgeDesk\'s copy of the key.' : 'a public address has nothing to revoke.') + '</div>'
        + (f.error ? '<div class="pfo-err">' + esc(f.error) + '</div>' : '')
        + '<div class="pfo-btns"><button class="pfo-btn" data-act="connect-submit"' + (f.busy ? ' disabled' : '') + '>' + (f.busy ? 'Checking…' : 'Connect') + '</button>'
        + '<button class="pfo-btn ghost" data-act="close">Cancel</button></div></div>';
      return h;
    }
    async function submitConnect() {
      var f0 = form;
      if (!f0 || f0.kind !== 'connect' || f0.busy) return;
      var el = sheet.querySelector('form[data-form="connect"]'), body = { action: 'connect', platform: f0.platform };
      if (f0.platform === 'kalshi') {
        var pk = el.querySelector('[name="private_key"]');
        body.key_id = String(el.querySelector('[name="key_id"]').value || '').trim(); body.private_key = String(pk.value || ''); pk.value = '';
        if (!body.key_id || !body.private_key) { f0.error = 'Enter the key id and its private key.'; body = null; return repaintSheet(); }
      } else {
        var v = K ? K.walletVerdict(el.querySelector('[name="wallet"]').value) : { ok: false, code: 'BAD_WALLET' };
        if (!v.ok) { el.querySelector('[name="wallet"]').value = ''; f0.error = K ? K.ERRORS[v.code] : 'That is not a wallet address.'; return repaintSheet(); }
        body.wallet = v.address;
      }
      f0.busy = true; f0.error = null; repaintSheet();
      ttv('connection_started', { entity: f0.platform });
      var r = await A.connectFn(body);
      body = null;
      if (form !== f0) return;
      if (!r || !r.ok) { f0.busy = false; f0.error = (r && r.message) || 'Could not connect. Nothing was stored.'; return repaintSheet(); }
      ttv('connection_completed', { entity: f0.platform });
      closeSheet(); invalidate(); await load();
      var s0 = r.sync || {};
      flash(s0.status === 'FAILED' ? 'Connected. The first sync did not finish (' + ((s0.error && s0.error.message) || 'it will retry') + ').'
        : 'Connected. First sync: ' + ((s0.totals && s0.totals.transactions_inserted) || 0) + ' trades.');
    }
    async function accountAction(act, id) {
      var msg = act === 'acct-disconnect' ? 'Disconnect this account? EdgeDesk deletes its copy of the credential and stops syncing. Your history stays.'
        : act === 'acct-delete-history' ? 'Disconnect and delete every position this connection synced? Their journal entries go too. This cannot be undone.' : null;
      if (msg && typeof root.confirm === 'function' && !root.confirm(msg)) return;
      var r = await A.connectFn(act === 'acct-sync' ? { action: 'sync', account_id: id } : { action: 'disconnect', account_id: id, delete_history: act === 'acct-delete-history' });
      invalidate(); await load();
      if (!r || !r.ok) return flash((r && r.message) || 'That did not work. Nothing was changed.', true);
      flash(act === 'acct-sync' ? 'Synced: ' + ((r.totals && r.totals.transactions_inserted) || 0) + ' new trades.' : (r.revoke || 'Disconnected.'));
    }
    async function setupAdd() {
      var have = {}; (S.accounts || []).forEach(function (a) { have[a.platform] = 1; });
      var picks = Object.keys(S.setup.selected || {}).filter(function (k) { return S.setup.selected[k] && !have[k]; });
      try {
        for (var i = 0; i < picks.length; i++) {
          var p = E.platform(picks[i]);
          await A.createAccount({ platform: p.key, platform_label: p.label, platform_type: p.type, connection_type: 'CSV', status: 'IMPORT_ONLY' });
        }
        S.setup.selected = {};
        await load();
      } catch (e) { flash(friendly(e).text, true); }
    }
    function openSheet(f) { form = f; sheet.hidden = false; sheet.innerHTML = sheetHTML(); var first = sheet.querySelector('select,input,button'); if (first && first.focus) first.focus(); }
    function repaintSheet() {
      var a = doc.activeElement, name = a && a.name, pos = a && a.selectionStart;
      sheet.innerHTML = sheetHTML();
      if (name) { var el = sheet.querySelector('[name="' + name + '"]'); if (el && el.focus) { el.focus(); try { if (pos != null && el.setSelectionRange) el.setSelectionRange(pos, pos); } catch (_) { /* not a text input */ } } }
    }
    function closeSheet() { form = null; sheet.hidden = true; sheet.innerHTML = ''; }
    function readForm(el) {
      var v = {};
      Array.prototype.forEach.call(el.querySelectorAll('[name]'), function (x) { v[x.name] = x.type === 'checkbox' ? x.checked : x.value; });
      return v;
    }
    function nowLocal() { return isoToLocalInput(new Date(S.now || Date.now()).toISOString()); }
    function newWager(platform, label) {
      openSheet({ kind: 'wager', values: { platform: platform || '', platform_label: label, status: 'OPEN', position_type: 'SPREAD', placed_at: nowLocal() } });
      recs().then(function () { if (form && !form.edit) { repaintSheet(); schedulePreBet(); } });
    }
    /* RECORD POSITION from a Card entry (or any EdgeDesk research): the form
       prefilled from what the Card froze, Before You Enter computed at once,
       and — on save — the decision snapshot stored with the position. The
       reader confirms or changes every field; nothing is placed anywhere. */
    function recordFrom(o) {
      o = o || {};
      if (!R || !o.entry) return newWager();
      var pf = R.prefillFromCard(o.entry, { unit: o.unit, current: o.current, now: S.now || Date.now() });
      var card = pf._card; delete pf._card;
      openSheet({ kind: 'wager', values: pf, card: { entry: o.entry, current: o.current || null, meta: card } });
      if (signedIn() && o.entry.entry_id) A.cardEvent(o.entry.entry_id, 'CONSIDERED', { decision: o.entry.decision, sport: o.entry.sport, type: o.entry.type, surface: o.surface || 'card' }).catch(function () {});
      recs().then(function () { if (form && !form.edit) { repaintSheet(); schedulePreBet(); } });
      schedulePreBet();
    }
    /* the snapshot of what EdgeDesk, the market and the reader's own state
       were, stored once with the new position (refused by the server after
       the event — then the position simply has no snapshot) */
    async function recordSnapshot(id) {
      if (!id || !form) return '';
      var row = form.card && R ? R.snapshotFromCard(form.card.entry, form.card.current) : { origin: 'MANUAL', edgedesk: {}, market: {} };
      if (!row) return '';
      row.position_id = id;
      try {
        await A.snapshot(row);
        /* the Card shows the entry as recorded, with the way to its record */
        if (form.card && form.card.entry && root.EDDecisionUI && root.EDDecisionUI.markRecorded) root.EDDecisionUI.markRecorded(form.card.entry.entry_id, id);
        return form.card ? ' Its decision record holds what EdgeDesk and the market showed.' : '';
      }
      catch (e) { return ''; }
    }
    function newPrediction(platform, label) {
      openSheet({ kind: 'prediction', values: { platform: platform || '', platform_label: label, side: 'YES', state: 'OPEN', placed_at: nowLocal() } });
      recs().then(function () { if (form && !form.edit) { repaintSheet(); schedulePreBet(); } });
    }
    async function editPosition(id) {
      var p = (S.positions || []).filter(function (x) { return x.id === id; })[0];
      if (!p) return;
      await recs();
      var edge = p.edge_ref_type ? p.edge_ref_type + ':' + p.edge_ref_id : '';
      var base = { platform: p.platform, platform_label: p.platform_label, sport: p.sport, league: p.league, event_name: p.event_name, market_name: p.market_name,
        notes: p.notes, edge_source: p.edge_source || '', edge_ref: edge };
      if (isWager(p)) {
        openSheet({ kind: 'wager', edit: true, id: id, position: p, values: Object.assign(base, { position_type: p.position_type, selection: p.selection, line: p.line == null ? '' : E.dec.str(p.line),
          odds: p.odds_american != null ? String(p.odds_american) : (p.odds_decimal || ''), odds_format: p.odds_american != null ? 'american' : 'decimal', stake: p.stake,
          status: p.status, settled_at: isoToLocalInput(p.settled_at) || nowLocal(), reported_payout: p.reported_payout || '', fees: p.fees && E.dec.sign(p.fees) ? p.fees : '', placed_at: isoToLocalInput(p.placed_at) }) });
      } else {
        var side = p.side === 'YES' || p.side === 'NO' ? p.side : '__other';
        openSheet({ kind: 'prediction', edit: true, id: id, position: p, fills: [], values: Object.assign(base, { side: side, side_other: side === '__other' ? p.side : '',
          state: p.resolution ? 'RESOLVED' : 'OPEN', resolution: p.resolution ? (['YES', 'NO', 'VOID'].indexOf(p.resolution) >= 0 ? p.resolution : '__side') : '',
          settled_at: isoToLocalInput(p.settled_at) || nowLocal(), current_price: p.current_price || '' }) });
        try { form.fills = await A.fills(id) || []; repaintSheet(); } catch (e) { form.error = friendly(e).text; repaintSheet(); }
      }
    }
    async function refreshAfterWrite(msg) { closeSheet(); await load(); if (msg) flash(msg); }
    function flash(msg, bad) {
      var n = doc.createElement('div'); n.className = bad ? 'pfo-err' : 'pfo-ok'; n.setAttribute('role', bad ? 'alert' : 'status'); n.textContent = msg;
      body.insertBefore(n, body.firstChild); setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 3500);
    }
    async function save(separate) {
      if (!form || form.busy) return;
      form.error = null; form.dupRetry = false;
      var el = sheet.querySelector('form[data-form]');
      if (el) form.values = Object.assign(form.values, readForm(el));
      var synced = form.position && form.position.source === 'SYNC';
      try {
        if (form.kind === 'wager') {
          var w = wagerFromForm(form.values, S.recs), bad = w.issues.filter(function (x) { return x.level === 'error'; });
          if (bad.length && !synced) { form.error = bad.map(function (x) { return x.message; }).join(' '); repaintSheet(); return; }
          form.busy = true; repaintSheet();
          if (form.edit) {
            var patch = synced ? { notes: w.row.notes, edge_source: w.row.edge_source, edge_ref_type: w.row.edge_ref_type, edge_ref_id: w.row.edge_ref_id } : w.row;
            await A.updatePosition(form.id, patch);
            return refreshAfterWrite('Saved.');
          }
          if (separate) w.row.dedupe_occurrence = (form.occurrence = (form.occurrence || 1) + 1);
          var made = await A.createWager(w.row), mid = made && made[0] && made[0].id;
          var dn = await recordDecision(mid), sn = await recordSnapshot(mid);
          return refreshAfterWrite('Recorded.' + dn + sn);
        }
        var pr = predictionFromForm(form.values, S.recs);
        if (form.edit) {
          var patch2 = synced ? { notes: pr.payload.notes, edge_source: pr.payload.edge_source, edge_ref_type: pr.payload.edge_ref_type, edge_ref_id: pr.payload.edge_ref_id }
            : { platform: pr.payload.platform, platform_label: pr.payload.platform_label, sport: pr.payload.sport, league: pr.payload.league, event_name: pr.payload.event_name,
              market_name: pr.payload.market_name, side: pr.payload.side, selection: pr.payload.selection, current_price: pr.payload.current_price,
              resolution: pr.payload.resolution, settled_at: pr.payload.resolution ? pr.payload.settled_at : null, notes: pr.payload.notes,
              edge_source: pr.payload.edge_source, edge_ref_type: pr.payload.edge_ref_type, edge_ref_id: pr.payload.edge_ref_id };
          var bad2 = pr.issues.filter(function (x) { return x.level === 'error' && /PLATFORM|EVENT|SIDE|RESOLUTION|CURRENT/.test(x.code); });
          if (bad2.length && !synced) { form.error = bad2.map(function (x) { return x.message; }).join(' '); repaintSheet(); return; }
          form.busy = true; repaintSheet();
          await A.updatePosition(form.id, patch2);
          return refreshAfterWrite('Saved.');
        }
        var bad3 = pr.issues.filter(function (x) { return x.level === 'error'; });
        if (bad3.length) { form.error = bad3.map(function (x) { return x.message; }).join(' '); repaintSheet(); return; }
        if (separate) pr.payload.dedupe_occurrence = (form.occurrence = (form.occurrence || 1) + 1);
        form.busy = true; repaintSheet();
        var pid = await A.recordPrediction(pr.payload);
        var dn2 = await recordDecision(pid), sn2 = await recordSnapshot(pid);
        return refreshAfterWrite('Recorded.' + dn2 + sn2);
      } catch (e) {
        var fe = friendly(e);
        if (form) { form.busy = false; form.error = fe.text; form.dupRetry = !!fe.dup && !form.edit; repaintSheet(); }
      }
    }
    /* the decision fields of the new-position form go to its journal, once:
       anything the database already recorded (a linked model probability)
       stays as it was */
    async function recordDecision(id) {
      var patch = decisionPatch(form.values);
      if (!id || !Object.keys(patch).length) return '';
      try {
        var j = await A.journal(id) || {};
        Object.keys(patch).forEach(function (k) { if (j[k] != null) delete patch[k]; });
        if (Object.keys(patch).length) await A.updateJournal(id, patch);
        return '';
      } catch (e) { return ' Your decision notes were not saved (' + friendly(e).text.replace(/\.$/, '') + '); add them from the position\'s journal.'; }
    }

    /* ── BEFORE YOU ENTER: context from the reader's own record, never advice ── */
    var preTimer = null;
    function draftOf(f) {
      var v = f.values, d = decisionPatch(v), out;
      if (f.kind === 'wager') {
        var w = wagerFromForm(v, S.recs).row;
        out = { platform_type: 'SPORTSBOOK', platform: w.platform, sport: w.sport, position_type: w.position_type, odds_american: w.odds_american,
          odds_decimal: w.odds_decimal, stake: w.stake, event_start_at: w.event_start_at, model_probability: d.model_probability || w.model_probability || null };
      } else {
        var p = predictionFromForm(v, S.recs).payload, b = p.fills[0] || {};
        out = { platform_type: 'PREDICTION_MARKET', platform: p.platform, sport: p.sport, position_type: p.position_type, price: b.price,
          stake: b.quantity && b.price != null ? E.dec.mul(b.quantity, b.price) : null, event_start_at: p.event_start_at,
          model_probability: d.model_probability || p.model_probability || null };
      }
      if (d.planned != null) out.planned = d.planned;
      if (d.thesis) out.thesis = d.thesis;
      return out;
    }
    function edgedeskFair(f) {
      try {
        var v = f.values;
        if (v.edge_source !== 'EDGEDESK' || blank(v.edge_ref)) return null;
        var at = attribution(v, S.recs), prob = at.model_probability;
        if (!prob || !(+prob > 0 && +prob < 1)) return null;
        if (f.kind === 'wager') {
          var w = wagerFromForm(v, S.recs).row;
          if (w.odds_american == null && !w.odds_decimal) return null;
          return { fair: E.americanText(E.decimalToAmerican(E.dec.divRound('1', prob, 6))), market: w.odds_american != null ? E.americanText(w.odds_american) : E.dec.str(w.odds_decimal) };
        }
        var b = predictionFromForm(v, S.recs).payload.fills[0] || {};
        return b.price != null ? { fair: E.priceText(prob), market: E.priceText(b.price) } : null;
      } catch (_) { return null; }
    }
    function prebetHTML(f) {
      var exp = f ? exposureOn(f.values && f.values.event_name, S.positions) : null;
      return f && (f.prebet || (exp && exp.n)) ? J.preBetPanel(f.prebet || {}, { edgedesk: edgedeskFair(f), exposure: exp }) : '';
    }
    function schedulePreBet() {
      if (!form || form.edit || (form.kind !== 'wager' && form.kind !== 'prediction')) return;
      if (preTimer) clearTimeout(preTimer);
      preTimer = setTimeout(runPreBet, 600);
    }
    async function runPreBet() {
      preTimer = null;
      var f0 = form;
      if (!f0 || f0.edit || (f0.kind !== 'wager' && f0.kind !== 'prediction')) return;
      var draft = draftOf(f0);
      if (!draft.platform && !draft.stake && draft.odds_american == null && !draft.odds_decimal && draft.price == null) return;
      var key = JSON.stringify(draft) + '|' + E.normText(f0.values.event_name);
      if (key === f0.prebetKey) return;
      f0.prebetKey = key;
      var ctx = null;
      /* context is optional: a database without the journal layer simply shows none */
      try { ctx = await A.preBet(draft, S.tz); } catch (_) { ctx = null; }
      if (form !== f0 || f0.prebetKey !== key) return;
      f0.prebet = ctx;
      var slot = sheet.querySelector('[data-r="prebet"]');
      if (slot) slot.innerHTML = prebetHTML(f0);
    }

    /* ── WHY, drill-downs and the journal editor ── */
    /* every WHY on the page: the evidence behind the figure, from the data on screen */
    function openWhy(id) {
      var item = J.whyItem(id, { summary: S.sum, cells: S.cells, analysis: S.analysis, film: S.coach.film, experiments: S.coach.experiments,
        expResults: S.coach.expResults, rows: S.rowById, periodText: periodText(), memory: S.coach.memory, baselineChange: S.coach.baselineChange });
      if (!item && id === 'grade') item = J.GRADE_WHY;
      if (item) openSheet({ kind: 'why', item: item });
    }
    /* the after-the-result reflection: would you make it again, and why.
       Only REVIEW fields are sent; what was recorded before the bet is
       write-once in the database and never part of this patch. */
    function reviewDraft(id) { var d = S.coach.reviewDraft = S.coach.reviewDraft || {}; return (d[id] = d[id] || {}); }
    async function saveReview(id) {
      var d = reviewDraft(id), inp = body.querySelector('[data-review="' + id + '"]');
      if (inp) d.note = inp.value;
      if (!d.again) return flash('Choose YES, NO or UNSURE first.', true);
      var note = String(d.note || '').trim().slice(0, 280) || null;
      try {
        await A.updateJournal(id, { would_repeat: d.again, review_note: note });
        var x = S.rowById[id];
        if (x) x.journal = Object.assign({}, x.journal || {}, { would_repeat: d.again, review_note: note, reviewed_at: new Date(S.now || Date.now()).toISOString() });
        delete S.coach.reviewDraft[id];
        paint(); flash('Reflection saved. What you recorded before the bet is unchanged.');
      } catch (e) { flash(friendly(e).text, true); }
    }
    async function openList(title, filter, note) {
      var r = range(), ok = ticket('list');
      openSheet({ kind: 'list', title: title, note: note, rows: null });
      var f0 = form;
      try {
        var rows = await A.list(r.from, r.to, S.tz, Object.assign({ basis: 'placed' }, filter), 200, S.platform) || [];
        if (!ok() || form !== f0) return;
        f0.rows = rows; S.listRows = rows; remember();
      } catch (e) { if (!ok() || form !== f0) return; f0.error = friendly(e).text; }
      repaintSheet();
    }
    async function openJournal(id) {
      var back = form && form.kind === 'list' ? form : null;
      openSheet({ kind: 'journal', id: id, row: S.rowById[id] || null, j: null, back: back });
      var f0 = form;
      try {
        var got = await Promise.all([A.journal(id), A.decisionRecord(id, S.tz).catch(function () { return null; })]);
        if (form !== f0) return; f0.j = got[0] || {}; f0.rec = got[1];
        if (!f0.row && f0.rec && f0.rec.position) f0.row = Object.assign({}, f0.rec.position, { placed_at: f0.rec.entry && f0.rec.entry.placed_at });
      }
      catch (e) { if (form !== f0) return; f0.error = friendly(e).text; }
      repaintSheet();
    }
    async function saveJournal() {
      if (!form || form.kind !== 'journal' || form.busy || form.j == null) return;
      var v = readForm(sheet.querySelector('form[data-form="journal"]')), patch = J.journalPatch(v, form.j), bad = J.journalIssues(patch);
      if (bad.length) { form.error = bad.join(' '); return repaintSheet(); }
      if (!Object.keys(patch).length) { form.error = 'Nothing new to record.'; return repaintSheet(); }
      form.busy = true; form.error = null; repaintSheet();
      try {
        await A.updateJournal(form.id, patch);
        closeSheet(); invalidate(); paint(); loadTab();
        flash('Journal saved. A recorded value is never rewritten.');
      } catch (e) { if (form) { form.busy = false; form.error = friendly(e).text; repaintSheet(); } }
    }
    async function addRule() {
      var r = J.ruleFromForm(readForm(body.querySelector('form[data-form="rule"]')));
      if (r.error) return flash(r.error, true);
      try { await A.addRule(r.row); invalidate(); paint(); loadTab(); flash('Rule adopted. It judges positions entered from now on.'); }
      catch (e) { flash(friendly(e).text, true); }
    }
    async function retireRule(id) {
      if (typeof root.confirm === 'function' && !root.confirm('Retire this rule? It keeps its history; positions entered from now on are no longer checked against it.')) return;
      try { await A.retireRule(id); invalidate(); paint(); loadTab(); flash('Rule retired.'); }
      catch (e) { flash(friendly(e).text, true); }
    }
    function experimentFromForm(v) {
      var title = String(v.title || '').trim(), days = Math.floor(+v.days), now = S.now || Date.now();
      if (!title) return { error: 'Say what you will change.' };
      if (!(days >= 7 && days <= 180)) return { error: 'Run an experiment for 7 to 180 days.' };
      var cond = {};
      if (v.condition) { var i = String(v.condition).indexOf(':'); cond = { dim: v.condition.slice(0, i), key: v.condition.slice(i + 1) }; }
      return { row: { title: title.slice(0, 120), hypothesis: blank(v.hypothesis) ? null : String(v.hypothesis).trim().slice(0, 500),
        metric: ['CLV', 'PROCESS', 'ROI'].indexOf(v.metric) >= 0 ? v.metric : 'CLV', condition: cond,
        starts_at: new Date(now).toISOString(), ends_at: new Date(now + days * 86400000).toISOString(), min_sample: 20,
        success_criteria: blank(v.success_criteria) ? null : String(v.success_criteria).trim().slice(0, 300), tz: S.tz } };
    }
    /* the result, once: the server freezes the evidence, the pre-registered
       test runs on exactly it, and the server refuses a conclusion the
       evidence does not allow */
    async function concludeExperiment(id) {
      try {
        var ev = await A.experimentEvidence(id), t = R.experimentTest(ev);
        var res = await A.concludeExperiment(id, t.payload);
        S.coach.experiments = null; loadCoach();
        flash('Result recorded: ' + String(res && res.conclusion || t.status).replace('_', ' ').toLowerCase() + '. It is kept permanently.');
      } catch (e) { flash(friendly(e).text, true); }
    }
    async function reflectExperiment(id) {
      var f = body.querySelector('form[data-form="exp-reflect"][data-id="' + id + '"]'), text = f ? String(readForm(f).reflection || '').trim() : '';
      if (!text) return flash('Write your reflection first.', true);
      try { await A.reflectExperiment(id, text.slice(0, 1000)); S.coach.experiments = null; loadCoach(); flash('Reflection saved. It is written once.'); }
      catch (e) { flash(friendly(e).text, true); }
    }
    /* ASK ABOUT THIS DECISION: answered in the assistant's drawer, on this
       page, from this one record (EDDecisionRecord.explain) — nothing is
       sent anywhere, and nothing the record does not hold is said */
    function askAbout(id) {
      var rec = form && form.rec && form.rec.position && form.rec.position.id === id ? form.rec : null;
      if (!rec || !R) return;
      var q = 'Walk me through this decision: ' + rec.position.event_name + ' · ' + rec.position.selection;
      var parts = R.explain(rec), html = parts.map(function (x) { return '<p><b>' + esc(x.h) + '.</b> ' + esc(x.t) + '</p>'; }).join('')
        + '<p class="edai-src">From your own decision record only. Nothing here is estimated or advice; follow-up questions go to the research desk, which does not see this record.</p>';
      closeSheet();
      try { if (root.edNavTrack) root.edNavTrack('secondary', 'ai:portfolio:record'); } catch (e) { /* never in the way */ }
      if (root.EDAI && root.EDAI.explainRecord) return root.EDAI.explainRecord(q, html);
      flash(parts.map(function (x) { return x.h + ': ' + x.t; }).join(' '));
    }
    async function exportJson() {
      if (S.exporting) return;
      S.exporting = true; paint();
      var msg, bad = false;
      try {
        var data = await A.exportAll();
        var blob = new root.Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), a = doc.createElement('a');
        a.href = root.URL.createObjectURL(blob); a.download = 'edgedesk-portfolio-' + new Date().toISOString().slice(0, 10) + '.json'; doc.body.appendChild(a); a.click();
        setTimeout(function () { root.URL.revokeObjectURL(a.href); a.remove(); }, 0);
        msg = 'Downloaded: every position, decision record, snapshot, review, rule and experiment on your account.';
      } catch (e) { msg = friendly(e).text; bad = true; }
      S.exporting = false; paint(); flash(msg, bad);
    }
    async function deleteAll() {
      var typed = typeof root.prompt === 'function' ? root.prompt('This permanently deletes every position, decision record, snapshot, review, rule, experiment and stored platform credential on your account. Download your data first if you want a copy.\n\nType DELETE MY PORTFOLIO to confirm.', '') : null;
      if (typed == null) return;
      if (String(typed).trim() !== 'DELETE MY PORTFOLIO') return flash('Nothing was deleted: the phrase did not match.', true);
      try { await A.deleteEverything('DELETE MY PORTFOLIO'); S.coach = defaults().coach; await load(); flash('Your Portfolio has been deleted.'); }
      catch (e) { flash(friendly(e).text, true); }
    }
    async function addExperiment() {
      var x = experimentFromForm(readForm(body.querySelector('form[data-form="experiment"]')));
      if (x.error) return flash(x.error, true);
      try { await A.addExperiment(x.row); S.coach.experiments = null; S.coach.expDraft = null; loadCoach(); flash('Experiment started. What it measures is fixed now.'); }
      catch (e) { flash(friendly(e).text, true); }
    }
    async function endExperiment(id) {
      if (typeof root.confirm === 'function' && !root.confirm('End this experiment now? Its result is measured over the days it ran.')) return;
      try { await A.endExperiment(id); S.coach.experiments = null; loadCoach(); flash('Experiment ended.'); }
      catch (e) { flash(friendly(e).text, true); }
    }
    function calMove(d) {
      var c = S.cal;
      if (c.view !== 'month' && c.selected) {
        var nd = shiftDay(c.selected, c.view === 'week' ? 7 * d : d);
        c.month = nd.slice(0, 7);
        ensureCalendar();
        return loadDay(c, nd);
      }
      var y = +c.month.slice(0, 4), m = +c.month.slice(5, 7) + d;
      if (m < 1) { m = 12; y--; }
      if (m > 12) { m = 1; y++; }
      /* the new month's grid and arrows stay on screen while its days load:
         blanking the calendar would pull the arrows out from under a finger */
      c.month = y + '-' + pad2(m); c.days = []; c.loading = true; c.selected = null; c.dayList = null; paint(); loadCalendar();
    }
    function calToday() { var t = E.localDate(S.now || Date.now(), S.tz); return t.slice(0, 7) === S.cal.month ? t : S.cal.month + '-01'; }

    async function remove() {
      if (!form || !form.edit) return;
      var ok = typeof root.confirm === 'function' ? root.confirm('Delete this position? This cannot be undone.') : true;
      if (!ok) return;
      try { await A.deletePosition(form.id); await refreshAfterWrite('Deleted.'); }
      catch (e) { form.error = friendly(e).text; repaintSheet(); }
    }
    async function addFill() {
      var el = sheet.querySelector('form[data-form="fill"]'), v = readForm(el), p = form.position;
      var q = I.readNumber(v.quantity), pr = I.readPrice(v.price), fe = blank(v.fee) ? { value: '0' } : I.readMoney(v.fee);
      var row = { position_id: form.id, transaction_type: v.action, quantity: q.value, price: pr.value, fee: fe.value, executed_at: localInputToIso(v.executed_at) };
      var issues = E.validateFill({ platform: p.platform, event_name: p.event_name, market_name: p.market_name, side: p.side, action: v.action, quantity: q.value, price: pr.value, fee: fe.value, executed_at: row.executed_at });
      if (issues.length) { form.error = issues.map(function (x) { return x.message; }).join(' '); repaintSheet(); return; }
      try { await A.addFill(row); form.fills = await A.fills(form.id) || []; form.error = null; await load(); repaintSheet(); }
      catch (e) { form.error = friendly(e).text; repaintSheet(); }
    }
    async function deleteFill(id) {
      try { await A.deleteFill(id); form.fills = await A.fills(form.id) || []; form.error = null; await load(); repaintSheet(); }
      catch (e) { form.error = friendly(e).text; repaintSheet(); }
    }
    async function saveAccount() {
      var v = form.values = Object.assign(form.values, readForm(sheet.querySelector('form[data-form="account"]')));
      var pl = platformFrom(v);
      if (!pl.platform) { form.error = 'Choose the platform, or name it under Other.'; repaintSheet(); return; }
      try {
        await A.createAccount({ platform: pl.platform, platform_label: pl.platform_label, platform_type: v.platform_type || 'SPORTSBOOK',
          connection_type: v.connection_type === 'CSV' ? 'CSV' : 'MANUAL', status: v.connection_type === 'CSV' ? 'IMPORT_ONLY' : 'MANUAL', display_name: blank(v.display_name) ? null : v.display_name.trim() });
        await refreshAfterWrite('Account added.');
      } catch (e) {
        var b = e && e.pg;
        form.error = b && b.code === '23505' ? 'You already track ' + pl.platform_label + ' that way.' : friendly(e).text; repaintSheet();
      }
    }

    /* ── import ── */
    function restage() {
      var st = S.imp;
      if (!st.text) return;
      var opts2 = { adapter: st.adapterChoice || undefined, map: st.map || undefined, platform: st.platform || undefined,
        platformLabel: st.platform ? E.platformLabel(st.platform) : undefined, timezone: st.timezone || S.tz, dateOrder: st.dateOrder, fileName: st.fileName };
      st.staged = I.stage(st.text, opts2);
      if (st.staged.adapter) st.map = st.staged.map;
      st.counts = null; st.serverRows = null; st.importId = null; st.result = null; st.error = null;
    }
    async function sha256(text) {
      try {
        var c = root.crypto && root.crypto.subtle;
        if (!c || !root.TextEncoder) return null;
        var buf = await c.digest('SHA-256', new root.TextEncoder().encode(text));
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
      } catch (_) { return null; }
    }
    /* a file, dropped or chosen: read in the browser; if the reader imported a
       file with the same columns before, read it the same way */
    function readImportFile(file) {
      var st = S.imp;
      if (!file) return;
      if (file.size > I.MAX_BYTES) { st.readError = 'That file is over 5 MB; split it.'; return paint(); }
      var rd = new root.FileReader();
      rd.onload = function () {
        st.text = String(rd.result || ''); st.fileName = file.name; st.readError = null; st.map = null; st.adapterChoice = st.adapterChoice || null; st.remembered = null;
        restage(); paint();
        ttv('import_started', { entity: st.platform || 'detect' });
        if (st.staged && st.staged.platform) ttv('import_detected', { entity: String(st.staged.platformHow || '').toLowerCase() });
        var sig = st.staged && st.staged.signature;
        A.rememberedImport(sig).then(function (m) {
          if (!m || S.imp !== st || !st.staged || st.staged.signature !== sig || st.counts) return;
          st.adapterChoice = m.importer; st.map = m.column_map && typeof m.column_map === 'object' ? m.column_map : null;
          if (!st.platform && m.platform) st.platform = m.platform;
          if (m.timezone) st.timezone = m.timezone;
          st.remembered = m.committed_at || true;
          restage(); paint();
          ttv('import_detected', { entity: 'remembered' });
        }).catch(function () { /* nothing remembered: the file is read fresh */ });
      };
      rd.onerror = function () { st.readError = 'The file could not be read.'; paint(); };
      rd.readAsText(file);
    }
    async function importCheck() {
      var st = S.imp, r = st.staged;
      if (!r || !r.rows.length) return;
      if ((r.fileIssues || []).some(function (x) { return x.level === 'error'; })) { st.error = 'Fix the file first: ' + r.fileIssues.filter(function (x) { return x.level === 'error'; }).map(function (x) { return x.message; }).join(' '); paint(); return; }
      st.busy = true; st.error = null; paint();
      try {
        var acct = (S.accounts || []).filter(function (a) { return a.platform === (st.platform || r.platform) && ['MANUAL', 'CSV'].indexOf(a.connection_type) >= 0; })[0];
        var chosen = st.platform || r.platform || null;
        st.importId = await A.createImport({ platform_type: r.platformType, importer: r.adapter, file_name: String(st.fileName || 'import.csv').slice(0, 200), header_signature: r.signature || null,
          file_sha256: await sha256(st.text), timezone: r.timezone, column_map: r.map, platform: chosen, platform_account_id: acct ? acct.id : null });
        await A.stageRows(st.importId, r.rows);
        st.counts = await A.classify(st.importId);
        st.serverRows = await A.importRows(st.importId) || [];
        ttv('import_reviewed', { entity: st.importId });
      } catch (e) { st.error = friendly(e).text; }
      st.busy = false; paint();
    }
    async function importCommit() {
      var st = S.imp;
      st.busy = true; paint();
      try {
        /* the server imports at most 1,000 rows per call, so no request can
           outrun the API's statement timeout; keep calling until it is done */
        var r, calls = 0;
        do {
          r = await A.commit(st.importId);
          st.progress = r && r.status !== 'COMMITTED' ? r : null;
          if (st.progress) paint();
        } while (r && r.status !== 'COMMITTED' && r.remaining > 0 && ++calls < 50);
        st.progress = null;
        st.result = r && r.status === 'COMMITTED' ? r : null;
        if (st.result) ttv('import_completed', { entity: st.importId });
        if (!st.result) st.error = 'The import stopped part-way. What went in is listed on each row; press Import again to finish it.';
        st.serverRows = await A.importRows(st.importId) || [];
        await load(); loadImports();
      } catch (e) { st.error = friendly(e).text; }
      st.busy = false; paint();
    }

    /* ── events ── */
    host.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!t || !host.contains(t)) return;
      var act = t.getAttribute('data-act'), v = t.getAttribute('data-v');
      if (act === 'imp-decide') return;   /* a checkbox: handled on change */
      if (t.tagName === 'A' || t.tagName === 'BUTTON') ev.preventDefault();
      if (act === 'tab') {
        if (!S.tabs.some(function (x) { return x[0] === v; })) {
          /* another mount's tab (Portfolio ↔ Process): the app takes the reader there */
          try { host.dispatchEvent(new root.CustomEvent('pfo-route', { bubbles: true, detail: { tab: v } })); } catch (_) { /* no events */ }
          return;
        }
        S.tab = v; closeSheet();
        if (v === 'import') { if (t.getAttribute('data-platform')) { S.imp.platform = t.getAttribute('data-platform'); restage(); } loadImports(); }
        paint(); loadTab(); return;
      }
      if (act === 'reload') return load();
      if (act === 'add') return openSheet({ kind: 'choose' });
      if (act === 'new-wager') return newWager(t.getAttribute('data-platform'), t.getAttribute('data-label'));
      if (act === 'new-prediction') return newPrediction(t.getAttribute('data-platform'), t.getAttribute('data-label'));
      if (act === 'close') return closeSheet();
      if (act === 'edit') return editPosition(t.getAttribute('data-id'));
      if (act === 'save') return save(false);
      if (act === 'save-separate') return save(true);
      if (act === 'delete') return remove();
      if (act === 'fill-add') return addFill();
      if (act === 'fill-delete') return deleteFill(t.getAttribute('data-id'));
      if (act === 'odds-format') { form.values = Object.assign(form.values, readForm(sheet.querySelector('form'))); form.values.odds_format = form.values.odds_format === 'decimal' ? 'american' : 'decimal'; form.values.odds = ''; return repaintSheet(); }
      if (act === 'open-kind') { S.openFilter.kind = v; return paint(); }
      if (act === 'period') { if (S.period !== v) { S.period = v; invalidatePeriod(); } paint(); return loadTab(); }
      if (act === 'platform') { if (S.platform !== (v || '')) { S.platform = v || ''; invalidate(); } paint(); return loadTab(); }
      if (act === 'cal-basis') { S.cal.basis = v; return paint(); }
      if (act === 'cal-view') {
        S.cal.view = v;
        if (v !== 'month' && !S.cal.selected) { ensureCalendar(); return loadDay(S.cal, calToday()); }
        ensureCalendar(); return paint();
      }
      if (act === 'cal-move') return calMove(+v);
      if (act === 'cal-day') { S.cal.month = v.slice(0, 7); ensureCalendar(); return loadDay(S.cal, v); }
      if (act === 'journal-day') return loadDay(S.jr, v);
      if (act === 'coach') {
        S.coach.sub = v; paint();
        /* a page opened from far down a phone screen starts at its top */
        try { if (host.getBoundingClientRect().top < 0) host.scrollIntoView({ block: 'start' }); } catch (_) { /* no layout */ }
        return loadCoach();
      }
      if (act === 'filter-open') return openSheet({ kind: 'filter', values: filterValues() });
      if (act === 'filter-apply') {
        /* the radios are tracked as they change; only the dates are read here */
        var ff = sheet.querySelector('form[data-form="filter"]');
        ['from', 'to'].forEach(function (k) { var el = ff && ff.querySelector('[name="' + k + '"]'); if (el) form.values[k] = el.value; });
        form.values.error = null; return applyFilter(form.values);
      }
      if (act === 'filter-reset') { S.platform = ''; S.period = 'ALL'; S.custom = null; closeSheet(); invalidate(); paint(); return loadTab(); }
      if (act === 'filter-clear') {
        if (v === 'platform') S.platform = ''; else if (v === 'period') { S.period = 'ALL'; S.custom = null; }
        invalidate(); paint(); return loadTab();
      }
      if (act === 'review-pick') {
        var rd = reviewDraft(t.getAttribute('data-id')), rin = body.querySelector('[data-review="' + t.getAttribute('data-id') + '"]');
        if (rin) rd.note = rin.value;
        rd.again = v; paint();
        var again = body.querySelector('[data-act="review-pick"][data-id="' + t.getAttribute('data-id') + '"][data-v="' + v + '"]');
        if (again && again.focus) { try { again.focus({ preventScroll: true }); } catch (_) { again.focus(); } }
        return;
      }
      if (act === 'review-save') return saveReview(t.getAttribute('data-id'));
      if (act === 'exp-setup') {
        var mw = { CLV: 'closing line value', PROCESS: 'process score', ROI: 'return' }[t.getAttribute('data-metric')] || 'closing line value';
        S.coach.expDraft = { title: 'Focus: ' + v, hypothesis: 'My ' + mw + ' improves', metric: t.getAttribute('data-metric') || 'CLV' };
        S.coach.sub = 'experiments'; paint();
        try { if (host.getBoundingClientRect().top < 0) host.scrollIntoView({ block: 'start' }); } catch (_) { /* no layout */ }
        return loadCoach();
      }
      if (act === 'film-move') { S.coach.week = shiftDay(S.coach.week || mondayOf(E.localDate(S.now || Date.now(), S.tz)), 7 * +v); S.coach.film = null; paint(); return loadCoach(); }
      if (act === 'why') return openWhy(t.getAttribute('data-id'));
      if (act === 'why-close') return closeSheet();
      if (act === 'drill') {
        var dim = t.getAttribute('data-dim'), key = t.getAttribute('data-key');
        return openList(X.keyLabel(dim, key), { dim: dim, key: key });
      }
      if (act === 'matrix') {
        var PL = { GOOD: 'Good process', AVERAGE: 'Average process', POOR: 'Poor process', UNGRADED: 'Not graded' }, RL = { WIN: 'won', LOSS: 'lost', OTHER: 'push, void or cash-out', OPEN: 'open' };
        return openList(PL[t.getAttribute('data-process')] + ' · ' + RL[t.getAttribute('data-result')], { process: t.getAttribute('data-process'), result: t.getAttribute('data-result') });
      }
      if (act === 'rules-broken') return openList('Outside your rules', { rules_broken: true });
      if (act === 'journal') return openJournal(t.getAttribute('data-id'));
      if (act === 'journal-save') return saveJournal();
      if (act === 'journal-back') { var bk = form && form.back; if (bk) { openSheet(bk); return; } return closeSheet(); }
      if (act === 'rule-add') return addRule();
      if (act === 'rule-retire') return retireRule(t.getAttribute('data-id'));
      if (act === 'exp-add') return addExperiment();
      if (act === 'exp-end') return endExperiment(t.getAttribute('data-id'));
      if (act === 'exp-conclude') return concludeExperiment(t.getAttribute('data-id'));
      if (act === 'exp-reflect') return reflectExperiment(t.getAttribute('data-id'));
      if (act === 'dr-ask') return askAbout(t.getAttribute('data-id'));
      if (act === 'export-json') return exportJson();
      if (act === 'delete-all') return deleteAll();
      if (act === 'more') { S.histLimit += 100; return paint(); }
      if (act === 'export') {
        var blob = new root.Blob([exportCsv(filterHistory(S))], { type: 'text/csv' }), a = doc.createElement('a');
        a.href = root.URL.createObjectURL(blob); a.download = 'edgedesk-portfolio.csv'; doc.body.appendChild(a); a.click();
        setTimeout(function () { root.URL.revokeObjectURL(a.href); a.remove(); }, 0); return;
      }
      if (act === 'add-account') return openSheet({ kind: 'account', values: { platform_type: 'SPORTSBOOK', connection_type: 'MANUAL' } });
      if (act === 'save-account') return saveAccount();
      if (act === 'rename-account') {
        var name = typeof root.prompt === 'function' ? root.prompt('A nickname for this account (blank to clear):', '') : null;
        if (name === null) return;
        return A.renameAccount(t.getAttribute('data-id'), String(name).trim().slice(0, 60)).then(load).catch(function (e) { S.error = friendly(e).text; paint(); });
      }
      if (act === 'remove-account') {
        if (typeof root.confirm === 'function' && !root.confirm('Remove this account? It has no positions.')) return;
        return A.deleteAccount(t.getAttribute('data-id')).then(load).catch(function (e) { S.error = friendly(e).text; paint(); });
      }
      if (act === 'setup-pick') { if (t.disabled) return; S.setup.selected[v] = !S.setup.selected[v]; if (S.setup.selected[v]) ttv('platform_selected', { entity: v }); return paint(); }
      if (act === 'setup-add') return setupAdd();
      if (act === 'setup-open') {
        S.setup.open = true; paint();
        var su = body.querySelector('[data-r="setup"]'); if (su && su.scrollIntoView) su.scrollIntoView({ block: 'start' });
        if (!S.lifetime) loadAccountsExtras();
        return;
      }
      if (act === 'setup-close') { S.setup.open = false; return paint(); }
      if (act === 'acct-connect') return openSheet({ kind: 'connect', platform: t.getAttribute('data-platform') });
      if (act === 'connect-submit') return submitConnect();
      if (act === 'acct-sync' || act === 'acct-disconnect' || act === 'acct-delete-history') return accountAction(act, t.getAttribute('data-id'));
      if (act === 'imp-platform') { S.imp.platform = v || ''; if (S.imp.text) restage(); return paint(); }
      if (act === 'imp-check') return importCheck();
      if (act === 'imp-commit') return importCommit();
      if (act === 'imp-review') { S.imp.reviewOnly = !S.imp.reviewOnly; return paint(); }
      if (act === 'imp-reset') { S.imp = { timezone: S.imp.timezone, dateOrder: S.imp.dateOrder, platform: S.imp.platform }; return paint(); }
    });
    host.addEventListener('change', function (ev) {
      var t = ev.target, f = t.getAttribute && t.getAttribute('data-f');
      if (t.getAttribute && t.getAttribute('data-act') === 'imp-decide') {
        var id = t.getAttribute('data-id'), d = t.checked ? 'IMPORT' : 'SKIP';
        A.setDecision(id, d).then(function () {
          (S.imp.serverRows || []).forEach(function (r) { if (String(r.id) === id) r.decision = d; });
          paint();
        }).catch(function (e) { S.imp.error = friendly(e).text; paint(); });
        return;
      }
      if (f === 'open') { S.openFilter[t.name] = t.value; return paint(); }
      if (f === 'hist') { S.histFilter[t.name] = t.value; S.histLimit = 100; return paint(); }
      if (f === 'imp') {
        var st = S.imp;
        if (t.name === 'file') return readImportFile(t.files && t.files[0]);
        if (/^map:/.test(t.name)) { st.map = Object.assign({}, st.map || {}); st.map[t.name.slice(4)] = t.value || undefined; if (!t.value) delete st.map[t.name.slice(4)]; }
        else if (t.name === 'adapter') { st.adapterChoice = t.value; st.map = null; }
        else st[t.name] = t.value;
        restage(); return paint();
      }
      if (f === 'filter' && form && form.kind === 'filter') {
        form.values[t.name] = t.value; form.values.error = null;
        if (t.name === 'source') form.values.platform = '';
        if (t.name === 'platform' && t.value) { var pt = (platformList().filter(function (x) { return x.key === t.value; })[0] || {}).type; if (pt) form.values.source = pt; }
        if (t.type === 'radio') repaintSheet();
        return;
      }
      if (f === 'form' && form) {
        /* only a choice that changes the form's shape repaints it; a text
           field's change fires as focus moves on, and repainting then would
           take the field the reader just clicked into out from under them */
        if (t.tagName === 'SELECT') { form.values = Object.assign(form.values, readForm(sheet.querySelector('form[data-form]'))); form.error = null; repaintSheet(); }
        else form.values[t.name] = t.value;
        schedulePreBet();
      }
    });
    host.addEventListener('input', function (ev) {
      var t = ev.target;
      if (t.getAttribute && t.getAttribute('data-review')) { reviewDraft(t.getAttribute('data-review')).note = t.value; return; }
      if (t.getAttribute && t.getAttribute('data-f') === 'hist' && t.name === 'q') { S.histFilter.q = t.value; S.histLimit = 100; var pos = t.selectionStart; paint(); var q = body.querySelector('[name="q"]'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (_) { /* fine */ } } return; }
      if (t.getAttribute && t.getAttribute('data-f') === 'form' && form && t.tagName === 'INPUT') {
        form.values[t.name] = t.value;
        var pv = sheet.querySelector('[data-r="preview"], .pfo-preview');
        if (pv) {
          var html = form.kind === 'wager' ? wagerPreview(wagerFromForm(form.values, S.recs).row)
            : predictionPreview(form.edit ? Object.assign({}, predictionFromForm(form.values, S.recs).payload, { fills: (form.fills || []).map(function (f) { return { action: f.transaction_type === 'FILL' ? f.side : f.transaction_type, quantity: f.quantity, price: f.price, fee: f.fee }; }) })
              : predictionFromForm(form.values, S.recs).payload);
          var tmp = doc.createElement('div'); tmp.innerHTML = html; pv.replaceWith(tmp.firstChild);
        }
        schedulePreBet();
      }
    });
    host.addEventListener('toggle', function (ev) {
      var t = ev.target, r = t && t.getAttribute && t.getAttribute('data-r');
      if (r === 'hist-more') S.histMore = t.open;
      if (r === 'imp-map') S.imp.mapOpen = t.open;
      /* a folder opened by a repaint reports itself open again: harmless */
      if (r === 'fold') S.jr.opened[t.getAttribute('data-v')] = t.open;
      if (r === 'year') {
        var y = +t.getAttribute('data-v');
        if (t.open) openYear(y);
        else if (S.jr.openYear === y) { S.jr.openYear = null; S.jr.yearRows = null; }
      }
    }, true);
    /* a file dropped on the drop zone reads like a chosen one */
    host.addEventListener('dragover', function (ev) { var z = ev.target.closest && ev.target.closest('[data-r="drop"]'); if (z) { ev.preventDefault(); z.classList.add('over'); } });
    host.addEventListener('dragleave', function (ev) { var z = ev.target.closest && ev.target.closest('[data-r="drop"]'); if (z) z.classList.remove('over'); });
    host.addEventListener('drop', function (ev) {
      var z = ev.target.closest && ev.target.closest('[data-r="drop"]');
      if (!z) return;
      ev.preventDefault(); z.classList.remove('over');
      readImportFile(ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]);
    });
    sheet.addEventListener('click', function (ev) { if (ev.target === sheet) closeSheet(); });
    host.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && form) closeSheet(); });

    load();
    var ctl = { state: S, reload: load, setTab: function (t) { S.tab = t; if (t === 'import') loadImports(); paint(); loadTab(); }, close: closeSheet,
      /* a page of the coach (report, leaks, strengths, timing, edge, rules, experiments, film) */
      coach: function (sub) { if (sub) S.coach.sub = sub; if (S.tab === 'coach') { paint(); loadCoach(); } },
      /* Record Position from a Card entry: { entry, current, unit, surface } */
      record: recordFrom,
      /* one position's Decision Record (search results and notifications open it) */
      openRecord: function (id) { if (id) openJournal(id); } };
    host.__pfo = ctl;
    return ctl;
  }
  /* the app's router calls this every time the view opens */
  function show(host, opts) {
    if (!host) return null;
    if (host.__pfo) { host.__pfo.reload(); return host.__pfo; }
    return mount(host, opts);
  }

  /* the reader's own positions for the app's search (portfolio_search) */
  function searchPositions(q, deps) { return makeApi(deps).search(q, 8); }

  return {
    VERSION: VERSION, show: show, mount: mount, registerLiveProvider: registerLiveProvider, makeApi: makeApi, searchPositions: searchPositions,
    wagerFromForm: wagerFromForm, predictionFromForm: predictionFromForm, wagerPreview: wagerPreview, predictionPreview: predictionPreview,
    render: { overview: overview, open: openView, history: historyView, analytics: analyticsView, accounts: accountsView, import: importView,
      wagerForm: wagerForm, predictionForm: predictionForm, fills: fillsEditor, chart: chart, overviewServer: overviewServer, analyticsServer: analyticsServer, kindTable: kindTable },
    decisionPatch: decisionPatch, setupVisible: setupVisible, exposureOn: exposureOn,
    filterHistory: filterHistory, filterOpen: filterOpen, exportCsv: exportCsv, csvCell: csvCell, friendly: friendly, defaults: defaults,
    localInputToIso: localInputToIso, isoToLocalInput: isoToLocalInput, POSITION_SELECT: POSITION_SELECT
  };
}));
