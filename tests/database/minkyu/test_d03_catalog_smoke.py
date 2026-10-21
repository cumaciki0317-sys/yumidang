"""Preauth 고정 smoke의 합성 회귀. PostgreSQL 구문/실제 DB PASS를 주장하지 않는다."""
import ast
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch

ROOT=Path(__file__).resolve().parents[3]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module
m=load('d03_catalog_smoke_unit','tools/local/run_d03_catalog_smoke.py')
batch=load('d03_catalog_batch_unit',m.BATCH)
RUNTIME=(ROOT/m.RUNTIME).read_bytes();KERNEL=(ROOT/m.KERNEL).read_bytes()

class CatalogSmokeTests(unittest.TestCase):
    def bodies(self):
        registry=m.catalog_registry(RUNTIME);queries=batch.kernel_queries(KERNEL,('auth.users','private.ai_budget_ledgers'))
        controls,_=batch.control_query(KERNEL)
        return m.scripts(batch,registry,queries,controls)
    def authority(self):
        kw={'head':'a'*40,'pins':{m.SOURCE:'b'*64}}
        return m.ReviewedD03CatalogSmoke(m.canonical(kw),m.canonical({p:'c'*64 for p in m.EXTRA}),
            m.canonical({'sourceHead':kw['head']}),'d'*64,'root','catalog-smoke-root')
    def test_typed_authority_no_external_action_for_dict(self):
        with patch.object(m.subprocess,'check_output')as git:
            with self.assertRaisesRegex(ValueError,'TYPED_ROOT'):m.run_reviewed({})
            git.assert_not_called()
    def test_exact_extra_pins_and_current_head_required(self):
        a=self.authority();a.validate()
        bads=[replace(a,extra_pins_bytes=m.canonical({m.SELF:'c'*64})),
              replace(a,current_profile_bytes=m.canonical({'sourceHead':'f'*40})),
              replace(a,source_kwargs_bytes=m.canonical({'head':'--output=/tmp/unwanted','pins':{m.SOURCE:'b'*64}}))]
        for bad in bads:
            with self.subTest(bad=bad),self.assertRaises(ValueError):bad.validate()
    def test_registry_contains_only_six_exact_source_methods(self):
        queries=m.catalog_registry(RUNTIME)
        self.assertEqual(tuple(queries),m.ORDER);self.assertEqual(len(queries),6)
        self.assertTrue(queries['initial'].startswith('select coalesce(jsonb_agg('))
        self.assertTrue(queries['fast'].startswith('select pg_stat_clear_snapshot();select '))
        self.assertIn('pg_db_role_setting',queries['roles']);self.assertIn('pg_get_functiondef',queries['routines'])
        for query in queries.values():self.assertNotIn('insert into',query.lower());self.assertNotIn('update ',query.lower())
    def test_missing_source_method_cannot_be_replaced_by_arbitrary_query(self):
        changed=RUNTIME.replace(b'def initial_activity_sql():',b'def foreign_activity_sql():',1)
        with self.assertRaises((StopIteration,ValueError)):m.catalog_registry(changed)
    def test_eight_distinct_finite_pg_scripts_each_rr_readonly(self):
        bodies=self.bodies();self.assertEqual(list(bodies),['before',*m.ORDER,'after']);self.assertEqual(len(bodies),8)
        for name,body in bodies.items():
            with self.subTest(name=name):
                self.assertTrue(body.startswith(b'begin isolation level repeatable read read only;'))
                self.assertTrue(body.endswith(b'rollback;\n'));self.assertEqual(body.count(b"'pid',pg_backend_pid()"),1)
    def test_fast_keeps_original_two_statements_order_and_empty_void_result(self):
        body=self.bodies()['fast'];clear=body.index(b'select pg_stat_clear_snapshot();')
        envelope=body.index(b"select json_build_object('fast',")
        self.assertLess(clear,envelope);self.assertEqual(body.count(b'select pg_stat_clear_snapshot();'),1)
    def test_preauth_gate_refuses_existing_or_dangling_binding_and_old_issuance(self):
        for name,kind in [('signed-ai-binding-private.json','file'),('signed-ai-binding-private.json','symlink'),('root-auth6-current-receipt.json','file'),('auth-provision-old','dir')]:
            with self.subTest(name=name,kind=kind),tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
                root=Path(directory);m.preauth_files(root);path=root/name
                if kind=='file':path.write_bytes(b'{}')
                elif kind=='dir':path.mkdir()
                else:path.symlink_to(root/'missing')
                with self.assertRaisesRegex(ValueError,'FRESH_PREAUTH'):m.preauth_files(root)
    def test_zero_auth_exact_counts_and_bool_rejected(self):
        keys={'authUsers','authSessions','authIdentities','authRefreshTokens','authMfaClaims','profiles'}
        value={k:0 for k in keys};m.zero_auth(value)
        for changed in (dict(value,authUsers=1),dict(value,authUsers=False),{}):
            with self.assertRaisesRegex(ValueError,'AUTH_NOT_EMPTY'):m.zero_auth(changed)
    def transport(self,mode='ok'):
        saved={};events=[];runner=Mock();runner.call.return_value='UNKNOWN'if mode=='backend'else'ABSENT'
        runner.memory.side_effect=lambda n:events.append(('memory',n))
        source=SimpleNamespace(HOST='unix:///synthetic',close_process_group=Mock(return_value={'closed':mode!='pg'}))
        def save(name,value):
            events.append(('save',name))
            if mode=='save'and name.endswith('-raw-private.json'):raise OSError('rawsave')
            if mode=='intent'and name.endswith('-intent.json'):raise OSError('intent')
            saved[name]=value
        transport=m.FixedSmokePg(source,runner,'own-db',self.bodies(),save,Mock())
        def popen(argv,**kwargs):
            events.append(('popen',argv))
            if mode=='popen':raise OSError('popen')
            marker=b'{"pid":123,"backendStart":"synthetic"}\n'
            if mode=='marker':marker=b'broken\n'
            label=['before',*m.ORDER,'after'][transport.counter-1]
            envelope=m.canonical({label:'[]'})
            raw=marker+(b'\n'if label=='fast'else b'')+envelope+b'\n'
            if mode=='extra':raw+=b'extra\n'
            if mode=='overflow':raw+=b'x'*8388608
            kwargs['stdout'].write(raw);kwargs['stdout'].flush()
            return SimpleNamespace(poll=lambda:0,returncode=3 if mode=='syntax'else 0)
        return transport,runner,source,saved,events,popen
    def test_first_pg_requires_fresh_one_gib_before_spawn(self):
        t,r,source,saved,events,popen=self.transport()
        with patch.object(m.subprocess,'Popen',side_effect=popen):self.assertEqual(t.run('before'),{'before':'[]'})
        self.assertEqual(events[0],('memory',1048576));self.assertLess(next(i for i,e in enumerate(events)if e[0]=='memory'),next(i for i,e in enumerate(events)if e[0]=='popen'))
        self.assertFalse(t.sticky);self.assertTrue(t.last_closure['backendAbsent'])
    def test_same_owned_db_proc_observer_only_and_whole_raw_before_verdict(self):
        t,r,source,saved,events,popen=self.transport()
        with patch.object(m.subprocess,'Popen',side_effect=popen):t.run('before')
        argv=r.call.call_args.args[0];self.assertEqual(argv[:3],['exec','own-db','/bin/sh']);self.assertNotIn('psql',argv)
        self.assertIn('pg-1-before-raw-private.json',saved);self.assertIn('pg-1-before-closed.json',saved)
    def test_syntax_failure_attempts_backend_closure_then_blocks_all_following_sql(self):
        t,r,source,saved,events,popen=self.transport('syntax')
        with patch.object(m.subprocess,'Popen',side_effect=popen)as spawn:
            with self.assertRaisesRegex(ValueError,'POSTGRES_QUERY_FAILED'):t.run('before')
            calls=spawn.call_count
            with self.assertRaisesRegex(ValueError,'STICKY'):t.run('initial')
            self.assertEqual(spawn.call_count,calls)
        self.assertTrue(t.sticky);self.assertTrue(t.last_closure['backendAbsent']);self.assertEqual(t.last_closure['returnCode'],3)
        self.assertEqual(saved['pg-1-before-raw-private.json']['returnCode'],3)
    def test_save_popen_marker_pg_backend_overflow_failures_all_sticky(self):
        for mode in ('save','intent','popen','marker','pg','backend','overflow','extra'):
            with self.subTest(mode=mode):
                t,r,source,saved,events,popen=self.transport(mode)
                with patch.object(m.subprocess,'Popen',side_effect=popen)as spawn:
                    with self.assertRaises(Exception):t.run('before')
                    calls=spawn.call_count
                    with self.assertRaisesRegex(ValueError,'STICKY'):t.run('initial')
                    self.assertEqual(spawn.call_count,calls)
                self.assertTrue(t.sticky)
                if mode in ('marker','pg','backend','popen','intent','save'):self.assertFalse(t.last_closure['backendAbsent'])
    def test_fast_void_output_is_allowed_only_for_fixed_fast_call(self):
        t,r,source,saved,events,popen=self.transport()
        with patch.object(m.subprocess,'Popen',side_effect=popen):
            for label in ['before',*m.ORDER,'after']:
                self.assertEqual(t.run(label),{label:'[]'})
        self.assertEqual(t.counter,8);r.memory.assert_called_once_with(1048576)
        self.assertEqual(source.close_process_group.call_count,8)
        with self.assertRaisesRegex(ValueError,'NO_REPLAY'):t.run('after')
    def test_script_mutation_or_reordering_refused_before_spawn(self):
        t,r,source,saved,events,popen=self.transport()
        with patch.object(m.subprocess,'Popen')as spawn:
            with self.assertRaisesRegex(ValueError,'FIXED_ORDER'):t.run('initial')
            t.bodies['before']+=b'select 99;'
            with self.assertRaisesRegex(ValueError,'SCRIPT_CHANGED'):t.run('before')
            spawn.assert_not_called()
    def test_late_memory_failure_after_raw_closure_keeps_sticky(self):
        t,r,source,saved,events,popen=self.transport();t.live.side_effect=[None,ValueError('late memory')]
        with patch.object(m.subprocess,'Popen',side_effect=popen),self.assertRaisesRegex(ValueError,'late memory'):t.run('before')
        self.assertTrue(t.sticky);self.assertTrue(t.last_closure['backendAbsent'])
    def test_final_receipt_is_guarded_after_context_exit(self):
        tree=ast.parse((ROOT/m.SELF).read_bytes());run=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='run_reviewed')
        calls=[n for n in ast.walk(run)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr=='publish']
        self.assertEqual(len(calls),1)
        gate=batch.FinalReceiptGate();writer=Mock()
        with self.assertRaisesRegex(ValueError,'NOT_PERMITTED'):gate.publish(writer,{})
        writer.assert_not_called()
    def test_descriptor_provenance_covers_literal_bytes(self):
        a=self.authority();before=m.sha(m.canonical(a.descriptor()))
        self.assertEqual(set(a.descriptor()),set(a.__dict__))
        self.assertNotEqual(before,m.sha(m.canonical(replace(a,query_registry_sha256='e'*64).descriptor())))

if __name__=='__main__':unittest.main()
