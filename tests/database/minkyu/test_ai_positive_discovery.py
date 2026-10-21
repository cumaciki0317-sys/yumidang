"""합성 포트 회귀. 실제 Docker·Auth·DB·공급사 전송 없이 새 positive 범위만 검사한다."""
import ast
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock
import uuid

ROOT = Path(__file__).resolve().parents[3]
PATH = ROOT / 'tests/integration/minkyu/ai_positive_discovery_local.py'
spec = importlib.util.spec_from_file_location('positive_candidate', PATH)
positive = importlib.util.module_from_spec(spec); spec.loader.exec_module(positive)


def fixture():
    return {'scope': positive.SCOPE, 'scopeId': 'a' * 32, 'query': '합성긍정abcdef',
        'postIds': ['00000000-0000-4000-8000-'+str(n).zfill(12) for n in range(1, 4)],
        'titles': ['합성 차분', '합성 활발', '합성 미입력'], 'ledger': 'positive-' + 'a' * 32,
        'accounts': [{'userId': '00000000-0000-4000-8000-'+str(100+n).zfill(12), 'accessToken': 'unit.original.token'} for n in range(6)]}


def golden():
    f = fixture(); cases = []; data = {t: [] for t in (*positive.BUDGET, 'ai_chat_requests', 'ai_result_receipts', 'ai_member_daily_usage', 'ai_member_processing')}
    day = '2026-10-19'; viewer = f['accounts'][0]['userId']
    for name, tasks in positive.CASE_TASKS.items():
        rid, lease = str(uuid.uuid4()), str(uuid.uuid4()); success = name in ('semantic', 'recheck_change')
        row = {'case': name, 'modelTasks': tasks[:], 'cardIds': [f['postIds'][2], f['postIds'][0]] if name == 'semantic' else [f['postIds'][2]] if name == 'recheck_change' else [],
            'resultStatus': 'results' if success else 'unavailable', 'resultCount': int(success), 'authReads': 1,
            'finishOutcome': 'output_privacy' if name == 'output_privacy' else 'finished',
            'originalTokenSha256': positive.sha(f['accounts'][0]['accessToken'].encode()),
            'requests': [{'requestId': rid, 'leaseSha256': positive.sha(lease.encode())}], 'reservations': []}
        cases.append(row)
        data['ai_chat_requests'].append({'request_id': rid, 'user_id': viewer, 'outcome': row['finishOutcome'],
            'finished_at': 'time', 'started_at': 'time', 'counted_day': day, 'lease_token': lease,
            'client_request_hash':positive.sha(('positive-'+name+'-'+f['scopeId']).encode()), 'output_retry_of':None,'retry_request_id':None})
        if success: data['ai_result_receipts'].append({'request_id': rid, 'user_id': viewer})
        for task in tasks:
            identifier = str(uuid.uuid4()); row['reservations'].append({'reservationId': identifier, 'task': task,
                'accountId': 'yumi', 'accountDay': day, 'units': 100, 'dispatched': True, 'settled': True})
            data['ai_account_budget_reservations'].append({'reservation_id': identifier, 'ledger_id': f['ledger'],
                'account_id': 'yumi', 'account_day': day, 'reserved_units': 100, 'unknown_at': None,
                'settled_at': 'time', 'input_tokens': 1, 'output_tokens': 1})
    data['ai_member_daily_usage'] = [{'user_id': viewer, 'kst_day': day, 'started_requests': 4}]
    data['ai_member_processing'] = [{'user_id': a['userId'], 'exploration_allowed': True, 'summary_allowed': False, 'summary_view_allowed': False, 'summary_generate_allowed': False, 'summary_source_allowed': False,
        'active_request_id': None} for a in f['accounts']]
    data['ai_budget_ledgers'] = [{'ledger_id': f['ledger'], 'unit_limit':100000000,'call_limit':64,'charged_units': 22, 'reserved_units': 0,
        'open_calls': 0, 'settled_calls': 11, 'unknown_usage_calls': 0}]
    data['ai_global_daily_budget'] = [{'kst_day': day, 'charged_units': 22, 'reserved_units': 0}]
    data['ai_account_daily_budget'] = [{'account_id': 'yumi', 'kst_day': day, 'charged_units': 22, 'reserved_units': 0}]
    return f, {'status': 'PASS', 'scope': positive.SCOPE, 'nativeExternalAttempts': 0, 'mutationCount': 1,
        'actualAuthPostgrestProductFactory': True, 'actualNaver': 'NOT_RUN', 'actualProviderQuality': 'NOT_RUN', 'cases': cases}, data


class ProofContract(unittest.TestCase):
    def test_exact_four_cases_eleven_settlements(self):
        positive.verify_database(*golden())

    def test_rejects_scope_effect_and_unknown_corruption(self):
        changes = [lambda f,r,d: r['cases'][0]['cardIds'].reverse(),
            lambda f,r,d: r['cases'][1]['modelTasks'].append('intent'),
            lambda f,r,d: r['cases'][3].update(cardIds=f['postIds'][:]),
            lambda f,r,d: r.update(actualNaver='PASS'),
            lambda f,r,d: r.update(nativeExternalAttempts=True),
            lambda f,r,d: r['cases'][0].update(originalTokenSha256='0'*64),
            lambda f,r,d: d['ai_chat_requests'][0].update(user_id=f['accounts'][1]['userId']),
            lambda f,r,d: d['ai_result_receipts'].append(dict(d['ai_result_receipts'][0])),
            lambda f,r,d: d['ai_account_budget_reservations'][0].update(unknown_at='unresolved'),
            lambda f,r,d: d['ai_account_budget_reservations'][0].update(input_tokens=True),
            lambda f,r,d: d['ai_global_daily_budget'][0].update(kst_day='2026-10-20'),
            lambda f,r,d: d['ai_budget_ledgers'][0].update(charged_units=23),
            lambda f,r,d: d['ai_member_processing'][0].update(summary_allowed=True),
            lambda f,r,d: d['ai_member_processing'][0].update(summary_view_allowed=True),
            lambda f,r,d: d['ai_member_processing'][0].update(summary_generate_allowed=True),
            lambda f,r,d: d['ai_member_processing'][0].update(summary_source_allowed=True)]
        for change in changes:
            f,r,d = golden(); change(f,r,d)
            with self.subTest(change=changes.index(change)), self.assertRaises((ValueError, KeyError)):
                positive.verify_database(f,r,d)

    def current_fixture(self):
        head = subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()
        pins = {p:positive.sha((ROOT/p).read_bytes()) for p in (positive.READONLY_PROFILE,*positive.CURRENT_HELPERS)}
        path=ROOT/positive.READONLY_PROFILE
        module=importlib.util.module_from_spec(importlib.util.spec_from_loader('positive_profile_test',loader=None))
        module.__file__=str(path);exec(compile(path.read_bytes(),str(path),'exec'),module.__dict__)
        with module.current_support(pins):
            from prepare_migrations import inspect_migrations
            entries=inspect_migrations(ROOT)['migrations']
        profile=positive.ReviewedCurrentPositiveProfile(head,positive.sha(positive.canonical(entries)),
            [e['version'] for e in entries], ['auth.users','private.synthetic'], positive.sha(positive.canonical(['auth.users','private.synthetic'])))
        return head,pins,entries,profile

    def test_current_profile_consumes_real_pinned_inspector_without_recursive_source_pins_or_poison(self):
        head,pins,entries,profile=self.current_fixture()
        poison=SimpleNamespace(inspect_migrations=Mock(side_effect=AssertionError('UNPINNED_IMPORT')))
        with patch.dict(sys.modules,{'prepare_migrations':poison}), patch.object(positive,'source_pins',side_effect=AssertionError('RECURSIVE_SOURCE_PINS')):
            result=positive.verify_current_profile(profile.descriptor(),pins,head,profile.descriptor()['versions'])
            self.assertIs(sys.modules['prepare_migrations'],poison)
        poison.inspect_migrations.assert_not_called();self.assertEqual(result['entries'],entries)
        for changed in [dict(sourceHead='0'*40),dict(migrationEntriesSha256='0'*64),
                        dict(versions=profile.descriptor()['versions'][:-1]+['99999999999999'])]:
            with self.subTest(changed=changed),self.assertRaises(ValueError):
                positive.verify_current_profile({**profile.descriptor(),**changed},pins,head)

    def test_current_inspector_or_helper_pin_change_is_refused(self):
        head,pins,_,profile=self.current_fixture()
        for path in (positive.READONLY_PROFILE,*positive.CURRENT_HELPERS):
            for bad in [{**pins,path:'0'*64},{k:v for k,v in pins.items() if k!=path}]:
                with self.subTest(path=path),self.assertRaises(ValueError):
                    positive.verify_current_profile(profile.descriptor(),bad,head)

    def test_current_typed_review_seals_profile_and_historical_descriptor_unchanged(self):
        head,pins,_,profile=self.current_fixture()
        with tempfile.TemporaryDirectory(prefix='positive-profile-review-') as directory:
            root=Path(directory).resolve();receipt=root/('auth-provision-'+'b'*32)/'receipt.json'
            args=dict(decision_id='offline-current',root=root,source_head=head,
                pins={**pins,positive.SELF:'a'*64,positive.FACTORY:'a'*64},binding_sha256='a'*64,
                auth6_receipt=receipt,auth6_receipt_sha256='a'*64,
                capsule_root='/private/tmp/positive-reviewed-capsule/source',node_path='/usr/bin/node',
                node_sha256='a'*64,scope_id='a'*32,daemon_id=str(uuid.UUID(int=10)))
            # 이 순수 생성 회귀는 node 실행·실제 설치 경로 검증 범위를 주장하지 않는다.
            with patch.object(positive.Path,'resolve',lambda p:p):
                old=positive.ReviewedPositiveDiscovery(**args)
                new=positive.ReviewedPositiveDiscovery(**args,current_profile=profile)
                self.assertNotIn('currentProfile',old.descriptor())
                self.assertEqual(new.descriptor()['currentProfile'],profile.descriptor())
                for change in [dict(current_profile=profile.descriptor()),dict(source_head='0'*40),
                               dict(pins={positive.SELF:'a'*64,positive.FACTORY:'a'*64})]:
                    params={**args,'current_profile':profile,**change}
                    with self.subTest(change=change),self.assertRaises(ValueError):positive.ReviewedPositiveDiscovery(**params)

    def test_current_profile_target_same_count_drift_is_rejected_before_any_docker(self):
        head,pins,entries,profile=self.current_fixture()
        run=object.__new__(positive.PositiveRun);run.root=Path('/private/tmp/positive-offline-bind')
        receipt_path=run.root/('auth-provision-'+'b'*32)/'receipt.json'
        raw=positive.canonical({'accounts':[]})
        receipt=positive.canonical(dict(status='PASS_LOCAL_AUTH6_PROVISION_ONLY',accounts=6,
            bindingSha256=positive.sha(raw),actualGoTrueAndDatabaseSessions=True,originalRowsPreserved=True,
            actualNaver='NOT_RUN',actualAI22AI23AI24='NOT_RUN',authAccountsRetained=True,
            creationReceiptRoot=str(receipt_path.parent)))
        run.value=dict(bindingSha256=positive.sha(raw),auth6Receipt=str(receipt_path),
            auth6ReceiptSha256=positive.sha(receipt),sourceHead=head,pins=pins,currentProfile=profile.descriptor())
        run.read=lambda p:receipt if str(p)==str(receipt_path) else raw
        target={'versions':[e['version'] for e in entries],'context':'wrong-offline-context','host':'offline'}
        run.ai=SimpleNamespace(signed_prepared_target=Mock(return_value=target))
        run.private_module=SimpleNamespace(CONTEXT='expected',HOST='expected')
        correct=list(target['versions']);target['versions'][-1]='99999999999999'
        real_run=subprocess.run
        def no_docker(args,**kwargs):
            if args[0] != 'git': raise AssertionError('DOCKER_NOT_ALLOWED')
            return real_run(args,**kwargs)
        with patch.object(positive.subprocess,'run',side_effect=no_docker):
            with self.assertRaisesRegex(ValueError,'VERSIONS'):run.bind()
            target['versions']=correct
            with self.assertRaisesRegex(ValueError,'FIXED_MINKYU_CONTEXT'):run.bind()
        positive.verify_target_profile({}, {'versions':list(range(121))})
        with self.assertRaisesRegex(ValueError,'CURRENT121'):
            positive.verify_target_profile({}, {'versions':correct})

    def test_current_exact_table_scope_preserves_all_bags_and_authority_without_count_promotion(self):
        _,_,_,profile=self.current_fixture();tables=profile.descriptor()['expectedTables']
        before={'rows':{t:{'a'*64:2} for t in tables},'authoritySha256':'b'*64}
        positive.unchanged_except(before,copy.deepcopy(before),set(),approved_tables=tables)
        for after in [dict(before,rows={'auth.users':{'a'*64:2},'private.replacement':{}}),
                      dict(before,rows={**before['rows'],'private.extra':{}}),
                      dict(before,authoritySha256='c'*64),
                      dict(before,rows={**before['rows'],'auth.users':{'a'*64:1}})]:
            with self.subTest(after=after),self.assertRaises(ValueError):
                positive.unchanged_except(before,after,set(),approved_tables=tables)
        with self.assertRaises(ValueError):positive.unchanged_except(before,before,set())
        bad=profile.descriptor();bad.pop('expectedTables')
        with self.assertRaisesRegex(ValueError,'PROFILE_REVIEW'):positive.verify_current_profile(bad,{},'a'*40)

    def test_duplicate_and_nonfinite_json_rejected(self):
        for raw in ['{"a":1,"a":2}', '{"a":NaN}']:
            with self.assertRaises(ValueError): positive.raw_json(raw)

    def test_all_178_bags_multiplicity_and_authority_preserved(self):
        before = {'rows': {'private.t'+str(i): {'a'*64: 2} for i in range(178)}, 'authoritySha256':'b'*64}
        after = copy.deepcopy(before); positive.unchanged_except(before, after, set())
        after['rows']['private.t177']['a'*64] = 1
        with self.assertRaisesRegex(ValueError, 'UNOWNED'): positive.unchanged_except(before, after, set())
        after = copy.deepcopy(before); after['authoritySha256'] = 'c'*64
        with self.assertRaisesRegex(ValueError, 'AUTHORITY'): positive.unchanged_except(before, after, set())

    def test_default_cli_and_untyped_run_have_zero_execution(self):
        with patch.object(positive, 'PositiveRun') as runner:
            with self.assertRaisesRegex(ValueError, 'TYPED'): positive.run_reviewed({})
            runner.assert_not_called()
        result = subprocess.run(['python3','-B',str(PATH)], capture_output=True, text=True, timeout=5)
        self.assertEqual(json.loads(result.stdout)['actualCalls'], 0)
        self.assertEqual(json.loads(result.stdout)['status'], 'NOT_RUN')

    def test_self_uncommitted_source_guard_is_not_waived(self):
        # 실제 HEAD와 작업 트리가 달라진 저장소에서 기존 guard가 먼저 거절한다. Docker/HTTP 호출은 없다.
        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
            positive.source_pins('0'*40)

    def test_existing_full_observer_and_signed_closures_both_require_head_bytes(self):
        # Git 명령 응답만 고정한다. 실제 guard 두 함수와 실제 파일 bytes/변경 감지를 그대로 쓴다.
        tracked=subprocess.check_output(['git','-C',str(ROOT),'ls-files','-z']).decode().split('\0')
        paths=[p for p in tracked if p and ((p.startswith('backend/supabase/functions/') and p.endswith(('.ts','.mjs')))
            or (p.startswith('tools/local/') and p.endswith('.py'))
            or (p.startswith('tests/integration/jonghyun/isolated_') and p.endswith(('.py','.ts')))
            or (p.startswith('tests/database/') and '/current_' in p and p.endswith('.sql'))
            or p in ['tests/integration/minkyu/content_inspection_http_local.ts','tests/integration/minkyu/worker_safety_http.ts','tests/integration/minkyu/worker_safety_http_local.py'])]
        paths+=['tests/integration/minkyu/member_cleanup_reconcile_local.py','tests/integration/minkyu/product_connection_restore108_local.py',positive.SELF]
        originals={p:(ROOT/p).read_bytes() for p in set(paths)}
        head='a'*40
        def git(args,**kw):
            if args[-2:]==['rev-parse','HEAD']:return head+'\n'
            if args[-2:]==['ls-files','-z']:return ('\0'.join(originals)+'\0').encode()
            if args[-2]=='show':return originals[args[-1].split(':',1)[1]]
            raise AssertionError(args)
        with tempfile.TemporaryDirectory(prefix='positive-source-') as directory:
            root=Path(directory).resolve()
            for path,raw in originals.items():
                dest=root/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw)
            with patch.object(positive,'ROOT',root),patch.object(positive.subprocess,'check_output',side_effect=git):
                h,pins=positive.source_pins(head);self.assertEqual(h,head)
                for path in ('backend/supabase/functions/_shared/jobs/event-collection.ts',
                             'tests/integration/minkyu/product_connection_restore108_local.py',positive.SELF):
                    self.assertIn(path,pins);dest=root/path;dest.write_bytes(originals[path]+b'\n# drift')
                    with self.subTest(path=path),self.assertRaises(ValueError):positive.source_pins(head)
                    dest.write_bytes(originals[path])

    def test_all_prior_factory_function_bodies_remain_exact(self):
        raw=(ROOT/positive.FACTORY).read_text();start=raw.index('async function signedAuthNegative(f:any){')
        end=len(raw)
        self.assertEqual(hashlib.sha256(raw[start:end].rstrip().encode()).hexdigest(),
            '21856129fc4c9712dea8181a16bb4d016f8cf4f034bce8a505c5377e5b6812dd')

    def test_memory_failure_still_cleans_exact_fixture_and_saves_before_verdict(self):
        run = object.__new__(positive.PositiveRun); events = []; f=fixture()
        run.r=SimpleNamespace(sql=lambda sql:events.append(('sql',sql)), clean=lambda:events.append(('standard-clean',None)))
        run.before={'rows':{**{'private.t'+str(i):{} for i in range(176)}, **{'private.'+t:{} for t in positive.BUDGET[1:3]}},'authoritySha256':'a'*64}
        run.ai=SimpleNamespace(quote=lambda v:"'"+v+"'");run.child=None;run.setup=True; run.fixture=f; run.evidence=Path('/unit/evidence'); run.root=Path('/unit/root')
        run.value={'auth6Receipt':'/unit/receipt'};run.binding_raw=b'binding';run.receipt_raw=b'receipt'
        run.fixed_identity=lambda:events.append(('identity',None));run.capsule=lambda:None
        run.snapshot=lambda cleanup=False: copy.deepcopy(run.before)
        run.save=lambda name,value:events.append(('save',name))
        run.read=lambda path: b'binding' if str(path).endswith('signed-ai-binding-private.json') else b'receipt' if str(path)=='/unit/receipt' else b'private'
        run.clean()
        self.assertLess(events.index(('save','final-before-cleanup-private.json')), next(i for i,e in enumerate(events) if e[0]=='sql'))
        self.assertLess(events.index(('save','final-after-cleanup-private.json')), len(events))
        self.assertEqual(run.cleanup_proof['status'],'PASS')
        sql=next(e[1] for e in events if e[0]=='sql')
        self.assertIn('external_processing_allowed=false',sql)
        self.assertIn('delete from public.posts where id in(',sql)
        self.assertNotIn('delete from auth.',sql)
        for identifier in f['postIds']: self.assertIn(identifier,sql)

    def test_live_child_defers_all_cleanup_sql_and_retains_final_read(self):
        run=object.__new__(positive.PositiveRun);events=[]
        run.r=SimpleNamespace(sql=lambda _:events.append('UNSAFE_SQL'),clean=lambda:events.append('UNSAFE_CLEAN'))
        run.child=object();run.snapshot=lambda cleanup=False:{'readOnly':'notProof'}
        run.save=lambda name,value:events.append(name)
        with self.assertRaisesRegex(ValueError,'LIVE_CHILD_CLEANUP_DEFERRED'):run.clean()
        self.assertEqual(events,['final-before-cleanup-private.json'])

    def test_child_streams_are_bounded_private_and_preserve_failure_prefix(self):
        with tempfile.TemporaryDirectory(prefix='positive-capture-') as directory:
            run=object.__new__(positive.PositiveRun);run.evidence=Path(directory)
            def write(root,name,raw):
                fd=os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                with os.fdopen(fd,'wb') as stream:stream.write(raw)
            run.writer=SimpleNamespace(save_bytes=write);run.capture_threads=[];run.capture_failures=[]
            run.child=SimpleNamespace(returncode=1);run.read=lambda p:p.read_bytes();saved=[];run.save=lambda n,v:saved.append((n,v))
            run.capture(io.BytesIO(b'prefix'+b'x'*10000),'positive-factory-stdout-private.json',1024)
            run.capture(io.BytesIO(b'AI_CHECK_POSITIVE_PRODUCT_RESULTS\n'),'positive-factory-stderr-private.json',65536)
            out,err=run.finish_capture()
            self.assertEqual(len(out),1024);self.assertTrue(out.startswith(b'prefix'))
            self.assertEqual(err,b'AI_CHECK_POSITIVE_PRODUCT_RESULTS\n')
            self.assertEqual(run.capture_failures,['POSITIVE_CAPTURE_LIMIT'])
            self.assertEqual((run.evidence/'positive-factory-stdout-private.json').stat().st_mode&0o777,0o600)
            self.assertTrue(saved[0][1]['privateRawOutputPreserved'])

    def test_preparation_checks_monitor_on_each_sql_and_auth_boundary(self):
        tree=ast.parse(PATH.read_bytes());bind=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='PositiveRun')
        bind=next(n for n in bind.body if isinstance(n,ast.FunctionDef) and n.name=='bind')
        adapter=next(n for n in bind.body if isinstance(n,ast.ClassDef) and n.name=='MonitoredSignedRunner')
        calls=[]
        class Base:
            def sql(self,_):calls.append('sql');return 'ok'
            def auth_user(self,_):calls.append('auth');return {}
        owner=SimpleNamespace(cleaning=False,failures=['memory'],done=SimpleNamespace(is_set=lambda:False),deadline=float('inf'))
        ns={'self':SimpleNamespace(ai=SimpleNamespace(SignedRunner=Base)), 'owner':owner, 'require':positive.require, 'time':time}
        exec(compile(ast.Module(body=[adapter],type_ignores=[]),'actual-monitor-adapter','exec'),ns)
        adapter=ns['MonitoredSignedRunner']()
        for action in (lambda:adapter.sql('read'),lambda:adapter.auth_user('original')):
            with self.assertRaisesRegex(ValueError,'MEMORY_MONITOR'):action()
        self.assertEqual(calls,[])
        owner.failures=[];owner.deadline=0
        with self.assertRaisesRegex(ValueError,'OBSERVER_TIMEOUT'):adapter.sql('read')
        self.assertEqual(calls,[])
        owner.cleaning=True;self.assertEqual(adapter.sql('cleanup'),'ok');self.assertEqual(calls,['sql'])


# 실제 제품 runtime을 메모리 REST wire로 실행한다. 전역 fetch는 네트워크에 연결하지 않는다.
NODE_WIRE = r'''
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const f=JSON.parse(readFileSync(0,'utf8')),calls=[];let changed=false;
const hash=v=>createHash('md5').update(JSON.stringify(v)).digest('hex');
globalThis.fetch=async(input,init={})=>{
 const u=new URL(String(input));assert.equal(u.origin,f.origin);calls.push(u.pathname);
 const token=new Headers(init.headers).get('authorization')?.slice(7);
 if(u.pathname==='/auth/v1/user'){const a=f.accounts.find(a=>a.accessToken===token);assert.ok(a);return Response.json({id:a.userId,role:'authenticated',is_anonymous:false});}
 const name=u.pathname.split('/').at(-1),a=JSON.parse(init.body);
 if(name==='acquire_ai_chat_request')return Response.json({status:'acquired',leaseToken:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString()});
 if(name==='reserve_ai_chat_account_model')return Response.json({status:'reserved',reservationId:randomUUID(),accountId:a.p_account_id,accountDay:'2026-10-19'});
 if(name==='settle_ai_account_budget')return Response.json({settled:true,pending:false});
 if(name==='finish_ai_chat_request')return Response.json({finished:true});
 if(name==='record_ai_chat_result_available')return Response.json({requestId:a.p_request_id,availableAt:new Date().toISOString()});
 if(name==='get_my_profile_traits')return Response.json({interests:[],conversationStyles:[],mbti:null});
 if(name==='set_my_profile_traits'){assert.equal(token,f.accounts[1].accessToken);assert.deepEqual(a,{p_interests:['전시'],p_conversation_styles:['활발한 수다'],p_mbti:'INFP'});assert.equal(changed,false);changed=true;return Response.json({interests:['전시'],conversationStyles:['활발한 수다'],mbti:'INFP'});}
 const ids=[f.postIds[2],f.postIds[1],f.postIds[0]],styles=id=>id===f.postIds[2]?[]:[id===f.postIds[0]&&!changed?'차분한 대화':'활발한 수다'];
 if(name==='search_public_posts_v2'){
  const start=a.p_cursor?ids.indexOf(a.p_cursor.id)+1:0,id=ids[start],i=f.postIds.indexOf(id);
  assert.equal(a.p_region,'서울특별시');assert.equal(a.p_limit,1);assert.equal(a.p_filters.query,f.query);
  return Response.json({items:id?[{id,title:f.titles[i],authorDisplayName:'합*성',publicArea:'서울특별시 종로구 삼청동',startsAt:'2026-10-24T12:00:00Z',endsAt:'2026-10-24T14:00:00Z',cost:{kind:'free'},state:'recruiting',canApply:false}]:[],nextCursor:start<2?{sortAt:new Date(Date.UTC(2026,9,19,0,0,-start)).toISOString(),id}:null});
 }
 if(name==='get_post_author_traits')return Response.json({items:a.p_post_ids.map(postId=>({postId,interests:postId===f.postIds[2]?[]:['전시'],conversationStyles:styles(postId),mbti:postId===f.postIds[2]?null:'INFP',traitsVersion:hash(styles(postId))}))});
 throw Error('UNEXPECTED_OFFLINE_RPC_'+name);
};
const {signedPositiveDiscoveryCase}=await import(pathToFileURL(f.codeRoot+'/tests/integration/jonghyun/isolated_ai_factory.ts').href);
let result;try{result=await signedPositiveDiscoveryCase(f);}catch(e){process.stderr.write(JSON.stringify(calls));throw e;}assert.ok(changed);assert.equal(calls.filter(p=>p.endsWith('/set_my_profile_traits')).length,1);
process.stdout.write(JSON.stringify(result));
'''


class ProductFactory(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'Node 필요')
    def test_nonempty_real_product_runtime_with_offline_rest_wire(self):
        f=fixture(); f.update(codeRoot=str(ROOT),origin='http://127.0.0.1:57999',anon='unit-anon',service='unit-service',signedLocalAuth=True,productManifest={})
        for i,a in enumerate(f['accounts']): a.update(accessToken='unit.member'+str(i)+'.signature',expiresAt=4_000_000_000,sessionId=str(uuid.uuid4()))
        with tempfile.TemporaryDirectory(prefix='positive-offline-') as directory:
            os.chmod(directory,0o700);f['evidence']=directory
            p=subprocess.run(['node','--experimental-strip-types','--input-type=module','-e',NODE_WIRE],input=json.dumps(f),capture_output=True,text=True,timeout=30,cwd=ROOT)
            self.assertEqual(p.returncode,0,p.stderr)
            result=json.loads(p.stdout);positive.verify_result(f,result)
            self.assertEqual([c['resultStatus'] for c in result['cases']],['results','unavailable','unavailable','results'])
            self.assertEqual(sum(len(c['reservations']) for c in result['cases']),11)
            self.assertTrue((Path(directory)/'positive-traits-mutation-intent-private.json').is_file())


if __name__ == '__main__': unittest.main()
