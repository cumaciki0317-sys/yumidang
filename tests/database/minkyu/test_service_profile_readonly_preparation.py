"""실제 service-api 코드+합성 fetch와 순수 증거 회귀. Docker/SQL/HTTP 실제 전송 0."""
import ast
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock
import uuid

CANDIDATE = Path(__file__).resolve().parents[3]
REPO = Path(os.environ.get('YUMIDANG_READONLY_TEST_SOURCE', CANDIDATE)).resolve()
PATH = CANDIDATE / 'tests/integration/minkyu/service_profile_readonly_local.py'
spec = importlib.util.spec_from_file_location('service_readonly_candidate', PATH)
readonly = importlib.util.module_from_spec(spec); spec.loader.exec_module(readonly)


def fixture():
    ids = [str(uuid.UUID(int=100+n)) for n in range(6)]
    name = '합성 AI 검증회원'; masked = name[0] + '*' * (len(name)-2) + name[-1]
    profiles = [dict(userId=uid, realName=name, avatarUrl=None, bio=None, sweetness=15,
        displayName=masked, age=36, gender='female', avatarPath=None, interests=[],
        conversationStyles=[], mbti=None, completedCount=0) for uid in ids[:2]]
    return {'scope': readonly.SCOPE, 'scopeId': 'a'*32, 'signedLocalAuth': True,
        'origin': 'http://127.0.0.1:57999', 'anon': 'unit-anon', 'service': 'unit-service',
        'codeRoot': str(REPO), 'factoryPath': str(CANDIDATE / readonly.FACTORY),
        'productManifest': readonly.service_graph(REPO), 'expectedProfiles': profiles,
        'accounts': [dict(userId=uid, sessionId=str(uuid.UUID(int=200+n)), accessToken='unit.member'+str(n)+'.signature',
                          expiresAt=4_000_000_000) for n, uid in enumerate(ids)]}


def golden(f):
    rows = []; original = f['accounts'][0]['accessToken']; parts = original.split('.')
    forged = '.'.join(parts[:2] + [('b' if parts[2][0]=='a' else 'a') + parts[2][1:]])
    for name, status, auth, rpc, keys in readonly.EXPECTED_CASES:
        token = None if name == 'missing' else forged if name == 'forged' else original
        wire = []
        if auth: wire.append(dict(kind='auth', tokenSha256=readonly.sha(token.encode()), httpStatus=403 if name=='forged' else 200, bodySha256='a'*64))
        if rpc: wire.append(dict(kind='rpc', name='get_my_profile' if name=='own' else 'get_public_profile', tokenSha256=readonly.sha(token.encode()), httpStatus=200, bodySha256='b'*64))
        rows.append(dict(case=name,httpStatus=status,authReads=auth,rpcCalls=rpc,dtoKeys=keys,
            tokenSha256=None if token is None else readonly.sha(token.encode()),outputSha256='c'*64,
            originalActorMatched=name=='own',maskedOther=name=='public_other',wire=wire))
    return dict(status='PASS', scope=readonly.SCOPE, cases=rows, authReads=3, rpcCalls=2,
        nativeExternalAttempts=0, forbiddenRpcAttempts=0, providerCalls=0, modelCalls=0,
        reservationCalls=0, fixtureWrites=0, actualNaver='NOT_RUN',
        expiredOriginal='NOT_RUN_SAME_ORIGINAL_CONTEXT_REQUIRED',rawContentLogged=False)


NODE_WIRE = r'''
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const f=JSON.parse(readFileSync(0,'utf8'));let count=0;
globalThis.fetch=async(input,init={})=>{
 const u=new URL(String(input));assert.equal(u.origin,f.origin);count++;
 const token=new Headers(init.headers).get('authorization')?.replace(/^Bearer /i,'');
 if(u.pathname==='/auth/v1/user'){
  assert.equal(init.method,'GET');const account=f.accounts.find(a=>a.accessToken===token);
  return account?Response.json({id:account.userId,role:'authenticated',is_anonymous:false}):Response.json({error_code:'bad_jwt',msg:'invalid signature'},{status:403});
 }
 assert.equal(init.method,'POST');assert.equal(token,f.accounts[0].accessToken);
 const args=JSON.parse(init.body);
 if(u.pathname==='/rest/v1/rpc/get_my_profile'){
  assert.deepEqual(args,{});const p=f.expectedProfiles[0];
  const d=Object.fromEntries(['userId','realName','avatarUrl','bio','sweetness'].map(k=>[k,p[k]]));
  if(f.breakCase==='own_extra')d.secret='private';if(f.breakCase==='own_wrong_actor')d.userId=f.accounts[1].userId;
  return Response.json(d);
 }
 if(u.pathname==='/rest/v1/rpc/get_public_profile'){
  assert.deepEqual(args,{p_profile_id:f.accounts[1].userId});const p=f.expectedProfiles[1];
  const d=Object.fromEntries(['displayName','age','gender','avatarPath','bio','interests','conversationStyles','mbti','completedCount','sweetness'].map(k=>[k,p[k]]));d.profileId=p.userId;
  if(f.breakCase==='public_extra'){d.realName=p.realName;d.userId=p.userId;}
  if(f.breakCase==='public_unmasked')d.displayName=p.realName;
  return Response.json(d);
 }
 throw Error('UNEXPECTED_OFFLINE_RPC');
};
if(f.useDirectEntry){process.argv[1]=f.factoryPath;process.argv[2]=f.fixturePath;process.argv[3]='--signed-service-profile-readonly';await import(pathToFileURL(f.factoryPath).href);assert.equal(count,5);}
else{const {signedServiceProfileReadonlyCase}=await import(pathToFileURL(f.factoryPath).href);
 const result=await signedServiceProfileReadonlyCase(f);assert.equal(count,5);process.stdout.write(JSON.stringify(result));}
'''


EXPIRED_WIRE = r'''
import assert from 'node:assert/strict';import {readFileSync}from'node:fs';import{pathToFileURL}from'node:url';
const f=JSON.parse(readFileSync(0,'utf8'));let reads=0;
globalThis.fetch=async(input,init={})=>{const u=new URL(String(input));reads++;
 assert.equal(u.origin,f.origin);assert.equal(u.pathname,'/auth/v1/user');assert.equal(init.method,'GET');
 assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+f.accounts[0].accessToken);
 return Response.json({error_code:'bad_jwt',msg:f.breakCase==='not_expiry'?'invalid signature':'invalid JWT: token is expired'},
 {status:f.breakCase==='auth_success'?200:403});};
if(f.useDirectEntry){process.argv[1]=f.factoryPath;process.argv[2]=f.fixturePath;process.argv[3]='--signed-service-profile-original-expired';await import(pathToFileURL(f.factoryPath).href);assert.equal(reads,1);}
else{const{originalExpiredMeCase}=await import(pathToFileURL(f.factoryPath).href);
 try{const result=await originalExpiredMeCase(f);assert.equal(reads,1);process.stdout.write(JSON.stringify(result));}
 catch(error){assert.equal(reads,f.breakCase==='not_expired'?0:1);throw error;}}
'''


class ServiceReadonlyPreparation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0,str(REPO/'tools/local'))
        with mock.patch.object(readonly,'ROOT',REPO):
            cls.ai=readonly.load('tests/integration/jonghyun/isolated_ai_contracts.py',readonly.sha((REPO/'tests/integration/jonghyun/isolated_ai_contracts.py').read_bytes()))
            cls.private=readonly.load('tools/local/prepare_auth_negative.py',readonly.sha((REPO/'tools/local/prepare_auth_negative.py').read_bytes()))
            cls.shared=readonly.load(readonly.POSITIVE,readonly.sha((REPO/readonly.POSITIVE).read_bytes()))
    def setUp(self):
        # 제품 소스 clone의 755 권한을 입력 보안 경계로 끌어들이지 않는다.
        self.directory = tempfile.TemporaryDirectory(prefix='yumidang-service-readonly-offline-')
        self.root = Path(self.directory.name).resolve(); self.root.chmod(0o700)
    def tearDown(self): self.directory.cleanup()
    def wire(self, break_case=None, prepared=None, direct=False):
        f = fixture() if prepared is None else prepared; f['evidence'] = str(self.root)
        if break_case: f['breakCase'] = break_case
        if direct:
            f.update(useDirectEntry=True,fixturePath=str(self.root/'direct-fixture.json'))
            Path(f['fixturePath']).write_bytes(readonly.canonical(f));Path(f['fixturePath']).chmod(0o600)
        p = subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', NODE_WIRE],
            input=json.dumps(f), capture_output=True, text=True, timeout=30, cwd=CANDIDATE)
        return f, p

    def expired_wire(self,break_case=None,direct=False):
        f=fixture();f.update(scope='ORIGINAL_AUTH6_EXPIRED_ME_ONLY',purpose='original_expired_me',
            activeReceiptSha256='d'*64,evidence=str(self.root))
        a=f['accounts'][0];now=int(time.time());claims=dict(sub=a['userId'],session_id=a['sessionId'],iss=f['origin']+'/auth/v1',
            role='authenticated',is_anonymous=False,iat=now-3601,exp=now-1)
        enc=lambda x:base64.urlsafe_b64encode(readonly.canonical(x)).rstrip(b'=').decode()
        a.update(expiresAt=claims['exp'],accessToken=enc({'alg':'HS256','typ':'JWT'})+'.'+enc(claims)+'.originalsignature')
        if break_case:f['breakCase']=break_case
        if break_case=='not_expired':
            claims.update(iat=now,exp=now+3600);a.update(expiresAt=claims['exp'],accessToken=enc({'alg':'HS256'})+'.'+enc(claims)+'.originalsignature')
        if direct:
            f.update(useDirectEntry=True,fixturePath=str(self.root/'direct-fixture.json'))
            Path(f['fixturePath']).write_bytes(readonly.canonical(f));Path(f['fixturePath']).chmod(0o600)
        p=subprocess.run(['node','--experimental-strip-types','--input-type=module','-e',EXPIRED_WIRE],
            input=json.dumps(f),capture_output=True,text=True,timeout=30,cwd=CANDIDATE)
        return f,p

    @unittest.skipUnless(shutil.which('node'),'Node 필요')
    def test_original_expired_mode_uses_real_product_runtime_and_one_fake_auth_no_rpc(self):
        f,p=self.expired_wire();self.assertEqual(p.returncode,0,p.stderr);result=json.loads(p.stdout)
        refs=readonly.verify_expired_responses(f,result,readonly.PrivateArtifacts(self.ai,self.private).private,self.root)
        self.assertEqual(len(refs),2);self.assertEqual(result['httpStatus'],401)
        self.assertEqual(result['actualAuthReads'],1);self.assertEqual(result['rpcCalls'],0)
        self.assertEqual(result['ttlSeconds'],3600);self.assertGreaterEqual(result['observedAt'],result['expiresAt'])

    @unittest.skipUnless(shutil.which('node'),'Node 필요')
    def test_expired_cli_mode_enters_exact_single_auth_purpose(self):
        f,p=self.expired_wire(direct=True);self.assertEqual(p.returncode,0,p.stderr)
        readonly.verify_expired_responses(f,json.loads(p.stdout),readonly.PrivateArtifacts(self.ai,self.private).private,self.root)

    @unittest.skipUnless(shutil.which('node'),'Node 필요')
    def test_active_cli_mode_preserves_four_case_dispatch(self):
        f,p=self.wire(direct=True);self.assertEqual(p.returncode,0,p.stderr)
        readonly.verify_private_responses(f,json.loads(p.stdout),readonly.PrivateArtifacts(self.ai,self.private).private,self.root)

    @unittest.skipUnless(shutil.which('node'),'Node 필요')
    def test_expired_mode_rejects_nonexpired_and_nonexpiry_auth_failure(self):
        for case in ['not_expired','not_expiry','auth_success']:
            # 각 첫 실행마다 고유 출력 디렉터리를 사용한다.
            with tempfile.TemporaryDirectory(prefix='expired-negative-',dir=self.root)as folder:
                previous=self.root;self.root=Path(folder)
                try:
                    _,p=self.expired_wire(case);self.assertNotEqual(p.returncode,0,case)
                finally:self.root=previous

    @unittest.skipUnless(shutil.which('node'),'Node 필요')
    def test_expired_raw_response_and_product_must_remain_hash_bound(self):
        f,p=self.expired_wire();self.assertEqual(p.returncode,0,p.stderr);result=json.loads(p.stdout)
        path=self.root/'service-expired-auth-private.json';path.write_bytes(b'{}')
        with self.assertRaises((ValueError,KeyError)):
            readonly.verify_expired_responses(f,result,readonly.PrivateArtifacts(self.ai,self.private).private,self.root)

    @unittest.skipUnless(shutil.which('node'), 'Node 필요')
    def test_actual_service_runtime_with_only_offline_auth_rpc_wire(self):
        f, p = self.wire(); self.assertEqual(p.returncode, 0, p.stderr)
        result = json.loads(p.stdout); readonly.verify_result(f, result)
        refs=readonly.verify_private_responses(f,result,readonly.PrivateArtifacts(self.ai,self.private).private,self.root)
        self.assertEqual(len(refs),9)
        self.assertEqual([c['httpStatus'] for c in result['cases']], [200,401,401,200])
        self.assertEqual(len(list(self.root.glob('service-readonly-auth-*-private.json'))), 3)
        self.assertEqual(len(list(self.root.glob('service-readonly-rpc-*-private.json'))), 2)
        for path in self.root.iterdir(): self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    @unittest.skipUnless(shutil.which('node'), 'Node 필요')
    def test_raw_auth_rpc_and_product_artifacts_are_required_and_hash_bound(self):
        f,p=self.wire();self.assertEqual(p.returncode,0,p.stderr);result=json.loads(p.stdout)
        reader=readonly.PrivateArtifacts(self.ai,self.private).private
        for name in ['service-readonly-auth-1-private.json','service-readonly-rpc-2-private.json','service-readonly-own-private.json']:
            path=self.root/name;raw=path.read_bytes();path.write_bytes(b'{}')
            with self.subTest(name=name),self.assertRaises((ValueError,KeyError)):
                readonly.verify_private_responses(f,result,reader,self.root)
            path.write_bytes(raw)
        path.unlink()
        with self.assertRaises(FileNotFoundError):readonly.verify_private_responses(f,result,reader,self.root)

    @unittest.skipUnless(shutil.which('node'), 'Node 필요')
    def test_actual_runtime_rejects_extra_own_field(self):
        _, p = self.wire('own_extra'); self.assertNotEqual(p.returncode, 0)
        self.assertIn('OWN_EXACT_DTO', p.stderr)

    @unittest.skipUnless(shutil.which('node'), 'Node 필요')
    def test_actual_runtime_rejects_wrong_own_actor(self):
        _, p = self.wire('own_wrong_actor'); self.assertNotEqual(p.returncode, 0)
        self.assertIn('OWN_VALUES', p.stderr)

    @unittest.skipUnless(shutil.which('node'), 'Node 필요')
    def test_actual_runtime_rejects_public_private_keys(self):
        _, p = self.wire('public_extra'); self.assertNotEqual(p.returncode, 0)
        self.assertIn('PUBLIC_EXACT_DTO', p.stderr)

    @unittest.skipUnless(shutil.which('node'), 'Node 필요')
    def test_actual_runtime_rejects_full_name_in_public_display(self):
        _, p = self.wire('public_unmasked'); self.assertNotEqual(p.returncode, 0)
        self.assertIn('MASKED_NAME', p.stderr)

    def test_result_requires_original_tokens_and_exact_counts(self):
        f = fixture(); readonly.verify_result(f, golden(f))
        mutations = [lambda r:r.update(fixtureWrites=1),lambda r:r.update(modelCalls=1),
            lambda r:r.update(reservationCalls=1),lambda r:r.update(nativeExternalAttempts=1),
            lambda r:r.update(authReads=True),lambda r:r['cases'][1].update(authReads=1),
            lambda r:r['cases'][2].update(rpcCalls=1),lambda r:r['cases'][0].update(tokenSha256='f'*64),
            lambda r:r['cases'][3].update(maskedOther=False),lambda r:r['cases'][0]['wire'][1].update(name='set_my_profile_avatar'),
            lambda r:r['cases'][2]['wire'][0].update(httpStatus=200),lambda r:r.update(expiredOriginal='PASS')]
        for change in mutations:
            value=golden(f);change(value)
            with self.subTest(index=mutations.index(change)),self.assertRaises(ValueError):readonly.verify_result(f,value)

    def test_prior_factory_all_function_bodies_preserved(self):
        new=(CANDIDATE/readonly.FACTORY).read_text()
        marker='/** 새 합성 Auth6/3공고 전용.'
        # 198 원본문 pin. shallow clone에서도 과거 Git object에 의존하지 않는다.
        self.assertEqual(readonly.sha(new[new.index(marker):].encode()),
            '18448f852abfb20d50fef50d3d68079793b0e6ad1673b763b640037adfbf68c2')

    def test_service_import_closure_is_expanded_and_fits_original_capsule_contract(self):
        graph=readonly.service_graph(REPO)
        for path in ['service-api/index.ts','service-api/handler.ts','_shared/auth/principal.ts',
                     '_shared/db/repositories/profiles.ts','_shared/http/response.ts']:
            self.assertIn('backend/supabase/functions/'+path,graph)
        self.assertLessEqual(len(graph)+1,256)
        self.assertTrue(all(p.startswith('backend/supabase/functions/') and p.endswith('.ts')for p in graph))

    def test_new_candidate_is_not_committed_and_does_not_get_skip_path(self):
        # 앞선 observer/positive gate는 명시된 fixture다. 현재 clone의 미커밋과 무관하게
        # 이 helper가 HEAD에 없는 단계까지 실제로 도달하고 그 단계가 거절하는지 검증한다.
        repo=self.root/'source-gate-fixture';repo.mkdir(mode=0o700)
        positive=b'hermetic positive source';helper=b'hermetic readonly source';head='a'*40
        for rel,raw in [(readonly.POSITIVE,positive),(readonly.SELF,helper)]:
            path=repo/rel;path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);path.write_bytes(raw)
        shared=SimpleNamespace(source_pins=mock.Mock(return_value=(head,{})))
        calls=[];in_head=False
        def git(command,*args,**kwargs):
            calls.append(command)
            if command==['git','-C',str(repo),'rev-parse','HEAD']:return head
            if command==['git','-C',str(repo),'show',head+':'+readonly.POSITIVE]:return positive
            if command==['git','-C',str(repo),'show',head+':'+readonly.SELF]:
                if not in_head:raise subprocess.CalledProcessError(128,command)
                return helper
            raise AssertionError('UNEXPECTED_HERMETIC_GIT_COMMAND')
        with mock.patch.object(readonly,'ROOT',repo),mock.patch.object(readonly,'load',return_value=shared)as loader,\
             mock.patch.object(readonly,'service_graph',return_value={}),\
             mock.patch.object(readonly.subprocess,'check_output',side_effect=git):
            with self.assertRaisesRegex(ValueError,'READONLY_SOURCE_NOT_COMMITTED'):readonly.source_pins()
            self.assertIn(['git','-C',str(repo),'show',head+':'+readonly.SELF],calls)
            shared.source_pins.assert_called_once_with(head)
            loader.assert_called_once_with(readonly.POSITIVE,readonly.sha(positive))
            in_head=True
            self.assertEqual(readonly.source_pins(),(head,{readonly.SELF:readonly.sha(helper)}))
            (repo/readonly.SELF).write_bytes(helper+b' changed')
            with self.assertRaisesRegex(ValueError,'READONLY_SOURCE_NOT_COMMITTED'):readonly.source_pins()
        tree=ast.parse(PATH.read_bytes())
        self.assertFalse(any(isinstance(n,ast.Attribute)and n.attr=='__new__'for n in ast.walk(tree)))
        self.assertNotIn('allowRetry',PATH.read_text());self.assertNotIn('skipIntent',PATH.read_text())

    def test_duplicate_and_nonfinite_json_rejected(self):
        for raw in [b'{"a":1,"a":2}',b'{"a":NaN}']:
            with self.assertRaises(ValueError):readonly.exact(raw)

    def test_readonly_purpose_does_not_call_ai_prepare_clean_or_fixture_write(self):
        tree=ast.parse(PATH.read_bytes())
        calls=[n for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)]
        self.assertFalse(any(n.func.attr in ('prepare','clean','sql','auth_user')for n in calls))
        self.assertTrue(any(n.func.attr=='sealed_runtime_capsule'for n in calls))

    def test_same_runtime_projection_rejects_restart_and_network_replacement(self):
        roles=['db','auth','rest','gateway'];network={'supabase_network_test':'1'*64}
        binding={'containers':{k:{'id':str(i)*64}for i,k in enumerate(roles,2)}}
        expected={k:dict(id=binding['containers'][k]['id'],startedAt='2026-10-20T00:00:00Z',restartCount=0,networks=network)for k in roles}
        readonly.verify_runtime_projection(expected,copy.deepcopy(expected),binding,[dict(name=next(iter(network)),id='1'*64)])
        for field,value in [('startedAt','2026-10-20T00:00:01Z'),('restartCount',1),('networks',{'bridge':'f'*64})]:
            actual=copy.deepcopy(expected);actual['auth'][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):
                readonly.verify_runtime_projection(expected,actual,binding,[dict(name=next(iter(network)),id='1'*64)])

    def expired_fixture(self):
        f=fixture();a=f['accounts'][0];a['expiresAt']=4600
        claims=dict(sub=a['userId'],session_id=a['sessionId'],iss=f['origin']+'/auth/v1',iat=1000,exp=4600,role='authenticated',is_anonymous=False)
        a['accessToken']='unit.'+base64.urlsafe_b64encode(readonly.canonical(claims)).rstrip(b'=').decode()+'.signature'
        binding=dict(accounts=f['accounts'],jwtIssuer=f['origin']+'/auth/v1',preparedRoot=str(self.root),containers={'db':{'id':'d'*64}})
        raw=b'  '+readonly.canonical(binding)+b'\n'
        active=dict(scope=readonly.SCOPE,status='PASS',standardSignedBindingValidated=True,originalBindingSha256=readonly.sha(raw),
            root=str(self.root),database={'id':'d'*64},runtimeIdentitySha256='1'*64,originalAuth6ReceiptSha256='2'*64,
            authRowsSha256='3'*64,banRevokeSha256='3'*64,sourceHead='a'*40,sourcePinsSha256='4'*64)
        current=dict(root=str(self.root),sourceId='d'*64,runtimeIdentitySha256='1'*64,auth6ReceiptSha256='2'*64,
            sourceHead='a'*40,sourcePinsSha256='4'*64,
            tokenSha256=readonly.sha(a['accessToken'].encode()),baselineAuthRowsSha256='3'*64,currentAuthRowsSha256='3'*64,
            baselineBanRevokeSha256='3'*64,currentBanRevokeSha256='3'*64,rowsUnchanged=True)
        return active,raw,claims,current

    def test_original_expired_preparation_never_claims_actual_rejection_or_dispatch(self):
        active,raw,claims,current=self.expired_fixture()
        result=readonly.prepare_original_expired_me(active,raw,raw,claims,current,now_epoch=4600)
        self.assertEqual(result['purpose'],'original_expired_me');self.assertFalse(result['dispatchAllowed'])
        self.assertEqual(result['actualAuth'],'NOT_RUN');self.assertEqual(result['actualProduct401'],'NOT_RUN')

    def test_expired_original_context_replacement_and_missing_evidence_rejected(self):
        mutations=[lambda a,r,c,p:p.update(sourceId='e'*64),lambda a,r,c,p:p.update(root='/private/tmp/another-context'),
            lambda a,r,c,p:p.update(runtimeIdentitySha256='4'*64),lambda a,r,c,p:p.update(auth6ReceiptSha256='4'*64),
            lambda a,r,c,p:p.update(sourceHead='b'*40),lambda a,r,c,p:p.update(sourcePinsSha256='5'*64),
            lambda a,r,c,p:p.update(tokenSha256='4'*64),lambda a,r,c,p:p.update(currentAuthRowsSha256='4'*64),
            lambda a,r,c,p:p.update(currentBanRevokeSha256='4'*64),lambda a,r,c,p:p.pop('rowsUnchanged'),
            lambda a,r,c,p:c.update(session_id=str(uuid.uuid4())),lambda a,r,c,p:c.update(iat=1001),
            lambda a,r,c,p:c.update(role='anon'),lambda a,r,c,p:a.update(standardSignedBindingValidated=False)]
        for mutate in mutations:
            active,raw,claims,current=self.expired_fixture();mutate(active,raw,claims,current)
            with self.subTest(index=mutations.index(mutate)),self.assertRaises((ValueError,KeyError)):
                readonly.prepare_original_expired_me(active,raw,raw,claims,current,now_epoch=4600)
        active,raw,claims,current=self.expired_fixture()
        with self.assertRaises(ValueError):readonly.prepare_original_expired_me(active,raw,raw+b' ',claims,current,now_epoch=4600)
        with self.assertRaises(ValueError):readonly.prepare_original_expired_me(active,raw,raw,claims,current,now_epoch=4599)

    def make_review(self, **changes):
        data=dict(decision_id='offline-readonly-test',root=str(self.root),source_head='a'*40,
            pins={k:'a'*64 for k in (readonly.SELF,readonly.FACTORY,readonly.POSITIVE)},binding_sha256='a'*64,
            auth6_receipt=str(self.root/('auth-provision-'+'b'*32)/'receipt.json'),auth6_receipt_sha256='a'*64,
            capsule_root='/private/tmp/yumidang-readonly-test-capsule/source',node_path=str(Path(shutil.which('node')).resolve()),
            node_sha256='a'*64,scope_id='c'*32,daemon_id=str(uuid.UUID(int=10)),
            runtime_identity_ref={'path':str(self.root/'service-profile-runtime-identity.json'),'sha256':'a'*64})
        data.update(changes)
        with mock.patch.object(readonly,'ROOT',REPO): return readonly.ReviewedServiceProfileReadonly(**data)

    def test_typed_review_rejects_repo_root_bad_capsule_and_missing_runtime_pin(self):
        self.make_review()
        for change in [dict(root=str(REPO)),dict(capsule_root=str(self.root/'capsule')),
                       dict(runtime_identity_ref={'path':str(self.root/'other.json'),'sha256':'a'*64}),
                       dict(runtime_identity_ref={}),dict(source_head='wrong'),dict(pins={readonly.FACTORY:'a'*64})]:
            with self.subTest(change=change),self.assertRaises(ValueError):self.make_review(**change)
        with self.assertRaises(ValueError):readonly.run_reviewed(SimpleNamespace())

    def fake_bind_run(self):
        run=object.__new__(readonly.ServiceProfileReadonlyRun)
        f=fixture();binding=dict(accounts=f['accounts'],containers={},credentials={'anon':'unit-anon','service':'unit-service'},
            origin=f['origin'],sourcePins={},evidenceRoot=str(self.root/('signed-auth-'+'a'*32)))
        raw=readonly.canonical(binding)
        receipt=dict(status='PASS_LOCAL_AUTH6_PROVISION_ONLY',accounts=6,bindingSha256=readonly.sha(raw),
            actualGoTrueAndDatabaseSessions=True,originalRowsPreserved=True,authAccountsRetained=True,
            actualNaver='NOT_RUN',actualAI22AI23AI24='NOT_RUN',creationReceiptRoot=str(self.root))
        runtime={};runtime_raw=readonly.canonical(runtime);receipt_raw=readonly.canonical(receipt)
        target=dict(versions=list(range(121)),id='d'*64,project='jonghyun-backend100-d020f001')
        run.root=self.root;run.evidence=self.root/('service-profile-readonly-'+'a'*32);run.evidence_owned=False
        run.value=dict(decisionId='offline-bind-only',daemonId=str(uuid.UUID(int=10)),sourceHead='a'*40,
            bindingSha256=readonly.sha(raw),auth6Receipt=str(self.root/'auth-receipt.json'),
            auth6ReceiptSha256=readonly.sha(receipt_raw),runtimeIdentity={'path':str(self.root/'service-profile-runtime-identity.json'),'sha256':readonly.sha(runtime_raw)})
        run.reviewed=SimpleNamespace(_sealed=b'offline-typed-caller-already-checked')
        files={str(self.root/'signed-ai-binding-private.json'):raw,str(self.root/'auth-receipt.json'):receipt_raw,
            str(self.root/'owned-networks.json'):b'[]',str(self.root/'service-profile-runtime-identity.json'):runtime_raw}
        run.read=lambda path:files[str(path)]
        run.writer=readonly.PrivateArtifacts(self.ai,self.private)
        run.failures=[];run.samples=[];run.done=threading.Event();run.deadline=10**20
        run.fixed_identity=mock.Mock();run.r=None
        port=SimpleNamespace(memory_kib=mock.Mock(return_value=1048576),settings=mock.Mock(return_value={
            'jwtExpirySeconds':3600,'anonymousEnabled':False,'signupDisabled':True}))
        def controls():
            self.assertTrue((self.root/'service-profile-readonly-intent.json').is_file())
            return {**{k:False for k in self.ai.PROVISION_CLOSED_CONTROLS},'cronLaunchActiveJobs':'off'}
        port.closed_controls=mock.Mock(side_effect=controls)
        class FakeBasePort:
            def __init__(self,reviewed):self.__dict__.update(port.__dict__)
        run.ai=SimpleNamespace(signed_prepared_target=mock.Mock(return_value=target),validate_signed_binding=mock.Mock(),
            SignedRunner=mock.Mock(return_value=SimpleNamespace()),ReviewedSignedProvisioning=mock.Mock(return_value=SimpleNamespace(prepared_root=self.root)),
            provisioning_metadata=mock.Mock(),FixedLifecycleProvisioningPorts=FakeBasePort,
            PROVISION_CLOSED_CONTROLS=self.ai.PROVISION_CLOSED_CONTROLS)
        return run,port,files,binding,target

    def test_standard_binding_gate_and_single_intent_precede_first_sql(self):
        run,port,files,binding,target=self.fake_bind_run();self.assertEqual(run.bind(),target)
        run.ai.validate_signed_binding.assert_called_once_with(binding,self.root,target)
        self.assertEqual(run.ai.validate_signed_binding.call_args.kwargs,{})
        port.closed_controls.assert_called_once()
        self.assertTrue(run.evidence_owned)
        again,again_port,_,_,_=self.fake_bind_run();again.evidence=self.root/'different-own-attempt'
        with self.assertRaises(FileExistsError):again.bind()
        again_port.closed_controls.assert_not_called()

    def test_expired_active_binding_is_not_revalidated_with_past_clock(self):
        run,port,_,_,_=self.fake_bind_run()
        run.ai.validate_signed_binding.side_effect=ValueError('SIGNED_ACCOUNT_METADATA')
        with self.assertRaisesRegex(ValueError,'SIGNED_ACCOUNT_METADATA'):run.bind()
        self.assertEqual(run.ai.validate_signed_binding.call_args.kwargs,{})
        port.closed_controls.assert_not_called();port.memory_kib.assert_not_called()
        self.assertFalse(run.evidence.exists())

    def test_binding_bytes_replacement_refused_before_any_ports(self):
        run,port,files,_,_=self.fake_bind_run()
        files[str(self.root/'signed-ai-binding-private.json')]+=b' '
        with self.assertRaisesRegex(ValueError,'ORIGINAL_PACKETS_CHANGED'):run.bind()
        run.ai.validate_signed_binding.assert_not_called();port.closed_controls.assert_not_called()

    def test_start_1g_and_maintenance_768_and_three_second_probe_bounds(self):
        run,port,_,_,_=self.fake_bind_run();run.port=port
        port.memory_kib.return_value=1048575
        with self.assertRaises(ValueError):run.memory(start=True)
        port.memory_kib.return_value=786432;run.memory()
        port.memory_kib.return_value=786431
        with self.assertRaises(ValueError):run.memory()
        port.memory_kib.return_value=1048576
        with mock.patch.object(readonly.time,'monotonic',side_effect=[0,3.001]):
            with self.assertRaises(ValueError):run.memory(start=True)

    def test_bind_under_1g_creates_no_intent_and_executes_no_sql(self):
        run,port,_,_,_=self.fake_bind_run();port.memory_kib.return_value=1048575
        with self.assertRaisesRegex(ValueError,'MEMORY_GUARD'):run.bind()
        self.assertFalse((self.root/'service-profile-readonly-intent.json').exists())
        port.closed_controls.assert_not_called()

    def test_owner_read_port_blocks_each_new_sql_after_monitor_or_deadline_failure(self):
        calls=[];owner=SimpleNamespace(binding={},failures=[],done=threading.Event(),deadline=time.monotonic()+60)
        owner.active=lambda:readonly.ServiceProfileReadonlyRun.active(owner)
        class Base:
            def __init__(self,reviewed):self.target={'versions':['v']}
            def read_sql(self,query,timeout=3):calls.append(query);return '["v"]'
        ai=SimpleNamespace(FixedLifecycleProvisioningPorts=Base,signed_verify_history=self.ai.signed_verify_history)
        port=readonly.monitored_read_ports(ai,SimpleNamespace(prepared_root=self.root),owner)
        self.assertEqual(port.history(),{'method':'SUPABASE_DB_HISTORY','native':'NOT_RUN'})
        self.assertEqual(len(calls),1)
        for mutate in [lambda:owner.failures.append('MEMORY'),lambda:owner.done.set(),lambda:setattr(owner,'deadline',0)]:
            mutate()
            with self.assertRaisesRegex(ValueError,'LIVE_GUARD'):port.read_sql('select 1;')
            with self.assertRaisesRegex(ValueError,'LIVE_GUARD'):port.history()
            self.assertEqual(len(calls),1)
            owner.failures.clear();owner.done.clear();owner.deadline=time.monotonic()+60
        def fail_during_sql(*args):calls.append('dispatched');owner.failures.append('MEMORY');return '1'
        with mock.patch.object(Base,'read_sql',side_effect=fail_during_sql):
            with self.assertRaisesRegex(ValueError,'LIVE_GUARD'):port.read_sql('select 1;')
        self.assertEqual(calls[-1],'dispatched')

    def test_dispatch_rechecks_original_binding_with_current_standard_validator_and_headroom(self):
        run,_,files,binding,target=self.fake_bind_run();run.bind()
        run.dispatch_binding()
        self.assertEqual(run.ai.validate_signed_binding.call_count,2)
        run.ai.validate_signed_binding.assert_called_with(binding,self.root,target)
        self.assertEqual(run.ai.validate_signed_binding.call_args.kwargs,{})
        with mock.patch.object(readonly.time,'time',return_value=binding['accounts'][0]['expiresAt']-300):
            with self.assertRaisesRegex(ValueError,'DISPATCH_EXPIRY'):run.dispatch_binding()
        files[str(self.root/'signed-ai-binding-private.json')]+=b' '
        with self.assertRaisesRegex(ValueError,'DISPATCH_BINDING_CHANGED'):run.dispatch_binding()

    def test_expiry_rejection_after_intent_prevents_first_node_dispatch(self):
        run,_,_,_,_=self.fake_bind_run();run.bind();run.fixture=fixture()
        run.capsule=mock.Mock();run.ai.validate_signed_binding.side_effect=ValueError('SIGNED_ACCOUNT_METADATA')
        with mock.patch.object(readonly.subprocess,'Popen')as start:
            with self.assertRaisesRegex(ValueError,'SIGNED_ACCOUNT_METADATA'):run.invoke()
        start.assert_not_called()
        self.assertTrue((run.evidence/'service-readonly-dispatch-intent.json').is_file())

    def test_capsule_binary_reuses_reviewed_regular_nonblocking_reader(self):
        node=self.root/'node';os.mkfifo(node,0o600)
        run=SimpleNamespace(ai=SimpleNamespace(sealed_runtime_capsule=mock.Mock()),private_module=self.private,
            writer=readonly.PrivateArtifacts(self.ai,self.private),value={'sourceHead':'a'*40,'capsuleRoot':'/private/tmp/test/source',
                'pins':{readonly.FACTORY:'a'*64},'nodePath':str(node),'nodeSha256':'a'*64})
        began=time.monotonic()
        with mock.patch.object(readonly,'service_graph',return_value={}):
            with self.assertRaisesRegex(ValueError,'BINARY_FILE'):readonly.ServiceProfileReadonlyRun.capsule(run)
        self.assertLess(time.monotonic()-began,2)

    def test_factory_stream_outcome_requires_both_durable_lengths_hashes_and_capture(self):
        stdout,stderr=b'{"status":"PASS"}',b''
        base={'privateRawOutputPreserved':True,'streamFailures':[],'stdoutBytes':len(stdout),'stderrBytes':0,
            'stdoutSha256':readonly.sha(stdout),'stderrSha256':readonly.sha(stderr)}
        shared=SimpleNamespace(PositiveRun=SimpleNamespace(finish_capture=lambda _: (stdout,stderr)))
        run=SimpleNamespace(shared=shared,evidence=self.root,read=lambda _:readonly.canonical(base))
        self.assertEqual(readonly.ServiceProfileReadonlyRun.finish_capture(run),(stdout,stderr))
        for key,value in [('privateRawOutputPreserved',False),('stdoutBytes',True),('stderrSha256','e'*64),
                          ('stdoutSha256','e'*64),('streamFailures',['READ_FAILED'])]:
            broken=copy.deepcopy(base);broken[key]=value;run.read=lambda _,data=broken:readonly.canonical(data)
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'RAW_STREAM_PROOF_CHANGED'):
                readonly.ServiceProfileReadonlyRun.finish_capture(run)

    def test_real_private_writer_is_exclusive_and_keeps_original_bytes(self):
        writer=readonly.PrivateArtifacts(self.ai,self.private)
        writer.save_bytes(self.root,'proof.json',b'{"synthetic":true}')
        self.assertEqual(writer.private(self.root/'proof.json'),b'{"synthetic":true}')
        self.assertEqual((self.root/'proof.json').stat().st_mode&0o777,0o600)
        with self.assertRaises(FileExistsError):writer.save_bytes(self.root,'proof.json',b'{}')

    def test_full178_bag_multiplicity_unknown_and_authority_preserved_without_exceptions(self):
        before={'rows':{'private.t'+str(i):{'a'*64:2}for i in range(178)},
            'authoritySha256':'b'*64,'constraintsSha256':'c'*64,'catalogSha256':'d'*64}
        self.shared.unchanged_except(before,copy.deepcopy(before),set())
        for mutate in [lambda a:a['rows']['private.t177'].update({'a'*64:1}),
                       lambda a:a.update(authoritySha256='e'*64),lambda a:a.update(constraintsSha256='e'*64),
                       lambda a:a.update(catalogSha256='e'*64),lambda a:a['rows'].pop('private.t1')]:
            after=copy.deepcopy(before);mutate(after)
            with self.subTest(mutate=mutate),self.assertRaises(ValueError):self.shared.unchanged_except(before,after,set())

    def active_packet(self):
        """원자료 연결 회귀용 합성 과거 영수증. 실제 Auth/DB 증거로 사용하지 않는다."""
        parent=self.root;scope='c'*32;evidence=parent/('service-profile-readonly-'+scope);evidence.mkdir(mode=0o700)
        _,raw,claims,_=self.expired_fixture();binding=readonly.exact(raw);f=fixture();f['accounts']=binding['accounts']
        self.root=evidence
        try:f,p=self.wire(prepared=f)
        finally:self.root=parent
        self.assertEqual(p.returncode,0,p.stderr);proof=json.loads(p.stdout)
        writer=readonly.PrivateArtifacts(self.ai,self.private)
        def save(path,value):
            path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            return writer.save_bytes(path.parent,path.name,value if type(value)is bytes else readonly.canonical(value))
        runtime_ref={'path':str(parent/'service-profile-runtime-identity.json'),'sha256':save(parent/'service-profile-runtime-identity.json',{})}
        binding.update(credentials={'anon':f['anon'],'service':f['service']},origin=f['origin'],sourcePins={},
            databaseManifestSha256=save(parent/'database-manifest.json',{}))
        binding_raw=readonly.canonical(binding);save(parent/'signed-ai-binding-private.json',binding_raw)
        receipt_path=parent/('auth-provision-'+'b'*32)/'receipt.json'
        auth6={'status':'PASS_LOCAL_AUTH6_PROVISION_ONLY','accounts':6,'bindingSha256':readonly.sha(binding_raw),
            'actualGoTrueAndDatabaseSessions':True,'originalRowsPreserved':True,'authAccountsRetained':True,
            'actualNaver':'NOT_RUN','actualAI22AI23AI24':'NOT_RUN','creationReceiptRoot':str(receipt_path.parent)}
        receipt_sha=save(receipt_path,auth6)
        pins={k:'a'*64 for k in (readonly.SELF,readonly.FACTORY,readonly.POSITIVE,
            'tests/integration/jonghyun/isolated_ai_contracts.py','tools/local/prepare_auth_negative.py')}
        review=self.make_review(binding_sha256=readonly.sha(binding_raw),auth6_receipt=str(receipt_path),pins=pins,
            auth6_receipt_sha256=receipt_sha,runtime_identity_ref=runtime_ref)
        v=review.descriptor();f.update(scopeId=scope,codeRoot=v['capsuleRoot'])
        fixture_path=evidence/'service-readonly-factory-private.json';fixture_sha=save(fixture_path,f)
        proof_path=evidence/'service-readonly-factory-proof.json';proof_sha=save(proof_path,proof)
        refs=readonly.verify_private_responses(f,proof,writer.private,evidence);save(evidence/'service-readonly-private-links.json',refs)
        save(evidence/'positive-factory-stdout-private.json',p.stdout.encode());save(evidence/'positive-factory-stderr-private.json',b'')
        save(evidence/'positive-factory-outcome.json',{'exitCode':0,'privateRawOutputPreserved':True,'streamFailures':[],
            'stdoutBytes':len(p.stdout.encode()),'stderrBytes':0,'stdoutSha256':readonly.sha(p.stdout.encode()),'stderrSha256':readonly.sha(b'')})
        save(evidence/'positive-child-closed.json',{'exited':True,'exitCode':0,'exactOwnedSessionOnly':True})
        final={'rows':{'private.t'+str(i):{'a'*64:22}for i in range(176)},
            'authoritySha256':'b'*64,'constraintsSha256':'c'*64,'catalogSha256':'d'*64}
        final['rows'].update({'auth.users':{'e'*64:6},'private.ai_account_budget_reservations':{'f'*64:2}})
        snapshot_sha=save(evidence/'before-private.json',final);save(evidence/'final-private.json',final)
        auth_sha=readonly.sha(readonly.canonical({'auth.users':{'e'*64:6}}))
        active={'scope':readonly.SCOPE,'status':'PASS','fixedFailures':[],'root':str(parent),'sourceHead':v['sourceHead'],
            'sourcePinsSha256':readonly.sha(readonly.canonical(v['pins'])),'originalBindingSha256':v['bindingSha256'],
            'originalAuth6ReceiptSha256':v['auth6ReceiptSha256'],'runtimeIdentitySha256':runtime_ref['sha256'],
            'database':{'id':'d'*64,'project':'jonghyun-backend100-d020f001'},'standardSignedBindingValidated':True,
            'ownedChildClosed':True,'activationAllowed':False,'automaticReplay':False,'fixtureWrites':0,'modelCalls':0,
            'reservationCalls':0,'containersStopped':0,'actualNaver':'NOT_RUN','expiredOriginal':'NOT_RUN_SAME_ORIGINAL_CONTEXT_REQUIRED',
            'memorySamples':[1048576,786432],'beforeSnapshotSha256':snapshot_sha,'finalSnapshotSha256':snapshot_sha,
            'authRowsSha256':auth_sha,'banRevokeSha256':auth_sha,'banRevokeScope':'FULL_AUTH_ROW_BAGS_INCLUDE_USER_BAN_AND_SESSION_ROWS',
            'actualPhaseReceipt':{'path':str(proof_path),'sha256':proof_sha},'privateResponses':refs,
            'factoryInput':{'path':str(fixture_path),'sha256':fixture_sha}}
        active['commandProofs']={name:{'path':str(evidence/name),'sha256':readonly.sha((evidence/name).read_bytes())}for name in
            ('positive-factory-stdout-private.json','positive-factory-stderr-private.json','positive-factory-outcome.json','positive-child-closed.json')}
        save(parent/'service-profile-readonly-intent.json',{'scope':readonly.SCOPE,'sourceHead':v['sourceHead'],
            'reviewSha256':readonly.sha(review._sealed),'originalBindingSha256':v['bindingSha256'],
            'originalAuth6ReceiptSha256':v['auth6ReceiptSha256'],'noReplay':True})
        path=evidence/'service-readonly-receipt.json';digest=save(path,active)
        expired=readonly.ReviewedOriginalExpiredMe('offline-expired-once',review,{'path':str(path),'sha256':digest})
        return expired,writer,final

    @unittest.skipUnless(shutil.which('node'),'Node 필요')
    def test_expired_typed_active_provenance_verifies_original_raw_and_full178(self):
        review,writer,final=self.active_packet()
        with mock.patch.object(readonly,'ROOT',REPO):
            active,binding,raw,fixture,expected,refs=readonly.original_active_evidence(review,writer.private,self.shared)
        self.assertEqual(expected,readonly.canonical(final));self.assertEqual(active['status'],'PASS')
        self.assertEqual(len(refs),23);self.assertEqual(binding['accounts'],fixture['accounts'])
        self.assertEqual(readonly.sha(raw),active['originalBindingSha256'])

    @unittest.skipUnless(shutil.which('node'),'Node 필요')
    def test_expired_provenance_rejects_changed_missing_and_cross_context_inputs(self):
        review,writer,_=self.active_packet();evidence=Path(review.descriptor()['activeReceipt']['path']).parent
        paths=[self.root/'signed-ai-binding-private.json',self.root/'service-profile-readonly-intent.json',
            self.root/'service-profile-runtime-identity.json',evidence/'before-private.json',evidence/'final-private.json',
            evidence/'service-readonly-factory-private.json',evidence/'service-readonly-factory-proof.json',
            evidence/'service-readonly-auth-1-private.json',evidence/'service-readonly-rpc-2-private.json',
            evidence/'service-readonly-public_other-private.json',evidence/'positive-child-closed.json',
            evidence/'positive-factory-outcome.json',evidence/'positive-factory-stdout-private.json',
            evidence/'service-readonly-receipt.json']
        for path in paths:
            raw=path.read_bytes();path.write_bytes(b'{"replaced":true}')
            with self.subTest(path=path.name),mock.patch.object(readonly,'ROOT',REPO),self.assertRaises((ValueError,KeyError)):
                readonly.original_active_evidence(review,writer.private,self.shared)
            path.write_bytes(raw)
        path.unlink()
        with mock.patch.object(readonly,'ROOT',REPO),self.assertRaises(FileNotFoundError):
            readonly.original_active_evidence(review,writer.private,self.shared)

    @unittest.skipUnless(shutil.which('node'),'Node 필요')
    def test_expired_ref_hash_does_not_replace_original_pass_source_memory_or_auth_requirements(self):
        review,writer,_=self.active_packet();ref=review.descriptor()['activeReceipt'];path=Path(ref['path']);original=path.read_bytes()
        mutations=[lambda v:v.update(sourceHead='b'*40),lambda v:v.update(runtimeIdentitySha256='e'*64),
            lambda v:v.update(sourcePinsSha256='e'*64),lambda v:v.update(standardSignedBindingValidated=False),
            lambda v:v.update(memorySamples=[786431]),lambda v:v.update(fixtureWrites=False),lambda v:v.update(ownedChildClosed=False),
            lambda v:v.update(authRowsSha256='e'*64),lambda v:v.update(status='FAIL'),lambda v:v.update(commandProofs={})]
        for i,mutate in enumerate(mutations):
            changed=readonly.exact(original);mutate(changed);raw=readonly.canonical(changed);path.write_bytes(raw)
            other=readonly.ReviewedOriginalExpiredMe('offline-expired-rejected',review.active_review,{'path':str(path),'sha256':readonly.sha(raw)})
            with self.subTest(i=i),mock.patch.object(readonly,'ROOT',REPO),self.assertRaises(ValueError):
                readonly.original_active_evidence(other,writer.private,self.shared)
        path.write_bytes(original)

    def test_expired_review_cannot_choose_new_source_or_accept_untyped_authority(self):
        active=self.make_review();ref={'path':str(self.root/('service-profile-readonly-'+'c'*32)/'service-readonly-receipt.json'),'sha256':'a'*64}
        readonly.ReviewedOriginalExpiredMe('offline-expired',active,ref)
        for other in [SimpleNamespace(),active.descriptor()]:
            with self.assertRaises(ValueError):readonly.ReviewedOriginalExpiredMe('offline-expired',other,ref)
        for change in [{'path':str(self.root/'new-context/receipt.json')},{'sha256':'wrong'},{'skip':True}]:
            changed={**ref,**change}
            with self.assertRaises(ValueError):readonly.ReviewedOriginalExpiredMe('offline-expired',active,changed)
        with self.assertRaises(ValueError):readonly.run_original_expired_me(active)

    def genuine_expired_run(self,review):
        v=review.active_review.descriptor()
        modules={readonly.POSITIVE:self.shared,'tests/integration/jonghyun/isolated_ai_contracts.py':self.ai,
            'tools/local/prepare_auth_negative.py':self.private}
        with mock.patch.object(readonly,'source_pins',return_value=(v['sourceHead'],v['pins'])),\
             mock.patch.object(readonly,'load',side_effect=lambda p,_:modules[p]):
            run=readonly.OriginalExpiredMeRun(review)
        target={'id':'d'*64,'project':'jonghyun-backend100-d020f001','versions':list(range(121))}
        calls=[]
        def bind_ports(binding,raw,t):
            run.binding=binding;run.binding_raw=raw;run.target=t
            def closed():
                self.assertTrue((self.root/'service-profile-original-expired-intent.json').is_file())
                calls.append('first-fixed-read-sql')
                return {**{k:False for k in self.ai.PROVISION_CLOSED_CONTROLS},'cronLaunchActiveJobs':'off'}
            run.port=SimpleNamespace(closed_controls=closed)
        run.bind_ports=bind_ports
        run.ai=SimpleNamespace(**{k:v for k,v in self.ai.__dict__.items()if not k.startswith('__')})
        run.ai.signed_prepared_target=mock.Mock(return_value=target);run.ai.validate_signed_binding=mock.Mock(side_effect=AssertionError('ACTIVE_VALIDATOR_MUST_NOT_BE_USED_FOR_EXPIRED_PURPOSE'))
        return run,calls

    @unittest.skipUnless(shutil.which('node'),'Node 필요')
    def test_expired_genuine_constructor_and_independent_intent_no_active_bypass_or_replay(self):
        review,writer,_=self.active_packet();run,calls=self.genuine_expired_run(review)
        old_intent=(self.root/'service-profile-readonly-intent.json').read_bytes()
        with mock.patch.object(readonly,'ROOT',REPO):run.bind()
        self.assertEqual(calls,['first-fixed-read-sql']);run.ai.validate_signed_binding.assert_not_called()
        self.assertEqual((self.root/'service-profile-readonly-intent.json').read_bytes(),old_intent)
        again,again_calls=self.genuine_expired_run(review)
        with mock.patch.object(readonly,'ROOT',REPO),self.assertRaisesRegex(ValueError,'NO_REPLAY'):again.bind()
        self.assertEqual(again_calls,[])
        self.assertTrue((run.evidence/'original-active-inputs.json').is_file())

    @unittest.skipUnless(shutil.which('node'),'Node 필요')
    def test_expired_current_full178_unknown_auth_and_authority_must_equal_original_active_final(self):
        review,_,final=self.active_packet();run,_=self.genuine_expired_run(review)
        with mock.patch.object(readonly,'ROOT',REPO):run.bind()
        evidence=run.evidence
        mutations=[lambda v:v['rows']['private.ai_account_budget_reservations'].update({'f'*64:1}),
            lambda v:v['rows']['auth.users'].update({'e'*64:5}),lambda v:v.update(authoritySha256='e'*64),
            lambda v:v.update(constraintsSha256='e'*64),lambda v:v.update(catalogSha256='e'*64)]
        for i,mutate in enumerate(mutations):
            value=copy.deepcopy(final);mutate(value);run.evidence=evidence/('drift-'+str(i));run.evidence.mkdir(mode=0o700)
            run.snapshot=lambda state=value:state
            with self.subTest(i=i),self.assertRaisesRegex(ValueError,'CURRENT_FULL178_CHANGED'):run.prepare_fixture()
            self.assertEqual(readonly.exact((run.evidence/'before-private.json').read_bytes()),value)
        run.evidence=evidence/'unchanged';run.evidence.mkdir(mode=0o700);run.snapshot=lambda:copy.deepcopy(final)
        run.prepare_fixture();self.assertEqual(run.fixture['purpose'],'original_expired_me')
        self.assertEqual(run.fixture['scope'],'ORIGINAL_AUTH6_EXPIRED_ME_ONLY')
        run.dispatch_binding();run.ai.validate_signed_binding.assert_not_called()

    def test_expired_executor_keeps_separate_scope_and_final_guard_with_two_raw_responses(self):
        active,base,calls=self.flow();ref={'path':str(self.root/('service-profile-readonly-'+'c'*32)/'service-readonly-receipt.json'),'sha256':'a'*64}
        reviewed=readonly.ReviewedOriginalExpiredMe('offline-expired-flow',active,ref)
        class FakeExpiredFlow(base):
            PHASE_SCOPE=readonly.EXPIRED_SCOPE
            STANDARD_ACTIVE=False
            EXPECTED_RESPONSES=2
            RECEIPT_NAME='service-expired-receipt.json'
            def __init__(self,review):super().__init__(review.active_review)
            def invoke(self):
                result=super().invoke()
                self.private_response_refs=dict(list(self.private_response_refs.items())[:2])
                return result
            def receipt_extra(self,result,errors):
                return {'purpose':'original_expired_me','expiredOriginal':'PASS_ORIGINAL_AUTH_EXPIRED_READONLY',
                    'historicalStandardActiveValidated':True,'ttlChanged':False,'clockChanged':False}
        with mock.patch.object(readonly,'OriginalExpiredMeRun',FakeExpiredFlow):result=readonly.run_original_expired_me(reviewed)
        self.assertEqual(result['scope'],readonly.EXPIRED_SCOPE);self.assertEqual(result['status'],'PASS')
        self.assertFalse(result['standardSignedBindingValidated']);self.assertTrue(result['historicalStandardActiveValidated'])
        self.assertEqual(len(result['privateResponses']),2);self.assertEqual(result['beforeSnapshotSha256'],result['finalSnapshotSha256'])
        self.assertIn(('save','service-expired-receipt.json'),calls);self.assertNotIn(('save','service-readonly-receipt.json'),calls)

    @unittest.skipUnless(shutil.which('node'),'Node 필요')
    def test_expired_dispatch_rechecks_active_source_inputs_and_exact_original_binding(self):
        review,_,final=self.active_packet();run,_=self.genuine_expired_run(review)
        with mock.patch.object(readonly,'ROOT',REPO):run.bind()
        run.snapshot=lambda:copy.deepcopy(final);run.prepare_fixture();run.dispatch_binding()
        original=(self.root/'signed-ai-binding-private.json').read_bytes()
        (self.root/'signed-ai-binding-private.json').write_bytes(original+b' ')
        with self.assertRaisesRegex(ValueError,'DISPATCH_BINDING_CHANGED'):run.dispatch_binding()
        (self.root/'signed-ai-binding-private.json').write_bytes(original)
        original_path=Path(review.descriptor()['activeReceipt']['path']);data=original_path.read_bytes();original_path.write_bytes(data+b' ')
        with self.assertRaisesRegex(ValueError,'ACTIVE_INPUT_CHANGED'):run.dispatch_binding()
        run.ai.validate_signed_binding.assert_not_called()

    def flow(self, *, drift=False, close_failure=False):
        review=self.make_review();parent=self;calls=[];durable=readonly.ServiceProfileReadonlyRun.durable_command_proofs
        baseline={'rows':{'private.t'+str(i):{'a'*64:2}for i in range(176)},
            'authoritySha256':'b'*64,'constraintsSha256':'c'*64,'catalogSha256':'d'*64}
        baseline['rows'].update({'auth.users':{'e'*64:6},'private.ai_account_budget_reservations':{'f'*64:2}})
        class FakeReadonlyFlow:
            PHASE_SCOPE=readonly.SCOPE
            STANDARD_ACTIVE=True
            EXPECTED_RESPONSES=9
            RECEIPT_NAME='service-readonly-receipt.json'
            def __init__(self, reviewed):
                self.value=reviewed.descriptor();self.root=parent.root;self.evidence=parent.root/'fake-flow-evidence'
                self.evidence.mkdir(mode=0o700);self.evidence_owned=True
                self.done=threading.Event();self.thread=None;self.failures=[];self.samples=[1048576]
                self.child=None;self.before=None;self.shared=parent.shared
                self.factory_proof=None;self.private_response_refs=None;self.factory_input=None;self.command_proofs=None
                self.writer=readonly.PrivateArtifacts(parent.ai,parent.private)
            def save(self,name,value):
                calls.append(('save',name));return self.writer.save_bytes(self.evidence,name,readonly.canonical(value))
            def read(self,path):return self.writer.private(path)
            def final_provenance(self):pass
            def receipt_extra(self,result,errors):return {}
            def durable_command_proofs(self):return durable(self)
            def bind(self):return {'id':'d'*64,'project':'jonghyun-backend100-d020f001'}
            def monitor(self):self.done.wait(5)
            def prepare_fixture(self):self.before=copy.deepcopy(baseline);self.save('before-private.json',self.before)
            def invoke(self):
                calls.append(('invoke','active-four-only'))
                raw=readonly.canonical(golden(fixture()));digest=self.writer.save_bytes(self.evidence,'factory-proof.json',raw)
                self.factory_proof={'path':str(self.evidence/'factory-proof.json'),'sha256':digest}
                self.factory_input=self.factory_proof
                self.writer.save_bytes(self.evidence,'positive-factory-stdout-private.json',raw)
                self.writer.save_bytes(self.evidence,'positive-factory-stderr-private.json',b'')
                self.save('positive-factory-outcome.json',{'exitCode':0,'privateRawOutputPreserved':True,'streamFailures':[],
                    'stdoutBytes':len(raw),'stderrBytes':0,'stdoutSha256':readonly.sha(raw),'stderrSha256':readonly.sha(b'')})
                self.save('positive-child-closed.json',{'exited':True,'exitCode':0,'exactOwnedSessionOnly':True})
                self.private_response_refs={}
                for i in range(9):
                    name='raw-'+str(i)+'.json';digest=self.writer.save_bytes(self.evidence,name,b'{}')
                    self.private_response_refs[name]={'path':str(self.evidence/name),'sha256':digest}
                if close_failure:self.child=SimpleNamespace(pid=1234)
                return golden(fixture())
            def close_child(self):
                calls.append(('close',self.child is None))
                if close_failure:raise ValueError('OWNED_CHILD_GROUP_REMAINS')
                self.child=None
            def snapshot(self):
                calls.append(('snapshot','final'));value=copy.deepcopy(baseline)
                if drift:value['rows']['private.ai_account_budget_reservations']['f'*64]=1
                return value
        return review,FakeReadonlyFlow,calls

    def test_fake_typed_flow_closes_child_then_saves_full_final_before_pass(self):
        review,flow,calls=self.flow()
        with mock.patch.object(readonly,'ServiceProfileReadonlyRun',flow):result=readonly.run_reviewed(review)
        self.assertEqual(result['status'],'PASS');self.assertTrue(result['ownedChildClosed'])
        self.assertEqual(result['fixtureWrites'],0);self.assertEqual(result['reservationCalls'],0)
        self.assertLess(calls.index(('close',True)),calls.index(('snapshot','final')))
        self.assertLess(calls.index(('save','final-private.json')),calls.index(('save','service-readonly-receipt.json')))
        self.assertEqual(result['beforeSnapshotSha256'],result['finalSnapshotSha256'])
        self.assertEqual(result['expiredOriginal'],'NOT_RUN_SAME_ORIGINAL_CONTEXT_REQUIRED')

    def test_fake_typed_final_unknown_drift_retains_raw_final_and_fails(self):
        review,flow,calls=self.flow(drift=True)
        with mock.patch.object(readonly,'ServiceProfileReadonlyRun',flow):
            with self.assertRaisesRegex(ValueError,'FAILED_CLOSED'):readonly.run_reviewed(review)
        output=self.root/'fake-flow-evidence';final=json.loads((output/'final-private.json').read_bytes())
        self.assertEqual(final['rows']['private.ai_account_budget_reservations']['f'*64],1)
        result=json.loads((output/'service-readonly-receipt.json').read_bytes())
        self.assertEqual(result['status'],'FAIL');self.assertIn('READONLY_FINAL_PRESERVATION_NOT_PROVEN',result['fixedFailures'])

    def test_fake_typed_child_group_failure_prevents_final_sql_and_pass(self):
        review,flow,calls=self.flow(close_failure=True)
        with mock.patch.object(readonly,'ServiceProfileReadonlyRun',flow):
            with self.assertRaises(ValueError):readonly.run_reviewed(review)
        self.assertNotIn(('snapshot','final'),calls)
        result=json.loads((self.root/'fake-flow-evidence/service-readonly-receipt.json').read_bytes())
        self.assertEqual(result['status'],'FAIL');self.assertFalse(result['ownedChildClosed'])
        self.assertIsNone(result['finalSnapshotSha256'])


if __name__=='__main__':unittest.main()
