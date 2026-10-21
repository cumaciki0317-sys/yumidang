"""성공 계약의 합성 회귀. 실제 SQL·HTTP·trigger 실행 증거가 아니다."""
import copy
import importlib.util
import pathlib
import sys
import unittest
import uuid
ROOT=pathlib.Path(__file__).resolve().parents[3]
p=ROOT/'tests/integration/minkyu/deadline_success_local.py';s=importlib.util.spec_from_file_location('deadline_success_test_module',p);m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m)

class SuccessContractTests(unittest.TestCase):
    def setup_data(self):
        ids=[str(uuid.uuid4())for _ in range(5)];author,reviewer,ap,episode,rid=ids
        tables=tuple(sorted(set(m.EXTRA)|{'private.synthetic_'+str(i).zfill(3)for i in range(176)}))
        review=m.ReviewedDeadlineSuccess('a'*40,'b'*64,'c'*64,tuple(str(i).zfill(14)for i in range(125)),tables,m.sha(m.canon(tables)),'d'*32,author,reviewer,ap,episode)
        rows={t:[]for t in m.EXTRA};response={'status':200,'transportClosed':True,'bodyComplete':True,'body':{'reviewId':rid,'submittedAt':'2026-10-21T00:00:00Z','deduplicated':False}}
        rows['public.appointment_reviews']=[dict(id=rid,appointment_id=ap,reviewer_id=reviewer,rating=3,comment=None,experience='neutral',praises=[],submitted_at=response['body']['submittedAt'])]
        rows['private.review_publication']=[dict(review_id=rid,publication_source='policy',is_public=False)]
        rows['private.sweetness_review_contributions']=[dict(review_id=rid,recipient_episode_id=episode,reaction_delta=0,star_delta=0)]
        rows['private.review_summary_state']=[dict(profile_id=u,revision=2,fingerprint=None,visible_summary_id=None)for u in(author,reviewer)]
        rows['private.review_refresh_outbox']=[dict(profile_id=u,requested_at='synthetic')for u in(author,reviewer)]
        return review,rows,response
    def test_success_requires_database_payload_and_closed_original_http(self):
        r,rows,response=self.setup_data();self.assertEqual(m.verify_success(response,rows,r,1,2,3)['status'],'VERIFIED_DB_ENTRY_SUCCESS_ONLY')
        for key,val in [('status',400),('transportClosed',False),('bodyComplete',False)]:
            bad=copy.deepcopy(response);bad[key]=val
            with self.assertRaises(ValueError):m.verify_success(bad,rows,r,1,2,3)
    def test_exact_one_review_response_and_recipient(self):
        r,rows,response=self.setup_data()
        for table,key,val in [('public.appointment_reviews','reviewer_id',r.author_id),('public.appointment_reviews','rating',True),('private.sweetness_review_contributions','recipient_episode_id',r.reviewer_id),('private.sweetness_review_contributions','star_delta',1),('private.review_publication','is_public',True)]:
            bad=copy.deepcopy(rows);bad[table][0][key]=val
            with self.assertRaises(ValueError):m.verify_success(response,bad,r,1,2,3)
        rows['public.appointment_reviews']*=2
        with self.assertRaises(ValueError):m.verify_success(response,rows,r,1,2,3)
    def test_summary_revision_extra_checkpoint_and_foreign_outbox_rejected(self):
        r,rows,response=self.setup_data()
        for t,row in [('private.review_summary_checkpoints',{}),('private.review_refresh_outbox',{'profile_id':str(uuid.uuid4())})]:
            bad=copy.deepcopy(rows);bad[t].append(row)
            with self.assertRaises(ValueError):m.verify_success(response,bad,r,1,2,3)
        rows['private.review_summary_state'][0]['revision']=3
        with self.assertRaises(ValueError):m.verify_success(response,rows,r,1,2,3)
    def test_initial_relations_must_all_be_absent(self):
        r,rows,_=self.setup_data();empty={t:[]for t in m.EXTRA};m.verify_initial_empty(empty,r)
        for t in m.EXTRA:
            bad=copy.deepcopy(empty);bad[t]=[{}]
            with self.assertRaises(ValueError):m.verify_initial_empty(bad,r)
    def test_equal_late_and_timeout_window_not_success(self):
        r,rows,response=self.setup_data()
        for times in [(2,2,3),(3,2,4),(1,2,7000001),(True,2,3)]:
            with self.assertRaises(ValueError):m.verify_success(response,rows,r,*times)
    def test_full_delta_preserves_unknown_auth_and_nonowned_bags(self):
        r,_,_=self.setup_data();before={'rows':{t:{}for t in r.expected_tables},'authority':'exact'};after=copy.deepcopy(before);added={t:{}for t in m.EXTRA};added[m.EXTRA[0]]={'a'*64:1};after['rows'][m.EXTRA[0]]=dict(added[m.EXTRA[0]]);m.verify_delta(before,after,added,r)
        bad=copy.deepcopy(after);bad['rows']['private.synthetic_001']={'b'*64:1}
        with self.assertRaises(ValueError):m.verify_delta(before,bad,added,r)
        bad=copy.deepcopy(after);bad['authority']='changed'
        with self.assertRaises(ValueError):m.verify_delta(before,bad,added,r)
    def test_cleanup_order_is_new_review_before_fixture_then_summary(self):
        r,_,response=self.setup_data();plan=m.cleanup_plan(r,response['body']['reviewId']);self.assertIn('sweetness_review_contributions',plan['beforeFixtureCleanup'][0]);self.assertIn('review_publication',plan['beforeFixtureCleanup'][1]);self.assertIn('appointment_reviews',plan['beforeFixtureCleanup'][2]);self.assertEqual(plan['requiredBeforeFinalDeletes']['summaryRevision'],5);self.assertFalse(plan['sequenceReset'])
    def test_untyped_and_unregistered124_refused_before_execution(self):
        r,_,_=self.setup_data()
        with self.assertRaisesRegex(ValueError,'AUTHORITY_TYPE'):m.run_reviewed({})
        from dataclasses import replace
        with self.assertRaisesRegex(ValueError,'REVIEWED125'):replace(r,versions=r.versions[:-1]).validate()
    def test_cleanup_guards_all_captured_payload_before_any_delete(self):
        r,rows,response=self.setup_data();pred={t:'false'for t in ('private.conversation_generation_appointments','private.appointment_member_episodes','public.appointments','public.notifications','private.conversation_retention_generations','public.join_requests','public.posts')}
        sql=m.guarded_cleanup_sql(r,response['body']['reviewId'],rows,pred)
        self.assertEqual(sql.count('success_cleanup_payload_changed'),6)
        self.assertLess(sql.index('lock table'),sql.index('delete from'))
        self.assertLess(sql.index('delete from private.review_publication'),sql.index('delete from public.appointment_reviews'))
        self.assertLess(sql.index('delete from public.appointments'),sql.index('delete from private.review_summary_state'))
        self.assertNotIn('setval',sql)
    def test_subclass_normal_constructor_and_runtime_guard_preserved(self):
        import types
        events=[]
        class Base:
            def __init__(self,value):events.append(('construct',value))
            def guard(self,*a,**kw):events.append(('guard',a,kw))
            def save(self,n,v):events.append(('save',n))
        anchor=types.SimpleNamespace(check=lambda:events.append(('source',)))
        cls=m.success_runtime_class(types.SimpleNamespace(FixedDeadlineRuntime=Base),self.setup_data()[0],anchor)
        obj=cls('normal');obj.guard('review');obj.save('proof',{'x':1})
        self.assertIsInstance(obj,Base);self.assertEqual(events[:3],[('construct','normal'),('source',),('guard',('review',),{})])
        self.assertEqual(obj.success_proofs['proof'],{'x':1})
    def test_source_anchor_accepts_sibling_output_rejects_leaf_and_parent_replace(self):
        import tempfile
        from unittest.mock import patch
        from dataclasses import replace
        r,_,_=self.setup_data()
        with tempfile.TemporaryDirectory()as tmp:
            root=pathlib.Path(tmp).resolve();path=root/m.SELF;path.parent.mkdir(parents=True);path.write_bytes(b'synthetic source')
            r=replace(r,self_sha256=m.sha(path.read_bytes()))
            def git(args,**kwargs):return r.source_head+'\n'if 'rev-parse'in args else b'synthetic source'
            with patch.object(m.subprocess,'check_output',side_effect=git):
                anchor=m.SourceAnchor(root,r)
                try:
                    (path.parent/'new-artifact').write_bytes(b'normal');anchor.check()
                    path.write_bytes(b'changed source')
                    with self.assertRaises(ValueError):anchor.check()
                finally:anchor.close()
                path.write_bytes(b'synthetic source');anchor=m.SourceAnchor(root,r)
                try:
                    path.parent.rename(path.parent.with_name('renamed'));path.parent.mkdir();path.write_bytes(b'synthetic source')
                    with self.assertRaisesRegex(ValueError,'PARENT_CHANGED'):anchor.check()
                finally:anchor.close()
    def test_separate_success_phase_uses_original_http_and_full_delta(self):
        import types
        r,rows,response=self.setup_data();initial={'rows':{t:{}for t in r.expected_tables},'authority':'same'}
        bags={t:{m.sha(m.canon(row)):1 for row in records}for t,records in rows.items()}
        final=copy.deepcopy(initial)
        for t,bag in bags.items():final['rows'][t]=bag
        contract={'query':'select submit_appointment_review()','querySha256':'e'*64}
        class Base:
            def __init__(self):
                self.fixture_baseline=initial;self.http_child=types.SimpleNamespace(result=response,response_closed=True)
                self.http_backend={'pid':5,'backendStart':'stable'}
                self.authority=types.SimpleNamespace(rpc_review_bytes=m.canon(contract))
            def save(self,*args):pass
            def run_fast_phase(self,seal):
                self.save('d03-fast-window-private.json',{'deadlineUs':2})
                self.save('d03-fast-release-private.json',{'releasedUs':3,'actualCommitCompletedUpperBound':True})
                self.save('d03-fast-activity-one.json',[{'pid':5,'backendStart':'stable','waitEventType':'Lock','queryStartUs':1,**contract}])
                return {'status':'NOT_PROVEN'}
            def snapshot(self):return final
        module=types.SimpleNamespace(FixedDeadlineRuntime=Base,reviewed_rpc=lambda x:x)
        cls=m.success_runtime_class(module,r,types.SimpleNamespace(check=lambda:None))
        class FakePorts(cls):
            def __init__(self):super().__init__();self.fixture_baseline=initial
            def relation_state(self):return rows,bags
        obj=FakePorts();self.assertEqual(obj.run_fast_phase(None)['status'],'VERIFIED_DB_ENTRY_SUCCESS_ONLY')
        response['transportClosed']=False
        with self.assertRaises(ValueError):FakePorts().run_fast_phase(None)
    def test_cleanup_unverified_generated_review_refused(self):
        import types
        r,rows,_=self.setup_data()
        class Base:
            def __init__(self):pass
        cls=m.success_runtime_class(types.SimpleNamespace(FixedDeadlineRuntime=Base),r,None)
        class Ports(cls):
            def relation_state(self):return rows,{}
        with self.assertRaisesRegex(ValueError,'CLEANUP_NOT_REVIEWED'):Ports().cleanup_fixture(None)
    def test_anchor_initial_failure_restores_runtime_and_helper_modules(self):
        from unittest.mock import patch
        import types
        review,_,_=self.setup_data();raw=(ROOT/'tests/integration/minkyu/deadline_lock_runtime.py').read_bytes()
        authority=m.ReviewedSuccessAuthority(review,b'{}',m.sha(raw))
        keys=('reviewed_success_runtime','run_database_tests');prior={k:sys.modules.get(k)for k in keys}
        try:
            for present in (False,True):
                saved={k:types.ModuleType('original_'+k)for k in keys}
                for k in keys:
                    if present:sys.modules[k]=saved[k]
                    else:sys.modules.pop(k,None)
                def failure(*args):
                    sys.modules['run_database_tests']=types.ModuleType('poison_during_failed_anchor')
                    raise ValueError('SYNTHETIC_ANCHOR_FAILURE')
                with patch.object(m.ReviewedSuccessAuthority,'validate',return_value={}),patch.object(m.subprocess,'check_output',return_value=raw),patch.object(m,'SourceAnchor',side_effect=failure):
                    with self.assertRaisesRegex(ValueError,'SYNTHETIC_ANCHOR_FAILURE'):m.run_reviewed(authority)
                for k in keys:
                    if present:self.assertIs(sys.modules[k],saved[k])
                    else:self.assertNotIn(k,sys.modules)
        finally:
            for k,v in prior.items():
                if v is None:sys.modules.pop(k,None)
                else:sys.modules[k]=v
if __name__=='__main__':unittest.main()
