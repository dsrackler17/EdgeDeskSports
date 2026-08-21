/* Model Collective — NFL odds components.
 *
 * The one place the front end reads market odds. Every Collective surface
 * (the wall, the board, model pages, the market page, the embed, the admin
 * console) renders from this file, so a price shown in two places is the same
 * price from the same fetch.
 *
 * It talks only to the Collective's own collective_odds edge function. It has
 * no provider URL and no API key, and there is nothing here for one to leak
 * through: the browser never sees a credential because the browser never
 * calls a provider.
 *
 * Three rules the renderers enforce, not just document:
 *  1. Nothing is displayed without its capture time. If the feed is older
 *     than the server's freshness window the markup says so and shows the
 *     age. A stale price is never dressed up as a current one.
 *  2. "LIVE" appears only when the payload says a game is live. There is no
 *     decorative live indicator.
 *  3. When there is no price, the markup says there is no price. No blanks
 *     that read as zero, no placeholder numbers.
 *
 * Usage:
 *   MCOdds.configure({ api: 'https://…/functions/v1' });
 *   var board = await MCOdds.board();            // cached, deduped
 *   el.innerHTML = MCOdds.marketLine(game);      // one-line summary
 *   el.innerHTML = MCOdds.marketCard(game);      // full book grid
 *   MCOdds.injectCss(document.head);             // or a shadow root
 */
(function (global) {
  'use strict';

  var MCOdds = {};

  /* ---------------------------------------------------------------- config */
  var CFG = {
    api: null,
    fn: 'collective_odds',
    league: 'nfl',
    /* Client cache. The server already caches; this stops one page render
       from making the same request five times. */
    ttlMs: 20000
  };

  MCOdds.configure = function (opts) {
    opts = opts || {};
    if (opts.api) CFG.api = String(opts.api).replace(/\/$/, '');
    if (opts.fn) CFG.fn = opts.fn;
    if (opts.league) CFG.league = opts.league;
    if (typeof opts.ttlMs === 'number') CFG.ttlMs = opts.ttlMs;
    return MCOdds;
  };

  function apiBase() {
    if (CFG.api) return CFG.api;
    var c = global.COLLECTIVE_CONFIG;
    if (c && c.API) return String(c.API).replace(/\/$/, '');
    if (global.API) return String(global.API).replace(/\/$/, '');
    return '';
  }

  /* ------------------------------------------------------------- transport */
  var cache = {};      /* url -> { at, data } */
  var inflight = {};   /* url -> promise */

  function get(path, ttl) {
    var url = apiBase() + '/' + CFG.fn + path;
    var now = Date.now();
    var hit = cache[url];
    if (hit && now - hit.at < (ttl == null ? CFG.ttlMs : ttl)) {
      return Promise.resolve(hit.data);
    }
    if (inflight[url]) return inflight[url];
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    var p = fetch(url, { signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (timer) clearTimeout(timer);
        delete inflight[url];
        cache[url] = { at: Date.now(), data: d };
        return d;
      })
      .catch(function (e) {
        if (timer) clearTimeout(timer);
        delete inflight[url];
        /* A failed request is "unavailable", never an empty board that could
           be mistaken for a week with no games. */
        return {
          state: 'unavailable',
          last_updated: (hit && hit.data && hit.data.last_updated) || null,
          age_seconds: null,
          notice: 'Odds unavailable.',
          error: { message: (e && e.message) || 'request failed' },
          games: []
        };
      });
    inflight[url] = p;
    return p;
  }

  /* The slate with the full book grid. Everything else is a view of this, so
     a page that shows odds in three places makes one request. */
  MCOdds.board = function (opts) {
    opts = opts || {};
    var q = [];
    if (opts.days) q.push('days=' + encodeURIComponent(opts.days));
    if (opts.from) q.push('from=' + encodeURIComponent(opts.from));
    if (opts.to) q.push('to=' + encodeURIComponent(opts.to));
    if (opts.week) q.push('week=' + encodeURIComponent(opts.week));
    if (opts.limit) q.push('limit=' + encodeURIComponent(opts.limit));
    if (opts.books === false) q.push('books=0');
    var path = '/v1/nfl/odds' + (q.length ? '?' + q.join('&') : '');
    return get(path, opts.ttlMs).then(index);
  };

  MCOdds.status = function () { return get('/v1/nfl/status', 10000); };

  MCOdds.history = function (eventId, opts) {
    opts = opts || {};
    var q = [];
    if (opts.market) q.push('market=' + encodeURIComponent(opts.market));
    if (opts.book) q.push('book=' + encodeURIComponent(opts.book));
    if (opts.outcome) q.push('outcome=' + encodeURIComponent(opts.outcome));
    return get('/v1/nfl/odds/' + encodeURIComponent(eventId) + '/history' +
      (q.length ? '?' + q.join('&') : ''), 30000);
  };

  MCOdds.closingForGame = function (collectiveGameId) {
    return get('/v1/nfl/closing/' + encodeURIComponent(collectiveGameId), 60000);
  };

  /* Adds lookup tables so a caller can find a game by either identity without
     scanning the array on every row it renders. */
  function index(d) {
    d = d || {};
    var games = d.games || [];
    var byEvent = {}, byGame = {}, byTeams = {};
    games.forEach(function (g) {
      if (g.event_id) byEvent[g.event_id] = g;
      if (g.collective_game_id) byGame[g.collective_game_id] = g;
      byTeams[teamKey(g.away) + '@' + teamKey(g.home)] = g;
    });
    d.byEvent = byEvent;
    d.byGame = byGame;
    d.byTeams = byTeams;
    /* Matching by team code is the fallback for a Collective game that the
       odds feed has not been linked to yet. */
    d.find = function (game) {
      if (!game) return null;
      if (game.game_id && byGame[game.game_id]) return byGame[game.game_id];
      if (game.event_id && byEvent[game.event_id]) return byEvent[game.event_id];
      var k = teamKey(game.away) + '@' + teamKey(game.home);
      return byTeams[k] || null;
    };
    return d;
  }

  function teamKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

  /* ------------------------------------------------------------ formatting */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  MCOdds.esc = esc;

  /* American odds, always signed. -110 and +135 read differently and the sign
     carries the meaning. */
  MCOdds.price = function (n) {
    if (n == null || !isFinite(n)) return '—';
    n = Math.round(Number(n));
    return (n > 0 ? '+' : '') + n;
  };

  /* A spread in home convention. PK is a real number in this market and is
     spelled out rather than shown as 0. */
  MCOdds.line = function (n) {
    if (n == null || !isFinite(n)) return '—';
    n = Number(n);
    if (n === 0) return 'PK';
    return (n > 0 ? '+' : '') + trimNum(n);
  };

  MCOdds.total = function (n) {
    if (n == null || !isFinite(n)) return '—';
    return trimNum(Number(n));
  };

  /* Two decimals, trailing zeros trimmed. A consensus median lands on
     quarter points (the median of -3.5 and -4 is -3.75) and rounding that to
     one decimal would print a number no book is offering. */
  function trimNum(n) {
    var s = (Math.round(Number(n) * 100) / 100).toFixed(2);
    return s.replace(/0$/, '').replace(/\.0?$/, '');
  }

  MCOdds.pct = function (x, d) {
    if (x == null || !isFinite(x)) return '—';
    return (100 * Number(x)).toFixed(d == null ? 1 : d) + '%';
  };

  MCOdds.ago = function (seconds) {
    if (seconds == null || !isFinite(seconds)) return '';
    seconds = Math.max(0, Math.round(seconds));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 5400) return Math.round(seconds / 60) + 'm ago';
    if (seconds < 172800) return Math.round(seconds / 3600) + 'h ago';
    return Math.round(seconds / 86400) + 'd ago';
  };

  /* Age recomputed from the timestamp rather than trusting the server's
     age_seconds, which was correct when the response was cached and is not
     correct a minute later. */
  MCOdds.ageOf = function (iso) {
    if (!iso) return null;
    var ms = Date.parse(iso);
    if (!isFinite(ms)) return null;
    return Math.max(0, Math.round((Date.now() - ms) / 1000));
  };

  /* Freshness, decided here from the timestamp and the server's window. */
  MCOdds.freshness = function (env, iso) {
    env = env || {};
    /* undefined means "not asked about a specific series", so fall back to
       the feed timestamp. An explicit null means this game has no stored
       price, which is unavailable and must not inherit the feed's. */
    var at = (iso === undefined) ? env.last_updated : iso;
    var age = MCOdds.ageOf(at);
    var win = Number(env.stale_after_seconds) > 0 ? Number(env.stale_after_seconds) : 900;
    if (age == null) return { state: 'unavailable', age: null, at: null };
    return { state: age <= win ? 'live' : 'stale', age: age, at: at };
  };

  MCOdds.freshChip = function (env, iso) {
    var f = MCOdds.freshness(env, iso);
    if (f.state === 'unavailable') {
      return '<span class="mco-chip mco-none" title="No stored price for this market">Odds unavailable</span>';
    }
    if (f.state === 'stale') {
      return '<span class="mco-chip mco-stale" title="Older than the freshness window. Shown, but not current.">' +
        'Stale &middot; ' + esc(MCOdds.ago(f.age)) + '</span>';
    }
    return '<span class="mco-chip mco-fresh">Updated ' + esc(MCOdds.ago(f.age)) + '</span>';
  };

  /* --------------------------------------------------------- reading a game */
  /* Consensus spread in home convention, or null. */
  MCOdds.consensusSpread = function (g) {
    var c = g && g.consensus && g.consensus.spread;
    return c && c.median != null ? Number(c.median) : null;
  };
  MCOdds.consensusTotal = function (g) {
    var c = g && g.consensus && g.consensus.total;
    return c && c.median != null ? Number(c.median) : null;
  };
  MCOdds.consensusHomeProb = function (g) {
    var c = g && g.consensus && g.consensus.moneyline;
    return c && c.home_fair_prob != null ? Number(c.home_fair_prob) : null;
  };
  /* Sharp reference, kept apart from the consensus on purpose. */
  MCOdds.sharp = function (g, book) {
    var s = g && g.consensus && g.consensus.sharp;
    if (!s) return null;
    if (book) return s[book] || null;
    var keys = Object.keys(s);
    return keys.length ? { book: keys[0], data: s[keys[0]] } : null;
  };

  /* The line most books are on, with the best price available AT that line.
     Different lines are never compared: the payload keeps them apart and so
     does this. */
  MCOdds.bestAtPrimary = function (g, market, outcome) {
    var m = g && g.best && g.best[market];
    var o = m && m.outcomes && m.outcomes[outcome];
    if (!o || !o.lines || !o.lines.length) return null;
    var primary = o.primary_line;
    var row = null;
    for (var i = 0; i < o.lines.length; i++) {
      var L = o.lines[i];
      if (L.is_primary || (primary != null && Number(L.line) === Number(primary))) { row = L; break; }
    }
    if (!row) row = o.lines[0];
    return {
      line: row.line == null ? null : Number(row.line),
      book: row.best && row.best.book,
      price: row.best && row.best.price,
      books: row.books || [],
      captured_at: row.latest_captured_at || null,
      other_lines: o.lines.length - 1
    };
  };

  MCOdds.bookName = function (g, id) {
    var lists = (g && g.books) || {};
    var keys = Object.keys(lists);
    for (var i = 0; i < keys.length; i++) {
      var rows = lists[keys[i]] || [];
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].book === id && rows[j].book_name) return rows[j].book_name;
      }
    }
    return id ? String(id) : '';
  };

  /* ------------------------------------------------------- model vs market */
  /* Both numbers are home-convention spreads, which is the only reason they
     can be subtracted. A model that posted no spread has no comparison, and
     this returns null rather than inventing one from a pick side. */
  MCOdds.edge = function (modelSpread, marketSpread, homeCode, awayCode) {
    if (modelSpread == null || marketSpread == null) return null;
    if (!isFinite(modelSpread) || !isFinite(marketSpread)) return null;
    var diff = Number(modelSpread) - Number(marketSpread);
    if (Math.abs(diff) < 0.005) {
      return { points: 0, side: null, text: 'in line with the market' };
    }
    /* A more negative model number means the model is further onto the home
       team than the market is. */
    var side = diff < 0 ? (homeCode || 'home') : (awayCode || 'away');
    return {
      points: Math.abs(diff),
      side: side,
      text: trimNum(Math.abs(diff)) + ' pts toward ' + side
    };
  };

  MCOdds.edgeHtml = function (modelSpread, marketSpread, homeCode, awayCode) {
    var e = MCOdds.edge(modelSpread, marketSpread, homeCode, awayCode);
    if (!e) return '<span class="mco-dim" title="A difference needs both a model spread and a market spread">—</span>';
    if (!e.side) return '<span class="mco-dim">in line</span>';
    return '<span class="mco-edge">' + esc(trimNum(e.points)) + ' pts <span class="mco-dim">toward ' +
      esc(e.side) + '</span></span>';
  };

  /* ---------------------------------------------------------- render: line */
  /* One compact row: spread, total, moneyline, from the consensus, with the
     capture time attached. Used wherever a game already has its own card. */
  MCOdds.marketLine = function (g, env) {
    if (!g) {
      return '<div class="mco-line mco-empty">Market unavailable</div>';
    }
    var f = MCOdds.freshness(env, g.last_odds_at);
    if (f.state === 'unavailable') {
      return '<div class="mco-line mco-empty">Market unavailable' +
        (g.last_odds_at ? ' <span class="mco-dim">last updated ' + esc(MCOdds.ago(MCOdds.ageOf(g.last_odds_at))) + '</span>' : '') +
        '</div>';
    }
    var sp = MCOdds.consensusSpread(g);
    var tot = MCOdds.consensusTotal(g);
    var hp = MCOdds.consensusHomeProb(g);
    var spBest = MCOdds.bestAtPrimary(g, 'spread', 'home');
    var parts = [];
    if (sp != null) {
      parts.push('<span class="mco-mk"><b>' + esc(g.home) + ' ' + esc(MCOdds.line(sp)) + '</b>' +
        (spBest && spBest.price != null
          ? ' <span class="mco-dim">' + esc(MCOdds.price(spBest.price)) + ' ' + esc(MCOdds.bookName(g, spBest.book)) + '</span>'
          : '') + '</span>');
    }
    if (tot != null) parts.push('<span class="mco-mk">O/U <b>' + esc(MCOdds.total(tot)) + '</b></span>');
    if (hp != null) {
      parts.push('<span class="mco-mk">' + esc(g.home) + ' ML <b>' + esc(MCOdds.pct(hp, 0)) + '</b>' +
        ' <span class="mco-dim" title="Fair price after removing the vig">no-vig</span></span>');
    }
    if (!parts.length) {
      return '<div class="mco-line mco-empty">No market posted for this game yet</div>';
    }
    return '<div class="mco-line">' +
      '<span class="mco-tag">MARKET</span>' + parts.join('') +
      (g.is_live ? '<span class="mco-chip mco-live">LIVE</span>' : '') +
      '<span class="mco-spacer"></span>' + MCOdds.freshChip(env, g.last_odds_at) +
      '</div>';
  };

  /* ---------------------------------------------------------- render: card */
  /* The full picture for one game: every book on every market, the best price
     within each line, the consensus, the sharp reference, and open/close. */
  MCOdds.marketCard = function (g, env, opts) {
    opts = opts || {};
    if (!g) return '<div class="mco-card mco-empty">Market unavailable</div>';
    var f = MCOdds.freshness(env, g.last_odds_at);
    var head = '<div class="mco-hd">' +
      '<span class="mco-gm">' + esc(g.away_name || g.away) + ' @ ' + esc(g.home_name || g.home) + '</span>' +
      (g.is_live ? '<span class="mco-chip mco-live">LIVE</span>' : '') +
      (g.market_closed ? '<span class="mco-chip mco-closed" title="Kickoff has passed; the closing line is final">Market closed</span>' : '') +
      '<span class="mco-spacer"></span>' + MCOdds.freshChip(env, g.last_odds_at) + '</div>';

    if (f.state === 'unavailable') {
      return '<div class="mco-card">' + head +
        '<div class="mco-empty">No stored prices for this game. Nothing is shown rather than an estimate.</div></div>';
    }

    var body = '';
    body += marketBlock(g, 'spread', 'Spread', ['home', 'away']);
    body += marketBlock(g, 'total', 'Total', ['over', 'under']);
    body += marketBlock(g, 'moneyline', 'Moneyline', ['home', 'away']);

    var cons = '';
    var sp = MCOdds.consensusSpread(g), tot = MCOdds.consensusTotal(g), hp = MCOdds.consensusHomeProb(g);
    if (sp != null || tot != null || hp != null) {
      var c = g.consensus || {};
      cons = '<div class="mco-cons"><span class="mco-tag">CONSENSUS</span>' +
        (sp != null ? '<span class="mco-mk">' + esc(g.home) + ' <b>' + esc(MCOdds.line(sp)) + '</b>' +
          (c.spread && c.spread.books ? ' <span class="mco-dim">' + c.spread.books + ' books</span>' : '') + '</span>' : '') +
        (tot != null ? '<span class="mco-mk">total <b>' + esc(MCOdds.total(tot)) + '</b></span>' : '') +
        (hp != null ? '<span class="mco-mk">' + esc(g.home) + ' <b>' + esc(MCOdds.pct(hp, 0)) + '</b> ' +
          '<span class="mco-dim">no-vig</span></span>' : '') +
        '<span class="mco-note">Median across retail books. The moneyline is a median of de-vigged probabilities, not an average of prices.</span>' +
        '</div>';
    }

    var sharpRow = '';
    var sharp = g.consensus && g.consensus.sharp;
    if (sharp && Object.keys(sharp).length) {
      var bits = Object.keys(sharp).map(function (k) {
        var s = sharp[k] || {};
        var seg = [];
        if (s.spread != null) seg.push(esc(g.home) + ' ' + esc(MCOdds.line(s.spread)));
        if (s.total != null) seg.push('total ' + esc(MCOdds.total(s.total)));
        if (s.moneyline_home != null) seg.push('ML ' + esc(MCOdds.price(s.moneyline_home)));
        return '<span class="mco-mk"><b>' + esc(MCOdds.bookName(g, k) || k) + '</b> ' + seg.join(' &middot; ') + '</span>';
      }).join('');
      sharpRow = '<div class="mco-sharp"><span class="mco-tag">SHARP REFERENCE</span>' + bits +
        '<span class="mco-note">Kept out of the consensus on purpose.</span></div>';
    }

    var oc = openClose(g);

    return '<div class="mco-card">' + head + cons + sharpRow + body + oc +
      (opts.footer === false ? '' :
        '<div class="mco-foot">Odds via the Collective&rsquo;s own feed. Research and information only, not betting advice.</div>') +
      '</div>';
  };

  function outcomeLabel(g, o) {
    if (o === 'home') return g.home;
    if (o === 'away') return g.away;
    if (o === 'over') return 'Over';
    if (o === 'under') return 'Under';
    return o;
  }

  /* One market, one row per outcome, prices grouped by line. Two books on the
     same line are comparable and the better price is marked; two books on
     different lines are not, and neither is marked. */
  function marketBlock(g, market, title, outcomes) {
    var rows = '';
    var any = false;
    outcomes.forEach(function (o) {
      var best = MCOdds.bestAtPrimary(g, market, o);
      if (!best) {
        rows += '<tr><td class="mco-sel">' + esc(outcomeLabel(g, o)) + '</td>' +
          '<td colspan="2" class="mco-dim">no price posted</td></tr>';
        return;
      }
      any = true;
      var bestDec = null;
      (best.books || []).forEach(function (b) {
        if (bestDec == null || Number(b.price_decimal) > bestDec) bestDec = Number(b.price_decimal);
      });
      var chips = (best.books || []).map(function (b) {
        var win = bestDec != null && Number(b.price_decimal) === bestDec;
        return '<span class="mco-bk' + (win ? ' mco-best' : '') + (b.is_sharp ? ' mco-sharpbk' : '') + '"' +
          ' title="' + esc(b.book_name || b.book) + (b.is_sharp ? ' (sharp)' : '') +
          (b.captured_at ? ' &middot; ' + esc(MCOdds.ago(MCOdds.ageOf(b.captured_at))) : '') + '">' +
          '<i>' + esc(b.book_name || b.book) + '</i>' + esc(MCOdds.price(b.price)) + '</span>';
      }).join('');
      var num = market === 'moneyline'
        ? ''
        : '<b>' + esc(market === 'total' ? MCOdds.total(best.line) : MCOdds.line(best.line)) + '</b> ';
      rows += '<tr><td class="mco-sel">' + esc(outcomeLabel(g, o)) + '</td>' +
        '<td class="mco-num">' + num + '</td>' +
        '<td class="mco-books">' + chips +
        (best.other_lines > 0
          ? '<span class="mco-alt" title="Books on a different number. A price at another line is a different bet, so it is not ranked against these.">' +
            best.other_lines + ' at another line</span>'
          : '') +
        '</td></tr>';
    });
    if (!any && !rows) return '';
    return '<div class="mco-mkt"><div class="mco-mkt-t">' + esc(title) + '</div>' +
      '<table class="mco-tbl"><tbody>' + rows + '</tbody></table></div>';
  }

  /* Open, current and close side by side. "Close" is only ever rendered from
     a stored closing line; an unfinished market shows the current number and
     says the market has not closed. */
  function openClose(g) {
    var open = (g.opening || {})['spread:home'];
    var close = (g.closing || {})['spread:home'];
    var cur = MCOdds.consensusSpread(g);
    if (!open && !close && cur == null) return '';
    var cells = '';
    cells += '<span><i>Open</i>' + (open && open.line != null ? esc(MCOdds.line(open.line)) : '—') + '</span>';
    cells += '<span><i>Current</i>' + (cur != null ? esc(MCOdds.line(cur)) : '—') + '</span>';
    cells += '<span><i>Close</i>' + (close && close.line != null
      ? esc(MCOdds.line(close.line))
      : '<span class="mco-dim" title="Written only after kickoff">not closed</span>') + '</span>';
    return '<div class="mco-oc"><span class="mco-tag">' + esc(g.home) + ' SPREAD</span>' + cells + '</div>';
  }

  /* --------------------------------------------------------- render: movement */
  /* Every stored state for one series. Unchanged polls are not stored, so
     each point here is a real move. */
  MCOdds.movementHtml = function (hist, g) {
    var pts = (hist && hist.points) || [];
    if (!pts.length) return '<div class="mco-empty">No stored movement for this market yet.</div>';
    var rows = pts.map(function (p) {
      return '<tr><td class="mco-dim">' + esc(new Date(p.at).toLocaleString()) + '</td>' +
        '<td>' + esc(MCOdds.bookName(g, p.book) || p.book) + '</td>' +
        '<td class="mco-num">' + esc(p.line == null ? '' : MCOdds.line(p.line)) + '</td>' +
        '<td class="mco-num">' + esc(MCOdds.price(p.price)) + '</td>' +
        (p.is_live ? '<td><span class="mco-chip mco-live">live</span></td>' : '<td></td>') +
        '</tr>';
    }).join('');
    return '<table class="mco-tbl mco-move"><thead><tr><th>Captured</th><th>Book</th>' +
      '<th class="mco-num">Line</th><th class="mco-num">Price</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  };

  /* ------------------------------------------------------------------- css */
  var CSS = [
    '.mco-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;padding:6px 0}',
    '.mco-tag{font-size:9.5px;letter-spacing:.14em;color:var(--faint,#5b6472);font-weight:700}',
    '.mco-mk{white-space:nowrap}',
    '.mco-mk b{font-variant-numeric:tabular-nums}',
    '.mco-dim{color:var(--dim,#8a93a2)}',
    '.mco-spacer{flex:1}',
    '.mco-chip{font-size:10px;padding:2px 6px;border-radius:999px;border:1px solid var(--border,#262c36);white-space:nowrap}',
    '.mco-fresh{color:var(--dim,#8a93a2)}',
    '.mco-stale{color:var(--warn,#d99a2b);border-color:rgba(217,154,43,.45)}',
    '.mco-none{color:var(--faint,#5b6472)}',
    '.mco-live{color:var(--pos,#2fb47c);border-color:rgba(47,180,124,.5);font-weight:700;letter-spacing:.08em}',
    '.mco-closed{color:var(--faint,#5b6472)}',
    '.mco-empty{color:var(--dim,#8a93a2);font-size:12.5px;padding:8px 0}',
    '.mco-card{border:1px solid var(--border,#262c36);border-radius:10px;padding:12px;background:var(--surface,#13161c)}',
    '.mco-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
    '.mco-gm{font-weight:600}',
    '.mco-cons,.mco-sharp{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;padding:6px 0;border-top:1px solid var(--border,#262c36)}',
    '.mco-note{color:var(--faint,#5b6472);font-size:11px;flex-basis:100%}',
    '.mco-mkt{border-top:1px solid var(--border,#262c36);padding-top:8px;margin-top:8px}',
    '.mco-mkt-t{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim,#8a93a2);margin-bottom:4px}',
    '.mco-tbl{width:100%;border-collapse:collapse;font-size:12.5px}',
    '.mco-tbl td,.mco-tbl th{padding:3px 6px;text-align:left;vertical-align:top}',
    '.mco-tbl th{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim,#8a93a2)}',
    '.mco-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.mco-sel{white-space:nowrap}',
    '.mco-books{display:flex;gap:5px;flex-wrap:wrap}',
    '.mco-bk{font-size:11px;border:1px solid var(--border,#262c36);border-radius:6px;padding:1px 5px;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.mco-bk i{font-style:normal;color:var(--faint,#5b6472);margin-right:5px}',
    '.mco-best{border-color:rgba(47,180,124,.6);color:var(--pos,#2fb47c)}',
    '.mco-sharpbk i{color:var(--gold,#e3b84d)}',
    '.mco-alt{font-size:10.5px;color:var(--faint,#5b6472);align-self:center}',
    '.mco-oc{display:flex;gap:16px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border,#262c36);margin-top:8px;padding-top:8px;font-size:12.5px}',
    '.mco-oc span{display:flex;flex-direction:column;font-variant-numeric:tabular-nums}',
    '.mco-oc i{font-style:normal;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint,#5b6472)}',
    '.mco-edge{font-variant-numeric:tabular-nums}',
    '.mco-foot{margin-top:10px;font-size:10.5px;color:var(--faint,#5b6472)}',
    '.mco-move td{border-top:1px solid var(--border,#262c36)}'
  ].join('');

  /* Injected once per root, so the same components work in the page and
     inside the embed's shadow tree. */
  MCOdds.injectCss = function (root) {
    root = root || (global.document && global.document.head);
    if (!root) return;
    if (root.querySelector && root.querySelector('style[data-mco]')) return;
    var st = (root.ownerDocument || global.document).createElement('style');
    st.setAttribute('data-mco', '1');
    st.textContent = CSS;
    root.appendChild(st);
  };

  MCOdds.css = CSS;

  if (typeof module !== 'undefined' && module.exports) module.exports = MCOdds;
  global.MCOdds = MCOdds;
})(typeof window !== 'undefined' ? window : this);
