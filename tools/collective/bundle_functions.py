#!/usr/bin/env python3
"""Bundle each Collective edge function into ONE self-contained file so it
can be pasted into the Supabase dashboard's function editor (which takes a
single index.ts). Inlines the _shared modules in dependency order, strips
import lines and export keywords, and keeps everything else verbatim."""
import re, os, sys

ROOT = 'supabase/functions'
OUT = 'supabase/functions-bundled'
SHARED_ORDER = ['env.ts', 'http.ts', 'db.ts', 'keys.ts', 'auth.ts', 'reads.ts', 'prompt_template.ts',
                'oddsblaze.ts']
FUNCTIONS = ['collective_ingest', 'collective_public', 'collective_embed',
             'collective_join', 'collective_admin', 'collective_billing',
             'collective_odds']

def strip(src):
    # remove complete import statements first (single or multi line)
    src = re.sub(r'^import\s+\{[^}]*\}\s+from\s+"[^"]+";\s*$', '', src, flags=re.M | re.S)
    src = re.sub(r'^import\s+[^;{]*\s+from\s+"[^"]+";\s*$', '', src, flags=re.M)
    # strip export keywords but keep the declarations
    src = re.sub(r'^export (async function|function|const|class|interface|type)', r'\1', src, flags=re.M)
    return src

os.makedirs(OUT, exist_ok=True)
shared = {}
for f in SHARED_ORDER:
    shared[f] = strip(open(f'{ROOT}/_shared/{f}').read())

ok = True
for fn in FUNCTIONS:
    src = open(f'{ROOT}/{fn}/index.ts').read()
    used = [f for f in SHARED_ORDER if f'/_shared/{f.replace(".ts","")}' in src or f'from "../_shared/{f}"' in src]
    # dependency closure: http->env(no), db->env, auth->env+db, reads->env+db, prompt none
    deps = {'db.ts': ['env.ts'], 'auth.ts': ['env.ts', 'http.ts', 'db.ts'], 'reads.ts': ['env.ts', 'db.ts'],
            'http.ts': [], 'keys.ts': [], 'env.ts': [], 'prompt_template.ts': [], 'oddsblaze.ts': []}
    need = set(used)
    changed = True
    while changed:
        changed = False
        for u in list(need):
            for d in deps.get(u, []):
                if d not in need:
                    need.add(d); changed = True
    parts = [f'// {fn} - SELF-CONTAINED BUNDLE for the Supabase dashboard editor.',
             '// Generated from supabase/functions/ by tools/collective/bundle_functions.py.',
             '// Paste this whole file as index.ts for a function named exactly: ' + fn,
             '// IMPORTANT: turn OFF "Enforce JWT verification" for this function.', '']
    for f in SHARED_ORDER:
        if f in need:
            parts.append(f'// ---------- inlined _shared/{f} ----------')
            parts.append(shared[f])
    parts.append(f'// ---------- {fn}/index.ts ----------')
    parts.append(strip(src))
    bundle = '\n'.join(parts)
    if 'from "../_shared' in bundle or re.search(r'^\s*import ', bundle, flags=re.M):
        print(f'FAIL: {fn} still has imports'); ok = False
    open(f'{OUT}/{fn}.ts', 'w').write(bundle)
    print(f'OK: {OUT}/{fn}.ts ({len(bundle)} bytes, shared: {sorted(need)})')
sys.exit(0 if ok else 1)
