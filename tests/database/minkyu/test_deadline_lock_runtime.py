"""실제 포트의 고정 범위/보존 실패/host 자식 종료 합성 회귀. Docker/HTTP 실행 0."""
from copy import deepcopy
from dataclasses import replace
import importlib.util
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch,Mock

ROOT=Path(__file__).resolve().parents[3]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(spec)
    sys.modules[name]=m;spec.loader.exec_module(m);return m
m=load('d03_runtime_unit','tests/integration/minkyu/deadline_lock_runtime.py')
e=load('d03_executor_unit','tests/integration/minkyu/deadline_lock_executor.py')

class RuntimeTests(unittest.TestCase):
    def test_photo_source_ascii_name_and_direct_root(self):
        root=Path('/private/tmp/fresh-d03')
        name='d03-photo-'+'a'*32+'.jpg'
        self.assertEqual(m.photo_source_path(root/name,root),root/name)
        for bad in (name.replace('.jpg',r'\.jpg'),name+'.extra',name.upper(),
                    'd03-photo-'+'a'*31+'.jpg'):
            with self.subTest(name=bad),self.assertRaisesRegex(ValueError,'D03_PHOTO_SOURCE_PATH'):
                m.photo_source_path(root/bad,root)
        with self.assertRaisesRegex(ValueError,'D03_PHOTO_SOURCE_PATH'):
            m.photo_source_path(root/'nested'/name,root)

    def review(self):
        return e.ReviewedDeadlineExecution('root','a'*40,'b'*64,'c'*64,'d'*64,'e'*32,
            *[f'd0300000-0000-4000-8000-{n:012d}'for n in range(1,7)])
    def sample(self):
        tables=sorted(list(m.predicates(self.review()))+['auth.users','private.ai_global_daily_budget'])
        before={'rows':{t:{}for t in tables},'authoritySha256':'a'*64,'catalogSha256':'b'*64,'constraintsSha256':'c'*64,'sequenceStateSha256':'d'*64}
        before['rows']['auth.users']={'0'*64:2};before['rows']['private.ai_global_daily_budget']={'1'*64:1}
        own={t:{str(n)*64:1}for n,t in enumerate(m.predicates(self.review()),2)}
        after=deepcopy(before)
        for t,bag in own.items():after['rows'][t].update(bag)
        return tables,before,after,own
    def test_default_untyped_has_no_subprocess(self):
        with patch.object(m.subprocess,'check_output')as command:
            with self.assertRaisesRegex(ValueError,'TYPED_RUNTIME_AUTHORITY'):m.run_reviewed({})
            command.assert_not_called()
    def test_missing_or_foreign_runtime_source_refused_before_git(self):
        for pins in ({},{'foreign.py':'a'*64}):
            with patch.object(m.subprocess,'check_output')as command:
                with self.assertRaisesRegex(ValueError,'EXACT_OWN_SOURCE_SET'):m.verify_own_sources('a'*40,pins)
                command.assert_not_called()
    def test_exact_added_seven_rows_preserves_auth_budget_and_exact_table_profile(self):
        tables,before,after,own=self.sample()
        m.verify_delta(before,after,own,tables,cleanup=False)
        m.verify_delta(before,before,{t:{}for t in own},tables,cleanup=True)
    def test_old_auth_unknown_or_budget_row_mutation_rejected(self):
        tables,before,after,own=self.sample()
        for table in ('auth.users','private.ai_global_daily_budget'):
            changed=deepcopy(after);changed['rows'][table]={}
            with self.assertRaisesRegex(ValueError,'UNOWNED_OR_MISSING_ROW'):m.verify_delta(before,changed,own,tables,cleanup=False)
    def test_duplicate_own_row_and_extra_notification_rejected(self):
        tables,before,after,own=self.sample()
        own['public.notifications']['f'*64]=1;after['rows']['public.notifications']['f'*64]=1
        with self.assertRaisesRegex(ValueError,'EXACT_ONE_NEW_ROW'):m.verify_delta(before,after,own,tables,cleanup=False)
    def test_cleanup_must_return_full_original_bags(self):
        tables,before,after,own=self.sample()
        with self.assertRaisesRegex(ValueError,'OWN_ROWS_REMAIN'):m.verify_delta(before,after,own,tables,cleanup=True)
        changed=deepcopy(before);changed['rows']['auth.users']={}
        with self.assertRaises(ValueError):m.verify_delta(before,changed,{t:{}for t in own},tables,cleanup=True)
    def test_table_set_catalog_roles_and_sequence_changes_refused(self):
        tables,before,after,own=self.sample()
        for key in ('authoritySha256','catalogSha256','constraintsSha256','sequenceStateSha256'):
            changed=deepcopy(after);changed[key]='f'*64
            with self.assertRaisesRegex(ValueError,'AUTHORITY_OR_CATALOG'):m.verify_delta(before,changed,own,tables,cleanup=False)
        with self.assertRaisesRegex(ValueError,'FULL_TABLE_INVENTORY'):m.verify_delta(before,after,own,tables+['private.foreign'],cleanup=False)
    def test_predicates_never_use_time_range_or_profile_deletion(self):
        p=m.predicates(self.review())
        self.assertEqual(len(p),7);self.assertIn('requester_id',p['public.join_requests'])
        self.assertIn('recipient_id',p['public.notifications']);self.assertIn('generation=1',p['private.conversation_retention_generations'])
        self.assertNotIn('auth.users',p);self.assertNotIn('storage.objects',p)
        sql=m.owned_rows_sql(self.review());self.assertIn('to_jsonb(r)',sql);self.assertIn('sha256',sql)
    def test_holder_uses_exact_container_and_new_process_group(self):
        owner=Mock();owner.review=self.review();owner.executor=e
        owner.core.r.base=['docker','--host','unix:///fixed.sock'];owner.core.target={'id':'a'*64}
        proc=Mock();proc.stdin=io.BytesIO();proc.stdout=io.BytesIO(b'');proc.stderr=io.BytesIO(b'');proc.poll.return_value=0;proc.returncode=0
        with patch.object(m.subprocess,'Popen',return_value=proc)as popen:
            # 성공 직후 stdin write 전에 종료된 경우도 정확 자식만 닫는다.
            with self.assertRaisesRegex(ValueError,'HOLDER_CLOSED'):m.PsqlHolder(owner)
            argv=popen.call_args.args[0]
            self.assertEqual(argv[:6],['docker','--host','unix:///fixed.sock','exec','-i','a'*64])
            self.assertTrue(popen.call_args.kwargs['start_new_session'])
    def test_holder_pid_reuse_not_terminated_by_database_cleanup(self):
        # 정리는 DB backend terminate를 사용하지 않는다. 생존 exactPID이면 fail closed한다.
        raw=(ROOT/'tests/integration/minkyu/deadline_lock_runtime.py').read_text()
        self.assertNotIn('pg_terminate_backend(',raw)
        self.assertNotIn('pg_cancel_backend(',raw)

    def test_failed_sql_result_saved_before_returncode_verdict(self):
        command=object.__new__(m.PsqlHolder);command.owner=Mock();command.owner.cleaning=False
        command.proc=Mock();command.proc.poll.return_value=1;command.proc.returncode=1
        command.failure=[];command.buffers={'stdout':bytearray(b''),'stderr':bytearray(b'ERROR')}
        saved=[];command.close=lambda:saved.append('raw-closed-saved')
        with self.assertRaisesRegex(ValueError,'SQL_EXECUTION_FAILED_RAW_SAVED'):command.collect()
        self.assertEqual(saved,['raw-closed-saved'])
    def test_capture_limit_closes_child_before_failclosed(self):
        command=object.__new__(m.PsqlHolder);command.owner=Mock();command.owner.cleaning=False
        command.proc=Mock();command.proc.poll.return_value=None;command.failure=['OUTPUT_LIMIT']
        saved=[];command.close=lambda:saved.append('closed')
        with self.assertRaisesRegex(ValueError,'SQL_CAPTURE_LIMIT'):command.collect()
        self.assertEqual(saved,['closed'])
    def test_source_guard_failure_closes_pending_sql_child(self):
        command=object.__new__(m.PsqlHolder);command.owner=Mock();command.owner.cleaning=False
        command.owner.guard.side_effect=ValueError('SOURCE_CHANGED');command.proc=Mock();command.proc.poll.return_value=None
        command.failure=[];saved=[];command.close=lambda:saved.append('closed')
        with self.assertRaisesRegex(ValueError,'SOURCE_CHANGED'):command.collect()
        self.assertEqual(saved,['closed'])

    def rpc(self):
        query='WITH pgrst_source AS ( SELECT "public"."submit_appointment_review"($1)) SELECT * FROM pgrst_source'
        return {'query':query,'querySha256':m.sha(query.encode())}
    def correlated(self):
        contract=self.rpc();holder={'pid':10,'backendStart':'holder'}
        sample={'pid':20,'backendStart':'http','queryStartUs':82,'xactStartUs':81,'observedUs':90,'waitEventType':'Lock','blockingPids':[10]}
        row={**sample,'query':contract['query'],'querySha256':contract['querySha256'],'state':'active'}
        return [row],holder,sample,contract,80,100
    def test_prepared_query_without_literal_uuid_uses_reviewed_correlation(self):
        out=m.correlated_waiter(*self.correlated())
        self.assertEqual(out['scope'],'CORRELATED_POSTGREST_DB_ENTRY_ONLY')
        self.assertFalse(out['httpIngressProven']);self.assertFalse(out['DBJWTclaimDirectObserved'])
    def test_query_fingerprint_is_not_approved_from_observed_value(self):
        rows,holder,sample,contract,dispatch,deadline=self.correlated()
        rows[0]['query']='SELECT other_rpc($1)'
        with self.assertRaisesRegex(ValueError,'CORRELATION_MISMATCH'):m.correlated_waiter(rows,holder,sample,contract,dispatch,deadline)
        contract['querySha256']='0'*64
        with self.assertRaisesRegex(ValueError,'ROOT_REVIEWED_RPC_FINGERPRINT'):m.reviewed_rpc(contract)
    def test_other_rpc_or_ddl_waiting_on_holder_refused(self):
        rows,holder,sample,contract,dispatch,deadline=self.correlated()
        rows.append({'pid':21,'blockingPids':[10],'query':'ALTER TABLE public.posts'})
        with self.assertRaisesRegex(ValueError,'OTHER_WAITERS'):m.correlated_waiter(rows,holder,sample,contract,dispatch,deadline)
    def test_dispatch_xact_query_observation_deadline_order_is_exact(self):
        for field,value in [('queryStartUs',79),('xactStartUs',79),('observedUs',100)]:
            rows,h,s,c,d,end=self.correlated();s[field]=value;rows[0][field]=value
            with self.assertRaises(ValueError):m.correlated_waiter(rows,h,s,c,d,end)
    def test_http_pool_idle_is_retained_without_backend_termination(self):
        rows=[{'pid':20,'backendStart':'http','state':'idle','xactStartUs':None,'blockingPids':[],'querySha256':self.rpc()['querySha256']}]
        out=m.pooled_transaction_closed(rows,{'pid':20,'backendStart':'http'},self.rpc(),True)
        self.assertTrue(out['pooledBackendRetained']);self.assertTrue(out['requestTransactionClosed']);self.assertFalse(out['backendTerminated'])
        self.assertFalse(m.pooled_transaction_closed([],{'pid':20,'backendStart':'http'},self.rpc(),True)['pooledBackendRetained'])
    def test_pool_reuse_unclosed_response_open_transaction_or_blockers_refused(self):
        base={'pid':20,'backendStart':'http','state':'idle','xactStartUs':None,'blockingPids':[],'querySha256':'0'*64}
        for changes in ({'backendStart':'reused'},{'state':'idle in transaction'},{'state':'idle in transaction (aborted)'},{'state':'active'},
                        {'xactStartUs':81},{'blockingPids':[10]}):
            with self.assertRaises(ValueError):m.pooled_transaction_closed([{**base,**changes}],{'pid':20,'backendStart':'http'},self.rpc(),True)
        with self.assertRaises(ValueError):m.pooled_transaction_closed([base],{'pid':20,'backendStart':'http'},self.rpc(),False)
        with self.assertRaises(ValueError):m.pooled_transaction_closed([base,{'pid':21,'blockingPids':[20]}],{'pid':20,'backendStart':'http'},self.rpc(),True)
        with self.assertRaises(ValueError):m.pooled_transaction_closed([base,{'pid':21,'state':'active','blockingPids':[],'querySha256':self.rpc()['querySha256']}],{'pid':20,'backendStart':'http'},self.rpc(),True)
    def alias_review(self):
        aliases=[f'd0300000-0000-4000-8000-{n:012d}@naver.yumidang.invalid'for n in range(1,7)]
        descriptor={'decisionId':'root-source-issue','preparedRoot':'/private/tmp/fresh-d03','aliases':aliases}
        return {**descriptor,'descriptorSha256':m.sha(m.canonical(descriptor))},{'d03EmailAliasPolicy':descriptor,'qualification':'NOT_RUN_SYNTHETIC_EMAIL_ALIAS_ONLY'},[{'authEmail':a}for a in aliases]
    def alias_module(self):
        class Policy:
            def __init__(self,decision,root,aliases):self._sealed=m.canonical({'decisionId':decision,'preparedRoot':str(root),'aliases':aliases})
            def descriptor(self):return m.json.loads(self._sealed)
        class AI:ReviewedD03AuthEmailAliases=Policy
        return AI
    def test_alias_policy_rebuilt_in_same_loaded_module_after_module_churn(self):
        value,receipt,accounts=self.alias_review();a=self.alias_module();b=self.alias_module()
        first=m.runtime_alias_policy(a,value,receipt,Path(value['preparedRoot']),accounts)
        second=m.runtime_alias_policy(b,value,receipt,Path(value['preparedRoot']),accounts)
        self.assertIs(type(first),a.ReviewedD03AuthEmailAliases);self.assertIs(type(second),b.ReviewedD03AuthEmailAliases)
        self.assertIsNot(type(first),type(second));self.assertEqual(first.descriptor(),second.descriptor())
    def test_receipt_cannot_create_alias_authority_or_expand_alias_scope(self):
        value,receipt,accounts=self.alias_review()
        for changed in (None,{},dict(value,descriptorSha256='0'*64),dict(value,preparedRoot='/private/tmp/other')):
            with self.assertRaises(ValueError):m.runtime_alias_policy(self.alias_module(),changed,receipt,Path(value['preparedRoot']),accounts)
        accounts[0]['authEmail']='other@naver.yumidang.invalid'
        with self.assertRaisesRegex(ValueError,'RECEIPT_MISMATCH'):m.runtime_alias_policy(self.alias_module(),value,receipt,Path(value['preparedRoot']),accounts)
    def test_unintegrated_kernel_refuses_without_default_alias_fallback(self):
        value,receipt,accounts=self.alias_review()
        with self.assertRaisesRegex(ValueError,'KERNEL_ALIAS_NOT_INTEGRATED'):m.runtime_alias_policy(object(),value,receipt,Path(value['preparedRoot']),accounts)

    def closed_command(self, owner, *, remaining_group=False):
        command=object.__new__(m.PsqlHolder);command.owner=owner;command.label='sql-00001';command.persistent=False;command.closed=False;command.closure_verified=False
        command.proc=Mock();command.proc.poll.return_value=0;command.proc.returncode=0;command.proc.pid=12345
        command.proc.stdin=io.BytesIO();command.proc.stdout=io.BytesIO();command.proc.stderr=io.BytesIO()
        command.readers=[];command.failure=[];command.backend=None
        stamp=m.canonical({'kind':'D03_COMMAND_BACKEND','pid':50,'backendStart':'exact-db-start'})
        command.buffers={'stdout':bytearray(stamp+b'\n42\n'),'stderr':bytearray()}
        return command
    def test_each_sql_close_discharges_backend_and_proves_process_group_absent(self):
        owner=Mock();command=self.closed_command(owner)
        with patch.object(m.os,'killpg',side_effect=ProcessLookupError):command.close()
        self.assertTrue(command.closure_verified);owner.finish_raw_backend.assert_called_once_with(command)
        self.assertEqual(command.backend,{'pid':50,'backendStart':'exact-db-start'})
        owner.mark_raw_unclosed.assert_not_called()
    def test_fork_group_after_leader_exit_is_sticky_and_blocks_next_sql(self):
        owner=Mock();command=self.closed_command(owner)
        with patch.object(m.os,'killpg',return_value=None):
            with self.assertRaisesRegex(ValueError,'PROCESS_GROUP_REMAINS'):command.close()
        owner.mark_raw_unclosed.assert_called_once();owner.finish_raw_backend.assert_not_called()
        with self.assertRaisesRegex(ValueError,'CLOSURE_STICKY'):command.close()
        runtime=object.__new__(m.FixedDeadlineRuntime);runtime.review=self.review();runtime.raw_sticky=[{'errorType':'unclosed'}]
        with self.assertRaisesRegex(ValueError,'STICKY_NO_FURTHER_SQL'):runtime.guard(runtime.review,cleanup=True)
    def test_unknown_sql_backend_or_observer_failure_is_not_cleaned_as_success(self):
        owner=Mock();command=self.closed_command(owner);command.buffers['stdout']=bytearray(b'no backend stamp\n')
        with patch.object(m.os,'killpg',side_effect=ProcessLookupError):
            with self.assertRaises(ValueError):command.close()
        owner.mark_raw_unclosed.assert_called_once()
        owner=Mock();owner.finish_raw_backend.side_effect=ValueError('DB_BACKEND_STILL_LIVE');command=self.closed_command(owner)
        with patch.object(m.os,'killpg',side_effect=ProcessLookupError):
            with self.assertRaisesRegex(ValueError,'DB_BACKEND_STILL_LIVE'):command.close()
        self.assertFalse(command.closure_verified);owner.mark_raw_unclosed.assert_called_once()
    def test_late_memory_failure_after_cleanup_join_cannot_return_success(self):
        runtime=object.__new__(m.FixedDeadlineRuntime);runtime.core=Mock();runtime.core.evidence_owned=True
        runtime.core.failures=[];runtime.raw_sticky=[];runtime.save=Mock()
        def late_join(timeout):runtime.core.failures.append('MEMORY_MONITOR_LATE')
        runtime.core.thread.join.side_effect=late_join;runtime.core.thread.is_alive.return_value=False
        with self.assertRaisesRegex(ValueError,'LATE_MEMORY_MONITOR_FAILURE'):runtime.close()
        proof=runtime.save.call_args.args[1]
        self.assertFalse(proof['successReturnPermitted']);self.assertEqual(proof['monitorFailures'],['MEMORY_MONITOR_LATE'])
    def test_late_memory_failure_preserves_original_failure_and_final_evidence(self):
        runtime=object.__new__(m.FixedDeadlineRuntime);runtime.core=Mock();runtime.core.evidence_owned=True
        runtime.core.failures=['MEMORY'];runtime.raw_sticky=[];runtime.save=Mock();runtime.core.thread.is_alive.return_value=False
        original=ValueError('ORIGINAL_SQL_FAILURE');runtime.close(original)
        self.assertEqual(str(original),'ORIGINAL_SQL_FAILURE');self.assertIn('D03_FINALIZATION_UNPROVEN',original.__notes__[0])
        self.assertEqual(runtime.save.call_args.args[1]['originalFailureType'],'ValueError')

    def test_discharge_uses_fixed_observer_without_recursive_raw_command(self):
        runtime=object.__new__(m.FixedDeadlineRuntime);runtime.core=Mock();runtime.core.ai.quote=lambda v:"'"+v+"'"
        runtime.core.port.read_sql.return_value='0';runtime.raw_discharge_index=0;runtime.save=Mock();runtime.sql=Mock(side_effect=AssertionError('recursive raw SQL'))
        command=Mock();command.backend={'pid':50,'backendStart':'fixed-start'};command.label='sql-00001'
        runtime.finish_raw_backend(command)
        runtime.sql.assert_not_called();runtime.core.port.read_sql.assert_called_once()
        self.assertIn('pid=50',runtime.core.port.read_sql.call_args.args[0])
        proof=runtime.save.call_args.args[1];self.assertFalse(proof['observerIsRecursiveD03RawChild'])
        self.assertEqual(proof['observerPort'],'PINNED_FIXED_LIFECYCLE_READ_SQL')

    def qualification_inputs(self):
        review=self.review();alias,_,_=self.alias_review()
        profile={'sourceHead':review.source_head,'expectedTables':['auth.users']}
        service={'sourceHead':review.source_head,'root':alias['preparedRoot'],'currentProfile':profile,
                 'bindingSha256':review.binding_sha,'auth6ReceiptSha256':review.original_receipt_sha,'auth6Receipt':alias['preparedRoot']+'/auth-provision-'+('a'*32)+'/receipt.json'}
        actors=[{'userId':uid,'sessionId':review.original_session_id if uid==review.reviewer_id else 'author-session',
                 'jpegPath':alias['preparedRoot']+'/d03-photo-'+str(n)*32+'.jpg','jpegSha256':str(n)*64,'storagePath':uid+'/own.jpg'}
                for n,uid in enumerate((review.author_id,review.reviewer_id),1)]
        producer={'head':review.source_head,'root':service['root'],'profile':profile,'bindingSha256':review.binding_sha,
                  'receiptSha256':review.original_receipt_sha,'receiptPath':service['auth6Receipt'],
                  'aliasPolicy':{k:alias[k]for k in ('decisionId','preparedRoot','aliases')},'aliasPolicySha256':alias['descriptorSha256'],'actors':actors}
        packet={a['userId']:{'path':a['jpegPath'],'sha256':a['jpegSha256'],'storagePath':a['storagePath']}for a in actors}
        baseline={'rows':{'auth.users':{'0'*64:6}},'catalogSha256':'a'*64}
        receipt={'status':'PASS_SYNTHETIC_QUALIFICATION_ONLY','failureType':None,'actualNaver':'NOT_RUN','actualStorageAPI':'NOT_RUN',
                 'sourceJpegBytesVerified':True,'auth6HistoricalReceiptPreserved':True,'qualificationPacketSha256':m.sha(m.canonical(packet)),
                 'qualifiedBaselineSha256':m.sha(m.canonical(baseline)),'ownedChildClosed':True,'originalBindingSha256':review.binding_sha,
                 'originalReceiptSha256':review.original_receipt_sha,'retainOwnQualificationRows':True,'automaticReplay':False}
        intent={'scope':'SYNTHETIC_D03_QUALIFICATION_ONLY','reviewSha256':m.sha(m.canonical(producer)),
                'originalBindingSha256':review.binding_sha,'originalAuth6ReceiptSha256':review.original_receipt_sha,'noReplay':True}
        return receipt,intent,producer,service,review,packet,baseline,deepcopy(baseline),alias
    def test_final_qualification_pass_keeps_historical_auth6_and_qualified_baseline_separate(self):
        out=m.verify_qualification_provenance(*self.qualification_inputs())
        self.assertTrue(out['historicalAuth6Separate']);self.assertTrue(out['qualifiedBaselineVerified'])
        self.assertEqual(out['qualificationStatus'],'PASS_SYNTHETIC_QUALIFICATION_ONLY')
    def test_fail_closed_receipt_with_valid_packet_cannot_be_consumed(self):
        for changes in ({'status':'FAIL_CLOSED'},{'failureType':'MONITOR_CLOSURE_UNPROVEN'},{'ownedChildClosed':False},
                        {'actualNaver':'PASS'},{'actualStorageAPI':'PASS'},{'auth6HistoricalReceiptPreserved':False}):
            values=list(self.qualification_inputs());values[0].update(changes)
            with self.assertRaisesRegex(ValueError,'FINAL_QUALIFICATION_NOT_PASS'):m.verify_qualification_provenance(*values)
    def test_qualification_other_head_root_auth_round_or_alias_policy_refused(self):
        for change in ({'head':'f'*40},{'root':'/private/tmp/other'},{'bindingSha256':'f'*64},{'receiptSha256':'f'*64},
                       {'receiptPath':'/private/tmp/other/receipt.json'},{'aliasPolicySha256':'f'*64}):
            values=list(self.qualification_inputs());values[2].update(change)
            with self.assertRaises(ValueError):m.verify_qualification_provenance(*values)
    def test_arbitrary_packet_stale_baseline_or_other_actor_session_refused(self):
        values=list(self.qualification_inputs());values[5][values[4].reviewer_id]['storagePath']='other/photo.jpg'
        with self.assertRaisesRegex(ValueError,'PACKET_MAPPING'):m.verify_qualification_provenance(*values)
        values=list(self.qualification_inputs());values[7]['rows']['auth.users']={}
        with self.assertRaisesRegex(ValueError,'QUALIFIED_BASELINE_CHANGED'):m.verify_qualification_provenance(*values)
        values=list(self.qualification_inputs());values[2]['actors'][1]['sessionId']='other-session'
        with self.assertRaisesRegex(ValueError,'ACTORS_MISMATCH'):m.verify_qualification_provenance(*values)
    def test_literal_receipt_sha_checked_before_actual_auth_or_qualification_reads(self):
        from types import SimpleNamespace
        values=self.qualification_inputs();receipt,intent,producer,service,review,packet,baseline,current,alias=values
        root=Path(service['root']);rp=root/'d03-qualification/receipt.json';qp=root/'d03-qualification-private.json'
        runtime=object.__new__(m.FixedDeadlineRuntime);runtime.guard=Mock();runtime.review=review
        runtime.readonly=SimpleNamespace(exact=lambda b:m.json.loads(b))
        runtime.core=SimpleNamespace(root=root,read=lambda p:m.canonical(packet)if p==qp else m.canonical(receipt))
        runtime.authority=SimpleNamespace(qualification_path=str(qp),qualification_sha=m.sha(m.canonical(packet)),
            qualification_receipt_path=str(rp),qualification_receipt_sha='f'*64)
        with self.assertRaisesRegex(ValueError,'FINAL_QUALIFICATION_RECEIPT_CHANGED'):runtime.verify_original_auth(review)
    def test_review_intent_sha_prevents_other_round_with_same_valid_packet(self):
        from types import SimpleNamespace
        receipt,intent,producer,service,review,packet,baseline,current,alias=self.qualification_inputs()
        root=Path(service['root']);rp=root/'d03-qualification/receipt.json';qp=root/'d03-qualification-private.json'
        intent['reviewSha256']='f'*64
        files={qp:m.canonical(packet),rp:m.canonical(receipt),root/'d03-qualification/intent.json':m.canonical(intent)}
        runtime=object.__new__(m.FixedDeadlineRuntime);runtime.guard=Mock();runtime.review=review
        runtime.readonly=SimpleNamespace(exact=lambda b:m.json.loads(b));runtime.core=SimpleNamespace(root=root,read=lambda p:files[p])
        runtime.authority=SimpleNamespace(qualification_path=str(qp),qualification_sha=m.sha(files[qp]),
            qualification_receipt_path=str(rp),qualification_receipt_sha=m.sha(files[rp]),qualification_review_bytes=m.canonical(producer))
        with self.assertRaisesRegex(ValueError,'REVIEW_INTENT_SHA'):runtime.verify_original_auth(review)

    def window_runtime(self,remaining_us=300000000):
        from types import SimpleNamespace
        runtime=object.__new__(m.FixedDeadlineRuntime);runtime.http_dispatched=False;runtime.review=self.review();runtime.executor=e
        runtime.readonly=SimpleNamespace(exact=lambda b:m.json.loads(b));runtime.sql=Mock(return_value=m.json.dumps({'databaseNowUs':1000000000,'deadlineUs':1000000000+remaining_us}))
        runtime.save=Mock();runtime.account={'accessToken':'original-unchanged'};runtime.core=SimpleNamespace(ai=Mock())
        runtime.core.ai.signed_claims.return_value={'exp':5000}
        return runtime
    def test_dispatch_after_preparation_retains_measured_db_window(self):
        runtime=self.window_runtime()
        with patch.object(m.time,'monotonic',side_effect=[0,1,2]):runtime.verify_dispatch_window()
        self.assertTrue(runtime.http_dispatched);self.assertEqual(runtime.dispatch_us,1000000000)
        proof=runtime.save.call_args_list[0].args[1]
        self.assertEqual(proof['fixtureHorizonSeconds'],300);self.assertEqual(proof['httpTimeoutSeconds'],360)
        self.assertEqual(proof['holderTimeoutSeconds'],390);self.assertEqual(proof['minimumRemainingUs'],30000000)
    def test_prep_overrun_is_no_dispatch_with_raw_window_and_no_replay(self):
        runtime=self.window_runtime(50000000)
        with patch.object(m.time,'monotonic',side_effect=[0,25,26]):
            with self.assertRaisesRegex(ValueError,'WINDOW_OVERRUN_NO_REPLAY'):runtime.verify_dispatch_window()
        self.assertFalse(runtime.http_dispatched)
        proof=runtime.save.call_args.args[1];self.assertFalse(proof['httpDispatched']);self.assertFalse(proof['automaticReplay'])
        self.assertEqual(proof['effectiveRemainingUs'],23999999)
    def test_final_evidence_fsync_overrun_is_also_no_dispatch(self):
        runtime=self.window_runtime(50000000)
        with patch.object(m.time,'monotonic',side_effect=[0,1,25]):
            with self.assertRaisesRegex(ValueError,'WINDOW_OVERRUN'):runtime.verify_dispatch_window()
        self.assertFalse(runtime.http_dispatched);self.assertEqual(runtime.save.call_count,3)
    def test_original_jwt_must_outlast_synthetic_window_without_reissuing(self):
        runtime=self.window_runtime();runtime.core.ai.signed_claims.return_value={'exp':1350}
        with patch.object(m.time,'monotonic',side_effect=[0,1,2]):
            with self.assertRaisesRegex(ValueError,'ORIGINAL_JWT_TOO_SHORT'):runtime.verify_dispatch_window()
        self.assertFalse(runtime.http_dispatched);self.assertEqual(runtime.account['accessToken'],'original-unchanged')

    def fast_profile(self):
        return {'scope':'SEALED_D03_POSTGREST_EIGHT_SECOND_PHASE','sourceHead':self.review().source_head,
            'preparedRoot':'/private/tmp/fresh-d03','decisionId':self.review().decision_id,'timeoutPreflightSha256':'f'*64,
            'effectiveStatementTimeoutMs':8000,'effectiveLockTimeoutMs':8000,'expectedRpcQuerySha256':self.rpc()['querySha256'],
            'basisUrls':list(m.POSTGREST_V16_BASIS)}
    def test_fast_scope_requires_explicit_root_timeout_fingerprint_and_official_basis(self):
        profile=self.fast_profile();m.ReviewedD03FastPhase(m.canonical(profile)).descriptor()
        for change in ({'scope':'skip_guards'},{'effectiveStatementTimeoutMs':30000},{'effectiveLockTimeoutMs':True},
                       {'basisUrls':[]},{'timeoutPreflightSha256':'unreviewed'}):
            with self.assertRaises(ValueError):m.ReviewedD03FastPhase(m.canonical({**profile,**change})).descriptor()
    def test_narrow_dispatch_uses_only_database_clock_with_conservative_elapsed(self):
        row={'databaseNowUs':1000000000,'deadlineUs':1005000000}
        self.assertEqual(m.validate_narrow_dispatch(row,100000,{'exp':5000}),4900000)
        for elapsed in (3000001,5000000):
            with self.assertRaisesRegex(ValueError,'NO_DISPATCH'):m.validate_narrow_dispatch(row,elapsed,{'exp':5000})
        with self.assertRaises(ValueError):m.validate_narrow_dispatch({**row,'deadlineUs':1007000000},0,{'exp':5000})
    def test_sql_timeout_deadlock_and_output_loss_never_become_policy_reproduction(self):
        for body in ({'code':'57014','message':'statement timeout'},{'code':'55P03','message':'lock timeout'},
                     {'code':'22023','message':'invalid_review'},{}):
            self.assertEqual(m.classify_fast_result({'status':400,'body':body},100,500,510)['status'],'NOT_PROVEN')
        response={'status':400,'body':{'code':'22023','message':'review_unavailable'}}
        self.assertEqual(m.classify_fast_result(response,1000000,6000000,6100000)['status'],'REPRODUCED_CORRELATED_DB_ENTRY_ONLY')
        self.assertEqual(m.classify_fast_result(response,1000000,6000000,8000000)['status'],'NOT_PROVEN')
        self.assertFalse(m.classify_fast_result(response,1000000,6000000,6100000)['policyComplete'])
    def test_fast_source_fd_rejects_replaced_or_symlinked_source(self):
        import tempfile,os
        with tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
            path=Path(directory)/'code.py';path.write_bytes(b'verified')
            st=path.lstat();stamp=(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,m.sha(b'verified'))
            self.assertEqual(m.fast_source_bytes(path,stamp),b'verified')
            path.unlink();path.write_bytes(b'verified')
            with self.assertRaises(ValueError):m.fast_source_bytes(path,stamp)
            path.unlink();target=Path(directory)/'target';target.write_bytes(b'verified');path.symlink_to(target)
            with self.assertRaises(OSError):m.fast_source_bytes(path,stamp)
    def test_fast_phase_refuses_expired_scope_or_stale_memory_without_transport(self):
        from types import SimpleNamespace
        seal=object.__new__(m.FastSourceSeal);seal.runtime=SimpleNamespace(review=self.review());seal.started=0;seal.prepared=0
        with patch.object(m.time,'monotonic',return_value=9):
            with self.assertRaisesRegex(ValueError,'OBSERVATION_EXPIRED'):seal.guard(self.review())
        seal.runtime.core=SimpleNamespace(failures=[]);seal.runtime.raw_sticky=[];seal.runtime.memory_last=1;seal.started=4
        with patch.object(m.time,'monotonic',return_value=5):
            with self.assertRaisesRegex(ValueError,'MEMORY_OR_CLOSURE'):seal.guard(self.review())
    def test_untyped_fast_context_cannot_start_or_open_connections(self):
        runtime=Mock()
        with self.assertRaisesRegex(ValueError,'SEALED_CONTEXT'):m.run_sealed_fast_phase(runtime,{})
        runtime.guard.assert_not_called()
    def test_fast_failure_still_requires_full_postguard(self):
        runtime=Mock();runtime.review=self.review();runtime.http_dispatched=False
        seal=object.__new__(m.FastSourceSeal);seal.runtime=runtime
        runtime.guard.side_effect=[None,ValueError('POST_FULL_GUARD_FAILED')]
        with patch.object(m,'PsqlHolder',side_effect=ValueError('NO_HOLDER')):
            with self.assertRaisesRegex(ValueError,'POST_GUARD_OR_CLOSURE'):m.run_sealed_fast_phase(runtime,seal)
        self.assertEqual(runtime.guard.call_count,2)
        self.assertEqual(runtime.save.call_args.args[1]['status'],'NOT_PROVEN')

    def test_commit_delay_is_included_in_fast_timeout_margin(self):
        response={'status':400,'body':{'code':'22023','message':'review_unavailable'}}
        delayed=m.classify_fast_result(response,1000000,6000000,8000000)
        self.assertEqual(delayed['status'],'NOT_PROVEN')
        self.assertEqual(delayed['releaseMarkerMeaning'],'ACTUAL_COMMIT_COMPLETED_UPPER_BOUND')
        within=m.classify_fast_result(response,1000000,6000000,7999999)
        self.assertEqual(within['status'],'REPRODUCED_CORRELATED_DB_ENTRY_ONLY')

if __name__=='__main__':unittest.main()
