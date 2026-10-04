"""EdgeDesk CFB player-level roster intelligence (docs/cfb-personnel/DESIGN.md).

Data foundation (this phase):
  positions   provider position string -> position family -> unit
  identity    canonical players (ESPN athlete id), aliases, transfers, alias resolution
  usage       player x game usage from play-by-play, point-in-time
  state       player-week state and the usage-derived depth chart at an instant T

Value models (qb, units, lineup) are the next phase; the state rows carry their
fields as named null placeholders.
"""
RULE_VERSION = 'cfb_personnel_foundation_v1'
