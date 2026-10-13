"""기존 자원 보존 경계의 모형 검사. 도커·인증·SQL 실제 호출은 없다."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import sqlite3
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT/'tools/local'))
sys.path.insert(0, str(ROOT/'tests/integration/jonghyun'))
import run_database_tests as guard
import isolated_ai_contracts as ai


def sha(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


class PreservedGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='preserved-guard-')
        self.root=Path(self.tmp.name).resolve();self.root.chmod(0o700)
        self.project='jonghyun-backend100-a1234567'
        self.host='unix://'+str(Path.home()/'.colima/jonghyun-backend100/docker.sock')
        self.old={'Id':'a'*64,'Name':'/supabase_db_jonghyun-backend100-b1234567','Image':'sha256:'+'b'*64,
                  'Config':{'Labels':{'com.supabase.cli.project':'jonghyun-backend100-b1234567'}},
                  'HostConfig':{'ReadonlyRootfs':False},'Mounts':[],
                  'State':{'Running':True,'Status':'running','OOMKilled':False}}
        self.new=copy.deepcopy(self.old);self.new.update(Id='c'*64,Name='/supabase_db_'+self.project)
        self.new['Config']={'Labels':{'com.supabase.cli.project':self.project}}
        self.net={'Id':'d'*64,'Name':'supabase_network_jonghyun-backend100-b1234567','Containers':{}}
        self.vol={'Name':'supabase_db_jonghyun-backend100-b1234567','Labels':{'test':'original'}}
        old={'id':self.old['Id'],'name':self.old['Name'][1:],'image':self.old['Image'],
             'labelsSha256':sha(self.old['Config']['Labels']),'configSha256':sha(self.old['Config']),
             'hostConfigSha256':sha(self.old['HostConfig']),'mountsSha256':sha(self.old['Mounts']),
             'state':{'running':True,'status':'running','oomKilled':False}}
        self.baseline={'version':1,'scope':'OBSERVED_EXISTING_RESOURCES_METADATA_ONLY','profile':'jonghyun-backend100',
            'dockerHost':self.host,'containers':[old],'customNetworks':[{'id':self.net['Id'],'name':self.net['Name'],'inspectionSha256':sha(self.net)}],
            'volumes':[{'name':self.vol['Name'],'inspectionSha256':sha(self.vol)}],
            'existingDatabaseOrStorageRead':'NOT_RUN','existingMutationCommands':'NOT_RUN',
            'wholeStoredBytesPreserved':'NOT_VERIFIED','baselineMetadataSha256':'0'*64}
        raw=self.write('protected-resource-baseline.json',self.baseline)
        self.intent={'version':2,'context':'colima-jonghyun-backend100','dockerHost':self.host,'project':self.project,
            'scope':'new-synthetic-only','existingContainers':[{'id':old['id'],'name':old['name']}],
            'existingNetworks':[{'id':self.net['Id'],'name':self.net['Name']}],'preservedBaselineSha256':hashlib.sha256(raw).hexdigest()}
        self.owned=[{'id':self.new['Id'],'name':self.new['Name'][1:],'image':self.new['Image']}]
        self.write('execution-intent.json',self.intent);self.write('owned-containers.json',self.owned)
        self.extra_id=None;self.extra_net=False;self.extra_vol=False;self.calls=[]

    def tearDown(self): self.tmp.cleanup()

    def write(self,name,value):
        raw=json.dumps(value,sort_keys=True).encode();path=self.root/name;path.write_bytes(raw);path.chmod(0o600);return raw

    def call(self,args,data=None):
        self.calls.append(args)
        if args[:2]==['context','inspect']:return self.host
        if args[0]=='ps':return '\n'.join([self.old['Id'],self.new['Id']]+([self.extra_id]if self.extra_id else []))
        if args[0]=='inspect':
            found={self.old['Id']:self.old,self.new['Id']:self.new}
            return json.dumps([found[key]for key in args[1:]])
        if args[:2]==['network','ls']:
            items=[{'ID':self.net['Id'],'Name':self.net['Name']},{'ID':'bridge','Name':'bridge'}]
            if self.extra_net:items.append({'ID':'e'*64,'Name':'unexpected-network'})
            return '\n'.join(map(json.dumps,items))
        if args[:2]==['network','inspect']:return json.dumps([self.net])
        if args[:2]==['volume','ls']:return self.vol['Name']+('\nextra-volume'if self.extra_vol else '')
        if args[:2]==['volume','inspect']:return json.dumps([self.vol])
        if args[0]=='exec':return 'SQL_MODEL_ONLY'
        raise AssertionError('UNEXPECTED_COMMAND')

    def verify(self):guard.verify_preserved_resources(self.root,self.host,self.project,self.call)

    def test_pure_contract_does_not_call_docker_and_live_matches(self):
        result=guard.preserved_contract(self.root,self.intent,self.owned,self.host,self.project)
        self.assertEqual(result['baseline'],self.baseline);self.assertEqual(self.calls,[])
        self.verify();self.assertTrue(self.calls)
        self.assertFalse(any(c[0]in('run','stop','rm','start')or c[:2]in(['network','create'],['volume','rm'])for c in self.calls))

    def test_legacy_empty_never_activates_preservation(self):
        self.write('execution-intent.json',{'existingContainers':[],'existingNetworks':[]})
        self.verify();self.assertEqual(self.calls,[])
        self.assertIsNone(guard.preserved_contract(self.root,{'existingContainers':[],'existingNetworks':[]},[],self.host,self.project))
        with self.assertRaises(ValueError):guard.preserved_contract(self.root,{'existingContainers':[{}],'existingNetworks':[]},[],self.host,self.project)

    def test_baseline_tamper_unknown_version_and_fake_flags_rejected(self):
        for mutate in [lambda x:x.update(version=True),lambda x:x.update(version=3),lambda x:x.update(actualReady=True),lambda x:x.update(preservedBaselineSha256='f'*64),lambda x:x.update(existingContainers=[])]:
            value=copy.deepcopy(self.intent);mutate(value)
            with self.assertRaises(ValueError):guard.preserved_contract(self.root,value,self.owned,self.host,self.project)

    def test_owned_collision_and_wrong_project_rejected(self):
        for owned in [[{'id':self.old['Id'],'name':self.new['Name'][1:],'image':self.new['Image']}],
                      [{'id':self.new['Id'],'name':self.old['Name'][1:],'image':self.new['Image']}],self.owned*2]:
            self.write('owned-containers.json',owned)
            with self.assertRaises(ValueError):guard.preserved_contract(self.root,self.intent,owned,self.host,self.project)

    def test_private_permissions_link_and_mutated_fd_rejected(self):
        path=self.root/'protected-resource-baseline.json';path.chmod(0o644)
        with self.assertRaises(ValueError):guard.preserved_private_bytes(self.root,path.name)
        path.chmod(0o600);os.link(path,self.root/'other.json')
        with self.assertRaises(ValueError):guard.preserved_private_bytes(self.root,path.name)
        (self.root/'other.json').unlink()
        original=os.fstat;count=0
        def changed(fd):
            nonlocal count
            count+=1
            if count==2:path.write_bytes(b'changed')
            return original(fd)
        with patch.object(guard.os,'fstat',side_effect=changed):
            with self.assertRaises(ValueError):guard.preserved_private_bytes(self.root,path.name)

    def test_container_state_image_config_mount_changes_fail(self):
        original=copy.deepcopy(self.old)
        for key,value in [('State',{'Running':False,'Status':'exited','OOMKilled':False}),('Image','sha256:'+'f'*64),
                          ('Config',{'Labels':{}}),('HostConfig',{}),('Mounts',[{'Name':'changed'}])]:
            self.old=copy.deepcopy(original);self.old[key]=value
            with self.assertRaises(ValueError):self.verify()

    def test_unexpected_inventory_network_attachment_volume_changes_fail(self):
        self.extra_id='f'*64
        with self.assertRaises(ValueError):self.verify()
        self.extra_id=None;self.extra_net=True
        with self.assertRaises(ValueError):self.verify()
        self.extra_net=False;self.extra_vol=True
        with self.assertRaises(ValueError):self.verify()
        self.extra_vol=False;self.net['Containers']={'new':{'Name':self.new['Name']}}
        with self.assertRaises(ValueError):self.verify()

    def test_read_failure_never_calls_mutation(self):
        with self.assertRaises(RuntimeError):guard.verify_preserved_resources(self.root,self.host,self.project,lambda args:(_ for _ in ()).throw(RuntimeError('MODEL_READ_FAILURE')))
        self.assertEqual(self.calls,[])

    def test_original_pins_reject_replacing_baseline_intent_or_owned_receipts(self):
        pins=guard.preserved_resource_pins(self.root,self.intent)
        guard.verify_preserved_resources(self.root,self.host,self.project,self.call,pins)
        other=copy.deepcopy(self.intent);other['preservedBaselineSha256']='f'*64
        self.write('execution-intent.json',other)
        with self.assertRaises(ValueError):guard.verify_preserved_resources(self.root,self.host,self.project,self.call,pins)
        self.write('execution-intent.json',self.intent)
        self.write('owned-containers.json',list(reversed(self.owned))+self.owned)
        with self.assertRaises(ValueError):guard.verify_preserved_resources(self.root,self.host,self.project,self.call,pins)

    def test_v2_descriptor_cannot_downgrade_to_legacy_empty(self):
        pins=guard.preserved_resource_pins(self.root,self.intent)
        for value in [{'version':1,'existingContainers':[],'existingNetworks':[]},{'existingContainers':[],'existingNetworks':[]}]:
            self.write('execution-intent.json',value)
            with self.assertRaisesRegex(ValueError,'PRESERVED_PIN_CHANGED'):
                guard.verify_preserved_resources(self.root,self.host,self.project,self.call,pins)
        self.assertEqual(self.calls,[])

    def test_declared_new_network_and_volume_collisions_fail_before_live(self):
        self.write('owned-networks.json',[{'id':self.net['Id'],'name':'supabase_network_'+self.project}])
        with self.assertRaises(ValueError):guard.preserved_contract(self.root,self.intent,self.owned,self.host,self.project)
        (self.root/'owned-networks.json').unlink()
        self.write('owned-volumes.json',[{'name':self.vol['Name']}])
        with self.assertRaises(ValueError):guard.preserved_contract(self.root,self.intent,self.owned,self.host,self.project)

    def test_runner_sql_before_and_after_and_post_failure(self):
        runner=object.__new__(ai.Runner);runner.root=self.root
        runner.target={'host':self.host,'project':self.project,'id':self.new['Id'],'image':self.new['Image'],'container':self.new['Name'][1:],'context':'colima-jonghyun-backend100'}
        runner.target['preservedResourcePins']=guard.preserved_resource_pins(self.root,self.intent)
        runner.call=self.call
        self.assertEqual(runner.sql('select synthetic;'),'SQL_MODEL_ONLY')
        self.assertEqual(sum(c[0]=='ps'for c in self.calls),2)
        def change(args,data=None):
            if args[0]=='exec':self.old['State']['Running']=False;return 'SQL_MODEL_ONLY'
            return self.call(args,data)
        runner.call=change
        with self.assertRaises(ValueError):runner.sql('select synthetic;')

    def test_signed_reader_supports_os_temp_and_rejects_outside(self):
        self.assertEqual(ai.signed_private_read(self.root/'execution-intent.json'),(self.root/'execution-intent.json').read_bytes())
        with self.assertRaises(ValueError):ai.signed_private_read(Path('/etc/hosts'))

    def test_provision_amr_requires_exact_six_owners_and_keeps_unknown_table(self):
        accounts=[{'userId':str(uuid.uuid4())}for _ in range(6)]
        baseline={table:{}for table in ai.PROVISION_OWNED_TABLES};baseline['storage.objects']={}
        added={table:{}for table in ai.PROVISION_OWNED_TABLES}
        for table in added:
            for account in accounts:
                for operation in (('login','user_signedup')if table=='auth.audit_log_entries'else('row',)):
                    h=sha([table,account['userId'],operation])
                    added[table][h]={'rowSha256':h,'ownerUserId':account['userId'],'operation':operation}
        current={table:{row['rowSha256']:1 for row in added.get(table,{}).values()}for table in baseline}
        ai.provisioning_added_scope(baseline,current,added,accounts)
        self.assertEqual(len(ai.LCP_TABLES),len(set(ai.LCP_TABLES)))
        wrong=copy.deepcopy(added);next(iter(wrong['auth.mfa_amr_claims'].values()))['ownerUserId']=str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError,'PROVISION_ADDED_ROW'):
            ai.provisioning_added_scope(baseline,current,wrong,accounts)
        missing=copy.deepcopy(added);missing['auth.mfa_amr_claims'].pop(next(iter(missing['auth.mfa_amr_claims'])))
        with self.assertRaisesRegex(ValueError,'PROVISION_ADDED_ROW_COUNT'):
            ai.provisioning_added_scope(baseline,current,missing,accounts)
        foreign=copy.deepcopy(current);foreign['storage.objects']['f'*64]=1
        with self.assertRaisesRegex(ValueError,'PROVISION_UNOWNED_ROW_CHANGED'):
            ai.provisioning_added_scope(baseline,foreign,added,accounts)

    def test_amr_owner_query_rejects_other_session_other_user_and_other_method(self):
        account={'userId':str(uuid.uuid4()),'sessionId':str(uuid.uuid4()),'authEmail':'synthetic@example.invalid'}
        ports=object.__new__(ai.FixedSignedProvisioningPorts);queries=[]
        ports.read_sql=lambda query,timeout=3:(queries.append(query)or'{}')
        ports.added_rows({},[account])
        query=next(q for q in queries if 'from auth.mfa_amr_claims'in q)
        condition=query.rsplit(' on ',1)[1].removesuffix(';').replace('::text','')
        with sqlite3.connect(':memory:')as db:
            db.execute("attach database ':memory:' as auth")
            db.execute('create table auth.sessions(id text,user_id text)')
            db.execute('create table auth.mfa_amr_claims(id text,session_id text,authentication_method text)')
            db.execute('create table owners(user_id text,session_id text)')
            db.execute('insert into owners values(?,?)',(account['userId'],account['sessionId']))
            db.execute('insert into auth.sessions values(?,?)',(account['sessionId'],account['userId']))
            db.executemany('insert into auth.mfa_amr_claims values(?,?,?)',[
                ('owned',account['sessionId'],'password'),('other-method',account['sessionId'],'totp'),('other-session','foreign-session','password')])
            sql='select r.id from auth.mfa_amr_claims r join owners a on '+condition
            self.assertEqual(db.execute(sql).fetchall(),[('owned',)])
            db.execute('update auth.sessions set user_id=?',(str(uuid.uuid4()),))
            self.assertEqual(db.execute(sql).fetchall(),[])

    def test_bulk_provision_snapshot_keeps_original_four_schemas_and_duplicate_counts(self):
        ports=object.__new__(ai.FixedSignedProvisioningPorts);calls=[]
        schemas=['auth','public','private','storage','cron','vault']
        bags={schema+'.fixture':{'a'*64:2,'b'*64:1}for schema in schemas}
        def read(query,timeout=5):
            calls.append(query)
            return json.dumps([[schema,'fixture']for schema in schemas]) if 'from pg_tables'in query else json.dumps(bags)
        ports.read_sql=read
        result=ports.original_rows()
        self.assertEqual(result,{k:v for k,v in bags.items()if k.split('.')[0]in ('auth','public','private','storage')})
        self.assertEqual(len(calls),2)
        self.assertEqual(result['auth.fixture']['a'*64],2)
        bags['auth.fixture']['a'*64]=0
        with self.assertRaises(ValueError):ports.original_rows()


if __name__=='__main__':unittest.main()
