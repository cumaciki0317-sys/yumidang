#!/usr/bin/env python3
"""검토한 합성121 archive의 새 격리 사본에서 고정된 신규 서버 SQL만 검사. 기본 실행 없음.

기존 컨테이너/네트워크/볼륨·archive는 읽기만 한다. 새 대상은 network none,
port/volume 없이 생성하고 정확한 신규 ID만 한 번 중지·보존한다.
실제 Auth/운영/Storage 전체 복원 검증을 대신하지 않는다.
"""
import argparse
import hashlib
import types
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

ROOT=Path(__file__).resolve().parents[2]
SELF='tools/local/run_ai_consent_scratch.py'
CONTEXT='colima-yumidang-minkyu'
HOST='unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock'
DAEMON='879401ec-e2b7-4ad8-9915-0a16ea74e3f5'
IMAGE='sha256:28f0e16a019e648089fc1a6d333549a55548f6019c15ae4bd7cd58b989027518'
ARCHIVE=Path('/private/tmp/yumidang-db121-20261019-b003/capture-execution')
ARCHIVE_PINS={'source.dump':'c741bec810faeb83b217a37aa8df865bd6499827e27a7099506d167c593706bf','roles.sql':'e3c775a7e3f96c947d53e72ea9e803e8d0d812b8eb3d4a9286147ed1914cecf3'}
SQL='backend/supabase/migrations/20261020100000_ai_independent_consents.sql'
# KOPIS124는 정적 검토 scope 등록이다. 이 목록 추가로 실제 SQL/Auth/운영 검증이 완료되지 않는다.
MIGRATIONS=[SQL,'backend/supabase/migrations/20261020130000_post_private_events.sql',
 'backend/supabase/migrations/20261021120000_kopis_verified_snapshots.sql']
CONCURRENT_HELPER='tests/integration/minkyu/ai_consent_concurrent_local.py'
CONCURRENT_FIXTURE='tests/database/minkyu/ai_consent_concurrent_fixture.sql'
ADDITIONAL_SOURCES=(CONCURRENT_HELPER,CONCURRENT_FIXTURE)
TESTS=['tests/database/minkyu/post_manual_events.sql','tests/database/minkyu/ai_independent_consents.sql','tests/database/minkyu/current_summary_fences.sql','tests/database/minkyu/current_completion_consent_policy.sql',
 'tests/database/minkyu/kopis_verified_snapshots.sql']
def need(ok,code):
 if not ok:raise ValueError(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def canon(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def mount_digest(mounts):
 # Docker inspect 순서 비결정성만 제거한다. 각 전체 항목과 중복 개수는 보존한다.
 return sha(canon(sorted(canon(x).decode() for x in mounts)))
def assert_preserved(before,after,own):
 expected={**after,'containers':[x for x in after['containers'] if x['id']!=own]}
 need(before==expected,'EXISTING_RESOURCES_CHANGED')
def check_host_transition(before,after,*,first_start):
 if before==after:return after
 restored={**after,'OomKillDisable':False}
 need(first_start and before.get('OomKillDisable') is False and after.get('OomKillDisable','missing') is None and before==restored,'TARGET_CONFIG_CHANGED')
 return after

def source_review(head,pins):
 actual=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()
 need(actual==head and re.fullmatch('[a-f0-9]{40}',head),'HEAD_CHANGED')
 need(set(pins)=={SELF,*MIGRATIONS,*TESTS,*ADDITIONAL_SOURCES},'SOURCE_SET_CHANGED')
 for name,pin in pins.items():
  p=ROOT/name;need(p.resolve()==p and p.is_file() and sha(p.read_bytes())==pin,'SOURCE_CHANGED')
  need(subprocess.check_output(['git','-C',str(ROOT),'show',head+':'+name])==p.read_bytes(),'SOURCE_NOT_COMMITTED')
 need(subprocess.check_output(['git','-C',str(ROOT),'config','yumidang.actor'],text=True).strip()=='minkyu','ACTOR')
 need(subprocess.check_output(['git','-C',str(ROOT),'config','core.hooksPath'],text=True).strip()=='.githooks','HOOK')

def file_identity(s):
 # 실제 읽기가 접근시각을 갱신하는 것은 내용/소유권 변경이 아니다.
 return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def private_raw(path):
 need(path.is_absolute() and path.resolve()==path,'PRIVATE_LINK')
 s=path.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1,'PRIVATE_MODE')
 with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as f:
  need(file_identity(os.fstat(f.fileno()))==file_identity(s),'PRIVATE_CHANGED');raw=f.read(128*1024**2+1)
  need(len(raw)<=128*1024**2 and file_identity(os.fstat(f.fileno()))==file_identity(s) and file_identity(path.lstat())==file_identity(s),'PRIVATE_CHANGED')
 return raw

class Scratch:
 __module_host__=HOST
 def __init__(self,review,output):
  self.review=review;self.output=output;self.target=None;self.seq=0;self.before=None;self.created=None;self.runtime_host=None;self.minimum=None;self.started_at=None;self.init=None;self.start_sent=False;self.concurrent_unclosed=False
 def save(self,name,raw):
  raw=raw if isinstance(raw,bytes) else canon(raw)
  with os.fdopen(os.open(self.output/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as f:f.write(raw)
 def memory(self,start=False):
  p=subprocess.run(['colima','ssh','--profile','yumidang-minkyu','--','cat','/proc/meminfo'],capture_output=True,timeout=3)
  m=re.search(rb'^MemAvailable:\s+(\d+) kB$',p.stdout,re.M);need(p.returncode==0 and m,'MEMORY_UNPROVEN')
  n=int(m[1]);self.minimum=n if self.minimum is None else min(n,self.minimum)
  need(n>=(1048576 if start else 786432),'MEMORY_LOW')
 def docker(self,args,raw=None,*,allow_failure=False,timeout=60):
  self.memory();self.seq+=1
  # command stdin may contain synthetic archive/roles; only private output is retained.
  with tempfile.TemporaryFile() as inp,tempfile.TemporaryFile() as out,tempfile.TemporaryFile() as err:
   if raw is not None:inp.write(raw);inp.seek(0)
   p=subprocess.Popen(['docker','--host',HOST,*args],stdin=inp,stdout=out,stderr=err,start_new_session=True)
   started=time.monotonic()
   interrupted=None
   try:
    while p.poll() is None:
     self.memory();need(time.monotonic()-started<timeout,'COMMAND_TIMEOUT');time.sleep(.3)
   except BaseException as exc:
    interrupted=exc
    try:os.killpg(p.pid,15)
    except ProcessLookupError:pass
    try:p.wait(timeout=3)
    except subprocess.TimeoutExpired:
     try:os.killpg(p.pid,9)
     except ProcessLookupError:pass
     try:p.wait(timeout=3)
     except subprocess.TimeoutExpired:interrupted=ValueError('CHILD_NOT_CLOSED')
   out.seek(0);err.seek(0);stdout=out.read();stderr=err.read()
  self.save(f'command-{self.seq:04d}.json',{'args':args,'exit':p.returncode,'childClosed':p.poll() is not None,'stdoutSha256':sha(stdout),'stderrSha256':sha(stderr)})
  self.save(f'command-{self.seq:04d}.stdout',stdout);self.save(f'command-{self.seq:04d}.stderr',stderr)
  if interrupted is not None:raise interrupted
  need(p.poll() is not None,'CHILD_NOT_CLOSED')
  need(allow_failure or p.returncode==0,'COMMAND_FAILED')
  return stdout,p.returncode
 def inventory(self):
  need(self.docker(['info','--format','{{.ID}}'])[0].decode().strip()==DAEMON,'DAEMON_CHANGED')
  ids=self.docker(['ps','-a','--no-trunc','--format','{{.ID}}'])[0].decode().splitlines()
  rows=json.loads(self.docker(['inspect',*ids])[0]) if ids else []
  containers=[{'id':x['Id'],'name':x['Name'],'image':x['Image'],'config':sha(canon(x['Config'])),'host':sha(canon(x['HostConfig'])),'mounts':mount_digest(x['Mounts']),'running':x['State']['Running'],'startedAt':x['State']['StartedAt'],'restart':x['RestartCount']} for x in rows]
  networks=self.docker(['network','ls','--no-trunc','--format','{{.ID}}'])[0].decode().splitlines()
  volumes=self.docker(['volume','ls','--format','{{.Name}}'])[0].decode().splitlines()
  ns=json.loads(self.docker(['network','inspect',*networks])[0]) if networks else []
  vs=json.loads(self.docker(['volume','inspect',*volumes])[0]) if volumes else []
  # network none의 이번 신규 연결만 비교에서 제외하고 다른 항목은 그대로 보존한다.
  for n in ns:
   if n.get('Name')=='none' and self.target is not None:
    n['Containers']={k:v for k,v in (n.get('Containers') or {}).items() if k!=self.target}
  return {'containers':sorted(containers,key=lambda x:x['id']),'networks':sorted(ns,key=lambda x:x['Id']),'volumes':sorted(vs,key=lambda x:x['Name'])}
 def guard(self):
  source_review(self.review['head'],self.review['pins'])
  for name,pin in ARCHIVE_PINS.items():need(sha(private_raw(ARCHIVE/name))==pin,'ARCHIVE_CHANGED')
  if self.before is not None:assert_preserved(self.before,self.inventory(),self.target)
 def validate_created(self,x):
  c=x['Config'];h=x['HostConfig'];labels=c.get('Labels') or {}
  networks=x.get('NetworkSettings',{}).get('Networks') or {}
  need(set(networks)=={'none'} or (not networks and not x['State']['Running']),'TARGET_NETWORK_CHANGED')
  need(all(not row.get(key) for row in networks.values() for key in ('IPAddress','GlobalIPv6Address','Gateway','IPv6Gateway')),'TARGET_NETWORK_ADDRESS')
  need(x['Image']==IMAGE and x['Name']=='/'+self.review['name'] and not x['Mounts']
   and h['NetworkMode']=='none' and not h.get('PortBindings') and h['Memory']==536870912 and h['MemorySwap']==536870912
   and h['PidsLimit']==128 and h['NanoCpus']==500000000 and h['LogConfig']['Type']=='none' and not h.get('AutoRemove')
   and h.get('RestartPolicy',{}).get('Name') in ('no','') and c['User']=='postgres' and c['Entrypoint']==['sh']
   and c['Cmd']==['-c',self.init] and c.get('Healthcheck',{}).get('Test')==['NONE']
   and labels.get('yumidang.owner')=='minkyu' and labels.get('yumidang.scope')=='AI_CONSENT_ARCHIVE_SCRATCH'
   and labels.get('yumidang.review')==sha(canon(self.review)),'CREATED_CONFIGURATION')
 def own(self,first=False,final=False):
  need(self.target and all(x['id']!=self.target for x in self.before['containers']),'EXACT_NEW_TARGET_REQUIRED')
  x=json.loads(self.docker(['inspect',self.target])[0])[0]
  need(x['Id']==self.target and x['Config']==self.created['Config'] and x['Image']==IMAGE and not x['Mounts'] and x['RestartCount']==0,'TARGET_CHANGED')
  check_host_transition(self.created['HostConfig'] if self.runtime_host is None else self.runtime_host,x['HostConfig'],first_start=first)
  self.validate_created(x)
  need(not x['State']['OOMKilled'] and not x['State']['Restarting'],'TARGET_STATE_CHANGED')
  if first:
   need(self.started_at is None and self.created['State']['Status']=='created' and self.created['State']['StartedAt']=='0001-01-01T00:00:00Z' and x['State']['Running'] and x['State']['StartedAt']!='0001-01-01T00:00:00Z','FIRST_START_ONLY')
   self.started_at=x['State']['StartedAt'];self.runtime_host=x['HostConfig'];self.save('after-start-private.json',canon(x))
  elif self.started_at is not None:
   need(x['State']['StartedAt']==self.started_at and (final or x['State']['Running']),'TARGET_INCARNATION_CHANGED')
  else:need(x['State']['Status']=='created' and not x['State']['Running'],'UNREVIEWED_START')
  return x
 def read_archive(self,name):
  raw=private_raw(ARCHIVE/name);need(sha(raw)==ARCHIVE_PINS[name],'ARCHIVE_CHANGED');return raw
 def read_source(self,name):
  p=ROOT/name;need(p.resolve()==p,'SOURCE_LINK');raw=p.read_bytes();need(sha(raw)==self.review['pins'][name],'SOURCE_CHANGED');return raw
 def sql(self,raw):
  self.guard();self.own()
  return self.docker(['exec','-i',self.target,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/var/run/postgresql','-U','supabase_admin','-d','postgres'],raw)[0]
 def additional_checks(self):
  self.guard();self.own()
  raw=self.read_source(CONCURRENT_HELPER)
  module=types.ModuleType('reviewed_ai_consent_concurrent_local');module.__file__=str(ROOT/CONCURRENT_HELPER)
  exec(compile(raw,module.__file__,'exec'),module.__dict__)
  result=module.run(self)
  self.guard();self.own()
  need(result.get('status')=='PASS_SYNTHETIC_SQL_CONCURRENCY_ONLY','CONCURRENT_CHECK_NOT_PROVEN')
  return result
 def run(self):
  error=None;status='FAIL_CLOSED';stopped=False
  try:
   self.guard();self.before=self.inventory();self.save('existing-before-private.json',self.before)
   image=json.loads(self.docker(['image','inspect',IMAGE])[0])[0]
   need(image['Id']==IMAGE and not image['Config'].get('Volumes'),'IMAGE_CHANGED')
   self.memory(start=True)
   name=self.review['name'];need(re.fullmatch('yumidang-ai-consent-scratch-[a-f0-9]{8}',name),'NAME')
   need(not any(x['name']=='/'+name for x in self.before['containers']),'NAME_EXISTS')
   init="initdb -U supabase_admin -D /tmp/ai-consent-data --auth-local=trust --auth-host=reject --encoding=UTF8 && exec postgres -D /tmp/ai-consent-data -c config_file=/etc/postgresql/postgresql.conf -c data_directory=/tmp/ai-consent-data -c hba_file=/tmp/ai-consent-data/pg_hba.conf -c listen_addresses='' -c unix_socket_directories=/var/run/postgresql -c ssl=off -c cron.database_name=postgres -c cron.launch_active_jobs=off -c shared_buffers=16MB -c max_connections=40"
   self.init=init
   self.save('create-intent.json',{'name':name,'reviewSha256':sha(canon(self.review)),'attempt':1,'noReplay':True})
   out,_=self.docker(['create','--pull=never','--name',name,'--network','none','--memory','512m','--memory-swap','512m','--pids-limit','128','--cpus','0.5','--log-driver','none','--no-healthcheck','--label','yumidang.owner=minkyu','--label','yumidang.scope=AI_CONSENT_ARCHIVE_SCRATCH','--label','yumidang.review='+sha(canon(self.review)),'--user','postgres','--entrypoint','sh',IMAGE,'-c',init])
   self.target=out.decode().strip();need(re.fullmatch('[a-f0-9]{64}',self.target),'NEW_ID')
   self.created=json.loads(self.docker(['inspect',self.target])[0])[0];self.save('created-private.json',self.created);self.validate_created(self.created)
   self.guard();self.save('start-intent.json',{'id':self.target,'attempt':1,'noReplay':True});self.start_sent=True;self.docker(['start',self.target]);self.own(first=True)
   ready=False
   for _ in range(40):
    self.own();_,code=self.docker(['exec',self.target,'pg_isready','-h','/var/run/postgresql','-U','supabase_admin'],allow_failure=True)
    if code==0:ready=True;break
   need(ready,'TARGET_NOT_READY')
   role_sql='\n'.join(x for x in self.read_archive('roles.sql').decode().splitlines() if not re.match(r'CREATE ROLE supabase_admin(?: |;)',x))
   self.sql(role_sql.encode());self.guard();self.own()
   # Full synthetic archive into this new scratch only; this is not a full-restore acceptance claim.
   self.docker(['exec',self.target,'dropdb','-h','/var/run/postgresql','-U','supabase_admin','--force','--maintenance-db=template1','postgres'])
   self.guard();self.own();self.docker(['exec','-i',self.target,'pg_restore','-h','/var/run/postgresql','-U','supabase_admin','-d','template1','--create','--exit-on-error'],self.read_archive('source.dump'))
   baseline=self.sql(b"select count(*) from private.ai_account_budget_reservations where unknown_at is not null and settled_at is null;")
   need(baseline.strip()==b'2','SYNTHETIC_UNKNOWN_BASELINE')
   for migration in MIGRATIONS:self.sql(self.read_source(migration))
   for test in TESTS:self.sql(self.read_source(test))
   self.additional_checks()
   need(self.sql(b"select count(*) from private.ai_account_budget_reservations where unknown_at is not null and settled_at is null;")==baseline,'UNKNOWN_CHANGED')
   self.guard();status='PASS_SQL_ONLY'
  except BaseException as exc:error=type(exc).__name__+':'+str(exc) if isinstance(exc,ValueError) else type(exc).__name__
  finally:
   # create 응답 유실/메모리 거절도 이름+검토 label+기존 ID 제외로 자기 대상만 발견한다.
   if self.created is None and self.before is not None and self.init is not None:
    try:
     found,_=self.docker(['ps','-a','--no-trunc','--format','{{.ID}}','--filter','name=^/'+self.review['name']+'$','--filter','label=yumidang.review='+sha(canon(self.review))])
     ids=found.decode().splitlines();need(len(ids)<=1,'CREATE_DISCOVERY_AMBIGUOUS')
     if ids:
      need(all(x['id']!=ids[0] for x in self.before['containers']),'EXISTING_DISCOVERY_REFUSED')
      x=json.loads(self.docker(['inspect',ids[0]])[0])[0]
      need(x['Image']==IMAGE and x['Name']=='/'+self.review['name'] and not x['Mounts'] and x['HostConfig']['NetworkMode']=='none' and not x['HostConfig'].get('PortBindings') and x['RestartCount']==0,'DISCOVERED_TARGET_CHANGED')
      self.validate_created(x);self.target=ids[0];self.created=x;self.runtime_host=x['HostConfig'];self.started_at=x['State']['StartedAt'] if x['State']['Running'] else None;self.save('discovered-private.json',x)
    except BaseException:pass
   if self.target and self.created:
    try:
     need(not self.concurrent_unclosed,'STOP_WITH_UNCLOSED_CONCURRENT_ACTORS_REFUSED')
     if self.runtime_host is None and self.start_sent:
      x=json.loads(self.docker(['inspect',self.target])[0])[0]
      if x['State']['Running']:self.own(first=True)
     self.own();self.save('stop-intent.json',{'id':self.target,'attempt':1,'noReplay':True});self.docker(['stop','--time','10',self.target]);x=self.own(final=True);stopped=not x['State']['Running'] and x['State']['ExitCode']==0 and not x['State']['OOMKilled']
    except BaseException:stopped=False
   preserved=False
   if self.before is not None:
    try:
     after=self.inventory();self.save('existing-after-private.json',after);assert_preserved(self.before,after,self.target);source_review(self.review['head'],self.review['pins']);
     for name,pin in ARCHIVE_PINS.items():need(sha(private_raw(ARCHIVE/name))==pin,'ARCHIVE_CHANGED')
     preserved=True
    except BaseException:pass
   result={'status':status if stopped and preserved else 'FAIL_CLOSED','targetId':self.target,'targetStopped':stopped,'existingPreserved':preserved,'existingStoredBytes':'NOT_VERIFIED','minimumAvailableKiB':self.minimum,'sourceHead':self.review['head'],'error':error,'scope':'SYNTHETIC_ARCHIVE_REVIEWED_SERVER_SQL_ONLY','migrationFiles':MIGRATIONS,'testFiles':TESTS,'additionalCheckFiles':list(ADDITIONAL_SOURCES),'concurrentActorsClosed':not self.concurrent_unclosed,'actualAuth':'NOT_RUN','operatingChanged':False,'fullRestore':False,'realMembers':False,'providerCalls':0,'automaticReplay':False}
   self.save('receipt.json',result)
  return result

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--review',type=Path);p.add_argument('--sha256');p.add_argument('--output',type=Path);p.add_argument('--run',action='store_true');a=p.parse_args()
 if not a.run:print(json.dumps({'status':'NOT_RUN','scope':'SYNTHETIC_ARCHIVE_REVIEWED_SERVER_SQL_ONLY','migrationFiles':MIGRATIONS,'testFiles':TESTS,'additionalCheckFiles':list(ADDITIONAL_SOURCES)}));return
 need(a.review and a.output and a.sha256,'REVIEW_REQUIRED');raw=private_raw(a.review);need(sha(raw)==a.sha256,'REVIEW_CHANGED');v=json.loads(raw)
 need(set(v)=={'head','pins','name'} and type(v['pins']) is dict,'REVIEW_SHAPE');source_review(v['head'],v['pins'])
 need(a.output.parent.resolve()==a.output.parent and a.output.parent==a.review.parent and not a.output.exists(),'FRESH_PRIVATE_OUTPUT')
 s=a.output.parent.stat();need(s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o700,'OUTPUT_PARENT')
 a.output.mkdir(mode=0o700);r=Scratch(v,a.output).run();print(json.dumps(r));raise SystemExit(0 if r['status']=='PASS_SQL_ONLY' else 1)
if __name__=='__main__':main()
