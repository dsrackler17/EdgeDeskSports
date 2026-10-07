/* ===========================================================================
   /admin/growth/ — the OUTBOUND tab (supabase/growth_outbound.sql).

   Shown only to an outbound OWNER. The page asks one question first —
   growth_outbound_is_owner() — and calls no other outbound door unless the
   answer is exactly true. That is a courtesy, not the security: every door
   checks the owner again in the database, and an affiliate admin who is not
   an owner is refused there whatever this page does.

   Nothing here sends anything. The tab shows the mode (TEST MODE / LIVE)
   everywhere it matters, what is blocking a send, today's counts, the
   prospects (with their emails — owner only), suppressions, the settings
   and the activity log. Raising the daily cap and leaving test mode each
   ask for a deliberate confirmation, and the database refuses either without
   the confirmation flag.

   RESEARCH (Phase 3). One prospect opens into what is known about them and
   how sure: every number beside its bar, the gates still unmet, each fact
   with its sources, and the full history of every observation ("previously
   … currently …"). The owner adds a prospect or evidence, retires a wrong
   observation, and releases an address or profile attached to the wrong
   person. The page computes nothing: names, confidences, scores and status
   all come back from the database, which derives them from the evidence.
   Everything shown here was found on the open web, so all of it is escaped,
   and only an https: address ever becomes a link.
   =========================================================================== */
(function (root) {
  'use strict';

  var S = null, OWNER = false, LOADED = false, SETTINGS = null, DETAIL = null, CATALOG = null;
  var BLOCKERS = {
    postal_address_missing: 'no postal address is configured (required in every commercial email)',
    unsubscribe_endpoint_missing: 'the opt-out endpoint is not configured yet',
    test_inbox_missing: 'test mode is on but no test inbox is set',
    no_outbound_owner: 'no outbound owner is configured'
  };
  var STATUS = { discovered: 'Discovered', needs_research: 'Needs research', qualified: 'Qualified', ready_for_review: 'Ready for review',
    contacted: 'Contacted', replied: 'Replied', converted: 'Converted', rejected: 'Rejected', suppressed: 'Suppressed' };
  var EV_FIELDS = [['full_name', 'Name'], ['organization', 'Organization'], ['job_title', 'Title or role'], ['email', 'Email address'],
    ['project', 'Project'], ['article', 'Article'], ['podcast', 'Podcast'], ['newsletter', 'Newsletter'], ['model', 'Model'],
    ['topic', 'Topic'], ['sports_focus', 'Sport covered'], ['audience_size', 'Audience size'], ['fit_signal', 'Fit signal']];
  var EV_KINDS = [['own_site', 'Their own site'], ['own_profile', 'Their own profile'], ['publication', 'A publication about them'],
    ['interview', 'An interview'], ['directory', 'A directory or list'], ['owner_verified', 'I checked it myself'],
    ['pattern_guess', 'A guessed address (email only)'], ['provider_verified', 'Verification provider'], ['provider_found', 'Provider lookup']];
  var REASONS = { conflicting_sources: 'sources disagree', single_source: 'only one independent source', stale_role: 'over a year old',
    stale_audience: 'over a year old', old_content: 'over 18 months old — never call it recent' };
  var WARN = { first_name_withheld: 'first name withheld — identity not certain, or no plain first name',
    role_unconfirmed: 'role below its confidence bar', email_unsourced: 'the email address has no source',
    draft_cites_no_evidence: 'a draft cites no evidence', unsupported_claim: 'a draft makes a claim no current evidence supports',
    duplicate: 'duplicates another prospect', possible_duplicate: 'may be the same person as another prospect' };
  var FIELDS = [
    ['Mode', [['test_mode', 'bool', 'Test mode — every send goes only to the test inbox'],
              ['automation_enabled', 'bool', 'Automation — discover, research and draft on schedule (never approve, never send)'],
              ['test_inbox', 'email', 'Test inbox']]],
    ['Limits', [['max_sends_per_day', 'int', 'Daily send cap (live)', 1, 200], ['max_test_sends_per_day', 'int', 'Daily test-send cap', 1, 100],
                ['daily_prospect_target', 'int', 'Prospects to prepare per day', 1, 100]]],
    ['Gates', [['min_fit_score', 'int', 'Minimum fit score', 0, 100], ['min_identity_confidence', 'num', 'Minimum identity confidence'],
               ['min_role_confidence', 'num', 'Minimum role confidence'], ['min_research_confidence', 'num', 'Minimum research confidence'],
               ['min_email_confidence', 'num', 'Minimum email confidence']]],
    ['Follow-ups', [['followup_enabled', 'bool', 'Follow-up 1 (still needs your approval)'], ['followup_delay_days', 'int', 'Days before follow-up 1', 2, 30],
                    ['final_followup_enabled', 'bool', 'Final follow-up'], ['final_followup_delay_days', 'int', 'Days before the final follow-up', 3, 60]]],
    ['Sender and compliance', [['sender_name', 'text', 'Sender name'], ['sender_email', 'email', 'Sender email (@edgedesksports.com)'],
                               ['reply_to_email', 'email', 'Reply-to (@edgedesksports.com, optional)'], ['cta_url', 'text', 'Call-to-action URL (edgedesksports.com)'],
                               ['business_name', 'text', 'Business name in the footer'], ['postal_address', 'text', 'Postal address in the footer (required to send)'],
                               ['unsubscribe_url_base', 'text', 'Opt-out endpoint base URL']]]
  ];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function say(id, kind, t) { var el = $(id); if (!el) return; el.className = 'msg ' + (kind || ''); el.textContent = t || ''; }
  function when(v) { return v ? String(v).replace('T', ' ').slice(0, 16) + 'Z' : '—'; }
  function num(x, d) { return x == null ? '—' : Number(x).toFixed(d == null ? 2 : d); }
  function label(list, k) { for (var i = 0; i < list.length; i++) if (list[i][0] === k) return list[i][1]; return k; }
  function warnText(w) {
    w = String(w);
    if (WARN[w]) return WARN[w];
    var m = /^(conflict|stale|unsupported_fit_factor|unknown_fit_factor):(.+)$/.exec(w);
    if (!m) return w;
    return m[1] === 'conflict' ? 'sources disagree about the ' + label(EV_FIELDS, m[2]).toLowerCase()
      : m[1] === 'stale' ? 'the ' + label(EV_FIELDS, m[2]).toLowerCase() + ' is old'
      : m[1] === 'unsupported_fit_factor' ? 'fit reason "' + m[2] + '" has no current evidence, so it does not count'
      : 'unknown fit reason "' + m[2] + '"';
  }
  /* A source address came from the web: it is a link only if it is plainly https. */
  function link(u, text) {
    u = String(u || '');
    var t = esc(text == null ? u : text);
    return /^https:\/\/[^\s"'<>`\\]+$/.test(u) ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer nofollow">' + t + '</a>' : t;
  }
  function hostOf(u) { var m = /^https?:\/\/([^/?#]+)/.exec(String(u || '')); return m ? m[1] : String(u || ''); }
  function clip(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n) + '…' : t; }
  function options(list, sel) { return list.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (x[0] === sel ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join(''); }
  function kpi(label, v, sub) { return '<div class="kpi"><i>' + esc(label) + '</i><b>' + esc(v) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>'; }
  function fail(id, e) {
    if (e && e.kind === 'signed_out') { if (typeof root.showGate === 'function') root.showGate(e.message, false); return; }
    if (e && e.kind === 'forbidden') { reset(); say('appMsg', 'err', 'This account is no longer an outbound owner.'); $('appMsg').classList.remove('hide'); return; }
    say(id, 'err', S ? S.message(e) : String(e && e.message || e));
    var el = $(id); if (el) el.classList.remove('hide');
  }

  /* ── visibility ─────────────────────────────────────────────────────── */
  function reset() {
    OWNER = false; LOADED = false; SETTINGS = null;
    if ($('tabs')) $('tabs').classList.add('hide');
    if ($('obModeTag')) $('obModeTag').classList.add('hide');
    show('growth');
    DETAIL = null; CATALOG = null;
    ['obKpis', 'obProspects', 'obSupp', 'obSettings', 'obActivity', 'obChips', 'obDetail', 'obLookOut'].forEach(function (id) { if ($(id)) $(id).innerHTML = ''; });
    if ($('obDetailWrap')) $('obDetailWrap').classList.add('hide');
  }
  function show(which) {
    var out = which === 'outbound' && OWNER;
    $('tabGrowth').classList.toggle('hide', out);
    $('tabOutbound').classList.toggle('hide', !out);
    $('tabBtnGrowth').classList.toggle('on', !out); $('tabBtnGrowth').setAttribute('aria-selected', String(!out));
    $('tabBtnOutbound').classList.toggle('on', out); $('tabBtnOutbound').setAttribute('aria-selected', String(out));
    if (out && !LOADED) load();
  }

  /* Ask the one question. Anything but exactly `true` hides the tab. */
  function start(session) {
    S = session; reset();
    return S.rpc('growth_outbound_is_owner', {}).then(function (v) {
      OWNER = v === true;
      $('tabs').classList.toggle('hide', !OWNER);
      if (OWNER) return S.rpc('growth_outbound_settings', {}).then(paintMode, function () {});
    }, function () { OWNER = false; $('tabs').classList.add('hide'); });
  }

  /* ── mode: TEST MODE / LIVE, everywhere ─────────────────────────────── */
  function paintMode(st) {
    SETTINGS = st || SETTINGS || {};
    var s = SETTINGS, t = s.today || {};
    var tag = $('obModeTag');
    tag.classList.remove('hide');
    tag.className = 'tag ' + (s.test_mode ? 'test' : 'live');
    tag.textContent = s.test_mode ? 'outbound · test mode' : 'outbound · LIVE';
    $('obChips').innerHTML =
      (s.test_mode ? '<span class="chip test" data-mode="test">TEST MODE — sends go only to ' + esc(s.test_inbox || '(no test inbox set)') + '</span>'
                   : '<span class="chip live" data-mode="live">LIVE — approved drafts reach real prospects</span>')
      + '<span class="chip ' + (s.automation_enabled ? 'ok' : 'off') + '">automation ' + (s.automation_enabled ? 'on' : 'off') + ' · never approves or sends</span>'
      + '<span class="chip">live sends today ' + esc(t.live_sends || 0) + ' / ' + esc(s.max_sends_per_day) + '</span>'
      + '<span class="chip">test sends today ' + esc(t.test_sends || 0) + ' / ' + esc(s.max_test_sends_per_day) + '</span>';
    var b = s.send_blockers || [];
    $('obBlock').classList.toggle('hide', !b.length);
    $('obBlock').innerHTML = b.length ? '<b>Sending is blocked</b> until this is fixed: ' + b.map(function (x) { return esc(BLOCKERS[x] || x); }).join(' · ') : '';
  }

  /* ── loading ────────────────────────────────────────────────────────── */
  function load() {
    if (!OWNER) return Promise.resolve();
    LOADED = true;
    $('obMsg').classList.add('hide');
    return Promise.all([loadOverview(), loadProspects(), loadSupp(), loadActivity()]).catch(function (e) { fail('obMsg', e); });
  }
  function loadOverview() {
    return S.rpc('growth_outbound_overview', {}).then(function (o) {
      paintMode(o.settings); paintSettings(o.settings);
      var p = o.prospects_by_status || {};
      $('obKpis').innerHTML = kpi('Discovered today', o.discovered_today || 0)
        + kpi('Needs research', p.needs_research || 0) + kpi('Ready for review', p.ready_for_review || 0, (o.drafts_pending_review || 0) + ' draft(s) waiting')
        + kpi('Approved, not sent', o.drafts_approved_unsent || 0) + kpi('Contacted', p.contacted || 0)
        + kpi('Replied', p.replied || 0) + kpi('Suppressed', o.suppressions || 0, 'addresses and domains')
        + kpi('Sent automatically', 0, 'always zero: sending needs you');
    });
  }
  function loadProspects() {
    var st = $('obStatus').value || null, q = $('obSearch').value.trim() || null;
    return S.rpc('growth_outbound_prospects', { p_status: st, p_search: q, p_limit: 100, p_offset: 0 }).then(function (r) {
      var rows = (r && r.rows) || [];
      $('obProspects').innerHTML = '<tr><th>Prospect</th><th>Organization</th><th>Type · focus</th><th class="r">Fit</th><th>Confidence (id · role · email · research)</th><th>Email</th><th>Status</th><th>Updated</th></tr>'
        + (rows.length ? rows.map(function (x) {
          return '<tr><td><button type="button" class="lnk" data-open="' + esc(x.id) + '">' + esc(x.full_name || '(name not established)') + '</button>'
            + (x.is_test ? ' <span class="pill test">TEST</span>' : '') + (x.suppressed ? ' <span class="pill bad">suppressed</span>' : '')
            + (x.duplicate_of ? ' <span class="pill bad">duplicate</span>' : '') + '</td>'
            + '<td>' + esc(x.organization || '—') + '</td><td>' + esc(x.prospect_type) + (x.sports_focus && x.sports_focus.length ? ' · ' + esc(x.sports_focus.join(', ')) : '') + '</td>'
            + '<td class="r">' + (x.fit_score == null ? '—' : esc(x.fit_score)) + '</td>'
            + '<td class="conf"><b>' + num(x.identity_confidence) + '</b> · ' + num(x.role_confidence) + ' · <b>' + num(x.email_confidence) + '</b> · ' + num(x.research_confidence) + '</td>'
            + '<td class="mono">' + esc(x.email || '—') + ' <span class="pill">' + esc(x.email_status) + '</span></td>'
            + '<td>' + esc(STATUS[x.status] || x.status) + (x.gates && x.gates.length ? '<div class="sub">' + esc(clip(x.gates.join('; '), 120)) + '</div>' : '') + '</td><td>' + when(x.updated_at) + '</td></tr>';
        }).join('') : '<tr><td colspan="8">No prospects ' + (st ? 'in "' + esc(STATUS[st] || st) + '"' : 'yet') + '. Add one below; automatic discovery arrives in a later phase, and nothing is invented to fill this table.</td></tr>');
    });
  }
  function loadSupp() {
    return S.rpc('growth_outbound_suppressions', { p_limit: 200 }).then(function (rows) {
      rows = rows || [];
      $('obSupp').innerHTML = '<tr><th>When</th><th>Scope</th><th>Address or domain</th><th>Kind</th><th>Source</th><th>Reason</th></tr>'
        + (rows.length ? rows.map(function (x) {
          return '<tr><td>' + when(x.created_at) + '</td><td>' + esc(x.scope) + '</td><td class="mono">' + esc(x.target) + '</td><td>' + esc(x.kind) + '</td><td>' + esc(x.source) + '</td><td class="wrap">' + esc(x.reason || '') + '</td></tr>';
        }).join('') : '<tr><td colspan="6">No suppressions yet.</td></tr>');
    });
  }
  function loadActivity() {
    return S.rpc('growth_outbound_activity', { p_limit: 100, p_prospect: null }).then(function (rows) {
      rows = rows || [];
      $('obActivity').innerHTML = '<tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Detail</th></tr>'
        + (rows.length ? rows.map(function (a) {
          return '<tr><td>' + when(a.at) + '</td><td>' + esc(a.actor_kind) + '</td><td>' + esc(a.action) + '</td><td class="mono">' + esc((a.entity || '') + (a.entity_id ? ' ' + String(a.entity_id).slice(0, 8) : '')) + '</td>'
            + '<td class="mono wrap">' + esc(JSON.stringify(a.detail || {}).slice(0, 400)) + '</td></tr>';
        }).join('') : '<tr><td colspan="5">Nothing recorded yet.</td></tr>');
    });
  }

  /* ── settings ───────────────────────────────────────────────────────── */
  function paintSettings(s) {
    s = s || {};
    $('obSettings').innerHTML = FIELDS.map(function (g) {
      return '<fieldset><legend>' + esc(g[0]) + '</legend><div class="row">' + g[1].map(function (f) {
        var id = 'obf_' + f[0], v = s[f[0]];
        if (f[1] === 'bool') return '<div class="f" style="min-width:260px"><label class="chk"><input type="checkbox" id="' + id + '"' + (v ? ' checked' : '') + '> ' + esc(f[2]) + '</label></div>';
        var type = f[1] === 'int' || f[1] === 'num' ? 'number' : f[1] === 'email' ? 'email' : 'text';
        var extra = f[1] === 'num' ? ' step="0.01" min="0" max="1"' : f[1] === 'int' ? ' step="1"' + (f[3] != null ? ' min="' + f[3] + '"' : '') + (f[4] != null ? ' max="' + f[4] + '"' : '') : '';
        return '<div class="f"><label for="' + id + '">' + esc(f[2]) + '</label><input id="' + id + '" type="' + type + '"' + extra + ' value="' + esc(v == null ? '' : v) + '"></div>';
      }).join('') + '</div></fieldset>';
    }).join('');
  }
  function readSettings() {
    var out = {};
    FIELDS.forEach(function (g) {
      g[1].forEach(function (f) {
        var el = $('obf_' + f[0]); if (!el) return;
        var cur = SETTINGS ? SETTINGS[f[0]] : undefined, v;
        if (f[1] === 'bool') v = el.checked;
        else if (f[1] === 'int') v = el.value === '' ? null : parseInt(el.value, 10);
        else if (f[1] === 'num') v = el.value === '' ? null : parseFloat(el.value);
        else v = el.value.trim() === '' ? null : el.value.trim();
        if (v === null && (f[1] === 'int' || f[1] === 'num')) return;
        if (String(v) !== String(cur == null ? null : cur)) out[f[0]] = v;
      });
    });
    return out;
  }
  function save() {
    var p = readSettings(), keys = Object.keys(p);
    if (!keys.length) { say('obSetMsg', '', 'Nothing changed.'); return Promise.resolve(); }
    var s = SETTINGS || {};
    /* RAISING THE CAP IS DELIBERATE: said in numbers, confirmed, and the flag
       goes to the database, which refuses the increase without it. */
    if (p.max_sends_per_day != null && p.max_sends_per_day > s.max_sends_per_day) {
      if (!root.confirm('You are about to RAISE the daily live send cap from ' + s.max_sends_per_day + ' to ' + p.max_sends_per_day + '.\n\nScaling should be deliberate. Continue?')) {
        say('obSetMsg', '', 'Not saved: the cap increase was not confirmed.'); return Promise.resolve();
      }
      p.confirm_cap_increase = true;
    }
    /* LEAVING TEST MODE: typed, not clicked. */
    if (p.test_mode === false && s.test_mode) {
      var typed = root.prompt('Leaving TEST MODE lets approved drafts reach REAL prospects.\n\nType LIVE to confirm.');
      if (typed !== 'LIVE') { say('obSetMsg', '', 'Not saved: still in test mode.'); return Promise.resolve(); }
      p.confirm_live = true;
    }
    $('obSave').disabled = true;
    return S.rpc('growth_outbound_settings_update', { p: p }).then(function (r) {
      if (!r || r.ok === false) { say('obSetMsg', 'err', 'Not saved: ' + ((r && (r.detail || r.reason)) || 'refused')); return; }
      var changed = Object.keys(r.changed || {});
      say('obSetMsg', 'ok', changed.length ? 'Saved: ' + changed.join(', ') + '.' : 'Saved (no change).');
      paintMode(r.settings); paintSettings(r.settings);
      return loadActivity();
    }, function (e) { fail('obSetMsg', e); }).then(function () { $('obSave').disabled = false; });
  }

  /* ── one prospect: what is known, and how sure ─────────────────────── */
  function catalog() {
    if (CATALOG) return Promise.resolve(CATALOG);
    return S.rpc('growth_outbound_fit_catalog', {}).then(function (c) { CATALOG = c || []; return CATALOG; },
      function (e) { if (e && e.kind === 'not_installed') return []; throw e; });
  }
  function openProspect(id) {
    if (!OWNER || !id) return Promise.resolve();
    $('obDetailWrap').classList.remove('hide');
    say('obDetailMsg', '', 'Loading…');
    return Promise.all([S.rpc('growth_outbound_prospect', { p_id: id }), catalog()]).then(function (r) {
      var d = r[0];
      if (!d || d.ok === false) { say('obDetailMsg', 'err', 'That prospect could not be loaded' + (d && d.reason ? ' (' + d.reason + ')' : '') + '.'); return; }
      DETAIL = d; say('obDetailMsg', '', ''); paintDetail(d);
      /* below the sticky header, whatever height it wraps to on this screen */
      var hd = document.querySelector('header'), top = $('obDetailWrap').getBoundingClientRect().top + (root.pageYOffset || 0) - (hd ? hd.offsetHeight : 0) - 8;
      if (root.scrollTo) root.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }, function (e) { fail('obDetailMsg', e); });
  }
  function bar(name, v, min, extra, advisory) {
    var ok = v != null && min != null && Number(v) >= Number(min);
    return '<div class="kpi ' + (v == null ? '' : ok ? 'pass' : 'short') + '"><i>' + esc(name) + '</i><b>' + (v == null ? '—' : esc(typeof v === 'number' && v <= 1 ? num(v) : v)) + '</b>'
      + '<small>' + (min != null ? (advisory ? 'aim ' : 'needs ') + esc(min) : '') + (extra ? (min != null ? ' · ' : '') + esc(extra) : '') + '</small></div>';
  }
  function paintDetail(d) {
    var p = d.prospect || {}, a = p.assessment || {}, th = a.thresholds || {}, f = a.fields || {}, gates = a.gates || [];
    var current = (d.evidence || []).filter(function (e) { return e.current; });
    var h = '<div class="row" style="align-items:center"><div><div class="pname">' + esc(p.full_name || '(name not established)')
      + (p.is_test ? ' <span class="pill test">TEST</span>' : '') + (p.suppressed ? ' <span class="pill bad">suppressed</span>' : '') + '</div>'
      + '<div class="sub">' + esc([p.job_title, p.organization].filter(Boolean).join(' · ') || 'role not established') + ' · ' + esc(p.prospect_type) + '</div></div>'
      + '<span class="sp"></span><span class="pill st">' + esc(STATUS[p.status] || p.status) + '</span></div>';
    if (!a.evaluated_at) h += '<div class="block">Not assessed yet: run supabase/growth_outbound.sql again so the database can evaluate this prospect. Nothing here counts as ready until it has.</div>';
    else if (p.status === 'suppressed' || p.status === 'rejected') h += '<div class="block">' + esc(STATUS[p.status]) + (p.status_reason ? ': ' + esc(p.status_reason) : '') + '</div>';
    else if (gates.length) h += '<div class="block"><b>Not ready to contact.</b> ' + gates.map(esc).join(' · ') + '</div>';
    else if (p.status === 'needs_research') h += '<div class="block">' + esc(p.status_reason || 'More research requested') + '</div>';
    else if (p.status === 'discovered') h += '<div class="block">Nothing is known about this prospect yet: add evidence below.</div>';
    else h += '<div class="okb">Every gate clears' + (p.is_test ? ' (a test prospect skips the gates)' : '') + '.</div>';
    h += '<div class="kpis" style="margin-top:10px">'
      + bar('Identity', p.identity_confidence, th.identity) + bar('Role', p.role_confidence, th.role, 'a gate only when a draft cites it', true)
      + bar('Email', p.email_confidence, th.email, p.email ? p.email_status : 'no address')
      + bar('Research', p.research_confidence, th.research, a.research && a.research.from === 'draft_claims' ? 'weakest claim a draft cites' : 'best fact found')
      + bar('Fit', p.fit_score, th.fit) + '</div>';
    if ((p.warnings || []).length) h += '<div class="chips">' + p.warnings.map(function (w) { return '<span class="chip warn">' + esc(warnText(w)) + '</span>'; }).join('') + '</div>';
    if ((d.related || []).length) h += '<div class="note">' + d.related.map(function (r) {
      return (r.relation === 'duplicate_of' ? 'Duplicate of ' : 'Possibly the same person as ') + '<button type="button" class="lnk" data-open="' + esc(r.id) + '">'
        + esc(r.full_name || r.email || r.id) + '</button>' + (r.organization ? ' (' + esc(r.organization) + ')' : '');
    }).join(' · ') + '</div>';

    h += '<h3>What is established</h3><div class="tw"><table><tr><th>Fact</th><th>Currently</th><th class="r">Confidence</th><th class="r">Sources</th><th>Why not higher</th><th>Other claims</th></tr>'
      + ['full_name', 'organization', 'job_title', 'audience_size'].map(function (k) {
        var x = f[k];
        if (!x) return '<tr><td>' + esc(label(EV_FIELDS, k)) + '</td><td colspan="5" class="dim">no evidence</td></tr>';
        return '<tr><td>' + esc(label(EV_FIELDS, k)) + '</td><td class="wrap">' + esc(x.claim) + '</td><td class="r conf">' + num(x.confidence) + '</td><td class="r">' + esc(x.sources) + '</td>'
          + '<td class="wrap">' + esc((x.reasons || []).map(function (r) { return REASONS[r] || r; }).join('; ')) + '</td>'
          + '<td class="wrap">' + esc((x.alternatives || []).map(function (o) { return o.claim + ' (' + num(o.confidence) + ')'; }).join('; ')) + '</td></tr>';
      }).join('')
      + '<tr><td>Email</td><td class="mono">' + esc(p.email || '—') + '</td><td class="r conf">' + num(p.email_confidence) + '</td><td class="r">' + esc(a.email && a.email.kinds ? a.email.kinds.length : 0) + '</td>'
      + '<td class="wrap">' + esc(p.email ? p.email_status + (p.email_status === 'verified' ? '' : ' — verified means you, or a verification provider, checked it') : '') + '</td><td></td></tr></table></div>';

    var fit = (a.fit && a.fit.factors) || [];
    h += '<h3>Fit</h3><div class="tw"><table><tr><th>Reason</th><th class="r">Points</th><th>Rests on evidence</th><th class="r">Confidence</th></tr>'
      + (fit.length ? fit.map(function (x) {
        return '<tr><td>' + esc(x.label) + '</td><td class="r">' + esc((x.points > 0 ? '+' : '') + x.points) + '</td><td class="mono">' + esc((x.evidence || []).map(function (i) { return '#' + i; }).join(' ') || '— (a penalty needs none)') + '</td><td class="r conf">' + num(x.confidence) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="dim">No fit reason counts yet.</td></tr>') + '</table></div>';

    h += '<h3>Evidence — currently and previously</h3><div class="tw"><table><tr><th>#</th><th>Fact</th><th>Claim</th><th>Source</th><th>The words on the page</th><th>Published</th><th>Seen</th><th class="r">Now</th><th>State</th></tr>'
      + ((d.evidence || []).length ? d.evidence.map(function (e) {
        return '<tr class="' + (e.current ? '' : 'old') + '"><td class="mono">' + esc(e.id) + '</td><td>' + esc(label(EV_FIELDS, e.field_name)) + '</td><td class="wrap">' + esc(clip(e.claim, 200)) + '</td>'
          + '<td>' + esc(label(EV_KINDS, e.source_kind)) + '<div class="sub">' + link(e.source_url, hostOf(e.source_url)) + '</div></td>'
          + '<td class="wrap quote">' + esc(clip(e.source_excerpt, 280)) + '</td><td>' + (e.source_published_at ? esc(String(e.source_published_at).slice(0, 10)) : '—') + '</td><td>' + esc(String(e.observed_at || '').slice(0, 10)) + '</td>'
          + '<td class="r conf">' + (e.current ? num(e.claim_confidence) : '—') + '</td>'
          + '<td class="wrap">' + (e.current ? 'current <button type="button" class="g sm" data-supersede="' + esc(e.id) + '">Supersede</button>'
            : 'previously — superseded ' + esc(String(e.superseded_at || '').slice(0, 10)) + (e.superseded_reason ? ': ' + esc(clip(e.superseded_reason, 160)) : '')) + '</td></tr>';
      }).join('') : '<tr><td colspan="9" class="dim">No evidence yet.</td></tr>') + '</table></div>';

    h += '<h3>Add evidence</h3><div class="row">'
      + '<div class="f" style="max-width:170px"><label for="evField">Fact</label><select id="evField">' + options(EV_FIELDS, 'project') + '</select></div>'
      + '<div class="f"><label for="evClaim">Claim</label><input id="evClaim" maxlength="500"></div>'
      + '<div class="f"><label for="evUrl">Source page (https://…)</label><input id="evUrl" maxlength="2000" class="mono"></div>'
      + '<div class="f" style="max-width:210px"><label for="evKind">Kind of source</label><select id="evKind">' + options(EV_KINDS.slice(0, 7), 'own_site') + '</select></div></div>'
      + '<div class="row" style="margin-top:8px"><div class="f"><label for="evQuote">The words on the page that say it</label><input id="evQuote" maxlength="2000"></div>'
      + '<div class="f" style="max-width:170px"><label for="evDate">Published (optional)</label><input id="evDate" type="date"></div>'
      + '<button type="button" id="evAdd">Add evidence</button></div><div class="msg" id="evMsg"></div>'
      + '<div class="note">Confidence is the database\'s, not yours: one site counts once however often it repeats a claim, a rival claim halves it, and old roles and old content weigh less.</div>';

    h += '<h3>Fit reasons</h3><div class="row">'
      + '<div class="f"><label for="fitCode">Reason</label><select id="fitCode">' + (CATALOG || []).map(function (c) {
        return '<option value="' + esc(c.code) + '">' + esc(c.label + ' (' + (c.points > 0 ? '+' : '') + c.points + ')') + '</option>';
      }).join('') + '</select></div>'
      + '<div class="f"><label for="fitEv">Rests on (current evidence)</label><select id="fitEv"><option value="">— none (only a penalty may) —</option>' + current.filter(function (e) { return e.field_name !== 'email'; }).map(function (e) {
        return '<option value="' + esc(e.id) + '">#' + esc(e.id) + ' ' + esc(label(EV_FIELDS, e.field_name)) + ': ' + esc(clip(e.claim, 60)) + '</option>';
      }).join('') + '</select></div><button type="button" class="g" id="fitAdd">Add reason</button>'
      + '<button type="button" class="g" id="fitDrop">Remove reason</button></div><div class="msg" id="fitMsg"></div>';

    h += '<h3>Who this is</h3><div class="tw"><table><tr><th>Key</th><th>Value</th><th>Strength</th><th>First seen</th><th>State</th><th></th></tr>'
      + ((d.identifiers || []).length ? d.identifiers.map(function (i) {
        return '<tr class="' + (i.released_at ? 'old' : '') + '"><td>' + esc(i.kind) + '</td><td class="mono wrap">' + esc(clip(i.value, 120)) + '</td><td>' + esc(i.strength) + '</td><td>' + esc(String(i.first_seen || '').slice(0, 10)) + '</td>'
          + '<td class="wrap">' + (i.released_at ? 'released' + (i.released_reason ? ': ' + esc(clip(i.released_reason, 120)) : '') : 'current') + '</td>'
          + '<td>' + (i.released_at || i.kind === 'name_org' ? '' : '<button type="button" class="g sm" data-release="' + esc(i.id) + '">Not theirs</button>') + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="dim">No identifiers.</td></tr>') + '</table></div>'
      + '<div class="note">An email address or a profile names one prospect. "Not theirs" releases it from this person (kept on the record) so it can belong to someone else.</div>';

    h += '<h3>Drafts</h3><div class="tw"><table><tr><th>Step</th><th>Subject</th><th>Status</th><th class="r">Claims cited</th></tr>'
      + ((d.drafts || []).length ? d.drafts.map(function (x) {
        return '<tr><td>' + esc(x.sequence_number) + '</td><td class="wrap">' + esc(clip(x.subject, 150)) + '</td><td>' + esc(x.status) + '</td><td class="r">' + esc((x.claims || []).length) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="dim">No drafts. Drafting arrives in a later phase.</td></tr>') + '</table></div>';

    h += '<div class="row" style="margin-top:12px"><span class="sp"></span><button type="button" class="g" id="pdEval">Re-evaluate</button>'
      + '<button type="button" class="g" id="pdResearch">Needs more research</button><button type="button" class="g" id="pdReject">Reject</button></div>';
    $('obDetail').innerHTML = h;
  }
  function refreshAfter(id) {
    return Promise.all([openProspect(id), loadProspects(), loadOverview(), loadActivity()]).catch(function (e) { fail('obDetailMsg', e); });
  }
  function why(r) { return (r && (r.detail || r.reason)) || 'refused'; }
  function addEvidence() {
    if (!DETAIL) return Promise.resolve();
    var id = DETAIL.prospect.id, url = $('evUrl').value.trim(), claim = $('evClaim').value.trim();
    if (!claim || !url) { say('evMsg', 'err', 'A claim and the page it is on are both needed.'); return Promise.resolve(); }
    var item = { field_name: $('evField').value, claim: claim, source_url: url, source_kind: $('evKind').value,
      source_excerpt: $('evQuote').value.trim() || null };
    if ($('evDate').value) item.source_published_at = $('evDate').value + 'T00:00:00Z';
    $('evAdd').disabled = true;
    return S.rpc('growth_outbound_evidence_add', { p_prospect: id, p: { evidence: [item] } }).then(function (r) {
      if (!r || r.ok === false) { say('evMsg', 'err', 'Not added: ' + why(r)); $('evAdd').disabled = false; return; }
      return refreshAfter(id);
    }, function (e) { $('evAdd').disabled = false; fail('evMsg', e); });
  }
  function fitChange(remove) {
    if (!DETAIL) return Promise.resolve();
    var id = DETAIL.prospect.id, code = $('fitCode').value, ev = $('fitEv').value;
    var f = { code: code };
    if (remove) f.remove = true; else if (ev) f.evidence = [Number(ev)];
    return S.rpc('growth_outbound_evidence_add', { p_prospect: id, p: { fit_factors: [f] } }).then(function (r) {
      if (!r || r.ok === false) { say('fitMsg', 'err', 'Not changed: ' + why(r)); return; }
      return refreshAfter(id);
    }, function (e) { fail('fitMsg', e); });
  }
  function supersede(evId) {
    var reason = root.prompt('Supersede evidence #' + evId + '?\n\nIt stays on the record as "previously", and stops counting. Why?');
    if (reason == null || !String(reason).trim()) return Promise.resolve();
    var id = DETAIL.prospect.id;
    return S.rpc('growth_outbound_evidence_supersede', { p_evidence_id: Number(evId), p_reason: String(reason).trim() }).then(function (r) {
      if (!r || r.ok === false) { say('obDetailMsg', 'err', 'Not superseded: ' + why(r)); return; }
      return refreshAfter(id);
    }, function (e) { fail('obDetailMsg', e); });
  }
  function release(keyId) {
    var reason = root.prompt('This address or profile does not belong to this person?\n\nIt is released from them (kept on the record) and cleared from the prospect. Why?');
    if (reason == null || !String(reason).trim()) return Promise.resolve();
    var id = DETAIL.prospect.id;
    return S.rpc('growth_outbound_identifier_release', { p_identifier_id: Number(keyId), p_reason: String(reason).trim() }).then(function (r) {
      if (!r || r.ok === false) { say('obDetailMsg', 'err', 'Not released: ' + why(r)); return; }
      return refreshAfter(id);
    }, function (e) { fail('obDetailMsg', e); });
  }
  function setStatus(st) {
    if (!DETAIL) return Promise.resolve();
    var id = DETAIL.prospect.id;
    var reason = root.prompt(st === 'rejected' ? 'Reject this prospect? Any draft still waiting is cancelled. Reason:' : 'What needs more research? (Any draft still waiting is cancelled.)');
    if (reason == null) return Promise.resolve();
    return S.rpc('growth_outbound_prospect_set_status', { p_id: id, p_status: st, p_reason: String(reason).trim() || null }).then(function (r) {
      if (!r || r.ok === false) { say('obDetailMsg', 'err', 'Not changed: ' + why(r)); return; }
      return refreshAfter(id);
    }, function (e) { fail('obDetailMsg', e); });
  }
  function reevaluate() {
    if (!DETAIL) return Promise.resolve();
    var id = DETAIL.prospect.id;
    return S.rpc('growth_outbound_prospect_evaluate', { p_id: id }).then(function () { return refreshAfter(id); }, function (e) { fail('obDetailMsg', e); });
  }

  /* ── have we seen them? and: add a prospect ─────────────────────────── */
  function lookup() {
    var q = $('obLook').value.trim();
    if (!q) return Promise.resolve();
    return S.rpc('growth_outbound_identity_lookup', { p_text: q }).then(function (r) {
      if (!r || r.ok === false) { $('obLookOut').innerHTML = '<div class="msg err">That is not an email address or a web address.</div>'; return; }
      var hits = [];
      (r.keys || []).forEach(function (k) { (k.matches || []).forEach(function (m) { if (!m.released) hits.push({ k: k, m: m }); }); });
      $('obLookOut').innerHTML = '<div class="note">Recognised as <span class="mono">' + esc(r.canonical) + '</span> · keys: '
        + esc((r.keys || []).map(function (k) { return k.kind + ' ' + k.value + ' (' + k.strength + ')'; }).join(', ')) + '</div>'
        + (r.suppressed ? '<div class="block">This address is suppressed: it will not be added or contacted.</div>' : '')
        + (hits.length ? '<div class="note">Already known: ' + hits.map(function (x) {
          return '<button type="button" class="lnk" data-open="' + esc(x.m.prospect_id) + '">' + esc(x.m.full_name || '(name not established)') + '</button> (' + esc(STATUS[x.m.status] || x.m.status) + ', by ' + esc(x.k.kind) + ')';
        }).join(' · ') + '</div>' : '<div class="note">Not seen before.</div>');
    }, function (e) { fail('obLookMsg', e); });
  }
  function addProspect() {
    var p = {}, email = $('apEmail').value.trim(), urls = $('apUrls').value.split(/\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (email) p.email = email;
    if (urls.length) p.urls = urls;
    if (!email && !urls.length) { say('apMsg', 'err', 'Give an email address or a profile or website: a prospect must be someone we can recognise again.'); return Promise.resolve(); }
    p.prospect_type = $('apType').value; p.campaign_type = $('apCampaign').value;
    var sports = $('apSports').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (sports.length) p.sports_focus = sports;
    if ($('apTest').checked) p.is_test = true;
    var claim = $('apClaim').value.trim(), src = $('apSrc').value.trim();
    if (claim || src) {
      if (!claim || !src) { say('apMsg', 'err', 'Evidence needs both the claim and the page it is on.'); return Promise.resolve(); }
      p.evidence = [{ field_name: $('apField').value, claim: claim, source_url: src, source_kind: $('apKind').value, source_excerpt: $('apQuote').value.trim() || null }];
    }
    $('apAdd').disabled = true;
    return S.rpc('growth_outbound_prospect_upsert', { p: p }).then(function (r) {
      $('apAdd').disabled = false;
      if (!r || r.ok === false) {
        say('apMsg', 'err', r && r.reason === 'suppressed' ? 'Not added: that address, its domain or that person is suppressed.'
          : r && r.reason === 'identity_conflict' ? 'Not added: those details belong to different prospects. Open them and release the wrong one first.'
          : 'Not added: ' + why(r));
        return;
      }
      say('apMsg', 'ok', (r.created ? 'Added' : 'Already known — added to their record') + '. Status: ' + (STATUS[r.status] || r.status) + '.'
        + (r.possible_duplicates && r.possible_duplicates.length ? ' Possibly the same person as ' + r.possible_duplicates.length + ' other prospect(s).' : ''));
      ['apEmail', 'apUrls', 'apSports', 'apClaim', 'apSrc', 'apQuote'].forEach(function (k) { $(k).value = ''; });
      return refreshAfter(r.prospect_id);
    }, function (e) { $('apAdd').disabled = false; fail('apMsg', e); });
  }

  /* ── suppress ───────────────────────────────────────────────────────── */
  function suppress() {
    var t = $('supTarget').value.trim(), scope = $('supScope').value, kind = $('supKind').value, why = $('supReason').value.trim() || null;
    if (!t) { say('supMsg', 'err', 'Enter an address or a domain.'); return Promise.resolve(); }
    if (!root.confirm('Suppress ' + (scope === 'domain' ? 'every address at ' : '') + t + ' permanently?\n\nEvery unsent draft for it is cancelled. This cannot be undone from the console.')) return Promise.resolve();
    return S.rpc('growth_outbound_suppress', { p_target: t, p_kind: kind, p_reason: why, p_scope: scope }).then(function (r) {
      if (!r || r.ok === false) { say('supMsg', 'err', 'Not suppressed: ' + (r && r.reason === 'invalid_target_or_kind' ? 'that is not a valid ' + (scope === 'domain' ? 'domain' : 'address') : (r && r.reason) || 'refused')); return; }
      say('supMsg', 'ok', 'Suppressed. ' + r.prospects_suppressed + ' prospect(s) marked, ' + r.drafts_cancelled + ' draft(s) cancelled.');
      $('supTarget').value = ''; $('supReason').value = '';
      return Promise.all([loadSupp(), loadOverview(), loadProspects(), loadActivity()]);
    }, function (e) { fail('supMsg', e); });
  }

  function wire() {
    $('tabBtnGrowth').onclick = function () { show('growth'); };
    $('tabBtnOutbound').onclick = function () { show('outbound'); };
    $('obReload').onclick = function () { LOADED = false; load(); };
    $('obFind').onclick = function () { loadProspects().catch(function (e) { fail('obMsg', e); }); };
    $('obStatus').onchange = $('obFind').onclick;
    $('obSearch').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('obFind').onclick(); });
    $('obSave').onclick = save;
    $('supAdd').onclick = suppress;
    $('obLookBtn').onclick = lookup;
    $('obLook').addEventListener('keydown', function (e) { if (e.key === 'Enter') lookup(); });
    $('apAdd').onclick = addProspect;
    $('apField').innerHTML = options(EV_FIELDS, 'full_name');
    $('apKind').innerHTML = options(EV_KINDS.slice(0, 7), 'own_site');
    $('obDetailClose').onclick = function () { DETAIL = null; $('obDetailWrap').classList.add('hide'); $('obDetail').innerHTML = ''; };
    /* one listener for every button drawn from data */
    $('tabOutbound').addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b || !OWNER) return;
      if (b.getAttribute('data-open')) openProspect(b.getAttribute('data-open'));
      else if (b.getAttribute('data-supersede')) supersede(b.getAttribute('data-supersede'));
      else if (b.getAttribute('data-release')) release(b.getAttribute('data-release'));
      else if (b.id === 'evAdd') addEvidence();
      else if (b.id === 'fitAdd') fitChange(false);
      else if (b.id === 'fitDrop') fitChange(true);
      else if (b.id === 'pdEval') reevaluate();
      else if (b.id === 'pdResearch') setStatus('needs_research');
      else if (b.id === 'pdReject') setStatus('rejected');
    });
  }

  var API = { start: start, reset: reset, show: show, open: openProspect, _readSettings: readSettings };
  root.EDOutbound = API;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  }
})(typeof window !== 'undefined' ? window : globalThis);
