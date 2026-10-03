#!/usr/bin/env python3
"""민규 전용 로컬 DB에 미커밋 네이버 SQL·검사를 적용하고 전부 rollback한다."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
import run_database_tests as db
from run_event_database_tests import read_source, statements
ROOT = Path(__file__).resolve().parents[2]
MIGRATION = Path('backend/supabase/migrations/20261002090000_naver_signup.sql')
TEST = Path('tests/database/minkyu/naver_signup.sql')
CHECKS = {'acl','state_one_use_wrong_verifier_expiry','eligibility_reservation_uid_session',
          'explicit_completion_photo_atomic_traits_safe_output','legacy_reads_activity_gates_relogin_requalification','actual_role_denial'}
def build_script(migration, tests):
    chunks, probes = statements(migration), statements(tests)
    if chunks[0].lower() != 'begin' or chunks[-1].lower() != 'commit' or probes[0].lower() != 'begin' or probes[-1].lower() != 'rollback':
        raise ValueError('EXPECTED_TRANSACTION_WRAPPER')
    body = chunks[1:-1] + probes[1:-1]
    if any(re.match(r'(?is)^(begin|commit|rollback|abort|savepoint|release|start\s+transaction)\b',x) for x in body):
        raise ValueError('NESTED_TRANSACTION')
    if not all('NAVER_CHECK:'+name in tests for name in CHECKS): raise ValueError('TEST_MARKERS_MISSING')
    absent = "do $$ begin assert to_regclass('private.naver_accounts') is null; assert to_regclass('private.naver_sessions') is null; assert to_regclass('private.profile_traits') is null; end $$;"
    return ("set statement_timeout='20s'; set lock_timeout='5s'; set idle_in_transaction_session_timeout='30s'; set transaction_timeout='90s';\n"
            "begin; set local plpgsql.check_asserts=on;\n"+absent+'\n'+';\n'.join(body)+';\nreset role; rollback;\n'
            'set plpgsql.check_asserts=on;\n'+absent+"\nselect 'NAVER_ROLLBACK_PASS';\n")
def execute():
    migration,tests=read_source(ROOT,MIGRATION),read_source(ROOT,TEST)
    script=build_script(migration,tests)
    endpoint=db.docker('context','inspect',db.CONTEXT,'--format','{{.Endpoints.docker.Host}}')
    if endpoint.returncode or endpoint.stdout.strip()!='unix://'+str(Path.home()/'.colima/yumidang-minkyu/docker.sock'): raise ValueError('DEDICATED_CONTEXT_REQUIRED')
    container=db.docker('inspect',db.CONTAINER)
    if container.returncode: raise ValueError('DEDICATED_CONTAINER_REQUIRED')
    db.validate_target(endpoint.stdout.strip(),json.loads(container.stdout)[0])
    with db.SessionLock(73110002):
        result=subprocess.run(db.psql_command(),input=script,capture_output=True,text=True,timeout=100)
    if result.returncode:
        # 합성 자료 검사에서도 SQL 원문·연결 정보는 출력하지 않는다.
        return {'status':'FAIL','result':'SQL_CHECK_FAILED','rollback':'NOT_VERIFIED'}
    lines=result.stdout.splitlines()
    observed={x.removeprefix('NAVER_CHECK:') for x in lines if x.startswith('NAVER_CHECK:')}
    if observed!=CHECKS or 'NAVER_ROLLBACK_PASS' not in lines: return {'status':'FAIL','result':'CHECK_OR_ROLLBACK_MARKER_MISSING'}
    return {'status':'PASS','checks':len(CHECKS),'rollback':'PASS','scope':'local_pending_migration_only',
            'migration_sha256':hashlib.sha256(migration.encode()).hexdigest(),'tests_sha256':hashlib.sha256(tests.encode()).hexdigest()}
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--run',action='store_true');args=parser.parse_args()
    report={'status':'NOT_RUN','result':'EXPLICIT_RUN_REQUIRED'}
    if args.run:
        try: report=execute()
        except Exception: report={'status':'FAIL','result':'SOURCE_OR_TARGET_CHECK_FAILED'}
    print(json.dumps(report));return 0 if report['status']=='PASS' else 2 if report['status']=='NOT_RUN' else 1
if __name__=='__main__':raise SystemExit(main())
