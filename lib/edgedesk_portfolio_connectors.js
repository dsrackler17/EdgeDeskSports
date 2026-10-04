/* ===========================================================================
   EDGEDESK PORTFOLIO — the connector contract.
   docs/portfolio-architecture.md § Connectors

   Every way a position reaches the Portfolio — typed by hand, imported from a
   CSV, and (from Phase B) pulled from a platform's own API — is a connector,
   and every connector ends in the same place: normalized rows in
   portfolio_positions and portfolio_transactions. The Portfolio UI never asks
   where a row came from.

   THE CONTRACT (every connector implements all seven)
     connect(ctx)            establish the connection; for a real integration
                             this runs SERVER-SIDE and stores only ciphertext
                             in portfolio_private.platform_credentials
     disconnect(ctx)         revoke and forget the credential; history stays
     healthCheck(ctx)        is the connection still good? (revoked keys,
                             expired tokens → ACTION_REQUIRED, never a silent
                             failure)
     sync(ctx)               incremental: from ctx.cursor, returns
                             { positions, transactions, cursor, fetched, errors }
     fetchPositions(ctx)     the platform's positions, raw
     fetchTransactions(ctx)  the platform's fills / settlements, raw
     normalize(raw, ctx)     one raw record → the normalized shape below

   THE NORMALIZED SHAPE (identical for every source; validated by
   EDPortfolio.validateWager / validateFill)
     { kind: 'wager', platform, platform_label, position_type, sport, league,
       event_name, market_name, selection, side, line, odds_american |
       odds_decimal, stake, status, reported_payout, fees, placed_at,
       settled_at, external_position_id, ... }
     { kind: 'fill', platform, platform_label, event_name, market_name, side,
       action: 'BUY' | 'SELL', quantity, price, fee, executed_at,
       external_transaction_id, resolution, settlement_price, current_price }

   WHAT IS REGISTERED TODAY: manual and csv. Nothing here claims a platform
   connection that does not exist; an automatic connector is added only when
   it works end to end (docs/platform-support.md).

   Browser: window.EDPortfolioConnectors.   Node: require('./edgedesk_portfolio_connectors.js').
   =========================================================================== */
(function (root, factory) {
  var E = root.EDPortfolio || (typeof require === 'function' ? require('./edgedesk_portfolio.js') : null);
  var api = factory(E);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDPortfolioConnectors = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (E) {
  'use strict';

  var METHODS = ['connect', 'disconnect', 'healthCheck', 'sync', 'fetchPositions', 'fetchTransactions', 'normalize'];
  /* how a platform can be reached at all, classified before any code exists */
  var INTEGRATION_CLASSES = {
    OFFICIAL_API: 'A — official API',
    AUTHORIZED_OAUTH: 'B — authorized OAuth / account connection',
    APPROVED_AGGREGATOR: 'C — approved third-party aggregator',
    USER_API_CREDENTIAL: 'D — user-supplied API credential',
    FILE_IMPORT: 'E — file / CSV / statement import',
    EMAIL_IMPORT: 'F — email / receipt import',
    MANUAL_ONLY: 'G — manual entry only'
  };
  var RUNS_ON = ['browser', 'server'];

  function notSupported(method) {
    return function () { return { ok: false, code: 'NOT_SUPPORTED', message: method + ' is not something this connector does.' }; };
  }
  /* a connector that does not implement the whole contract is refused at definition */
  function defineConnector(spec) {
    var missing = [];
    if (!spec || !/^[a-z0-9_]{2,40}$/.test(spec.key || '')) missing.push('key');
    if (!spec || !spec.label) missing.push('label');
    if (!spec || E.CONNECTION_TYPES.indexOf(spec.connectionType) < 0) missing.push('connectionType');
    if (!spec || !INTEGRATION_CLASSES[spec.integrationClass]) missing.push('integrationClass');
    if (!spec || RUNS_ON.indexOf(spec.runsOn) < 0) missing.push('runsOn');
    METHODS.forEach(function (m) { if (!spec || typeof spec[m] !== 'function') missing.push(m); });
    /* a credential-bearing connector never runs in the browser */
    if (spec && ['API', 'OAUTH', 'AGGREGATOR'].indexOf(spec.connectionType) >= 0 && spec.runsOn !== 'server') missing.push('runsOn:server');
    if (missing.length) throw new Error('portfolio connector "' + (spec && spec.key) + '" is incomplete: ' + missing.join(', '));
    var c = {};
    Object.keys(spec).forEach(function (k) { c[k] = spec[k]; });
    c.capabilities = Object.freeze(Object.assign({ autoSync: false, positions: false, transactions: false, settlements: false, cash: false }, spec.capabilities || {}));
    return Object.freeze(c);
  }
  function validateNormalized(rec) {
    if (!rec || (rec.kind !== 'wager' && rec.kind !== 'fill')) return [{ level: 'error', code: 'BAD_KIND', message: 'A record is a wager or a fill.' }];
    return rec.kind === 'wager' ? E.validateWager(rec) : E.validateFill(rec);
  }

  /* ── THE SYNC ENGINE'S POLICIES (pure; the server-side runner uses them) ── */
  /* exponential backoff with a cap, and optional full jitter from a supplied
     random source so tests stay deterministic */
  function backoffMs(attempt, opts) {
    opts = opts || {};
    var base = opts.baseMs || 1000, cap = opts.capMs || 5 * 60 * 1000;
    var d = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
    return opts.random ? Math.floor(opts.random() * d) : d;
  }
  /* an upstream failure → what the account shows and whether to retry */
  function classifyFailure(status, opts) {
    opts = opts || {};
    if (status === 401 || status === 403) return { code: 'CREDENTIAL_REJECTED', accountStatus: 'ACTION_REQUIRED', retry: false };
    if (status === 429) return { code: 'RATE_LIMITED', accountStatus: null, retry: true, retryAfterMs: opts.retryAfterMs || null };
    if (status >= 500 || status === 0 || status == null) return { code: 'UPSTREAM_UNAVAILABLE', accountStatus: null, retry: true };
    if (status === 404) return { code: 'NOT_FOUND', accountStatus: 'ERROR', retry: false };
    return { code: 'REQUEST_REFUSED', accountStatus: 'ERROR', retry: false };
  }
  /* a log line may carry a code and a short sentence — never a token, key,
     cookie, header or response body */
  var SECRETISH = /(bearer\s+[a-z0-9._~+\/-]+|eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]+|(api[_-]?key|secret|token|password|cookie|signature)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/ig;
  function safeLogMessage(text) {
    return String(text == null ? '' : text).replace(SECRETISH, '[redacted]').replace(/\s+/g, ' ').slice(0, 500);
  }

  /* ── THE TWO CONNECTORS THAT EXIST ── */
  var manual = defineConnector({
    key: 'manual', label: 'Manual entry', connectionType: 'MANUAL', integrationClass: 'MANUAL_ONLY', runsOn: 'browser',
    capabilities: { positions: true, transactions: true },
    connect: function () { return { ok: true, status: 'MANUAL' }; },
    disconnect: function () { return { ok: true, status: 'DISCONNECTED' }; },
    healthCheck: function () { return { ok: true, status: 'MANUAL', message: 'Entered by hand; there is nothing to check.' }; },
    sync: notSupported('sync'), fetchPositions: notSupported('fetchPositions'), fetchTransactions: notSupported('fetchTransactions'),
    /* the forms already produce the normalized shape */
    normalize: function (rec) { return { record: rec, issues: validateNormalized(rec) }; }
  });
  var csv = defineConnector({
    key: 'csv', label: 'CSV import', connectionType: 'CSV', integrationClass: 'FILE_IMPORT', runsOn: 'browser',
    capabilities: { positions: true, transactions: true, settlements: true },
    connect: function () { return { ok: true, status: 'IMPORT_ONLY' }; },
    disconnect: function () { return { ok: true, status: 'DISCONNECTED' }; },
    healthCheck: function () { return { ok: true, status: 'IMPORT_ONLY', message: 'Imported from files; there is nothing to check.' }; },
    sync: notSupported('sync'), fetchPositions: notSupported('fetchPositions'), fetchTransactions: notSupported('fetchTransactions'),
    normalize: function (record, ctx) {
      var I = (typeof self !== 'undefined' && self.EDPortfolioImport) || (typeof require === 'function' ? require('./edgedesk_portfolio_import.js') : null);
      var adapter = I.ADAPTERS[(ctx && ctx.adapter) || 'generic_sportsbook_v1'];
      var out = adapter.normalize(record, ctx.map, ctx);
      return { record: out.normalized, issues: out.issues };
    }
  });
  var REGISTRY = { manual: manual, csv: csv };

  return {
    METHODS: METHODS, INTEGRATION_CLASSES: INTEGRATION_CLASSES, defineConnector: defineConnector,
    validateNormalized: validateNormalized, backoffMs: backoffMs, classifyFailure: classifyFailure, safeLogMessage: safeLogMessage,
    get: function (k) { return REGISTRY[k] || null; }, list: function () { return Object.keys(REGISTRY).map(function (k) { return REGISTRY[k]; }); }
  };
}));
