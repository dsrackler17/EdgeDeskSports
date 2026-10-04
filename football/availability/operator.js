/* ============================================================================
   THE OPERATOR CORRECTION INTERFACE — a human, with a receipt.

   WHY THIS EXISTS. Some of what this model needs is published in a form no
   scraper will reliably recover: a two-deep buried in a game-notes PDF laid
   out in columns, a coach naming a starter in a Monday press conference, a
   conference page that renders its table in JavaScript. Pretending otherwise
   produces the worst outcome available — a silent gap that looks like a fact
   about the sport rather than a fact about the pipeline.

   So there is a door for a person, and it is a NARROW one. Every entry must
   carry all of:

     the fact          a named player on the CURRENT roster, and a status or a
                       starter designation from EdgeDesk's own vocabulary
     the fixture       the game it is about, or the window it holds for. A fact
                       about Saturday is not a fact about the following week
     the source        a name AND a url. "I heard" is not an entry
     the publication   when the SOURCE said it, not when the operator typed it
     the operator      who recorded it, and when
     an expiry         after which it stops being applied, because a human
                       correction that never expires is a permanent fiction

   An entry missing any of them is REFUSED, loudly, with the reason — it is
   never partially applied. Refusals are published in the artifact so a
   half-filled entry is visible instead of silently inert.

   WHAT AN OPERATOR CANNOT DO. He cannot promote a projection to a
   confirmation: an entry claiming a CONFIRMED starter must carry an official
   team or conference url, and one that does not is downgraded to PROJECTED
   and says so. He cannot declare a roster healthy — there is no "everybody is
   available" entry, because that is a claim about players nobody named. He
   cannot outrank a later official filing: reconciliation is by publication
   time, and an official report published after an operator entry supersedes
   it.

   Node and browser (UMD).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDAvailabilityOperator = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var SCHEMA = 'edgedesk_operator_corrections_v1';
  var KINDS = ['AVAILABILITY', 'STARTER'];
  var STATUSES = ['AVAILABLE', 'PROBABLE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT', 'OUT_FIRST_HALF',
    'GAME_TIME_DECISION', 'DAY_TO_DAY', 'LIMITED'];
  /* how long an entry may hold if the operator gives no expiry: one football
     week. A correction about this Saturday must not still be applied in
     November because nobody came back to delete it. */
  var DEFAULT_TTL_HOURS = 168;

  function isStr(x) { return typeof x === 'string' && x.trim().length > 0; }
  function isUrl(x) { return isStr(x) && /^https?:\/\/[^\s]+\.[^\s]+/i.test(x.trim()); }
  function ts(x) { var t = Date.parse(x); return isFinite(t) ? t : null; }

  /* An OFFICIAL source is a team or conference domain. Nothing else may carry
     a CONFIRMED starter, whatever the entry claims. */
  var CONFERENCE_HOSTS = ['secsports.com', 'bigten.org', 'theacc.com', 'big12sports.com', 'themw.com',
    'conferenceusa.com', 'sunbeltsports.org'];
  function officialish(url) {
    if (!isUrl(url)) return false;
    var host = String(url).replace(/^https?:\/\//i, '').split('/')[0].toLowerCase().replace(/^www\./, '');
    for (var i = 0; i < CONFERENCE_HOSTS.length; i++) {
      if (host === CONFERENCE_HOSTS[i] || host.slice(-(CONFERENCE_HOSTS[i].length + 1)) === '.' + CONFERENCE_HOSTS[i]) return true;
    }
    /* a school's own domain: a university site, or the athletics department
       site pattern every programme uses (`gostanford.com`, `hornetsports.com`,
       `soonersports.com`, `ramblinwreck.com` is the exception and is not
       accepted here rather than being special-cased into a guess) */
    return /\.edu$/.test(host) || /^[a-z0-9-]+(sports|athletics)\.com$/.test(host);
  }

  /* one entry -> { ok, entry, why }. Nothing is coerced: a field that is wrong
     makes the entry invalid rather than being quietly corrected. */
  function validate(e, now) {
    now = now || Date.now();
    var why = [];
    if (!e || typeof e !== 'object') return { ok: false, why: ['not an object'] };
    if (KINDS.indexOf(e.kind) < 0) why.push('kind must be one of ' + KINDS.join('/'));
    if (!isStr(e.team)) why.push('team is required');
    if (!isStr(e.player)) why.push('player is required — an entry about nobody in particular is not evidence');
    if (!isStr(e.source_name)) why.push('source_name is required');
    if (!isUrl(e.source_url)) why.push('source_url must be a real http(s) url — "I heard" is not an entry');
    if (!isStr(e.recorded_by)) why.push('recorded_by is required: a correction needs an author');
    var pub = ts(e.published_at);
    if (pub == null) why.push('published_at is required and must be a timestamp — when the SOURCE said it, not '
      + 'when this was typed');
    else if (pub > now + 3600000) why.push('published_at is in the future');
    var rec = ts(e.recorded_at);
    if (rec == null) why.push('recorded_at is required');
    if (e.kind === 'AVAILABILITY' && STATUSES.indexOf(e.status) < 0) {
      why.push('status must be one of ' + STATUSES.join('/'));
    }
    if (e.kind === 'STARTER' && !isStr(e.position)) why.push('a STARTER entry must name the position');
    if (!isStr(e.game_id) && ts(e.kickoff) == null && ts(e.expires_at) == null) {
      why.push('an entry needs a game_id, a kickoff or an expires_at: a fact with no fixture and no expiry is a '
        + 'permanent claim, and this interface does not accept those');
    }
    if (why.length) return { ok: false, why: why };

    var expires = ts(e.expires_at);
    if (expires == null) {
      var k = ts(e.kickoff);
      /* a game-scoped entry dies six hours after its kickoff; otherwise the
         default week applies */
      expires = k != null ? (k + 6 * 3600000) : (pub + DEFAULT_TTL_HOURS * 3600000);
    }
    var confirmed = e.kind === 'STARTER' && e.confirmed === true;
    var downgraded = null;
    if (confirmed && !officialish(e.source_url)) {
      confirmed = false;
      downgraded = 'the entry claimed a CONFIRMED starter but its source is not a team or conference domain, so it '
        + 'is carried as a PROJECTION. An operator cannot promote a projection to an announcement';
    }
    return { ok: true, why: [], entry: {
      kind: e.kind, team: e.team, player: e.player, position: e.position || null,
      status: e.kind === 'AVAILABILITY' ? e.status : null,
      confirmed: e.kind === 'STARTER' ? confirmed : null,
      downgraded_why: downgraded,
      game_id: isStr(e.game_id) ? e.game_id : null,
      kickoff: e.kickoff || null,
      source_name: e.source_name, source_url: e.source_url,
      published_at: new Date(pub).toISOString(),
      recorded_by: e.recorded_by, recorded_at: new Date(rec).toISOString(),
      expires_at: new Date(expires).toISOString(),
      note: isStr(e.note) ? e.note : null,
      /* the tier an operator entry enters the evidence stack at. Below an
         official filing and above nothing. */
      tier: confirmed ? 1 : 2,
      evidence_kind: 'OPERATOR'
    } };
  }

  /* the whole store -> what is live now, what is expired, and what was
     refused. Every category is published; nothing disappears quietly. */
  function load(store, now) {
    now = now || Date.now();
    var live = [], expired = [], refused = [];
    var list = (store && store.entries) || [];
    for (var i = 0; i < list.length; i++) {
      var v = validate(list[i], now);
      if (!v.ok) { refused.push({ entry: list[i], why: v.why }); continue; }
      if (Date.parse(v.entry.expires_at) <= now) { expired.push(v.entry); continue; }
      live.push(v.entry);
    }
    return { live: live, expired: expired, refused: refused,
      counts: { live: live.length, expired: expired.length, refused: refused.length },
      basis: 'an operator correction is dated evidence with a named source and an expiry. It is tiered below an '
        + 'official filing, it cannot declare a roster healthy, and it cannot promote a projection to a '
        + 'confirmation without an official url.' };
  }

  /* live entries for one team, newest publication first */
  function forTeam(loaded, teamKeyOrName, normKey) {
    var k = normKey ? normKey(teamKeyOrName) : String(teamKeyOrName || '').toLowerCase();
    return (loaded.live || []).filter(function (e) {
      return (normKey ? normKey(e.team) : String(e.team).toLowerCase()) === k;
    }).sort(function (a, b) { return Date.parse(b.published_at) - Date.parse(a.published_at); });
  }

  return { SCHEMA: SCHEMA, KINDS: KINDS, STATUSES: STATUSES, DEFAULT_TTL_HOURS: DEFAULT_TTL_HOURS,
    validate: validate, load: load, forTeam: forTeam, officialish: officialish };
});
