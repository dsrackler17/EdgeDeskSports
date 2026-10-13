import argparse,pathlib,pandas as pd
p=argparse.ArgumentParser();p.add_argument('input');p.add_argument('output');a=p.parse_args()
s=pathlib.Path(a.input);df=pd.read_parquet(s) if s.suffix=='.parquet' else pd.read_csv(s,low_memory=False);df.to_csv(a.output,index=False);print(len(df),'rows exported')
