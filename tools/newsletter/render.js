#!/usr/bin/env node
/* ============================================================================
   THE EMAIL — EdgeDesk's brand, in the one medium that still runs on 1999's
   HTML.

   THE CONSTRAINTS ARE NOT STYLISTIC, THEY ARE WHAT MAIL CLIENTS DO:

     · every style is inline, because Outlook and several webmail clients drop
       or rewrite a <style> block. The <style> block that IS here carries only
       a mobile media query, which is an enhancement — the layout is correct
       without it;
     · the layout is nested tables with explicit widths. Flexbox and grid do
       not survive Word's rendering engine, which is what desktop Outlook uses;
     · there is not a single <img> in the file. "Keep essential information
       readable with images disabled" is trivially satisfied by an email that
       has no images to disable — the EdgeDesk mark is a coloured table cell,
       the rules are borders, and the numbers are text;
     · no web font. A font a client will not load is a font that falls back
       somewhere you did not choose, so the stack is the system one and the
       numbers are in the system monospace, which is what the terminal's
       JetBrains Mono degrades to anyway;
     · the preheader is the first thing in the body and is hidden, because the
       inbox preview line is the second-most-read text in any newsletter and
       leaving it to chance means it shows the unsubscribe link.

   THE PALETTE IS THE SITE'S, token for token — the warm ink ground and the
   teal OBSERVED accent out of index.html's :root. A dark email is a real
   choice in 2026 and the brand is dark; the one concession is that every
   background colour is set explicitly on a cell rather than inherited, so a
   client that ignores the body background does not paint dark text on white.

   PLACEHOLDERS, NOT ADDRESSES. Unsubscribe, preferences and the one-click
   endpoint are per recipient, so the stored edition carries {{PLACEHOLDERS}}
   and the sender substitutes them. The stored HTML is therefore identical for
   every recipient, which is what makes an edition reproducible.
   ========================================================================== */
'use strict';

/* index.html :root, the tokens that survive being inlined. */
const T = {
  ink: '#100e0a',
  panel: '#191510',
  raised: '#221c15',
  cell: '#1e1913',
  line: '#332a1b',
  line2: '#3a3124',
  text: '#f1ebdf',
  dim: '#a29581',
  faint: '#6f6553',
  obs: '#2fa79a',          /* OBSERVED — measured, and the brand accent */
  onAccent: '#042320',
  est: '#d9a441',          /* ESTIMATED */
  exp: '#d274b0',          /* EXPERIMENTAL */
  val: '#7cc142',          /* VALIDATED */
  neg: '#e2664b',
};
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
const WIDTH = 600;

const PLACEHOLDER = {
  unsubscribe: '{{UNSUBSCRIBE_URL}}',
  preferences: '{{PREFERENCES_URL}}',
  webview: '{{WEBVIEW_URL}}',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function txt(v) { if (v == null) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }

/* ------------------------------------------------------------- fragments */
function cell(content, style) {
  return '<td style="' + style + '">' + content + '</td>';
}
function row(content) { return '<tr>' + content + '</tr>'; }
function table(inner, attrs) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
    + (attrs || '') + '>' + inner + '</table>';
}

function rule(color) {
  return table(row(cell('&nbsp;', 'font-size:1px;line-height:1px;height:1px;background-color:'
    + (color || T.line) + ';')), 'width="100%" style="width:100%;"');
}

function spacer(h) {
  return '<div style="line-height:' + h + 'px;height:' + h + 'px;font-size:1px;">&nbsp;</div>';
}

function pill(label, color) {
  return '<span style="font-family:' + MONO + ';font-size:10px;letter-spacing:.09em;'
    + 'text-transform:uppercase;color:' + color + ';border:1px solid ' + color + ';'
    + 'border-radius:999px;padding:2px 7px;white-space:nowrap;">' + esc(label) + '</span>';
}

function btn(href, label, opts) {
  opts = opts || {};
  const bg = opts.ghost ? 'transparent' : T.obs;
  const fg = opts.ghost ? T.text : T.onAccent;
  const border = opts.ghost ? T.line2 : T.obs;
  return table(row(cell(
    '<a href="' + esc(href) + '" style="display:inline-block;font-family:' + SANS + ';'
    + 'font-size:14px;font-weight:700;color:' + fg + ';text-decoration:none;padding:12px 20px;'
    + 'border:1px solid ' + border + ';border-radius:9px;">' + esc(label) + '</a>',
    'background-color:' + bg + ';border-radius:9px;')),
  'border="0" cellpadding="0" cellspacing="0"');
}

/* ------------------------------------------------------------- the games */
function numberRow(label, value, opts) {
  opts = opts || {};
  return row(
    cell('<span style="font-family:' + SANS + ';font-size:12px;color:' + T.faint + ';'
      + 'text-transform:uppercase;letter-spacing:.06em;">' + esc(label) + '</span>',
    'padding:4px 10px 4px 0;vertical-align:top;width:40%;')
    + cell('<span style="font-family:' + MONO + ';font-size:14px;color:'
      + (opts.color || T.text) + ';font-weight:600;">' + esc(value) + '</span>'
      + (opts.note ? '<br><span style="font-family:' + SANS + ';font-size:11.5px;color:'
        + T.faint + ';">' + esc(opts.note) + '</span>' : ''),
    'padding:4px 0;vertical-align:top;'));
}

function gameBlock(g, index) {
  const parts = [];
  /* rank + matchup */
  parts.push('<div style="font-family:' + MONO + ';font-size:11px;letter-spacing:.14em;'
    + 'text-transform:uppercase;color:' + T.obs + ';font-weight:700;">'
    + esc('#' + (g.rank || index + 1)) + '</div>');
  parts.push('<div style="font-family:' + SANS + ';font-size:19px;line-height:1.25;font-weight:700;'
    + 'color:' + T.text + ';padding-top:4px;">' + esc(g.matchup) + '</div>');
  parts.push('<div style="font-family:' + MONO + ';font-size:12px;color:' + T.dim + ';padding-top:5px;">'
    + esc(g.kickoff_label || '')
    + (g.venue ? esc(' · ' + g.venue) : '')
    + (g.neutral_site ? ' · neutral site' : '') + '</div>');

  /* the numbers */
  const rows = [];
  if (g.model && g.model.home_line_text) {
    rows.push(numberRow('EdgeDesk fair spread', g.model.home_line_text, { color: T.exp }));
  }
  if (g.market && g.market.available) {
    rows.push(numberRow('Market spread', g.market.line_text, {
      color: T.obs,
      note: [g.market.book, g.market.quoted_at_label].filter(Boolean).join(' · ')
        + (g.market.stale ? ' · flagged stale' : ''),
    }));
  } else if (g.market) {
    rows.push(numberRow('Market spread', 'not available', {
      color: T.faint, note: g.market.why || null,
    }));
  }
  if (g.difference && g.difference.available) {
    rows.push(numberRow('Difference',
      (g.difference.points === 0 ? 'none' : g.difference.points.toFixed(1) + ' pts toward '
        + (g.difference.edge_home > 0 ? g.home : g.away)),
      { color: T.est }));
  }
  if (g.total) rows.push(numberRow('Total', g.model.total + ' model · ' + g.market.total + ' market', { color: T.dim }));
  if (rows.length) {
    parts.push(spacer(12) + table(rows.join(''), 'width="100%" style="width:100%;"'));
  }

  if (g.difference && g.difference.available && g.difference.points !== 0) {
    parts.push('<div style="font-family:' + SANS + ';font-size:13px;line-height:1.5;color:' + T.dim
      + ';padding-top:10px;">' + esc(g.difference.text) + '</div>');
  }

  /* the evidence */
  if ((g.why || []).length) {
    parts.push(spacer(10) + (g.why || []).map(w =>
      '<div style="font-family:' + SANS + ';font-size:14px;line-height:1.55;color:' + T.text
      + ';padding-bottom:7px;">' + esc(w.text) + '</div>').join(''));
  }

  /* what to watch */
  if (g.watch) {
    parts.push(spacer(4) + table(row(
      cell('<div style="font-family:' + MONO + ';font-size:10px;letter-spacing:.09em;'
        + 'text-transform:uppercase;color:' + T.est + ';padding-bottom:4px;">'
        + esc('Watch before kickoff' + (g.watch.label ? ' · ' + g.watch.label : '')) + '</div>'
        + '<div style="font-family:' + SANS + ';font-size:13px;line-height:1.5;color:' + T.dim + ';">'
        + esc(g.watch.text) + '</div>',
      'padding:11px 13px;background-color:' + T.cell + ';border-left:3px solid ' + T.est + ';')),
    'width="100%" style="width:100%;"'));
  }

  /* flags the reader is owed */
  const flags = (g.flags || []).filter(f => f && f.text);
  if (flags.length) {
    parts.push(spacer(8) + flags.map(f =>
      '<div style="font-family:' + SANS + ';font-size:12px;line-height:1.5;color:' + T.faint
      + ';padding-bottom:4px;">' + esc(f.text) + '</div>').join(''));
  }

  /* the link */
  if (g.link) {
    parts.push(spacer(12) + '<a href="' + esc(g.link.url) + '" style="font-family:' + SANS
      + ';font-size:13.5px;font-weight:600;color:' + T.obs + ';text-decoration:underline;">'
      + esc(g.link.label) + ' &rarr;</a>');
  }

  return table(row(cell(parts.join(''), 'padding:20px 0 4px 0;')), 'width="100%" style="width:100%;"');
}

/* ------------------------------------------------------------ the layout */
function renderHtml(edition, opts) {
  opts = opts || {};
  const urls = Object.assign({}, PLACEHOLDER, opts.urls || {});
  const variant = opts.variant === 'member' ? 'member' : 'free';
  const site = opts.site || 'https://edgedesksports.com';
  const address = opts.mailing_address || 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423';
  const hub = edition.sport === 'CFB' ? site + '/articles/college-football' : site + '/articles/nfl';

  const body = [];

  /* preheader — hidden, and padded so a client does not pull the footer in */
  body.push('<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;'
    + 'font-size:1px;line-height:1px;color:' + T.ink + ';opacity:0;">'
    + esc(edition.preview_text || '')
    + '&#847;&zwnj;&nbsp;'.repeat(60) + '</div>');

  /* masthead */
  body.push(table(row(
    cell(table(row(
      cell('&nbsp;', 'width:9px;background-color:' + T.obs + ';font-size:1px;line-height:18px;')
      + cell('&nbsp;', 'width:9px;font-size:1px;')
      + cell('<span style="font-family:' + SANS + ';font-size:17px;font-weight:800;color:'
        + T.text + ';letter-spacing:-.01em;">EdgeDesk</span>', 'vertical-align:middle;')
      + cell(pill('Research, not picks', T.obs), 'text-align:right;vertical-align:middle;')),
    'width="100%" style="width:100%;"'), 'padding:22px 0 14px 0;')),
  'width="100%" style="width:100%;"'));

  body.push(rule(T.line));

  /* title */
  body.push(table(row(cell(
    '<div style="font-family:' + MONO + ';font-size:11px;letter-spacing:.2em;text-transform:uppercase;'
    + 'color:' + T.dim + ';">' + esc(edition.title) + '</div>'
    + '<div style="font-family:' + SANS + ';font-size:26px;line-height:1.2;font-weight:800;color:'
    + T.text + ';padding-top:8px;letter-spacing:-.02em;">'
    + esc('Week ' + edition.week + ' — ' + edition.game_count + ' game'
      + (edition.game_count === 1 ? '' : 's') + ' worth your research time') + '</div>'
    + '<div style="font-family:' + MONO + ';font-size:11.5px;color:' + T.faint + ';padding-top:8px;">'
    + esc('Season ' + edition.season + ' · data cutoff ' + String(edition.data_cutoff_at).replace('T', ' ').slice(0, 16) + ' UTC')
    + '</div>',
    'padding:24px 0 6px 0;')), 'width="100%" style="width:100%;"'));

  /* intro */
  body.push(table(row(cell(
    (edition.intro.paragraphs || []).map(p =>
      '<div style="font-family:' + SANS + ';font-size:15px;line-height:1.62;color:' + T.dim
      + ';padding-bottom:12px;">' + esc(p) + '</div>').join(''),
    'padding:14px 0 2px 0;')), 'width="100%" style="width:100%;"'));

  /* the main research CTA, once, near the top where it is useful */
  body.push(table(row(cell(btn(hub, 'Open the EdgeDesk research'), 'padding:6px 0 18px 0;')),
    'width="100%" style="width:100%;"'));

  body.push(rule(T.line));

  /* the games */
  (edition.games || []).forEach((g, i) => {
    body.push(gameBlock(g, i));
    if (i < edition.games.length - 1) body.push(spacer(14) + rule(T.line2) );
  });

  if (!(edition.games || []).length) {
    body.push(table(row(cell('<div style="font-family:' + SANS + ';font-size:15px;line-height:1.6;color:'
      + T.dim + ';">No game on this week’s slate cleared EdgeDesk’s research bar, so there is nothing '
      + 'to feature. That is the finding.</div>', 'padding:24px 0;')), 'width="100%" style="width:100%;"'));
  }

  body.push(spacer(18) + rule(T.line));

  /* standing disclosures */
  const disclosures = (edition.disclosures || []).slice();
  body.push(table(row(cell(
    '<div style="font-family:' + MONO + ';font-size:10px;letter-spacing:.09em;text-transform:uppercase;'
    + 'color:' + T.faint + ';padding-bottom:8px;">What this is, and what it is not</div>'
    + '<div style="font-family:' + SANS + ';font-size:12.5px;line-height:1.6;color:' + T.faint + ';">'
    + esc(edition.positioning) + '</div>'
    + disclosures.map(d => '<div style="font-family:' + SANS + ';font-size:12.5px;line-height:1.6;color:'
      + T.faint + ';padding-top:8px;">' + esc(d) + '</div>').join(''),
    'padding:20px 0;')), 'width="100%" style="width:100%;"'));

  /* the audience CTA — restrained, and different for a member */
  if (variant === 'member') {
    body.push(table(row(cell(
      '<div style="font-family:' + SANS + ';font-size:13.5px;line-height:1.6;color:' + T.dim + ';">'
      + 'Your subscription includes the full board, every game on it and the model-versus-market state '
      + 'for each one — not just the games in this email.</div>'
      + spacer(10) + btn(site + '/app.html#research/football', 'Open the research terminal', { ghost: true }),
      'padding:16px 18px;background-color:' + T.panel + ';border:1px solid ' + T.line + ';border-radius:12px;')),
    'width="100%" style="width:100%;"'));
  } else {
    body.push(table(row(cell(
      '<div style="font-family:' + SANS + ';font-size:13.5px;line-height:1.6;color:' + T.dim + ';">'
      + 'This email covers ' + esc(String(edition.game_count)) + ' of '
      + esc(String((edition.selection_summary && edition.selection_summary.considered) || edition.game_count))
      + ' games EdgeDesk priced this week. The terminal carries all of them, with the drivers, the '
      + 'measured edges and the limits behind each number.</div>'
      + spacer(10) + btn(site + '/#pricing', 'See what a subscription opens', { ghost: true }),
      'padding:16px 18px;background-color:' + T.panel + ';border:1px solid ' + T.line + ';border-radius:12px;')),
    'width="100%" style="width:100%;"'));
  }

  /* footer */
  body.push(spacer(22) + rule(T.line) + table(row(cell(
    '<div style="font-family:' + SANS + ';font-size:12px;line-height:1.7;color:' + T.faint + ';">'
    + 'You are receiving this because you asked EdgeDesk for the '
    + esc(edition.sport_label) + ' week-ahead research email.<br>'
    + '<a href="' + esc(urls.preferences) + '" style="color:' + T.obs + ';text-decoration:underline;">Email preferences</a>'
    + ' &nbsp;·&nbsp; '
    + '<a href="' + esc(urls.unsubscribe) + '" style="color:' + T.obs + ';text-decoration:underline;">Unsubscribe</a>'
    + ' &nbsp;·&nbsp; '
    + '<a href="' + esc(site) + '/privacy.html" style="color:' + T.faint + ';text-decoration:underline;">Privacy</a>'
    + ' &nbsp;·&nbsp; '
    + '<a href="' + esc(site) + '/terms.html" style="color:' + T.faint + ';text-decoration:underline;">Terms</a>'
    + '</div>'
    + '<div style="font-family:' + SANS + ';font-size:11.5px;line-height:1.7;color:' + T.faint + ';padding-top:12px;">'
    + esc(address) + '</div>'
    + '<div style="font-family:' + SANS + ';font-size:11.5px;line-height:1.7;color:' + T.faint + ';padding-top:10px;">'
    + 'Research and information only. Not betting or financial advice, and not a prediction of any outcome. '
    + '21+ &middot; 1-800-GAMBLER &middot; ncpgambling.org</div>',
    'padding:18px 0 34px 0;')), 'width="100%" style="width:100%;"'));

  return [
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml" lang="en">',
    '<head>',
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="color-scheme" content="dark light" />',
    '<meta name="supported-color-schemes" content="dark light" />',
    '<title>' + esc(edition.subject) + '</title>',
    '<style type="text/css">',
    '  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}',
    '  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}',
    '  a{color:' + T.obs + ';}',
    '  @media screen and (max-width:620px){',
    '    .edx{width:100% !important;}',
    '    .edpad{padding-left:18px !important;padding-right:18px !important;}',
    '  }',
    '</style>',
    '</head>',
    '<body style="margin:0;padding:0;background-color:' + T.ink + ';">',
    table(row(cell(
      table(row(cell(body.join(''), 'padding:0 24px;')),
        'class="edx" width="' + WIDTH + '" style="width:' + WIDTH + 'px;max-width:' + WIDTH + 'px;'
        + 'background-color:' + T.ink + ';"'),
      'align="center" style="padding:0;')),
    'width="100%" style="width:100%;background-color:' + T.ink + ';" class="edpad"'),
    '</body></html>',
  ].join('\n');
}

/* ---------------------------------------------------------- plain text */
/* NOT AN AFTERTHOUGHT. Some readers set their client to text, some clients
   fall back to it, and spam filters read it. It carries every fact the HTML
   carries, in the same order, with the same numbers. */
function renderText(edition, opts) {
  opts = opts || {};
  const urls = Object.assign({}, PLACEHOLDER, opts.urls || {});
  const variant = opts.variant === 'member' ? 'member' : 'free';
  const site = opts.site || 'https://edgedesksports.com';
  const address = opts.mailing_address || 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423';
  const hub = edition.sport === 'CFB' ? site + '/articles/college-football' : site + '/articles/nfl';
  const L = [];
  const hr = '-'.repeat(64);

  L.push('EDGEDESK — ' + edition.title.toUpperCase() + ' · RESEARCH, NOT PICKS');
  L.push(hr);
  L.push('Week ' + edition.week + ' — ' + edition.game_count + ' game'
    + (edition.game_count === 1 ? '' : 's') + ' worth your research time');
  L.push('Season ' + edition.season + ' · data cutoff ' + String(edition.data_cutoff_at).replace('T', ' ').slice(0, 16) + ' UTC');
  L.push('');
  (edition.intro.paragraphs || []).forEach(p => { L.push(wrap(p)); L.push(''); });
  L.push('Open the EdgeDesk research: ' + hub);
  L.push('');

  (edition.games || []).forEach((g, i) => {
    L.push(hr);
    L.push('#' + (g.rank || i + 1) + '  ' + g.matchup);
    L.push(g.kickoff_label + (g.venue ? ' · ' + g.venue : '') + (g.neutral_site ? ' · neutral site' : ''));
    L.push('');
    const lbl = (k) => '  ' + k.padEnd(20, ' ') + ': ';
    if (g.model && g.model.home_line_text) L.push(lbl('EdgeDesk fair spread') + g.model.home_line_text);
    if (g.market && g.market.available) {
      L.push(lbl('Market spread') + g.market.line_text
        + '  (' + [g.market.book, g.market.quoted_at_label].filter(Boolean).join(', ')
        + (g.market.stale ? ', flagged stale' : '') + ')');
    } else if (g.market) {
      L.push(lbl('Market spread') + 'not available' + (g.market.why ? ' — ' + g.market.why : ''));
    }
    if (g.difference && g.difference.available) {
      L.push(lbl('Difference') + (g.difference.points === 0 ? 'none'
        : g.difference.points.toFixed(1) + ' pts toward ' + (g.difference.edge_home > 0 ? g.home : g.away)));
    }
    if (g.total) L.push(lbl('Total') + g.model.total + ' model · ' + g.market.total + ' market');
    L.push('');
    if (g.difference && g.difference.available && g.difference.points !== 0) { L.push(wrap(g.difference.text)); L.push(''); }
    (g.why || []).forEach(w => { L.push(wrap(w.text)); L.push(''); });
    if (g.watch) {
      L.push('WATCH BEFORE KICKOFF' + (g.watch.label ? ' — ' + g.watch.label : '') + ':');
      L.push(wrap(g.watch.text)); L.push('');
    }
    (g.flags || []).filter(f => f && f.text).forEach(f => { L.push(wrap(f.text)); L.push(''); });
    if (g.link) L.push(g.link.label + ': ' + g.link.url);
    L.push('');
  });

  if (!(edition.games || []).length) {
    L.push(wrap('No game on this week’s slate cleared EdgeDesk’s research bar, so there is nothing to feature. That is the finding.'));
    L.push('');
  }

  L.push(hr);
  L.push('WHAT THIS IS, AND WHAT IT IS NOT');
  L.push(wrap(edition.positioning));
  (edition.disclosures || []).forEach(d => { L.push(''); L.push(wrap(d)); });
  L.push('');
  if (variant === 'member') {
    L.push(wrap('Your subscription includes the full board, every game on it and the model-versus-market state for each one — not just the games in this email.'));
    L.push('Open the research terminal: ' + site + '/app.html#research/football');
  } else {
    L.push(wrap('This email covers ' + edition.game_count + ' of '
      + ((edition.selection_summary && edition.selection_summary.considered) || edition.game_count)
      + ' games EdgeDesk priced this week. The terminal carries all of them, with the drivers, the measured edges and the limits behind each number.'));
    L.push('See what a subscription opens: ' + site + '/#pricing');
  }
  L.push('');
  L.push(hr);
  L.push(wrap('You are receiving this because you asked EdgeDesk for the ' + edition.sport_label
    + ' week-ahead research email.'));
  L.push('Email preferences: ' + urls.preferences);
  L.push('Unsubscribe: ' + urls.unsubscribe);
  L.push(address);
  L.push(wrap('Research and information only. Not betting or financial advice, and not a prediction of any outcome. 21+ · 1-800-GAMBLER · ncpgambling.org'));
  return L.join('\n') + '\n';
}

function wrap(s, width) {
  const w = width || 72;
  const words = String(s == null ? '' : s).split(/\s+/).filter(Boolean);
  const out = []; let line = '';
  words.forEach(word => {
    if (!line.length) { line = word; return; }
    if ((line + ' ' + word).length > w) { out.push(line); line = word; return; }
    line += ' ' + word;
  });
  if (line.length) out.push(line);
  return out.join('\n');
}

/* Substitute the per-recipient placeholders into stored copy. Deliberately a
   plain replace on an exact token: a template language here would be a second
   way for an address to end up in the wrong email. */
function personalise(body, urls) {
  let out = String(body == null ? '' : body);
  Object.keys(PLACEHOLDER).forEach(k => {
    const token = PLACEHOLDER[k];
    const value = (urls && urls[k]) || '';
    out = out.split(token).join(value);
  });
  return out;
}

function render(edition, opts) {
  return { html: renderHtml(edition, opts), text: renderText(edition, opts) };
}

module.exports = { T, SANS, MONO, WIDTH, PLACEHOLDER, esc, wrap, render, renderHtml, renderText, personalise };
