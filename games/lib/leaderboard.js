/* ===========================================================================
   EdgeDesk Games — the weekly leaderboard.

   TWO RULES, and they are the whole design:

     1. NEVER FABRICATE A PLAYER. If there are no real entries, the board says
        "No leaderboard results yet. Be the first." — it does not seed itself
        with plausible names to look busy. Fake social proof is a lie that gets
        harder to unwind the longer it runs.
     2. NEVER BLOCK PLAY. The board is a read against a Supabase table that may
        not be deployed yet. Every failure resolves to the honest empty state
        rather than an error the player has to think about.

   The table is defined in supabase/games_leaderboard.sql. Until it is deployed
   this module returns `{ available:false }` and the page renders the empty
   state, which is exactly what a brand-new product should show.
   =========================================================================== */
(function (root) {
  'use strict';

  var W = root.EDGamesWeek;
  var TABLE = 'games_weekly_scores';
  var TIMEOUT_MS = 6000;

  /* The project URL and public anon key are declared once, in the terminal.
     A page that wants the leaderboard passes them in via configure() so this
     module never carries a second copy of a credential. */
  var cfg = null;
  function configure(url, key) { cfg = (url && key) ? { url: url, key: key } : null; }

  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; rej(new Error('timeout')); } }, ms);
      p.then(function (v) { if (!done) { done = true; clearTimeout(t); res(v); } },
             function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } });
    });
  }

  /* Top N for a week. Resolves — never rejects — to a shape the page can
     render without branching on errors. */
  function top(weekKey, limit) {
    var wk = weekKey || (W ? W.weekKey() : null);
    var n = limit || 10;
    var empty = { available: false, week: wk, rows: [], reason: null };
    if (!cfg || typeof fetch !== 'function') {
      empty.reason = 'not_configured';
      return Promise.resolve(empty);
    }
    var q = cfg.url + '/rest/v1/' + TABLE
      + '?select=display_name,score,price_it_played,pick5_correct'
      + '&week_key=eq.' + encodeURIComponent(wk)
      + '&order=score.desc&limit=' + n;
    return withTimeout(fetch(q, { headers: { apikey: cfg.key, authorization: 'Bearer ' + cfg.key } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (rows) {
        if (!Array.isArray(rows)) throw new Error('unexpected shape');
        return { available: true, week: wk, rows: rows, reason: null };
      }), TIMEOUT_MS)
      .catch(function (e) {
        empty.reason = (e && e.message) || 'unreachable';
        return empty;
      });
  }

  /* The player's own rank, when the board is live AND they appear on it.
     An anonymous player who has never published a score has no rank, and the
     page must say "—" rather than inventing a position. */
  function rankOf(rows, displayName) {
    if (!rows || !rows.length || !displayName) return null;
    for (var i = 0; i < rows.length; i++)
      if (rows[i].display_name === displayName) return i + 1;
    return null;
  }

  var API = { TABLE: TABLE, configure: configure, top: top, rankOf: rankOf };
  root.EDGamesLeaderboard = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
