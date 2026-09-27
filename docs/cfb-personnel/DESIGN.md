# CFB player-level roster intelligence — design contract

The team rating says what a team has been. The personnel system says whether the team taking the field
Saturday is the same team. Every adjustment answers four questions: **who** changed, **how much** football
value changed, **what replacement** takes those snaps, and **how much of that change the team's current
rating already contains**. Where the data cannot answer them, the system widens uncertainty instead of
inventing precision.

## What the data allows (from the player-data audit, 2026-09-27)

| capability | status | basis |
|---|---|---|
| player identity across transfers | **yes** | ESPN athlete id in PBP, cfbfastR rosters/player_stats, ESPN rosters, player box; persists across schools |
| QB usage, efficiency, starts, changes | **yes, 2009+** | PBP passer ids 97–99.9%; first dropback = starter (92–95% agreement) |
| RB / WR / TE usage and efficiency | **yes (receivers weaker 2024: .69)** | PBP rusher / receiver ids |
| pass-rush, interceptions (defenders) | **partial** | PBP sack ids .86–.99; INT ids collapse 2021–23 |
| tackles, TFL, pressures, PD | **2024+ only** | ESPN player box |
| snap counts, depth charts, OL participation | **no** | no feed the repo reads carries them |
| pregame availability | **2026 conference games only** | official reports, gated on published_at |
| transfers | **derivable** | id changes team between seasons; no portal dates |
| recruiting per player | **no** | recruit ids empty |

So: a strong, backtestable QB system; usage-based value for skill positions; unit-level, uncertainty-first
treatment of the offensive line and the defense; availability as the pregame lineup signal from 2026 on.

## Layout

```
football/cfb_v2/research/v2/personnel/   the system (Python; runs beside the weekly engine)
  identity.py      canonical players, aliases, provider ids, positions, transfer history
  positions.py     position normalization (original -> normalized family)
  usage.py         player-game usage from play-by-play (point-in-time)
  state.py         player-week state: role, expected snap/usage share, value, replacement, availability
  qb.py            QB value (hierarchical), player vs system, replacement, lineup deltas
  units.py         unit strength / health / continuity (QB, OL, WR_TE, RB, FRONT7, SECONDARY, ST)
  lineup.py        baseline lineup context, lineup deltas (double-count protection), scenarios
  events.py        append-only player events and refresh triggers
  backtest.py      historical QB / skill / OL / defense backtests and the model comparison
  tests_personnel.py
football/cfb_personnel/<season>/          committed state (JSON Lines, append-only, versioned)
docs/cfb-personnel/DESIGN.md, METHODS.md, AUDIT.md, BACKTEST.md
supabase/cfb_personnel.sql
```

## Tables (repository files and Postgres, same names)

`cfb_players`, `cfb_player_aliases`, `cfb_transfer_history`, `cfb_player_performance` (player-game),
`cfb_player_week_state`, `cfb_qb_week_state` (the weekly engine's, extended), `cfb_depth_chart_state`
(usage-derived rotation; no provider depth chart exists), `cfb_unit_week_state` (the weekly engine's,
extended), `cfb_player_events`, `cfb_personnel_game_snapshot`, `cfb_personnel_model_versions`.

## The rules

1. **Point in time.** A player-week state uses only games that kicked off before its as-of instant and reports
   published before it. No season-ending totals, no retrospective depth, no future transfer destinations.
2. **Baseline lineup.** Every team state records the lineup its rating represents (`rating_lineup_context`:
   usage-weighted, over the same games and recency weights as the rating). A personnel adjustment is
   `expected upcoming lineup − rating baseline lineup`, never an absolute player value added on top.
3. **Re-anchoring.** As a replacement accumulates games, the baseline moves to him through the same
   weighting, so a long-term absence stops being subtracted.
4. **Probabilistic availability.** Status → play probability, with source tier and status age. UNKNOWN is not
   healthy; a stale status loses information.
5. **Units, not sums.** Unit health combines a linear component with continuity and depth penalties, capped;
   OL and defensive units are uncertainty-first where no player data exists.
6. **Scenarios** for genuinely high-impact unresolved players (the starting QB first): run the lineup states,
   mix the distributions by play probability.
7. **Pure model only.** Personnel is football information EdgeDesk knows. The sportsbook line never informs a
   player's status or value.
8. **Versioned and governed.** The personnel model is `cfb_personnel_v1` with its components versioned; it
   enters production only as a challenger (V2.1 + personnel) through the Model Lab, and only the components
   whose backtests improve or preserve accuracy on ordinary games while improving lineup-change games.
9. **No LLM ratings.** Values come from the quantitative system; any narrative is written afterward from
   the structured output.
