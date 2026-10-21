"""Batch의 원 kernel 해시/문자열 동등성 및 실패 차단. DB/Docker 실행 0."""
import ast
from contextlib import contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import os
import tempfile
import threading
from dataclasses import replace
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch

ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('d03_timeout_batch_unit',ROOT/'tools/local/collect_d03_timeout_batch.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
KERNEL=(ROOT/m.KERNEL).read_bytes();DEADLINE=(ROOT/m.DEADLINE).read_bytes()
TABLES=('auth.users','private.ai_budget_ledgers')

class BatchTests(unittest.TestCase):
    def raw(self):
        return {'tables':json.dumps([t.split('.')for t in TABLES]),'rows':json.dumps({TABLES[0]:{'a'*64:2},TABLES[1]:{}}),
            'authority':'b'*64,'constraints':'[ {"x": 1, "y": 2} ]',
            'catalog':'{"relations" : [{"name": "가", "quote": "a\\\\b"}], "columns" : []}'}
    def test_original_kernel_dynamic_dispatch_all_five_queries_and_hashes(self):
        queries=m.kernel_queries(KERNEL,TABLES);raw=self.raw();calls=[]
        tree=ast.parse(KERNEL)
        classes=[]
        for name,names in [('FixedSignedProvisioningPorts',('snapshot',)),('FixedLifecycleProvisioningPorts',('original_rows','snapshot'))]:
            node=next(n for n in tree.body if isinstance(n,ast.ClassDef)and n.name==name)
            classes.append(ast.ClassDef(name=name,bases=[]if name=='FixedSignedProvisioningPorts'else[ast.Name(id='FixedSignedProvisioningPorts',ctx=ast.Load())],keywords=[],body=[n for n in node.body if isinstance(n,ast.FunctionDef)and n.name in names],decorator_list=[]))
        env={'json':json,'re':m.re,'hashlib':hashlib,'signed_exact_json':m.exact}
        exec(compile(ast.fix_missing_locations(ast.Module(body=classes,type_ignores=[])),'<original-kernel>','exec'),env)
        obj=env['FixedLifecycleProvisioningPorts']()
        def read(q,timeout=5):
            calls.append(q);return raw[next(k for k,v in queries.items()if v==q)]
        obj.read_sql=read
        original=obj.snapshot()
        self.assertEqual(original,m.snapshot_from(raw,TABLES));self.assertEqual(len(calls),5)
        self.assertEqual(set(calls),set(queries.values()));self.assertEqual(original['rows'][TABLES[0]]['a'*64],2)
    def test_catalog_and_constraints_hash_original_text_not_json_reserialization(self):
        raw=self.raw();actual=m.snapshot_from(raw,TABLES)
        self.assertEqual(actual['constraintsSha256'],m.sha(raw['constraints'].strip().encode()))
        self.assertEqual(actual['catalogSha256'],m.sha(raw['catalog'].strip().encode()))
        self.assertNotEqual(actual['catalogSha256'],m.sha(m.canonical(m.exact(raw['catalog']))))
        self.assertEqual(actual['authoritySha256'],'b'*64)
    def test_exact_roster_and_bag_keys_not_count_only(self):
        for key,value in [('tables',json.dumps([['auth','users'],['private','other']])),('rows',json.dumps({'auth.users':{},'private.other':{}}))]:
            raw=self.raw();raw[key]=value
            with self.assertRaises(ValueError):m.snapshot_from(raw,TABLES)
    def test_complete_reviewed_large_inventory_uses_exact_names(self):
        tables=tuple('private.t'+str(n).zfill(3)for n in range(182))
        queries=m.kernel_queries(KERNEL,tables)
        self.assertEqual(queries['rows'].count('::text table_name'),182)
        raw=self.raw();raw['tables']=json.dumps([t.split('.')for t in tables]);raw['rows']=json.dumps({t:{}for t in tables})
        self.assertEqual(set(m.snapshot_from(raw,tables)['rows']),set(tables))
        raw['tables']=json.dumps([t.split('.')for t in tables[:-1]]+[['private','unexpected']])
        with self.assertRaisesRegex(ValueError,'TABLE_SET'):m.snapshot_from(raw,tables)
    def test_duplicate_count_bool_zero_and_negative_refused(self):
        for n in (True,0,-1,1.2):
            raw=self.raw();raw['rows']=json.dumps({TABLES[0]:{'a'*64:n},TABLES[1]:{}})
            with self.subTest(n=n),self.assertRaisesRegex(ValueError,'ROW_BAG'):m.snapshot_from(raw,TABLES)
    def test_empty_table_kept_and_duplicate_row_count_preserved(self):
        self.assertEqual(m.snapshot_from(self.raw(),TABLES)['rows'],{TABLES[0]:{'a'*64:2},TABLES[1]:{}})
    def test_envelope_preserves_each_original_text_and_read_only_rr(self):
        queries=m.kernel_queries(KERNEL,TABLES);sql=m.batch_sql(queries).decode()
        self.assertTrue(sql.startswith('begin isolation level repeatable read read only;'))
        self.assertTrue(sql.endswith('rollback;\n'))
        for q in queries.values():self.assertIn('('+q[:-1]+')::text',sql)
        self.assertNotIn(')::jsonb',sql)
    def test_added_statement_and_unreviewed_table_schema_refused(self):
        with self.assertRaises(ValueError):m.batch_sql({'roles':'select 1;delete from t;'})
        with self.assertRaises(ValueError):m.kernel_queries(KERNEL,('pg_catalog.pg_class',))
    def test_candidate_same_keys_and_sha_as_original_collector(self):
        raw=self.raw();extra,basis=m.collection_queries(DEADLINE)
        raw.update(roles='[{"role": "authenticated", "settings": ["statement_timeout=8s"]}]',routines='[{"identity": "public.f()", "definition": "select 1"}]')
        rest={'Id':'rest-id','Image':'sha256:image','Config':{'Env':['PGRST_DB_CONFIG=true','PGRST_DB_URI=postgresql://local/db','IGNORED_SECRET=not-exported'],'Cmd':['postgrest'],'Entrypoint':['entry']},'Mounts':[]}
        tree=ast.parse(DEADLINE);fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='collect_timeout_preflight')
        env={'sha':m.sha,'canonical':m.canonical,'POSTGREST_V16_BASIS':tuple(basis)}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),'<original-collector>','exec'),env)
        runtime=Mock();runtime.readonly.exact=m.exact;runtime.sql.side_effect=lambda q:raw['roles'];runtime.core.port.read_sql.return_value=raw['routines']
        runtime.core.r.call.return_value=json.dumps([rest]);runtime.core.binding={'containers':{'rest':{'id':'rest-id'}}};runtime.core.root=Path('/private/tmp/fresh');runtime.review.source_head='a'*40
        original=env['collect_timeout_preflight'](runtime)
        actual=m.timeout_candidate(raw,rest,'a'*40,Path('/private/tmp/fresh'),basis)
        self.assertEqual(actual,original);self.assertEqual(m.sha(m.canonical(actual)),m.sha(m.canonical(original)))
    def transport_case(self,mode):
        saves=[];runner=Mock();runner.call.return_value='OTHER'if mode=='backend'else'ABSENT'
        kernel=Mock(HOST='synthetic');kernel.close_process_group.return_value={'closed':mode!='pg'}
        def save(name,value):
            saves.append(name)
            if mode=='save'and name.endswith('-raw-private.json'):raise OSError('raw save')
            if mode=='intent'and name.endswith('-intent.json'):raise OSError('intent save')
        transport=m.BatchTransport(kernel,runner,'own-db',save,Mock())
        def create(argv,**kw):
            if mode=='popen':raise OSError('popen')
            raw=b'{"pid":123,"backendStart":"synthetic"}\n{"x":"value"}\n'
            if mode=='marker':raw=b'bad\n{}\n'
            if mode=='overflow':raw+=b'x'*8388608
            kw['stdout'].write(raw)
            return SimpleNamespace(poll=lambda:0,returncode=1 if mode=='exit'else 0)
        with patch.object(m.subprocess,'Popen',side_effect=create)as popen:
            if mode=='ok':self.assertEqual(transport.run(b'fixed'),{'x':'value'});self.assertFalse(transport.sticky)
            else:
                with self.assertRaises(Exception):transport.run(b'fixed')
                self.assertTrue(transport.sticky);calls=popen.call_count
                with self.assertRaisesRegex(ValueError,'STICKY'):transport.run(b'fixed')
                self.assertEqual(popen.call_count,calls)
    def test_success_and_all_ambiguous_failures_sticky_no_second_sql(self):
        for mode in ('ok','intent','save','popen','marker','pg','backend','exit','overflow'):
            with self.subTest(mode=mode):self.transport_case(mode)
    def test_context_exit_failure_and_late_finalization_forbid_receipt(self):
        @contextmanager
        def failed():
            yield
            raise ValueError('late context')
        gate=m.FinalReceiptGate();gate.finalized=True;save=Mock()
        with self.assertRaisesRegex(ValueError,'late context'):
            with gate.support(failed()):pass
        with self.assertRaisesRegex(ValueError,'NOT_PERMITTED'):gate.publish(save,{})
        save.assert_not_called()
        @contextmanager
        def success():yield
        gate=m.FinalReceiptGate()
        with gate.support(success()):pass
        with self.assertRaisesRegex(ValueError,'NOT_PERMITTED'):gate.publish(save,{})
        gate.finalized=True;gate.publish(save,{});save.assert_called_once_with('receipt.json',{})
    def test_anchor_accepts_concurrent_own_evidence_files(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
            root=Path(directory);path=root/'binding.json';path.write_bytes(b'original');path.chmod(0o600)
            anchor=m.PrivateFileAnchor(path,m.sha(b'original'),lambda p:p.read_bytes())
            failures=[]
            def evidence():
                try:
                    for n in range(100):(root/('command-'+str(n)+'.json')).write_bytes(b'evidence')
                except BaseException as e:failures.append(e)
            worker=threading.Thread(target=evidence);worker.start()
            try:
                for _ in range(100):anchor.check()
                worker.join();anchor.check();self.assertEqual(failures,[])
            finally:worker.join();anchor.close()
    def test_anchor_rejects_binding_bytes_permissions_links_and_replace(self):
        for mode in ('bytes','permissions','hardlink','symlink','replace'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
                root=Path(directory);path=root/'binding.json';path.write_bytes(b'original');path.chmod(0o600)
                anchor=m.PrivateFileAnchor(path,m.sha(b'original'),lambda p:p.read_bytes())
                try:
                    if mode=='bytes':path.write_bytes(b'changed!')
                    elif mode=='permissions':path.chmod(0o644)
                    elif mode=='hardlink':os.link(path,root/'other')
                    elif mode=='symlink':path.rename(root/'old');path.symlink_to(root/'old')
                    else:path.rename(root/'old');path.write_bytes(b'original');path.chmod(0o600)
                    with self.assertRaises((ValueError,OSError)):anchor.check()
                finally:anchor.close()
    def test_anchor_rejects_parent_replacement_or_permission_change(self):
        for mode in ('replace','mode','symlink'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
                root=Path(directory);parent=root/'auth';parent.mkdir(mode=0o700);path=parent/'receipt.json';path.write_bytes(b'receipt');path.chmod(0o600)
                anchor=m.PrivateFileAnchor(path,m.sha(b'receipt'),lambda p:p.read_bytes())
                try:
                    if mode=='mode':parent.chmod(0o755)
                    else:
                        parent.rename(root/'old')
                        if mode=='symlink':parent.symlink_to(root/'old',target_is_directory=True)
                        else:
                            parent.mkdir(mode=0o700);(parent/'receipt.json').write_bytes(b'receipt');(parent/'receipt.json').chmod(0o600)
                    with self.assertRaises((ValueError,OSError)):anchor.check()
                finally:anchor.close()
    def test_anchor_initial_secure_reader_and_digest_cannot_be_skipped(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
            path=Path(directory)/'binding';path.write_bytes(b'original');path.chmod(0o600)
            reader=Mock(side_effect=ValueError('private rejected'))
            with self.assertRaisesRegex(ValueError,'private rejected'):m.PrivateFileAnchor(path,m.sha(b'original'),reader)
            reader.assert_called_once_with(path)
            with self.assertRaisesRegex(ValueError,'INITIAL_PRIVATE'):m.PrivateFileAnchor(path,'0'*64,lambda p:p.read_bytes())
    def test_authority_descriptor_covers_every_literal_and_raw_source_bytes(self):
        a=m.ReviewedD03ReadonlyBatch(b'{"head":"h"}','a'*64,'b'*64,'c'*64,'d'*64,'auth/receipt.json','e'*64,TABLES,m.sha(m.canonical(list(TABLES))),'root','timeout-batch-root')
        descriptor=a.descriptor();self.assertEqual(set(descriptor),set(a.__dict__))
        self.assertEqual(descriptor['source_kwargs_bytes'],m.sha(a.source_kwargs_bytes))
        before=m.sha(m.canonical(descriptor))
        for key in a.__dict__:
            value=getattr(a,key)
            changed=value+b' 'if type(value)is bytes else value+('private.extra',)if type(value)is tuple else value+'x'
            self.assertNotEqual(before,m.sha(m.canonical(replace(a,**{key:changed}).descriptor())),key)
    def test_output_writer_private_exclusive_fd_and_directory_fsync(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
            output=Path(directory)/'output';output.mkdir(mode=0o700);writer=m.PrivateOutputWriter(output)
            try:
                value={'raw':'자료'}
                with patch.object(m.os,'fsync',wraps=os.fsync)as sync:
                    self.assertEqual(writer.save('raw.json',value),m.sha(m.canonical(value)))
                    self.assertEqual(sync.call_count,2)
                self.assertEqual((output/'raw.json').read_bytes(),m.canonical(value));self.assertEqual((output/'raw.json').stat().st_mode&0o777,0o600)
                with self.assertRaises(FileExistsError):writer.save('raw.json',value)
            finally:writer.close()
    def test_output_saved_bytes_length_permissions_and_links_bound_to_hash(self):
        for mode in ('content','length','permissions','hardlink'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
                output=Path(directory)/'output';output.mkdir(mode=0o700);writer=m.PrivateOutputWriter(output)
                real_sync=os.fsync;changed=[]
                def tamper(fd):
                    real_sync(fd)
                    if not changed and (output/'raw.json').exists():
                        changed.append(True);path=output/'raw.json'
                        if mode=='content':path.write_bytes(b'x'*len(m.canonical({'raw':'original'})))
                        elif mode=='length':path.write_bytes(b'longer unexpected data')
                        elif mode=='permissions':path.chmod(0o640)
                        else:os.link(path,output/'alias.json')
                try:
                    with patch.object(m.os,'fsync',side_effect=tamper),self.assertRaisesRegex(ValueError,'STORED_'):
                        writer.save('raw.json',{'raw':'original'})
                finally:writer.close()
    def test_output_returned_sha_is_bounded_pread_saved_bytes(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
            output=Path(directory)/'output';output.mkdir(mode=0o700);writer=m.PrivateOutputWriter(output)
            try:
                value={'raw':'saved'};raw=m.canonical(value)
                with patch.object(m.os,'pread',wraps=os.pread)as read:
                    digest=writer.save('raw.json',value)
                    self.assertEqual(read.call_count,1);self.assertEqual(read.call_args.args[1:],(len(raw)+1,0))
                self.assertEqual(digest,m.sha((output/'raw.json').read_bytes()))
            finally:writer.close()
    def test_output_rename_symlink_mode_and_parent_replacement_refused(self):
        for mode in ('rename','symlink','mode','parent'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
                root=Path(directory);parent=root/'parent';parent.mkdir(mode=0o700);output=parent/'output';output.mkdir(mode=0o700)
                foreign=root/'foreign';foreign.mkdir(mode=0o700);writer=m.PrivateOutputWriter(output)
                try:
                    if mode=='mode':output.chmod(0o755)
                    elif mode=='parent':parent.rename(root/'old-parent');parent.mkdir(mode=0o700);(parent/'output').mkdir(mode=0o700)
                    else:
                        output.rename(parent/'old-output')
                        if mode=='symlink':output.symlink_to(foreign,target_is_directory=True)
                        else:output.mkdir(mode=0o700)
                    with self.assertRaises((ValueError,OSError)):writer.save('must-not-write.json',{'data':'private'})
                    self.assertFalse((foreign/'must-not-write.json').exists())
                    self.assertEqual(list(root.rglob('must-not-write.json')),[])
                finally:writer.close()
    def test_output_existing_symlink_leaf_and_traversal_refused(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
            root=Path(directory);output=root/'output';output.mkdir(mode=0o700);foreign=root/'foreign';foreign.write_bytes(b'unchanged')
            writer=m.PrivateOutputWriter(output)
            try:
                (output/'raw.json').symlink_to(foreign)
                with self.assertRaises(FileExistsError):writer.save('raw.json',{})
                for name in ('../foreign','/tmp/foreign','..','nested/raw.json'):
                    with self.assertRaisesRegex(ValueError,'OUTPUT_NAME'):writer.save(name,{})
                self.assertEqual(foreign.read_bytes(),b'unchanged')
            finally:writer.close()
    def test_unknown_json_duplicate_and_nonfinite_refused(self):
        for raw in ('{"a":1,"a":2}','{"a":NaN}'):
            with self.assertRaises(ValueError):m.exact(raw)
    def test_untyped_cli_authority_has_no_subprocess(self):
        with patch.object(m.subprocess,'Popen')as popen:
            with self.assertRaisesRegex(ValueError,'TYPED'):m.run_reviewed({})
            popen.assert_not_called()

if __name__=='__main__':unittest.main()
