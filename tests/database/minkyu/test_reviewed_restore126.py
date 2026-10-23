"""정확126 복원 준비/오프라인 소비 회귀. 실제 SQL·capture·restore를 실행하지 않는다."""
import ast
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools/local'))
import prepare_database_restore as core
import prepare_restore_source_manifest as manifest
import verify_restoration_readiness as secure
import prepare_migrations


def raw(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def digest(v):
    return hashlib.sha256(raw(v)).hexdigest()


def state(deleted=False):
    return {'snapshot': {'rows': {'private.ai_budget_reservations': '1:' + '1'*32,
            'public.profiles': ('0:' + '2'*32) if deleted else '1:' + '3'*32},
            'catalog': 'synthetic catalog', 'roles': {'roles': [{'rolname': 'postgres'}], 'memberships': []}},
        'rawAuthority': {'database': ['postgres', 'postgres', 'UTF8', 'C.UTF-8', 'C.UTF-8',
                        'c', None, None, -1, True, False, 'pg_default', None, [], None],
                        'schemas': [], 'relations': [], 'columns': [], 'functions': [],
                        'defaults': [], 'dbRoleSettings': []},
        'effectivePrivileges': [['postgres', 'schema', 'public', 'USAGE', True]],
        'sequences': {'public.synthetic_seq': [41, True]}}


LOCALE = {'encoding': 'UTF8', 'collate': 'C.UTF-8', 'ctype': 'C.UTF-8', 'provider': 'c',
          'locale': None, 'version': None, 'actualVersion': None, 'icuRules': None}


class Restore126Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='yumidang-restore126-unit-')
        cls.repo = Path(cls.temp.name).resolve()
        cls.git('init', '-q')
        cls.git('config', 'user.name', 'Synthetic fixture')
        cls.git('config', 'user.email', 'fixture@example.invalid')
        # 실제 등록된126 SQL 바이트는 읽어 고정한다. SQL 실행은 하지 않는다.
        for item in prepare_migrations.inspect_migrations(ROOT)['migrations']:
            cls.copy(item['path'])
        for name in manifest.SOURCE_FILES | {'tools/local/prepare_migrations.py',
                'tools/local/prepare_database.py', 'tools/local/prepare_edge.py',
                'tools/local/prepare_current_policy.py'}:
            cls.copy(name)
        cls.git('add', '.')
        cls.git('commit', '-qm', 'Synthetic exact126 bytes')
        cls.head = core.head(cls.repo)
        cls.entries = prepare_migrations.inspect_migrations(cls.repo)['migrations']
        cls.files = {name: hashlib.sha256((cls.repo/name).read_bytes()).hexdigest()
                     for name in manifest.SOURCE_FILES}

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    @classmethod
    def git(cls, *args):
        return subprocess.check_output(['git', '-C', str(cls.repo), *args], stderr=subprocess.DEVNULL)

    @classmethod
    def copy(cls, name):
        p = cls.repo/name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes((ROOT/name).read_bytes())

    def setUp(self):
        for module, name in ((secure, 'ReviewedMatching126RestoreProfile'),
                (secure, 'ReviewedMatching126RestoreEvidence'),
                (secure, 'verify_matching126_restore_evidence'),
                (manifest, 'prepare_reviewed_matching126_restore'),
                (core, 'prepare_matching126_restore_review')):
            self.assertTrue(callable(getattr(module, name, None)), 'missing normal126 API: ' + name)

    def value(self):
        return {'version': 1, 'scope': 'MATCHING126_DATABASE_RESTORE_REVIEW_ONLY',
            'sourceHead': self.head, 'migrationsSha256': digest(self.entries),
            'captureId': '12345678-1234-4234-8234-123456789abc',
            'sourceIdentity': {'id': 'c'*64, 'name': 'synthetic-source', 'image': 'd'*64},
            'targetProject': 'jonghyun-backend100-1234abcd',
            'relations': sorted(state()['snapshot']['rows']), 'roles': ['postgres'],
            'sequences': ['public.synthetic_seq'],
            'unknownIds': ['23456789-1234-4234-8234-123456789abc'],
            'deletionPlan': [{'relation': 'public.profiles', 'rowIdentity': 'synthetic-id'}],
            'sourceStateSha256': digest(state()), 'reappliedStateSha256': digest(state(True)),
            'storageMetadata': 45, 'storageOriginals': 6, 'storageMissing': 39,
            'migrations': copy.deepcopy(self.entries),
            'sourcePins': {**self.files, **{x['path']: x['sha256'] for x in self.entries}},
            'databaseLocaleSha256': digest(LOCALE)}

    def profile(self, value=None):
        return secure.ReviewedMatching126RestoreProfile(raw(self.value() if value is None else value))

    def test_exact126_preparation_has_no_execution_or_target_authority(self):
        profile = self.profile()
        result = manifest.prepare_reviewed_matching126_restore(self.repo, profile)
        self.assertEqual(result['review']['status'], 'PREPARED_NOT_RUN')
        self.assertEqual(result['review']['scope'], 'MATCHING126_DATABASE_RESTORE_PREPARATION_ONLY')
        self.assertEqual(result['source']['migrationCount'], 126)
        self.assertEqual(result['source']['migrations'], self.entries)
        for k in ('executionAllowed', 'runnable', 'fullRestore'):
            self.assertIs(result['review'][k], False)
        self.assertEqual(result['review']['capture'], 'NOT_RUN')
        self.assertEqual(result['review']['restore'], 'NOT_RUN')
        self.assertNotIn('targetId', result['review'])
        self.assertNotIn('intentId', result['review'])

    def test125_127_hash_count_scope_and_missing_source_pin_are_rejected(self):
        for change in ('125', '127', 'hash', 'pin', 'pinvalue', 'scope', 'head'):
            v = self.value()
            if change == '125': v['migrations'].pop()
            if change == '127': v['migrations'].append({**v['migrations'][-1], 'path': 'backend/supabase/migrations/20261024000000_unreviewed.sql', 'version': '20261024000000'})
            if change == 'hash': v['migrations'][0]['sha256'] = '0'*64
            if change == 'pin': v['sourcePins'].pop(next(iter(self.files)))
            if change == 'pinvalue': v['sourcePins'][next(iter(self.files))] = '0'*64
            if change == 'scope': v['scope'] = 'CURRENT124_DATABASE_RESTORE_REVIEW_ONLY'
            if change == 'head': v['sourceHead'] = '0'*40
            with self.subTest(change=change), self.assertRaises((secure.VerificationError, manifest.ManifestRefused, ValueError)):
                manifest.prepare_reviewed_matching126_restore(self.repo, self.profile(v))

    def test_actual125_or_unregistered127_git_source_is_rejected_even_with_new_head(self):
        for count in (125,127):
            with self.subTest(count=count), tempfile.TemporaryDirectory(prefix='restore126-cross-') as temp:
                repo=Path(temp).resolve()/'repo'
                subprocess.run(['git','clone','--no-hardlinks',str(self.repo),str(repo)],
                               check=True,capture_output=True)
                def git(*args):
                    return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.DEVNULL)
                if count==125:
                    (repo/self.entries[-1]['path']).unlink()
                else:
                    (repo/'backend/supabase/migrations/20261024000000_unreviewed.sql').write_text('select 127;')
                git('add','.')
                git('-c','user.name=Synthetic fixture','-c','user.email=fixture@example.invalid',
                    'commit','-qm','Different actual migration set')
                v=self.value();v['sourceHead']=core.head(repo)
                with self.assertRaises(ValueError):
                    manifest.prepare_reviewed_matching126_restore(repo,self.profile(v))

    def test_old124_and_new126_types_cannot_cross_approve(self):
        v = self.value()
        with self.assertRaises(secure.VerificationError): secure.ReviewedCurrentRestoreProfile(raw(v))
        profile = self.profile()
        with self.assertRaises(secure.VerificationError): core.prepare_current124_restore_review(profile, {})
        with self.assertRaises(secure.VerificationError): secure.verify_current_restore_evidence(profile, {})

    def test_working_source_bytes_are_not_approved_by_new_profile(self):
        path = self.repo/'tools/local/prepare_database_restore.py'
        before = path.read_bytes()
        try:
            path.write_bytes(before + b'\n# uncommitted\n')
            with self.assertRaises((manifest.ManifestRefused, secure.VerificationError)):
                manifest.prepare_reviewed_matching126_restore(self.repo, self.profile())
        finally: path.write_bytes(before)

    def packet(self):
        p = self.profile()
        binding = {k: p.value()[k] for k in ('sourceHead','migrationsSha256','captureId','sourceIdentity','targetProject')}
        binding.update(profileSha256=p.sha256, targetId='e'*64, intentId='34567890-1234-4234-8234-123456789abc')
        unknown = [{'id': p.value()['unknownIds'][0], 'status':'UNKNOWN',
                    'fullReservationAndLedgerRows': {'reservation': {'state':'UNKNOWN'}, 'ledger': {'reserved': 1}}}]
        payloads = {'sourceState':state(), 'restoredState':state(), 'reappliedState':state(True),
            'sourceUnknown':unknown, 'restoredUnknown':unknown, 'reappliedUnknown':unknown,
            'deletionPlan':p.value()['deletionPlan'], 'sourceLocale':LOCALE,
            'restoredLocale':LOCALE, 'reappliedLocale':LOCALE}
        data={}; refs={}
        for kind,payload in payloads.items():
            path='/private/tmp/synthetic-restore126/'+kind+'.json'
            data[path]=raw({'kind':kind,'binding':binding,'payload':payload})
            refs[kind]={'path':path,'sha256':hashlib.sha256(data[path]).hexdigest()}
        receipts={}
        phases={'capture':('sourceState','sourceUnknown','sourceLocale'),
                'restore':('restoredState','restoredUnknown','restoredLocale'),
                'deletionReapply':('reappliedState','reappliedUnknown','reappliedLocale','deletionPlan')}
        for phase,kinds in phases.items():
            path='/private/tmp/synthetic-restore126/receipt-'+phase+'.json'
            receipt={'scope':'MATCHING126_DATABASE_ONLY_PRODUCER','phase':phase,
                'status':'COMPLETED_DATABASE_ONLY','binding':binding,
                'artifacts':{k:refs[k]['sha256'] for k in kinds}, 'ownChildClosed':True,
                'sourcePreserved':True, 'existingMetadataPreserved':True,
                'automaticReplay':False,'fullRestore':False}
            data[path]=raw(receipt); receipts[phase]={'path':path,'sha256':hashlib.sha256(data[path]).hexdigest()}
        return p, {'version':1,'binding':binding,'artifacts':refs,'originalReceipts':receipts},data

    def consume(self, p, packet, data):
        return secure.verify_matching126_restore_evidence(p,
            secure.ReviewedMatching126RestoreEvidence(raw(packet)), data.__getitem__)

    def change(self, packet, data, kind, change, *, receipt=False):
        ref=packet['originalReceipts' if receipt else 'artifacts'][kind]
        v=json.loads(data[ref['path']]);change(v if receipt else v['payload'])
        data[ref['path']]=raw(v);ref['sha256']=hashlib.sha256(data[ref['path']]).hexdigest()
        if not receipt:
            for phase,r in packet['originalReceipts'].items():
                body=json.loads(data[r['path']])
                if kind in body['artifacts']:
                    body['artifacts'][kind]=ref['sha256'];data[r['path']]=raw(body);r['sha256']=hashlib.sha256(data[r['path']]).hexdigest()

    def test_complete_synthetic_values_still_cannot_be_runtime_or_full_restore_pass(self):
        p,packet,data=self.packet();r=self.consume(p,packet,data)
        self.assertEqual(r['status'],'MATCHING126_OFFLINE_EVIDENCE_MATCHED')
        self.assertEqual(r['runtimeValidation'],'NOT_INDEPENDENTLY_EXECUTED')
        self.assertEqual(r['captureImplementation'],'NOT_RUN')
        self.assertEqual(r['restoreImplementation'],'NOT_RUN')
        self.assertFalse(r['fullRestore']);self.assertFalse(r['executionAllowed'])
        self.assertEqual(r['sequenceScope'],'LAST_VALUE_IS_CALLED_ONLY')
        self.assertEqual(r['storageScope'],'HISTORICAL45_MAPPING_NOT_CURRENT_BYTES')

    def test_incomplete_failed_or_unclosed_producer_never_matches(self):
        for phase in ('capture','restore','deletionReapply'):
            for field,value in (('status','NOT_RUN'),('status','FAIL_CLOSED'),('ownChildClosed',False),
                                ('sourcePreserved',False),('binding',{}),('artifacts',{})):
                p,packet,data=self.packet()
                self.change(packet,data,phase,lambda v:v.update({field:value}),receipt=True)
                with self.subTest(phase=phase,field=field,value=value),self.assertRaises(secure.VerificationError):
                    self.consume(p,packet,data)

    def test_locale_roles_acl_sequence_unknown_and_unplanned_deletion_each_reject(self):
        cases=[('restoredLocale',lambda v:v.update(actualVersion='wrong')),
            ('restoredState',lambda v:v['snapshot']['roles']['memberships'].append('foreign')),
            ('restoredState',lambda v:v['rawAuthority']['functions'].append('newgrant')),
            ('restoredState',lambda v:v['sequences'].update({'public.synthetic_seq':[42,True]})),
            ('restoredUnknown',lambda v:v[0]['fullReservationAndLedgerRows']['ledger'].update(reserved=0)),
            ('deletionPlan',lambda v:v.append({'relation':'public.profiles','rowIdentity':'other'})),
            ('reappliedState',lambda v:v['snapshot']['rows'].update({'private.ai_budget_reservations':'0:'+'0'*32}))]
        for kind,change in cases:
            p,packet,data=self.packet();self.change(packet,data,kind,change)
            with self.subTest(kind=kind),self.assertRaises((secure.VerificationError,core.RestoreError)):
                self.consume(p,packet,data)

    def test_ref_swap_and_extra_profile_bypass_fields_reject(self):
        p,packet,data=self.packet();calls={}
        def reader(path):
            calls[path]=calls.get(path,0)+1
            return data[path] + (b' ' if calls[path]>1 else b'')
        with self.assertRaises(secure.VerificationError):
            secure.verify_matching126_restore_evidence(p, secure.ReviewedMatching126RestoreEvidence(raw(packet)), reader)
        v=self.value();v['allowExecution']=True
        with self.assertRaises(secure.VerificationError):self.profile(v)

    def test_artifact_swap_during_final_producer_read_is_rejected(self):
        p,packet,data=self.packet();calls={}
        last=packet['originalReceipts']['deletionReapply']['path']
        changed=packet['artifacts']['sourceState']['path']
        def reader(path):
            calls[path]=calls.get(path,0)+1
            if path==last and calls[path]==3:
                data[changed]+=b' '
            return data[path]
        with self.assertRaises(secure.VerificationError):
            secure.verify_matching126_restore_evidence(p,
                secure.ReviewedMatching126RestoreEvidence(raw(packet)), reader)

    def test_legacy_code_and_extracted124_checks_are_semantically_identical(self):
        base='8598a2966192062062571ac1e93df7a4a536d868'
        pins={'prepare_database_restore.py':'ea763d40631c93cf5d276dc3da577b8b3ecfa751cef759ca7c73bb48517f9a70',
              'prepare_restore_source_manifest.py':'d331b47acb36db992f12cb43e581e4891c91567a9f90f4401033b7afb08c82c9',
              'verify_restoration_readiness.py':'fe9d49d860400579c9f138430d81b5357b7c265dcacc5a62349e1073419a2136'}
        def dump(v):
            return ast.dump(ast.Module(body=v,type_ignores=[]),include_attributes=False)
        for name,pin in pins.items():
            old=subprocess.check_output(['git','-C',str(ROOT),'show',base+':tools/local/'+name])
            self.assertEqual(hashlib.sha256(old).hexdigest(),pin)
            before=ast.parse(old);after=ast.parse((ROOT/'tools/local'/name).read_bytes())
            index={n.name:n for n in after.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
            altered={'ReviewedCurrentRestoreProfile','ReviewedCurrentRestoreEvidence','verify_current_restore_evidence'} if name=='verify_restoration_readiness.py' else set()
            for n in before.body:
                if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name not in altered:
                    self.assertEqual(dump([n]),dump([index[n.name]]),name+':'+n.name)
            if not altered:continue
            previous={n.name:n for n in before.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
            class Specialize(ast.NodeTransformer):
                def visit_Name(self,n):
                    if n.id=='scope':return ast.Constant('CURRENT124_DATABASE_RESTORE_REVIEW_ONLY')
                    if n.id=='artifact_names':return ast.Name(id='_CURRENT_ARTIFACTS',ctx=ast.Load())
                    return n
                def visit_BinOp(self,n):
                    if isinstance(n.op,ast.BitOr) and isinstance(n.right,ast.Call) and isinstance(n.right.func,ast.Name) and n.right.func.id=='set':
                        if len(n.right.args)==1 and isinstance(n.right.args[0],ast.Name) and n.right.args[0].id=='extra_fields':return self.visit(n.left)
                    return self.generic_visit(n)
            def specialized(nodes):return [Specialize().visit(copy.deepcopy(n)) for n in nodes]
            for cls,helper in (('ReviewedCurrentRestoreProfile','_validate_restore_profile'),
                               ('ReviewedCurrentRestoreEvidence','_validate_restore_evidence')):
                oldmethod=next(n for n in previous[cls].body if isinstance(n,ast.FunctionDef))
                body=index[helper].body
                if isinstance(body[0],ast.Expr) and isinstance(body[0].value,ast.Constant):body=body[1:]
                self.assertEqual(dump(oldmethod.body),dump(specialized(body)))
            oldfn=previous['verify_current_restore_evidence'];helper=index['_verify_restore_evidence_values']
            start=next(i for i,n in enumerate(oldfn.body) if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id=='binding')
            self.assertEqual(dump(oldfn.body[start:-1]),dump(specialized(helper.body[2:-1])))
            self.assertEqual(dump([oldfn.body[-1]]),dump([index['verify_current_restore_evidence'].body[-1]]))


if __name__=='__main__':unittest.main()
