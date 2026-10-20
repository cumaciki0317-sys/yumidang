"""새 원 Auth6의 service-api 읽기만 검증한다. CLI/기본 import는 실행하지 않는다."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
SELF = 'tests/integration/minkyu/service_profile_readonly_local.py'
FACTORY = 'tests/integration/jonghyun/isolated_ai_factory.ts'
POSITIVE = 'tests/integration/minkyu/ai_positive_discovery_local.py'
SCOPE = 'LOCAL_AUTH6_SERVICE_PROFILE_READONLY_ONLY'
EXPIRED = 'original_expired_me'
EXPIRED_SCOPE = 'ORIGINAL_AUTH6_EXPIRED_ME_ONLY'
SHA = re.compile('[a-f0-9]{64}\\Z')
OWN_KEYS = ['userId', 'realName', 'avatarUrl', 'bio', 'sweetness']
PUBLIC_KEYS = ['profileId', 'displayName', 'age', 'gender', 'avatarPath', 'bio', 'interests',
               'conversationStyles', 'mbti', 'completedCount', 'sweetness']
EXPECTED_CASES = [('own', 200, 1, 1, OWN_KEYS), ('missing', 401, 0, 0, []),
                  ('forged', 401, 1, 0, []), ('public_other', 200, 1, 1, PUBLIC_KEYS)]


def need(value, code):
    if not value: raise ValueError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()


def sha(raw): return hashlib.sha256(raw).hexdigest()


def exact(raw):
    def pairs(items):
        out = {}
        for key, value in items:
            need(key not in out, 'READONLY_DUPLICATE_JSON'); out[key] = value
        return out
    return json.loads(raw, object_pairs_hook=pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError('READONLY_NONFINITE_JSON')))


def load(relative, expected):
    path = ROOT / relative; raw = path.read_bytes()
    need(path.resolve() == path and not path.is_symlink() and sha(raw) == expected, 'READONLY_MODULE_CHANGED')
    spec = importlib.util.spec_from_loader('readonly_' + Path(relative).stem, loader=None)
    module = importlib.util.module_from_spec(spec); module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def service_graph(repo=ROOT):
    """실제 service-api의 정적 상대 import closure. 기존 capsule 허용 경로만 사용한다."""
    repo = Path(repo); boundary = repo / 'backend/supabase/functions'
    pending = [boundary / 'service-api/index.ts']; found = {}
    while pending:
        path = pending.pop()
        need(path.resolve() == path and path.is_relative_to(boundary) and path.suffix == '.ts'
             and not path.is_symlink(), 'READONLY_IMPORT_OUTSIDE_PRODUCT')
        relative = path.relative_to(repo).as_posix()
        if relative in found: continue
        raw = path.read_bytes(); found[relative] = sha(raw)
        for local in re.findall(r'''(?:from\s*|import\s*)["'](\.[^"']+)["']''', raw.decode()):
            pending.append(Path(os.path.normpath(path.parent / local)))
    need(1 <= len(found) + 1 <= 256, 'READONLY_CAPSULE_FILE_LIMIT')
    return found


def source_pins(expected_head=None):
    head = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True, timeout=15).strip()
    need(re.fullmatch('[a-f0-9]{40}', head) and (expected_head is None or expected_head == head), 'READONLY_HEAD_CHANGED')
    original = subprocess.check_output(['git', '-C', str(ROOT), 'show', head + ':' + POSITIVE], timeout=15)
    shared = load(POSITIVE, sha(original)); need((ROOT / POSITIVE).read_bytes() == original, 'READONLY_SHARED_NOT_COMMITTED')
    _, pins = shared.source_pins(head)
    need((ROOT / SELF).is_file(), 'READONLY_SOURCE_NOT_COMMITTED')
    additions = {**service_graph(ROOT), SELF: sha((ROOT / SELF).read_bytes())}
    for relative, pin in additions.items():
        try: committed = subprocess.check_output(['git', '-C', str(ROOT), 'show', head + ':' + relative], timeout=15, stderr=subprocess.DEVNULL)
        except subprocess.SubprocessError: raise ValueError('READONLY_SOURCE_NOT_COMMITTED') from None
        need(sha(committed) == pin and (relative not in pins or pins[relative] == pin), 'READONLY_SOURCE_NOT_COMMITTED')
        pins[relative] = pin
    need(subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True, timeout=15).strip() == head,
         'READONLY_HEAD_CHANGED')
    return head, pins


class ReviewedServiceProfileReadonly:
    """별도 root 검토 코드만 생성한다. JSON flags/ports/skip 옵션을 받지 않는다."""
    def __init__(self, decision_id, root, source_head, pins, binding_sha256, auth6_receipt,
                 auth6_receipt_sha256, capsule_root, node_path, node_sha256, scope_id,
                 daemon_id, runtime_identity_ref):
        root, capsule, receipt, node = map(Path, (root, capsule_root, auth6_receipt, node_path))
        need(type(decision_id) is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}', decision_id), 'READONLY_REVIEW_ID')
        need(root.is_absolute() and root.resolve() == root and not root.is_relative_to(ROOT), 'READONLY_PRIVATE_ROOT')
        need(capsule.is_absolute() and capsule.resolve() == capsule and Path('/private/tmp') in capsule.parents
             and capsule.parent != Path('/private/tmp') and not capsule.is_relative_to(root)
             and not root.is_relative_to(capsule) and not capsule.is_relative_to(ROOT), 'READONLY_NEW_CAPSULE')
        need(receipt.parent.parent == root and receipt.name == 'receipt.json'
             and re.fullmatch('auth-provision-[a-f0-9]{32}', receipt.parent.name), 'READONLY_AUTH6_ROOT')
        need(node.is_absolute() and node.resolve() == node and node.name == 'node', 'READONLY_NODE_PATH')
        need(type(source_head) is str and re.fullmatch('[a-f0-9]{40}', source_head)
             and type(pins) is dict and {SELF, FACTORY, POSITIVE} <= set(pins)
             and all(type(k) is str and type(v) is str and SHA.fullmatch(v) for k, v in pins.items()), 'READONLY_SOURCE_PINS')
        need(all(type(v) is str and SHA.fullmatch(v) for v in (binding_sha256, auth6_receipt_sha256, node_sha256))
             and type(scope_id) is str and re.fullmatch('[a-f0-9]{32}', scope_id)
             and type(daemon_id) is str and str(uuid.UUID(daemon_id)) == daemon_id, 'READONLY_BINDING_HASHES')
        need(type(runtime_identity_ref) is dict and set(runtime_identity_ref) == {'path', 'sha256'}
             and Path(runtime_identity_ref['path']) == root / 'service-profile-runtime-identity.json'
             and type(runtime_identity_ref['sha256']) is str and SHA.fullmatch(runtime_identity_ref['sha256']),
             'READONLY_EXPLICIT_RUNTIME_IDENTITY')
        self._sealed = canonical(dict(scope=SCOPE, decisionId=decision_id, root=str(root), sourceHead=source_head,
            pins=pins, bindingSha256=binding_sha256, auth6Receipt=str(receipt), auth6ReceiptSha256=auth6_receipt_sha256,
            capsuleRoot=str(capsule), nodePath=str(node), nodeSha256=node_sha256, scopeId=scope_id,
            daemonId=daemon_id, runtimeIdentity=runtime_identity_ref))

    def descriptor(self): return exact(self._sealed)


def verify_result(fixture, result):
    keys = {'status', 'scope', 'cases', 'authReads', 'rpcCalls', 'nativeExternalAttempts',
            'forbiddenRpcAttempts', 'providerCalls', 'modelCalls', 'reservationCalls', 'fixtureWrites',
            'actualNaver', 'expiredOriginal', 'rawContentLogged'}
    need(type(result) is dict and set(result) == keys and result['status'] == 'PASS' and result['scope'] == SCOPE
         and result['actualNaver'] == 'NOT_RUN' and result['rawContentLogged'] is False
         and result['expiredOriginal'] == 'NOT_RUN_SAME_ORIGINAL_CONTEXT_REQUIRED', 'READONLY_EXACT_RESULT')
    for key, expected in [('authReads', 3), ('rpcCalls', 2), *[(k, 0) for k in
        ('nativeExternalAttempts', 'forbiddenRpcAttempts', 'providerCalls', 'modelCalls', 'reservationCalls', 'fixtureWrites')]]:
        need(type(result[key]) is int and result[key] == expected, 'READONLY_FORBIDDEN_EFFECT_OR_COUNT')
    need(type(result['cases']) is list and len(result['cases']) == 4, 'READONLY_FOUR_CASES')
    original = fixture['accounts'][0]['accessToken']
    parts = original.split('.'); need(len(parts) == 3 and bool(parts[2]), 'READONLY_ORIGINAL_TOKEN')
    forged = '.'.join(parts[:2] + [('b' if parts[2][0] == 'a' else 'a') + parts[2][1:]])
    for row, (name, status, auth, rpc, dto) in zip(result['cases'], EXPECTED_CASES):
        need(type(row) is dict and set(row) == {'case', 'httpStatus', 'authReads', 'rpcCalls', 'dtoKeys',
             'tokenSha256', 'outputSha256', 'originalActorMatched', 'maskedOther', 'wire'}
             and row['case'] == name and type(row['httpStatus']) is int and row['httpStatus'] == status
             and type(row['authReads']) is int and row['authReads'] == auth
             and type(row['rpcCalls']) is int and row['rpcCalls'] == rpc and row['dtoKeys'] == dto
             and row['originalActorMatched'] is (name == 'own') and row['maskedOther'] is (name == 'public_other')
             and SHA.fullmatch(row['outputSha256']), 'READONLY_CASE_PROOF')
        token = None if name == 'missing' else forged if name == 'forged' else original
        need(row['tokenSha256'] == (None if token is None else sha(token.encode())), 'READONLY_ORIGINAL_TOKEN_CHANGED')
        wire = row['wire']; need(type(wire) is list and len(wire) == auth + rpc, 'READONLY_READ_TRANSPORT_PROOF')
        if auth:
            item = wire[0]
            need(set(item) == {'kind', 'tokenSha256', 'httpStatus', 'bodySha256'} and item['kind'] == 'auth'
                 and item['tokenSha256'] == sha(token.encode()) and type(item['httpStatus']) is int
                 and item['httpStatus'] in ((401, 403) if name == 'forged' else (200,))
                 and SHA.fullmatch(item['bodySha256']), 'READONLY_ACTUAL_AUTH_RESPONSE_REQUIRED')
        if rpc:
            item = wire[1]
            need(set(item) == {'kind', 'name', 'tokenSha256', 'httpStatus', 'bodySha256'} and item['kind'] == 'rpc'
                 and item['name'] == ('get_my_profile' if name == 'own' else 'get_public_profile')
                 and item['tokenSha256'] == sha(token.encode()) and type(item['httpStatus']) is int
                 and item['httpStatus'] == 200 and SHA.fullmatch(item['bodySha256']), 'READONLY_ACTUAL_RPC_RESPONSE_REQUIRED')
    return result


def verify_runtime_projection(expected, actual, binding, owned_networks):
    roles = {'db', 'auth', 'rest', 'gateway'}
    need(type(expected) is dict and type(actual) is dict and set(expected) == set(actual) == roles, 'READONLY_RUNTIME_ROLES')
    networks = {n['name']: n['id'] for n in owned_networks}
    need(len(networks) == len(owned_networks) == 1, 'READONLY_OWN_NETWORK_REQUIRED')
    for role in roles:
        item = expected[role]
        need(type(item) is dict and set(item) == {'id', 'startedAt', 'restartCount', 'networks'}
             and item['id'] == binding['containers'][role]['id'] and type(item['startedAt']) is str
             and item['startedAt'] not in ('', '0001-01-01T00:00:00Z')
             and type(item['restartCount']) is int and item['restartCount'] == 0
             and item['networks'] == networks and actual[role] == item, 'READONLY_RUNTIME_IDENTITY_CHANGED')


def verify_private_responses(fixture, result, reader, evidence):
    """원 Auth/RPC와 제품 응답 파일을 결과 SHA에 결합한다. reader는 고정 private reader다."""
    verify_result(fixture, result); refs = {}; counts = {'auth': 0, 'rpc': 0}
    js = lambda v: json.dumps(v, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
    def read(name):
        path = Path(evidence) / name; raw = reader(path)
        refs[name] = {'path': str(path), 'sha256': sha(raw)}
        return exact(raw)
    for row in result['cases']:
        rpc_body = None
        for item in row['wire']:
            kind = item['kind']; counts[kind] += 1
            raw = read('service-readonly-' + kind + '-' + str(counts[kind]) + '-private.json')
            need(type(raw) is dict and set(raw) == {'httpStatus', 'rawBody'}
                 and raw['httpStatus'] == item['httpStatus'] and type(raw['rawBody']) is str
                 and sha(raw['rawBody'].encode()) == item['bodySha256'], 'READONLY_RAW_RESPONSE_CHANGED')
            body = exact(raw['rawBody'])
            if kind == 'auth' and item['httpStatus'] == 200:
                need(body.get('id') == fixture['accounts'][0]['userId'] and body.get('role') == 'authenticated'
                     and body.get('is_anonymous') is not True, 'READONLY_RAW_AUTH_ACTOR_CHANGED')
            if kind == 'rpc': rpc_body = body
        product = read('service-readonly-' + row['case'] + '-private.json')
        need(type(product) is dict and set(product) == {'httpStatus', 'envelope'}
             and product['httpStatus'] == row['httpStatus'] and sha(js(product['envelope'])) == row['outputSha256'],
             'READONLY_RAW_PRODUCT_CHANGED')
        if rpc_body is not None: need(product['envelope'].get('data') == rpc_body, 'READONLY_RAW_RPC_PRODUCT_CHANGED')
    return refs


def verify_expired_responses(fixture, result, reader, evidence):
    """현재 실제 Auth 만료 거절과 제품 401의 원 응답을 결합한다. 시간/토큰을 고치지 않는다."""
    fields = {'status','scope','purpose','httpStatus','actualAuthHttpStatus','actualAuthReads','rpcCalls',
        'nativeExternalAttempts','providerCalls','modelCalls','reservationCalls','fixtureWrites',
        'originalTokenSha256','originalSessionSha256','activeReceiptSha256','iat','expiresAt','observedAt',
        'ttlSeconds','authBodySha256','outputSha256','actualNaver','rawContentLogged'}
    a=fixture['accounts'][0]
    need(type(result) is dict and set(result)==fields and result['status']=='PASS'
        and result['scope']==fixture['scope']==EXPIRED_SCOPE and result['purpose']==fixture['purpose']==EXPIRED
        and result['httpStatus']==401 and type(result['actualAuthHttpStatus']) is int
        and result['actualAuthHttpStatus'] in (401,403) and result['actualNaver']=='NOT_RUN'
        and result['rawContentLogged'] is False, 'EXPIRED_EXACT_PURPOSE_RESULT')
    for key,n in [('actualAuthReads',1),('rpcCalls',0),('nativeExternalAttempts',0),('providerCalls',0),
                  ('modelCalls',0),('reservationCalls',0),('fixtureWrites',0),('ttlSeconds',3600)]:
        need(type(result[key]) is int and result[key]==n,'EXPIRED_FORBIDDEN_EFFECT_OR_COUNT')
    claims=expired_metadata({'accounts':[a], 'jwtIssuer':fixture['origin']+'/auth/v1'},int(time.time()))
    need(result['originalTokenSha256']==sha(a['accessToken'].encode()) and result['originalSessionSha256']==sha(a['sessionId'].encode())
        and result['activeReceiptSha256']==fixture['activeReceiptSha256']
        and type(result['iat']) is int and type(result['expiresAt']) is int and type(result['observedAt']) is int
        and result['iat']==claims['iat'] and result['expiresAt']==claims['exp']
        and claims['exp']<=result['observedAt']<=int(time.time())
        and SHA.fullmatch(result['authBodySha256']) and SHA.fullmatch(result['outputSha256']), 'EXPIRED_ORIGINAL_RESULT_BINDING')
    refs={}
    def read(name):
        path=Path(evidence)/name;raw=reader(path);refs[name]={'path':str(path),'sha256':sha(raw)};return exact(raw)
    auth=read('service-expired-auth-private.json')
    need(type(auth) is dict and set(auth)=={'httpStatus','rawBody'} and auth['httpStatus']==result['actualAuthHttpStatus']
        and type(auth['rawBody']) is str and sha(auth['rawBody'].encode())==result['authBodySha256'],'EXPIRED_RAW_AUTH_CHANGED')
    body=exact(auth['rawBody'])
    need(type(body) is dict and body.get('error_code')=='bad_jwt' and type(body.get('msg')) is str
        and 'expired' in body['msg'].lower(),'EXPIRED_ACTUAL_AUTH_REASON_REQUIRED')
    product=read('service-expired-me-private.json')
    need(type(product) is dict and set(product)=={'httpStatus','envelope'} and product['httpStatus']==401
        and type(product['envelope']) is dict and set(product['envelope'])=={'error','requestId'}
        and product['envelope']['error'].get('code')=='AUTH_REQUIRED'
        and sha(json.dumps(product['envelope'],separators=(',',':'),ensure_ascii=False,allow_nan=False).encode())==result['outputSha256'],
        'EXPIRED_RAW_PRODUCT_CHANGED')
    return refs


def expired_metadata(binding, now_epoch):
    a=binding['accounts'][0];token=a['accessToken']
    need(type(token) is str and len(token)<=16384 and re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',token),
         'EXPIRED_ORIGINAL_TOKEN_SHAPE')
    try:
        part=token.split('.')[1];claims=exact(base64.urlsafe_b64decode(part+'='*((-len(part))%4)))
    except Exception: raise ValueError('EXPIRED_ORIGINAL_TOKEN_METADATA') from None
    need(type(claims) is dict and claims.get('sub')==a['userId'] and claims.get('session_id')==a['sessionId']
        and claims.get('iss')==binding['jwtIssuer'] and claims.get('role')=='authenticated' and claims.get('is_anonymous') is False
        and type(claims.get('iat')) is int and type(claims.get('exp')) is int and claims['exp']==a['expiresAt']
        and claims['exp']-claims['iat']==3600 and type(now_epoch) is int and now_epoch>=claims['exp'],
        'EXPIRED_ORIGINAL_CLOCK_OR_TOKEN_CHANGED')
    return claims


class ReviewedOriginalExpiredMe:
    """같은 원 active 검토와 고정 PASS 영수증만 받는 독립 목적. 새 source/session 선택은 없다."""
    def __init__(self, decision_id, active_review, active_receipt_ref):
        need(type(active_review) is ReviewedServiceProfileReadonly,'EXPIRED_TYPED_ACTIVE_REVIEW_REQUIRED')
        value=active_review.descriptor();path=Path(value['root'])/('service-profile-readonly-'+value['scopeId'])/'service-readonly-receipt.json'
        need(type(decision_id) is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}',decision_id),'EXPIRED_REVIEW_ID')
        need(type(active_receipt_ref) is dict and set(active_receipt_ref)=={'path','sha256'}
            and active_receipt_ref['path']==str(path) and type(active_receipt_ref['sha256']) is str
            and SHA.fullmatch(active_receipt_ref['sha256']),'EXPIRED_ACTIVE_RECEIPT_REF')
        self.active_review=active_review
        self._sealed=canonical({'scope':EXPIRED_SCOPE,'purpose':EXPIRED,'decisionId':decision_id,
            'activeReviewSha256':sha(active_review._sealed),'activeReceipt':active_receipt_ref})
    def descriptor(self):return exact(self._sealed)


def verify_auth6_receipt(receipt,binding_raw,path):
    need(receipt['status']=='PASS_LOCAL_AUTH6_PROVISION_ONLY' and type(receipt['accounts']) is int and receipt['accounts']==6
        and receipt['bindingSha256']==sha(binding_raw) and receipt['actualGoTrueAndDatabaseSessions'] is True
        and receipt['originalRowsPreserved'] is True and receipt['authAccountsRetained'] is True
        and receipt['actualNaver']=='NOT_RUN' and receipt['actualAI22AI23AI24']=='NOT_RUN'
        and receipt['creationReceiptRoot']==str(Path(path).parent),'READONLY_AUTH6_PROVENANCE')


def original_active_evidence(reviewed, reader, shared):
    """고정 SHA active PASS의 실제 원 입력·출력·178 bag 연결을 재검산한다. DB/HTTP 호출은 없다."""
    need(type(reviewed) is ReviewedOriginalExpiredMe,'EXPIRED_TYPED_REVIEW_REQUIRED')
    v=reviewed.active_review.descriptor();bound=reviewed.descriptor();root=Path(v['root'])
    need(sha(reviewed.active_review._sealed)==bound['activeReviewSha256'],'EXPIRED_ACTIVE_REVIEW_CHANGED')
    evidence=root/('service-profile-readonly-'+v['scopeId']);refs={}
    def read(path):
        path=Path(path);raw=reader(path);refs[str(path)]={'path':str(path),'sha256':sha(raw)};return raw
    active_raw=read(bound['activeReceipt']['path']);need(sha(active_raw)==bound['activeReceipt']['sha256'],'EXPIRED_ACTIVE_RECEIPT_CHANGED')
    active=exact(active_raw);binding_raw=read(root/'signed-ai-binding-private.json');binding=exact(binding_raw)
    receipt_raw=read(v['auth6Receipt']);receipt=exact(receipt_raw)
    need(sha(binding_raw)==v['bindingSha256'] and sha(receipt_raw)==v['auth6ReceiptSha256'],'EXPIRED_ORIGINAL_AUTH6_CHANGED')
    verify_auth6_receipt(receipt,binding_raw,v['auth6Receipt'])
    intent=exact(read(root/'service-profile-readonly-intent.json'))
    need(intent=={'scope':SCOPE,'sourceHead':v['sourceHead'],'reviewSha256':bound['activeReviewSha256'],
        'originalBindingSha256':sha(binding_raw),'originalAuth6ReceiptSha256':sha(receipt_raw),'noReplay':True},'EXPIRED_ORIGINAL_ACTIVE_INTENT_CHANGED')
    need(active['scope']==SCOPE and active['status']=='PASS' and active['fixedFailures']==[]
        and active['root']==str(root)==binding['preparedRoot'] and active['sourceHead']==v['sourceHead']
        and active['sourcePinsSha256']==sha(canonical(v['pins']))
        and active['originalBindingSha256']==v['bindingSha256'] and active['originalAuth6ReceiptSha256']==v['auth6ReceiptSha256']
        and active['runtimeIdentitySha256']==v['runtimeIdentity']['sha256']
        and active['database']['id']==binding['containers']['db']['id'] and active['standardSignedBindingValidated'] is True
        and active['ownedChildClosed'] is True and active['activationAllowed'] is False and active['automaticReplay'] is False
        and active['fixtureWrites']==active['modelCalls']==active['reservationCalls']==active['containersStopped']==0
        and active['actualNaver']=='NOT_RUN' and active['expiredOriginal']=='NOT_RUN_SAME_ORIGINAL_CONTEXT_REQUIRED',
        'EXPIRED_ORIGINAL_ACTIVE_PASS_REQUIRED')
    need(type(active['memorySamples']) is list and len(active['memorySamples'])>0
        and all(type(n) is int and n>=786432 for n in active['memorySamples']),'EXPIRED_ACTIVE_MEMORY_PROOF')
    need(all(type(active[k]) is int and active[k]==0 for k in ('fixtureWrites','modelCalls','reservationCalls','containersStopped')),
        'EXPIRED_ACTIVE_EFFECT_TYPE')
    runtime=read(v['runtimeIdentity']['path']);need(sha(runtime)==v['runtimeIdentity']['sha256'],'EXPIRED_ORIGINAL_RUNTIME_CHANGED')
    before_raw=read(evidence/'before-private.json');final_raw=read(evidence/'final-private.json')
    need(sha(before_raw)==active['beforeSnapshotSha256'] and sha(final_raw)==active['finalSnapshotSha256'],
        'EXPIRED_ACTIVE_SNAPSHOT_CHANGED')
    before,final=exact(before_raw),exact(final_raw);shared.unchanged_except(before,final,set())
    need(type(final['rows']) is dict and len(final['rows'])==178,'EXPIRED_ACTIVE_FULL178_REQUIRED')
    auth_sha=sha(canonical({k:b for k,b in final['rows'].items() if k.startswith('auth.')}))
    need(active['authRowsSha256']==active['banRevokeSha256']==auth_sha
        and active['banRevokeScope']=='FULL_AUTH_ROW_BAGS_INCLUDE_USER_BAN_AND_SESSION_ROWS','EXPIRED_ACTIVE_AUTH_SCOPE_CHANGED')
    fixture_path=evidence/'service-readonly-factory-private.json';fixture_raw=read(fixture_path);fixture=exact(fixture_raw)
    need(active['factoryInput']=={'path':str(fixture_path),'sha256':sha(fixture_raw)},'EXPIRED_ACTIVE_FACTORY_INPUT_SHA_CHANGED')
    need(fixture['scope']==SCOPE and fixture['scopeId']==v['scopeId'] and fixture['signedLocalAuth'] is True
        and fixture['accounts']==binding['accounts'] and fixture['origin']==binding['origin']
        and fixture['anon']==binding['credentials']['anon'] and fixture['service']==binding['credentials']['service']
        and fixture['evidence']==str(evidence) and fixture['codeRoot']==v['capsuleRoot']
        and fixture['productManifest']==service_graph(ROOT),'EXPIRED_ACTIVE_FACTORY_INPUT_CHANGED')
    proof_ref=active['actualPhaseReceipt'];proof_raw=read(evidence/'service-readonly-factory-proof.json')
    need(proof_ref=={'path':str(evidence/'service-readonly-factory-proof.json'),'sha256':sha(proof_raw)},'EXPIRED_ACTIVE_FACTORY_REF_CHANGED')
    proof=verify_result(fixture,exact(proof_raw));raw_refs=verify_private_responses(fixture,proof,read,evidence)
    need(active['privateResponses']==raw_refs and exact(read(evidence/'service-readonly-private-links.json'))==raw_refs,
        'EXPIRED_ACTIVE_RAW_LINKS_CHANGED')
    out=read(evidence/'positive-factory-stdout-private.json');err=read(evidence/'positive-factory-stderr-private.json')
    outcome=exact(read(evidence/'positive-factory-outcome.json'))
    need(exact(out)==proof and outcome['exitCode']==0 and outcome['privateRawOutputPreserved'] is True and outcome['streamFailures']==[]
        and type(outcome['stdoutBytes']) is int and outcome['stdoutBytes']==len(out)
        and type(outcome['stderrBytes']) is int and outcome['stderrBytes']==len(err)
        and outcome['stdoutSha256']==sha(out) and outcome['stderrSha256']==sha(err),'EXPIRED_ACTIVE_RAW_STREAM_CHANGED')
    need(exact(read(evidence/'positive-child-closed.json'))=={'exited':True,'exitCode':0,'exactOwnedSessionOnly':True},
        'EXPIRED_ACTIVE_CHILD_NOT_CLOSED')
    command_names=('positive-factory-stdout-private.json','positive-factory-stderr-private.json','positive-factory-outcome.json','positive-child-closed.json')
    need(active['commandProofs']=={name:refs[str(evidence/name)] for name in command_names},'EXPIRED_ACTIVE_COMMAND_REFS_CHANGED')
    return active,binding,binding_raw,fixture,canonical(final),refs


def prepare_original_expired_me(active_receipt, original_binding_raw, current_binding_raw, claims, current,
                                *, now_epoch):
    """만료 목적의 준비 검증만 한다. 표준 active 검사나 실제 Auth 거절을 대체하지 않는다."""
    need(type(active_receipt) is dict and active_receipt.get('scope') == SCOPE
         and active_receipt.get('status') == 'PASS' and active_receipt.get('standardSignedBindingValidated') is True,
         'EXPIRED_ORIGINAL_ACTIVE_RECEIPT_REQUIRED')
    need(all(type(active_receipt.get(k)) is str and SHA.fullmatch(active_receipt[k]) for k in
        ('originalBindingSha256', 'originalAuth6ReceiptSha256', 'runtimeIdentitySha256',
         'sourcePinsSha256', 'authRowsSha256', 'banRevokeSha256')) and
         type(active_receipt.get('sourceHead')) is str and re.fullmatch('[a-f0-9]{40}', active_receipt['sourceHead']),
         'EXPIRED_ORIGINAL_HASH_PROVENANCE_REQUIRED')
    need(type(original_binding_raw) is bytes and type(current_binding_raw) is bytes
         and original_binding_raw == current_binding_raw
         and active_receipt['originalBindingSha256'] == sha(original_binding_raw), 'EXPIRED_ORIGINAL_BINDING_CHANGED')
    original_binding = exact(original_binding_raw)
    a = original_binding['accounts'][0]
    token = a['accessToken']
    need(type(token) is str and len(token) <= 16384 and re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token),
         'EXPIRED_ORIGINAL_TOKEN_SHAPE')
    try:
        part = token.split('.')[1]
        decoded = exact(base64.urlsafe_b64decode(part + '=' * ((-len(part)) % 4)))
    except Exception: raise ValueError('EXPIRED_ORIGINAL_TOKEN_METADATA') from None
    need(type(decoded) is dict and decoded == claims, 'EXPIRED_ORIGINAL_TOKEN_METADATA_CHANGED')
    need(type(claims) is dict and claims.get('sub') == a['userId'] and claims.get('session_id') == a['sessionId']
         and claims.get('iss') == original_binding['jwtIssuer'] and type(claims.get('iat')) is int
         and claims.get('role') == 'authenticated' and claims.get('is_anonymous') is False
         and type(claims.get('exp')) is int and claims['exp'] == a['expiresAt']
         and claims['exp'] - claims['iat'] == 3600 and type(now_epoch) is int and now_epoch >= claims['exp'],
         'EXPIRED_ORIGINAL_CLOCK_OR_TOKEN_CHANGED')
    need(type(current) is dict and set(current) == {'root', 'sourceId', 'sourceHead', 'sourcePinsSha256', 'runtimeIdentitySha256',
        'auth6ReceiptSha256', 'tokenSha256', 'baselineAuthRowsSha256', 'currentAuthRowsSha256',
        'baselineBanRevokeSha256', 'currentBanRevokeSha256', 'rowsUnchanged'}
        and current['root'] == active_receipt['root'] == original_binding['preparedRoot']
        and current['sourceId'] == active_receipt['database']['id'] == original_binding['containers']['db']['id']
        and type(current['sourceId']) is str and SHA.fullmatch(current['sourceId'])
        and current['sourceHead'] == active_receipt['sourceHead']
        and current['sourcePinsSha256'] == active_receipt['sourcePinsSha256']
        and current['runtimeIdentitySha256'] == active_receipt['runtimeIdentitySha256']
        and current['auth6ReceiptSha256'] == active_receipt['originalAuth6ReceiptSha256']
        and current['tokenSha256'] == sha(a['accessToken'].encode())
        and current['baselineAuthRowsSha256'] == current['currentAuthRowsSha256'] == active_receipt['authRowsSha256']
        and current['baselineBanRevokeSha256'] == current['currentBanRevokeSha256'] == active_receipt['banRevokeSha256']
        and current['rowsUnchanged'] is True, 'EXPIRED_SAME_ORIGINAL_CONTEXT_REQUIRED')
    return {'purpose': EXPIRED, 'status': 'PREPARATION_CONSISTENT_ONLY', 'actualAuth': 'NOT_RUN',
        'actualProduct401': 'NOT_RUN', 'dispatchAllowed': False,
        'remaining': 'SEPARATE_TYPED_EXPIRED_DISPATCH_REVIEW_REQUIRED', 'ttlChanged': False, 'clockChanged': False}


class PrivateArtifacts:
    """검토된 목적별 private writer만 재사용한다. 실행 객체를 우회 조립하지 않는다."""
    def __init__(self, ai, private): self.ai, self.module = ai, private
    def private(self, path): return self.module.secure_private_bytes(Path(path), self.ai)
    def save_bytes(self, root, name, raw): return self.module.FixedPair.save_bytes(self, root, name, raw)


def monitored_read_ports(ai, reviewed, owner):
    """표준 ports의 고정 읽기만 사용하고 각 SQL 앞뒤에 이 실행의 중단 조건을 검사한다."""
    class OwnerReadonlyPorts(ai.FixedLifecycleProvisioningPorts):
        def __init__(self):
            super().__init__(reviewed)
            self.root = reviewed.prepared_root; self.binding = owner.binding
        def read_sql(self, query, timeout=3):
            owner.active(); value = super().read_sql(query, timeout); owner.active(); return value
        def sql(self, query): return self.read_sql(query)
        def history(self): return ai.signed_verify_history(self)
    return OwnerReadonlyPorts()


class ServiceProfileReadonlyRun:
    PHASE_SCOPE=SCOPE
    FACTORY_MODE='--signed-service-profile-readonly'
    EXPECTED_RESPONSES=9
    STANDARD_ACTIVE=True
    RECEIPT_NAME='service-readonly-receipt.json'
    def __init__(self, reviewed):
        need(type(reviewed) is ReviewedServiceProfileReadonly, 'READONLY_TYPED_REVIEW_REQUIRED')
        self.reviewed = reviewed; self.value = reviewed.descriptor(); self.root = Path(self.value['root'])
        need(source_pins(self.value['sourceHead'])[1] == self.value['pins'], 'READONLY_SOURCE_CHANGED')
        pins = self.value['pins']; sys.path.insert(0, str(ROOT / 'tools/local'))
        self.shared = load(POSITIVE, pins[POSITIVE])
        self.ai = load('tests/integration/jonghyun/isolated_ai_contracts.py', pins['tests/integration/jonghyun/isolated_ai_contracts.py'])
        self.private_module = load('tools/local/prepare_auth_negative.py', pins['tools/local/prepare_auth_negative.py'])
        self.writer = PrivateArtifacts(self.ai, self.private_module)
        self.ai.private_temp_root(self.root)
        self.deadline = time.monotonic() + 300; self.done = threading.Event(); self.thread = None
        self.failures = []; self.samples = []; self.child = None; self.capture_threads = []; self.capture_failures = []
        self.r = None; self.port = None; self.before = None; self.fixture = None
        self.factory_proof = None; self.private_response_refs = None; self.factory_input = None; self.command_proofs=None
        self.evidence_owned = False
        self.evidence = self.root / ('service-profile-readonly-' + self.value['scopeId'])

    def read(self, path): return self.writer.private(path)
    def save(self, name, value):
        need(self.evidence_owned, 'READONLY_OWN_EVIDENCE_REQUIRED')
        return self.writer.save_bytes(self.evidence, name, canonical(value))
    def live(self):
        self.active()
        self.fixed_identity()
    def active(self):
        need(not self.failures and not self.done.is_set() and time.monotonic() < self.deadline, 'READONLY_LIVE_GUARD')
    def fixed_identity(self):
        need(source_pins(self.value['sourceHead'])[1] == self.value['pins'], 'READONLY_SOURCE_CHANGED')
        if self.r is None: return
        need(self.r.call(['info', '--format', '{{.ID}}']) == self.value['daemonId'], 'READONLY_DAEMON_CHANGED')
        self.r.signed_identity()
        actual = {}
        for role, container in self.binding['containers'].items():
            x = exact(self.r.call(['inspect', container['id']]))[0]
            need(x['State']['Restarting'] is False, 'READONLY_RUNTIME_RESTARTING')
            actual[role] = {'id': x['Id'], 'startedAt': x['State']['StartedAt'], 'restartCount': x['RestartCount'],
                'networks': {k: v['NetworkID'] for k, v in x['NetworkSettings']['Networks'].items()}}
        verify_runtime_projection(self.runtime_identity, actual, self.binding, self.owned_networks)
    def memory(self, start=False):
        began = time.monotonic(); n = self.port.memory_kib()
        need(time.monotonic() - began <= 3 and type(n) is int and n >= (1048576 if start else 786432), 'READONLY_MEMORY_GUARD')
        self.samples.append(n)
    def monitor(self):
        while not self.done.is_set():
            began = time.monotonic()
            try: self.memory()
            except BaseException: self.failures.append('READONLY_MEMORY_GUARD'); return
            self.done.wait(max(0, began + 3 - time.monotonic()))
    def bind(self):
        binding_raw = self.read(self.root / 'signed-ai-binding-private.json'); receipt_raw = self.read(self.value['auth6Receipt'])
        need(sha(binding_raw) == self.value['bindingSha256'] and sha(receipt_raw) == self.value['auth6ReceiptSha256'], 'READONLY_ORIGINAL_PACKETS_CHANGED')
        binding, receipt = exact(binding_raw), exact(receipt_raw)
        verify_auth6_receipt(receipt,binding_raw,self.value['auth6Receipt'])
        target = self.ai.signed_prepared_target(self.root)
        need(len(target['versions']) == 121, 'READONLY_CURRENT121_REQUIRED')
        self.ai.validate_signed_binding(binding, self.root, target)
        self.bind_ports(binding,binding_raw,target)
        need(not self.evidence.exists() and not self.evidence.is_symlink(), 'READONLY_EVIDENCE_NO_REPLAY')
        self.evidence.mkdir(mode=0o700); self.evidence_owned = True
        self.writer.save_bytes(self.root, 'service-profile-readonly-intent.json', canonical({'scope': SCOPE,
            'sourceHead': self.value['sourceHead'], 'reviewSha256': sha(self.reviewed._sealed),
            'originalBindingSha256': sha(binding_raw), 'originalAuth6ReceiptSha256': sha(receipt_raw), 'noReplay': True}))
        self.closed_controls()
        return target
    def bind_ports(self,binding,binding_raw,target):
        self.binding = binding; self.binding_raw = binding_raw; self.target = target
        self.r = self.ai.SignedRunner(self.root, binding)
        reviewed = self.ai.ReviewedSignedProvisioning(self.value['decisionId'], self.root, binding['sourcePins'],
            binding['containers'], binding['credentials'], int(time.time()) + 300)
        self.ai.provisioning_metadata(reviewed, target, binding['origin'])
        self.port = monitored_read_ports(self.ai, reviewed, self)
        self.owned_networks = exact(self.read(self.root / 'owned-networks.json'))
        runtime_ref = self.value['runtimeIdentity']; raw = self.read(runtime_ref['path'])
        need(sha(raw) == runtime_ref['sha256'], 'READONLY_RUNTIME_PACKET_CHANGED'); self.runtime_identity = exact(raw)
        self.live(); self.memory(start=True)
        need(self.port.settings() == {'jwtExpirySeconds': 3600, 'anonymousEnabled': False, 'signupDisabled': True},
             'READONLY_AUTH_SETTINGS')
    def closed_controls(self):
        need(self.port.closed_controls() == {**{k: False for k in self.ai.PROVISION_CLOSED_CONTROLS}, 'cronLaunchActiveJobs': 'off'},
             'READONLY_CLOSED_CONTROLS')
    def snapshot(self):
        self.fixed_identity()
        need(self.port.history() == {'method': 'SUPABASE_DB_HISTORY', 'native': 'NOT_RUN'}, 'READONLY_HISTORY_CHANGED')
        value = self.ai.lcp_snapshot(self.port.snapshot()); need(len(value['rows']) == 178, 'READONLY_FULL178_REQUIRED')
        self.fixed_identity(); return value
    def prepare_fixture(self):
        self.before = self.snapshot(); self.save('before-private.json', self.before)
        users = self.binding['accounts']; q = self.ai.quote
        ids = ','.join(q(a['userId']) + '::uuid' for a in users[:2])
        query = "select jsonb_agg(jsonb_build_object('userId',p.id,'realName',p.real_name,'avatarUrl',p.avatar_url,'bio',p.bio,'sweetness',private.current_member_sweetness(p.id),'displayName',public.mask_real_name(p.real_name),'age',public.korean_age(p.birth_date),'gender',p.gender,'avatarPath',p.avatar_url,'interests',coalesce(to_jsonb(t.interests),'[]'::jsonb),'conversationStyles',coalesce(to_jsonb(t.conversation_styles),'[]'::jsonb),'mbti',t.mbti,'completedCount',private.completed_appointment_count(p.id))order by p.id)from public.profiles p left join private.profile_traits t on t.profile_id=p.id where p.id in(" + ids + ');'
        profiles = exact(self.port.read_sql(query)); need(type(profiles) is list and len(profiles) == 2, 'READONLY_ORIGINAL_PROFILES_REQUIRED')
        profiles = [next(p for p in profiles if p['userId'] == a['userId']) for a in users[:2]]
        need(all(p['sweetness'] == 15 and p['completedCount'] == 0 for p in profiles), 'READONLY_INITIAL_PROFILE_REQUIRED')
        # 실제 원 Auth6 profile만 읽는다. Naver·사진 fixture 추가와 AI prepare/clean은 호출하지 않는다.
        self.fixture = {'scope': SCOPE, 'scopeId': self.value['scopeId'], 'signedLocalAuth': True,
            'codeRoot': self.value['capsuleRoot'], 'origin': self.binding['origin'],
            'anon': self.binding['credentials']['anon'], 'service': self.binding['credentials']['service'],
            'accounts': users, 'expectedProfiles': profiles, 'evidence': str(self.evidence),
            'productManifest': service_graph(ROOT)}
    def capsule(self):
        pins = {**service_graph(ROOT), FACTORY: self.value['pins'][FACTORY]}
        self.ai.sealed_runtime_capsule(self.value['sourceHead'], Path(self.value['capsuleRoot']), pins, pins)
        self.private_module.FixedPair.binary(self.writer, self.value['nodePath'], self.value['nodeSha256'], 'node')
    def dispatch_binding(self):
        raw = self.read(self.root / 'signed-ai-binding-private.json')
        need(raw == self.binding_raw and sha(raw) == self.value['bindingSha256'], 'READONLY_DISPATCH_BINDING_CHANGED')
        self.ai.validate_signed_binding(self.binding, self.root, self.target)
        need(self.binding['accounts'][0]['expiresAt'] > time.time() + 300, 'READONLY_DISPATCH_EXPIRY')
    def capture(self, *args): return self.shared.PositiveRun.capture(self, *args)
    def finish_capture(self):
        out, err = self.shared.PositiveRun.finish_capture(self)
        proof = exact(self.read(self.evidence / 'positive-factory-outcome.json'))
        need(proof['privateRawOutputPreserved'] is True and proof['streamFailures'] == []
             and type(proof['stdoutBytes']) is int and proof['stdoutBytes'] == len(out)
             and type(proof['stderrBytes']) is int and proof['stderrBytes'] == len(err)
             and proof['stdoutSha256'] == sha(out) and proof['stderrSha256'] == sha(err), 'READONLY_RAW_STREAM_PROOF_CHANGED')
        return out, err
    def close_child(self): return self.shared.PositiveRun.close_child(self)
    def factory_output(self,result):
        result=verify_result(self.fixture,result)
        self.private_response_refs=verify_private_responses(self.fixture,result,self.read,self.evidence)
        return result
    def durable_command_proofs(self):
        refs={};raw={}
        for name in ('positive-factory-stdout-private.json','positive-factory-stderr-private.json','positive-factory-outcome.json','positive-child-closed.json'):
            path=self.evidence/name;raw[name]=self.read(path);refs[name]={'path':str(path),'sha256':sha(raw[name])}
        out,err=raw['positive-factory-stdout-private.json'],raw['positive-factory-stderr-private.json']
        proof=exact(raw['positive-factory-outcome.json'])
        need(type(proof['exitCode']) is int and proof['exitCode']==0 and proof['privateRawOutputPreserved'] is True and proof['streamFailures']==[]
            and type(proof['stdoutBytes']) is int and proof['stdoutBytes']==len(out)
            and type(proof['stderrBytes']) is int and proof['stderrBytes']==len(err)
            and proof['stdoutSha256']==sha(out) and proof['stderrSha256']==sha(err)
            and exact(out)==exact(self.read(self.factory_proof['path'])),'READONLY_FINAL_COMMAND_PROOF_CHANGED')
        need(exact(raw['positive-child-closed.json'])=={'exited':True,'exitCode':0,'exactOwnedSessionOnly':True},'READONLY_FINAL_CHILD_PROOF_CHANGED')
        self.command_proofs=refs
    def final_provenance(self):pass
    def receipt_extra(self,result,errors):return {}
    def invoke(self):
        self.capsule(); self.live(); self.memory(start=True)
        input_sha=self.save('service-readonly-factory-private.json', self.fixture)
        self.factory_input={'path':str(self.evidence/'service-readonly-factory-private.json'),'sha256':input_sha}
        self.save('service-readonly-dispatch-intent.json', {'scope': self.PHASE_SCOPE, 'singleAttempt': True, 'noReplay': True})
        self.dispatch_binding(); self.active()
        self.child = subprocess.Popen([self.value['nodePath'], '--experimental-strip-types',
            str(Path(self.value['capsuleRoot']) / FACTORY), str(self.evidence / 'service-readonly-factory-private.json'),
            self.FACTORY_MODE], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, env=self.ai.midnight_minimal_env(self.evidence))
        # 기존 검토된 bounded raw capture/child-group 종료를 그대로 재사용한다.
        self.capture(self.child.stdout, 'positive-factory-stdout-private.json', 1048576)
        self.capture(self.child.stderr, 'positive-factory-stderr-private.json', 65536)
        while self.child.poll() is None:
            need(not self.failures and not self.capture_failures and time.monotonic() < self.deadline, 'READONLY_CHILD_GUARD')
            self.done.wait(.1)
        out, _ = self.finish_capture()
        need(self.child.returncode == 0 and not self.failures and not self.capture_failures, 'READONLY_FACTORY_FAILED')
        result = self.factory_output(exact(out))
        self.save('service-readonly-private-links.json', self.private_response_refs)
        digest = self.save('service-readonly-factory-proof.json', result)
        self.factory_proof = {'path': str(self.evidence / 'service-readonly-factory-proof.json'), 'sha256': digest}
        self.capsule(); self.live(); return result


class OriginalExpiredMeRun(ServiceProfileReadonlyRun):
    PHASE_SCOPE=EXPIRED_SCOPE
    FACTORY_MODE='--signed-service-profile-original-expired'
    EXPECTED_RESPONSES=2
    STANDARD_ACTIVE=False
    RECEIPT_NAME='service-expired-receipt.json'
    def __init__(self,reviewed):
        need(type(reviewed) is ReviewedOriginalExpiredMe,'EXPIRED_TYPED_REVIEW_REQUIRED')
        need(sha(reviewed.active_review._sealed)==reviewed.descriptor()['activeReviewSha256'],'EXPIRED_ACTIVE_REVIEW_CHANGED')
        super().__init__(reviewed.active_review)
        self.expired_review=reviewed;self.active_refs={};self.active_receipt=None
        self.evidence=self.root/('service-profile-original-expired-'+self.value['scopeId'])
    def bind(self):
        active,binding,raw,fixture,final,refs=original_active_evidence(self.expired_review,self.read,self.shared)
        expired_metadata(binding,int(time.time()))
        need(sha(self.read(self.root/'database-manifest.json'))==binding['databaseManifestSha256'],'EXPIRED_SOURCE_MANIFEST_CHANGED')
        target=self.ai.signed_prepared_target(self.root);need(len(target['versions'])==121,'READONLY_CURRENT121_REQUIRED')
        need(active['database']=={'id':target['id'],'project':target['project']},'EXPIRED_ORIGINAL_DATABASE_CHANGED')
        self.active_receipt=active;self.active_fixture=fixture;self.active_final=final;self.active_refs=refs
        self.bind_ports(binding,raw,target)
        need(not self.evidence.exists() and not self.evidence.is_symlink(),'EXPIRED_EVIDENCE_NO_REPLAY')
        self.evidence.mkdir(mode=0o700);self.evidence_owned=True
        self.writer.save_bytes(self.root,'service-profile-original-expired-intent.json',canonical({
            'scope':EXPIRED_SCOPE,'purpose':EXPIRED,'sourceHead':self.value['sourceHead'],
            'reviewSha256':sha(self.expired_review._sealed),'originalBindingSha256':sha(raw),
            'activeReceipt':self.expired_review.descriptor()['activeReceipt'],'singleAttempt':True,'noReplay':True}))
        self.save('original-active-inputs.json',self.active_refs)
        self.closed_controls()
        return target
    def final_provenance(self):
        for ref in self.active_refs.values():
            need(sha(self.read(ref['path']))==ref['sha256'],'EXPIRED_ACTIVE_INPUT_CHANGED')
    def prepare_fixture(self):
        self.before=self.snapshot();self.save('before-private.json',self.before)
        need(canonical(self.before)==self.active_final,'EXPIRED_CURRENT_FULL178_CHANGED')
        claims=expired_metadata(self.binding,int(time.time()));auth_sha=sha(canonical({k:b for k,b in self.before['rows'].items() if k.startswith('auth.')}))
        current={'root':str(self.root),'sourceId':self.target['id'],'sourceHead':self.value['sourceHead'],
            'sourcePinsSha256':sha(canonical(self.value['pins'])),'runtimeIdentitySha256':self.value['runtimeIdentity']['sha256'],
            'auth6ReceiptSha256':self.value['auth6ReceiptSha256'],'tokenSha256':sha(self.binding['accounts'][0]['accessToken'].encode()),
            'baselineAuthRowsSha256':self.active_receipt['authRowsSha256'],'currentAuthRowsSha256':auth_sha,
            'baselineBanRevokeSha256':self.active_receipt['banRevokeSha256'],'currentBanRevokeSha256':auth_sha,'rowsUnchanged':True}
        preparation=prepare_original_expired_me(self.active_receipt,self.binding_raw,self.read(self.root/'signed-ai-binding-private.json'),claims,current,now_epoch=int(time.time()))
        self.save('original-expired-preparation.json',preparation)
        self.fixture={**self.active_fixture,'scope':EXPIRED_SCOPE,'purpose':EXPIRED,'evidence':str(self.evidence),
            'activeReceiptSha256':self.expired_review.descriptor()['activeReceipt']['sha256']}
    def dispatch_binding(self):
        need(self.read(self.root/'signed-ai-binding-private.json')==self.binding_raw,'EXPIRED_DISPATCH_BINDING_CHANGED')
        self.final_provenance();expired_metadata(self.binding,int(time.time()))
    def factory_output(self,result):
        self.private_response_refs=verify_expired_responses(self.fixture,result,self.read,self.evidence)
        return result
    def receipt_extra(self,result,errors):
        return {'purpose':EXPIRED,'originalActiveReceipt':self.expired_review.descriptor()['activeReceipt'],
            'originalActiveInputs':self.active_refs,'historicalStandardActiveValidated':self.active_receipt is not None,
            'expiredOriginal':'PASS_ORIGINAL_AUTH_EXPIRED_READONLY' if result is not None and not errors else 'NOT_PROVEN',
            'naturalTtlSeconds':3600,'ttlChanged':False,'clockChanged':False}


def execute_reviewed(reviewed):
    need(type(reviewed) is ReviewedServiceProfileReadonly, 'READONLY_TYPED_REVIEW_REQUIRED')
    return execute_run(ServiceProfileReadonlyRun(reviewed))


def execute_run(run):
    need(type(run) in (ServiceProfileReadonlyRun,OriginalExpiredMeRun),'READONLY_FIXED_RUN_REQUIRED')
    errors = []; result = None; target = None; final = None
    try:
        target = run.bind(); run.thread = threading.Thread(target=run.monitor, daemon=True); run.thread.start()
        run.prepare_fixture(); result = run.invoke(); run.close_child()
    except BaseException: errors.append('READONLY_EXECUTION_FAILED_NO_REPLAY')
    finally:
        try: run.close_child()
        except BaseException: errors.append('READONLY_CHILD_NOT_CLOSED')
        try:
            need(run.child is None, 'READONLY_FINAL_CAPTURE_CHILD_NOT_CLOSED')
            if run.before is not None:
                final = run.snapshot(); run.save('final-private.json', final)
                run.shared.unchanged_except(run.before, final, set())
                for ref in (run.private_response_refs or {}).values():
                    need(sha(run.read(ref['path'])) == ref['sha256'], 'READONLY_FINAL_RAW_RESPONSE_CHANGED')
                if run.factory_proof:
                    need(sha(run.read(run.factory_proof['path'])) == run.factory_proof['sha256'], 'READONLY_FINAL_FACTORY_PROOF_CHANGED')
                if result is not None:
                    need(type(run.factory_proof) is dict and type(run.private_response_refs) is dict
                         and len(run.private_response_refs) == run.EXPECTED_RESPONSES and type(run.factory_input) is dict,
                         'READONLY_DURABLE_PHASE_PROOF_REQUIRED')
                    need(sha(run.read(run.factory_input['path']))==run.factory_input['sha256'],'READONLY_FINAL_FACTORY_INPUT_CHANGED')
                    run.durable_command_proofs()
                run.final_provenance()
            else: errors.append('READONLY_BASELINE_NOT_CAPTURED')
        except BaseException: errors.append('READONLY_FINAL_PRESERVATION_NOT_PROVEN')
        run.done.set()
        if run.thread is not None:
            run.thread.join(timeout=3)
            if run.thread.is_alive(): errors.append('READONLY_MONITOR_NOT_CLOSED')
        if run.failures: errors.append('READONLY_MEMORY_FAILURE')
        if run.evidence_owned:
            receipt = {'scope': run.PHASE_SCOPE, 'status': 'PASS' if result is not None and not errors else 'FAIL',
                'root': str(run.root), 'sourceHead': run.value['sourceHead'], 'sourcePinsSha256': sha(canonical(run.value['pins'])),
                'database': None if target is None else {'id': target['id'], 'project': target['project']},
                'originalBindingSha256': run.value['bindingSha256'], 'originalAuth6ReceiptSha256': run.value['auth6ReceiptSha256'],
                'actualPhaseReceipt': run.factory_proof, 'privateResponses': run.private_response_refs,'factoryInput':run.factory_input,
                'commandProofs':run.command_proofs,
                'runtimeIdentitySha256': run.value['runtimeIdentity']['sha256'], 'standardSignedBindingValidated': run.STANDARD_ACTIVE and target is not None,
                'beforeSnapshotSha256': None if run.before is None else sha(canonical(run.before)),
                'finalSnapshotSha256': None if final is None else sha(canonical(final)),
                'authRowsSha256': None if final is None else sha(canonical({k:v for k,v in final['rows'].items() if k.startswith('auth.')})),
                'banRevokeSha256': None if final is None else sha(canonical({k:v for k,v in final['rows'].items() if k.startswith('auth.')})),
                'banRevokeScope': 'FULL_AUTH_ROW_BAGS_INCLUDE_USER_BAN_AND_SESSION_ROWS',
                'ownedChildClosed': run.child is None, 'fixedFailures': errors, 'memorySamples': run.samples,
                'fixtureWrites': 0, 'modelCalls': 0, 'reservationCalls': 0, 'containersStopped': 0,
                'actualNaver': 'NOT_RUN', 'expiredOriginal': 'NOT_RUN_SAME_ORIGINAL_CONTEXT_REQUIRED',
                'activationAllowed': False, 'automaticReplay': False}
            receipt.update(run.receipt_extra(result,errors))
            run.save(run.RECEIPT_NAME, receipt)
    need(not errors and result is not None, 'READONLY_FAILED_CLOSED_PRIVATE_EVIDENCE_PRESERVED')
    return receipt


def run_reviewed(reviewed):
    need(type(reviewed) is ReviewedServiceProfileReadonly, 'READONLY_TYPED_REVIEW_REQUIRED')
    previous = signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(RuntimeError('READONLY_INTERRUPTED')))
    try: return execute_reviewed(reviewed)
    finally: signal.signal(signal.SIGTERM, previous)


def run_original_expired_me(reviewed):
    need(type(reviewed) is ReviewedOriginalExpiredMe,'EXPIRED_TYPED_REVIEW_REQUIRED')
    previous=signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(RuntimeError('READONLY_INTERRUPTED')))
    try:return execute_run(OriginalExpiredMeRun(reviewed))
    finally:signal.signal(signal.SIGTERM,previous)


if __name__ == '__main__':
    print(json.dumps({'scope': SCOPE, 'status': 'NOT_RUN', 'actualHTTP': 0, 'actualSQL': 0,
        'expiredOriginal': 'NOT_RUN_REVIEWED_ORIGINAL_EXPIRED_ME_REQUIRED', 'activationAllowed': False}))
