"""D03 실행기 순서·실패 정리 합성 회귀. 실제 실행 포트는 사용하지 않는다."""
from dataclasses import replace
import importlib.util
from pathlib import Path
import sys
import unittest

P=Path(__file__).resolve().parents[2]/'integration/minkyu/deadline_lock_executor.py'
S=importlib.util.spec_from_file_location('deadline_executor_test',P)
m=importlib.util.module_from_spec(S);sys.modules[S.name]=m;S.loader.exec_module(m)

class FakeChild:
    def __init__(self, runtime, kind): self.r=runtime;self.kind=kind
    def identity(self): return {'pid':10,'backendStart':'exact-start'}
    def release_after_deadline(self): self.r.events.append('release');return {'databaseReleaseUs':110}
    def finish(self): self.r.events.append('response');return {'status':400,'body':{'code':'22023','message':'review_unavailable'}}
    def close(self): self.r.events.append('close-'+self.kind)

class FakeRuntime:
    def __init__(self, fail=None): self.events=[];self.fail=fail;self.writes=0
    def guard(self, review, cleanup=False):
        self.events.append('guard-cleanup' if cleanup else 'guard')
        if self.fail=='preservation' and self.writes and not cleanup: raise ValueError('PRESERVATION_CHANGED')
    def save(self,name,value):
        self.events.append(name)
        if self.fail=='holder-save' and name=='d03-holder-private.json':raise OSError('evidence_disk')
    def verify_original_auth(self,v):
        self.events.append('original-auth')
        if self.fail=='auth':raise ValueError('ORIGINAL_JWT_FAILED')
    def snapshot(self):return {'snapshot':'synthetic'}
    def sql(self,sql):
        if sql.startswith('begin;'):
            self.writes+=1;self.events.append('setup')
            if self.fail=='commit-loss':raise ValueError('AMBIGUOUS_COMMIT')
            return ''
        return '[{"pid":20,"backendStart":"waiter-start"}]'
    def verify_delta(self,before,after,v,cleanup):self.events.append('delta-cleanup' if cleanup else 'delta-fixture')
    def open_holder(self,v):self.events.append('open-holder');return FakeChild(self,'holder')
    def start_original_http(self,v):self.events.append('start-http');return FakeChild(self,'http')
    def verify_waiter_binding(self,v,holder,sample):
        self.events.append('bind-waiter')
        if self.fail=='waiter':raise ValueError('WRONG_BACKEND')
    def close_owned_children(self):self.events.append('all-owned-children-closed')
    def verify_owned_backends_absent(self):
        self.events.append('backend-absent')
        if self.fail=='backend-live':raise ValueError('OWN_BACKEND_STILL_LIVE')
    def cleanup_fixture(self,v):self.events.append('cleanup-fixture')

class ExecutorTests(unittest.TestCase):
    def review(self):
        ids=[f'd0300000-0000-4000-8000-{n:012d}' for n in range(1,7)]
        return m.ReviewedDeadlineExecution('root-review','a'*40,'b'*64,'c'*64,'d'*64,'e'*32,*ids)
    def test_cli_and_type_cannot_start(self):
        with self.assertRaisesRegex(ValueError,'TYPED_ROOT_REVIEW'):m.DeadlineExecutor({},FakeRuntime())
    def test_success_collects_only_and_closes_before_cleanup(self):
        r=FakeRuntime();out=m.DeadlineExecutor(self.review(),r).run()
        self.assertEqual(out['status'],'RAW_D03_EXECUTION_COLLECTED_ONLY');self.assertFalse(out['policyComplete'])
        self.assertEqual(out['scope'],'CORRELATED_POSTGREST_DB_ENTRY_ONLY');self.assertFalse(out['DBJWTclaimDirectObserved'])
        self.assertLess(r.events.index('bind-waiter'),r.events.index('release'))
        self.assertLess(r.events.index('close-http'),r.events.index('cleanup-fixture'))
        self.assertLess(r.events.index('close-holder'),r.events.index('cleanup-fixture'))
        self.assertLess(r.events.index('backend-absent'),r.events.index('cleanup-fixture'))
    def test_preservation_failure_after_write_still_cleans_without_http(self):
        r=FakeRuntime('preservation')
        with self.assertRaisesRegex(ValueError,'PRESERVATION_CHANGED'):m.DeadlineExecutor(self.review(),r).run()
        self.assertIn('cleanup-fixture',r.events);self.assertNotIn('start-http',r.events)
        self.assertIn('d03-original-failure-private.json',r.events)
    def test_ambiguous_setup_commit_is_not_retried_and_cleanup_attempted(self):
        r=FakeRuntime('commit-loss')
        with self.assertRaisesRegex(ValueError,'AMBIGUOUS_COMMIT'):m.DeadlineExecutor(self.review(),r).run()
        self.assertEqual(r.writes,1);self.assertIn('cleanup-fixture',r.events)
    def test_evidence_disk_failure_closes_owned_holder_and_cleans(self):
        r=FakeRuntime('holder-save')
        with self.assertRaises(OSError):m.DeadlineExecutor(self.review(),r).run()
        self.assertIn('close-holder',r.events);self.assertIn('cleanup-fixture',r.events)
    def test_wrong_waiter_never_released_as_success(self):
        r=FakeRuntime('waiter')
        with self.assertRaisesRegex(ValueError,'WRONG_BACKEND'):m.DeadlineExecutor(self.review(),r).run()
        self.assertNotIn('release',r.events);self.assertIn('close-http',r.events);self.assertIn('cleanup-fixture',r.events)
    def test_live_backend_prevents_sql_cleanup(self):
        r=FakeRuntime('backend-live')
        with self.assertRaisesRegex(ValueError,'CLEANUP_UNPROVEN'):m.DeadlineExecutor(self.review(),r).run()
        self.assertNotIn('cleanup-fixture',r.events)
    def test_original_auth_failure_precedes_all_fixture_writes(self):
        r=FakeRuntime('auth')
        with self.assertRaisesRegex(ValueError,'ORIGINAL_JWT_FAILED'):m.DeadlineExecutor(self.review(),r).run()
        self.assertEqual(r.writes,0)
    def test_uuid_or_review_pin_mutation_refused(self):
        for change in ({'source_head':'short'},{'author_id':self.review().reviewer_id},{'post_id':"';delete from public.posts;--"}):
            with self.assertRaises(ValueError):m.DeadlineExecutor(replace(self.review(),**change),FakeRuntime())
    def test_sql_preserves_clock_and_closed_inspection_guard(self):
        sql=m.fixture_sql(self.review())
        self.assertIn('clock_timestamp()',sql);self.assertIn('d03_ticket_lane_not_reviewed',sql)
        self.assertNotIn('disable trigger',sql.lower());self.assertNotIn('request.jwt.claims',sql)
        self.assertNotIn('update private.content_inspection_control',sql)
        self.assertIn('pg_blocking_pids',m.waiter_sql(self.review(),10))

    def test_actual_http_port_saves_raw_before_post_guard_failure(self):
        from unittest.mock import patch, Mock
        response=Mock();response.read.return_value=b'{"code":"22023","message":"review_unavailable","details":null,"hint":null}';response.code=400
        opener=Mock();opener.open.return_value=response
        saved=[];calls=[]
        def guard():
            calls.append(1)
            if len(calls)==2:raise ValueError('PRESERVATION_CHANGED')
        with patch('urllib.request.build_opener',return_value=opener):
            with self.assertRaisesRegex(ValueError,'PRESERVATION_CHANGED'):
                m.original_review_http('http://127.0.0.1:54321','anon','original-token',self.review(),guard,lambda n,v:saved.append((n,v)))
        self.assertEqual(opener.open.call_count,1);response.close.assert_called_once()
        self.assertEqual(opener.open.call_args.args[0].data,m.review_payload_bytes(self.review()))
        self.assertEqual(saved[0][0],'d03-http-body-private.bin')
        self.assertIs(type(saved[0][1]),bytes)

    def test_http_response_loss_is_unknown_and_not_retried(self):
        from unittest.mock import patch,Mock
        opener=Mock();opener.open.side_effect=TimeoutError('lost')
        saved=[]
        with patch('urllib.request.build_opener',return_value=opener):
            with self.assertRaises(TimeoutError):
                m.original_review_http('http://127.0.0.1:54321','anon','original-token',self.review(),lambda:None,lambda n,v:saved.append(v))
        self.assertEqual(opener.open.call_count,1);self.assertEqual(saved,[{'status':'UNKNOWN_RESPONSE','retry':False}])

    def test_http_nonexact_origin_refused_before_transport(self):
        from unittest.mock import patch
        for origin in ('http://localhost:54321','http://127.0.0.1:54321/path','http://127.0.0.1:54321?x=1','http://user@127.0.0.1:54321','https://example.com'):
            with patch('urllib.request.build_opener') as opened:
                with self.assertRaises(ValueError):m.original_review_http(origin,'anon','jwt',self.review(),lambda:None,lambda *a:None)
                opened.assert_not_called()

    def test_holder_uses_database_deadline_without_guc_timestamp(self):
        sql=m.holder_open_sql(self.review())+m.holder_release_sql(self.review())
        self.assertIn('for update',sql);self.assertIn('backend_start',sql)
        self.assertIn('review_deadline_at-clock_timestamp()',sql)
        self.assertNotIn('set_config',sql);self.assertNotIn('request.jwt',sql)

    def test_window_failure_prevents_http_open_with_no_retry(self):
        from unittest.mock import patch,Mock
        opener=Mock();saved=[]
        def overrun():raise ValueError('D03_DISPATCH_WINDOW_OVERRUN_NO_REPLAY')
        with patch('urllib.request.build_opener',return_value=opener):
            with self.assertRaisesRegex(ValueError,'WINDOW_OVERRUN'):
                m.original_review_http('http://127.0.0.1:54321','anon','original-token',self.review(),lambda:None,lambda *a:saved.append(a),overrun)
        opener.open.assert_not_called();self.assertEqual(saved,[])
    def test_synthetic_horizon_and_transport_timeouts_are_consistent(self):
        from unittest.mock import patch,Mock
        response=Mock();response.read.return_value=b'{}';response.code=400;opener=Mock();opener.open.return_value=response
        with patch('urllib.request.build_opener',return_value=opener):
            m.original_review_http('http://127.0.0.1:54321','anon','original-token',self.review(),lambda:None,lambda *a:None,lambda:None)
        self.assertEqual(opener.open.call_args.kwargs['timeout'],360)
        self.assertIn("interval '300 seconds'",m.fixture_sql(self.review()))
        self.assertIn("statement_timeout='390s'",m.holder_open_sql(self.review()))
        self.assertIn("idle_in_transaction_session_timeout='390s'",m.holder_open_sql(self.review()))

    def test_background_window_failure_is_raised_before_waiter_sampling(self):
        r=FakeRuntime();child=FakeChild(r,'http');child.error=ValueError('D03_DISPATCH_WINDOW_OVERRUN_NO_REPLAY')
        r.start_original_http=lambda v:child
        with self.assertRaisesRegex(ValueError,'WINDOW_OVERRUN_NO_REPLAY'):m.DeadlineExecutor(self.review(),r).run()
        self.assertNotIn('bind-waiter',r.events);self.assertNotIn('release',r.events)
        self.assertIn('cleanup-fixture',r.events);self.assertIn('d03-original-failure-private.json',r.events)

    def test_fast_executor_preserves_not_proven_and_runs_cleanup(self):
        r=FakeRuntime();r.prepare_fast_phase=lambda review:'SEALED_BY_RUNTIME';r.run_fast_phase=lambda seal:{'status':'NOT_PROVEN','policyComplete':False}
        out=m.ReviewedFastDeadlineExecutor(self.review(),r,object()).run()
        self.assertEqual(out['status'],'NOT_PROVEN');self.assertIn('cleanup-fixture',r.events)
        self.assertIn('backend-absent',r.events)

    def test_fast_release_upper_bound_is_strictly_after_commit(self):
        sql=m.fast_holder_release_sql(self.review())
        self.assertLess(sql.index('pg_sleep('),sql.index('commit;'))
        self.assertLess(sql.index('commit;'),sql.index("'releasedUs'"))
        self.assertIn("'actualCommitCompletedUpperBound',true",sql)
        # 과거 경로의 원시 marker 계약은 별도로 보존한다.
        old=m.holder_release_sql(self.review())
        self.assertLess(old.index("'releasedUs'"),old.index('commit;'))

if __name__=='__main__':unittest.main()
