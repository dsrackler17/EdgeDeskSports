"""Small, auditable quant primitives. These do not constitute trained models."""
import math
from datetime import datetime

def safe_ratio(numerator,denominator):
 if denominator is None or denominator<=0:return None
 if numerator is None:return None
 return numerator/denominator

def american_to_decimal(american):
 if not math.isfinite(american) or american==0 or abs(american)<100:raise ValueError('Standard American odds must be <= -100 or >= +100')
 return 1+american/100 if american>0 else 1+100/(-american)

def decimal_to_american(decimal):
 if not math.isfinite(decimal) or decimal<=1:raise ValueError('Decimal odds must exceed 1')
 return (decimal-1)*100 if decimal>=2 else -100/(decimal-1)

def proportional_no_vig(decimal_prices):
 if len(decimal_prices)<2 or any(not math.isfinite(x) or x<=1 for x in decimal_prices):raise ValueError('Need a complete mutually exclusive market of valid decimal odds')
 q=[1/x for x in decimal_prices];s=sum(q);return [x/s for x in q]

def expected_profit(decimal,p_win,p_loss,p_push=0,p_void=0):
 probs=[p_win,p_loss,p_push,p_void]
 if not math.isfinite(decimal) or decimal<=1 or any(not math.isfinite(x) or x<0 or x>1 for x in probs) or not math.isclose(sum(probs),1,abs_tol=1e-8):raise ValueError('Invalid price or probability distribution')
 return p_win*(decimal-1)-p_loss

def expected_split_profit(decimal,full_win,half_win,push,half_loss,full_loss):
 ps=[full_win,half_win,push,half_loss,full_loss]
 if decimal<=1 or any(not math.isfinite(p) or p<0 for p in ps) or not math.isclose(sum(ps),1,abs_tol=1e-8):raise ValueError('Invalid settlement distribution')
 return (full_win+half_win/2)*(decimal-1)-half_loss/2-full_loss

def goalie_gsax(expected_goals_against,goals_allowed):return expected_goals_against-goals_allowed

def efg(fgm,three_pm,fga):return safe_ratio(fgm+0.5*three_pm,fga)

def innings_from_outs(outs):
 if not isinstance(outs,int) or outs<0:raise ValueError('Outs must be nonnegative integer')
 return outs/3

def parse_baseball_innings(native):
 """Convert baseball notation 5.2 -> 17 outs, never float 5.2 innings."""
 s=str(native);parts=s.split('.');whole=int(parts[0]);partial=int(parts[1]) if len(parts)==2 else 0
 if whole<0 or partial not in (0,1,2) or len(parts)>2:raise ValueError('Invalid baseball innings notation')
 return whole*3+partial

def posterior_rate(successes,trials,prior_rate,prior_exposure):
 if trials<0 or successes<0 or successes>trials or not 0<=prior_rate<=1 or prior_exposure<=0:raise ValueError('Invalid binomial/prior counts')
 return (successes+prior_rate*prior_exposure)/(trials+prior_exposure)

def asof_versions(records,cutoff):
 """Keep latest observed version per record_id, excluding unknown known_at."""
 cut=datetime.fromisoformat(cutoff.replace('Z','+00:00'));latest={}
 if cut.tzinfo is None:raise ValueError('Cutoff must be timezone-aware')
 for r in records:
  if not r.get('known_at'):continue
  k=datetime.fromisoformat(r['known_at'].replace('Z','+00:00'))
  if k.tzinfo is None:raise ValueError('known_at must be timezone-aware')
  if k>cut:continue
  old=latest.get(r['record_id'])
  if old is None or (k,r.get('revision',0))>(datetime.fromisoformat(old['known_at'].replace('Z','+00:00')),old.get('revision',0)):latest[r['record_id']]=r
 return list(latest.values())
