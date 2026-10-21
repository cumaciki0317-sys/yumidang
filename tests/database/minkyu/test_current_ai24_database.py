"""current AI24 계약·원 snapshot AST 등가·고정 SQL 거절 회귀. 실제 DB/모델은 없다."""
import ast
import hashlib
import importlib.util
import json
import re
import sys
import marshal
import copy
import tempfile
from unittest.mock import patch
from pathlib import Path
import types
import unittest

ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('current_ai24_database',ROOT/'tools/local/current_ai24_database.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
RAW=(ROOT/m.KERNEL).read_bytes()

class CurrentDatabaseTests(unittest.TestCase):
    def tables(self):
        core=set(m.owned_predicates('null','ledger'))|{'auth.users','auth.sessions','auth.identities','auth.refresh_tokens','auth.audit_log_entries','auth.mfa_amr_claims','private.ai_budget_reservations','private.ai_account_budget_reservations','private.ai_account_daily_budget','private.ai_global_daily_budget'}
        return sorted(core|{'public.t'+str(n)for n in range(182-len(core))})
    def profile(self):
        tables=self.tables()
        return dict(sourceHead='a'*40,migrationEntriesSha256='b'*64,versions=[str(20261020000000+n)for n in range(124)],expectedTables=tables,fullTableSetSha256=m.sha(m.canonical(tables)))
    def review(self,operation=None,users=()):
        return m.ReviewedCurrentAI24Database('decision',operation or m.IssuerOperation(),'a'*40,
            {p:'c'*64 for p in (m.SELF,m.PURE,m.KERNEL)},self.profile(),'/private/tmp/ai24-test','scope',
            {k:{'id':str(i)*64}for i,k in enumerate(('db','auth','rest','gateway'),1)},users)
    def test_typed_and_exact_profile(self):
        self.assertEqual(len(self.review().descriptor()['profile']['expectedTables']),182)
        with self.assertRaisesRegex(ValueError,'TYPED_OPERATION'):self.review('issuer')
        with self.assertRaisesRegex(ValueError,'MEMBER_SCOPE'):self.review(m.MidnightOperation())
    def test_explicit125_and_arbitrary126(self):
        profile=self.profile();profile['versions'].append('20261021142140')
        args=('d',m.IssuerOperation(),'a'*40,{p:'c'*64 for p in(m.SELF,m.PURE,m.KERNEL)})
        tail=('/private/tmp/ai24-test','scope',{k:{'id':str(i)*64}for i,k in enumerate(('db','auth','rest','gateway'),1)})
        self.assertEqual(len(m.ReviewedCurrentAI24Database(*args,profile,*tail).descriptor()['profile']['versions']),125)
        profile['versions'][-1]='20261021142141'
        with self.assertRaisesRegex(ValueError,'EXPLICIT125_VERSION'):m.ReviewedCurrentAI24Database(*args,profile,*tail)
        profile['versions'].append('20261021150000')
        with self.assertRaises(ValueError):m.ReviewedCurrentAI24Database(*args,profile,*tail)
    def test_125_consumes_exact_inspector_target_and_literal_hash(self):
        profile=self.profile();profile['versions'].append('20261021142140')
        value=dict(profile=profile,pins={},sourceHead='a'*40)
        entries=[dict(version=v,path='fixture/'+v,sha256='a'*64)for v in profile['versions']]
        entries[-1].update(path=m.DEADLINE125,sha256=m.DEADLINE125_SHA)
        verify=types.SimpleNamespace(verify_current_profile=unittest.mock.Mock(return_value={'entries':entries}))
        with patch.object(m,'checked_source'),patch.object(m,'pinned_module',return_value=verify):
            m.verify_current125(ROOT,value,profile['versions'])
            verify.verify_current_profile.assert_called_once_with(profile,{},'a'*40,profile['versions'])
            entries[-1]['sha256']='0'*64
            with self.assertRaisesRegex(ValueError,'EXPLICIT125_SOURCE'):m.verify_current125(ROOT,value,profile['versions'])
        with patch.object(m,'checked_source'),patch.object(m,'pinned_module',return_value=types.SimpleNamespace(verify_current_profile=unittest.mock.Mock(side_effect=ValueError('HEAD_MANIFEST_OR_TARGET_CHANGED')))):
            with self.assertRaisesRegex(ValueError,'HEAD_MANIFEST_OR_TARGET_CHANGED'):m.verify_current125(ROOT,value,[])
        with patch.object(m,'pinned_module')as load:
            m.verify_current125(ROOT,dict(value,profile=self.profile()),None);load.assert_not_called()
    def test_profile_hash_mutation_rejected(self):
        profile=self.profile();profile['expectedTables'][0]='private.foreign'
        with self.assertRaises(ValueError):m.ReviewedCurrentAI24Database('d',m.IssuerOperation(),'a'*40,{p:'c'*64 for p in(m.SELF,m.PURE,m.KERNEL)},profile,'/private/tmp/ai24-test','scope',{k:{'id':str(i)*64}for i,k in enumerate(('db','auth','rest','gateway'),1)})
    def test_midnight_original_method_ast_exact_result(self):
        tables=self.tables();rows={t:{'f'*64:2}for t in tables};raw_catalog='[ {"p": 1} ]';raw_authority='{"a": 2, "b": 3}'
        queries=m.snapshot_queries(RAW,m.MidnightOperation,tables)
        class Fake:
            def original_rows(self):return rows
            def read_sql(self,query,timeout=5):
                q=query.strip().removesuffix(';')
                return raw_catalog if q==queries['catalog']else raw_authority if q==queries['authority']else (_ for _ in ()).throw(AssertionError(q))
        tree=ast.parse(RAW);cls=next(n for n in tree.body if isinstance(n,ast.ClassDef)and n.name=='SignedMidnightRunner')
        method=next(n for n in cls.body if isinstance(n,ast.FunctionDef)and n.name=='snapshot')
        namespace={'json':json,'hashlib':hashlib}
        exec(compile(ast.Module(body=[method],type_ignores=[]),'<original snapshot>','exec'),namespace)
        original=namespace['snapshot'](Fake())
        envelope={'tables':json.dumps([x.split('.')for x in tables]),'rows':json.dumps(rows),'catalog':raw_catalog,'authority':raw_authority}
        actual,actual_rows=m.decode_snapshot(envelope,m.MidnightOperation,tables)
        self.assertEqual(actual,original);self.assertEqual(rows,actual_rows)
        self.assertNotEqual(actual['catalogSha256'],m.sha(json.dumps(json.loads(raw_catalog)).encode()))
        self.assertEqual(actual['sequence'],'NOT_VERIFIED');self.assertEqual(actual['physical'],'NOT_VERIFIED')
    def test_issuer_original_two_snapshot_methods_ast_exact_result(self):
        tables=self.tables();rows={t:{'a'*64:2}for t in tables}
        queries=m.snapshot_queries(RAW,m.IssuerOperation,tables)
        responses={queries['authority']:'c'*64,queries['catalog']:'{ "x": 1 }',queries['constraints']:'[1,  2]'}
        class Fake:
            def original_rows(self):return rows
            def read_sql(self,query,timeout=5):return responses[query.strip().removesuffix(';')]
        tree=ast.parse(RAW);classes=[]
        for name,parent in (('FixedSignedProvisioningPorts','Fake'),('FixedLifecycleProvisioningPorts','FixedSignedProvisioningPorts')):
            cls=next(n for n in tree.body if isinstance(n,ast.ClassDef)and n.name==name)
            method=next(n for n in cls.body if isinstance(n,ast.FunctionDef)and n.name=='snapshot')
            classes.append(ast.ClassDef(name=name,bases=[ast.Name(id=parent,ctx=ast.Load())],keywords=[],body=[method],decorator_list=[],type_params=[]))
        namespace={'Fake':Fake,'hashlib':hashlib,'re':re}
        exec(compile(ast.fix_missing_locations(ast.Module(body=classes,type_ignores=[])),'<original issuer snapshot>','exec'),namespace)
        original=namespace['FixedLifecycleProvisioningPorts']().snapshot()
        envelope=dict(tables=json.dumps([x.split('.')for x in tables]),rows=json.dumps(rows),authority='c'*64,catalog='{ "x": 1 }',constraints='[1,  2]')
        actual,_=m.decode_snapshot(envelope,m.IssuerOperation,tables)
        self.assertEqual(actual,original)
    def test_issuer_query_sources_preserve_json_text(self):
        queries=m.snapshot_queries(RAW,m.IssuerOperation,self.tables())
        self.assertIn('jsonb_build_object',queries['catalog']);self.assertIn('pg_constraint',queries['constraints'])
        self.assertIn('pg_default_acl',queries['authority']);self.assertNotIn('jsonb_build_object',queries['rows'].split('from(')[0])
    def test_unknown_duplicate_bag_counts_preserved(self):
        tables=self.tables();rows={t:{}for t in tables};rows[tables[0]]={'f'*64:3}
        envelope=dict(tables=json.dumps([x.split('.')for x in tables]),rows=json.dumps(rows),authority='c'*64,catalog='  {"x": 1} ',constraints=' [1, 2] ')
        value,_=m.decode_snapshot(envelope,m.IssuerOperation,tables)
        self.assertEqual(value['rows'][tables[0]]['f'*64],3)
        self.assertEqual(value['catalogSha256'],m.sha(b'{"x": 1}'))
    def test_extra_table_or_envelope_refused(self):
        tables=self.tables();envelope=dict(tables=json.dumps([x.split('.')for x in tables]),rows=json.dumps({t:{}for t in tables}),authority='c'*64,catalog='{}',constraints='[]',extra='x')
        with self.assertRaisesRegex(ValueError,'SNAPSHOT_FIELDS'):m.decode_snapshot(envelope,m.IssuerOperation,tables)
    def test_registry_scope_and_free_sql_refused(self):
        registry=m.FixedOperationRegistry([RAW]);uid='11111111-1111-4111-8111-111111111111'
        owner=types.SimpleNamespace(users=[uid],all_users=[uid],accounts=[])
        query='begin;insert into public.profiles(id,real_name,birth_date,gender)values('+m.quote(uid)+"::uuid,'합성 AI 검증회원','1990-01-01','female');commit;"
        self.assertTrue(registry.permits(query,owner,[uid],'scope',123))
        self.assertFalse(registry.permits(query.replace(uid,'22222222-2222-4222-8222-222222222222'),owner,[uid],'scope',123))
        self.assertFalse(registry.permits('delete from auth.users;',owner,[uid],'scope',123))
        self.assertFalse(registry.permits('select 1',owner,[uid],'scope',123))
    def test_sticky_blocks_before_guard(self):
        db=object.__new__(m.CurrentDatabase);db.sticky=True;calls=[];db.guard=lambda:calls.append('metadata')
        with self.assertRaisesRegex(ValueError,'STICKY'):db.execute(b'select 1',1,True)
        self.assertFalse(calls)
    def test_save_failure_sticky_no_child_or_followup_metadata(self):
        db=object.__new__(m.CurrentDatabase);db.value={'root':'/private/tmp/ai24-capture-no-native-fixture'};db.sticky=False;db.counter=0;db.base=('docker','--host','fixed');db.db='a'*64
        calls=[];db.guard=lambda:calls.append('guard');db.save=lambda *a:(_ for _ in ()).throw(OSError('save'))
        db.child=lambda *a:(_ for _ in ()).throw(AssertionError('child must not start'))
        with self.assertRaises(OSError):db.execute(b'select 1',1,True)
        self.assertTrue(db.sticky);before=len(calls)
        with self.assertRaises(ValueError):db.execute(b'select 1',1,True)
        self.assertEqual(len(calls),before)
    def test_authorization_evidence_save_failure_keeps_sticky(self):
        db=object.__new__(m.CurrentDatabase);db.value={'root':'/private/tmp/ai24-capture-no-native-fixture'};db.sticky=False
        db.registry=types.SimpleNamespace(authorize=lambda *a:{'class':'Runner','method':'digest'})
        db.validate_context=lambda *a:None;db.marker=lambda:'';db.execute=lambda *a:'value';db.counter=1;db.operation_users=[]
        db.save=lambda *a:(_ for _ in ()).throw(OSError('proof save'))
        with self.assertRaises(OSError):db.read_sql('select 1')
        self.assertTrue(db.sticky)
        with self.assertRaisesRegex(ValueError,'STICKY'):db.read_sql('select 1')
    def test_write_lane_closed_even_if_preparation_status_mutated(self):
        db=object.__new__(m.CurrentDatabase);db.value={'root':'/private/tmp/ai24-capture-no-native-fixture'};db.sticky=False;db.preparation_status={'executionAllowed':True}
        with self.assertRaisesRegex(ValueError,'WRITE_COVERAGE_NOT_REVIEWED'):db.sql('select 1')
    def test_partial_registry_coverage_is_not_execution_approval(self):
        source=(ROOT/'tools/local/provision_current_midnight.py').read_text()
        self.assertIn("preparation_status['executionAllowed'] is True",source)
        self.assertIn('ISSUER_DATABASE_WRITE_COVERAGE_NOT_REVIEWED',source)
        prepared=(ROOT/'tools/local/prepare_isolated_midnight.py').read_text()
        self.assertIn('CURRENT_AI24_DATABASE_TYPED_REVIEW_REQUIRED',prepared)
    def test_arbitrary_side_effect_query_absent_from_callsites_refused(self):
        registry=m.FixedOperationRegistry([RAW])
        owner=types.SimpleNamespace(users=[],all_users=[],accounts=[])
        for sql in ("select set_config('role','service_role',false)","begin;delete from public.profiles;commit;","drop table auth.users;"):
            self.assertFalse(registry.permits(sql,owner,[],'scope',0))
    def captured_fixture(self):
        namespace={'__name__':'ai24_actual_code_fixture','__file__':str(ROOT/m.KERNEL)}
        old_path=list(sys.path)
        try:exec(compile(RAW,str(ROOT/m.KERNEL),'exec'),namespace)
        finally:sys.path[:]=old_path
        ai=types.SimpleNamespace(**namespace)
        uid='11111111-1111-4111-8111-111111111111';sid='22222222-2222-4222-8222-222222222222'
        account={'userId':uid,'sessionId':sid,'authEmail':'synthetic-ai-scope-m0@example.invalid'}
        db=object.__new__(m.CurrentDatabase);db.value={'scopeId':'scope','profile':self.profile()};db.reviewed=types.SimpleNamespace(operation=m.IssuerOperation)
        db.users=[];db.initial_accounts=[];db.population=lambda:([uid],[account])
        registry=m.FixedOperationRegistry([RAW,(ROOT/'tools/local/provision_current_midnight.py').read_bytes(),(ROOT/'tools/local/prepare_isolated_midnight.py').read_bytes()])
        class Port(ai.FixedLifecycleProvisioningPorts):
            def __init__(self):self.calls=[]
            def read_sql(self,query,timeout=3):
                match=registry.authorize(query,db.validate_context);self.calls.append((query,match));return '{}'
        owner=Port();db.owner=owner;registry.bind(owner,ROOT,ai)
        return ai,owner,db,registry,uid,sid,account
    def test_actual_code_and_module_identity_dynamic_email(self):
        ai,owner,db,registry,uid,sid,account=self.captured_fixture()
        self.assertIsNone(owner.resolve_email(account['authEmail']))
        self.assertEqual(owner.calls[-1][1]['method'],'resolve_email')
        with self.assertRaisesRegex(ValueError,'FOREIGN_EMAIL'):owner.resolve_email('foreign@example.invalid')
    def test_actual_closed_controls_dynamic_list(self):
        ai,owner,db,registry,*_=self.captured_fixture()
        self.assertEqual(owner.closed_controls(),{})
        self.assertEqual(owner.calls[-1][0],registry.static_controls)
    def test_forged_code_object_with_same_filename_and_lines_refused(self):
        ai,owner,db,registry,uid,sid,account=self.captured_fixture()
        original=ai.FixedSignedProvisioningPorts.resolve_email
        forged=types.FunctionType(marshal.loads(marshal.dumps(original.__code__)),original.__globals__)
        self.assertEqual(forged.__code__,original.__code__);self.assertIsNot(forged.__code__,original.__code__)
        with self.assertRaisesRegex(ValueError,'UNAPPROVED_CALLSITE'):forged(owner,account['authEmail'])
    def test_foreign_globals_with_original_code_refused(self):
        ai,owner,db,registry,uid,sid,account=self.captured_fixture()
        original=ai.FixedSignedProvisioningPorts.resolve_email
        forged=types.FunctionType(original.__code__,dict(original.__globals__))
        with self.assertRaisesRegex(ValueError,'UNAPPROVED_CALLSITE'):forged(owner,account['authEmail'])
    def test_plain_forwarding_query_is_not_approved(self):
        ai,owner,db,registry,*_=self.captured_fixture()
        with self.assertRaisesRegex(ValueError,'UNAPPROVED_CALLSITE'):registry.authorize(registry.static_controls,db.validate_context)
    def runtime_fixture(self):
        ai,owner,db,registry,uid,sid,account=self.captured_fixture()
        users=[uid,'33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555']
        epoch=1761068400
        # 정확 KST 자정. 동적 query의 day 범위를 위해 source epoch를 별도 고정한다.
        epoch=1761068400-((1761068400+32400)%86400)
        accounts=[{'userId':u,'sessionId':str(__import__('uuid').UUID(int=100+i*2+j,version=4)),
            'authEmail':'synthetic-ai-scope-m'+str(i)+'@example.invalid'}for i,u in enumerate(users)for j in range(2)]
        owner.users=list(users);owner.all_users=list(users);owner.boundary_epoch=epoch
        owner.root=Path('/private/tmp/ai24-capture-no-native-fixture');owner.target={'versions':db.value['profile']['versions']}
        owner.binding={'accounts':accounts};owner.scope_id='scope';owner.changed=False;owner.days=set();owner.ledgers=[]
        db.reviewed=types.SimpleNamespace(operation=m.MidnightOperation);db.users=list(users);db.epoch=epoch
        db.value['users']=users;db.binding_accounts_sha=m.sha(m.canonical(accounts));db.population=lambda:(users,accounts)
        owner.accounts=[{'account_id':k,'registered':False,'unit_limit':3200000}for k in('yumi','jonghyun','minkyu','sungho')]
        db.initial_accounts=__import__('copy').deepcopy(owner.accounts)
        def record(query,timeout=3):
            match=registry.authorize(query,db.validate_context);owner.calls.append((query,match))
            if 'schema_migrations' in query:return json.dumps(owner.target['versions'])
            if 'midnightEpoch' in query:return json.dumps({'epoch':epoch-1000,'midnightEpoch':epoch})
            if "select external_processing_allowed from" in query:return 'f\noff'
            if 'select json_agg(to_jsonb(a)' in query:return json.dumps(owner.accounts)
            if query.startswith('select (select count(*)')or query.startswith('select(select count(*)'):return '0'
            if 'started_requests' in query:return '[3,20,3]'
            return '{}'
        owner.read_sql=record;owner.sql=record
        owner.digest=types.MethodType(ai.Runner.digest,owner);owner.protected_rows=types.MethodType(ai.SignedRunner.protected_rows,owner)
        owner.validate_original_accounts=lambda:None;owner.snapshot=lambda:{};owner.save_signed=lambda *a:None
        owner.signed_identity=lambda:None;owner.export_resume_state=lambda:{}
        return ai,owner,db,registry,users,accounts
    def test_dynamic_day_source_assignment_exact_and_foreign_day_refused(self):
        ai,owner,db,registry,users,accounts=self.runtime_fixture()
        day=m.datetime.fromtimestamp(db.epoch,m.timezone(m.timedelta(hours=9))).date()
        self.assertEqual(ai.SignedMidnightRunner.counts(owner,str(day)),[3,20,3])
        self.assertEqual(ai.SignedMidnightRunner.counts(owner,str(day-m.timedelta(days=1))),[3,20,3])
        with self.assertRaisesRegex(ValueError,'FOREIGN_DAY'):ai.SignedMidnightRunner.counts(owner,str(day+m.timedelta(days=1)))
    def test_fixed_activation_and_cleanup_templates_authorize_real_code(self):
        ai,owner,db,registry,users,accounts=self.runtime_fixture()
        ai.SignedMidnightRunner.activate_fixture_registration(owner)
        writes=[(q,x)for q,x in owner.calls if q.startswith('begin;do $midnight$')]
        self.assertEqual(len(writes),1)
        self.assertEqual(m.write_operation(writes[0][1],writes[0][0])['kind'],'activate')
        owner.protected={t:{}for t in('ai_budget_ledgers','ai_budget_reservations','ai_account_budget_reservations','ai_account_daily_budget','ai_global_daily_budget')}
        owner.baseline='{}'
        ai.SignedRunner.clean(owner)
        kinds={m.write_operation(x,q)['kind']for q,x in owner.calls}
        self.assertTrue({'activate','close_guard','cleanup_members','restore_account','readonly'}<=kinds)
    def test_dynamic_metadata_queries_are_exact_for_owned_session(self):
        ai,owner,db,registry,uid,sid,account=self.captured_fixture()
        self.assertFalse(owner.session_proof(account))
        self.assertFalse(owner.metadata_proof(account,'scope','ai24-member-0'))
        owner.added_rows({},[account]);owner.cleanup_audits({'member':{'userId':uid,'authEmail':account['authEmail']}})
        self.assertTrue(any(x['method']=='added_rows'for _,x in owner.calls))
        bad={**account,'sessionId':'99999999-9999-4999-8999-999999999999'}
        with self.assertRaisesRegex(ValueError,'FOREIGN_SESSION'):owner.session_proof(bad)
    def test_fixture_write_templates_exact_owned_ids_and_ledger(self):
        ai,owner,db,registry,users,accounts=self.runtime_fixture()
        owner.changed=True;owner.fixture_baseline={};owner.fixture={};owner.effect_proof=lambda x:None
        owner.start_factory=lambda *a:None
        class StopAfterWrites(Exception):pass
        owner.finish_factory=lambda *a,**kw:(_ for _ in ()).throw(StopAfterWrites())
        with self.assertRaises(StopAfterWrites):ai.SignedMidnightRunner.prepare_units(owner)
        writes=[(q,x)for q,x in owner.calls if q.startswith('insert ')]
        self.assertEqual([m.write_operation(x,q)['kind']for q,x in writes],['processing','ledger'])
        self.assertTrue(all(u in writes[0][0]for u in users));self.assertIn("'signed-midnight-scope'",writes[1][0])
        owner.users=['99999999-9999-4999-8999-999999999999']
        with self.assertRaisesRegex(ValueError,'RUNTIME_SCOPE_CHANGED'):ai.SignedMidnightRunner.prepare_units(owner)
    def test_profile_write_uses_only_exact_receipted_user(self):
        ai,owner,db,registry,uid,sid,account=self.captured_fixture()
        owner.sql=owner.read_sql
        self.assertFalse(owner.link_profile(uid));owner.unlink_profile(uid)
        writes=[(q,x)for q,x in owner.calls if q.startswith('begin;')]
        self.assertEqual([m.write_operation(x,q)['kind']for q,x in writes],['link_profile','unlink_profile'])
        self.assertEqual(m.write_operation(writes[0][1],writes[0][0])['users'],[uid])
        with self.assertRaisesRegex(ValueError,'FOREIGN_USER'):owner.link_profile('99999999-9999-4999-8999-999999999999')
    def test_reviewed_ast_mutation_and_missing_scope_not_autoapproved(self):
        changed=RAW.replace(b"select(clock_timestamp()at time zone'Asia/Seoul')::date;",b"select set_config('role','service_role',false);")
        with self.assertRaisesRegex(ValueError,'UNREVIEWED_METHOD_AST'):m.FixedOperationRegistry([changed])
        registry=m.FixedOperationRegistry([RAW]);self.assertFalse(registry.coverage_complete)
    def delta_fixture(self):
        tables=self.tables();rows={t:{}for t in tables};owned={t:{}for t in m.owned_predicates('null','own')}
        rows['private.ai_budget_reservations']={'a'*64:1};rows['private.ai_account_budget_reservations']={'b'*64:1}
        rows['private.ai_account_daily_budget']={'c'*64:1};rows['private.ai_global_daily_budget']={'d'*64:1}
        rows['public.profiles']={'e'*64:1};rows['private.ai_budget_ledgers']={'f'*64:1}
        accounts=[{'account_id':k,'registered':False,'unit_limit':3200000}for k in('yumi','jonghyun','minkyu','sungho')]
        flags={'accounts':accounts,'guard':[{'singleton':True,'external_processing_allowed':False}]}
        for table,data in [('private.ai_budget_accounts',accounts),('private.ai_processing_guard',flags['guard'])]:
            rows[table]={m.sha(m.canonical(r)):1 for r in data};owned[table]=dict(rows[table])
        snapshot={'rows':{},'authoritySha256':'1'*64,'constraintsSha256':'2'*64,'catalogSha256':'3'*64}
        return {'rows':rows,'owned':owned,'flags':flags,'snapshot':snapshot}
    def refresh_flag_bags(self,state):
        for table,key in [('private.ai_budget_accounts','accounts'),('private.ai_processing_guard','guard')]:
            bag={m.sha(m.canonical(r)):1 for r in state['flags'][key]};state['rows'][table]=bag;state['owned'][table]=dict(bag)
    def test_flag_delta_and_baseline_restore_preserve_every_other_field(self):
        before=self.delta_fixture();after=copy.deepcopy(before)
        for a in after['flags']['accounts']:a['registered']=True
        after['flags']['guard'][0]['external_processing_allowed']=True;self.refresh_flag_bags(after)
        activate={'kind':'activate','tables':['private.ai_budget_accounts','private.ai_processing_guard']}
        m.verify_write_state(before,after,activate,'scope',[],before['flags']['accounts'])
        bad=copy.deepcopy(after);bad['flags']['accounts'][0]['unit_limit']=999;self.refresh_flag_bags(bad)
        with self.assertRaisesRegex(ValueError,'FLAG_FIELDS_CHANGED'):m.verify_write_state(before,bad,activate,'scope',[],before['flags']['accounts'])
        restore={'kind':'restore_account','tables':['private.ai_budget_accounts'],'accountId':'yumi','registered':True}
        with self.assertRaisesRegex(ValueError,'RESTORE_NOT_BASELINE'):m.verify_write_state(after,after,restore,'scope',[],before['flags']['accounts'])
    def test_profile_delta_preserves_foreign_member_and_partial_unlink(self):
        before=self.delta_fixture();after=copy.deepcopy(before)
        for table,h in [('public.profiles','1'*64),('private.member_episodes','2'*64)]:after['rows'][table][h]=1;after['owned'][table]={h:1}
        op={'kind':'link_profile','tables':['public.profiles','private.member_episodes']}
        m.verify_write_state(before,after,op,'scope',['own'],before['flags']['accounts'])
        op['kind']='unlink_profile';m.verify_write_state(after,before,op,'scope',['own'],before['flags']['accounts'])
        bad=copy.deepcopy(after);del bad['rows']['public.profiles']['e'*64]
        with self.assertRaisesRegex(ValueError,'FOREIGN_WRITE_DELTA'):m.verify_write_state(before,bad,{'kind':'link_profile','tables':op['tables']},'scope',['own'],before['flags']['accounts'])
    def test_ledger_and_cleanup_keep_unknown_and_ninety_day_budget(self):
        before=self.delta_fixture();after=copy.deepcopy(before);after['rows']['private.ai_budget_ledgers']['1'*64]=1;after['owned']['private.ai_budget_ledgers']={'1'*64:1}
        op={'kind':'ledger','tables':['private.ai_budget_ledgers']};m.verify_write_state(before,after,op,'scope',['own'],before['flags']['accounts'])
        for table in ('private.ai_budget_reservations','private.ai_account_budget_reservations','private.ai_account_daily_budget','private.ai_global_daily_budget'):
            bad=copy.deepcopy(after);bad['rows'][table]={}
            with self.assertRaises(ValueError):m.verify_write_state(before,bad,op,'scope',['own'],before['flags']['accounts'])
        bad=copy.deepcopy(after);bad['rows']['private.ai_budget_ledgers'].pop('f'*64)
        with self.assertRaisesRegex(ValueError,'FOREIGN_WRITE_DELTA'):m.verify_write_state(before,bad,op,'scope',['own'],before['flags']['accounts'])
    def test_current_issuer_history_override_never_calls_original_runner_sql(self):
        raw=(ROOT/'tools/local/provision_current_midnight.py').read_text();tree=ast.parse(raw)
        cls=next(n for n in ast.walk(tree)if isinstance(n,ast.ClassDef)and n.name=='CurrentIssuerPorts')
        class Base:
            def __init__(self,reviewed):self.reviewed=reviewed;self.runner=types.SimpleNamespace(sql=lambda q:(_ for _ in ()).throw(AssertionError('unsafe old runner')))
        calls=[];ai=types.SimpleNamespace(signed_verify_history=lambda port:port.sql('history query'))
        namespace={'original':Base(None),'ai':ai,'need':m.need}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[cls],type_ignores=[])),'<issuer class>','exec'),namespace)
        with tempfile.TemporaryDirectory()as root:
            port=namespace['CurrentIssuerPorts'](types.SimpleNamespace(prepared_root=Path(root)))
            port.current_database=types.SimpleNamespace(assert_closed_state=lambda:None,sql=lambda q:calls.append(q))
            port.history();self.assertEqual(calls,['history query'])
            (Path(root)/'native119-runtime-provenance.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'NATIVE_HISTORY_UNSUPPORTED'):port.history()
            self.assertEqual(calls,['history query'])
    def test_real_issuer_constructor_full_registered_context_coverage(self):
        ai,owner,db,registry,uid,sid,account=self.captured_fixture()
        producer_path=ROOT/'tools/local/provision_current_midnight.py'
        ps=importlib.util.spec_from_file_location('current_issuer_live_code_fixture',producer_path);producer=importlib.util.module_from_spec(ps);ps.loader.exec_module(producer)
        original_globals=ai.FixedSignedProvisioningPorts.__init__.__globals__
        target={'id':'1'*64,'host':'unix:///fixture','project':'fixture','versions':self.profile()['versions']}
        previous=original_globals['signed_prepared_target'];original_globals['signed_prepared_target']=lambda root:target
        try:port=producer.fixed_ports(ai,types.SimpleNamespace(prepared_root=Path('/private/tmp/ai24-capture-no-native-fixture'),containers={},credentials={},source_pins={}))
        finally:original_globals['signed_prepared_target']=previous
        port.runner.call=lambda argv:json.dumps([{'Id':'1'*64,'HostConfig':{'PidMode':''}}])
        paths=(m.SELF,m.PURE,m.KERNEL,'tools/local/provision_current_midnight.py','tools/local/prepare_isolated_midnight.py')
        pins={p:m.sha((ROOT/p).read_bytes())for p in paths};review=m.ReviewedCurrentAI24Database('decision',m.IssuerOperation(),'a'*40,pins,self.profile(),port.reviewed.prepared_root,'scope',{k:{'id':str(i)*64}for i,k in enumerate(('db','auth','rest','gateway'),1)})
        # committed byte 비교는 별도 Git fixture 영역이다. 여기서는 실제 캡처 함수/code/globals 연결을 검증한다.
        with patch.object(m,'checked_source',side_effect=lambda repo,p,head,pins:(ROOT/p).read_bytes()):
            actual=m.CurrentDatabase(ROOT,review,ai,port,lambda *a:None,lambda:None,lambda:None)
        self.assertTrue(actual.preparation_status['executionAllowed'])
        self.assertEqual(actual.preparation_status['coverageVersion'],'CURRENT124_FIXED_SQL_V1')
        self.assertRegex(actual.preparation_status['fixedOperationManifestSha256'],'^[a-f0-9]{64}$')
    def test_prepared_callbacks_use_captured_code_globals_and_fixed_scope(self):
        ai,owner,db,registry,users,accounts=self.runtime_fixture()
        path=ROOT/'tools/local/prepare_isolated_midnight.py';spec=importlib.util.spec_from_file_location('prepared_original_callback_fixture',path)
        prepared=importlib.util.module_from_spec(spec);spec.loader.exec_module(prepared)
        # 실제 callback 함수 namespace를 모형 owner의 MRO에도 명시하여 constructor capture를 재현한다.
        class WithPrepared(type(owner)):
            captured_prepared_clock=prepared.FixedSignedMidnightPorts.clock
        owner.__class__=WithPrepared;registry.bind(owner,ROOT,ai)
        proto=object.__new__(prepared.FixedSignedMidnightPorts);proto.runner=owner
        proto.contract={'scopeId':'scope','signedSelectedUserIds':users,'boundary':m.datetime.fromtimestamp(db.epoch,m.timezone(m.timedelta(hours=9))).isoformat(),'currentProfile':db.value['profile']}
        proto.contract['currentProfile']=dict(db.value['profile'],memberSessions=[{'userId':u,'primarySessionId':accounts[i*2]['sessionId'],'secondarySessionId':accounts[i*2+1]['sessionId']}for i,u in enumerate(users)])
        proto.binding=owner.binding;proto.cleanup_result={'status':'PASS'};proto.observations=[]
        tables=db.value['profile']['expectedTables'];row_hash=m.sha(m.canonical({}))
        owner.snapshot_original_rows={t:{}for t in tables}
        owner.snapshot=lambda:dict(rows={t:row_hash for t in tables},catalogSha256='c'*64,rolesAclSha256='c'*64,unknownRows={t:row_hash for t in('private.ai_budget_reservations','private.ai_account_budget_reservations')},sequence='NOT_VERIFIED',physical='NOT_VERIFIED')
        owner.original_rows=lambda:owner.snapshot_original_rows
        owner.fixture={'aiLedgerId':'signed-midnight-scope'}
        for i,a in enumerate(accounts):a['accessToken']='fixture-token-'+str(i);a['expiresAt']=db.epoch+3600
        owner.auth_user=lambda token:{'id':next(a['userId']for a in accounts if a['accessToken']==token),'role':'authenticated','is_anonymous':False}
        def record(query,timeout=3):
            match=registry.authorize(query,db.validate_context);owner.calls.append((query,match))
            if 'select encode(sha256(convert_to(jsonb_build_object(' in query:return 'c'*64
            if 'from pg_tables' in query:return json.dumps(tables)
            if query.startswith('select jsonb_agg(to_jsonb(a)'):return json.dumps(owner.accounts)
            if query.startswith('select jsonb_agg(to_jsonb(a))'):return json.dumps([{'singleton':True,'external_processing_allowed':False}])
            if 'midnightEpoch'in query:return json.dumps({'epoch':db.epoch-1000,'midnightEpoch':db.epoch})
            if query.startswith('select user_id::text'):return next(a['userId']for a in accounts if a['sessionId']in query and a['userId']in query)
            return '{}'
        owner.read_sql=record
        proto.clock();proto.verify_signed_auth();proto.snapshot();proto.original_rows();proto.headroom();proto.owned_metadata()
        seen={x['method']for _,x in owner.calls}
        self.assertTrue({'clock','verify_signed_auth','snapshot','authority_hashes','original_rows','headroom','owned_metadata'}<=seen)
        proto.contract['scopeId']='foreign'
        with self.assertRaisesRegex(ValueError,'PARENT_SCOPE_CHANGED'):proto.clock()
    def test_snapshot_one_rr_and_single_envelope(self):
        db=object.__new__(m.CurrentDatabase);db.reviewed=self.review();db.value=db.reviewed.descriptor()
        db.queries=m.snapshot_queries(RAW,m.IssuerOperation,self.tables());db.ai=types.SimpleNamespace(signed_exact_json=json.loads)
        observed=[];tables=self.tables();rows={t:{}for t in tables}
        def execute(body,timeout,readonly):
            observed.append((body,timeout,readonly));return json.dumps(dict(tables=json.dumps([x.split('.')for x in tables]),rows=json.dumps(rows),authority='c'*64,catalog='{}',constraints='[]'))
        db.execute=execute;result=db.snapshot()
        self.assertEqual(len(observed),1);self.assertIn(b'begin isolation level repeatable read read only;',observed[0][0])
        self.assertEqual(observed[0][0].count(b"select jsonb_build_object('tables'"),1)
        self.assertEqual(result['rows'],rows)

if __name__=='__main__':unittest.main()
