/* ===========================================================================
   THE TITLE BOUTS THE SERVED UFC ELO'S CHAMPION TERM READS
   (model_loop/data/ufc/title_bouts.csv; model_loop/adapters/ufc/model.py
   champ_bonus).

   Why: since 2014 the defending champion won 123 of 187 undisputed title
   fights where the served Elo expected 106 (UFC_SIMULATOR_NOTES.md: +16.2
   in 2014-2020, +0.8 since). The loop can only test a champion term if it knows, for each bout, who the
   champion going in was. Whether a bout is a title fight, and who holds the
   belt, is known when the bout is booked, so the flag is point in time.

   Rows:
     past       every undisputed title fight with a champion going in
                (Wikipedia's List of UFC champions, parsed by
                simulator/src/sports/ufc/title_history.ts; vacant and interim
                titles excluded), matched to its bout in bouts.csv: the same
                day +-1 with both fighters (token match, then surnames)
                among bouts.csv and the simulator's ESPN feed
                (simulator/data/feeds/ufc_bouts.json.gz) for bouts the CSV
                does not have yet
     scheduled  a bout not yet final in which a current champion
                (ufc.com/rankings, simulator/data/feeds/ufc_rankings.json)
                fights at their division's weight class: a booked title
                defence, priced with the term before it happens
   Columns: bout_id, champion_id, champion, division, date, source.
   Unmatched title fights are printed and counted, never guessed.

     node simulator/src/research/ufc_title_bouts.ts [--check]
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO, BOUTS_CSV, TITLE_BOUTS_CSV, parseBoutsCsv, FINAL, type Bout } from '../sports/ufc/elo.ts';
import { parseTitleHistory } from '../sports/ufc/title_history.ts';
import { normName, tokenKey, feedToBout, type FeedBout } from '../sports/ufc/inputs.ts';

const WIKI = 'simulator/data/feeds/ufc_champions_wikipedia.html.gz';
const RANKINGS = 'simulator/data/feeds/ufc_rankings.json';
const FEED = 'simulator/data/feeds/ufc_bouts.json.gz';
const DAY = 86400000;

export interface TitleBout { bout_id: string; champion_id: string; champion: string; division: string; date: string; source: 'wikipedia' | 'ufc.com rankings (scheduled)' }

const gunzip = (rel: string) => zlib.gunzipSync(fs.readFileSync(path.join(REPO, rel))).toString('utf8');
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const sur = (s: string) => { const t = normName(s).split(' '); return t[t.length - 1]; };

export function titleBouts(bouts: Bout[], wikiHtml: string, rankings: any): { rows: TitleBout[]; unmatched: string[]; scheduled_unmatched: string[] } {
  const byDay = new Map<string, Bout[]>();
  for (const b of bouts) { const d = isoDay(b.ts); (byDay.get(d) || byDay.set(d, []).get(d)!).push(b); }
  const rows: TitleBout[] = [], unmatched: string[] = [];
  for (const h of parseTitleHistory(wikiHtml)) for (const f of h.fights) {
    if (f.interim || f.champion == null) continue;
    const t = Date.parse(f.date + 'T00:00:00Z');
    const cand: Bout[] = [];
    for (const k of [-1, 0, 1]) cand.push(...(byDay.get(isoDay(t + k * DAY)) || []));
    const kc = tokenKey(f.champion), kh = tokenKey(f.challenger);
    let hit = cand.find((b) => { const s = new Set([tokenKey(b.fighter_a), tokenKey(b.fighter_b)]); return s.has(kc) && s.has(kh); });
    if (!hit) hit = cand.find((b) => { const s = [sur(b.fighter_a), sur(b.fighter_b)]; return s.includes(sur(f.champion as string)) && s.includes(sur(f.challenger)); });
    if (!hit) { if (t >= Date.parse('2014-01-01T00:00:00Z')) unmatched.push(f.division + ' ' + f.date + ' ' + f.champion + ' v ' + f.challenger); continue; }
    const champIsA = tokenKey(hit.fighter_a) === kc || (tokenKey(hit.fighter_b) !== kc && sur(hit.fighter_a) === sur(f.champion));
    rows.push({ bout_id: hit.bout_id, champion_id: champIsA ? hit.fighter_a_id : hit.fighter_b_id, champion: champIsA ? hit.fighter_a : hit.fighter_b, division: f.division, date: f.date, source: 'wikipedia' });
  }
  /* booked defences: the current champion at their own weight, in a bout not yet final */
  const seen = new Set(rows.map((r) => r.bout_id)), scheduledUnmatched: string[] = [];
  const divisions = new Map<string, string>();
  for (const d of (rankings && rankings.divisions) || []) if (d.champion && d.champion.name && !/pound/i.test(d.division)) divisions.set(espnDivision(d.division), d.champion.name);
  for (const [division, name] of divisions) {
    const k = tokenKey(name);
    const booked = bouts.filter((b) => b.status !== FINAL && b.status !== 'STATUS_CANCELED' && b.status !== 'STATUS_CANCELLED' && b.weight_class === division && (tokenKey(b.fighter_a) === k || tokenKey(b.fighter_b) === k));
    for (const b of booked) {
      if (seen.has(b.bout_id)) continue;
      const isA = tokenKey(b.fighter_a) === k;
      rows.push({ bout_id: b.bout_id, champion_id: isA ? b.fighter_a_id : b.fighter_b_id, champion: isA ? b.fighter_a : b.fighter_b, division, date: isoDay(b.ts), source: 'ufc.com rankings (scheduled)' });
    }
    if (!bouts.some((b) => tokenKey(b.fighter_a) === k || tokenKey(b.fighter_b) === k)) scheduledUnmatched.push(division + ': ' + name + ' (no bout in the data under this name)');
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.bout_id.localeCompare(b.bout_id));
  return { rows, unmatched, scheduled_unmatched: scheduledUnmatched };
}
/** bouts.csv plus the feed's bouts it does not have yet (the simulator's union, inputs.ts) */
export function withFeed(bouts: Bout[], feed: { bouts: FeedBout[] } | null): Bout[] {
  const have = new Set(bouts.map((b) => b.bout_id));
  const extra = ((feed && feed.bouts) || []).filter((f) => !have.has(String(f.bout_id))).map(feedToBout).filter((b) => Number.isFinite(b.ts));
  return bouts.concat(extra);
}
/** ufc.com's division names -> the feed's weight classes ("Women's Strawweight" -> "W Strawweight") */
export function espnDivision(s: string): string { return s.replace(/^Women's\s+/, 'W ').trim(); }

export function toCsv(rows: TitleBout[]): string {
  const q = (v: string) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  return ['bout_id,champion_id,champion,division,date,source'].concat(rows.map((r) => [r.bout_id, r.champion_id, r.champion, r.division, r.date, r.source].map(q).join(','))).join('\n') + '\n';
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const feed = fs.existsSync(path.join(REPO, FEED)) ? JSON.parse(gunzip(FEED)) : null;
  const bouts = withFeed(parseBoutsCsv(fs.readFileSync(path.join(REPO, BOUTS_CSV), 'utf8')), feed);
  const wiki = gunzip(WIKI);
  const rankings = JSON.parse(fs.readFileSync(path.join(REPO, RANKINGS), 'utf8'));
  const r = titleBouts(bouts, wiki, rankings);
  const text = toCsv(r.rows), file = path.join(REPO, TITLE_BOUTS_CSV);
  const past = r.rows.filter((x) => x.source === 'wikipedia').length;
  console.log('title bouts: ' + r.rows.length + ' (' + past + ' past from Wikipedia, ' + (r.rows.length - past) + ' booked defences); unmatched since 2014: ' + r.unmatched.length + (r.unmatched.length ? ' (' + r.unmatched.join('; ') + ')' : '')
    + (r.scheduled_unmatched.length ? '; champions not in the data: ' + r.scheduled_unmatched.join('; ') : ''));
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur !== text) { console.error(TITLE_BOUTS_CSV + ' is stale: run node simulator/src/research/ufc_title_bouts.ts'); process.exit(1); }
    console.log(TITLE_BOUTS_CSV + ' is current');
  } else fs.writeFileSync(file, text);
}
