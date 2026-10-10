#!/usr/bin/env python3
"""검토된 정식 41개와 최신 정책 SQL 78개를 service-api 로컬 검증 루트에 준비한다. 실행 없음."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import prepare_edge as edge
from prepare_migrations import CANONICAL, COPY, MIGRATIONS, PreparationError, git

# 검토된 특정 경로와 바이트만 허용한다. 수정된 SQL을 자동으로 승인하지 않는다.
CURRENT_POLICY_REVIEWED = {
    'backend/supabase/migrations/20261010030000_hidden_message_read_receipts.sql': '74653943bae50901d50c72b1f4ccd66502f2799fc8ea7a5115e73fde270fe6ef',
    'backend/supabase/migrations/20261009031628_event_detail_projection.sql': '8b5b4af91067276fdfd27cd7340d30ff04f94ba632b029fa274885fde0be636c',
    'backend/supabase/migrations/20261009010900_worker_invocation_audit.sql': '5de1f86e7937cef02f2f7dd3a2691afe0663effdbfa49a2af1490d6221836288',
    'backend/supabase/migrations/20261009011000_member_cleanup_invocation.sql': '8cda95503183c2784c6e56cf4904b34eae67824fd310a1452c7001d7f1f52125',
    'backend/supabase/migrations/20261009011100_event_collection_lane.sql': 'f9e6026400a3a7b8d6e3a0c929f9c13e65cc41ff991180fd4fb4f17e921cc34c',
    'backend/supabase/migrations/20261009011200_event_invocation_audit.sql': 'd63015b7a9ef4988f5520ee25a4d8b87b7a03b7b152472e48d33ca7edf81fc61',
    'backend/supabase/migrations/20261009011400_worker_intent_confirmation.sql': '7ba321e924e02bfea41a244435a21a5fc52d71e049421e178ca72a91358065ed',
    'backend/supabase/migrations/20261009011500_member_cleanup_reconcile.sql': '74a0d3b2af807310f76dd77d8769f3177ca8f47cef2161ca4b44f194bbb73081',
    'backend/supabase/migrations/20261009011600_content_inspection_tickets.sql': 'a3a7abf169d4edd2d86556def9823f5f56a2072796c3a9adcc1b46e1d23b58ec',
    'backend/supabase/migrations/20261009011700_member_retirement_receipt.sql': 'bfa60e1169dc3752c54a53c5a4be462af5a40ef87ccd4e8477f724230fd41456',
    'backend/supabase/migrations/20261009024414_member_cleanup_unknown_discovery.sql': '7d96eb284ff8d71685c6d3fe0379e7c3310a7dca89912bf855020920c3012e9c',
    'backend/supabase/migrations/20261008083002_member_cleanup_ack_recovery.sql': 'b930cfe057b48050dcb275473d3a7af2bfb5117c5af0185ce3929d60674d9213',
    'backend/supabase/migrations/20261008024000_runtime_recovery_schedule.sql': '41f41622a173edc150104d85b467f8b9c55531dc08eb4e257e8cd7e012a2f1e2',
    'backend/supabase/migrations/20261008025000_scoped_feedback_maintenance.sql': 'b9b3fa6a71ed54f60eb502f20d2187c3fea340c6d110dbc4cdf9efa17e3df38a',
    'backend/supabase/migrations/20261008026000_message_read_receipts.sql': 'b613a5fe40b3a342b2a980c33595777094705bc1df91103667e5fffe254d6b2e',
    'backend/supabase/migrations/20261008027000_member_cleanup_dispatch.sql': 'bf1a56ea440bda071bf88ffde76b71ba3fa32925b4e5810cdd46009fa1b56128',
    'backend/supabase/migrations/20261008022000_worker_runtime_atomic.sql': 'd3c9ebed9c370d561a18f92a230fa395c2d0efa0780d88cb3785fd86b8bb6bc3',
    'backend/supabase/migrations/20261008023000_worker_runtime_retention.sql': '014f04fdde6c2a01edee99d36f0e3521529af29c25746f86af4cea200c5abea6',
    'backend/supabase/migrations/20261008021000_worker_runtime_journal.sql': 'cef102978d33e8009567e95508750e9a23c34ac2788438f7536d1a75ff446df8',
    'backend/supabase/migrations/20261008020000_worker_owned_schedule.sql': '141e6e0b755c354b79360ee671adaf530ba2e96784c36b34a8c9336752472b4c',
    'backend/supabase/migrations/20261008010000_member_own_posts.sql': '8d38e1ffbba8a4764438372b66f263c0d6cb3875b0411094d0706d53057d636c',
    'backend/supabase/migrations/20261008011000_conversation_read_state.sql': '689475372776c2c85254cb7c895694607ef6157ff335b778400e922c972ab286',
    'backend/supabase/migrations/20261008012000_member_hidden_content_filters.sql': 'f264a46e13c39deaabcff7d548bea7f51c4de9301d9e2ff35ae5db670a46f84e',
    'backend/supabase/migrations/20261008013000_public_event_detail.sql': '931c3c4f6578e7e8d88910a84419102a1c00dc22a44ce2621f63f37056926d41',
    'backend/supabase/migrations/20261008014000_ai_feedback_receipts.sql': 'd8ed7f0a2738d59ccf3a5e77185ee75454f16d0ae8e9e75285353e2c39e66d9a',

    'backend/supabase/migrations/20261006160000_assigned_report_final_closure.sql': 'e52220edd8be14b753c17a1b53a6816342de3aa85f5ef0d9aee1e66bff5c885b',
    'backend/supabase/migrations/20261006151000_historical_safety_episode.sql': '8d4866ee9fa60321927109fa880cdf10d1d37e9d0a77f9a18892d66ba3dccb8a',
    'backend/supabase/migrations/20261006150000_general_sanction_appeal_resolution.sql': '718da5f5d8ccf27908190fd8d2511c1712d2af0fc7cd2d3518c46bae8b1ba50e',
    'backend/supabase/migrations/20261006141000_general_sanction_appeal_intake.sql': '07e23309cf979e74aff46d20787233f5a0d112bcf54bdf032c8e441e21a25106',
    'backend/supabase/migrations/20261006130041_general_sanction_notice_delivery.sql': '31526ba209a742449233cad1f52d024f471fb2de12864a53e4d15065226f676a',
    "backend/supabase/migrations/20261006123430_member_report_hidden_targets.sql": "4aa5af4aa88a53481c1bf52f3ce67f9ff5d3155e7cf215bd8b6d224ec219927b",
    "backend/supabase/migrations/20261006123447_member_report_hidden_targets_bridge.sql": "35ab1a696319c970cb16d5f4846e61ede7907a3ac5703271112554b7da34bf19",
    "backend/supabase/migrations/20261005001429_current_completion_consent_policy.sql": "22312f4333a4676a654a02a2802d63ebf6c7304923172a9dea6bf0de877df275",
    "backend/supabase/migrations/20261005001456_global_worker_lease.sql": "427c665cbe0686d6b70b33d5dc9b4546f7947fa9b5731a15670f1fd45f0fe6e9",
    "backend/supabase/migrations/20261005001538_current_public_search.sql": "f9b27ec0c373cf8264a6c0e7e7768a52c7bd4730c1644f8cb384391178d06d54",
    "backend/supabase/migrations/20261005002006_first_chat_application.sql": "46a7be5550c2a4e6c901899b06db4b7ebc7c833ef820b117cfbed24d43eef191",
    "backend/supabase/migrations/20261005002528_ai_atomic_requests.sql": "789e97ae1e179bff176f0fc5b9d18fed445e26d18d4b186ca877defc98f35c02",
    "backend/supabase/migrations/20261005003000_worker_job_fences.sql": "ce31ec87b09a40174b1ed6d277bb4abbc1cd8865e6855498a94686caccb12c90",
    "backend/supabase/migrations/20261005003159_current_summary_fences.sql": "e3796267685e641cc3aa0257bf2410ff4abec12c0ef5d52225ff14ba54fd4cbc",
    "backend/supabase/migrations/20261005005459_current_recruitment_reopen.sql": "af2c94c092e757765aef5745ce73bd83a146842875cf93b29a933102127c875e",
    "backend/supabase/migrations/20261005005855_current_member_blocks.sql": "28ad42ff14cae65bd6b984667119113753d04cf78b79c969b05d9a3fe675de69",
    "backend/supabase/migrations/20261005013901_current_sweetness_ledger.sql": "6db41b47a2f469d1370f2589f9a1daedc854275eac65f220fcb37909002a891e",
    "backend/supabase/migrations/20261005014629_appointment_place_change_draft.sql": "a3c2284bf1b2fbf19c3a4404c1deea2eaa6314c9faee51894c3b5c30e4e4904c",
    "backend/supabase/migrations/20261005014630_appointment_location_validation.sql": "93d7ab1d413a6e46425218798925f26440e8f1a674e2c3830e60394b862fa0c7",
    "backend/supabase/migrations/20261005015709_member_reports.sql": "317fbb34f1e07bf37976b3d9ec809f0ca6bfabf787006aad737e6552aeffc07c",
    "backend/supabase/migrations/20261005020135_current_member_lifecycle.sql": "d24d3e338e9a8876c3d34c761f3fe9c863095faa95d93bf0055c471a81ab266d",
    "backend/supabase/migrations/20261005020136_member_cleanup_dependencies.sql": "a5a5827f1d79887d36d3e22bba5d42a45f93702ae770f9a20822da7eea39259b",
    "backend/supabase/migrations/20261005021810_sanction_adjudication_draft.sql": "b3c56b87385b5bf835f7ae52390b80b963d50b9308dc3878b8645a756905120f",
    "backend/supabase/migrations/20261005030100_member_retention_batches.sql": "c7877762ca88df738a991b35fc65ae4144e1de6eaf7fca44b623caadaa7a1e60",
    "backend/supabase/migrations/20261005021811_member_activity_sanction_gates.sql": "cf30480c6254060fbaef2bba375260d611ed17059ac200aee2af93d90da80255",
    "backend/supabase/migrations/20261005040100_worker_queue_schedule.sql": "71e18556baf27779a68fb209fb5b1cb51310ef5e6511c5cd5d65402de397aee5",
    "backend/supabase/migrations/20261005040300_worker_queue_runner_role.sql": "49d7d72b47b33e5fee407498e6c09882c3e929de06c815240f10781d4c11917c",
    "backend/supabase/migrations/20261005040500_member_profile_preferences.sql": "98ce66ffc50229a6713266197b315a1eeec2e69bbdd5fe1908c1c45cb70bd278",
    "backend/supabase/migrations/20261005040600_appointment_change_withdrawal.sql": "80d58914f8db461c9e5d961b4a5ebcc8c51aaa6a0ce76fd843333e2079d5a10b",
    "backend/supabase/migrations/20261005040700_member_safety_state.sql": "39f2cabe90cc137252be7953f5c0078f087f78f8ce7a2fbeda469a7309e555cf",
    "backend/supabase/migrations/20261005040800_appointment_safety_result_sync.sql": "afc727a109454d430ab2b39b7d8000c2f7f49638c4351200454827c8a2c1ab80",
    "backend/supabase/migrations/20261005040900_appointment_review_holds.sql": "b13e5ade5891e49b049a7243ba3cbe161d8e64545212bc72d8865638a6992fe6",
    "backend/supabase/migrations/20261005041000_appointment_review_no_show_lifecycle.sql": "b780d364f0d614a160934bd57bb2c1347f24d6a9321275baadbbaf632db3ed50",
    "backend/supabase/migrations/20261005135215_member_sanction_history.sql": "c6dfa91e15bf8b97c1878b53ec62d887e18061fa5704aeee8f946a5ea5cc3b8c",
    "backend/supabase/migrations/20261005143045_profile_image_authenticated_access.sql": "c191b5808a970c7649edd1ba9b221a444d686ae3342c49b765629f0543f4f83e",
    "backend/supabase/migrations/20261005143318_assigned_report_operator_access.sql": "296cc4fc48fce2f66f1ad72d10b39b3a12d2f7a225033a61fb8ab2b56a4486fd",
    "backend/supabase/migrations/20261005150558_assigned_report_capture_access.sql": "ead3e529ce957748af590d82339f6c9c0589680b8cf465c4f5975285d994699c",
    "backend/supabase/migrations/20261005155136_assigned_report_review_start.sql": "c1083e452b284ed66edaa11bb4e075914e6f93ce64ab918a1c266f62ad470b71",
    "backend/supabase/migrations/20261005161352_assigned_report_review_state.sql": "4c497604f20db4708f65750697fe8bc4f51ea5e1afe6d81d95c2e119a63f0846",
    "backend/supabase/migrations/20261005171606_assigned_report_adjudication.sql": "d2e3b141ea5ad7048d075f1568f7afd6fc1320e3daa4f71163b252a91b825133",
    "backend/supabase/migrations/20261005190311_appointment_cancel_appeal_intake.sql": "359a8093c3a32bf7d547a17df98173de677307933780a8e78db323bc4c26fcd8",
    "backend/supabase/migrations/20261005195033_appointment_cancel_appeal_atomic_report.sql": "53750fc93d7edf48ff863807ccfa267c3e759213d55385b3d0d28103ec71f745",
    "backend/supabase/migrations/20261005203258_appointment_cancel_resolution_and_due.sql": "542d2efcc3c44e45e4d3cd1f7caeb2f22e5649615a22ff547f319267a45b3efa",
    "backend/supabase/migrations/20261005225107_report_retention_purge.sql": "c5b801c0f31dd8f058aafd844f90b5531cd582c7f668cc6703b0b01b3ce14a91",
    "backend/supabase/migrations/20261005225951_worker_supported_claim.sql": "bbe43a5adaef287145d832a37353c9c32991a813663b28975f8c1d5ad532fa8b",
    "backend/supabase/migrations/20261005232700_report_retention_dispatch_fence.sql": "4283b5d85a18404409db5828885576c091b8e4525a0f884a849f1d17bcdac2c5",
    "backend/supabase/migrations/20261005233511_cancellation_due_guard_closed.sql": "85aec069961a72d9ea0bd1cc23324c8c2c93800fba23896cd26eb4777df831b6",
    "backend/supabase/migrations/20261005235230_worker_queue_retention_schedule.sql": "8a1a0f10ad95ea1ca02569057a97ddf544cf65304d72d5a6ac0d55f094886f2e",
    "backend/supabase/migrations/20261006021419_cancellation_next_due_generation.sql": "b65932fbad39bd12064b0d53f8aa2b66106fb9f4418741b7a692137c91eee0fc",
    "backend/supabase/migrations/20261005180340_assigned_report_notice_receipts.sql": "880e62099cbb2f405da1e9035bcba2bdb0ff19c2f5a4d5222c63586240fbfc6b",
    "backend/supabase/migrations/20261006170000_ai_account_budget.sql": "3b8e5f523a077ee699505cda61835c3a082d4fdca7475e1b27db761b6e671ce8",
    "backend/supabase/migrations/20261007010000_cancellation_report_final_closure.sql": "d0f360ef470033757cfc409d27440ff29383c254e78a0c7cd2ad5f83a2f9db22",
    "backend/supabase/migrations/20261007020000_cancellation_clock_lineage.sql": "4f88fa9f16c1106ed4f56de580ed8e800ef9e6bddfa022a7ce048ca341c9fdbd",
}
QUEUE_RUNNER_ROLE_MIGRATION = "backend/supabase/migrations/20261005040300_worker_queue_runner_role.sql"
PROFILE_PREFERENCES_MIGRATION = "backend/supabase/migrations/20261005040500_member_profile_preferences.sql"
APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION = "backend/supabase/migrations/20261005040600_appointment_change_withdrawal.sql"
MEMBER_SAFETY_STATE_MIGRATION = "backend/supabase/migrations/20261005040700_member_safety_state.sql"
APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION = "backend/supabase/migrations/20261005040800_appointment_safety_result_sync.sql"
APPOINTMENT_REVIEW_HOLDS_MIGRATION = "backend/supabase/migrations/20261005040900_appointment_review_holds.sql"
MEMBER_SANCTION_HISTORY_MIGRATION = "backend/supabase/migrations/20261005135215_member_sanction_history.sql"
APPOINTMENT_REVIEW_NO_SHOW_MIGRATION = "backend/supabase/migrations/20261005041000_appointment_review_no_show_lifecycle.sql"
PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION = "backend/supabase/migrations/20261005143045_profile_image_authenticated_access.sql"
ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION = "backend/supabase/migrations/20261005143318_assigned_report_operator_access.sql"
ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION = "backend/supabase/migrations/20261005150558_assigned_report_capture_access.sql"
ASSIGNED_REPORT_REVIEW_START_MIGRATION = "backend/supabase/migrations/20261005155136_assigned_report_review_start.sql"
ASSIGNED_REPORT_REVIEW_STATE_MIGRATION = "backend/supabase/migrations/20261005161352_assigned_report_review_state.sql"
ASSIGNED_REPORT_ADJUDICATION_MIGRATION = "backend/supabase/migrations/20261005171606_assigned_report_adjudication.sql"
APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION = "backend/supabase/migrations/20261005190311_appointment_cancel_appeal_intake.sql"
APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION = "backend/supabase/migrations/20261005195033_appointment_cancel_appeal_atomic_report.sql"
APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION = "backend/supabase/migrations/20261005203258_appointment_cancel_resolution_and_due.sql"
ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION = "backend/supabase/migrations/20261005180340_assigned_report_notice_receipts.sql"
REPORT_RETENTION_PURGE_MIGRATION = "backend/supabase/migrations/20261005225107_report_retention_purge.sql"
WORKER_SUPPORTED_CLAIM_MIGRATION = "backend/supabase/migrations/20261005225951_worker_supported_claim.sql"
REPORT_RETENTION_DISPATCH_MIGRATION = "backend/supabase/migrations/20261005232700_report_retention_dispatch_fence.sql"
CANCELLATION_DUE_GUARD_MIGRATION = "backend/supabase/migrations/20261005233511_cancellation_due_guard_closed.sql"
WORKER_RETENTION_SCHEDULE_MIGRATION = "backend/supabase/migrations/20261005235230_worker_queue_retention_schedule.sql"
CANCELLATION_NEXT_DUE_MIGRATION = "backend/supabase/migrations/20261006021419_cancellation_next_due_generation.sql"
NEW_QUEUE_MIGRATIONS = {WORKER_RETENTION_SCHEDULE_MIGRATION, CANCELLATION_NEXT_DUE_MIGRATION}
HIDDEN_TARGET_MIGRATIONS = {'backend/supabase/migrations/20261006123430_member_report_hidden_targets.sql', 'backend/supabase/migrations/20261006123447_member_report_hidden_targets_bridge.sql'}
GENERAL_NOTICE_DELIVERY_MIGRATION = 'backend/supabase/migrations/20261006130041_general_sanction_notice_delivery.sql'
GENERAL_APPEAL_INTAKE_MIGRATION = 'backend/supabase/migrations/20261006141000_general_sanction_appeal_intake.sql'
GENERAL_APPEAL_RESOLUTION_MIGRATION = 'backend/supabase/migrations/20261006150000_general_sanction_appeal_resolution.sql'
HISTORICAL_SAFETY_EPISODE_MIGRATION = 'backend/supabase/migrations/20261006151000_historical_safety_episode.sql'
ASSIGNED_REPORT_FINAL_CLOSURE_MIGRATION = 'backend/supabase/migrations/20261006160000_assigned_report_final_closure.sql'
AI_ACCOUNT_BUDGET_MIGRATION = 'backend/supabase/migrations/20261006170000_ai_account_budget.sql'
CANCELLATION_REPORT_FINAL_CLOSURE_MIGRATION = 'backend/supabase/migrations/20261007010000_cancellation_report_final_closure.sql'
CANCELLATION_CLOCK_LINEAGE_MIGRATION = 'backend/supabase/migrations/20261007020000_cancellation_clock_lineage.sql'
ADDITIONAL_BACKEND_MIGRATIONS = {'backend/supabase/migrations/20261008012000_member_hidden_content_filters.sql', 'backend/supabase/migrations/20261008010000_member_own_posts.sql', 'backend/supabase/migrations/20261008011000_conversation_read_state.sql', 'backend/supabase/migrations/20261008013000_public_event_detail.sql', 'backend/supabase/migrations/20261008014000_ai_feedback_receipts.sql'}
ATOMIC_RUNTIME_MIGRATIONS = {'backend/supabase/migrations/20261008023000_worker_runtime_retention.sql', 'backend/supabase/migrations/20261008022000_worker_runtime_atomic.sql'}
RUNTIME_MIGRATIONS = {'backend/supabase/migrations/20261008020000_worker_owned_schedule.sql','backend/supabase/migrations/20261008021000_worker_runtime_journal.sql'}
CONNECTION_MIGRATIONS = {'backend/supabase/migrations/20261008083002_member_cleanup_ack_recovery.sql', 'backend/supabase/migrations/20261008027000_member_cleanup_dispatch.sql', 'backend/supabase/migrations/20261008024000_runtime_recovery_schedule.sql', 'backend/supabase/migrations/20261008025000_scoped_feedback_maintenance.sql', 'backend/supabase/migrations/20261008026000_message_read_receipts.sql'}
# SQL109~120(113 번호 미사용): 정확한 순서의 검토된 후속만 허용한다.
BACKEND_FOLLOWUP_MIGRATIONS = ('backend/supabase/migrations/20261009010900_worker_invocation_audit.sql', 'backend/supabase/migrations/20261009011000_member_cleanup_invocation.sql', 'backend/supabase/migrations/20261009011100_event_collection_lane.sql', 'backend/supabase/migrations/20261009011200_event_invocation_audit.sql', 'backend/supabase/migrations/20261009011400_worker_intent_confirmation.sql', 'backend/supabase/migrations/20261009011500_member_cleanup_reconcile.sql', 'backend/supabase/migrations/20261009011600_content_inspection_tickets.sql', 'backend/supabase/migrations/20261009011700_member_retirement_receipt.sql', 'backend/supabase/migrations/20261009024414_member_cleanup_unknown_discovery.sql', 'backend/supabase/migrations/20261009031628_event_detail_projection.sql', 'backend/supabase/migrations/20261010030000_hidden_message_read_receipts.sql')
NEW_PENDING_MIGRATIONS = set(BACKEND_FOLLOWUP_MIGRATIONS) | CONNECTION_MIGRATIONS | ATOMIC_RUNTIME_MIGRATIONS | RUNTIME_MIGRATIONS | ADDITIONAL_BACKEND_MIGRATIONS | NEW_QUEUE_MIGRATIONS | HIDDEN_TARGET_MIGRATIONS | {GENERAL_NOTICE_DELIVERY_MIGRATION, GENERAL_APPEAL_INTAKE_MIGRATION, GENERAL_APPEAL_RESOLUTION_MIGRATION, HISTORICAL_SAFETY_EPISODE_MIGRATION, ASSIGNED_REPORT_FINAL_CLOSURE_MIGRATION, AI_ACCOUNT_BUDGET_MIGRATION, CANCELLATION_REPORT_FINAL_CLOSURE_MIGRATION, CANCELLATION_CLOCK_LINEAGE_MIGRATION}
CONFIG = Path("backend/supabase/config.toml")


def inspect_current_migrations(repo):
    """HEAD 28/41/60/61/62/63/64/65/66/67/68/69/70/71/72/73/74/75/76/77/78/79/80/81/82의 정확한 집합과 현재 119개 바이트를 모두 검토 해시와 비교한다."""
    repo = Path(repo).resolve()
    if Path(git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve() != repo:
        raise PreparationError("--repo는 저장소 최상위 경로여야 합니다.")
    base = edge.GATEWAY_REVIEWED_MIGRATIONS
    policy = CURRENT_POLICY_REVIEWED
    reviewed = {**base, **policy}
    pending_base = {str(path) for path in edge.GATEWAY_PENDING}
    if (len(base) != 41 or len(policy) != 78 or len(reviewed) != 119
            or len(BACKEND_FOLLOWUP_MIGRATIONS) != 11
            or tuple(sorted(set(BACKEND_FOLLOWUP_MIGRATIONS))) != BACKEND_FOLLOWUP_MIGRATIONS
            or not set(BACKEND_FOLLOWUP_MIGRATIONS) <= set(policy)
            or not {QUEUE_RUNNER_ROLE_MIGRATION, PROFILE_PREFERENCES_MIGRATION, APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION, MEMBER_SAFETY_STATE_MIGRATION, APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION, APPOINTMENT_REVIEW_HOLDS_MIGRATION, APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, MEMBER_SANCTION_HISTORY_MIGRATION, PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION} <= set(policy)
            or not pending_base <= set(base)):
        raise PreparationError("검토된 기존 41개와 최신 78개 목록이 필요합니다.")
    source_head = git(repo, "rev-parse", "HEAD").decode().strip()
    head_names = git(repo, "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", str(MIGRATIONS)).decode().split("\0")
    head = set()
    excluded = set()
    for name in filter(None, head_names):
        path = Path(name)
        if path.suffix != ".sql":
            continue
        if COPY.search(path.name):
            excluded.add(name)
            continue
        if path.parent != MIGRATIONS or not CANONICAL.fullmatch(path.name) or name not in reviewed:
            raise PreparationError(f"검토 목록 밖 HEAD SQL입니다: {name}")
        if edge.digest(git(repo, "show", f"HEAD:{name}")) != reviewed[name]:
            raise PreparationError(f"HEAD SQL 내용이 검토된 해시와 다릅니다: {name}")
        head.add(name)
    historical108 = set(reviewed) - set(BACKEND_FOLLOWUP_MIGRATIONS)
    # 번호와 개수는 다르다. 일부 후속만 임의로 넣은 HEAD를 허용하지 않는다.
    followup_prefixes = tuple(historical108 | set(BACKEND_FOLLOWUP_MIGRATIONS[:n]) for n in range(1, len(BACKEND_FOLLOWUP_MIGRATIONS) + 1))
    historical107 = historical108 - {'backend/supabase/migrations/20261008083002_member_cleanup_ack_recovery.sql'}
    historical106 = historical107 - {'backend/supabase/migrations/20261008027000_member_cleanup_dispatch.sql'}
    historical105 = historical106 - {'backend/supabase/migrations/20261008026000_message_read_receipts.sql'}
    historical104 = historical105 - {'backend/supabase/migrations/20261008025000_scoped_feedback_maintenance.sql'}
    historical103 = historical104 - {'backend/supabase/migrations/20261008024000_runtime_recovery_schedule.sql'}
    historical102 = historical103 - {'backend/supabase/migrations/20261008023000_worker_runtime_retention.sql'}
    historical101 = historical102 - {'backend/supabase/migrations/20261008022000_worker_runtime_atomic.sql'}
    historical100 = historical101 - {'backend/supabase/migrations/20261008021000_worker_runtime_journal.sql'}
    historical99 = historical100 - {'backend/supabase/migrations/20261008020000_worker_owned_schedule.sql'}
    historical94 = historical99 - ADDITIONAL_BACKEND_MIGRATIONS
    historical93 = historical94 - {CANCELLATION_CLOCK_LINEAGE_MIGRATION}
    historical92 = historical93 - {CANCELLATION_REPORT_FINAL_CLOSURE_MIGRATION}
    historical91 = historical92 - {AI_ACCOUNT_BUDGET_MIGRATION}
    historical90 = historical91 - {ASSIGNED_REPORT_FINAL_CLOSURE_MIGRATION}
    historical89 = historical90 - {HISTORICAL_SAFETY_EPISODE_MIGRATION}
    historical88 = historical89 - {GENERAL_APPEAL_RESOLUTION_MIGRATION}
    historical87 = historical88 - {GENERAL_APPEAL_INTAKE_MIGRATION}
    historical86 = historical87 - {GENERAL_NOTICE_DELIVERY_MIGRATION}
    historical84 = historical86 - HIDDEN_TARGET_MIGRATIONS
    historical85 = historical84 | {"backend/supabase/migrations/20261006123430_member_report_hidden_targets.sql"}
    historical82 = historical84 - NEW_QUEUE_MIGRATIONS
    historical83 = historical82 | {WORKER_RETENTION_SCHEDULE_MIGRATION}
    # 이전 이력은 정확한 경로 집합으로 고정한다. 개수만 같은 임의 subset은 거절한다.
    previous60 = historical82 - {QUEUE_RUNNER_ROLE_MIGRATION, PROFILE_PREFERENCES_MIGRATION, APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION, MEMBER_SAFETY_STATE_MIGRATION, APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION, APPOINTMENT_REVIEW_HOLDS_MIGRATION, APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, MEMBER_SANCTION_HISTORY_MIGRATION, PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous61 = historical82 - {PROFILE_PREFERENCES_MIGRATION, APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION, MEMBER_SAFETY_STATE_MIGRATION, APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION, APPOINTMENT_REVIEW_HOLDS_MIGRATION, APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, MEMBER_SANCTION_HISTORY_MIGRATION, PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous62 = historical82 - {APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION, MEMBER_SAFETY_STATE_MIGRATION, APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION, APPOINTMENT_REVIEW_HOLDS_MIGRATION, APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, MEMBER_SANCTION_HISTORY_MIGRATION, PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous63 = historical82 - {MEMBER_SAFETY_STATE_MIGRATION, APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION, APPOINTMENT_REVIEW_HOLDS_MIGRATION, APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, MEMBER_SANCTION_HISTORY_MIGRATION, PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous64 = historical82 - {APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION, APPOINTMENT_REVIEW_HOLDS_MIGRATION, APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, MEMBER_SANCTION_HISTORY_MIGRATION, PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous65 = historical82 - {APPOINTMENT_REVIEW_HOLDS_MIGRATION, APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, MEMBER_SANCTION_HISTORY_MIGRATION, PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous66 = historical82 - {APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, MEMBER_SANCTION_HISTORY_MIGRATION, PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous67 = historical82 - {MEMBER_SANCTION_HISTORY_MIGRATION, PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous68 = historical82 - {PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous69 = historical82 - {ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous70 = historical82 - {ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous71 = historical82 - {ASSIGNED_REPORT_REVIEW_START_MIGRATION, ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous72 = historical82 - {ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous73 = historical82 - {ASSIGNED_REPORT_ADJUDICATION_MIGRATION, ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous74 = historical82 - {ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous75 = historical82 - {APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous76 = historical82 - {APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous77 = historical82 - {APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous78 = historical82 - {REPORT_RETENTION_PURGE_MIGRATION, WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous79 = historical82 - {WORKER_SUPPORTED_CLAIM_MIGRATION, REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous80 = historical82 - {REPORT_RETENTION_DISPATCH_MIGRATION, CANCELLATION_DUE_GUARD_MIGRATION}
    previous81 = historical82 - {CANCELLATION_DUE_GUARD_MIGRATION}
    if head not in (set(base) - pending_base, set(base), previous60, previous61, previous62, previous63, previous64, previous65, previous66, previous67, previous68, previous69, previous70, previous71, previous72, previous73, previous74, previous75, previous76, previous77, previous78, previous79, previous80, previous81, historical82, historical83, historical84, historical85, historical86, historical87, historical88, historical89, historical90, historical91, historical92, historical93, historical94, historical99, historical100, historical101, historical102, historical103, historical104, historical105, historical106, historical107, historical108, *followup_prefixes):
        raise PreparationError("검토된 HEAD 28개/41개/60개/61개/62개/63개/64개/65개/66개/67개/68개/69개/70개/71개/72개/73개/74개/75개/76개/77개/78개/79개/80개/81개/82개/83개/84개/85개/86개/87개/88개/89개/90개/91개/92개/93개/94개/99~108개 및 검토된 후속11개의 순차 prefix 전체만 준비할 수 있습니다.")
    # 기존 strict gateway 검사도 그대로 실행한다. 60/61/62/63/64/65/66/67/68/69/70/71/72/73/74/75/76/77/78/79/80/81/82개일 때는 기존 41개 집합만 전달한다.
    base_head = sorted(head & set(base))
    base_report = {"count": len(base_head), "migrations": [
        {"path": name, "sha256": reviewed[name]} for name in base_head]}
    edge.validate_reviewed_migration_history(base_report)
    payloads, entries, versions, hashes = {}, [], set(), set()
    for name, expected in sorted(reviewed.items()):
        path = Path(name)
        match = CANONICAL.fullmatch(path.name)
        data = edge.read_regular(repo, path)
        sha = edge.digest(data)
        if not match or not data.strip() or sha != expected:
            raise PreparationError(f"현재 SQL 내용이 검토된 해시와 다릅니다: {name}")
        if match[1] in versions or sha in hashes:
            raise PreparationError("선택 SQL 버전·내용이 중복됩니다.")
        versions.add(match[1]); hashes.add(sha)
        payloads[path] = data
        entries.append({"version": match[1], "path": name, "sha256": sha, "bytes": len(data)})
    # untracked/staged 신파일도 고정 목록으로만 선택한다. 사본은 선택하지 않고 기록한다.
    for candidate in (repo / MIGRATIONS).rglob("*.sql"):
        path = candidate.relative_to(repo)
        if COPY.search(path.name):
            excluded.add(str(path))
        elif str(path) not in reviewed:
            raise PreparationError(f"검토 목록 밖 현재 SQL입니다: {path}")
    pending = [entry for entry in entries if entry["path"] not in head]
    canonical = [entry for entry in entries if entry["path"] in head]
    return {"source_head": source_head, "canonical": canonical, "pending": pending,
            "entries": entries, "excluded": sorted(excluded)}, payloads


def create_base_snapshot(snapshot, payloads, config, sources):
    """검증된 바이트만 임시 Git에 기록한다. 원본 저장소/index/HEAD는 변경하지 않는다."""
    selected = {**{path: data for path, data in payloads.items()
                   if str(path) in edge.GATEWAY_REVIEWED_MIGRATIONS}, CONFIG: config, **sources}
    for path, data in selected.items():
        target = snapshot / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
    for args in (("init", "-q"), ("add", "."),
                 ("-c", "user.name=Local policy preparation", "-c", "user.email=local-policy@example.invalid",
                  "-c", "commit.gpgsign=false", "commit", "-qm", "Reviewed 41 migration snapshot")):
        try:
            subprocess.run(["git", "-C", str(snapshot), *args], env=environment,
                           capture_output=True, check=True, timeout=15)
        except (OSError, subprocess.SubprocessError) as exc:
            raise PreparationError("검토된 기존 SQL의 임시 Git 준비에 실패했습니다.") from exc
    return git(snapshot, "rev-parse", "HEAD").decode().strip()


def write_manifest(path, report):
    with path.open("x") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def prepare_current_policy(repo, output, *, gateway_probe=False):
    if not gateway_probe:
        raise PreparationError("최신 정책 준비에는 명시적 --gateway-probe가 필요합니다.")
    repo = Path(repo).resolve()
    history, sql_payloads = inspect_current_migrations(repo)
    config = edge.read_regular(repo, CONFIG)
    edge.gateway_config(config)  # 기존 임시 프로젝트/포트/함수 overlay 범위를 그대로 검증한다.
    sources = edge.source_snapshot(repo)
    destination = edge.private_gateway_output(repo, output)
    with tempfile.TemporaryDirectory(prefix="yumidang-policy-base-", dir="/private/tmp") as temporary:
        snapshot = Path(temporary) / "repo"
        snapshot.mkdir(mode=0o700)
        base_head = create_base_snapshot(snapshot, sql_payloads, config, sources)
        base_report = edge.prepare_gateway_probe(snapshot, destination)
    # 기존 도구의 READY는 41개 준비만 증명한다. 최신 정책 artifact와 별도 이름으로 보존한다.
    for name in ("migration", "database", "edge"):
        (destination / f"{name}-manifest.json").rename(destination / f"base-{name}-manifest.json")
    for path, data in sql_payloads.items():
        if str(path) in CURRENT_POLICY_REVIEWED:
            with (destination / "supabase/migrations" / path.name).open("xb") as stream:
                stream.write(data)
    current_history, current_sql = inspect_current_migrations(repo)
    if (current_history != history or current_sql != sql_payloads
            or edge.read_regular(repo, CONFIG) != config or edge.source_snapshot(repo) != sources):
        raise PreparationError("준비 중 원본이 변경되었습니다. 새 임시 루트로 다시 준비하십시오.")
    shared = {"status": "READY", "mode": "current_policy_gateway", "sql_execution": "NOT_RUN",
              "edge_execution": "NOT_RUN", "output_root": str(destination),
              "source_head": history["source_head"], "source_mode": "working_tree_snapshot",
              "canonical_count": len(history["canonical"]), "pending_count": len(history["pending"]),
              "migration_count": len(history["entries"]), "base_migration_count": 41, "policy_migration_count": len(CURRENT_POLICY_REVIEWED),
              "base_snapshot_head": base_head, "base_manifests": [f"base-{name}-manifest.json" for name in ("migration", "database", "edge")],
              "preparation_note": "파일 준비 결과이며 실제 SQL 적용·Edge 실행·운영 배포 검증이 아니다."}
    migration = {**shared, "count": len(history["entries"]), "migrations": history["entries"], "excluded": history["excluded"]}
    database = {**shared, "count": len(history["canonical"]), "total_count": len(history["entries"]),
                "migrations": history["canonical"], "pending": history["pending"],
                "excluded": history["excluded"], "config_sha256": edge.digest(config)}
    report = {**base_report, **shared, "base_snapshot_head": base_head,
              "policy_migrations": [entry for entry in history["entries"] if entry["path"] in CURRENT_POLICY_REVIEWED]}
    write_manifest(destination / "migration-manifest.json", migration)
    write_manifest(destination / "database-manifest.json", database)
    write_manifest(destination / "edge-manifest.json", report)
    write_manifest(destination / "current-policy-manifest.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--gateway-probe", action="store_true")
    args = parser.parse_args()
    try:
        result = prepare_current_policy(args.repo, args.output, gateway_probe=args.gateway_probe)
    except (PreparationError, OSError) as exc:
        print(json.dumps({"status": "BLOCKED", "sql_execution": "NOT_RUN", "edge_execution": "NOT_RUN", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
