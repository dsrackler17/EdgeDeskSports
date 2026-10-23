/* ===========================================================================
   edgedesk-sim fetch-cfb-sources — read the PRIMARY sources the college
   football simulator's rules config names, from somewhere that can reach
   them (GitHub's runners: .github/workflows/simulator-cfb-sources.yml), and
   print them whole.

     node simulator/src/cli/fetch_cfb_sources.ts [--out simulator/out/cfb_sources] [--only id,id] [--rows]

   --rows prints the rankings tables row by row (they are always written to
   --out as .tsv; the log keeps one summary line per season without it).
   Each text, link list and table prints as ONE JSON-encoded line (--lines
   for plain multi-line text): a job log is read back through an API that
   returns only its last 5,000 lines.

   Read-only. No credential, no database, nothing written outside --out.
   For each source: the URL asked and the URL answered, the HTTP status, the
   byte count and sha256 of the body, then the page text (PDFs through
   pdftotext). A reviewed commit compares that text with
   simulator/src/sports/cfb/config.ts and CFB_SIMULATOR_NOTES.md and cites the
   sha256 it read; nothing here marks anything verified.

   A source marked render is also loaded in headless Chrome (CHROME_BIN, else
   google-chrome / chromium on the PATH) and read from the rendered DOM: the
   conference sites build their articles in the browser, so the served HTML
   holds only the headline. A PDF with no text layer is read by OCR
   (pdftoppm + tesseract) and its text says so.

   Three kinds of source:
     rules     the CFP's 2026 format and selection protocol, each FBS
               conference's championship-game tiebreaker procedure, and the
               eligibility notices for reclassifying programs
     discover  a league's football landing page, printed as the links that
               name a tiebreaker, championship or eligibility (to find the
               2026 document when its URL is not known yet)
     rankings  Wikipedia's season rankings pages: only the CFP committee's
               table, printed as tab-separated rows (the committee proxy's
               historical inputs, simulator/src/research/cfb_committee.ts)
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256Hex } from '../core/canonical.ts';

const a = process.argv.slice(2), get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const OUT = get('--out') || path.join('simulator', 'out', 'cfb_sources');
const ONLY = (get('--only') || '').split(',').filter(Boolean);
const ROWS = a.includes('--rows'), LINES = a.includes('--lines');
/** one log line (JSON-encoded) unless --lines */
const out = (label: string, v: unknown) => console.log(label + (LINES ? '\n' + (typeof v === 'string' ? v : JSON.stringify(v, null, 1)) : ' ' + JSON.stringify(v)));
const UA = 'Mozilla/5.0 (compatible; EdgeDesk-Simulator-SourceCheck/0.1; +https://github.com/dsrackler17/EdgeDeskSports)';
fs.mkdirSync(OUT, { recursive: true });

type Kind = 'rules' | 'discover' | 'rankings' | 'tables';
/** links: print matching hrefs · snippet: print raw HTML windows around a pattern (lists a text dump loses) ·
    nextData: print the long strings of an embedded __NEXT_DATA__ JSON that match (script-rendered articles) */
interface Source { id: string; kind: Kind; url: string; links?: RegExp; max?: number; snippet?: RegExp; nextData?: RegExp; render?: boolean; find?: RegExp }
const LINKS = /tie-?break|tiebreak|championship|eligib|playoff|protocol|selection|format|2026/i;

export const CFB_SOURCES: Source[] = [
  /* the College Football Playoff */
  { id: 'cfp_2026_format_release', kind: 'rules', url: 'https://collegefootballplayoff.com/news/2026/8/6/sc-aug-2627.aspx', links: LINKS },
  { id: 'cfp_12_team_format', kind: 'rules', url: 'https://collegefootballplayoff.com/sports/2024/5/29/12-team-format.aspx', links: LINKS },
  { id: 'cfp_selection_protocol', kind: 'rules', url: 'https://collegefootballplayoff.com/sports/2016/10/24/selection-committee-protocol.aspx', links: LINKS },
  { id: 'cfp_home', kind: 'discover', url: 'https://collegefootballplayoff.com/', links: LINKS },
  { id: 'ncaa_cfp_explainer_2026', kind: 'rules', url: 'https://www.ncaa.com/news/football/article/2026-08-11/how-college-football-playoff-works-schedule-selections-rankings-byes-and-more' },
  /* conference championship-game tiebreakers */
  { id: 'acc_2026_tiebreaker', kind: 'rules', url: 'https://theacc.com/news/2026/7/15/acc-announces-new-football-championship-tiebreaker-policy.aspx', links: LINKS },
  { id: 'sec_tiebreaker_2024', kind: 'rules', url: 'https://www.secsports.com/news/2024/08/sec-announces-football-tie-breaking-process', links: LINKS, nextData: /tie|scoring margin|head-to-head|common/i, render: true },
  /* secondary reports of procedures whose official page a script renders or refuses (labelled secondary in config.ts) */
  { id: 'sec_tiebreaker_espn_2024', kind: 'rules', url: 'https://www.espn.com/college-football/story/_/id/40944783/sec-reveals-tiebreaking-procedures-conference-title-game' },
  { id: 'sec_tiebreaker_cbs', kind: 'rules', url: 'https://www.cbssports.com/college-football/news/sec-football-tiebreakers-heres-how-the-conference-will-circumvent-identical-records-in-divisionless-format/' },
  { id: 'big_ten_tiebreaker_espn_2024', kind: 'rules', url: 'https://www.espn.com/college-football/story/_/id/41003007/big-ten-reveals-football-tiebreakers-18-team-conference' },
  { id: 'big_ten_tiebreaker_cbs', kind: 'rules', url: 'https://www.cbssports.com/college-football/news/big-ten-football-tiebreakers-how-conference-will-decide-championship-game-matchup-with-divisions-gone-away/' },
  { id: 'mw_tiebreaker_pfn', kind: 'rules', url: 'https://www.profootballnetwork.com/cfb/mountain-west-tiebreakers-everything-to-know/' },
  { id: 'big_ten_tiebreaker_2024_pdf', kind: 'rules', url: 'https://nextgen.bigten.org/api/media/file/f142aa7f-aa37-430b-bf09-8988a6952c0c-2024_Big_Ten_Football_Tiebreaker_-_FINAL_10__72_.pdf' },
  { id: 'big_ten_tiebreaker_2024_release', kind: 'rules', url: 'https://bigten.org/fb/article/blt6104802d94ebe1ab/', links: LINKS, nextData: /tie|seed|championship/i, render: true },
  { id: 'big_ten_tiebreakers_2025', kind: 'rules', url: 'https://bigten.org/fb/article/58967/', links: LINKS, nextData: /tie|seed|championship/i, render: true },
  { id: 'big_ten_fcg_2026_game', kind: 'rules', url: 'https://bigten.org/news/2026/9/24/2026-discover-big-ten-football-championship-game.aspx', links: LINKS, render: true },
  { id: 'big_ten_week7_release', kind: 'rules', url: 'https://bigten.org/news/2026/10/14/2026-week-7-football-release.aspx', links: LINKS, render: true },
  { id: 'big_ten_fcg_2026', kind: 'rules', url: 'https://bigten.org/news/2026/8/19/championship-2026-discover-big-ten-football-championship-game-information.aspx', links: LINKS, render: true },
  { id: 'big_ten_fcg', kind: 'rules', url: 'https://bigten.org/FCG', links: LINKS },
  { id: 'big12_tiebreaker_pdf', kind: 'rules', url: 'https://s3.amazonaws.com/big12sports.com/documents/2025/11/4/Big_12_Football_2024_Tiebreaker_Policy.pdf' },
  { id: 'aac_tiebreaker_2025', kind: 'rules', url: 'https://theamerican.org/news/2025/11/23/FOOTBALL_Tiebreaker.aspx', links: LINKS },
  { id: 'aac_tiebreaker_2025_pdf', kind: 'rules', url: 'https://theamerican.org/documents/2025/10/29/25_FB_Tiebreakers.pdf' },
  { id: 'aac_tiebreaker_2026_pdf', kind: 'rules', url: 'https://theamerican.org/documents/2026/9/30/26_FB_Tiebreakers.pdf' },
  { id: 'aac_weekly_release_wk8_pdf', kind: 'rules', url: 'https://theamerican.org/documents/2026/10/22/2026_release_week_8.pdf', find: /tie-?break|championship game|eligib/ },
  { id: 'mw_tiebreaker_2026_pdf', kind: 'rules', url: 'https://themw.com/documents/2026/10/12/MW_Football_Championship_Tiebreaking_Procedures.pdf' },
  { id: 'mw_weekly_release_wk8_pdf', kind: 'rules', url: 'https://themw.com/documents/2026/10/20/2026_MWFB_Weekly_Release_Week_8.pdf', find: /tie-?break|championship game|eligib/ },
  { id: 'mw_media_guide_2026_pdf', kind: 'rules', url: 'https://themw.com/documents/2026/8/18/2026_MW_Football_Media_Guide.pdf', find: /tie-?break|eligib/ },
  { id: 'big_ten_media_guide_2026_pdf', kind: 'rules', url: 'https://bigten.org/documents/2026/10/13/2026_B1G_FB_MG_0728.pdf', find: /tie-?break/ },
  { id: 'big_ten_week7_release_pdf', kind: 'rules', url: 'https://bigten.org/documents/2026/10/14//2026_FB_Week_7_Release.pdf?id=15302', find: /tie-?break|championship game/ },
  { id: 'mac_week8_release_pdf', kind: 'rules', url: 'https://getsomemaction.com/documents/2026/10/21//2026_FB_Release_Week_8.pdf', find: /tie-?break|championship game|eligib|Sacramento/ },
  { id: 'mac_week8_release_b_pdf', kind: 'rules', url: 'https://getsomemaction.com/documents/2026/10/21//2026_FB_Release_Week_Eight.pdf', find: /tie-?break|championship game|eligib|Sacramento/ },
  { id: 'sec_standings_2026', kind: 'rules', url: 'https://www.secsports.com/sport/football/standings', render: true, find: /tie-?break|championship/ },
  { id: 'aac_standings_2026', kind: 'discover', url: 'https://theamerican.org/standings.aspx?standings=133', links: LINKS, render: true },
  { id: 'aac_2026_pairings', kind: 'rules', url: 'https://theamerican.org/news/2025/10/14/american-announces-2026-football-schedule-pairings.aspx', links: LINKS },
  { id: 'cusa_tiebreaker_policy_pdf', kind: 'rules', url: 'https://conferenceusa.com/documents/2024/9/19/CUSA_FB_Championship_Game_Tiebreaker_Policy.pdf' },
  { id: 'pac12_2026_operations', kind: 'rules', url: 'https://pac-12.com/news/2026/9/3/pac-12-announces-commercial-and-operational-updates-ahead-of-its-2026-football-season-kickoff.aspx', links: LINKS, render: true },
  { id: 'mw_2026_ccg', kind: 'rules', url: 'https://themw.com/news/2026/6/4/broadcast-details-announced-for-2026-mountain-west-football-championship-game.aspx', links: LINKS, render: true },
  { id: 'mw_2026_schedule', kind: 'rules', url: 'https://themw.com/news/2026/6/4/mw-announces-2026-football-schedule.aspx', links: LINKS, render: true },
  { id: 'mw_weekly_release_wk8', kind: 'rules', url: 'https://themw.com/news/2026/10/20/2026-mw-football-weekly-release-week-8.aspx', links: LINKS, render: true },
  { id: 'mw_2022_divisional_tiebreakers_pdf', kind: 'rules', url: 'https://admin.themw.com/documents/2022/9/27/2022_MW_Football_Divisional_Tiebreakers.pdf' },
  { id: 'ndsu_fbs_faq', kind: 'rules', url: 'https://gobison.com/sports/2026/2/9/fbs-frequently-asked-questions', links: LINKS, render: true },
  { id: 'ndsu_bowl_eligible_release', kind: 'rules', url: 'https://gobison.com/news/2026/10/17/bison-bowl-eligible-after-beating-nevada-31-17', links: LINKS },
  { id: 'mac_sac_state_joins', kind: 'rules', url: 'https://getsomemaction.com/news/2026/2/16/sacramento-state-joins-mid-american-conference-as-football-only-member.aspx', links: LINKS },
  { id: 'mac_sac_state_official', kind: 'rules', url: 'https://getsomemaction.com/news/2026/6/29/sacramento-state-officially-joins-mac-as-football-affiliate-member.aspx', links: LINKS },
  { id: 'mac_2026_schedule', kind: 'rules', url: 'https://getsomemaction.com/news/2026/3/24/2026-mac-football-schedule-released.aspx', links: LINKS },
  { id: 'mac_week0_release_pdf', kind: 'rules', url: 'https://getsomemaction.com/documents/2026/8/27//2026_FB_Release_Week_Zero_8_27.pdf' },
  { id: 'mac_week8_preview', kind: 'discover', url: 'https://getsomemaction.com/news/2026/10/20/week-8-mac-football-preview.aspx', links: LINKS },
  { id: 'sac_state_mac_join', kind: 'rules', url: 'https://hornetsports.com/news/2026/2/16/hornet-football-to-join-the-mac-in-2026.aspx', links: LINKS },
  { id: 'sac_state_affiliation_faq', kind: 'rules', url: 'https://hornetsports.com/sports/2024/9/17/conference-affiliation-breakdown.aspx', links: LINKS },
  { id: 'sun_belt_tiebreakers', kind: 'rules', url: 'https://sunbeltsports.org/sports/2018/8/30/FB_Tie-Breakers.aspx', links: LINKS, snippet: /two divisions are/i },
  { id: 'mac_tiebreaker', kind: 'rules', url: 'https://getsomemaction.com/sports/2025/11/12/FB_1112255434.aspx', links: LINKS },
  { id: 'mac_sacramento_state', kind: 'rules', url: 'https://getsomemaction.com/news/2026/8/28/football-sacramento-state.aspx', links: LINKS },
  { id: 'pac12_2026_schedule', kind: 'rules', url: 'https://gobulldogs.com/news/2026/2/11/football-pac-12-announces-2026-football-schedule', links: LINKS },
  { id: 'cusa_2026_schedule', kind: 'rules', url: 'https://conferenceusa.com/news/2026/4/29/fb-cusa-releases-revised-2026-football-schedule.aspx', links: LINKS },
  { id: 'ndsu_eligibility_report', kind: 'rules', url: 'https://www.kfyrtv.com/2026/06/24/north-dakota-state-football-earns-immediate-postseason-eligibility/', links: LINKS },
  { id: 'ndsu_mw_title_vote_report', kind: 'rules', url: 'https://nevadasportsnet.com/news/reporters/north-dakota-state-footballs-ability-to-play-for-2026-mw-title-to-be-voted-on-this-week' },
  { id: 'ncaa_di_cabinet_2026_06_24', kind: 'rules', url: 'https://ncaa.org/news/2026/6/24/media-center-di-cabinet-remands-two-semester-mens-soccer-proposal-to-oversight-committee-for-further-review.aspx' },
  { id: 'sac_state_mac_ap_report', kind: 'rules', url: 'https://wtop.com/ncaa-football/2026/02/sacramento-state-mens-football-to-join-fbs-mid-american-conference-in-july/' },
  { id: 'cfp_bracket_2026_27_pdf', kind: 'rules', url: 'https://collegefootballplayoff.com/documents/2026/7/14/2027_StandardizedBracket_2_R1.pdf' },
  { id: 'cfp_rankings_history', kind: 'tables', url: 'https://collegefootballplayoff.com/sports/2026/8/9/rankings-history.aspx', links: /rank|history|20\d\d/i },
  { id: 'cfp_rankings_week_by_week', kind: 'tables', url: 'https://collegefootballplayoff.com/sports/2026/8/9/wk-x-wk-rankings.aspx', links: /rank|week|20\d\d/i },
  /* where the 2026 documents live when the URL is not known yet */
  { id: 'mw_football', kind: 'discover', url: 'https://themw.com/sports/football', links: LINKS, render: true },
  { id: 'cusa_football', kind: 'discover', url: 'https://conferenceusa.com/sports/football', links: LINKS },
  { id: 'aac_football', kind: 'discover', url: 'https://theamerican.org/sports/football', links: LINKS, render: true },
  { id: 'sun_belt_football', kind: 'discover', url: 'https://sunbeltsports.org/sports/football', links: LINKS },
  { id: 'mac_football', kind: 'discover', url: 'https://getsomemaction.com/sports/football', links: LINKS },
  /* historical committee rankings (Wikipedia, CC BY-SA): the CFP table only */
  ...Array.from({ length: 12 }, (_, i): Source => {
    const y = 2014 + i;
    return { id: 'wiki_rankings_' + y, kind: 'rankings', url: 'https://en.wikipedia.org/wiki/' + y + '_NCAA_Division_I_FBS_football_rankings' };
  })
];

/** page text: scripts and styles dropped, block ends as newlines, entities decoded */
export function htmlText(html: string): string {
  const ent: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
  return decode(html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/div|\/tr|\/section|\/article|\/ol|\/ul|\/table)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' '), ent)
    .replace(/[ \t\f\r\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function decode(s: string, ent: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' }): string {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ent[n.toLowerCase()] ?? m);
}

/** a table as rows of cell texts, with rowspan/colspan expanded */
export function tableRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  const spans: Array<{ left: number; text: string } | undefined> = [];
  for (const tr of tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const out: string[] = [];
    let col = 0;
    const cells = tr.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi) || [];
    const take = () => { while (spans[col] && spans[col]!.left > 0) { out.push(spans[col]!.text); spans[col]!.left--; col++; } };
    for (const c of cells) {
      take();
      const open = c.match(/^<t[hd]\b([^>]*)>/i)![1];
      const rs = Number((open.match(/rowspan="?(\d+)/i) || [])[1] || 1), cs = Number((open.match(/colspan="?(\d+)/i) || [])[1] || 1);
      const text = decode(c.replace(/<sup\b[\s\S]*?<\/sup>/gi, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      for (let k = 0; k < cs; k++) { out.push(text); if (rs > 1) spans[col] = { left: rs - 1, text }; col++; }
    }
    take();
    rows.push(out);
  }
  return rows;
}

/** Wikipedia's season rankings page: the table under the heading that names the CFP */
export function cfpTables(html: string): Array<{ heading: string; rows: string[][] }> {
  const out: Array<{ heading: string; rows: string[][] }> = [];
  const re = /<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/gi;
  const heads: Array<{ at: number; text: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) heads.push({ at: m.index, text: decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() });
  heads.forEach((h, i) => {
    if (!/CFP|College Football Playoff/i.test(h.text)) return;
    const end = i + 1 < heads.length ? heads[i + 1].at : html.length;
    const seg = html.slice(h.at, end);
    for (const t of seg.match(/<table\b[\s\S]*?<\/table>/gi) || []) out.push({ heading: h.text, rows: tableRows(t) });
  });
  return out;
}

function section(title: string) { console.log('\n' + '='.repeat(100) + '\n== ' + title + '\n' + '='.repeat(100)); }
const SUMMARY: string[] = [];

/** the page's DOM after its scripts ran (headless Chrome), or null with the reason printed */
export function renderDom(url: string): string | null {
  const bins = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter((b): b is string => !!b);
  let why = 'no Chrome binary';
  for (const b of bins) {
    try {
      return execFileSync(b, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--virtual-time-budget=20000', '--dump-dom', url],
        { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 90000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { why = b + ': ' + String((e as Error).message).slice(0, 160); }
  }
  console.log('-- render failed (' + why + ')');
  return null;
}

/** text of a PDF: its text layer, else OCR of each page at 300 dpi (labelled), else null */
function pdfText(file: string): { text: string; via: string } | null {
  let text = '';
  try { text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 32 << 20 }); }
  catch (e) { console.log('pdftotext unavailable or failed: ' + String((e as Error).message).slice(0, 200)); return null; }
  if (text.replace(/\s/g, '').length >= 200) return { text, via: 'pdftotext' };
  const dir = fs.mkdtempSync(file + '.ocr-');
  try {
    execFileSync('pdftoppm', ['-r', '300', '-png', file, path.join(dir, 'p')]);
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    const ocr = pages.map((f) => execFileSync('tesseract', [path.join(dir, f), '-', '--psm', '6'], { encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] })).join('\n\f\n');
    return { text: '[OCR of ' + pages.length + ' page image(s): the PDF has no text layer]\n' + ocr, via: 'ocr' };
  } catch (e) { console.log('no text layer and OCR unavailable or failed: ' + String((e as Error).message).slice(0, 200)); return null; }
}

async function fetchSource(s: Source) {
  section('SOURCE ' + s.id + ' [' + s.kind + ']  ' + s.url);
  let res: Response;
  try { res = await fetch(s.url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(45000) }); }
  catch (e) { const msg = String((e as Error).message || e); console.log('FETCH FAILED: ' + msg); SUMMARY.push(s.id + ': FETCH FAILED ' + msg); return; }
  let body = Buffer.from(await res.arrayBuffer());
  let head = 'status ' + res.status + ' · final url ' + res.url + ' · ' + body.length + ' bytes · sha256 ' + sha256Hex(body) + ' · fetched_at ' + new Date().toISOString();
  console.log(head);
  const isPdf = /\.pdf($|\?)/i.test(res.url) || (res.headers.get('content-type') || '').includes('pdf');
  /* a league site's /documents/ URL can answer with a viewer page that embeds the file: read the file it names */
  if (isPdf && body.subarray(0, 5).toString('latin1') !== '%PDF-') {
    const m = body.toString('utf8').match(/(?:href|src|data)=["']([^"']+?\.pdf(?:\?[^"']*)?)["']/i);
    const inner = m ? new URL(m[1].replace(/&amp;/g, '&'), res.url).href : null;
    if (inner && inner !== res.url) {
      try {
        const r2 = await fetch(inner, { headers: { 'user-agent': UA, accept: 'application/pdf,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
        const b2 = Buffer.from(await r2.arrayBuffer());
        head += ' · the page wraps ' + r2.url + ': status ' + r2.status + ' · ' + b2.length + ' bytes · sha256 ' + sha256Hex(b2);
        console.log('-- the URL answered with a page that embeds the document; read ' + r2.url + ' (status ' + r2.status + ', sha256 ' + sha256Hex(b2) + ')');
        if (b2.subarray(0, 5).toString('latin1') === '%PDF-') body = b2;
      } catch (e) { console.log('-- embedded document fetch failed: ' + String((e as Error).message).slice(0, 160)); }
    } else console.log('-- not a PDF and no embedded .pdf link (first bytes ' + JSON.stringify(body.subarray(0, 60).toString('latin1')) + ')');
  }
  fs.writeFileSync(path.join(OUT, s.id + (isPdf ? '.pdf' : '.html')), body);
  if (s.kind === 'rankings') {
    const tabs = cfpTables(body.toString('utf8'));
    console.log('-- CFP tables: ' + tabs.length);
    tabs.forEach((t, i) => {
      console.log('-- table ' + i + ' under "' + t.heading + '" (' + t.rows.length + ' rows)');
      if (ROWS) out('-- rows', t.rows);
    });
    const tsv = tabs.map((t, i) => t.rows.map((r) => [i, ...r].join('\t')).join('\n')).join('\n');
    fs.writeFileSync(path.join(OUT, s.id + '.tsv'), tsv);
    SUMMARY.push(s.id + ': ' + head + ' · ' + tabs.length + ' CFP tables · tsv sha256 ' + sha256Hex(tsv));
    return;
  }
  let text: string, rendered = '';
  let html = isPdf ? '' : body.toString('utf8');
  if (isPdf) {
    const t = pdfText(path.join(OUT, s.id + '.pdf'));
    if (!t) { SUMMARY.push(s.id + ': ' + head + ' · PDF not converted'); return; }
    text = t.text;
    if (t.via === 'ocr') rendered = ' · read by OCR';
  } else {
    if (s.render) {
      const dom = renderDom(s.url);
      if (dom) {
        html = dom;
        rendered = ' · rendered DOM ' + Buffer.byteLength(dom) + ' bytes, sha256 ' + sha256Hex(dom);
        fs.writeFileSync(path.join(OUT, s.id + '.rendered.html'), dom);
        console.log('-- read from the rendered DOM (headless Chrome)' + rendered);
      }
    }
    text = htmlText(html);
  }
  if (!isPdf && s.links) {
    const links = [...new Set([...html.matchAll(/href=["']([^"'#]+)["'][^>]*>([\s\S]{0,600}?)<\/a>/gi)]
      .map((m) => [m[1], decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()])
      .filter(([h, t]) => s.links!.test(h) || s.links!.test(t) || /\/documents\/|\.pdf(\?|$)/i.test(h)).map(([h, t]) => h + '  «' + t.slice(0, 90) + '»'))].slice(0, 150);
    out('-- links matching ' + s.links + ' or naming a document (' + links.length + '):', links);
  }
  if (!isPdf && s.snippet) {
    const re = new RegExp(s.snippet.source, 'gi');
    let m: RegExpExecArray | null, k = 0;
    while ((m = re.exec(html)) && k++ < 3) out('-- raw html around ' + s.snippet + ':', html.slice(m.index, m.index + 2500));
  }
  if (!isPdf && s.nextData) {
    const nd = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    const found: string[] = [];
    const walk = (v: unknown) => { if (typeof v === 'string') { if (v.length > 150 && s.nextData!.test(v)) found.push(v); } else if (v && typeof v === 'object') for (const x of Object.values(v as object)) walk(x); };
    if (nd) { try { walk(JSON.parse(nd[1])); } catch (e) { console.log('__NEXT_DATA__ unparsable: ' + String((e as Error).message).slice(0, 120)); } }
    /* other frameworks inline the article as a JSON string in a script */
    for (const sc of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || []) if (s.nextData.test(sc) && /tie-?break/i.test(sc) && !/__NEXT_DATA__/.test(sc)) found.push(sc.slice(0, 30000));
    console.log('-- embedded article strings (' + found.length + '):');
    for (const f of [...new Set(found)].slice(0, 12)) out('>>>', htmlText(f.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\n/g, '\n').replace(/\\"/g, '"')).slice(0, 20000));
  }
  if (s.kind === 'tables') {
    const tabs = (html.match(/<table\b[\s\S]*?<\/table>/gi) || []).map(tableRows);
    console.log('-- tables: ' + tabs.length);
    tabs.forEach((t, i) => out('-- table ' + i + ' (' + t.length + ' rows, first 40):', t.slice(0, 40)));
  }
  fs.writeFileSync(path.join(OUT, s.id + '.txt'), text);
  SUMMARY.push(s.id + ': ' + head + rendered + ' · text ' + text.length + ' chars, sha256 ' + sha256Hex(text));
  if (s.kind === 'discover') return;
  if (s.find) {
    /* a long document (a media guide, a weekly release): the passages around each match, merged */
    const spans: Array<[number, number]> = [];
    for (const m of text.matchAll(new RegExp(s.find.source, 'gi'))) {
      const a = Math.max(0, m.index! - 1500), b = Math.min(text.length, m.index! + 3500), last = spans[spans.length - 1];
      if (last && a <= last[1]) last[1] = b; else spans.push([a, b]);
    }
    out('-- passages matching ' + s.find + ' (' + spans.length + ', text ' + text.length + ' chars, sha256 ' + sha256Hex(text) + '):', spans.slice(0, 15).map(([a, b]) => '[' + a + '..' + b + '] ' + text.slice(a, b)));
    return;
  }
  out('-- text (' + text.length + ' chars, sha256 ' + sha256Hex(text) + '):', text.slice(0, s.max || 40000));
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('cli', 'fetch_cfb_sources.ts'));
if (isMain) {
  for (const s of CFB_SOURCES) if (!ONLY.length || ONLY.includes(s.id)) await fetchSource(s);
  section('SUMMARY');
  console.log(SUMMARY.join('\n') + '\nwritten to ' + OUT);
}
