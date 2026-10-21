"""availability 준비/검산 회귀. 실제 Auth·DB·네트워크 0."""
import copy,importlib.util,json,subprocess,sys,unittest,tempfile,types,base64,time,os
from contextlib import contextmanager
from unittest.mock import patch
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('availability',ROOT/'tests/integration/minkyu/ai_availability_local.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class AvailabilityTests(unittest.TestCase):
 def review(self,versions=124):
  tables=sorted(set(m.BUDGET_TABLES)|{'public.t'+str(i)for i in range(177)})
  profile=dict(sourceHead='a'*40,migrationEntriesSha256='b'*64,versions=[str(20261020000000+i)for i in range(versions)],expectedTables=tables,fullTableSetSha256=m.sha(m.canonical(tables)))
  return m.ReviewedAvailabilityPreparation('root-decision','a'*40,{p:'c'*64 for p in(m.SELF,m.FACTORY,m.POSITIVE_FACTORY,m.ROUTE,m.MIGRATION)},profile,'d'*64,'e'*64,'f'*32,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',{k:str(i)*64 for i,k in enumerate(('db','auth','rest','gateway'),1)},'2026-10-21')
 def response(self,state,remaining):return m.canonical(dict(estimatedEligible=state=='estimated_eligible',reason=None if state=='estimated_eligible'else state,remaining=remaining,kstDay='2026-10-21',checkedAt='2026-10-21T03:00:00+00:00',resetsAt='2026-10-21T15:00:00+00:00',requestAuthoritative=True))
 def snapshot(self):return dict(rows={t:{}for t in self.review().descriptor()['profile']['expectedTables']},catalogSha256='a'*64,authoritySha256='b'*64,constraintsSha256='c'*64,sequenceSha256='d'*64,unknownRowsSha256='e'*64)
 def test_default_cli_and_typed_plan_are_not_run(self):
  out=subprocess.check_output([sys.executable,'-B',str(ROOT/m.SELF)]);self.assertEqual(json.loads(out)['status'],'NOT_RUN')
  plan=m.prepare(self.review());self.assertFalse(plan['executionAllowed']);self.assertEqual(plan['originalJwtSeconds'],3600)
  self.assertEqual([c['state']for c in plan['fixtures']],list(m.STATES));self.assertEqual(plan['minimumStartKiB'],1048576)
  with self.assertRaisesRegex(ValueError,'TYPED_REVIEW'):m.prepare(self.review().descriptor())
 def test_current125_or121_not_implicitly_accepted(self):
  for count in(121,125):
   with self.subTest(count=count),self.assertRaisesRegex(ValueError,'CURRENT124'):self.review(count)
 def test_plan_is_defensively_sealed(self):
  review=self.review();d=review.descriptor();d['profile']['expectedTables'].clear();self.assertEqual(len(review.descriptor()['profile']['expectedTables']),182)
 def test_five_exact_server_responses(self):
  for state,remaining in zip(m.STATES,(20,20,0,0,20)):
   proof=m.verify_response(self.response(state,remaining),state,'2026-10-21',remaining);self.assertFalse(proof['actualExecutionProven'])
 def test_response_extra_duplicate_and_bad_authority_rejected(self):
  for raw in(b'{"reason":null,"reason":null}',m.canonical(dict(json.loads(self.response('estimated_eligible',20)),extra=True)),self.response('estimated_eligible',20).replace(b'"requestAuthoritative":true',b'"requestAuthoritative":false')):
   with self.subTest(raw=raw),self.assertRaises(ValueError):m.verify_response(raw,'estimated_eligible','2026-10-21',20)
 def test_server_kst_midnight_reset_exact_not_client_timer(self):
  raw=self.response('estimated_eligible',20).replace(b'15:00:00',b'14:59:59')
  with self.assertRaisesRegex(ValueError,'SERVER_RESET'):m.verify_response(raw,'estimated_eligible','2026-10-21',20)
 def test_boolean_remaining_not_integer(self):
  raw=self.response('daily_limit',0).replace(b'"remaining":0',b'"remaining":false')
  with self.assertRaisesRegex(ValueError,'LIMIT'):m.verify_response(raw,'daily_limit','2026-10-21',0)
 def test_full_182_and_model_zero_required(self):
  s=self.snapshot();self.assertFalse(m.verify_get_preservation(self.review(),s,s,0,0)['actualExecutionProven'])
  for before,after in((1,1),(0,1)):
   with self.assertRaisesRegex(ValueError,'MODEL_DISPATCH'):m.verify_get_preservation(self.review(),s,s,before,after)
 def test_budget_unknown_catalog_sequence_or_duplicate_count_change_rejected(self):
  before=self.snapshot()
  for key in('catalogSha256','authoritySha256','constraintsSha256','sequenceSha256','unknownRowsSha256',*m.BUDGET_TABLES):
   after=copy.deepcopy(before)
   if key in after:after[key]='f'*64
   else:after['rows'][key]={'f'*64:2}
   with self.subTest(key=key),self.assertRaisesRegex(ValueError,'MUTATED_DATABASE'):m.verify_get_preservation(self.review(),before,after,0,0)
 def test_missing_table_not_count_only(self):
  s=self.snapshot();s['rows'].pop(next(iter(s['rows'])))
  with self.assertRaisesRegex(ValueError,'ALL_182'):m.verify_get_preservation(self.review(),s,s,0,0)
 def test_fixed_sql_root_uid_day_scope_and_priority(self):
  review=self.review();plans=[m.fixed_fixture_plan(review,s)for s in m.STATES]
  self.assertEqual(len({p['requestId']for p in plans}),5)
  self.assertTrue(all(not p['executionAllowed']for p in plans));self.assertEqual(len(plans[2]['fixedStatements']),4)
  self.assertTrue(all(len(p['fixedStatements'])==3 for i,p in enumerate(plans)if i!=2))
  for p in plans:
   text=''.join(p['fixedStatements']);self.assertIn(review.descriptor()['userId'],text);self.assertIn("'2026-10-21'::date",text)
  self.assertEqual(m.prepare(review)['fixtures'][2]['startedRequests'],20)
  with self.assertRaises(ValueError):m.fixed_fixture_plan(review,'foreign')
 def test_unreviewed_db_port_cannot_run(self):
  with self.assertRaisesRegex(ValueError,'DB_PORT_NOT_REVIEWED'):m.run_reviewed(self.review())
 @contextmanager
 def execution_lane(self,failure=None):
  review=self.review();v=review.descriptor();v['profile']['migrationEntriesSha256']=m.sha(m.canonical([{'version':ver}for ver in v['profile']['versions']]));log=[];state={'current':None,'failures':failure}
  with tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
   root=Path(directory);product={'backend/supabase/functions/service-api/index.ts':m.sha(b'source')}
   execution=m.ReviewedAvailabilityExecution.__new__(m.ReviewedAvailabilityExecution)
   execution._sealed=m.canonical(dict(preparation=v,sourceKwargs={'root':str(root)},authReceiptRelative='auth-provision-1/receipt.json',nodePath='/fixture/node',nodeSha256='a'*64,capsuleRoot=str(root/'capsule'),productPins=product))
   account={'userId':v['userId'],'sessionId':v['sessionId'],'accessToken':'synthetic.original.jwt'}
   binding={'accounts':[account],'origin':'http://127.0.0.1:57021'}
   (root/'signed-ai-binding-private.json').write_bytes(m.canonical(binding));(root/'auth-provision-1').mkdir()
   (root/'auth-provision-1/receipt.json').write_bytes(m.canonical(dict(status='PASS_LOCAL_AUTH6_PROVISION_ONLY',bindingSha256=v['bindingSha256'],actualGoTrueAndDatabaseSessions=True)))
   class Writer:
    def __init__(self,path):self.path=path;self.output_fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    def check_parents(self):pass
    def save(self,name,value):
     log.append(('save',name));raw=m.canonical(value);(self.path/name).write_bytes(raw);return m.sha(raw)
    def close(self):log.append(('writer_closed',));os.close(self.output_fd)
   class Anchor:
    def __init__(self,*args):pass
    def check(self):pass
    def close(self):log.append(('anchor_closed',))
   class SourceReview:
    def __init__(self,**kwargs):pass
   class Runner:
    def __init__(self,*args):
     import threading
     self.root=root;self.done=threading.Event();self.thread=None;self.failures=[];self.unclosed_child=False
     self.writer=types.SimpleNamespace(private=lambda p:Path(p).read_bytes())
     self.private=types.SimpleNamespace(FixedPair=types.SimpleNamespace(binary=lambda *a:None))
     self.ai=types.SimpleNamespace(signed_claims=lambda t:{'exp':time.time()+3600,'iat':time.time()},validate_signed_binding=lambda *a:None,signed_prepared_target=lambda p:{},product_graph=lambda:product,sealed_runtime_capsule=lambda *a:None,quote=lambda s:"'"+s.replace("'","''")+"'")
     # 정확3600은 두 호출간 시각차 대신 고정 원 claims로 만든다.
     issued=int(time.time());self.ai.signed_claims=lambda t:{'exp':issued+3600,'iat':issued}
    def source(self):return {'target':{},'migrationCount':124,'migrations':[{'version':ver}for ver in v['profile']['versions']]}
    def runtime_source(self):log.append(('source_guard',))
    def read(self,name):
     if name=='signed-provisioning-packet-private.json':return {'containers':{k:{'id':val}for k,val in v['ownIds'].items()},'credentials':{'anon':'synthetic-anon-key'}}
     if name=='owned-first-inspection.json':return [{'Id':v['ownIds']['db'],'HostConfig':{'PidMode':''}}]
     return {}
    def call(self,*args):return v['daemonId']
    def healthy(self):pass
    def baseline_guard(self):return {},{}
    def check_owned(self,*a,**kw):pass
    def memory(self,*a):pass
    def start_monitor(self):
     log.append(('monitor_start',))
     if failure=='late_monitor':
      owner=self
      class LateThread:
       def join(self,timeout):owner.failures.append('MEMORY_MONITOR_FAILED')
       def is_alive(self):return False
      self.thread=LateThread()
    def command(self,argv,timeout):
     packet=json.loads(Path(argv[-1]).read_bytes());case=packet['state'];log.append(('GET',case))
     if failure in('factory','factory_and_cleanup'):raise ValueError('synthetic factory failure')
     body=self_test.response(case,0 if case in('concurrent','daily_limit')else 20)
     return m.canonical(dict(scope='AVAILABILITY_SINGLE_FACTORY_GET',method='GET',path='/functions/v1/service-api/me/ai-availability',automaticReplay=False,databasePreservation='CALLER_REQUIRED',httpStatus=200,calls=1,state=case,scopeId=v['scopeId'],packetSha256=m.sha(m.canonical(packet)),bodyBase64=base64.b64encode(body).decode(),bodySha256=m.sha(body),modelDispatch=0,observations=[dict(origin=binding['origin'],path='/auth/v1/user',method='GET'),dict(origin=binding['origin'],path='/rest/v1/rpc/get_my_ai_availability',method='POST')],networkObserver='NODE_UNDICI_REQUEST_CREATE'))
   self_test=self
   class Transport:
    def __init__(self,*a):self.sticky=False;state['transport']=self
    def run(self,body):
     if body.startswith(b'begin isolation'):
      owned={key:([{'user_id':v['userId']}]if state['current']is not None and key!='results'else[])for key in('processing','daily','chat','results')}
      owned['guard']=[{'singleton':True,'external_processing_allowed':state['current']not in(None,'processing_disabled')}]
      if failure=='snapshot_after_apply'and state['current']is not None:raise ValueError('synthetic snapshot failure')
      rows={t:({m.sha(state['current'].encode()):1}if state['current']else{})for t in v['profile']['expectedTables']}
      return dict(controls='{}',own=json.dumps(dict(processing=0,daily=0,chat=0,results=0,day=v['kstDay'])),ownedrows=json.dumps(owned),sequence='[]',rows=json.dumps(rows))
     text=body.decode()
     if 'delete from'in text:
      if failure in('cleanup','factory_and_cleanup'):raise ValueError('synthetic cleanup failure')
      self_test.assertLess(text.index('lock table'),text.index('delete from'));self_test.assertIn('availability_owned_payload_changed',text)
      log.append(('cleanup',state['current']));state['current']=None;return {'completed':True}
     log.append(('apply',))
     if failure=='write_sticky':self.sticky=True;raise ValueError('synthetic PG unproven')
     if 'external_processing_allowed=false'in text:state['current']='processing_disabled'
     elif 'exploration_allowed,active_request_id)values'in text and ',false,null)'in text:state['current']='consent_required'
     elif 'insert into private.ai_chat_requests'in text:state['current']='concurrent'
     elif ',20);'in text:state['current']='daily_limit'
     else:state['current']='estimated_eligible'
     return {'completed':True}
   @contextmanager
   def support(*args):
    yield ()
    if failure=='context_exit':raise ValueError('synthetic context exit failure')
   source=types.SimpleNamespace(ReviewedCurrentAuthSource=SourceReview,runtime_support=support,CurrentAuthSource=Runner)
   batch=types.SimpleNamespace(PrivateOutputWriter=Writer,PrivateFileAnchor=Anchor,BatchTransport=Transport,kernel_queries=lambda *a:{},control_query=lambda *a:('select 1;',{}),exact=json.loads,batch_sql=lambda q:b'begin isolation',snapshot_from=lambda r,t:{'rows':json.loads(r['rows'])},captured_file=lambda p,d:b'source')
   @contextmanager
   def captured(*args):yield source,batch,{m.KERNEL:b'source',m.FACTORY:b'source','backend/supabase/functions/service-api/index.ts':b'source'}
   with patch.object(m,'captured_support',captured),patch.object(m.subprocess,'check_output',return_value='a'*40):yield execution,log,state,root
 def test_execution_model_all_five_gets_restore_before_next_case_and_receipt_after_exit(self):
  with self.execution_lane()as(review,log,state,root):
   result=m.run_reviewed(review);self.assertEqual(len(result['cases']),5);self.assertIsNone(state['current'])
   self.assertEqual([x[1]for x in log if x[0]=='GET'],list(m.STATES));self.assertEqual(len([x for x in log if x[0]=='cleanup']),5)
   self.assertTrue((root/('availability-'+'f'*32)/'receipt.json').exists())
 def test_execution_model_sticky_write_failure_does_not_dispatch_or_cleanup(self):
  with self.execution_lane('write_sticky')as(review,log,state,root):
   with self.assertRaisesRegex(ValueError,'PG unproven'):m.run_reviewed(review)
   self.assertFalse(any(x[0]in('GET','cleanup')for x in log));self.assertFalse((root/('availability-'+'f'*32)/'receipt.json').exists())
 def test_execution_model_factory_failure_restores_own_fixture_and_preserves_original_error(self):
  with self.execution_lane('factory')as(review,log,state,root):
   with self.assertRaisesRegex(ValueError,'factory failure'):m.run_reviewed(review)
   self.assertIsNone(state['current']);self.assertEqual(len([x for x in log if x[0]=='cleanup']),1)
 def test_service_closure_is_service_entry_and_requires_all_captured_imports(self):
  entry='backend/supabase/functions/service-api/index.ts';child='backend/supabase/functions/_shared/handler.ts'
  captured={entry:b"import {handle} from '../_shared/handler.ts';",child:b'export const handle=1;'}
  self.assertEqual(m.availability_product_graph(captured),{p:m.sha(raw)for p,raw in captured.items()})
  with self.assertRaisesRegex(ValueError,'CLOSURE_MISSING'):m.availability_product_graph({entry:captured[entry]})
  with self.assertRaisesRegex(ValueError,'CLOSURE_MISSING'):m.availability_product_graph({entry:b"import '../../../../outside.ts';"})
 def test_execution_model_snapshot_failure_preserves_unproven_payload_and_no_blind_cleanup(self):
  with self.execution_lane('snapshot_after_apply')as(review,log,state,root):
   with self.assertRaisesRegex(ValueError,'snapshot failure'):m.run_reviewed(review)
   self.assertFalse(any(x[0]in('GET','cleanup')for x in log))
   evidence=root/('availability-'+'f'*32)
   self.assertFalse((evidence/'receipt.json').exists());self.assertTrue((evidence/'processing_disabled-cleanup-failure.json').exists())
 def test_execution_model_cleanup_failure_stops_before_second_get(self):
  with self.execution_lane('cleanup')as(review,log,state,root):
   with self.assertRaisesRegex(ValueError,'cleanup failure'):m.run_reviewed(review)
   self.assertEqual([x[1]for x in log if x[0]=='GET'],['processing_disabled'])
   self.assertFalse((root/('availability-'+'f'*32)/'receipt.json').exists())
 def test_cleanup_requires_original_closed_singleton_and_exact_owned_payload(self):
  v=self.review().descriptor();plan=m.fixed_fixture_plan(self.review(),'concurrent');queries={'guard':'select 1;','processing':'select 2;'}
  for original in([], [{'singleton':True,'external_processing_allowed':True}]):
   with self.assertRaisesRegex(ValueError,'ORIGINAL_GUARD'):m.cleanup_statements(v,plan,{k:[]for k in queries},queries,original)
  with self.assertRaisesRegex(ValueError,'PAYLOAD_UNPROVEN'):m.cleanup_statements(v,plan,{},queries,[{'singleton':True,'external_processing_allowed':False}])
 def test_fixed_write_response_missing_boolean_or_extra_is_not_commit_proof(self):
  for result in ({},{'completed':False},{'completed':1},{'completed':True,'extra':True}):
   transport=types.SimpleNamespace(run=lambda body,result=result:result)
   with self.assertRaisesRegex(ValueError,'FIXED_WRITE_RESULT'):m.run_fixed_write(transport,['select 1;'])
 def test_factory_proof_rejects_boolean_dispatch_external_or_extra(self):
  packet=dict(origin='http://127.0.0.1:57921',scopeId='f'*32);body=self.response('daily_limit',0)
  result=dict(scope='AVAILABILITY_SINGLE_FACTORY_GET',scopeId=packet['scopeId'],state='daily_limit',packetSha256=m.sha(m.canonical(packet)),method='GET',path='/functions/v1/service-api/me/ai-availability',httpStatus=200,bodyBase64=base64.b64encode(body).decode(),bodySha256=m.sha(body),calls=1,automaticReplay=False,modelDispatch=0,observations=[dict(origin=packet['origin'],path='/auth/v1/user',method='GET'),dict(origin=packet['origin'],path='/rest/v1/rpc/get_my_ai_availability',method='POST')],networkObserver='NODE_UNDICI_REQUEST_CREATE',databasePreservation='CALLER_REQUIRED')
  self.assertEqual(m.verify_factory_result(result,packet,'daily_limit'),body)
  for key,value in [('modelDispatch',False),('calls',True),('observations',result['observations']+[dict(origin='https://external.invalid',path='/',method='POST')]),('unexpected',True)]:
   with self.subTest(key=key),self.assertRaises(ValueError):m.verify_factory_result(dict(result,**{key:value}),packet,'daily_limit')
 def test_fixture_lease_is_bounded_but_allows_full_source_guards_before_get(self):
  concurrent=m.fixed_fixture_plan(self.review(),'concurrent')
  self.assertIn("interval '10 minutes'",''.join(concurrent['fixedStatements']))
  self.assertNotIn("interval '60 seconds'",''.join(concurrent['fixedStatements']))
 def test_late_monitor_failure_prevents_receipt_after_all_five_cases(self):
  with self.execution_lane('late_monitor')as(review,log,state,root):
   with self.assertRaisesRegex(ValueError,'LATE_FINALIZATION'):m.run_reviewed(review)
   self.assertEqual(len([x for x in log if x[0]=='GET']),5)
   evidence=root/('availability-'+'f'*32);self.assertFalse((evidence/'receipt.json').exists())
   self.assertFalse(json.loads((evidence/'finalization.json').read_bytes())['closed'])
 def test_factory_and_cleanup_failure_preserve_both_failures_no_receipt(self):
  with self.execution_lane('factory_and_cleanup')as(review,log,state,root):
   with self.assertRaisesRegex(ValueError,'factory failure'):m.run_reviewed(review)
   evidence=root/('availability-'+'f'*32);proof=json.loads((evidence/'processing_disabled-cleanup-failure.json').read_bytes())
   self.assertEqual(proof['originalErrorType'],'ValueError');self.assertEqual(proof['cleanupErrorType'],'ValueError');self.assertFalse(proof['cleanupProven'])
   self.assertFalse((evidence/'receipt.json').exists())
 def test_factory_invalid_private_packet_fails_without_printing_credentials(self):
  import shutil
  node=shutil.which('node')
  if node is None:self.skipTest('Node 미설치 환경')
  with tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
   path=Path(directory)/'packet.json';path.write_text(json.dumps({'token':'never-print-this-token','anon':'never-print-this-key'}));path.chmod(0o600)
   result=subprocess.run([node,'--experimental-strip-types',str(ROOT/m.FACTORY),str(path)],capture_output=True,timeout=5)
   self.assertNotEqual(result.returncode,0);self.assertEqual(json.loads(result.stdout)['status'],'FAIL_CLOSED')
   self.assertNotIn(b'never-print',result.stdout+result.stderr)
 def test_context_exit_failure_keeps_receipt_absent_and_closes_writer_once(self):
  with self.execution_lane('context_exit')as(review,log,state,root):
   with self.assertRaisesRegex(ValueError,'context exit failure'):m.run_reviewed(review)
   self.assertEqual(len([x for x in log if x[0]=='writer_closed']),1)
   self.assertFalse((root/('availability-'+'f'*32)/'receipt.json').exists())
 def test_new_factory_uses_normal_product_factory_and_no_monkeypatch(self):
  source=(ROOT/m.FACTORY).read_text();self.assertIn('createRuntimeHandler',source);self.assertIn("method:'GET'",source)
  self.assertNotIn('globalThis.fetch=',source);self.assertNotIn('global.fetch=',source)
  self.assertLess(source.index('trace.subscribe(subscriber)'),source.index('await import'));self.assertIn("modelDispatch:0",source);self.assertIn("undici:request:create",source);self.assertIn('65536',source)
if __name__=='__main__':unittest.main()
