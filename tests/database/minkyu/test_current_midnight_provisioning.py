"""합성 port 전용. 실제 Docker·DB·GoTrue 발급·자정 실행은 하지 않는다."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

REPO=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('current_midnight_issuer_candidate',REPO/'tools/local/provision_current_midnight.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


def load_ai():
    path=REPO/m.RUNNER
    spec=importlib.util.spec_from_file_location('current_midnight_issuer_modeled_ai',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


class FakePorts:
    """MODELED GoTrue 상태기계. 사용자/세션의 UUID를 호출 응답에서만 부여한다."""
    def __init__(self,ai,root,containers,now,boundary,fail=None):
        self.ai=ai;self.root=root;self.containers=containers;self.now=now;self.boundary=boundary;self.fail=fail
        self.users={};self.sessions={};self.tokens={};self.profiles=set();self.audits=[];self.calls=[];self.preserve_calls=0;self.deleted=[]
        self.tables=sorted([*ai.PROVISION_OWNED_TABLES,'private.keep','storage.objects','cron.job','vault.secrets'])
    def identity(self):return self.containers
    def settings(self):return {'jwtExpirySeconds':3600,'anonymousEnabled':False,'signupDisabled':True}
    def closed_controls(self):return {**{k:False for k in self.ai.PROVISION_CLOSED_CONTROLS},'cronLaunchActiveJobs':'off'}
    def clock(self):return {'epoch':self.now,'midnightEpoch':self.boundary}
    def memory_kib(self):return 2*1048576
    def empty_auth(self):return not self.users
    def history(self):return {'method':'SUPABASE_DB_HISTORY','native':'NOT_RUN'}
    def preservation(self):
        self.preserve_calls+=1
        if self.fail=='post-preservation' and self.preserve_calls==2:raise ValueError('MODELED_EXISTING_RESOURCE_CHANGED')
    def resolve_email(self,email):return next((u for u,v in self.users.items()if v['email']==email),None)
    def link_profile(self,user):
        if user in self.profiles:raise ValueError('DUPLICATE_LINK')
        self.profiles.add(user);return True
    def unlink_profile(self,user):self.profiles.discard(user)
    def session_proof(self,a):return self.sessions.get(a['sessionId'],{}).get('userId')==a['userId']
    def metadata_proof(self,a,scope,case):return self.users[a['userId']]['user_metadata']==dict(fixture_scope_id=scope,fixture_case=case,email_verified=True)
    def raw(self,method,path,payload=None,token=None,admin=False):
        self.calls.append((method,path))
        if method=='POST'and path=='/admin/users':
            uid=str(uuid.uuid4());user=dict(id=uid,email=payload['email'],role='authenticated',is_anonymous=False,user_metadata=payload['user_metadata'])
            self.users[uid]=user;self.audits.append((uid,'user_signedup'));return 200,m.canonical(user)
        if method=='POST'and path=='/token?grant_type=password':
            uid=self.resolve_email(payload['email']);user=self.users[uid];sid=str(uuid.uuid4())
            claims=dict(sub=uid,session_id=sid,email=user['email'],iat=self.now,exp=self.now+3600,
                iss=self.origin+'/auth/v1',aud='authenticated',role='authenticated',is_anonymous=False)
            encode=lambda x:base64.urlsafe_b64encode(m.canonical(x)).decode().rstrip('=')
            bearer=encode({'alg':'HS256'})+'.'+encode(claims)+'.MODELED_NOT_REAL_SIGNATURE'
            self.sessions[sid]={'userId':uid,'token':bearer};self.tokens[bearer]=sid;self.audits.append((uid,'login'))
            login_count=sum(x==(uid,'login')for x in self.audits)
            if self.fail=='login-unknown'and len(self.sessions)==2:raise TimeoutError('MODELED_RESPONSE_LOST')
            if self.fail=='revoke-primary'and login_count==2:
                old=next(k for k,v in self.sessions.items()if v['userId']==uid and k!=sid);del self.sessions[old]
            # 실제 GoTrue처럼 login 때 갱신되는 필드를 추가해 전체 admin user DTO 동등 비교를 방지한다.
            return 200,m.canonical(dict(access_token=bearer,token_type='bearer',user={**user,'last_sign_in_at':'MODELED_CHANGED'}))
        if method=='GET'and path=='/user':
            sid=self.tokens.get(token);account=self.sessions.get(sid)
            return (401,m.canonical({}))if account is None else(200,m.canonical(self.users[account['userId']]))
        if path.startswith('/admin/users/'):
            uid=path.rsplit('/',1)[1]
            if method=='GET':return (200,m.canonical(self.users[uid]))if uid in self.users else(404,m.canonical({}))
            if method=='DELETE':
                self.deleted.append(uid);self.users.pop(uid,None)
                self.sessions={k:v for k,v in self.sessions.items()if v['userId']!=uid};self.audits.append((uid,'user_deleted'))
                return 204,b''
        raise AssertionError((method,path))
    def added_rows(self,before,accounts):
        result={t:{} for t in self.ai.PROVISION_OWNED_TABLES}
        def add(table,identifier,user,operation='row'):
            result[table][identifier]=dict(rowSha256=hashlib.sha256((table+identifier+operation).encode()).hexdigest(),ownerUserId=user,operation=operation)
        for user in self.users:
            for table in ('auth.users','auth.identities'):add(table,user,user)
            if user in self.profiles:
                for table in ('public.profiles','private.member_episodes'):add(table,user,user)
        for sid,account in self.sessions.items():
            for table in ('auth.sessions','auth.refresh_tokens','auth.mfa_amr_claims'):add(table,sid,account['userId'])
        for i,(user,operation)in enumerate(self.audits):add('auth.audit_log_entries',str(i),user,operation)
        return result
    def snapshot(self):
        added=self.added_rows({},[]);rows={t:{} for t in self.tables}
        for table,entries in added.items():
            for row in entries.values():rows[table][row['rowSha256']]=rows[table].get(row['rowSha256'],0)+1
        return dict(rows=rows,authoritySha256='a'*64,constraintsSha256='b'*64,catalogSha256='c'*64)


class CurrentMidnightIssuanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.ai=load_ai()
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='current-ai24-issue-modeled-',dir='/private/tmp');self.root=Path(self.temp.name).resolve();self.root.chmod(0o700)
        self.now=1800000000;self.boundary=self.now+1800;self.scope='d'*32
        self.containers={k:{'id':str(i)*64,'image':'sha256:'+'a'*64,'name':'MODELED-'+k,
            'configSha256':'a'*64,'hostConfigSha256':'b'*64,'mountsSha256':'c'*64}for i,k in enumerate(('db','auth','rest','gateway'),1)}
        self.ports=FakePorts(self.ai,self.root,self.containers,self.now,self.boundary)
        self.profile=dict(sourceHead='a'*40,migrationEntriesSha256='b'*64,versions=['20261020100000','20261020130000'],
            expectedTables=self.ports.tables,fullTableSetSha256=m.sha(m.canonical(self.ports.tables)))
        pins={**self.ai.signed_source_pins(),**{p:m.sha((REPO/p).read_bytes())for p in(m.SELF,*m.HELPERS,m.RUNNER,m.INSPECTOR)}}
        self.review=m.ReviewedCurrentMidnightIssuance('MODELED_ONLY',self.root,'a'*40,pins,self.profile,
            self.containers,{'anon':'MODELED_ANON','service':'MODELED_SERVICE'},self.scope,self.boundary,self.boundary+300,ports=self.ports)
        self.target={'id':'1'*64,'versions':self.profile['versions']}
        self.inspector=SimpleNamespace(verify_current_profile=lambda *args:None)
        self.evidence=self.root/('ai24-provision-'+self.scope)
    def tearDown(self):self.temp.cleanup()
    def execute(self):
        real_read=self.ai.signed_private_read
        def read(path):
            return m.canonical({'config_overlay':{'api.port':54321}})if Path(path)==self.root/'database-manifest.json'else real_read(path)
        with patch.object(m,'verify_pins'),patch.object(m.time,'time',return_value=self.now), \
             patch.object(self.ai,'signed_prepared_target',return_value=self.target), \
             patch.object(self.ai,'signed_private_read',side_effect=read), \
             patch.object(self.ai,'provisioning_metadata'),patch.object(self.ai,'validate_signed_binding'):
            return m._provision(self.review,self.review.descriptor(),self.ai,self.inspector)
    def test_exact_three_users_six_sessions_nine_audits_and_original_private_receipts(self):
        receipt=self.execute();self.assertEqual(receipt['status'],m.STATUS)
        self.assertEqual((receipt['members'],receipt['sessions'],receipt['createdAuthAudits']),(3,6,9))
        self.assertEqual(len(self.ports.users),3);self.assertEqual(len(self.ports.sessions),6);self.assertEqual(len(self.ports.profiles),3)
        self.assertEqual(self.ports.calls.count(('POST','/admin/users')),3);self.assertEqual(self.ports.calls.count(('POST','/token?grant_type=password')),6)
        self.assertEqual(self.ports.preserve_calls,2*len(self.ports.calls))
        profile=json.loads((self.evidence/'observed-profile-private.json').read_bytes())
        self.assertEqual(len(profile['memberSessions']),3)
        for member in profile['memberSessions']:self.assertNotEqual(member['primarySessionId'],member['secondarySessionId'])
        issued=list(self.evidence.glob('*-issued.json'));self.assertEqual(len(issued),6)
        for path in issued:
            proof=json.loads(path.read_bytes());self.assertEqual(proof['expiresAt']-proof['issuedAt'],3600)
            self.assertEqual(path.stat().st_mode&0o777,0o600);self.assertNotIn('MODELED_NOT_REAL_SIGNATURE',path.read_text())
        self.assertEqual(receipt['profileAssembly'],'ROOT_INDEPENDENT_REVIEW_REQUIRED');self.assertEqual(receipt['actualCrossSessionAI'],'NOT_RUN')
        resources=json.loads((self.evidence/'resource-clock-evidence-private.json').read_bytes())
        self.assertGreaterEqual(resources['initialMemoryKiB'],1048576)
        self.assertGreaterEqual(min(resources['memorySamplesKiB']),786432)
        self.assertTrue(all(c['midnightEpoch']==self.boundary for c in resources['sqlClocks']))
        # 실제 downstream reader를 소비해 issuer envelope의 private path/3×2 claims 연결을 검증한다.
        spec=importlib.util.spec_from_file_location('issuer_ai24_consumer_modeled',REPO/'tools/local/prepare_isolated_midnight.py')
        consumer=importlib.util.module_from_spec(spec);spec.loader.exec_module(consumer)
        auth=consumer.signed_input_binding(self.root/'current-ai24-binding-private.json',self.root,profile)
        self.assertEqual(len(auth['accounts']),6);self.assertEqual(len({a['userId']for a in auth['accounts']}),3)
    def test_lost_secondary_response_is_never_retried_and_only_created_user_is_deleted(self):
        self.ports.fail='login-unknown'
        with self.assertRaisesRegex(ValueError,'FAILED_PRIVATE_EVIDENCE'):self.execute()
        self.assertEqual(self.ports.calls.count(('POST','/token?grant_type=password')),2)
        self.assertEqual(len(self.ports.deleted),1);self.assertEqual(len(set(self.ports.deleted)),1)
        self.assertFalse(self.ports.users);self.assertFalse(self.ports.sessions);self.assertFalse(self.ports.profiles)
        failure=json.loads((self.evidence/'failure.json').read_bytes());self.assertEqual(failure['status'],'UNKNOWN');self.assertTrue(failure['noResend'])
    def test_second_session_invalidating_primary_refuses_success_and_cleans_exact_owner(self):
        self.ports.fail='revoke-primary'
        with self.assertRaisesRegex(ValueError,'FAILED_PRIVATE_EVIDENCE'):self.execute()
        self.assertEqual(self.ports.calls.count(('POST','/admin/users')),1);self.assertFalse(self.ports.users)
        self.assertFalse((self.evidence/'receipt.json').exists())
    def test_raw_create_output_survives_post_preservation_failure_before_any_verdict(self):
        self.ports.fail='post-preservation'
        with self.assertRaisesRegex(ValueError,'FAILED_PRIVATE_EVIDENCE'):self.execute()
        self.assertTrue((self.evidence/'ai24-member-0-create-response-private.json').exists())
        proof=json.loads((self.evidence/'ai24-member-0-create-outcome.json').read_bytes());self.assertTrue(proof['capturedBeforeVerdict'])
        self.assertEqual(self.ports.calls.count(('POST','/admin/users')),1);self.assertFalse(self.ports.users)
    def test_start_memory_or_clock_or_existing_target_refused_without_http(self):
        for kind in ('memory','clock','existing'):
            with self.subTest(kind=kind):
                if kind=='memory':self.ports.memory_kib=lambda:1048575
                if kind=='clock':self.ports.memory_kib=lambda:2097152;self.ports.clock=lambda:{'epoch':self.now,'midnightEpoch':self.boundary+86400}
                if kind=='existing':self.ports.clock=lambda:{'epoch':self.now,'midnightEpoch':self.boundary};self.ports.empty_auth=lambda:False
                # 초기 실패도 독립 증거 경로를 사용한다. 이전 attempt 재사용은 하지 않는다.
                scope=uuid.uuid4().hex;v=self.review.descriptor();self.review=m.ReviewedCurrentMidnightIssuance('MODELED_ONLY',self.root,'a'*40,v['pins'],self.profile,self.containers,v['credentials'],scope,self.boundary,self.boundary+300,ports=self.ports)
                with self.assertRaises(ValueError):self.execute()
                self.assertEqual(self.ports.calls,[])
    def test_default_cli_and_untyped_input_have_no_calls(self):
        with self.assertRaisesRegex(ValueError,'TYPED_REVIEW'):m.provision({})
        result=subprocess.run([sys.executable,'-B',str(REPO/m.SELF)],capture_output=True,text=True,timeout=5)
        self.assertEqual(json.loads(result.stdout)['status'],'NOT_RUN');self.assertEqual(json.loads(result.stdout)['actualAuth'],0)
    def test_uncommitted_self_and_wrong_head_source_are_not_approved(self):
        with self.assertRaisesRegex(ValueError,'HEAD_CHANGED'):m.source_pins('0'*40)
        # 합성 Git 객체 응답으로 SELF가 미추적임을 표현한다. 실제 repo 커밋 상태에 의존하지 않는다.
        def objects(args,**kwargs):
            chunks=[]
            for request in kwargs['input'].decode().splitlines():
                relative=request.split(':',1)[1]
                if relative==m.SELF:chunks.append((request+' missing\n').encode())
                else:
                    raw=(REPO/relative).read_bytes();chunks.append(('1'*40+' blob '+str(len(raw))+'\n').encode()+raw+b'\n')
            return SimpleNamespace(returncode=0,stdout=b''.join(chunks))
        with patch.object(m.subprocess,'check_output',return_value='a'*40+'\n'),patch.object(m.subprocess,'run',side_effect=objects):
            with self.assertRaisesRegex(ValueError,'COMMITTED_SOURCE_REQUIRED'):m.source_pins('a'*40)
    def test_exact_added_scope_refuses_six_user_shape_and_foreign_rows(self):
        self.execute();accounts=[]
        for sid,row in self.ports.sessions.items():accounts.append({'userId':row['userId'],'sessionId':sid})
        before={t:{}for t in self.ports.tables};after=self.ports.snapshot()['rows'];added=self.ports.added_rows({},accounts)
        m.added_scope(before,after,added,accounts)
        wrong=copy.deepcopy(after);wrong['private.keep']['f'*64]=1
        with self.assertRaisesRegex(ValueError,'UNOWNED_ROW'):m.added_scope(before,wrong,added,accounts)
        wrong_added=copy.deepcopy(added);wrong_added['auth.audit_log_entries'].pop(next(iter(wrong_added['auth.audit_log_entries'])))
        with self.assertRaisesRegex(ValueError,'ROW_COUNT'):m.added_scope(before,after,wrong_added,accounts)
        with self.assertRaisesRegex(ValueError,'EXACT_POPULATION'):
            m.added_scope(before,after,added,[{'userId':str(uuid.uuid4()),'sessionId':str(uuid.uuid4())}for _ in range(6)])

    def test_pinned_support_keeps_actual_late_imports_and_restores_success_or_failure(self):
        from unittest.mock import Mock
        pins={p:m.sha((REPO/p).read_bytes())for p in (*m.HELPERS,m.RUNNER,m.INSPECTOR)}
        poison_db=SimpleNamespace(isolated_config=Mock(side_effect=AssertionError('UNPINNED_LATE_IMPORT')))
        poison_sql=SimpleNamespace(inspect_migrations=Mock(side_effect=AssertionError('UNPINNED_LATE_IMPORT')))
        with patch.dict(sys.modules,{'prepare_database':poison_db,'prepare_migrations':poison_sql}):
            with m.support(pins)as(ai,_):self.assertIn(m.RUNNER,ai.signed_source_pins())
            self.assertIs(sys.modules['prepare_database'],poison_db);self.assertIs(sys.modules['prepare_migrations'],poison_sql)
            (self.root/'supabase').mkdir(mode=0o700)
            for path,raw in [(self.root/'database-manifest.json',m.canonical({'config_overlay':{'project_id':'jonghyun-backend100-deadbeef','api.port':62000}})),
                             (self.root/'execution-intent.json',b'{}'),(self.root/'supabase/config.toml',b'MODELED_INVALID_CONFIG')]:
                path.write_bytes(raw);path.chmod(0o600)
            with self.assertRaisesRegex(ValueError,'SIGNED_PREPARED_CONFIG'):
                with m.support(pins)as(ai,_):ai.signed_prepared_target(self.root)
            self.assertIs(sys.modules['prepare_database'],poison_db);self.assertIs(sys.modules['prepare_migrations'],poison_sql)
        poison_db.isolated_config.assert_not_called();poison_sql.inspect_migrations.assert_not_called()

    def test_forged_owner_and_same_count_session_allocation_are_refused(self):
        self.execute();accounts=[{'userId':row['userId'],'sessionId':sid}for sid,row in self.ports.sessions.items()]
        before={t:{}for t in self.ports.tables};after=self.ports.snapshot()['rows'];added=self.ports.added_rows({},accounts)
        for table in ('auth.sessions','auth.audit_log_entries'):
            altered=copy.deepcopy(added);first=next(iter(altered[table]));altered[table][first]['ownerUserId']=str(uuid.uuid4())
            with self.subTest(table=table),self.assertRaisesRegex(ValueError,'ROW_OWNER'):m.added_scope(before,after,altered,accounts)
        altered=copy.deepcopy(added);audit=next(k for k,v in altered['auth.audit_log_entries'].items()if v['operation']=='login')
        altered['auth.audit_log_entries'][audit]['operation']='user_signedup'
        with self.assertRaisesRegex(ValueError,'ROW_OWNER'):m.added_scope(before,after,altered,accounts)

    def test_private_evidence_symlink_cannot_redirect_created_receipts(self):
        outside=self.root/'outside';outside.mkdir(mode=0o700)
        self.evidence.symlink_to(outside,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'PREVIOUS_ATTEMPT'):self.execute()
        self.assertEqual(list(outside.iterdir()),[]);self.assertEqual(self.ports.calls,[])

    def test_first_create_rechecks_start_floor_after_intent_before_any_post(self):
        self.ports.memory_kib=lambda:786432 if(self.evidence/'ai24-member-0-create-intent-private.json').exists() else 2097152
        with self.assertRaisesRegex(ValueError,'FAILED_PRIVATE_EVIDENCE'):self.execute()
        self.assertTrue((self.evidence/'ai24-member-0-create-intent-private.json').exists())
        self.assertEqual(self.ports.calls,[]);self.assertFalse(self.ports.users)
        failure=json.loads((self.evidence/'failure.json').read_bytes())
        self.assertEqual(failure['fixedCode'],'ISSUER_MEMORY');self.assertTrue(failure['noResend'])

    def test_manually_shrunk_or_foreign_source_pin_review_refused_before_target_or_http(self):
        original=self.review.descriptor();product=next(p for p in original['pins']if p.startswith('backend/'))
        for pins in [{p:d for p,d in original['pins'].items()if p!=product},
                     {**original['pins'],'tools/local/unreviewed-foreign.py':'a'*64},
                     {**original['pins'],product:'0'*64}]:
            review=m.ReviewedCurrentMidnightIssuance('MODELED_ONLY',self.root,'a'*40,pins,self.profile,
                self.containers,original['credentials'],self.scope,self.boundary,self.boundary+300,ports=self.ports)
            with self.subTest(pins=len(pins)),patch.object(self.ai,'signed_prepared_target')as target:
                with self.assertRaisesRegex(ValueError,'SOURCE_CLOSURE|SIGNED_SOURCE_CHANGED'):
                    m._provision(review,review.descriptor(),self.ai,self.inspector)
                target.assert_not_called();self.assertEqual(self.ports.calls,[])
        review=m.ReviewedCurrentMidnightIssuance('MODELED_ONLY',self.root,'a'*40,{},self.profile,
            self.containers,original['credentials'],self.scope,self.boundary,self.boundary+300,ports=self.ports)
        with patch.object(m,'support')as loader:
            with self.assertRaisesRegex(ValueError,'EXACT_SOURCE_CLOSURE'):m.provision(review)
            loader.assert_not_called()


if __name__=='__main__':unittest.main()
