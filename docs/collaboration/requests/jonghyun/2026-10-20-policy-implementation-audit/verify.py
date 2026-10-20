#!/usr/bin/env python3
"""Validate audit coverage, real evidence references and document preservation; no product calls."""
from pathlib import Path
import collections,hashlib,json,re,subprocess,sys
from urllib.parse import unquote
B=Path(__file__).resolve().parent;R=B.parents[4];issues=[]
def check(ok,why):
 if not ok:issues.append(why)
def load(n):return json.loads((B/n).read_text())
a=load('audit.json');p=load('policy-units.json');ids={u['id'] for u in a['units']}
check(len(ids)==len(a['units']),'duplicate policy IDs')
check(hashlib.sha256((R/'정책.md').read_bytes()).hexdigest()==a['policy_sha256']==p['sha256'],'stale policy hash')
for arr,key in [('groups','id'),('gates','id'),('cases','id'),('decisions','id')]:
 vals=[x[key] for x in a[arr]];check(len(set(vals))==len(vals),'duplicate '+arr+' ID')
groups={x['id'] for x in a['groups']};gates={x['id'] for x in a['gates']};cases={x['id'] for x in a['cases']}
for u in a['units']:
 check(bool(u['group_ids']),u['id']+' no source audit mapping')
 check(bool(u['gate_ids']),u['id']+' no gate mapping')
 check(set(u['group_ids'])<=groups,u['id']+' missing group')
 check(set(u['gate_ids'])<=gates,u['id']+' missing gate')
 l=(R/'정책.md').read_text().splitlines()[u['line']-1]
 check((l[2:] if l.startswith('- ') else l)==u['text'],u['id']+' stale policy text')
refs=[]
for g in a['groups']:
 check(set(g['policy_ids'])<=ids,g['id']+' unknown policy')
 check(all(g.get(k) for k in ['title','policy_summary','actual','classification','source_refs','owner','next_action','acceptance']),g['id']+' missing required description')
 check(g['runtime_status']=='NOT_RUN',g['id']+' invented runtime PASS')
 refs+=g.get('source_refs',[])+g.get('evidence_refs',[])
for g in a['gates']:
 check(set(g['policy_ids'])<=ids,g['id']+' unknown policy')
 check(all(g.get(k) for k in ['title','requirement','required_evidence','current_status','missing','agreement']),g['id']+' missing gate details')
 refs+=g.get('existing_evidence',[])
for c in a['cases']:
 check(c['gate_id'] in gates,c['id']+' missing gate')
 check(set(c['policy_ids'])<=ids,c['id']+' unknown policy')
 check(all(c.get(k) for k in ['environment','actor','preconditions','steps','expected','forbidden','evidence_required','cleanup','owner']),c['id']+' incomplete executable case')
 check(c['result']=='NOT_RUN',c['id']+' invented new test run')
 refs+=c.get('existing_evidence',[])
for r in refs:
 if isinstance(r,str):r={'path':r}
 path=r.get('path','').split('#')[0]
 if not path or path.startswith(('http:','https:')):continue
 fp=R/unquote(path);check(fp.is_file(),'missing evidence '+path)
 if fp.is_file() and r.get('line'):
  check(1<=int(r['line'])<=len(fp.read_text().splitlines()),'invalid source line '+str(r))
originals=load('decision-records.json')['original_sources']
for f in originals:
 check(hashlib.sha256((R/f['path']).read_bytes()).hexdigest()==f['sha256'],'user original mutated '+f['path'])
 check(subprocess.check_output(['git','show',a['baseline']+':'+f['path']],cwd=R)==(R/f['path']).read_bytes(),'original differs from baseline '+f['path'])
for d in a['documents']:
 check((R/d['path']).is_file(),'missing document '+d['path'])
 check(hashlib.sha256((R/d['path']).read_bytes()).hexdigest()==d['after_sha256'],'stale document '+d['path'])
 check(bool(d.get('kind') and d.get('reason')),'unclassified document '+d['path'])
check(len(a['documents'])==len(load('document-inventory.json')['tracked_documents']),'document inventory omitted files')
changed=subprocess.check_output(['git','diff','--name-only','-z',a['baseline']],cwd=R).decode().split('\0')
for name in filter(None,changed):
 check(name.endswith(('.md','.html')) or '/2026-10-20-policy-implementation-audit/' in name,'product source changed '+name)
for q in a['questions']:check(len(q['options'])==3 and bool(q.get('recommendation') and q.get('example')),q['id']+' incomplete choices')
# Check current-policy links and newly added Markdown destinations without treating historical dead paths as current links.
newlinks=[]
diff=subprocess.check_output(['git','-c','core.quotePath=false','diff','--unified=0',a['baseline'],'--','*.md'],cwd=R,text=True);file=None
for line in diff.splitlines():
 if line.startswith('+++ b/'):file=line[6:]
 elif line.startswith('+') and not line.startswith('+++') and file:
  for target in re.findall(r'\]\(([^)]+)\)',line[1:]):
   target=target.strip('<>').split('#')[0]
   if not target or target.startswith(('http:','https:','mailto:','/private/tmp/','/Users/')):continue
   newlinks.append((file,target));check((R/file).parent.joinpath(unquote(target)).exists(),'new link missing '+file+' -> '+target)
# The published report links to a receipt written after the push; require it in --final mode.
if '--final' in sys.argv:
 receipt=load('remote-verification.json');check(receipt.get('verified') is True,'remote verification not complete');check(receipt.get('local_head')==receipt.get('remote_head'),'HEAD mismatch')
report={'status':'PASS' if not issues else 'FAIL','policy_items':len(ids),'source_groups':len(groups),'gates':len(gates),'qa_cases':len(cases),'documents':len(a['documents']),'source_and_evidence_references':len(refs),'original_user_forms_preserved':len(originals),'new_markdown_links_checked':len(newlinks),'issues':issues,'scope':'audit integrity and document coverage only; no product/runtime tests'}
(B/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False,indent=2));sys.exit(bool(issues))
