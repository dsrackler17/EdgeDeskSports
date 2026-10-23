/* ===========================================================================
   SIMULATED PROBABILITIES AGAINST KALSHI FUTURES — two comparisons, kept apart.

   A. REFERENCE. The YES mid of a two-sided quote whose spread is at most
      thresholds.max_reference_spread (the kalshi_rule 0.06), as an implied
      probability. Optionally normalised — ONLY across an outcome set the
      config declares mutually exclusive and exhaustive, with every member
      quoted, fresh, two-sided and captured within max_normalization_skew of
      each other; proportional normalisation is labelled an assumption, never
      "fair value". reference edge = research p - reference p (points).

   B. EXECUTABLE. Buying YES at the ASK (never the mid), at a stated quantity
      the ask size covers, plus the fee per contract when the fee schedule is
      verified. executable edge = research p - executable cost (points);
      expected net return per contract = research p - cost (dollars per $1
      contract), only when the fee is verified.

   A market is compared only through a person-verified mapping to one exact
   simulated outcome of the same sport, competition and season, whose
   settlement-rules hash still matches the market's. Everything else is
   excluded with its reason. An actionable flag needs every condition:
   eligible mapping, fresh quote, executable price at the quantity, verified
   fees, an executable edge over the threshold and over k Monte Carlo SEs.
   =========================================================================== */
export interface Quote {
  market_ticker: string; event_ticker?: string | null; series_ticker?: string | null;
  captured_at: string; status: string | null;
  yes_bid: number | null; yes_ask: number | null; no_bid?: number | null; no_ask?: number | null;
  yes_ask_size: number | null; yes_bid_size?: number | null; last_price?: number | null;
  close_time: string | null; rules_sha256: string | null; host?: string | null;
}
export interface Mapping {
  mapping_id: string; status: 'verified' | 'excluded';
  sport: string; competition: string; season: string;
  series_ticker: string; event_ticker: string; market_ticker: string;
  entity_id: string; outcome: string; outcome_set?: string | null;
  /** semantic: what the market settles on, in the run's own vocabulary (results.outcome_semantics); required
      when the run declares semantics, and it must be the mapped outcome's (no two outcomes share one) */
  settlement: { basis: string; rules_sha256: string; rules_excerpt?: string; semantic?: string };
  verified_by: string | null; verified_at: string | null; exclusion_reason?: string;
}
export interface OutcomeSet { id: string; outcome: string; entities: string[]; mutually_exclusive: boolean; exhaustive: boolean; note?: string }
export interface FuturesConfig {
  schema: string; mapping_version: string;
  thresholds: { max_quote_age_minutes: number; max_reference_spread: number; max_normalization_skew_minutes: number; exec_quantity: number; min_exec_edge_pp: number; min_edge_mcse_multiple: number };
  fees: { verified: boolean; kind: string; formula: string; rate: number; source: string; verified_by: string | null; verified_at: string | null };
  outcome_sets: OutcomeSet[];
  mappings: Mapping[];
}
export interface RunView { sport: string; competition: string; season: string; entities: Array<{ entity_id: string; outcomes: Record<string, { probability: number; mcse: number }> }>;
  /** outcome key -> what it settles on (e.g. regular-season conference first place vs the conference playoff title) */
  outcome_semantics?: Record<string, string> }

/** structural validation of the config against a run: wrong season, entity or outcome is rejected */
export function validateFuturesConfig(cfg: FuturesConfig, run: RunView): string[] {
  const errs: string[] = [];
  if (cfg.schema !== 'edgedesk_sim_kalshi_futures_v1') errs.push('wrong schema ' + cfg.schema);
  const t = cfg.thresholds;
  if (!(t.max_quote_age_minutes > 0 && t.max_reference_spread > 0 && t.max_reference_spread < 1 && t.exec_quantity >= 1 && t.min_exec_edge_pp >= 0 && t.min_edge_mcse_multiple >= 0)) errs.push('thresholds out of range');
  if (cfg.fees.verified && (!cfg.fees.verified_by || !cfg.fees.verified_at || !/^https:\/\//.test(cfg.fees.source))) errs.push('a verified fee schedule needs verified_by, verified_at and an https source');
  if (!(cfg.fees.rate >= 0 && cfg.fees.rate < 1)) errs.push('fee rate out of range');
  const ents = new Set(run.entities.map((e) => e.entity_id));
  const outs = new Set(run.entities.length ? Object.keys(run.entities[0].outcomes) : []);
  const seen = new Set<string>(), sets = new Map(cfg.outcome_sets.map((s) => [s.id, s]));
  const sem = run.outcome_semantics || null;
  if (sem) {
    const byS = new Map<string, string>();
    for (const [o, x] of Object.entries(sem)) { const prev = byS.get(x); if (prev) errs.push('outcomes ' + prev + ' and ' + o + ' declare the same settlement semantic ' + x); byS.set(x, o); }
  }
  for (const s of cfg.outcome_sets) {
    if (!outs.has(s.outcome)) errs.push('outcome set ' + s.id + ': unknown outcome ' + s.outcome);
    for (const e of s.entities) if (!ents.has(e)) errs.push('outcome set ' + s.id + ': unknown entity ' + e);
  }
  for (const m of cfg.mappings) {
    const id = m.mapping_id || '(no id)';
    if (seen.has(m.market_ticker)) errs.push(id + ': market ' + m.market_ticker + ' mapped twice');
    seen.add(m.market_ticker);
    if (m.status === 'excluded') { if (!m.exclusion_reason) errs.push(id + ': an excluded mapping needs its reason'); continue; }
    if (m.status !== 'verified') errs.push(id + ': status must be verified or excluded');
    if (m.sport !== run.sport || m.competition !== run.competition || m.season !== run.season) errs.push(id + ': maps ' + m.sport + '/' + m.competition + '/' + m.season + ', the run is ' + run.sport + '/' + run.competition + '/' + run.season);
    if (!ents.has(m.entity_id)) errs.push(id + ': unknown entity ' + m.entity_id);
    if (!outs.has(m.outcome)) errs.push(id + ': unknown outcome ' + m.outcome + ' (a regular-season title is not a playoff title: map only an outcome the simulator defines)');
    if (!m.settlement || !m.settlement.basis || !/^[0-9a-f]{64}$/.test(m.settlement.rules_sha256 || '')) errs.push(id + ': settlement basis and the rules text sha256 are required');
    if (sem && m.settlement && sem[m.outcome] && m.settlement.semantic !== sem[m.outcome]) errs.push(id + ': the market settles on ' + (m.settlement.semantic || '(no semantic declared)') + ', outcome ' + m.outcome + ' is ' + sem[m.outcome] + ' — a different futures market');
    if (!m.verified_by || !m.verified_at || !/^\d{4}-\d{2}-\d{2}/.test(m.verified_at)) errs.push(id + ': verified_by and verified_at are required');
    if (m.outcome_set) { const s = sets.get(m.outcome_set); if (!s) errs.push(id + ': unknown outcome set ' + m.outcome_set); else if (s.outcome !== m.outcome || s.entities.indexOf(m.entity_id) < 0) errs.push(id + ': not a member of outcome set ' + m.outcome_set); }
  }
  return errs;
}

export function feePerContract(price: number, contracts: number, rate: number): number {
  if (!(price > 0 && price < 1) || !(contracts >= 1)) throw new Error('feePerContract: bad price or quantity');
  /* ceil to the cent, in integer cents to avoid binary rounding */
  const cents = Math.ceil(Math.round(rate * contracts * price * (1 - price) * 1e8) / 1e6 - 1e-9);
  return cents / 100 / contracts;
}

export interface EdgeRow {
  market_ticker: string; event_ticker: string; series_ticker: string; mapping_id: string; entity_id: string; outcome: string; settlement_basis: string;
  quote_at: string; quote_age_minutes: number; yes_bid: number | null; yes_ask: number | null; yes_ask_size: number | null;
  reference_basis: 'yes_mid' | null; reference_prob: number | null; normalization: 'none' | 'proportional_complete_set'; normalized_ref_prob: number | null; normalization_note: string;
  research_prob: number; research_mcse: number; research_fair_decimal: number | null; reference_edge_pp: number | null;
  exec_quantity: number | null; exec_price: number | null; fee_per_contract: number | null; fee_basis: string; fee_verified: boolean;
  exec_cost_prob: number | null; exec_edge_pp: number | null; expected_net_return: number | null;
  stale: boolean; eligible: boolean; actionable: boolean; block_reasons: string[]; provenance: Record<string, string>;
}
export interface Comparison { status: 'compared' | 'unavailable'; rows: EdgeRow[]; excluded: Array<{ mapping_id: string; market_ticker: string; reason: string }>; methodology: Record<string, unknown>; note: string }

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function compareFutures(cfg: FuturesConfig, run: RunView, quotes: Map<string, Quote>, now: Date): Comparison {
  const errs = validateFuturesConfig(cfg, run);
  if (errs.length) throw new Error('the futures mapping is invalid: ' + errs.join('; '));
  const T = cfg.thresholds;
  const methodology = {
    reference: 'YES mid of a two-sided quote with spread <= ' + T.max_reference_spread + '; never an executable price',
    normalization: 'proportional, only across a declared mutually exclusive and exhaustive set with every member fresh, two-sided and captured within ' + T.max_normalization_skew_minutes + ' minutes — an assumption, not fair value',
    executable: 'buy YES at the ask for ' + T.exec_quantity + ' contracts, ask size permitting, plus the per-contract fee when the schedule is verified',
    fees: cfg.fees, thresholds: T, mapping_version: cfg.mapping_version,
    research: 'simulated probability = count / N with its Monte Carlo SE; fair decimal odds 1/p'
  };
  const live = cfg.mappings.filter((m) => m.status === 'verified');
  if (!live.length) return { status: 'unavailable', rows: [], excluded: cfg.mappings.filter((m) => m.status === 'excluded').map((m) => ({ mapping_id: m.mapping_id, market_ticker: m.market_ticker, reason: m.exclusion_reason || 'excluded' })), methodology,
    note: 'No verified Kalshi mapping exists for ' + run.sport + ' ' + run.season + ': market comparison is unavailable (not zero).' };
  const ent = new Map(run.entities.map((e) => [e.entity_id, e]));
  const excluded: Comparison['excluded'] = [];
  const ageMin = (q: Quote) => (now.getTime() - Date.parse(q.captured_at)) / 60000;
  const twoSided = (q: Quote) => q.yes_bid != null && q.yes_ask != null && q.yes_bid > 0 && q.yes_ask < 1 && q.yes_ask >= q.yes_bid;
  const usableRef = (q: Quote) => twoSided(q) && (q.yes_ask as number) - (q.yes_bid as number) <= T.max_reference_spread + 1e-12;
  /* normalisation sets that qualify */
  const normOk = new Map<string, { sum: number; note: string }>();
  for (const s of cfg.outcome_sets) {
    const members = live.filter((m) => m.outcome_set === s.id);
    let note = '';
    if (!s.mutually_exclusive || !s.exhaustive) note = 'set ' + s.id + ' is not declared mutually exclusive and exhaustive';
    else if (members.length !== s.entities.length) note = 'set ' + s.id + ' is incomplete: ' + members.length + ' of ' + s.entities.length + ' outcomes are mapped';
    else {
      const qs = members.map((m) => quotes.get(m.market_ticker));
      if (qs.some((q) => !q)) note = 'set ' + s.id + ': a member has no quote';
      else if (qs.some((q) => ageMin(q as Quote) > T.max_quote_age_minutes)) note = 'set ' + s.id + ': a member quote is stale';
      else if (qs.some((q) => !usableRef(q as Quote))) note = 'set ' + s.id + ': a member has no usable two-sided quote';
      else {
        const ts = qs.map((q) => Date.parse((q as Quote).captured_at));
        if ((Math.max(...ts) - Math.min(...ts)) / 60000 > T.max_normalization_skew_minutes) note = 'set ' + s.id + ': member quotes are more than ' + T.max_normalization_skew_minutes + ' minutes apart';
        else normOk.set(s.id, { sum: qs.reduce((a, q) => a + ((q as Quote).yes_bid as number + ((q as Quote).yes_ask as number)) / 2, 0), note: 'proportional normalisation across the complete set ' + s.id + ' (an assumption: it spreads the overround evenly, it is not fair value)' });
      }
    }
    if (note) normOk.set(s.id + '#no', { sum: NaN, note });
  }
  const rows: EdgeRow[] = [];
  for (const m of live) {
    const q = quotes.get(m.market_ticker);
    const e = ent.get(m.entity_id), o = e && e.outcomes[m.outcome];
    if (!o) { excluded.push({ mapping_id: m.mapping_id, market_ticker: m.market_ticker, reason: 'the run has no ' + m.outcome + ' for ' + m.entity_id }); continue; }
    if (!q) { excluded.push({ mapping_id: m.mapping_id, market_ticker: m.market_ticker, reason: 'no quote was captured for this market' }); continue; }
    if (q.rules_sha256 && q.rules_sha256 !== m.settlement.rules_sha256) { excluded.push({ mapping_id: m.mapping_id, market_ticker: m.market_ticker, reason: 'the market\'s settlement rules changed since the mapping was verified' }); continue; }
    const block: string[] = [];
    const age = ageMin(q), stale = age > T.max_quote_age_minutes;
    if (stale) block.push('quote is ' + Math.round(age) + ' minutes old (limit ' + T.max_quote_age_minutes + ')');
    const open = q.status == null || /^(open|active)$/i.test(q.status);
    const closed = q.close_time != null && Date.parse(q.close_time) <= now.getTime();
    if (!open || closed) block.push('market is ' + (closed ? 'closed' : q.status));
    if (!q.rules_sha256) block.push('the market\'s rules text was not captured, so the settlement match is unconfirmed');
    const eligible = open && !closed && !!q.rules_sha256;
    /* A. reference */
    let refProb: number | null = null, refBasis: 'yes_mid' | null = null;
    if (usableRef(q)) { refProb = r6(((q.yes_bid as number) + (q.yes_ask as number)) / 2); refBasis = 'yes_mid'; }
    else block.push(twoSided(q) ? 'reference unavailable: spread ' + r6((q.yes_ask as number) - (q.yes_bid as number)) + ' > ' + T.max_reference_spread : 'reference unavailable: one-sided book');
    let normalization: EdgeRow['normalization'] = 'none', normProb: number | null = null, normNote = 'not normalised: this market is not part of a declared complete outcome set';
    if (m.outcome_set) {
      const ok = normOk.get(m.outcome_set);
      if (ok && refProb != null) { normalization = 'proportional_complete_set'; normProb = r6(refProb / ok.sum); normNote = ok.note; }
      else normNote = 'not normalised: ' + ((normOk.get(m.outcome_set + '#no') || { note: 'the set does not qualify' }).note);
    }
    /* B. executable */
    const Q = T.exec_quantity;
    let execPrice: number | null = null, fee: number | null = null, cost: number | null = null, execEdge: number | null = null, ret: number | null = null;
    if (!(q.yes_ask != null && q.yes_ask > 0 && q.yes_ask < 1)) block.push('no executable YES ask');
    else if (q.yes_ask_size == null) block.push('ask depth unknown: the quantity cannot be confirmed');
    else if (q.yes_ask_size < Q) block.push('ask size ' + q.yes_ask_size + ' is below the stated quantity ' + Q);
    else {
      execPrice = q.yes_ask;
      if (cfg.fees.verified) { fee = r6(feePerContract(execPrice, Q, cfg.fees.rate)); cost = r6(execPrice + fee); ret = r6(o.probability - cost); }
      else { cost = execPrice; block.push('fee schedule unverified: the executable cost is pre-fee'); }
      execEdge = Math.round((o.probability - cost) * 1e6) / 1e4;
      if (execEdge < T.min_exec_edge_pp) block.push('executable edge ' + execEdge.toFixed(2) + ' pts is below ' + T.min_exec_edge_pp);
      if ((o.probability - cost) < T.min_edge_mcse_multiple * o.mcse) block.push('executable edge is within ' + T.min_edge_mcse_multiple + ' Monte Carlo SEs');
    }
    if (q.status == null) block.push('market status unknown');
    const actionable = eligible && !stale && cfg.fees.verified && execPrice != null && block.length === 0;
    rows.push({
      market_ticker: m.market_ticker, event_ticker: m.event_ticker, series_ticker: m.series_ticker, mapping_id: m.mapping_id, entity_id: m.entity_id, outcome: m.outcome,
      settlement_basis: m.settlement.basis, quote_at: q.captured_at, quote_age_minutes: Math.round(age * 100) / 100,
      yes_bid: q.yes_bid, yes_ask: q.yes_ask, yes_ask_size: q.yes_ask_size,
      reference_basis: refBasis, reference_prob: refProb, normalization, normalized_ref_prob: normProb, normalization_note: normNote,
      research_prob: o.probability, research_mcse: o.mcse, research_fair_decimal: o.probability > 0 ? r6(1 / o.probability) : null,
      reference_edge_pp: refProb == null ? null : Math.round((o.probability - refProb) * 1e6) / 1e4,
      exec_quantity: execPrice == null ? null : Q, exec_price: execPrice, fee_per_contract: fee,
      fee_basis: cfg.fees.verified ? cfg.fees.kind + ': ' + cfg.fees.formula + ' (rate ' + cfg.fees.rate + ')' : 'unverified — not included',
      fee_verified: cfg.fees.verified, exec_cost_prob: cost, exec_edge_pp: execEdge, expected_net_return: ret,
      stale, eligible, actionable, block_reasons: actionable ? [] : block,
      provenance: { quote: 'Observed (Kalshi, ' + (q.host || 'public API') + ', ' + q.captured_at + ')', research: 'Research (simulated)', normalization: normalization === 'none' ? 'n/a' : 'Estimated (assumption)' }
    });
  }
  return { status: 'compared', rows, excluded, methodology, note: rows.length + ' compared, ' + excluded.length + ' excluded' };
}
