"""Position normalization: a provider's position string -> a position FAMILY.

Families
  offense        QB RB WR TE OT OG C OL_OTHER
  defense        EDGE DT DL_OTHER LB CB S DB_OTHER
  special teams  K P LS RETURNER
  UNKNOWN

Rules
  * A GENERIC line label stays generic. 'OL' / 'IOL' / 'OFFENSIVE LINE' -> OL_OTHER and
    'DL' / 'DEFENSIVE LINE' -> DL_OTHER: the provider did not say tackle, guard, end or
    tackle, so neither do we. 'DB' and the nickel ('NB', scheme-dependent CB or S) ->
    DB_OTHER for the same reason.
  * 'DE' -> EDGE (the end is the edge player in every provider vocabulary we read);
    'NT' / 'NG' -> DT; 'FB' -> RB; 'SB' (slotback) -> WR; 'PK' -> K; 'KR' / 'PR' -> RETURNER.
  * 'ATH' is UNKNOWN unless `context` carries OBSERVED usage that is dominant and
    sizeable (usage_family below). That is evidence, and the result says so through
    `normalize_detail`; nothing is inferred from a name, a jersey number or a weight.

Units
  unit_of(family)         the personnel system's units: QB OL WR_TE RB FRONT7 SECONDARY ST
  weekly_unit_of(family)  the weekly engine's units:    QB OL WR_TE RB DL LB DB ST
                          (v2.weekly.availability.UNIT_OF_POSITION; a test checks the two
                          agree on every position string the weekly engine knows)
"""
import re

OFFENSE = ('QB', 'RB', 'WR', 'TE', 'OT', 'OG', 'C', 'OL_OTHER')
DEFENSE = ('EDGE', 'DT', 'DL_OTHER', 'LB', 'CB', 'S', 'DB_OTHER')
SPECIAL = ('K', 'P', 'LS', 'RETURNER')
FAMILIES = OFFENSE + DEFENSE + SPECIAL + ('UNKNOWN',)
OL_FAMILIES = ('OT', 'OG', 'C', 'OL_OTHER')
DL_FAMILIES = ('EDGE', 'DT', 'DL_OTHER')
FRONT7_FAMILIES = DL_FAMILIES + ('LB',)
SECONDARY_FAMILIES = ('CB', 'S', 'DB_OTHER')
DEFENSIVE_FAMILIES = FRONT7_FAMILIES + SECONDARY_FAMILIES
SKILL_FAMILIES = ('QB', 'RB', 'WR', 'TE')

# provider string (upper case, punctuation stripped) -> family
_MAP = {
    # quarterbacks
    'QB': 'QB', 'QUARTERBACK': 'QB',
    # backs
    'RB': 'RB', 'HB': 'RB', 'TB': 'RB', 'FB': 'RB', 'RUNNING BACK': 'RB', 'RUNNINGBACK': 'RB',
    'HALFBACK': 'RB', 'TAILBACK': 'RB', 'FULLBACK': 'RB',
    # receivers
    'WR': 'WR', 'SB': 'WR', 'FL': 'WR', 'SE': 'WR', 'WIDE RECEIVER': 'WR', 'RECEIVER': 'WR',
    'SLOTBACK': 'WR', 'SLOT': 'WR',
    'TE': 'TE', 'TIGHT END': 'TE',
    # offensive line: specific labels only
    'OT': 'OT', 'T': 'OT', 'LT': 'OT', 'RT': 'OT', 'OFFENSIVE TACKLE': 'OT', 'TACKLE': 'OT',
    'OG': 'OG', 'G': 'OG', 'LG': 'OG', 'RG': 'OG', 'GUARD': 'OG', 'OFFENSIVE GUARD': 'OG',
    'C': 'C', 'OC': 'C', 'CENTER': 'C',
    # generic line labels stay generic (do not guess)
    'OL': 'OL_OTHER', 'IOL': 'OL_OTHER', 'OFFENSIVE LINE': 'OL_OTHER', 'OFFENSIVE LINEMAN': 'OL_OTHER',
    'OLINE': 'OL_OTHER', 'INTERIOR OFFENSIVE LINE': 'OL_OTHER', 'INTERIOR OFFENSIVE LINEMAN': 'OL_OTHER',
    # defensive front
    'DE': 'EDGE', 'EDGE': 'EDGE', 'EDG': 'EDGE', 'DEFENSIVE END': 'EDGE',
    'DT': 'DT', 'NT': 'DT', 'NG': 'DT', 'DEFENSIVE TACKLE': 'DT', 'NOSE TACKLE': 'DT', 'NOSE GUARD': 'DT',
    'DL': 'DL_OTHER', 'DEFENSIVE LINE': 'DL_OTHER', 'DEFENSIVE LINEMAN': 'DL_OTHER', 'DLINE': 'DL_OTHER',
    'LB': 'LB', 'ILB': 'LB', 'OLB': 'LB', 'MLB': 'LB', 'WLB': 'LB', 'SLB': 'LB', 'LINEBACKER': 'LB',
    'INSIDE LINEBACKER': 'LB', 'OUTSIDE LINEBACKER': 'LB', 'MIDDLE LINEBACKER': 'LB',
    # secondary
    'CB': 'CB', 'CORNERBACK': 'CB', 'CORNER': 'CB',
    'S': 'S', 'FS': 'S', 'SS': 'S', 'SAF': 'S', 'SAFETY': 'S', 'FREE SAFETY': 'S', 'STRONG SAFETY': 'S',
    'DB': 'DB_OTHER', 'NB': 'DB_OTHER', 'NICKEL': 'DB_OTHER', 'NICKELBACK': 'DB_OTHER',
    'DEFENSIVE BACK': 'DB_OTHER',
    # special teams
    'K': 'K', 'PK': 'K', 'KICKER': 'K', 'PLACE KICKER': 'K', 'PLACEKICKER': 'K',
    'P': 'P', 'PUNTER': 'P',
    'LS': 'LS', 'LONG SNAPPER': 'LS', 'SNAPPER': 'LS',
    'KR': 'RETURNER', 'PR': 'RETURNER', 'RET': 'RETURNER', 'RS': 'RETURNER', 'KICK RETURNER': 'RETURNER',
    'PUNT RETURNER': 'RETURNER', 'RETURN SPECIALIST': 'RETURNER',
    # explicitly unknown
    'ATH': 'UNKNOWN', 'ATHLETE': 'UNKNOWN', 'N/S': 'UNKNOWN', 'NS': 'UNKNOWN', '': 'UNKNOWN',
    'UNKNOWN': 'UNKNOWN', 'NA': 'UNKNOWN', 'NAN': 'UNKNOWN', 'NONE': 'UNKNOWN', '-': 'UNKNOWN',
}
_ALREADY = set(FAMILIES)

UNIT_OF_FAMILY = {
    'QB': 'QB', 'RB': 'RB', 'WR': 'WR_TE', 'TE': 'WR_TE',
    'OT': 'OL', 'OG': 'OL', 'C': 'OL', 'OL_OTHER': 'OL',
    'EDGE': 'FRONT7', 'DT': 'FRONT7', 'DL_OTHER': 'FRONT7', 'LB': 'FRONT7',
    'CB': 'SECONDARY', 'S': 'SECONDARY', 'DB_OTHER': 'SECONDARY',
    'K': 'ST', 'P': 'ST', 'LS': 'ST', 'RETURNER': 'ST', 'UNKNOWN': 'UNKNOWN',
}
WEEKLY_UNIT_OF_FAMILY = {
    'QB': 'QB', 'RB': 'RB', 'WR': 'WR_TE', 'TE': 'WR_TE',
    'OT': 'OL', 'OG': 'OL', 'C': 'OL', 'OL_OTHER': 'OL',
    'EDGE': 'DL', 'DT': 'DL', 'DL_OTHER': 'DL', 'LB': 'LB',
    'CB': 'DB', 'S': 'DB', 'DB_OTHER': 'DB',
    'K': 'ST', 'P': 'ST', 'LS': 'ST', 'RETURNER': 'ST', 'UNKNOWN': 'UNKNOWN',
}
UNITS = ('QB', 'OL', 'WR_TE', 'RB', 'FRONT7', 'SECONDARY', 'ST')
WEEKLY_UNITS = ('QB', 'OL', 'WR_TE', 'RB', 'DL', 'LB', 'DB', 'ST')
# personnel unit -> the weekly units it spans (FRONT7 = DL + LB, SECONDARY = DB)
PERSONNEL_TO_WEEKLY = {'QB': ('QB',), 'OL': ('OL',), 'WR_TE': ('WR_TE',), 'RB': ('RB',),
                       'FRONT7': ('DL', 'LB'), 'SECONDARY': ('DB',), 'ST': ('ST',)}

# usage inference for ATH / unlisted players (observed PBP usage only)
USAGE_MIN_EVENTS = 10          # at least this many offensive usage events
USAGE_DOMINANCE = 0.70         # and one kind >= 70% of them


def _clean(s):
    if s is None:
        return ''
    try:
        if s != s:                                   # NaN
            return ''
    except (TypeError, ValueError):
        pass
    s = str(s).strip().upper().replace('_', ' ').replace('.', '')
    s = re.sub(r'\s+', ' ', s)
    return s


def usage_family(usage):
    """Family implied by observed usage, or None.
    usage: {'dropbacks': n, 'rushes': n, 'targets': n} (any missing key = 0).
    Returns QB when dropbacks dominate, RB for carries, WR for targets (a tight end
    cannot be told from a receiver by targets, so a target-dominant ATH is WR)."""
    if not usage:
        return None
    db = float(usage.get('dropbacks') or 0)
    ru = float(usage.get('rushes') or 0)
    tg = float(usage.get('targets') or 0)
    n = db + ru + tg
    if n < USAGE_MIN_EVENTS:
        return None
    for fam, v in (('QB', db), ('RB', ru), ('WR', tg)):
        if v / n >= USAGE_DOMINANCE:
            return fam
    return None


def normalize_detail(original_position, context=None):
    """-> (family, basis). basis: 'provider_label', 'generic_label' (an *_OTHER family),
    'usage_inferred' (ATH/unknown resolved from observed usage), 'unknown'."""
    s = _clean(original_position)
    fam = _MAP.get(s)
    if fam is None and s in _ALREADY:
        fam = s
    if fam is None:
        # tolerate provider decorations such as 'QB/ATH' or 'WR-KR': first token decides
        tok = re.split(r'[/\-, ]', s)[0] if s else ''
        fam = _MAP.get(tok)
    if fam is None:
        fam = 'UNKNOWN'
    if fam == 'UNKNOWN' and context:
        u = context.get('usage') if isinstance(context, dict) else None
        inferred = usage_family(u)
        if inferred:
            return inferred, 'usage_inferred'
        return 'UNKNOWN', 'unknown'
    if fam in ('OL_OTHER', 'DL_OTHER', 'DB_OTHER'):
        return fam, 'generic_label'
    return fam, ('unknown' if fam == 'UNKNOWN' else 'provider_label')


def normalize(original_position, context=None):
    """Provider position string -> family (see the module docstring).
    context: optional {'usage': {'dropbacks', 'rushes', 'targets'}} used ONLY to resolve
    an ATH / missing position from observed usage."""
    return normalize_detail(original_position, context)[0]


def unit_of(family):
    """Family -> personnel unit (QB OL WR_TE RB FRONT7 SECONDARY ST, or UNKNOWN)."""
    return UNIT_OF_FAMILY.get(family, 'UNKNOWN')


def weekly_unit_of(family):
    """Family -> the weekly engine's unit (QB OL WR_TE RB DL LB DB ST, or UNKNOWN)."""
    return WEEKLY_UNIT_OF_FAMILY.get(family, 'UNKNOWN')


def side_of(family):
    if family in OFFENSE:
        return 'OFFENSE'
    if family in DEFENSE:
        return 'DEFENSE'
    if family in SPECIAL:
        return 'SPECIAL'
    return 'UNKNOWN'
