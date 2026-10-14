"""승인3 migration의 좁은 변경 범위 검사. SQL/권한 경합 실행 증거가 아니며 native는 NOT_RUN."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[3]
PATH = ROOT / 'backend/supabase/migrations/20261014010000_operator_receipts_retirement.sql'
NATIVE = ROOT / 'tests/database/jonghyun/operator_receipts_retirement.sql'
RECEIPTS = {'assigned_report_final_closures', 'general_sanction_appeal_resolutions', 'cancellation_clock_repair_receipts'}


def assert_change_scope(text):
    """중요 데이터 삭제/TTL 변경/새 권한/핵심 탈퇴 복사를 거절하는 변경 범위 검증."""
    source = re.sub(r'--[^\n]*', '', text).lower()
    for forbidden in [r'\bdelete\s+from\b', r'\btruncate\b', r'\bgrant\b',
                      r'\b(?:create|drop)\s+table\b', r'\bdrop\s+function\b',
                      r'\b(?:create|alter|drop)\s+role\b', r'\b(?:create|alter|drop)\s+policy\b',
                      r'\bdisable\s+trigger\b', r'\b(?:create|alter|drop)\s+table\s+(?:auth|storage|public)\.',
                      r'\b(?:create(?:\s+or\s+replace)?|alter|drop)\s+function\s+public\.retire_my_account\b',
                      r'\bset\s+(?:retention_due_at|final_closed_at|result|fingerprint|actor_id)\s*=']:
        if re.search(forbidden, source):
            raise AssertionError('OPERATOR_MIGRATION_SCOPE_EXPANDED')
    if set(re.findall(r'\balter\s+table\s+([^\s]+)', source)) != {'%s'}:
        raise AssertionError('OPERATOR_MIGRATION_DDL_SCOPE')
    functions = set(re.findall(r'\bcreate(?: or replace)? function (private\.[a-z_]+)', source))
    if functions != {'private.require_assigned_report_operator', 'private.set_report_operator_approval',
                     'private.set_report_operator_assignment', 'private.revoke_retired_report_operator'}:
        raise AssertionError('OPERATOR_MIGRATION_FUNCTION_SCOPE')
    if set(re.findall(r'\bcreate trigger ([a-z_]+)', source)) != {'retire_report_operator'}:
        raise AssertionError('OPERATOR_MIGRATION_TRIGGER_SCOPE')
    updates = set(re.findall(r'\bupdate\s+(private\.[a-z_]+)\s+set\b', source))
    if updates != {'private.report_operator_approvals', 'private.report_operator_assignments'}:
        raise AssertionError('OPERATOR_MIGRATION_MUTATION_SCOPE')
    return source


def body(source, name):
    match = re.search(r'create(?: or replace)? function private\.' + name +
                      r'\([^;]*?\bas\s*\$\$(.*?)\$\$;', source, re.S)
    if not match:
        raise AssertionError('OPERATOR_FUNCTION_NOT_FOUND')
    return match.group(1)


class OperatorRetirementSourceTests(unittest.TestCase):
    def setUp(self):
        self.source = assert_change_scope(PATH.read_text())

    def test_only_exact_three_auth_foreign_keys_detach_without_receipt_rewrites(self):
        array = re.search(r'foreach target in array array\[(.*?)\]loop', self.source, re.S).group(1)
        self.assertEqual(set(re.findall(r"'private\.([a-z_]+)'::regclass", array)), RECEIPTS)
        for boundary in ["f.confrelid<>'auth.users'::regclass", "f.confdeltype<>'a'", 'f.condeferrable',
                         'not f.convalidated', "conkey=array[actor,client]::smallint[]", 'total<>1',
                         "attname='actor_id'and attnotnull", "attname='client_request_id'and attnotnull"]:
            self.assertIn(boundary, self.source)
        self.assertEqual(self.source.count("alter table %s drop constraint %i"), 1)
        self.assertNotIn('alter column', self.source)
        # 기존 신고 TTL/파기 연결 source를 소비한다. Auth 분리로 이 기존 계약을 대체하지 않는다.
        original = (ROOT / 'backend/supabase/migrations/20261006160000_assigned_report_final_closure.sql').read_text()
        self.assertIn("closed+interval '2160 hours'", original)
        self.assertIn('references private.member_reports(id)on delete cascade', original)

    def test_trigger_locks_auth_then_approval_then_sorted_assignments_and_keeps_first_revocation(self):
        trigger = body(self.source, 'revoke_retired_report_operator')
        locks = trigger.split('then return new;end if;', 1)[1]
        self.assertLess(locks.index('from auth.users'), locks.index('from private.report_operator_approvals'))
        self.assertLess(locks.index('from private.report_operator_approvals'), locks.index('from private.report_operator_assignments'))
        self.assertIn('where id=new.profile_id for update nowait', trigger)
        self.assertIn('order by id for update nowait', trigger)
        self.assertEqual(trigger.count('coalesce(revoked_at,new.retired_at)'), 2)
        self.assertIn("exception when lock_not_available", trigger)
        self.assertIn("errcode='40001'", trigger)
        self.assertIn('after insert on private.member_retirements', self.source)
        self.assertIn('revoke all on function private.revoke_retired_report_operator()', self.source)
        early = trigger.split('then return new;end if;', 1)[0]
        self.assertIn('not exists(select 1 from private.report_operator_approvals where auth_user_id=new.profile_id)', early)
        self.assertIn('and not exists(select 1 from private.report_operator_assignments where operator_uid=new.profile_id)', early)
        self.assertLess(trigger.index('then return new;end if;'), trigger.index('from auth.users'))

    def test_true_guards_existing_profiles_false_remains_revoke_only_and_common_reads_check_retired(self):
        common = body(self.source, 'require_assigned_report_operator')
        self.assertLess(common.index('from auth.users'), common.index('from auth.sessions'))
        self.assertLess(common.index('from auth.sessions'), common.index('private.profile_retired(u)'))
        self.assertLess(common.index('private.profile_retired(u)'), common.index('from private.report_operator_approvals'))
        self.assertEqual(common.count('for share nowait'), 2)
        for name, flag in [('set_report_operator_approval', 'p_approved'), ('set_report_operator_assignment', 'p_assigned')]:
            function = body(self.source, name)
            section = function.split('if ' + flag + ' then', 1)[1].split('end if;', 1)[0]
            self.assertIn('from public.profiles where id=p_user_id for key share nowait', section)
            self.assertIn('private.profile_retired(p_user_id)', section)
            self.assertNotIn('if not found', section)  # profile 미존재를 회원 가입 요구로 바꾸지 않는다.
            self.assertIn('exception when lock_not_available', function)
        assignment = body(self.source, 'set_report_operator_assignment')
        self.assertIn('else update private.report_operator_assignments set revoked_at=clock_timestamp()', assignment)

    def test_scope_checker_rejects_unapproved_data_privilege_and_retention_changes(self):
        for extra in ['delete from auth.users;', 'grant select on private.assigned_report_final_closures to authenticated;',
                      'update private.member_reports set retention_due_at=clock_timestamp();',
                      'create or replace function public.retire_my_account(x uuid)returns void as $$begin end;$$;',
                      'alter table private.unrelated drop constraint important_fk;',
                      'truncate private.cancellation_clock_lineage;']:
            with self.subTest(extra=extra), self.assertRaises(AssertionError):
                assert_change_scope(self.source + '\n' + extra)

    def test_native_candidate_preserves_original_receipts_and_remains_rollback_not_actual_claim(self):
        native = NATIVE.read_text().lower()
        self.assertIn('not_run', native)
        self.assertTrue(native.rstrip().endswith('rollback;'))
        self.assertIn('public.retire_my_account(', native)
        self.assertIn('delete from auth.users where id=pg_temp.operator_uid(3)', native)
        for label in ['closure', 'appeal', 'repair', 'clock', 'other_approval', 'other_assignment']:
            self.assertIn('select ' + label + ' from operator_receipts_before', native)
        self.assertIn('two-session nowait/40001', native)


if __name__ == '__main__':
    unittest.main()
