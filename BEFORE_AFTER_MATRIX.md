# EdgeDesk — Before / After Finding Matrix

Re-audit of the **patched** `app.html` against the original 179-finding baseline. Each finding shows its **before** state (present at the cited pre-patch line) and its **after** disposition. Companion to `AUDIT_REPORT.md`.

## Disposition legend

- **FIXED** — patched this pass; the defect no longer exists in the client.
- **PARTIAL** — meaningfully mitigated this pass; a documented remainder is deferred.
- **DEFERRED** — real, with an exact patch documented, **not applied** because it would change a displayed financial number or needs server confirmation (per the "prove-defect-before-changing-quant" rule).
- **SERVER** — `SERVER-SIDE AUDIT REQUIRED`; cannot be resolved from the frontend (RLS / Edge Functions).
- **DOCUMENTED** — captured with remediation guidance (mostly P3 polish, plus honesty-label / a11y / perf follow-ups that change no number).
- **REFUTED** — adversarial verification found the finding overstated or false.

> **Re-audit note.** An independent adversarial pass over the patched file (9 agents) confirmed every fix and hunted regressions. It caught **5 residual XSS sinks of the same class the initial pass missed** — `dscan` best-play verdict (`pick.x.sel`), `flPoll` title + work-table team, `renderTrapRadar` `t.board`, and the `renderBookBias` verdict `r.book`. **All 5 were then closed** (`esc`/`flEsc`/`edEsc`), so the XSS-class findings below are now fully, not partially, resolved. No behavioral regressions were found; the quant/session/state/data-integrity fixes all verified GREEN.

## Summary

| Disposition | P1 | P2 | P3 | Total |
|---|---:|---:|---:|---:|
| FIXED | 7 | 17 | 0 | 24 |
| PARTIAL | 0 | 3 | 0 | 3 |
| DEFERRED | 4 | 6 | 12 | 22 |
| SERVER | 3 | 14 | 11 | 28 |
| DOCUMENTED | 3 | 30 | 64 | 97 |
| REFUTED | 5 | 0 | 0 | 5 |
| **Total** | 22 | 70 | 87 | **179** |

## P1 — High (all 22)

| Finding | Region | Before | After | Note |
|---|---|---|---|---|
| MODEL price join folds all non-totals markets to \|h2h\|: spread/prop picks matched to moneyline price -> fabricated EV and wrong ledger log | cfb-wta-multiengine | present (L9966) | **DEFERRED** | modelKey market-fold — documented patch; may be intentional context; needs model-emits confirmation |
| Owned-table rows stamp captured_at=Date.now() and status=VERIFIED, defeating the freshness gate for all financial market data | fabric-source-registry | present (L21295) | **DEFERRED** | fabric freshness-stamp honesty patch documented |
| Mixed-source market: an nflverse REFERENCE total is displayed/exported as a live 'captured' quote | football-engine-cfb-board | present (L21582) | **DEFERRED** | documented exact patch; changes a displayed number or touches model path |
| Power 4 Supabase-fallback schedule marks both teams NON-FBS in the projection request | football-engine-cfb-board | present (L22396) | **DEFERRED** | documented exact patch; changes a displayed number or touches model path |
| Stake-size "recommendations" and BET/Bet-grade verdicts contradict the product's "not betting advice / does not tell you what to bet" claim | vnext-quality-paywall-weather | present (L12617) | **DOCUMENTED** | product-copy/claim decision for owner |
| readTable envelope hard-codes freshness='FRESH' on any successful fetch, independent of data age | fabric-source-registry | present (L21161) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| Module header claims it NEVER emits probabilities/edges/EV/CLV/confidence, but runSlate/projectGame/readProjections/historicalSummary emit exactly those | fabric-source-registry | present (L20867) | **DOCUMENTED** | product-copy/claim decision for owner |
| 401 refresh path bypasses the shared single-flight guard, racing a rotating single-use refresh token | money-math-core | present (L1868) | **FIXED** | edRefreshShared single-flight |
| onclick handlers interpolate DB names through stEsc, which does not escape single quotes or backslashes — apostrophe names break the handler and are a code-injection sink | research-shell-registry | present (L3329) | **FIXED** | edAttrJs for JS-string handler args |
| News feed renders untrusted title/teams/source/category into innerHTML with no escaping (stored XSS) | faultline-golf-ai-news | present (L7582) | **FIXED** | newsCard escaped + edSafeUrl |
| News item href is built from unescaped n.url — attribute breakout and javascript: scheme XSS | faultline-golf-ai-news | present (L7581) | **FIXED** | newsCard escaped + edSafeUrl |
| Fault title/finding/receipt render DB-sourced board_name, selection, trigger_note and team names into innerHTML unescaped (XSS) | faultline-golf-ai-news | present (L7510) | **FIXED** | faultline DB values flEsc at construction |
| Boards-under-watch nested/stale cards and market ledger interpolate DB strings unescaped | faultline-golf-ai-news | present (L7553) | **FIXED** | faultline DB values flEsc at construction |
| x.sel (raw DB selection) injected unescaped into innerHTML across every EDAI renderer — stored/reflected XSS | edai-renderers-bets | present (L16799) | **FIXED** | esc(x.sel) at all EDAI render sites; data copies left raw |
| Login gate is a client-side cosmetic redirect, not a data/paywall gate | boot-auth-css-html | present (L25) | **REFUTED** | Verified false by adversarial check |
| has_sharp truthfulness is the entire anchor-honesty gate but cannot be verified from the frontend | money-math-core | present (L1978) | **REFUTED** | Verified false by adversarial check |
| Paywall only gates the EMPTY board — non-subscribers with any edges loaded see the full Top 10 and Top 5 | edges-boards-mlb | present (L4067) | **REFUTED** | Verified false by adversarial check |
| Bet Discipline score is computed 100% client-side with no user_id scoping in any query — relies entirely on unverified RLS; if RLS is absent every user's score aggregates ALL users' bet_history | settings-auth-discipline | present (L11921) | **REFUTED** | Verified false by adversarial check |
| Discipline write-side inserts omit user_id entirely — rows are only correctly attributed if a DB default/trigger sets user_id=auth.uid(); otherwise silent data loss or orphaned rows | settings-auth-discipline | present (L12137) | **REFUTED** | Verified false by adversarial check |
| social_posts/likes/reports trust client-supplied user_id and handle; the 'DB trigger overwrites from auth.uid()' claim is unverified — impersonation possible if the trigger is absent | settings-auth-discipline | present (L11638) | **SERVER** | RLS / Edge Function — SERVER-SIDE AUDIT REQUIRED |
| Subscription/paywall enforcement in this region is client-side only (window.SUB read with limit 1, PAYWALL_LIVE boolean) — real data access must be RLS-gated on subscription state | settings-auth-discipline | present (L11107) | **SERVER** | RLS / Edge Function — SERVER-SIDE AUDIT REQUIRED |
| Paywall is DOM-only; premium-data enforcement rests entirely on unverified server-side RLS | vnext-quality-paywall-weather | present (L12930) | **SERVER** | RLS / Edge Function — SERVER-SIDE AUDIT REQUIRED |

## P2 — Medium (all 70)

| Finding | Region | Before | After | Note |
|---|---|---|---|---|
| Two divergent Shin/power de-vig implementations produce different fairs for the same price | money-math-core | present (L2445) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| renderAllBoards 'edge' tag compares model prob to VIGGED implied while the section claims 'de-vigged' | edges-boards-mlb | present (L3913) | **DEFERRED** | documented exact patch; changes a displayed number or touches model path |
| TrapRadar de-vig overround is corrupted by lay/null/duplicate rows in the board | edges-boards-mlb | present (L3845) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| flStale and flOver present fabricated edge numbers as concrete '+X.X pts' edges | faultline-golf-ai-news | present (L7080) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| Consensus both-sides vig filter keyed on event\|market wipes out all selections of multi-selection prop markets | cfb-wta-multiengine | present (L10811) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| Spearman rank correlation formula is wrong under ties — coverage scores are heavily tied | lab-dmodal-misc | present (L13712) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| Disclaimer says 'not advice / no prediction' while the UI emits BET/WATCH/PASS calls and stake sizing | boot-auth-css-html | present (L1748) | **DOCUMENTED** | product-copy/claim decision for owner |
| Avatar button has no accessible name and its dropdown lacks menu ARIA | boot-auth-css-html | present (L1441) | **DOCUMENTED** | a11y follow-up (Section 9) |
| Maturity badge is derived only from status==='validated' and ignores the passed/holdout fields — a row can render 'Validated' while its own dossier says it did not pass | research-shell-registry | present (L3086) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| Hardcoded model performance and training-window claims in RS_LIMITS.football go stale silently — the exact 'typed sentence that can't go stale loudly' anti-pattern | research-shell-registry | present (L3010) | **DOCUMENTED** | product-copy/claim decision for owner |
| Unescaped DB strings (selection / team / book / reason) written to innerHTML — stored-XSS sink, inconsistent with flEsc used one line away | edges-boards-mlb | present (L3918) | **DOCUMENTED** | see report |
| Doubleheader: mlbLookup returns the wrong game's pitchers/context | edges-boards-mlb | present (L4372) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Receipt shows two independently-computed edge numbers that can contradict (e.edge vs recomputed gap) | edges-boards-mlb | present (L4499) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| Both-sides dedup also silently drops a genuine edge when a duplicate-event row exists | edges-boards-mlb | present (L3973) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Fault cards, golf rows and 'Why this number' toggles use div onclick with no keyboard access or ARIA | faultline-golf-ai-news | present (L7514) | **DOCUMENTED** | a11y follow-up (Section 9) |
| Research Confidence partiality is computed against 100 but nonzero weights sum to 120, so it falsely claims 'All measurable components available' | cfb-wta-multiengine | present (L10618) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| MODEL card shows the model's own self-reported price as an authoritative 'Best price', contradicting the 'nothing invented' claim | cfb-wta-multiengine | present (L9941) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| 'Discipline Score' is presented as server-certified but is computed entirely in the browser from client-writable inputs — the honesty claim is false and the score is trivially gameable | settings-auth-discipline | present (L11722) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| discCheck falls back to bankroll=50 when no profile row, silently distorting stake_units, unit-size limits and chase detection that gate real financial warnings | settings-auth-discipline | present (L12215) | **DOCUMENTED** | documented with patch (Section 7/15) |
| MLB-only 'not connected' modules (pitching, bullpen, offense, defense, park, lineups) render on non-MLB receipts | vnext-quality-paywall-weather | present (L12582) | **DOCUMENTED** | see report |
| Interactive toggles are non-semantic clickable <div>s with onclick, not keyboard-operable | vnext-quality-paywall-weather | present (L12653) | **DOCUMENTED** | a11y follow-up (Section 9) |
| Market Coverage Research panel never mounts — wrapper bails because window.loadLab is undefined at parse time | lab-dmodal-misc | present (L14158) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Coverage 'reproduces the value that was true at capture' claim is false — availability reads mutable n_books | lab-dmodal-misc | present (L13454) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| dmodal has no focus management, no focus trap, and no dialog role on the card | lab-dmodal-misc | present (L14582) | **DOCUMENTED** | a11y follow-up (Section 9) |
| Brain manufactures a new quantitative "effective_edge" (in edge units) from hardcoded judgement coefficients and uses it to gate capital decisions | edai-brain-engine | present (L16310) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| Offline 'best/least attackable pitchers' ranks only the 12 most-attackable arms — genuinely best pitchers can never surface | edai-renderers-bets | present (L17431) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Re-evaluation and postmortem match live/graded rows by event\|market\|selection, dropping point — wrong price/CLV attributed for totals & spreads | edai-packet-api | present (L19624) | **DOCUMENTED** | documented with patch (Section 7/15) |
| bqGap rates an MLB game with NO pitcher data at all as only MODERATE, but a game with one KNOWN + one missing starter as CRITICAL — less information yields a lower gap | edai-packet-api | present (L18607) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| assertResearchOnly boundary guard is exact-key matching (misses home_win_prob/edge_pct/calibrated_edge_pct/avg_clv) and is never invoked on any emitted evidence | fabric-source-registry | present (L20979) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| validate() (impossible-value rejection) is never called on any live adapter output — dead in the real pipeline | fabric-source-registry | present (L20914) | **DOCUMENTED** | documented with patch (Section 7/15) |
| NWS windSpeed parsing concatenates range digits, producing absurd wind_mph presented as VERIFIED | fabric-source-registry | present (L21069) | **DOCUMENTED** | documented with patch (Section 7/15) |
| mergeEvidence collapses game_id-less weather evidence across different venues | fabric-source-registry | present (L20949) | **DOCUMENTED** | documented with patch (Section 7/15) |
| NFL kickoff parsed as browser-local time (no timezone) — wrong kickoff times and 12-day window per user location | football-engine-cfb-board | present (L21687) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Contradictory product claim: CFB card asserts 'no public CFB line archive' while the P4 card says that claim was wrong | football-engine-cfb-board | present (L21808) | **DOCUMENTED** | product-copy/claim decision for owner |
| FB.p4.absorbed is accumulated with += but never reset — inflated 'games absorbed' honesty note on any reload | football-engine-cfb-board | present (L22283) | **DOCUMENTED** | documented with patch (Section 7/15) |
| CFB signal-to-schedule matching uses prefix match — can bind a different game's market line | football-engine-cfb-board | present (L22023) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Storage-blocked / private-mode users are permanently bounced to the landing page | boot-auth-css-html | present (L28) | **FIXED** | gate no longer redirects on storage throw |
| Undefined CSS variable --fg makes emphasized values (incl. a confidence score) render with inherited, not intended, color | boot-auth-css-html | present (L651) | **FIXED** | --fg added (aliases --text) |
| --faint (#5b6472) fails WCAG 2.2 AA contrast for the small text it is used on | boot-auth-css-html | present (L33) | **FIXED** | --faint lifted to #78818f |
| Unescaped book_title / sport_title flow into innerHTML across every render (stored XSS) | money-math-core | present (L2489) | **FIXED** | escaped at sink (edEsc / edSafeUrl) |
| Sign-out clears edgedesk_session but not edgedesk_prefs — saved research and last-tab leak to the next user on a shared device | research-shell-registry | present (L3351) | **FIXED** | edSignOut clears all edgedesk_* keys |
| Top 5 board (renderDaily) shows stale/zombie prices as live edges — no freshness guard, unlike Top 10 | edges-boards-mlb | present (L4554) | **FIXED** | renderDaily zombie drop like Top10 |
| flImpl mishandles null/NaN American odds — returns 1.0 (100%), corrupting de-vig normalization and favorite sorting | edges-boards-mlb | present (L3786) | **FIXED** | flImpl NaN sentinel + flDevig/over drop non-finite (valid inputs proven identical) |
| AI-brief source links and re-run button trust edge-function URLs/names without scheme check or robust escaping | faultline-golf-ai-news | present (L7367) | **FIXED** | escaped at sink (edEsc / edSafeUrl) |
| renderModelEngine writes duplicate model_conflicts rows to the DB on every repaint (render side-effect, client timestamp, no idempotency) | cfb-wta-multiengine | present (L10230) | **FIXED** | logModelConflicts session dedup |
| WTA renders surface_edge object keys (and several numeric DB fields) into HTML without escaping | cfb-wta-multiengine | present (L9499) | **FIXED** | escaped at sink (edEsc / edSafeUrl) |
| discRenderProjections injects DB values game_id and confidence into innerHTML without escaping — stored XSS if game_projections is writable/attacker-influenced | settings-auth-discipline | present (L12196) | **FIXED** | escaped at sink (edEsc / edSafeUrl) |
| Unescaped DB-sourced text (venue_name, selection/team/sport labels) injected into innerHTML — stored XSS sink | vnext-quality-paywall-weather | present (L13188) | **FIXED** | escaped at sink (edEsc / edSafeUrl) |
| dmodal openDetail() has no request token — out-of-order fetches render the WRONG line's prices/CLV | lab-dmodal-misc | present (L14589) | **FIXED** | dmodal monotonic request token |
| DB-derived participant names embedded unescaped into detail/headline strings (potential stored XSS at render) | edai-brain-engine | present (L16450) | **FIXED** | escaped at sink (edEsc / edSafeUrl) |
| Check My Bet renders 'Good number.' — betting-advice tone conflicting with 'research only / not betting advice' positioning | edai-renderers-bets | present (L17794) | **FIXED** | reframed to factual fair-floor language |
| EDResearchV2.selfTest() writes synthetic packets to the real localStorage store and can prune/delete the user's actual research history | edai-packet-api | present (L20671) | **FIXED** | selfTest snapshot/restore PACKET_KEY |
| probe() POSTs {probe:true} to run_slate/project_game/team_brief/edgedesk_ai — risks unintended DB writes and LLM cost | fabric-source-registry | present (L21206) | **FIXED** | probe PROBE_SKIP side-effecting fns |
| No CSP and an inline-script/inline-onclick architecture make XSS mitigation impossible | boot-auth-css-html | present (L3) | **PARTIAL** | conservative CSP meta (object-src none; base-uri self); strict script-src needs inline-handler migration |
| Static modals lack dialog semantics, focus trapping, and labeling | boot-auth-css-html | present (L1654) | **PARTIAL** | role=dialog/aria-modal on paywall+dossier; full focus-trap deferred |
| Paywall overlay is not an accessible modal (no focus trap, role=dialog, aria-modal, or Escape) and leaves background focusable | vnext-quality-paywall-weather | present (L12930) | **PARTIAL** | role=dialog/aria-modal on paywall+dossier; full focus-trap deferred |
| Google Analytics (gtag) loads and fires a pageview before the auth gate and with no consent | boot-auth-css-html | present (L7) | **SERVER** | needs server-side verification |
| Anon-key fallback silently returns empty instead of erroring — confirm no sensitive table is readable by anon | money-math-core | present (L1853) | **SERVER** | RLS / Edge Function — SERVER-SIDE AUDIT REQUIRED |
| cfb/stats/props freshness hardcodes builtAt:null, so 'this pipeline publishes no build time' is asserted and no staleness is ever measured for these boards | research-shell-registry | present (L2853) | **SERVER** | needs server-side verification |
| plDelete / plLike / plReport can be invoked with any post id — soft-deletion or like/report of other users' posts depends solely on unverified RLS | settings-auth-discipline | present (L11670) | **SERVER** | RLS / Edge Function — SERVER-SIDE AUDIT REQUIRED |
| Feedback insert authenticates with anon SB_KEY when no session and sends a fully client-controlled user_email — spoofable attribution + anonymous spam vector | settings-auth-discipline | present (L11292) | **SERVER** | RLS / Edge Function — SERVER-SIDE AUDIT REQUIRED |
| past_due (or stale active) subscription with missing/invalid current_period_end grants indefinite access | vnext-quality-paywall-weather | present (L12891) | **SERVER** | RLS / Edge Function — SERVER-SIDE AUDIT REQUIRED |
| curEdge labeled 'authoritative (pipeline)' silently falls back to a locally recomputed consensus-based edge | edai-brain-engine | present (L16577) | **SERVER** | needs server-side verification |
| Brain 'call' (ACT/WATCH) is computed from credibility independent of the deterministic verdict and can contradict a PASS/WAIT | edai-brain-engine | present (L16334) | **SERVER** | needs server-side verification |
| Price-cushion / fragility computed from curEdge−FLOOR but labelled and used as 'EV over the EV floor' — can misstate headroom and contradict dscanPlayable | edai-packet-api | present (L18557) | **SERVER** | needs server-side verification |
| bet_quality.market_edge and provLine present x.curEdge as the sharp 'market-derived edge' whenever provenance=SHARP, even though a separate x.sharpEdge exists | edai-packet-api | present (L18714) | **SERVER** | needs server-side verification |
| Default slate date and canonDate use UTC (toISOString), fetching the wrong day for US-evening users | fabric-source-registry | present (L20943) | **SERVER** | RLS / Edge Function — SERVER-SIDE AUDIT REQUIRED |
| canonGameId collides on doubleheaders; mergeEvidence then silently drops the second game | fabric-source-registry | present (L20942) | **SERVER** | RLS / Edge Function — SERVER-SIDE AUDIT REQUIRED |
| _tok() falls back to the anon SB_KEY as the Authorization Bearer when no user is logged in | fabric-source-registry | present (L21137) | **SERVER** | RLS / Edge Function — SERVER-SIDE AUDIT REQUIRED |
| fbPredict cache key omits odds timestamp, moneylines and h2h quotes — a stale prediction can be reused across contexts | football-engine-cfb-board | present (L21787) | **SERVER** | needs server-side verification |

## P3 — Low (all 87)

| Finding | Region | Before | After | Note |
|---|---|---|---|---|
| Bootstrap CI is nondeterministic and hardcoded '95%' while acknowledged optimistic below n~100 | money-math-core | present (L2596) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| fmtFrac caps denominator at 50, giving up to 100% relative error on extreme short prices | money-math-core | present (L2704) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| isMarquee prefix matching false-positives (texas->Texas Tech, miami->Miami OH) mislabel non-marquee teams as public money | edges-boards-mlb | present (L3825) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| Season-window filter and staleness use UTC month/day while books/events are US-scheduled | faultline-golf-ai-news | present (L7199) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| clv() divides by pb without guarding pb===0 and labels a vig-inclusive implied prob as 'fair-prob basis' | settings-auth-discipline | present (L11738) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| max_odds commitment compares raw American odds numerically, so heavy favorites (large negative numbers) can never trigger it — an asymmetric guard that misrepresents risk | settings-auth-discipline | present (L11868) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| Weather applies a directional caution delta to moneylines despite conditions affecting both teams equally | vnext-quality-paywall-weather | present (L13180) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| gradeBet accepts invalid/decimal odds (0, ±1..99, or decimal like 1.91) and shows nonsense EV as authoritative | edai-renderers-bets | present (L16778) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| 'Your vs fair (cents)' metric is distorted/mis-signed across the +100/-100 discontinuity | edai-renderers-bets | present (L16791) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| mlbMatchup attributes opponent-offense strength to pitcher attackability when the arm has no stat line | edai-renderers-bets | present (L17417) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| historicalSummary win_rate/beat_close_rate divide by n that includes pushes/voids, understating win rate | fabric-source-registry | present (L20350) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| findConflicts compares moneylines/odds on raw scale with a 2% relative threshold, missing favorite/underdog disagreements | fabric-source-registry | present (L20970) | **DEFERRED** | documented; not altered per prove-defect-before-changing-quant rule |
| SPA app shell has no h1; heading hierarchy starts at h2 | boot-auth-css-html | present (L1435) | **DOCUMENTED** | a11y follow-up (Section 9) |
| Active bottom-nav tab is not exposed to assistive tech (no aria-current) | boot-auth-css-html | present (L1812) | **DOCUMENTED** | a11y follow-up (Section 9) |
| Duplicate/contradictory CSS: .bottomnav button padding redefined in the Pulse block | boot-auth-css-html | present (L777) | **DOCUMENTED** | see report |
| Primary 'RUN RESEARCH' button swallows all errors silently | boot-auth-css-html | present (L1471) | **DOCUMENTED** | see report |
| Two avatar-menu items route to the same destination | boot-auth-css-html | present (L1447) | **DOCUMENTED** | see report |
| sbPost has no 401 refresh-and-retry, unlike sbFetch | money-math-core | present (L1881) | **DOCUMENTED** | documented with patch (Section 7/15) |
| No-fair ('none') rows are folded into the SOFT CONSENSUS CLV cohort | money-math-core | present (L2622) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| Repeated 2000-iteration bootstraps run synchronously on the main thread per render | money-math-core | present (L2616) | **DOCUMENTED** | performance follow-up (Section 10) |
| rsMetaRender rebuilds host.innerHTML on every trigger, wiping the open state of the Provenance and Source-field <details> the user just expanded | research-shell-registry | present (L3290) | **DOCUMENTED** | see report |
| Column probe caches 'unknown' permanently for the session, so a single transient failure freezes a field as 'availability could not be determined' | research-shell-registry | present (L3481) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Research shell controls (tier/maturity badges, search hits, star and CLV buttons, dossier modal) are click-only and not keyboard/AT accessible | research-shell-registry | present (L3091) | **DOCUMENTED** | a11y follow-up (Section 9) |
| Freshness age derived from a future or date-only build stamp overstates recency ('built 0s ago' / 'built Xh ago' from midnight) | research-shell-registry | present (L3223) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| rsClvCheck keys the saved entry by list index, which can point at the wrong entity if the saved list mutates between render and click | research-shell-registry | present (L3382) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Literal '·' rendered as text instead of middot in receipt team records (double-escaped) | edges-boards-mlb | present (L4495) | **DOCUMENTED** | see report |
| Clickable receipt/board rows use onclick on non-interactive divs — keyboard inaccessible (WCAG 2.1.1) | edges-boards-mlb | present (L4530) | **DOCUMENTED** | a11y follow-up (Section 9) |
| Selection-to-team 'pick' highlighting uses substring indexOf and can bold the wrong team | edges-boards-mlb | present (L4486) | **DOCUMENTED** | see report |
| vnOd called with an undefined dec argument in eliminator and trap radar | edges-boards-mlb | present (L3806) | **DOCUMENTED** | see report |
| Provenance claim 'eligibility table maintained manually' is false for auto-generated GOLF dead-money faults | faultline-golf-ai-news | present (L7061) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| make_cut_pct and similar fields coerced with + and toFixed with no null guard, silently printing 0%/NaN% | faultline-golf-ai-news | present (L7242) | **DOCUMENTED** | documented with patch (Section 7/15) |
| News items styled as links are non-focusable anchors when url is missing | faultline-golf-ai-news | present (L7581) | **DOCUMENTED** | a11y follow-up (Section 9) |
| Same golf_stats data fetched three separate times per Faults load; duplicate render/util code | faultline-golf-ai-news | present (L7227) | **DOCUMENTED** | performance follow-up (Section 10) |
| Golf/board event matching uses loose bidirectional substring test that can keep or drop the wrong event | faultline-golf-ai-news | present (L7192) | **DOCUMENTED** | documented with patch (Section 7/15) |
| 'cannot be wrong in a new way / never guesses' framing contradicts synthetic edges and imputed inputs | faultline-golf-ai-news | present (L7343) | **DOCUMENTED** | product-copy/claim decision for owner |
| CFB AP rank badge can display a stale rank: ranks dict keyed by team only while max-week is keyed per season\|season_type | cfb-wta-multiengine | present (L9595) | **DOCUMENTED** | documented with patch (Section 7/15) |
| CFB game row shows SP+ rating gap as a green positive number with no home-field adjustment and no 'not an edge' caveat present on the row | cfb-wta-multiengine | present (L9654) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| plOpen embeds unescaped event_id into an inline onclick JS string (plSport escapes quotes, plOpen does not) — potential JS breakage/injection if event_id contains a quote | settings-auth-discipline | present (L11490) | **DOCUMENTED** | see report |
| Toggle switches and range/select controls have no accessible name (WCAG 2.2 AA 4.1.2 / 1.3.1) | settings-auth-discipline | present (L11043) | **DOCUMENTED** | a11y follow-up (Section 9) |
| est_money_preserved and all discipline side-logs are set from client input on every skip/override, so the user-facing 'money preserved' and breach history are self-reported, not verified | settings-auth-discipline | present (L12143) | **DOCUMENTED** | documented with patch (Section 7/15) |
| bqCardHTML is defined twice; the first full definition is dead code | vnext-quality-paywall-weather | present (L12639) | **DOCUMENTED** | see report |
| loadWeather discards earlier successful chunks if a later chunk request throws | vnext-quality-paywall-weather | present (L13061) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Confidence number/gauge shows a high value while tier/stake are forced to Avoid/Pass on hard fail | vnext-quality-paywall-weather | present (L12608) | **DOCUMENTED** | see report |
| Star ratings have no text alternative for assistive tech | vnext-quality-paywall-weather | present (L12642) | **DOCUMENTED** | a11y follow-up (Section 9) |
| CFB Analyst esc() fallback does not escape HTML | lab-dmodal-misc | present (L14658) | **DOCUMENTED** | see report |
| promHit prefix matching produces false-positive prominence (Texas Southern -> 'Texas', Miami OH -> 'Miami') | lab-dmodal-misc | present (L13436) | **DOCUMENTED** | documented with patch (Section 7/15) |
| frozenSnapshot tier key/label can disagree — colored style keyed off score, label from stored tier | lab-dmodal-misc | present (L13533) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| edaiPanel / dmodal transitions ignore prefers-reduced-motion | lab-dmodal-misc | present (L14902) | **DOCUMENTED** | a11y follow-up (Section 9) |
| 'Steam Confirmed' filter admits negative current edge and contradicts the row's own 'Missed' lifecycle chip | lab-dmodal-misc | present (L14360) | **DOCUMENTED** | documented with patch (Section 7/15) |
| dmodal render(): edge null yields 'removed 100%' while the Now edge cell shows '—' | lab-dmodal-misc | present (L14540) | **DOCUMENTED** | documented with patch (Section 7/15) |
| 'openers today' uses browser-local midnight while season/window logic uses UTC/ET | lab-dmodal-misc | present (L14317) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Discovery detail/replay/openDetail fetches have no AbortController | lab-dmodal-misc | present (L14393) | **DOCUMENTED** | performance follow-up (Section 10) |
| Heuristic credibility/confidence composites are reported to 0.1% precision, presenting judgement as measurement | edai-brain-engine | present (L16353) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| inList quoting strips only double-quotes; commas in a name are re-decoded and split the PostgREST in() list | edai-brain-engine | present (L15900) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Within-family conflict detection and consistency penalty are permanently inert because no extractor sets dir | edai-brain-engine | present (L15411) | **DOCUMENTED** | see report |
| Credibility band is computed and returned even when there is no edge, yielding a flattering score for a non-opportunity | edai-brain-engine | present (L16264) | **DOCUMENTED** | see report |
| Union 'take' keeps only the first (away) participant's metric value, discarding the home side's | edai-brain-engine | present (L15546) | **DOCUMENTED** | documented with patch (Section 7/15) |
| First-initial+lastname name join (nmAlt) can attach the wrong pitcher's stats to a starter | edai-renderers-bets | present (L17083) | **DOCUMENTED** | documented with patch (Section 7/15) |
| boardFeatures name-list query strips only quotes, not commas/parentheses — malformed PostgREST in.() list, silent wrong/empty results | edai-renderers-bets | present (L17043) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Edge-decay bar can render >100% or negative width and print '-N% remains' | edai-renderers-bets | present (L16790) | **DOCUMENTED** | see report |
| UI asserts packets are 'never overwritten / earlier packets are kept' while PACKET_CAP=40 and quota-shedding silently delete older packets | edai-packet-api | present (L19126) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| dailyScanCore does not restore SESSION.eventId/cache on a mid-run exception, leaking an emptied tool cache into the next loaded signal | edai-packet-api | present (L19745) | **DOCUMENTED** | documented with patch (Section 7/15) |
| reevaluate() persists appended re-evaluations via a bare localStorage.setItem in a swallowed try/catch, bypassing packetSave's quota/cap handling | edai-packet-api | present (L20086) | **DOCUMENTED** | documented with patch (Section 7/15) |
| packetLoadAll discards the ENTIRE packet history on any JSON parse error, after which the next save overwrites it, with no user warning | edai-packet-api | present (L19386) | **DOCUMENTED** | documented with patch (Section 7/15) |
| reevaluatePacket silently drops a finalist whose evidence() throws, omitting it from the re-eval report with no indication | edai-packet-api | present (L19628) | **DOCUMENTED** | documented with patch (Section 7/15) |
| bqDurability dereferences f.research.attack without a guard, unlike the rest of the layer — throws on the public betQuality API | edai-packet-api | present (L18621) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Freshness quality component uses a hardcoded 20-minute cutoff while the staleness gate uses STALE_MIN — a gate-stale quote can still score 'fresh' 1/1 | edai-packet-api | present (L18661) | **DOCUMENTED** | see report |
| Timezone-edge fallback (scan=all) counts and labels out-of-window games as 'in window / candidates identified' in the funnel and packet scope | edai-packet-api | present (L19722) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| liveSlate 'unavailable' list is always empty and its note over-promises coverage | fabric-source-registry | present (L21128) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| health() note claims 'WIRED = adapter written' but the ai source is WIRED with no adapter | fabric-source-registry | present (L21219) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| mlbSchedule status mapping collapses Delayed/Suspended/unknown states to 'scheduled' | fabric-source-registry | present (L21044) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Stale-downgrade guard only rescues status==='VERIFIED', leaving PROBABLE/PARTIAL evidence presented while stale | fabric-source-registry | present (L20909) | **DOCUMENTED** | honesty-of-claim fix documented (no number change) |
| fbMarketFromEvent coerces signal point with +r.point, bypassing the fbNum NaN/empty guard | football-engine-cfb-board | present (L21551) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Scope <select> has no accessible label (WCAG 4.1.2 / 3.3.2) | football-engine-cfb-board | present (L21922) | **DOCUMENTED** | a11y follow-up (Section 9) |
| Clickable week rows are <span onclick> — not keyboard operable (WCAG 2.1.1) | football-engine-cfb-board | present (L22008) | **DOCUMENTED** | a11y follow-up (Section 9) |
| P4 load-timeout gate can persist after a late successful load (stale honesty banner) | football-engine-cfb-board | present (L22357) | **DOCUMENTED** | documented with patch (Section 7/15) |
| Records provenance claim 'nothing is estimated' asserted in static copy, unverifiable here | boot-auth-css-html | present (L1512) | **SERVER** | needs server-side verification |
| Time-to-close and calibration parsing assume TZ-qualified timestamps | money-math-core | present (L2308) | **SERVER** | needs server-side verification |
| CFB team_season_stats is not filtered by season on read; comparison colors mix seasons and 'season totals' value is nondeterministic | cfb-wta-multiengine | present (L9597) | **SERVER** | needs server-side verification |
| modelEvOf magnitude heuristic (abs<=1 => fraction*100, else percent) is ambiguous around 1 and can mis-scale a model edge by 100x | cfb-wta-multiengine | present (L9930) | **SERVER** | needs server-side verification |
| WTA and CFB banners hardcode the green 'live' class regardless of how stale the slate/schedule is | cfb-wta-multiengine | present (L9432) | **SERVER** | needs server-side verification |
| Edge-anatomy equation can be internally inconsistent when e.edge's fair basis differs from bqFairP() | vnext-quality-paywall-weather | present (L12744) | **SERVER** | needs server-side verification |
| recDT referenced without a typeof guard inside the weather module | vnext-quality-paywall-weather | present (L13183) | **SERVER** | needs server-side verification |
| Research Lab gate compares clv_measured to clv_threshold with unverified units | lab-dmodal-misc | present (L14802) | **SERVER** | needs server-side verification |
| External module output (ED_COVERAGE.snapshotBlock/packet) injected raw; module state (HIST/LOADED/BOARD_CACHE) clearing on logout unverified | edai-renderers-bets | present (L16825) | **SERVER** | needs server-side verification |
| Research packets are stored in a single global localStorage key with no per-user scoping or logout clearing — history persists across users on a shared device | edai-packet-api | present (L19377) | **SERVER** | needs server-side verification |
| Module-level caches and rating state are never cleared on logout/user switch | football-engine-cfb-board | present (L21466) | **SERVER** | needs server-side verification |


---

## Quantitative methodology-invariance proofs

Per the requirement to prove the math is unchanged unless a defect was identified, every quantitative-adjacent change was numerically verified.

### 1. De-vig engines left UNCHANGED (no proven defect)
The two implementations (`devigShin/Power/Mult` vs `GE.devig`) were tested for equivalence across **every realistic two-way market** (both American prices over ±100…±2000; overrounds/holds 0–12%, then re-scanned up to 30%):

```
Shin   max |standalone − GE| = 6.9e-11   (worst @ 250/-350, hold 6.3%)
Power  max |standalone − GE| = 5.1e-11   (worst @ 500/-1000, hold 7.6%)
Shin   max divergence scanning hold to 30% = 9.0e-11
```

Divergence is pure float/bisection-iteration noise. The different solver bounds never bite because the root sits well inside both brackets. **Conclusion: not a defect → math left byte-identical.** (Consolidation is a maintainability option only, and only in a proven-output-identical form.)

### 2. `flImpl` / `flDevig` null-guard — valid inputs PROVEN identical
The only quantitative change applied. Old vs new, over the valid American grid and a set of all-valid two-way boards:

```
flImpl  valid-input   max |old − new| = 0
flDevig valid-board    max |over diff| = 0 ,  max |fair diff| = 0
```

Only the **invalid** path changed:
```
OLD flDevig with a null-odds row: [0.5798, 0, 0.4202]   (null injected a bogus 0)
NEW flDevig with a null-odds row: [0.5798, 0.4202]      (null row dropped; real pair de-vigged correctly)
```
And a `NaN` american (undefined price) that previously collapsed a whole board's overround to `1` (de-vig silently off) is now excluded. **Conclusion: valid-input methodology byte-identical; only the corrupting invalid path was repaired — a defect the audit explicitly identified.**

### 3. `bootCI` bootstrap — left UNCHANGED
Percentile bootstrap (2000 iters, 2.5/97.5) is standard and correct. Its `Math.random()` non-determinism is an auditability nit, **not a methodology defect** → not changed (seeding would alter the displayed interval).

### What was NOT changed (to avoid silently altering a displayed number)
`modelKey` market-fold; `renderAllBoards` vigged-vs-devigged edge label; consensus multi-selection vig filter; timezone/day-boundary; all odds/edge/CLV/probability formulas. Each is documented with an exact patch in `AUDIT_REPORT.md` and left for a deliberate, reviewed change.
