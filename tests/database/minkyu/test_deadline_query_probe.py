"""독립 probe의 거절/정리/후보 경계 합성 회귀. 실제 DB·HTTP 0."""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
import importlib.util
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock,patch

ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('d03_probe_unit',ROOT/'tests/integration/minkyu/deadline_query_probe_local.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)

class QueryProbeTests(unittest.TestCase):
    def row(self):
        query='SELECT public.submit_appointment_review(p_appointment_id := $1,p_rating := $2,p_comment := $3,p_experience := $4,p_praises := $5)'
        return dict(pid=20,backendStart='start20',query=query,querySha256=m.sha(query.encode()),state='active',
            waitEventType='Lock',blockingPids=[10],xactStartUs=101,queryStartUs=102,observedUs=103)
    def authority(self):
        return m.ReviewedD03QueryProbe(b'{}',m.canonical(dict(scope_id='probe',appointment_id='p1',post_id='p2',request_id='p3')),
            b'{}','a'*64,'b'*64,'packet','c'*64,'receipt','d'*64,b'{}',b'{}','e'*64,'actual',('a1','a2','a3'))
    def test_dict_authority_refused_without_io(self):
        with self.assertRaisesRegex(ValueError,'EXACT_TYPED'):m.run_reviewed({})
    def test_independent_scope_and_rows_required(self):
        a=self.authority();a.validate()
        for bad in (replace(a,actual_d03_scope_id='probe'),replace(a,actual_d03_fixture_ids=('p1','a2','a3'))):
            with self.assertRaisesRegex(ValueError,'DISTINCT'):bad.validate()
        self.assertNotIn('rpc_review_bytes',a.__dict__)
    def test_timeout_budget_cannot_be_lowered_or_coerced(self):
        for kw in ({'effective_statement_timeout_ms':7000},{'effective_lock_timeout_ms':True}):
            with self.assertRaisesRegex(ValueError,'EIGHT_SECOND_BUDGET'):replace(self.authority(),**kw).validate()
    def test_zero_rating_exact_rpc_shape(self):
        review=Mock(appointment_id='own')
        self.assertEqual(m.payload(review),b'{"p_appointment_id":"own","p_comment":null,"p_experience":"neutral","p_praises":[],"p_rating":0}')
    def test_candidate_never_approval(self):
        result=m.candidate([self.row()],{'pid':10},100)
        self.assertEqual(result['status'],'UNREVIEWED_CANDIDATE');self.assertFalse(result['automaticApproval']);self.assertFalse(result['actualD03Proven'])
    def test_other_rpc_or_ddl_waiter_refused(self):
        other=self.row();other.update(pid=21,query='ALTER TABLE public.appointments ADD x int')
        with self.assertRaisesRegex(ValueError,'UNIQUE'):m.candidate([self.row(),other],{'pid':10},100)
    def test_wrong_query_digest_timing_or_blocker_refused(self):
        for changes in ({'querySha256':'0'*64},{'blockingPids':[10,11]},{'queryStartUs':99},
                        {'query':'COMMIT'},{'state':'idle'},{'backendStart':None}):
            row=self.row();row.update(changes)
            with self.subTest(changes=changes),self.assertRaises(ValueError):m.candidate([row],{'pid':10},100)
    def test_timeout_response_never_candidate_success(self):
        good={'status':400,'transportClosed':True,'body':{'code':'22023','message':'invalid_review'}}
        m.response_ok(good)
        for status,code,message in ((400,'57014','canceling statement'),(400,'55P03','lock timeout'),(400,'22023','review_unavailable'),(200,'22023','invalid_review')):
            with self.assertRaisesRegex(ValueError,'EXPECTED_INVALID'):m.response_ok(dict(status=status,transportClosed=True,body=dict(code=code,message=message)))
    def test_release_single_attempt_even_ambiguous_failure(self):
        p=m.ProbeHTTP.__new__(m.ProbeHTTP);p.lock=threading.Lock();p.released=threading.Event();p.holder=Mock();p.release_error=None
        p.holder.send.side_effect=OSError('ambiguous');p.release();p.release()
        self.assertEqual(p.holder.send.call_count,1);self.assertIsInstance(p.release_error,OSError)
        self.assertIn("commit;select",p.holder.send.call_args.args[0])
    def test_watchdog_releases_after_fixed_three_seconds(self):
        p=m.ProbeHTTP.__new__(m.ProbeHTTP);p.released=Mock();p.released.wait.return_value=False;p.release=Mock()
        p._watchdog();p.released.wait.assert_called_once_with(3);p.release.assert_called_once()
    def runtime(self):
        r=Mock();r.http_dispatched=True;r.probe_pool_closed=True;r.snapshot.return_value={'rows':'original'};return r
    def test_pool_unproven_refuses_cleanup_writes(self):
        r=self.runtime();r.probe_pool_closed=False
        with self.assertRaisesRegex(ValueError,'NO_FIXTURE_WRITE'):m.finalize_probe(r,'review',{},True,None)
        r.cleanup_fixture.assert_not_called();r.close.assert_called_once()
    def test_sticky_raw_termination_refuses_cleanup_writes(self):
        r=self.runtime();r.close_owned_children.side_effect=ValueError('sticky PG')
        with self.assertRaisesRegex(ValueError,'sticky'):m.finalize_probe(r,'review',{},True,None)
        r.cleanup_fixture.assert_not_called();r.close.assert_called_once()
    def test_full_preservation_failure_and_late_monitor_deny_return(self):
        r=self.runtime();r.verify_delta.side_effect=ValueError('old UNKNOWN changed')
        with self.assertRaisesRegex(ValueError,'UNKNOWN'):m.finalize_probe(r,'review',{},True,None)
        r=self.runtime();r.close.side_effect=ValueError('late monitor failure')
        with self.assertRaisesRegex(ValueError,'late monitor'):m.finalize_probe(r,'review',{},True,None)
    def test_original_failure_keeps_cleanup_note(self):
        r=self.runtime();r.cleanup_fixture.side_effect=ValueError('cleanup');original=RuntimeError('primary')
        m.finalize_probe(r,'review',{},True,original)
        self.assertIn('PROBE_CLEANUP_UNPROVEN:ValueError',original.__notes__);r.close.assert_called_once_with(original)
    def context_run(self,exit_failure):
        authority=self.authority()
        pins={'tools/local/run_database_tests.py':'f'*64}
        fields=dict(scope_id='probe',appointment_id='p1',post_id='p2',request_id='p3',source_head='h',
            binding_sha='binding',original_receipt_sha='receipt',source_pins_sha=m.sha(m.canonical(pins)),decision_id='root')
        service=dict(sourceHead='h',bindingSha256='binding',auth6ReceiptSha256='receipt',pins=pins,scopeId='probe',decisionId='root')
        authority=replace(authority,execution_descriptor_bytes=m.canonical(fields),service_descriptor_bytes=m.canonical(service),
            owned_source_pins_bytes=m.canonical({'runtime':authority.runtime_sha256,'readonly':'x','executor':'y'}))
        module=Mock(SELF='runtime',READONLY='readonly',EXECUTOR='executor')
        ro=Mock();ro.exact=m.json.loads;ex=Mock();review=Mock(**fields);ex.ReviewedDeadlineExecution.return_value=review
        module.load.side_effect=[ro,ex]
        exited=[]
        @contextmanager
        def support(pins):
            try:yield
            finally:
                exited.append(True)
                if exit_failure:raise ValueError('support exit source changed')
        ro.current_support.side_effect=support
        runtime=module.FixedDeadlineRuntime.return_value
        runtime.save.side_effect=lambda name,value: self.assertTrue(exited) if name=='probe-candidate-private.json' else None
        request=Mock(response_closed=True);request.thread.is_alive.return_value=False
        result=dict(status='UNREVIEWED_CANDIDATE',backend={'pid':1},query='query',querySha256='q')
        with patch.object(m,'load_runtime',return_value=module),patch.object(m,'observe',return_value=(result,request)),patch.object(m,'finalize_probe'):
            if exit_failure:
                with self.assertRaisesRegex(ValueError,'support exit'):m.run_reviewed(authority)
            else:self.assertEqual(m.run_reviewed(authority),result)
        candidates=[call for call in runtime.save.call_args_list if call.args[0]=='probe-candidate-private.json']
        self.assertEqual(len(candidates),0 if exit_failure else 1)
        if candidates:self.assertTrue(candidates[0].args[1]['supportContextExited'])
    def test_context_exit_failure_does_not_publish_final_candidate(self):
        self.context_run(True)
    def test_candidate_published_only_after_successful_context_exit(self):
        self.context_run(False)
    def test_probe_guard_uses_runtime_binding_anchor_not_private_reader(self):
        from types import SimpleNamespace
        seal=m.ProbeSeal.__new__(m.ProbeSeal);review=SimpleNamespace(source_head='a'*40)
        core=SimpleNamespace(failures=[],read=Mock(side_effect=AssertionError('legacy reader called')))
        runtime=SimpleNamespace(review=review,raw_sticky=[],core=core,memory_last=m.time.monotonic(),original_binding_bytes=Mock(return_value=b'original'))
        seal.runtime=runtime;seal.core=core;seal.start=None;seal.sources={};seal.binding=b'original'
        with patch.object(m.subprocess,'check_output',return_value='a'*40):seal.guard(review)
        runtime.original_binding_bytes.assert_called_once();core.read.assert_not_called()
    def test_normal_finalization_verifies_full_original_bags(self):
        r=self.runtime();before={'auth':'same','UNKNOWN':'same'};m.finalize_probe(r,'review',before,True,None)
        r.verify_delta.assert_called_once_with(before,{'rows':'original'},'review',cleanup=True);r.close.assert_called_once_with(None)

if __name__=='__main__':unittest.main()
