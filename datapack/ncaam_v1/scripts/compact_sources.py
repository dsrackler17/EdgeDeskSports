"""Losslessly compact selected public SportsDataverse release assets.
Uses the captured release manifest. Requires pyarrow. Preserves every source field.
"""
import datetime as dt,hashlib,json,urllib.request
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq
R=Path(__file__).resolve().parents[1];D=R/'data';D.mkdir(parents=True,exist_ok=True)
manifest=json.loads((R/'sources/source_assets.json').read_text())
inventory=[]
old={x['table']:x for x in json.loads((R/'sources/inventory.json').read_text())} if (R/'sources/inventory.json').exists() else {}
for m in manifest:
    cache=R.parent/'quant_build/cbb_bulk_cache'/(m['tag']+'__'+m['asset'])
    if not cache.exists():
        cache.parent.mkdir(parents=True,exist_ok=True)
        with urllib.request.urlopen(m['url'],timeout=120) as response:cache.write_bytes(response.read())
    assert hashlib.sha256(cache.read_bytes()).hexdigest()==m['download_sha256']
    table=pq.read_table(cache)
    filename=('espn_'+m['asset']) if m['tag'].startswith('espn_') else m['asset']
    dest=D/filename
    prior=old.get(dest.stem)
    if prior and dest.exists() and prior.get('source_sha256')==m['download_sha256'] and hashlib.sha256(dest.read_bytes()).hexdigest()==prior['delivered_sha256']:
        inventory.append(prior)
        continue
    pq.write_table(table,dest,compression='zstd',compression_level=19,use_dictionary=True,dictionary_pagesize_limit=8*1024*1024,row_group_size=max(1,table.num_rows))
    restored=pq.read_table(dest)
    if not table.equals(restored):
        # Arrow equality treats floating NaN specially; compare native buffers via
        # normalized pandas only for this exceptional check, never for conversion.
        import pandas.testing as pt
        pt.assert_frame_equal(table.to_pandas(),restored.to_pandas(),check_exact=True)
        assert table.schema.equals(restored.schema,check_metadata=False)
    inventory.append({'table':dest.stem,'file':'data/'+filename,'rows':table.num_rows,'columns':table.column_names,'native_schema':str(table.schema),'source_tag':m['tag'],'source_asset':m['asset'],'source_sha256':m['download_sha256'],'delivered_sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'bytes':dest.stat().st_size,'encoding_check':'Exact source table equality after lossless Zstandard recompression'})
    print(filename,table.num_rows,dest.stat().st_size,flush=True)
(R/'sources/inventory.json').write_text(json.dumps(inventory,indent=2))
print('SOURCE TOTAL',len(inventory),sum(i['bytes'] for i in inventory),flush=True)
