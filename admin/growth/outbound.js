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
   =========================================================================== */
(function (root) {
  'use strict';

  var S = null, OWNER = false, LOADED = false, SETTINGS = null;
  var BLOCKERS = {
    postal_address_missing: 'no postal address is configured (required in every commercial email)',
    unsubscribe_endpoint_missing: 'the opt-out endpoint is not configured yet',
    test_inbox_missing: 'test mode is on but no test inbox is set',
    no_outbound_owner: 'no outbound owner is configured'
  };
  var STATUS = { discovered: 'Discovered', needs_research: 'Needs research', qualified: 'Qualified', ready_for_review: 'Ready for review',
    contacted: 'Contacted', replied: 'Replied', converted: 'Converted', rejected: 'Rejected', suppressed: 'Suppressed' };
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
    ['obKpis', 'obProspects', 'obSupp', 'obSettings', 'obActivity', 'obChips'].forEach(function (id) { if ($(id)) $(id).innerHTML = ''; });
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
          return '<tr><td>' + esc(x.full_name || '(name not established)') + (x.is_test ? ' <span class="pill test">TEST</span>' : '') + (x.suppressed ? ' <span class="pill bad">suppressed</span>' : '') + '</td>'
            + '<td>' + esc(x.organization || '—') + '</td><td>' + esc(x.prospect_type) + (x.sports_focus && x.sports_focus.length ? ' · ' + esc(x.sports_focus.join(', ')) : '') + '</td>'
            + '<td class="r">' + (x.fit_score == null ? '—' : esc(x.fit_score)) + '</td>'
            + '<td class="conf"><b>' + num(x.identity_confidence) + '</b> · ' + num(x.role_confidence) + ' · <b>' + num(x.email_confidence) + '</b> · ' + num(x.research_confidence) + '</td>'
            + '<td class="mono">' + esc(x.email || '—') + ' <span class="pill">' + esc(x.email_status) + '</span></td>'
            + '<td>' + esc(STATUS[x.status] || x.status) + '</td><td>' + when(x.updated_at) + '</td></tr>';
        }).join('') : '<tr><td colspan="8">No prospects ' + (st ? 'in "' + esc(STATUS[st] || st) + '"' : 'yet') + '. Discovery and research arrive in later phases; nothing is invented to fill this table.</td></tr>');
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
  }

  var API = { start: start, reset: reset, show: show, _readSettings: readSettings };
  root.EDOutbound = API;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  }
})(typeof window !== 'undefined' ? window : globalThis);
