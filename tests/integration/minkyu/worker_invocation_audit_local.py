"""SQL109 실제 격리 검사. SQL108 원본은 읽기만 하며 새 clone의 회귀는 rollback한다."""
import hashlib,json,os,re,subprocess,sys
from pathlib import Path
import product_connection_restore108_local as recovery
import queue_tls_environment as t

ROOT=Path('/private/tmp/yumidang-invocation109-20261009-v1')
NAME='yumidang-minkyu-invocation109-20261009-v1'
REPO=Path(__file__).resolve().parents[3]
MIGRATION=REPO/'backend/supabase/migrations/20261009010900_worker_invocation_audit.sql'
TEST=REPO/'tests/database/minkyu/worker_invocation_audit.sql'
BACKUP=Path('/private/tmp/yumidang-full108-20261009-v3')

def save(name,content):
 with os.fdopen(os.open(ROOT/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb')as stream:stream.write(content)

def call(args,data=None):
 result=subprocess.run(args,input=data,capture_output=True,timeout=120)
 if result.returncode:
  save('failure-'+str(__import__('uuid').uuid4())+'.log',result.stdout+result.stderr)
  raise RuntimeError('INVOCATION109_FAILED_PRIVATE_EVIDENCE_PRESERVED')
 return result.stdout

def query(sql):
 return call(t.DOCKER+['exec','-i',NAME,'psql','-XqAt','-U',recovery.BOOT,'-d','postgres','-v','ON_ERROR_STOP=1'],sql.encode())

def source(sql):return t.sql(sql)

def prepare():
 assert not ROOT.exists(),'EXISTING_INVOCATION109_PRESERVED'
 ROOT.mkdir(mode=0o700)
 existing=call(t.DOCKER+['ps','-a','--format','{{.Names}}']).decode().splitlines()
 assert NAME not in existing,'EXISTING_CLONE_PRESERVED'
 expected=json.loads((BACKUP/'source-comparison-private.json').read_text())['rows']
 assert recovery.read_database_row_digests(source)==expected,'SOURCE_SQL108_CHANGED'
 receipt=json.loads((BACKUP/'receipt.json').read_text())
 dump=BACKUP/'source.dump'
 assert hashlib.sha256(dump.read_bytes()).hexdigest()==receipt['dumpSha256'],'BACKUP_HASH_CHANGED'
 roles=re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;',';',(BACKUP/'roles.sql').read_text())
 roles='\n'.join(line for line in roles.splitlines()if not re.match(r'(CREATE|ALTER) ROLE yumidang_tls_bootstrap(?: |;)',line))
 recovery.restore(NAME,dump,roles)
 assert recovery.read_database_row_digests(query)==expected,'CLONE_SQL108_ROWS_CHANGED'
 save('prepared.json',json.dumps({'sourceChanged':False,'clone':NAME,'sourceDumpSha256':receipt['dumpSha256']}).encode())
 print('INVOCATION109_CLONE_PREPARED_NOT_ACTIVATED')

def apply_and_test():
 assert(ROOT/'prepared.json').is_file(),'PREPARE_FIRST'
 assert not(ROOT/'receipt.json').exists(),'EXISTING_RECEIPT_PRESERVED'
 source_before=recovery.read_database_row_digests(source)
 control=query("select to_regclass('private.worker_invocation_control');").decode().strip()
 migration=MIGRATION.read_bytes();test=TEST.read_bytes()
 if control:
  assert(ROOT/'applied.json').is_file(),'UNRECORDED_APPLY_INSPECT_NO_RETRY'
  assert json.loads((ROOT/'applied.json').read_text())['sha256']==hashlib.sha256(migration).hexdigest(),'APPLIED_SOURCE_CHANGED'
 else:
  query(migration.decode())
  save('applied.json',json.dumps({'sha256':hashlib.sha256(migration).hexdigest(),'operatingChanged':False}).encode())
 before=recovery.read_database_row_digests(query)
 assert all(before.get(k)==v for k,v in source_before.items()),'EXISTING_SOURCE_ROWS_CHANGED_IN_CLONE'
 assert query('select enabled from private.worker_invocation_control;').decode().strip()=='f','DEFAULT_OPEN'
 # All synthetic cleanup occurs inside the same transaction that the scratch test rolls back.
 prelude='begin;truncate private.worker_jobs,private.worker_runtime_intents,private.worker_runtime_results,private.worker_runtime_job_slots,private.member_cleanup_dispatches cascade;\n'
 query(prelude+re.sub(r'(?m)^begin;\n','',test.decode(),count=1))
 assert recovery.read_database_row_digests(query)==before,'SCRATCH_DID_NOT_ROLL_BACK'
 assert recovery.read_database_row_digests(source)==source_before,'SOURCE_MUTATED'
 recovery.assert_closed(query)
 receipt={'status':'PASS','scope':'ISOLATED_SQL109_DATABASE','migrationSha256':hashlib.sha256(migration).hexdigest(),
  'testSha256':hashlib.sha256(test).hexdigest(),'allTableRowsRolledBack':True,'casOneDispatch':True,
  'dbIdleAndSettlementEvidence':True,'effectFreeSuccessBlocked':True,'yieldedJobUniqueSlotAndLeaseAudit':True,
  'unknownNewDispatchBlocked':True,'globalLeaseNotExtended':True,'sourceDatabaseChanged':False,'operatingChanged':False,
  'realHttpAndProductCli':'NOT_RUN','fullFiveKinds':'NOT_RUN'}
 save('receipt.json',json.dumps(receipt,ensure_ascii=False,indent=2).encode())
 print(json.dumps(receipt,ensure_ascii=False))

if __name__=='__main__':
 if sys.argv[1:]==['--prepare']:prepare()
 elif sys.argv[1:]==['--apply-test']:apply_and_test()
 else:raise SystemExit('INVALID_ARGUMENTS')
