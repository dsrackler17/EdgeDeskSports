import sys,pathlib,unittest,math
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import quant_math as q
class QuantTests(unittest.TestCase):
 def test_prices(self):
  self.assertAlmostEqual(q.american_to_decimal(-110),1+100/110)
  self.assertEqual(q.american_to_decimal(150),2.5)
  for x in [-300,-110,100,150]:self.assertAlmostEqual(q.decimal_to_american(q.american_to_decimal(x)),x)
  for x in [0,50,-50,float('nan')]:
   with self.assertRaises(ValueError):q.american_to_decimal(x)
 def test_vig(self):
  self.assertEqual(q.proportional_no_vig([1.91,1.91]),[.5,.5])
  self.assertAlmostEqual(sum(q.proportional_no_vig([2.1,3.2,3.8])),1)
 def test_ev_with_push(self):
  self.assertAlmostEqual(q.expected_profit(2.0,.5,.4,.1),.1)
  self.assertAlmostEqual(q.expected_profit(2.0,0,0,0,1),0)
  with self.assertRaises(ValueError):q.expected_profit(2,.6,.6)
 def test_asian_split(self):self.assertAlmostEqual(q.expected_split_profit(2,.2,.2,.2,.2,.2),0)
 def test_exposures(self):
  self.assertIsNone(q.safe_ratio(1,0));self.assertAlmostEqual(q.efg(40,10,90),.5)
  self.assertAlmostEqual(q.goalie_gsax(3.4,2),1.4)
  self.assertEqual(q.parse_baseball_innings('5.2'),17)
  self.assertAlmostEqual(q.innings_from_outs(17),5+2/3)
  with self.assertRaises(ValueError):q.parse_baseball_innings('5.3')
 def test_shrinkage(self):self.assertAlmostEqual(q.posterior_rate(0,0,.3,10),.3)
 def test_asof_fail_closed(self):
  records=[{'record_id':'A','revision':1,'known_at':'2024-01-01T10:00:00Z','v':1},{'record_id':'A','revision':2,'known_at':'2024-01-01T12:00:00Z','v':2},{'record_id':'B','revision':1,'known_at':None,'v':7},{'record_id':'C','revision':1,'known_at':'2024-01-02T12:00:00Z','v':9}]
  self.assertEqual(q.asof_versions(records,'2024-01-01T11:00:00Z')[0]['v'],1)
  self.assertEqual(len(q.asof_versions(records,'2024-01-01T13:00:00Z')),1)
  self.assertEqual(q.asof_versions(records,'2024-01-01T13:00:00Z')[0]['v'],2)
if __name__=='__main__':unittest.main()
