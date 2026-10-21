"""D03 fresh Auth6 전용 실제 포트. import/CLI는 NOT_RUN, root typed 검토로만 호출한다.

현재 사용 중인 Auth source를 재사용하지 않는다. 새로운 root·원 발급 영수증·현재
manifest·사진 원본 SHA를 root가 검토해야 한다. 실제 Naver/Storage API는 검증하지 않는다.
"""
import base64
import datetime
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import stat
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[3]
SELF = 'tests/integration/minkyu/deadline_lock_runtime.py'
EXECUTOR = 'tests/integration/minkyu/deadline_lock_executor.py'
READONLY = 'tests/integration/minkyu/service_profile_readonly_local.py'
READONLY_TRANSPORT = 'tests/integration/minkyu/deadline_readonly_transport.py'
PRIVATE_ANCHOR_HELPER = 'tools/local/collect_d03_timeout_batch.py'
OWN_SOURCES = (SELF, EXECUTOR, READONLY, READONLY_TRANSPORT, PRIVATE_ANCHOR_HELPER)


def need(value, code):
    if not value: raise ValueError(code)


def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
def sha(raw): return hashlib.sha256(raw).hexdigest()


def photo_source_path(path, root):
    """합성 사진 이름·직계 경로만 검사한다. private 읽기 검사는 기존 reader가 유지한다."""
    need(path.parent == root and re.fullmatch(r'd03-photo-[a-f0-9]{32}[.]jpg', path.name),
         'D03_PHOTO_SOURCE_PATH')
    return path


def load(relative, digest):
    path = ROOT / relative; raw = path.read_bytes()
    need(path.resolve() == path and not path.is_symlink() and sha(raw) == digest, 'D03_MODULE_CHANGED')
    name = 'd03_runtime_' + path.stem
    spec = importlib.util.spec_from_loader(name, loader=None)
    module = importlib.util.module_from_spec(spec); module.__file__ = str(path)
    previous = sys.modules.get(name); sys.modules[name] = module
    try: exec(compile(raw, str(path), 'exec'), module.__dict__)
    finally:
        if previous is None: sys.modules.pop(name, None)
        else: sys.modules[name] = previous
    return module


@dataclass(frozen=True)
class ReviewedDeadlineAuthority:
    """root만 조립하는 불변 bytes. 새 source 증거가 없으면 생성해도 실행은 거절된다."""
    service_descriptor_bytes: bytes
    execution_descriptor_bytes: bytes
    owned_source_pins_bytes: bytes
    qualification_path: str
    qualification_sha: str
    qualification_receipt_path: str
    qualification_receipt_sha: str
    qualification_review_bytes: bytes
    rpc_review_bytes: bytes
    d03_alias_review_bytes: bytes
    fast_phase_review_bytes: bytes


def reviewed_rpc(value):
    need(type(value)is dict and set(value)=={'query','querySha256'} and type(value['query'])is str
         and 0<len(value['query'])<=65536 and sha(value['query'].encode())==value['querySha256']
         and len(re.findall(r'(?<![a-z_])"?submit_appointment_review"?\s*\(',value['query']))==1,
         'D03_ROOT_REVIEWED_RPC_FINGERPRINT')
    return value


def runtime_alias_policy(ai,root_review,receipt,root,accounts):
    # 권한 원천은 root literal이다. 영수증은 일치 여부만 확인하고 typed로 승격하지 않는다.
    need(type(root_review)is dict and set(root_review)=={'decisionId','preparedRoot','aliases','descriptorSha256'},'D03_ROOT_ALIAS_REVIEW')
    descriptor={k:root_review[k]for k in ('decisionId','preparedRoot','aliases')}
    need(root_review['preparedRoot']==str(root) and sha(canonical(descriptor))==root_review['descriptorSha256']
         and receipt.get('d03EmailAliasPolicy')==descriptor
         and receipt.get('qualification')=='NOT_RUN_SYNTHETIC_EMAIL_ALIAS_ONLY'
         and [a['authEmail']for a in accounts]==root_review['aliases'],'D03_ROOT_ALIAS_RECEIPT_MISMATCH')
    need(hasattr(ai,'ReviewedD03AuthEmailAliases'),'D03_KERNEL_ALIAS_NOT_INTEGRATED')
    policy=ai.ReviewedD03AuthEmailAliases(descriptor['decisionId'],root,descriptor['aliases'])
    need(policy.descriptor()==descriptor and sha(policy._sealed)==root_review['descriptorSha256'],'D03_LOADED_ALIAS_POLICY_MISMATCH')
    return policy


def correlated_waiter(rows,holder,sample,contract,dispatch_us,deadline_us):
    reviewed_rpc(contract)
    need(type(rows)is list and all(type(r)is dict and type(r.get('blockingPids'))is list for r in rows),'D03_ACTIVITY_SCOPE')
    blocked=[r for r in rows if holder['pid']in r['blockingPids']]
    need(len(blocked)==1,'D03_HOLDER_HAS_OTHER_WAITERS')
    r=blocked[0]
    need(r['pid']==sample['pid'] and r['backendStart']==sample['backendStart']
         and r['query']==contract['query'] and r['querySha256']==contract['querySha256']
         and r['blockingPids']==[holder['pid']] and r['waitEventType']=='Lock' and r['state']=='active'
         and r['queryStartUs']==sample['queryStartUs'] and r['xactStartUs']==sample['xactStartUs'],
         'D03_RPC_CORRELATION_MISMATCH')
    need(all(type(v)is int and v>0 for v in (dispatch_us,deadline_us,sample['queryStartUs'],sample['xactStartUs'],sample['observedUs']))
         and dispatch_us<=sample['xactStartUs']<=sample['queryStartUs']<=sample['observedUs']<deadline_us,
         'D03_RPC_DISPATCH_DATABASE_CLOCK')
    return {'scope':'CORRELATED_POSTGREST_DB_ENTRY_ONLY','httpIngressProven':False,'DBJWTclaimDirectObserved':False,
            'rpcQuerySha256':contract['querySha256']}


def pooled_transaction_closed(rows,backend,contract,worker_closed):
    reviewed_rpc(contract)
    need(worker_closed is True and type(rows)is list,'D03_HTTP_RESPONSE_NOT_CLOSED')
    need(not any(r.get('state')=='active'and r.get('querySha256')==contract['querySha256']for r in rows),'D03_OWN_RPC_STILL_ACTIVE')
    need(not any(backend['pid']in r.get('blockingPids',[])for r in rows),'D03_HTTP_BACKEND_BLOCKS_OTHERS')
    candidates=[r for r in rows if r.get('pid')==backend['pid']]
    if not candidates:
        return {'requestTransactionClosed':True,'pooledBackendRetained':False,'backendTerminated':False,'ownership':'POSTGREST_POOL_NOT_OWNED_BACKEND'}
    need(len(candidates)==1 and candidates[0].get('backendStart')==backend['backendStart'], 'D03_HTTP_BACKEND_START_CHANGED')
    r=candidates[0]
    need(r.get('state')=='idle'and r.get('xactStartUs')is None and r.get('blockingPids')==[], 'D03_HTTP_TRANSACTION_STILL_OPEN')
    return {'requestTransactionClosed':True,'pooledBackendRetained':True,'backendTerminated':False,'ownership':'POSTGREST_POOL_NOT_OWNED_BACKEND'}


def verify_qualification_provenance(receipt, intent, producer_review, service, review, packet, baseline, current, alias_review):
    fields={'status','failureType','actualNaver','actualStorageAPI','sourceJpegBytesVerified','auth6HistoricalReceiptPreserved',
        'qualificationPacketSha256','qualifiedBaselineSha256','ownedChildClosed','originalBindingSha256','originalReceiptSha256',
        'retainOwnQualificationRows','automaticReplay'}
    need(type(receipt)is dict and set(receipt)==fields and receipt['status']=='PASS_SYNTHETIC_QUALIFICATION_ONLY'
         and receipt['failureType']is None and receipt['actualNaver']=='NOT_RUN'and receipt['actualStorageAPI']=='NOT_RUN'
         and receipt['sourceJpegBytesVerified']is True and receipt['auth6HistoricalReceiptPreserved']is True
         and receipt['ownedChildClosed']is True and receipt['retainOwnQualificationRows']is True
         and receipt['automaticReplay']is False,'D03_FINAL_QUALIFICATION_NOT_PASS')
    need(producer_review['head']==review.source_head==service['sourceHead']
         and producer_review['root']==service['root']and producer_review['profile']==service['currentProfile']
         and producer_review['bindingSha256']==receipt['originalBindingSha256']==service['bindingSha256']==review.binding_sha
         and producer_review['receiptSha256']==receipt['originalReceiptSha256']==service['auth6ReceiptSha256']==review.original_receipt_sha
         and producer_review['receiptPath']==service['auth6Receipt'],'D03_QUALIFICATION_SOURCE_HISTORY_MISMATCH')
    descriptor={k:alias_review[k]for k in ('decisionId','preparedRoot','aliases')}
    need(producer_review['aliasPolicy']==descriptor and producer_review['aliasPolicySha256']==alias_review['descriptorSha256'],
         'D03_QUALIFICATION_ALIAS_REVIEW_MISMATCH')
    need(type(intent)is dict and set(intent)=={'scope','reviewSha256','originalBindingSha256','originalAuth6ReceiptSha256','noReplay'}
         and intent['scope']=='SYNTHETIC_D03_QUALIFICATION_ONLY'and intent['noReplay']is True
         and intent['originalBindingSha256']==review.binding_sha
         and intent['originalAuth6ReceiptSha256']==review.original_receipt_sha,'D03_QUALIFICATION_INTENT_MISMATCH')
    actors=producer_review['actors']
    need(type(actors)is list and len(actors)==2 and {a['userId']for a in actors}=={review.author_id,review.reviewer_id}
         and any(a['userId']==review.reviewer_id and a['sessionId']==review.original_session_id for a in actors),
         'D03_QUALIFICATION_ACTORS_MISMATCH')
    expected={a['userId']:{'path':a['jpegPath'],'sha256':a['jpegSha256'],'storagePath':a['storagePath']}for a in actors}
    need(packet==expected,'D03_QUALIFICATION_PACKET_MAPPING_MISMATCH')
    need(baseline==current,'D03_QUALIFIED_BASELINE_CHANGED')
    return {'qualificationStatus':receipt['status'],'actualNaver':'NOT_RUN','actualStorageAPI':'NOT_RUN',
            'historicalAuth6Separate':True,'qualifiedBaselineVerified':True}


def verify_own_sources(head, pins):
    need(type(pins) is dict and set(pins) == set(OWN_SOURCES), 'D03_EXACT_OWN_SOURCE_SET')
    need(re.fullmatch('[a-f0-9]{40}', head or ''), 'D03_REVIEW_HEAD')
    observed = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True, timeout=15).strip()
    need(observed == head, 'D03_HEAD_CHANGED')
    for relative, digest in pins.items():
        path = ROOT / relative
        need(path.resolve() == path and not path.is_symlink() and re.fullmatch('[a-f0-9]{64}', digest or ''), 'D03_SOURCE_PATH')
        raw = path.read_bytes()
        committed = subprocess.check_output(['git', '-C', str(ROOT), 'show', head + ':' + relative], timeout=15)
        need(raw == committed and sha(raw) == digest, 'D03_SOURCE_NOT_COMMITTED')
    need(subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True, timeout=15).strip() == head,
         'D03_HEAD_CHANGED')


def initial_activity_sql():
    """초기 관측의 고정 SELECT. aggregate ORDER BY는 jsonb_agg 괄호 안에 둔다."""
    return "select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'backendStart',backend_start,'queryStart',query_start,'xactStart',xact_start,'state',state,'waitEventType',wait_event_type,'blockingPids',pg_blocking_pids(pid),'query',query)order by pid),'[]'::jsonb)from pg_stat_activity where datname=current_database()and pid<>pg_backend_pid();"


class ReviewedDeadlineSourceSeal:
    """현재 D03 전용 exact source seal. full source_pins는 초기/최종 그대로 수행한다."""
    MIGRATIONS='backend/supabase/migrations'
    @staticmethod
    def directory_state(st):return (st.st_dev,st.st_ino,st.st_uid,st.st_gid,st.st_mode)
    @staticmethod
    def file_state(st):return (st.st_dev,st.st_ino,st.st_uid,st.st_gid,st.st_mode,st.st_nlink,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
    def __init__(self,readonly,reviewed,own_pins):
        need(type(reviewed)is readonly.ReviewedServiceProfileReadonly,'D03_TYPED_SOURCE_SEAL_REVIEW')
        self.readonly=readonly;self.value=reviewed.descriptor();self.head=self.value['sourceHead']
        need('currentProfile'in self.value and self.value['currentProfile']['sourceHead']==self.head,'D03_CURRENT_SOURCE_SEAL_ONLY')
        self.pins=dict(self.value['pins']);self.own_pins=dict(own_pins);self.directories={};self.files={};self.closed=False
        for rel,digest in self.own_pins.items():
            need(rel not in self.pins or self.pins[rel]==digest,'D03_SOURCE_SEAL_PIN_COLLISION');self.pins[rel]=digest
        self.preservation_copies=set();self.migrations=[]
        try:
            self.full_verify();self.capture_reviewed_migrations();self.index=self.head_index()
            tracked={entry[0].decode()for entry in self.index}
            need(self.working_index()==self.index,'D03_SOURCE_INDEX_NOT_HEAD')
            for rel,digest in self.pins.items():
                path=ROOT/rel
                need(type(rel)is str and not Path(rel).is_absolute()and '..'not in Path(rel).parts
                     and path.resolve()==path and re.fullmatch('[a-f0-9]{64}',digest),'D03_SOURCE_SEAL_PATH')
                fd=self.directory(path.parent);leaf=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
                try:state=self.file_state(os.fstat(leaf))
                except BaseException:os.close(leaf);raise
                self.files[rel]=(leaf,state,digest)
                need(stat.S_ISREG(os.fstat(leaf).st_mode)and os.fstat(leaf).st_nlink==1,'D03_SOURCE_SEAL_REGULAR')
                raw=self.read_leaf(leaf,self.files[rel][1][6])
                need(sha(raw)==digest,'D03_SOURCE_SEAL_CAPTURED_BYTES')
                if rel not in self.preservation_copies or rel in tracked:
                    need(self.git('show',self.head+':'+rel)==raw,'D03_SOURCE_SEAL_GIT_BLOB')
            self.check()
        except BaseException:self.close();raise
    def git(self,*args):return subprocess.check_output(['git','-C',str(ROOT),*args],timeout=15,stderr=subprocess.DEVNULL)
    def head_now(self):return self.git('rev-parse','HEAD').decode().strip()
    def full_verify(self):
        head,pins=self.readonly.source_pins(self.head,self.value['currentProfile'])
        need(head==self.head and pins==self.value['pins'],'D03_SOURCE_FULL_PROFILE_CHANGED')
        verify_own_sources(self.head,self.own_pins)
    def capture_reviewed_migrations(self):
        # service graph pins는 SQL을 포함하지 않는다. 명시 current profile에서 별도로 확정한다.
        cp=self.value['currentProfile']
        with self.readonly.current_support(self.value['pins'])as policy:
            history,payloads=policy.inspect_reviewed_current_migrations(ROOT,self.head,cp['migrationEntriesSha256'])
            entries=history['entries']
            need([entry['version']for entry in entries]==cp['versions'],'D03_SOURCE_MIGRATION_VERSIONS')
            need(sha(json.dumps(entries,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode())==cp['migrationEntriesSha256'],'D03_SOURCE_MIGRATION_MANIFEST')
            need(set(payloads)=={Path(entry['path'])for entry in entries},'D03_SOURCE_MIGRATION_PAYLOAD_SET')
            for entry in entries:
                rel=entry['path'];raw=payloads[Path(rel)]
                need(rel.startswith(self.MIGRATIONS+'/')and sha(raw)==entry['sha256'],'D03_SOURCE_MIGRATION_PAYLOAD')
                need(rel not in self.pins or self.pins[rel]==entry['sha256'],'D03_SOURCE_MIGRATION_PIN_COLLISION')
                self.pins[rel]=entry['sha256'];self.migrations.append(rel)
            for rel in history['excluded']:
                path=ROOT/rel
                if path.suffix.lower()!='.sql':continue
                need(rel.startswith(self.MIGRATIONS+'/')and policy.COPY.search(path.name)
                     and path.resolve()==path and not path.is_symlink(),'D03_SOURCE_UNREVIEWED_EXCLUDED_SQL')
                # COPY는 실행 source가 아니라 원문 보존 대상이다. 신규 추가는 이후 universe가 거절한다.
                self.preservation_copies.add(rel);self.pins[rel]=sha(path.read_bytes());self.migrations.append(rel)
        self.migrations=sorted(self.migrations)
    def head_index(self):
        rows=[]
        for entry in self.git('ls-tree','-rz','--full-tree',self.head).split(b'\0'):
            if not entry:continue
            meta,path=entry.split(b'\t',1);mode,kind,digest=meta.split(b' ')
            rows.append((path,mode,digest,b'0'))
        return sorted(rows)
    def working_index(self):
        rows=[]
        for entry in self.git('ls-files','--stage','-z').split(b'\0'):
            if not entry:continue
            meta,path=entry.split(b'\t',1);mode,digest,stage=meta.split(b' ')
            rows.append((path,mode,digest,stage))
        return sorted(rows)
    def directory(self,path):
        if path in self.directories:return self.directories[path][0]
        flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
        parent=None if path==Path('/')else path.parent
        fd=os.open(str(path)if parent is None else path.name,flags,**({}if parent is None else{'dir_fd':self.directory(parent)}))
        try:state=self.directory_state(os.fstat(fd))
        except BaseException:os.close(fd);raise
        self.directories[path]=(fd,state,parent)
        return fd
    def check_directories(self):
        for path,(fd,expected,parent)in self.directories.items():
            need(self.directory_state(os.fstat(fd))==expected,'D03_SOURCE_PARENT_FD_CHANGED')
            if parent is not None:
                current=os.stat(path.name,dir_fd=self.directories[parent][0],follow_symlinks=False)
                need(self.directory_state(current)==expected,'D03_SOURCE_PARENT_PATH_CHANGED')
    @staticmethod
    def read_leaf(fd,size):
        chunks=[];offset=0
        while offset<size:
            chunk=os.pread(fd,min(1048576,size-offset),offset);need(chunk,'D03_SOURCE_SHORT_READ');chunks.append(chunk);offset+=len(chunk)
        need(not os.pread(fd,1,size),'D03_SOURCE_OVERSIZE');return b''.join(chunks)
    def migration_universe(self):
        root=ROOT/self.MIGRATIONS;actual=[]
        need(root.resolve()==root and not root.is_symlink(),'D03_MIGRATION_SOURCE_PATH')
        for path in root.rglob('*'):
            need(not path.is_symlink(),'D03_MIGRATION_SOURCE_LINK')
            if path.is_file()and path.suffix.lower()=='.sql':actual.append(path.relative_to(ROOT).as_posix())
        return sorted(actual)
    def check(self):
        need(not self.closed and self.head_now()==self.head,'D03_SOURCE_HEAD_CHANGED')
        need(self.working_index()==self.index,'D03_SOURCE_INDEX_CHANGED')
        need(self.migration_universe()==self.migrations,'D03_SOURCE_MIGRATION_UNIVERSE_CHANGED')
        self.check_directories()
        for rel,(held,expected,digest)in self.files.items():
            path=ROOT/rel;parent=self.directories[path.parent][0]
            fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
            try:
                need(self.file_state(os.fstat(held))==expected and self.file_state(os.fstat(fd))==expected,'D03_SOURCE_LEAF_CHANGED')
                need(sha(self.read_leaf(fd,expected[6]))==digest,'D03_SOURCE_BYTES_CHANGED')
                need(self.file_state(os.fstat(fd))==expected and self.file_state(os.stat(path.name,dir_fd=parent,follow_symlinks=False))==expected,'D03_SOURCE_READ_CHANGED')
            finally:os.close(fd)
        self.check_directories()
        need(self.head_now()==self.head,'D03_SOURCE_HEAD_CHANGED')
    def finish(self):
        self.check();self.full_verify();self.check()
    def close(self):
        if self.closed:return
        for fd,_,_ in self.files.values():os.close(fd)
        for fd,_,_ in reversed(list(self.directories.values())):os.close(fd)
        self.files={};self.directories={};self.closed=True


def predicates(review):
    # 이름/시각의 느슨한 범위 DELETE는 허용하지 않는다.
    u = lambda v: "'" + v + "'::uuid"
    p, j, a = map(u, (review.post_id, review.request_id, review.appointment_id))
    return {
        'public.posts': 'id=' + p,
        'public.join_requests': 'id=' + j + ' and post_id=' + p + ' and requester_id=' + u(review.reviewer_id),
        'public.appointments': 'id=' + a + ' and post_id=' + p + ' and join_request_id=' + j,
        'public.notifications': 'join_request_id=' + j + ' and recipient_id=' + u(review.author_id) + " and kind='join_request'",
        'private.conversation_retention_generations': 'request_id=' + j + ' and generation=1',
        'private.appointment_member_episodes': 'appointment_id=' + a,
        'private.conversation_generation_appointments': 'appointment_id=' + a + ' and request_id=' + j + ' and generation=1',
    }


def owned_rows_sql(review):
    terms = []
    for table, predicate in predicates(review).items():
        terms.append("select '" + table + "' as t,coalesce(jsonb_object_agg(h,n),'{}'::jsonb)bag from(" +
            "select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')h,count(*)n from " +
            table + ' r where ' + predicate + ' group by 1)s')
    return 'select jsonb_object_agg(t,bag)from(' + ' union all '.join(terms) + ')x;'


def validate_summary_cleanup(origin,observed,users):
    """고정 D03 appointment 삭제 trigger의 새 두 projection만 정리한다."""
    need(type(origin)is dict and all(origin.get(k)==[]for k in('state','outbox','checkpoints'))
         and type(origin.get('epochUs'))is int,'D03_SUMMARY_ORIGIN_NOT_EMPTY')
    need(type(observed)is dict and set(observed)=={'epochUs','state','outbox','checkpoints'}
         and type(observed['epochUs'])is int and observed['epochUs']>=origin['epochUs']
         and observed['checkpoints']==[],'D03_SUMMARY_CHECKPOINT_OR_CLOCK')
    expected=set(users)
    for key in('state','outbox'):
        rows=observed[key]
        need(type(rows)is list and len(rows)in(0,2) and (not rows or {r.get('profile_id')for r in rows}==expected),
             'D03_SUMMARY_EXACT_TWO')
    need(bool(observed['state'])==bool(observed['outbox']),'D03_SUMMARY_PAIR')
    for row in observed['state']:
        need(set(row)=={'profile_id','revision','fingerprint','visible_summary_id'}
             and type(row['revision'])is int and row['revision']==1
             and row['fingerprint']is None and row['visible_summary_id']is None,'D03_SUMMARY_UNEXPECTED_STATE')
    for row in observed['outbox']:
        need(set(row)=={'profile_id','requested_at'}and type(row['requested_at'])is str,'D03_SUMMARY_OUTBOX_SHAPE')
        instant=datetime.datetime.fromisoformat(row['requested_at'].replace('Z','+00:00'))
        need(instant.tzinfo is not None and origin['epochUs']<=int(instant.timestamp()*1000000)<=observed['epochUs'],
             'D03_SUMMARY_OUTBOX_ORIGIN')


def verify_delta(before, after, owned, tables, *, cleanup):
    need(type(before) is dict and type(after) is dict and set(before) == set(after), 'D03_SNAPSHOT_SHAPE')
    need(sorted(before['rows']) == sorted(after['rows']) == tables, 'D03_FULL_TABLE_INVENTORY')
    need(all(before[k] == after[k] for k in before if k != 'rows'), 'D03_AUTHORITY_OR_CATALOG_CHANGED')
    need(type(owned) is dict and set(owned) == set(predicates_placeholder()), 'D03_EXACT_OWN_TABLES')
    for table, original in before['rows'].items():
        expected = dict(original)
        if table in owned:
            bag = owned[table]
            need(type(bag) is dict, 'D03_OWN_BAG')
            if cleanup: need(bag == {}, 'D03_OWN_ROWS_REMAIN')
            else:
                need(len(bag) == 1 and sum(bag.values()) == 1
                     and all(re.fullmatch('[a-f0-9]{64}', k) and type(n) is int and n == 1 for k,n in bag.items()), 'D03_EXACT_ONE_NEW_ROW')
                for h,n in bag.items():
                    need(h not in expected, 'D03_PREEXISTING_OWN_ROW')
                    expected[h] = n
        need(after['rows'][table] == expected, 'D03_UNOWNED_OR_MISSING_ROW_DELTA')


def predicates_placeholder():
    return ('public.posts','public.join_requests','public.appointments','public.notifications',
            'private.conversation_retention_generations','private.appointment_member_episodes','private.conversation_generation_appointments')


def identity_holder_open_sql(review,opening):
    """잠금용 행 값을 출력하지 않고 원 identity JSON 한 줄만 출력한다."""
    review.validate()
    target="select id from public.appointments where id='"+review.appointment_id+"'::uuid for update;"
    need(type(opening)is str and opening.count(target)==1,'D03_FIXED_HOLDER_OPENING')
    lock="do $d03holder$ begin perform 1 from public.appointments where id='"+review.appointment_id+"'::uuid for update; if not found then raise exception 'd03_holder_appointment_missing';end if;end $d03holder$;"
    return opening.replace(target,lock)


class PsqlHolder:
    """새 host process group의 정확 컨테이너 DB 세션 하나만 보유한다."""
    def __init__(self, owner, statement=None, label='holder'):
        self.label=label;self.persistent=statement is None
        self.owner=owner;self.proc=None;self.readers=[];self.lines=queue.Queue();self.buffers={'stdout':bytearray(),'stderr':bytearray()}
        self.failure=[];self.backend=None;self.closed=False;self.closure_verified=False;self.index=0
        owner.children.append(self)
        owner.guard(owner.review)
        argv=owner.core.r.base+['exec','-i',owner.core.target['id'],'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-f','-']
        try:
            self.proc=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            for name in ('stdout','stderr'):
                def reader(name=name):
                    try:
                        while True:
                            line=getattr(self.proc,name).readline(65537)
                            if not line:break
                            if len(self.buffers[name])+len(line)>65536:
                                self.failure.append('HOLDER_OUTPUT_LIMIT');break
                            self.buffers[name].extend(line)
                            if name=='stdout':self.lines.put(line)
                    except BaseException as error:self.failure.append(type(error).__name__)
                t=threading.Thread(target=reader,daemon=True);t.start();self.readers.append(t)
            need(self.proc.poll() is None,'D03_HOLDER_CLOSED')
            if statement is None:
                opening=owner.executor.holder_open_sql(owner.review)
                if label in ('holder','probe-holder'):opening=identity_holder_open_sql(owner.review,opening)
            else:opening="select json_build_object('kind','D03_COMMAND_BACKEND','pid',pg_backend_pid(),'backendStart',backend_start)from pg_stat_activity where pid=pg_backend_pid();\nset statement_timeout='15s';set lock_timeout='10s';set plpgsql.check_asserts=on;\n"+statement+"\n\\q\n"
            self.send(opening)
        except BaseException as original:
            try:self.close()
            except BaseException as closure:original.add_note('D03_RAW_CLOSE_UNPROVEN:'+type(closure).__name__)
            raise

    def collect(self):
        end=time.monotonic()+25
        try:
            while self.proc.poll() is None:
                self.owner.guard(self.owner.review,cleanup=self.owner.cleaning)
                need(not self.failure,'D03_SQL_CAPTURE_LIMIT_OR_ERROR')
                need(time.monotonic()<end,'D03_SQL_PROCESS_TIMEOUT')
                time.sleep(.05)
        finally:
            self.close()
        need(self.proc.returncode==0 and not self.failure,'D03_SQL_EXECUTION_FAILED_RAW_SAVED')
        lines=bytes(self.buffers['stdout']).split(b'\n',1)
        need(len(lines)==2,'D03_COMMAND_BACKEND_PREFIX_MISSING')
        return lines[1].decode().strip()

    def send(self,sql):
        need(not self.closed and self.proc.poll() is None, 'D03_HOLDER_CLOSED')
        self.proc.stdin.write(sql.encode());self.proc.stdin.flush()

    def next_json(self,seconds):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            self.owner.guard(self.owner.review)
            # 한 관측 배치에 이미 도착한 줄을 처리할 때 full guard를 재실행하지 않는다.
            # 실제 대기/저장/판정은 처음부터 같은 마감 안에 있어야 한다.
            need(time.monotonic()<end,'D03_HOLDER_OBSERVATION_TIMEOUT')
            while time.monotonic()<end:
                need(not self.failure,'D03_HOLDER_CAPTURE_FAILURE')
                try:line=self.lines.get(timeout=min(.1,max(0,end-time.monotonic())))
                except queue.Empty:
                    need(self.proc.poll() is None,'D03_HOLDER_EXITED');break
                self.index+=1
                self.owner.save(f'd03-{self.label}-line-{self.index:03d}.json',{'rawBase64':base64.b64encode(line).decode()})
                need(time.monotonic()<end,'D03_HOLDER_OBSERVATION_TIMEOUT')
                if line.startswith((b'{',b'[')):
                    value=json.loads(line)
                    need(time.monotonic()<end,'D03_HOLDER_OBSERVATION_TIMEOUT')
                    return value
        raise ValueError('D03_HOLDER_OBSERVATION_TIMEOUT')

    def identity(self):
        value=self.next_json(3)
        need(type(value) is dict and set(value)=={'pid','backendStart'} and type(value['pid'])is int and value['pid']>0,
             'D03_HOLDER_IDENTITY')
        self.backend=value
        self.owner.backend_ids.append(value)
        return value

    def release_after_deadline(self):
        self.send(self.owner.executor.holder_release_sql(self.owner.review))
        return self.next_json(330)

    def close(self):
        if self.closed:
            need(self.closure_verified,'D03_RAW_COMMAND_CLOSURE_STICKY')
            return
        try:
            self.closed=True
            if self.proc is not None:
                if self.proc.poll() is None and self.persistent:
                    try:
                        self.proc.stdin.write(b'rollback;\n\\q\n');self.proc.stdin.flush()
                        self.proc.wait(timeout=3)
                    except (BrokenPipeError,OSError,subprocess.TimeoutExpired):pass
                if self.proc.poll() is None:
                    try:os.killpg(self.proc.pid,signal.SIGTERM)
                    except ProcessLookupError:pass
                    try:self.proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        try:os.killpg(self.proc.pid,signal.SIGKILL)
                        except ProcessLookupError:pass
                        self.proc.wait(timeout=3)
                for t in self.readers:t.join(timeout=3)
                for stream in (self.proc.stdin,self.proc.stdout,self.proc.stderr):
                    if stream is not None:stream.close()
                need(not any(t.is_alive() for t in self.readers), 'D03_HOLDER_READER_ALIVE')
                self.owner.save(f'd03-{self.label}-closed-private.json',{'exitCode':self.proc.returncode,
                    'stdoutBase64':base64.b64encode(self.buffers['stdout']).decode(),
                    'stderrBase64':base64.b64encode(self.buffers['stderr']).decode(),'captureFailures':self.failure})
            need(self.proc is not None and self.proc.poll()is not None,'D03_RAW_LEADER_NOT_REAPED')
            try:os.killpg(self.proc.pid,0)
            except ProcessLookupError:pass
            else:raise ValueError('D03_RAW_PROCESS_GROUP_REMAINS')
            if not self.persistent:
                first=bytes(self.buffers['stdout']).split(b'\n',1)[0]
                stamp=json.loads(first)
                need(type(stamp)is dict and set(stamp)=={'kind','pid','backendStart'}
                     and stamp['kind']=='D03_COMMAND_BACKEND'and type(stamp['pid'])is int and stamp['pid']>0
                     and type(stamp['backendStart'])is str and stamp['backendStart'],'D03_COMMAND_BACKEND_UNPROVEN')
                self.backend={'pid':stamp['pid'],'backendStart':stamp['backendStart']}
            need(self.backend is not None,'D03_COMMAND_BACKEND_UNPROVEN')
            self.owner.finish_raw_backend(self)
            self.closure_verified=True
        except BaseException as error:
            self.owner.mark_raw_unclosed(self.label,error)
            raise


class OriginalHTTPChild:
    def __init__(self,owner):
        self.owner=owner;self.result=None;self.error=None;self.response_closed=False
        def execute():
            try:
                a=owner.account
                self.result=owner.executor.original_review_http(owner.core.binding['origin'],owner.core.binding['credentials']['anon'],
                    a['accessToken'],owner.review,lambda:owner.guard(owner.review),owner.save,owner.verify_dispatch_window)
            except BaseException as error:self.error=error
            finally:self.response_closed=(self.result is not None and self.result.get('transportClosed')is True)or self.owner.runtime.http_response_closed if isinstance(self.owner,FastSourceSeal)else(self.result is not None and self.result.get('transportClosed')is True)or self.owner.http_response_closed
        self.thread=threading.Thread(target=execute,daemon=True);self.thread.start()
    def finish(self):
        self.thread.join(timeout=365)
        need(not self.thread.is_alive(),'D03_HTTP_WORKER_STILL_LIVE')
        if self.error is not None:raise self.error
        return self.result
    def close(self):
        self.thread.join(timeout=365)
        need(not self.thread.is_alive(),'D03_HTTP_WORKER_STILL_LIVE')


class FixedDeadlineRuntime:
    def __init__(self,authority,readonly,executor,service_review,review):
        self.authority=authority;self.readonly=readonly;self.executor=executor;self.review=review
        self.value=service_review.descriptor();self.own_pins=readonly.exact(authority.owned_source_pins_bytes)
        self.readonly_transport=load(READONLY_TRANSPORT,self.own_pins[READONLY_TRANSPORT])
        self.private_anchor_helper=load(PRIVATE_ANCHOR_HELPER,self.own_pins[PRIVATE_ANCHOR_HELPER])
        self.binding_anchor=None;self.original_binding_raw=None
        self.cleaning=False;self.children=[];self.backend_ids=[];self.sequence=None;self.account=None;self.command_index=0;self.http_backend=None;self.http_child=None;self.dispatch_us=None;self.auth_verified=False;self.http_dispatched=False;self.http_response_closed=False;self.memory_last=None;self.raw_sticky=[];self.raw_discharge_index=0
        owner=self
        class DeadlineCore(readonly.ServiceProfileReadonlyRun):
            def __init__(core,reviewed):
                super().__init__(reviewed)
                core.source_seal=ReviewedDeadlineSourceSeal(readonly,reviewed,owner.own_pins)
            def fixed_identity(core):
                owner.assert_readonly_closed(core)
                # Docker 신원/보존 검사는 원 readonly와 동일 순서·동일 범위다.
                core.source_seal.check()
                if core.r is None:return
                need(core.r.call(['info','--format','{{.ID}}'])==core.value['daemonId'],'READONLY_DAEMON_CHANGED')
                core.r.signed_identity()
                actual={}
                for role,container in core.binding['containers'].items():
                    x=readonly.exact(core.r.call(['inspect',container['id']]))[0]
                    need(x['State']['Restarting']is False,'READONLY_RUNTIME_RESTARTING')
                    actual[role]={'id':x['Id'],'startedAt':x['State']['StartedAt'],'restartCount':x['RestartCount'],
                        'networks':{k:v['NetworkID']for k,v in x['NetworkSettings']['Networks'].items()}}
                readonly.verify_runtime_projection(core.runtime_identity,actual,core.binding,core.owned_networks)
            def bind_ports(core,binding,binding_raw,target):
                # 원 readonly bind_ports의 검사·순서 유지, SQL 생성 전 고정 wrapper 설치만 추가한다.
                core.binding=binding;core.binding_raw=binding_raw;core.target=target
                core.r=core.ai.SignedRunner(core.root,binding)
                reviewed=core.ai.ReviewedSignedProvisioning(core.value['decisionId'],core.root,binding['sourcePins'],
                    binding['containers'],binding['credentials'],int(time.time())+300)
                core.ai.provisioning_metadata(reviewed,target,binding['origin'])
                core.port=readonly.monitored_read_ports(core.ai,reviewed,core)
                core.port=owner.readonly_transport.bind_deadline_readonly_port(core.ai,core,owner)
                core.owned_networks=readonly.exact(core.read(core.root/'owned-networks.json'))
                ref=core.value['runtimeIdentity'];raw=core.read(ref['path'])
                need(sha(raw)==ref['sha256'],'READONLY_RUNTIME_PACKET_CHANGED');core.runtime_identity=readonly.exact(raw)
                core.live();core.memory(start=True)
                need(core.thread is None,'D03_MONITOR_NO_DUPLICATE')
                core.thread=threading.Thread(target=core.monitor,daemon=True);core.thread.start()
                need(core.thread.is_alive()and not core.failures,'D03_EARLY_MONITOR_NOT_LIVE')
                need(core.port.settings()=={'jwtExpirySeconds':3600,'anonymousEnabled':False,'signupDisabled':True},'READONLY_AUTH_SETTINGS')
            def memory(core,start=False):
                super().memory(start);owner.memory_last=time.monotonic()
            def monitor(core):
                while not core.done.is_set():
                    began=time.monotonic()
                    try:core.memory()
                    except BaseException:core.failures.append('D03_MEMORY_MONITOR');return
                    core.done.wait(max(0,began+1-time.monotonic()))
            def active(core):
                if not owner.cleaning:super().active()
        self.core=DeadlineCore(service_review)
        self.core.deadline=time.monotonic()+900
        self.core.evidence=self.core.root/('d03-deadline-'+review.scope_id)

    def original_binding_bytes(self):
        need(self.binding_anchor is not None and type(self.original_binding_raw)is bytes
             and sha(self.original_binding_raw)==self.value['bindingSha256'],'D03_ORIGINAL_BINDING_ANCHOR_REQUIRED')
        self.binding_anchor.check()
        return self.original_binding_raw

    def assert_readonly_closed(self,core=None):
        core=self.core if core is None else core
        if core.port is not None:
            need(callable(getattr(core.port,'assert_closed_state',None)),'D03_BOUND_READONLY_PORT_REQUIRED')
            core.port.assert_closed_state()

    def guard(self,review,cleanup=False):
        need(review==self.review,'D03_EXECUTION_REVIEW_CHANGED')
        need(not self.raw_sticky,'D03_RAW_CLOSURE_STICKY_NO_FURTHER_SQL')
        self.assert_readonly_closed()
        if cleanup:self.cleaning=True
        self.core.source_seal.check()
        self.core.fixed_identity()
        if not self.cleaning:self.core.active()
        self.core.closed_controls()

    def mark_raw_unclosed(self,label,error):
        self.raw_sticky.append({'command':label,'errorType':type(error).__name__})
        # sticky 결과를 초기화하거나 다음 SQL로 정리 성공을 합성하지 않는다.

    def finish_raw_backend(self,command):
        backend=command.backend;q=self.core.ai.quote
        self.core.fixed_identity()
        # 기존 고정 observer 포트로 확인한다. runtime.sql/PsqlHolder를 재귀 생성하지 않는다.
        raw=self.core.port.read_sql('select count(*)from pg_stat_activity where pid='+str(backend['pid'])+
            ' and backend_start='+q(backend['backendStart'])+'::timestamptz;')
        self.raw_discharge_index+=1
        self.save(f'd03-raw-discharge-{self.raw_discharge_index:05d}.json',{'command':command.label,
            'backend':backend,'observerPort':'PINNED_FIXED_LIFECYCLE_READ_SQL','rawResult':raw,
            'leaderReaped':True,'processGroupAbsent':True,'observerIsRecursiveD03RawChild':False})
        self.core.fixed_identity()
        need(raw=='0','D03_RAW_BACKEND_NOT_TERMINATED')

    def save(self,name,value):
        if name=='d03-http-transport-closed-private.json':self.http_response_closed=value.get('transportClosed')is True
        if name=='d03-intent.json':
            value={**value,'rootServiceReviewSha256':sha(self.authority.service_descriptor_bytes),
                'rootExecutionReviewSha256':sha(self.authority.execution_descriptor_bytes),
                'rootRpcReviewSha256':sha(self.authority.rpc_review_bytes),
                'rootAliasReviewSha256':sha(self.authority.d03_alias_review_bytes),
                'rootQualificationReceiptSha256':self.authority.qualification_receipt_sha,
                'rootQualificationReviewSha256':sha(self.authority.qualification_review_bytes)}
        if type(value)is bytes:
            name=name.replace('.bin','-raw.json')
            value={'rawBase64':base64.b64encode(value).decode(),'rawSha256':sha(value),'rawBytes':len(value)}
        return self.core.save(name,value)

    def bind(self):
        c=self.core;ro=self.readonly
        raw=c.read(c.root/'signed-ai-binding-private.json');receipt_raw=c.read(self.value['auth6Receipt'])
        need(sha(raw)==self.value['bindingSha256']and sha(receipt_raw)==self.value['auth6ReceiptSha256'],'D03_ORIGINAL_PACKETS_CHANGED')
        binding=ro.exact(raw);receipt=ro.exact(receipt_raw)
        ro.verify_auth6_receipt(receipt,raw,self.value['auth6Receipt'])
        target=c.ai.signed_prepared_target(c.root);ro.verify_target_profile(self.value,target)
        self.alias_policy=runtime_alias_policy(c.ai,ro.exact(self.authority.d03_alias_review_bytes),receipt,c.root,binding['accounts'])
        c.ai.validate_signed_binding(binding,c.root,target,d03_email_aliases=self.alias_policy)
        need(all(a['expiresAt']>time.time()+1200 for a in binding['accounts']),'D03_FRESH_ORIGINAL_AUTH_REQUIRED')
        need(not c.evidence.exists()and not c.evidence.is_symlink(),'D03_EVIDENCE_NO_REPLAY')
        # bind_ports는 원본 runtimeIdentity/정확4ID·시작시각/설정/메모리를 검증한다.
        c.evidence.mkdir(mode=0o700);c.evidence_owned=True
        self.binding_anchor=self.private_anchor_helper.PrivateFileAnchor(c.root/'signed-ai-binding-private.json',sha(raw),c.read)
        self.original_binding_raw=raw
        c.bind_ports(binding,raw,target)
        c.closed_controls()
        need(c.port.read_sql('select enabled from private.content_inspection_control where singleton;')=='f','D03_INSPECTION_TICKET_LANE_NOT_REVIEWED')
        need(c.port.read_sql('select count(*)from public.posts;')=='0','D03_FRESH_SOURCE_REQUIRED')
        accounts=[a for a in binding['accounts']if a['userId']==self.review.reviewer_id and a['sessionId']==self.review.original_session_id]
        need(len(accounts)==1 and any(a['userId']==self.review.author_id for a in binding['accounts']),'D03_EXACT_ORIGINAL_ACTORS')
        self.account=accounts[0]
        self.save('d03-activity-before-private.json',self.readonly.exact(self.sql(initial_activity_sql())))
        # bind_ports의 초기 메모리 검사 직후 시작한 같은 monitor만 유지한다.
        need(c.thread is not None and c.thread.is_alive()and not c.failures,'D03_EARLY_MONITOR_NOT_LIVE')

    def verify_original_auth(self,review):
        self.guard(review)
        c=self.core;ro=self.readonly
        qp=Path(self.authority.qualification_path)
        need(qp.parent==c.root and qp.name=='d03-qualification-private.json','D03_QUALIFICATION_PATH')
        raw=c.read(qp);need(sha(raw)==self.authority.qualification_sha,'D03_QUALIFICATION_CHANGED')
        packet=ro.exact(raw)
        rp=Path(self.authority.qualification_receipt_path)
        need(rp==c.root/'d03-qualification/receipt.json','D03_FINAL_QUALIFICATION_RECEIPT_PATH')
        receipt_raw=c.read(rp)
        need(type(self.authority.qualification_receipt_sha)is str and re.fullmatch('[a-f0-9]{64}',self.authority.qualification_receipt_sha)
             and sha(receipt_raw)==self.authority.qualification_receipt_sha,'D03_FINAL_QUALIFICATION_RECEIPT_CHANGED')
        receipt=ro.exact(receipt_raw)
        need(type(self.authority.qualification_review_bytes)is bytes,'D03_ROOT_QUALIFICATION_REVIEW_BYTES')
        producer_review=ro.exact(self.authority.qualification_review_bytes)
        intent=ro.exact(c.read(c.root/'d03-qualification/intent.json'))
        need(intent.get('reviewSha256')==sha(self.authority.qualification_review_bytes),'D03_QUALIFICATION_REVIEW_INTENT_SHA')
        baseline_raw=c.read(c.root/'d03-qualification/qualified-baseline-private.json')
        need(receipt.get('qualificationPacketSha256')==sha(raw)==self.authority.qualification_sha
             and receipt.get('qualifiedBaselineSha256')==sha(baseline_raw),'D03_QUALIFICATION_ARTIFACT_SHA_MISMATCH')
        baseline=ro.exact(baseline_raw)
        proof=verify_qualification_provenance(receipt,intent,producer_review,self.value,review,packet,baseline,
            c.snapshot(),ro.exact(self.authority.d03_alias_review_bytes))
        self.save('d03-final-qualification-consumed-private.json',{**proof,
            'finalQualificationReceiptSha256':sha(receipt_raw),'qualifiedBaselineSha256':sha(baseline_raw),
            'qualificationPacketSha256':sha(raw),'producerReviewSha256':sha(self.authority.qualification_review_bytes)})
        need(type(packet)is dict and set(packet)=={review.author_id,review.reviewer_id},'D03_QUALIFICATION_EXACT_TWO')
        q=c.ai.quote
        for uid in (review.author_id,review.reviewer_id):
            a=next(a for a in c.binding['accounts']if a['userId']==uid)
            claims=c.ai.signed_claims(a['accessToken'])
            need(claims.get('sub')==uid and claims.get('session_id')==a['sessionId']
                 and type(claims.get('iat'))is int and type(claims.get('exp'))is int
                 and claims['exp']-claims['iat']==3600 and claims['exp']>time.time()+300,'D03_ORIGINAL_JWT_CLAIMS')
            actual=c.ai.preserved_operation(lambda:self.guard(review),lambda:c.r.auth_user(a['accessToken']))
            need(actual.get('id')==uid and actual.get('role')=='authenticated'and actual.get('is_anonymous')is not True,'D03_ACTUAL_GOTRUE')
            photo=packet[uid]
            need(type(photo)is dict and set(photo)=={'path','sha256','storagePath'}and type(photo['sha256'])is str
                 and re.fullmatch('[a-f0-9]{64}',photo['sha256']),'D03_PHOTO_PACKET')
            path=photo_source_path(Path(photo['path']),c.root)
            need(type(photo['storagePath'])is str and re.fullmatch(re.escape(uid)+r'/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]jpg',photo['storagePath']),'D03_OWNED_PHOTO_STORAGE_PATH')
            image=c.read(path)
            need(1<=len(image)<=2097152 and sha(image)==photo['sha256'] and image[:2]==b'\xff\xd8'and image[-2:]==b'\xff\xd9','D03_PHOTO_SOURCE_BYTES')
            # 원본 사진 전송/Storage object bytes는 검증 범위 밖이다. 합성 metadata만 검증한다.
            sql="select exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id join public.profiles p on p.id=u.id join private.naver_accounts n on n.user_id=u.id join private.naver_sessions ns on ns.user_id=u.id and ns.session_id=s.id and ns.subject=n.subject join storage.objects o on o.bucket_id='profile-images'and o.name=p.avatar_url where u.id="+q(uid)+"::uuid and s.id="+q(a['sessionId'])+"::uuid and not u.is_anonymous and u.email="+q(a['authEmail'])+" and n.auth_email=u.email and n.verification_status='qualified'and n.completed_at is not null and n.gender='female'and p.gender='female'and p.birth_date=n.birth_date and public.korean_age(p.birth_date,(clock_timestamp()at time zone'Asia/Seoul')::date)>=19 and p.avatar_url="+q(photo['storagePath'])+" and o.owner_id=u.id::text and o.metadata->>'mimetype'='image/jpeg'and o.metadata->>'size'="+q(str(len(image)))+" and exists(select 1 from private.member_episodes e where e.profile_id=u.id and e.ended_at is null) and not private.profile_retired(u.id));"
            need(self.sql(sql)=='t','D03_QUALIFIED_SOURCE_METADATA_MISSING')
        self.auth_verified=True
        self.save('d03-auth-qualification-private.json',{'status':'ACTUAL_LOCAL_AUTH_SYNTHETIC_QUALIFICATION_ONLY',
            'originalReceiptSha256':self.value['auth6ReceiptSha256'],'actualNaver':'NOT_RUN','actualStorageAPI':'NOT_RUN','sourcePhotoBytesVerified':True})

    def sequence_state(self):
        # 순서·중복을 고정한 실제 sequence 상태. reset은 하지 않는다.
        return self.sql("select coalesce(jsonb_agg(jsonb_build_array(schemaname,sequencename,last_value)order by schemaname,sequencename),'[]'::jsonb)from pg_sequences where schemaname in('auth','public','private','storage','cron','vault');")

    def snapshot(self):
        value=self.core.snapshot()
        value['sequenceStateSha256']=sha(self.sequence_state().encode())
        return value

    def sql(self,statement):
        if statement==self.executor.fixture_sql(self.review):
            need(not hasattr(self,'summary_fixture_origin'),'D03_SUMMARY_FIXTURE_REPLAY')
            origin=self.readonly.exact(self._sql_command(self.summary_origin_sql()))
            need(type(origin)is dict and set(origin)=={'epochUs','state','outbox','checkpoints'}
                 and type(origin['epochUs'])is int and all(origin[k]==[]for k in('state','outbox','checkpoints')),
                 'D03_SUMMARY_PREEXISTING_ROWS')
            self.save('d03-summary-origin-private.json',origin)
            self.summary_fixture_origin=canonical(origin)
        return self._sql_command(statement)

    def summary_origin_sql(self):
        ids=','.join(self.executor.uid(u)for u in sorted((self.review.author_id,self.review.reviewer_id)))
        parts=["'epochUs',(extract(epoch from clock_timestamp())*1000000)::bigint"]
        for key,table in(('state','review_summary_state'),('outbox','review_refresh_outbox'),('checkpoints','review_summary_checkpoints')):
            parts.append("'"+key+"',(select coalesce(jsonb_agg(to_jsonb(t)order by profile_id),'[]'::jsonb)from private."+table+' t where profile_id in('+ids+'))')
        return 'select jsonb_build_object('+','.join(parts)+');'

    def _sql_command(self,statement):
        self.guard(self.review,cleanup=self.cleaning)
        self.command_index+=1
        command=PsqlHolder(self,statement=statement,label=f'sql-{self.command_index:05d}')
        value=command.collect()
        self.guard(self.review,cleanup=self.cleaning)
        return value

    def owned(self):return self.readonly.exact(self.sql(owned_rows_sql(self.review)))

    def verify_delta(self,before,after,review,cleanup):
        verify_delta(before,after,self.owned(),self.value['currentProfile']['expectedTables'],cleanup=cleanup)

    def open_holder(self,review):
        return PsqlHolder(self)

    def verify_dispatch_window(self):
        # caller는 원HTTP worker의 최종 source/identity guard 직후 한 번만 호출한다.
        need(self.http_dispatched is False,'D03_HTTP_ALREADY_DISPATCHED')
        begin=time.monotonic()
        row=self.readonly.exact(self.sql("select json_build_object('databaseNowUs',(extract(epoch from clock_timestamp())*1000000)::bigint,'deadlineUs',(extract(epoch from review_deadline_at)*1000000)::bigint)from public.appointments where id="+self.executor.uid(self.review.appointment_id)+';'))
        need(type(row)is dict and set(row)=={'databaseNowUs','deadlineUs'}and all(type(v)is int for v in row.values()),'D03_DISPATCH_CLOCK_SHAPE')
        proof={**row,'minimumRemainingUs':30000000,'fixtureHorizonSeconds':300,'httpTimeoutSeconds':360,
            'holderTimeoutSeconds':390,'runtimeTimeoutSeconds':900,'singleDispatch':True}
        # 먼저 관측을 보존한다. fsync/guard/DB 왕복 전체 elapsed를 보수적으로 차감한다.
        self.save('d03-dispatch-window-private.json',proof)
        elapsed_us=int((time.monotonic()-begin)*1000000)+1
        effective=row['deadlineUs']-row['databaseNowUs']-elapsed_us
        claims=self.core.ai.signed_claims(self.account['accessToken'])
        jwt_ok=type(claims.get('exp'))is int and claims['exp']*1000000>row['deadlineUs']+60000000
        self.save('d03-dispatch-window-decision-private.json',{'elapsedUs':elapsed_us,'effectiveRemainingUs':effective,
            'minimumRemainingUs':30000000,'originalJWTOutlastsDeadlineAndMargin':jwt_ok,'automaticReplay':False})
        # 마지막 증거 fsync 지연도 보내기 직전에 포함한다.
        final_elapsed=int((time.monotonic()-begin)*1000000)+1
        final_effective=row['deadlineUs']-row['databaseNowUs']-final_elapsed
        if not (30000000<=final_effective<=300000000 and jwt_ok):
            self.save('d03-http-no-dispatch-window-private.json',{'httpDispatched':False,'finalElapsedUs':final_elapsed,
                'effectiveRemainingUs':final_effective,'minimumRemainingUs':30000000,
                'originalJWTOutlastsDeadlineAndMargin':jwt_ok,'automaticReplay':False})
            need(jwt_ok,'D03_ORIGINAL_JWT_TOO_SHORT_FOR_WINDOW')
            raise ValueError('D03_DISPATCH_WINDOW_OVERRUN_NO_REPLAY')
        self.dispatch_us=row['databaseNowUs'];self.http_dispatched=True

    def start_original_http(self,review):
        need(self.auth_verified is True and self.http_child is None,'D03_SINGLE_ORIGINAL_HTTP_INTENT')
        self.dispatch_us=int(self.sql('select(extract(epoch from clock_timestamp())*1000000)::bigint;'))
        self.save('d03-http-dispatch-private.json',{'databaseDispatchUs':self.dispatch_us,'scopeId':review.scope_id,
            'payloadSha256':sha(self.executor.review_payload_bytes(review)),
            'expectedRpcQuerySha256':reviewed_rpc(self.readonly.exact(self.authority.rpc_review_bytes))['querySha256'],
            'userId':review.reviewer_id,'sessionId':review.original_session_id,'originalJWTVerified':True})
        child=OriginalHTTPChild(self);self.children.append(child);self.http_child=child;return child

    def activity(self):
        return self.readonly.exact(self.sql("select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'backendStart',backend_start,'queryStartUs',(extract(epoch from query_start)*1000000)::bigint,'xactStartUs',(extract(epoch from xact_start)*1000000)::bigint,'state',state,'waitEventType',wait_event_type,'blockingPids',pg_blocking_pids(pid),'query',query,'querySha256',encode(sha256(convert_to(query,'UTF8')),'hex'))order by pid),'[]'::jsonb)from pg_stat_activity where datname=current_database()and pid<>pg_backend_pid();"))

    def verify_waiter_binding(self,review,holder,sample):
        need(type(sample)is dict and set(sample)=={'pid','backendStart','queryStartUs','xactStartUs','observedUs','waitEventType','blockingPids'}
             and type(sample['pid'])is int and sample['pid']>0 and sample['pid']!=holder['pid']
             and type(sample['backendStart'])is str,'D03_EXACT_WAITER')
        self.http_backend={'pid':sample['pid'],'backendStart':sample['backendStart']}
        rows=self.activity();self.save('d03-activity-blocked-private.json',rows)
        contract=reviewed_rpc(self.readonly.exact(self.authority.rpc_review_bytes))
        d=int(self.sql('select(extract(epoch from review_deadline_at)*1000000)::bigint from public.appointments where id='+self.executor.uid(review.appointment_id)+';'))
        need(self.http_child is not None and self.auth_verified is True,'D03_ROOT_HTTP_CONTEXT')
        result=correlated_waiter(rows,holder,sample,contract,self.dispatch_us,d)
        self.save('d03-rpc-correlation-private.json',result);sample['deadlineUs']=d

    def close_owned_children(self):
        errors=[]
        for child in self.children:
            try:child.close()
            except BaseException as error:errors.append(type(error).__name__)
        need(not errors,'D03_OWNED_CHILD_CLOSE_FAILED')

    def verify_owned_backends_absent(self):
        q=self.core.ai.quote
        for child in self.children:
            if isinstance(child,PsqlHolder):
                need(child.closed and child.proc is not None and child.proc.poll()is not None,'D03_RAW_PSQL_LEADER_NOT_REAPED')
                if child.persistent:need(child.backend is not None,'D03_HOLDER_BACKEND_IDENTITY_UNPROVEN')
                try:os.killpg(child.proc.pid,0)
                except ProcessLookupError:pass
                else:raise ValueError('D03_RAW_PSQL_PROCESS_GROUP_REMAINS')
        for backend in self.backend_ids:
            need(self.sql('select count(*)from pg_stat_activity where pid='+str(backend['pid'])+' and backend_start='+q(backend['backendStart'])+'::timestamptz;')=='0','D03_OWN_RAW_PSQL_BACKEND_STILL_PRESENT')
        if self.http_child is not None and self.http_dispatched:
            need(self.http_backend is not None,'D03_HTTP_BACKEND_NOT_IDENTIFIED')
            rows=self.activity();self.save('d03-http-transaction-final-private.json',rows)
            proof=pooled_transaction_closed(rows,self.http_backend,self.readonly.exact(self.authority.rpc_review_bytes),
                not self.http_child.thread.is_alive()and self.http_child.response_closed is True)
            self.save('d03-http-transaction-closure-private.json',proof)
        elif self.http_child is not None:
            need(not self.http_child.thread.is_alive(),'D03_UNDISPATCHED_WORKER_STILL_LIVE')
            self.save('d03-http-no-dispatch-private.json',{'httpDispatched':False,'workerClosed':True,'automaticReplay':False,
                'poolTransactionCreated':False})
        self.save('d03-owned-backends-closure-private.json',{'remainingOwnBackends':[],
            'remainingOwnBackendsScope':'RAW_PSQL_OWNED_ONLY','backendTerminated':False})

    def cleanup_fixture(self,review):
        # 고정 7관계 밖의 cascade 후보가 있으면 정리를 중단한다.
        p=predicates(review)
        # 후기/신고/완료확인 등 예상하지 않은 관계는 cascade로 지우지 않는다.
        aid=self.executor.uid(review.appointment_id)
        need(self.sql('select(select count(*)from public.appointment_reviews where appointment_id='+aid+')+(select count(*)from public.appointment_disputes where appointment_id='+aid+')+(select count(*)from public.appointment_completion_confirmations where appointment_id='+aid+');')=='0','D03_UNREVIEWED_CLEANUP_RELATION')
        order=('private.conversation_generation_appointments','private.appointment_member_episodes','public.appointments',
               'public.notifications','private.conversation_retention_generations','public.join_requests','public.posts')
        need(hasattr(self,'summary_fixture_origin'),'D03_SUMMARY_ORIGIN_REQUIRED')
        ids=','.join(self.executor.uid(u)for u in sorted((review.author_id,review.reviewer_id)))
        prefix="begin;set local statement_timeout='5s';set local lock_timeout='1s';lock table private.review_summary_state,private.review_refresh_outbox,private.review_summary_checkpoints in share row exclusive mode;do $d03empty$ begin "
        for table in('review_summary_state','review_refresh_outbox','review_summary_checkpoints'):
            prefix+="if exists(select 1 from private."+table+' where profile_id in('+ids+"))then raise exception 'd03_summary_predelete_not_empty';end if;"
        self.sql(prefix+'end $d03empty$;'+''.join('delete from '+t+' where '+p[t]+';'for t in order)+'commit;')
        origin=self.readonly.exact(self.summary_fixture_origin)
        observed=self.readonly.exact(self.sql(self.summary_origin_sql()))
        validate_summary_cleanup(origin,observed,(review.author_id,review.reviewer_id))
        self.save('d03-summary-cleanup-candidate-private.json',observed)
        # 정확 관측 payload를 같은 트랜잭션에서 다시 비교한다. 조건이 달라지면 삭제 0/rollback.
        q=self.core.ai.quote;ids=','.join(self.executor.uid(u)for u in sorted((review.author_id,review.reviewer_id)))
        script="begin;set local statement_timeout='5s';set local lock_timeout='1s';lock table private.review_summary_state,private.review_refresh_outbox,private.review_summary_checkpoints in share row exclusive mode;do $d03summary$ begin "
        for key,table in(('state','review_summary_state'),('outbox','review_refresh_outbox'),('checkpoints','review_summary_checkpoints')):
            expected=q(canonical(observed[key]).decode())+'::jsonb'
            script+="if(select coalesce(jsonb_agg(to_jsonb(t)order by profile_id),'[]'::jsonb)from private."+table+' t where profile_id in('+ids+'))is distinct from '+expected+" then raise exception 'd03_summary_payload_changed';end if;"
        script+='end $d03summary$;'
        for table in('review_refresh_outbox','review_summary_state'):
            script+='delete from private.'+table+' where profile_id in('+ids+');'
        self.sql(script+'commit;')
        final=self.readonly.exact(self.sql(self.summary_origin_sql()))
        need(all(final[k]==[]for k in('state','outbox','checkpoints')),'D03_SUMMARY_CLEANUP_REMAINS')
        self.save('d03-summary-cleanup-proof-private.json',{'originSha256':sha(self.summary_fixture_origin),
            'candidateSha256':sha(canonical(observed)),'final':final,'existingRowsDeleted':False})


    def prepare_fast_phase(self,review):return FastSourceSeal(self,review)
    def run_fast_phase(self,seal):return run_sealed_fast_phase(self,seal)

    def close(self,original_error=None):
        errors=[];readonly_closed=True
        try:self.assert_readonly_closed()
        except BaseException:
            readonly_closed=False;errors.append('D03_READONLY_CLOSURE_STICKY')
        self.core.done.set()
        if self.core.thread is not None:
            self.core.thread.join(timeout=4)
            if self.core.thread.is_alive():errors.append('D03_MEMORY_MONITOR_STILL_LIVE')
        if self.core.failures:errors.append('D03_LATE_MEMORY_MONITOR_FAILURE')
        if self.raw_sticky:errors.append('D03_RAW_CLOSURE_STICKY')
        anchor=getattr(self,'binding_anchor',None)
        if anchor is not None:
            try:
                if readonly_closed and not self.raw_sticky:anchor.check()
            except BaseException as error:errors.append('D03_FINAL_BINDING_'+type(error).__name__)
            finally:anchor.close();self.binding_anchor=None
        if hasattr(self.core,'source_seal'):
            try:
                if readonly_closed and not self.raw_sticky and not errors:self.core.source_seal.finish()
            except BaseException as error:errors.append('D03_FINAL_SOURCE_'+type(error).__name__)
            finally:self.core.source_seal.close()
        if self.core.evidence_owned:
            try:self.save('d03-runtime-final-status-private.json',{'originalFailureType':None if original_error is None else type(original_error).__name__,
                'monitorFailures':list(self.core.failures),'rawSticky':list(self.raw_sticky),'finalErrors':errors,
                'successReturnPermitted':original_error is None and not errors})
            except BaseException as error:errors.append(type(error).__name__)
        if errors:
            if original_error is not None:original_error.add_note('D03_FINALIZATION_UNPROVEN:'+','.join(errors))
            else:raise ValueError('D03_FINALIZATION_UNPROVEN:'+','.join(errors))


def reconstruct_service_review(ro,value):
    need(type(value)is dict and 'currentProfile'in value,'D03_CURRENT_PROFILE_REQUIRED')
    cp=value['currentProfile']
    profile=ro.ReviewedCurrentServiceProfile(cp['sourceHead'],cp['migrationEntriesSha256'],cp['versions'],cp['expectedTables'],cp['fullTableSetSha256'])
    return ro.ReviewedServiceProfileReadonly(value['decisionId'],value['root'],value['sourceHead'],value['pins'],
        value['bindingSha256'],value['auth6Receipt'],value['auth6ReceiptSha256'],value['capsuleRoot'],value['nodePath'],
        value['nodeSha256'],value['scopeId'],value['daemonId'],value['runtimeIdentity'],profile)


def run_reviewed(authority):
    need(type(authority)is ReviewedDeadlineAuthority,'D03_TYPED_RUNTIME_AUTHORITY_REQUIRED')
    need(type(authority.service_descriptor_bytes)is bytes and type(authority.execution_descriptor_bytes)is bytes
         and type(authority.owned_source_pins_bytes)is bytes,'D03_IMMUTABLE_REVIEW_BYTES')
    owned=json.loads(authority.owned_source_pins_bytes);value=json.loads(authority.service_descriptor_bytes)
    verify_own_sources(value['sourceHead'],owned)
    ro=load(READONLY,owned[READONLY]);execution=load(EXECUTOR,owned[EXECUTOR])
    review=execution.ReviewedDeadlineExecution(**ro.exact(authority.execution_descriptor_bytes));review.validate()
    need(review.source_head==value['sourceHead']and review.binding_sha==value['bindingSha256']
         and review.original_receipt_sha==value['auth6ReceiptSha256']and review.source_pins_sha==sha(ro.canonical(value['pins']))
         and review.scope_id==value['scopeId']and review.decision_id==value['decisionId'],'D03_REVIEW_INPUT_MISMATCH')
    reviewed_rpc(ro.exact(authority.rpc_review_bytes))
    service=reconstruct_service_review(ro,value)
    old_path=list(sys.path);old_runner=sys.modules.get('run_database_tests');runtime=None;original_error=None
    try:
        sys.modules['run_database_tests']=ro.load('tools/local/run_database_tests.py',value['pins']['tools/local/run_database_tests.py'])
        with ro.current_support(value['pins']):
            try:
                runtime=FixedDeadlineRuntime(authority,ro,execution,service,review)
                runtime.bind()
                fast_review=ReviewedD03FastPhase(authority.fast_phase_review_bytes)
                return execution.ReviewedFastDeadlineExecutor(review,runtime,fast_review).run()
            except BaseException as error:
                original_error=error
                raise
            finally:
                if runtime is not None:runtime.close(original_error)
    finally:
        sys.path[:]=old_path
        if old_runner is None:sys.modules.pop('run_database_tests',None)
        else:sys.modules['run_database_tests']=old_runner


if __name__=='__main__':
    print(json.dumps({'status':'NOT_RUN','reason':'새 freshsource root typed review 없이는 실행하지 않습니다.'},ensure_ascii=False))

# 공식 v16 계약: connection role→impersonated role→hoisted function 설정,
# 그 뒤 pre-request hook이 설정을 바꿀 수 있다. catalog 역할값만 실효값으로 승격하지 않는다.
POSTGREST_V16_BASIS=(
 'https://docs.postgrest.org/en/v16/references/transactions.html#impersonated-role-settings',
 'https://docs.postgrest.org/en/v16/references/transactions.html#hoisted-function-settings',
 'https://docs.postgrest.org/en/v16/references/transactions.html#pre-request',
 'https://github.com/PostgREST/postgrest/releases/tag/v16.1')

@dataclass(frozen=True)
class ReviewedD03FastPhase:
    """root가 실제 preflight 원자료를 읽은 뒤 봉인한다. 관측으로 자동 생성하지 않는다."""
    sealed: bytes
    def descriptor(self):
        need(type(self.sealed)is bytes,'D03_FAST_REVIEW_BYTES')
        value=json.loads(self.sealed)
        need(type(value)is dict and set(value)=={'scope','sourceHead','preparedRoot','decisionId','timeoutPreflightSha256',
             'effectiveStatementTimeoutMs','effectiveLockTimeoutMs','expectedRpcQuerySha256','basisUrls'}
             and value['scope']=='SEALED_D03_POSTGREST_EIGHT_SECOND_PHASE'
             and re.fullmatch('[a-f0-9]{40}',value['sourceHead'])and re.fullmatch('[a-f0-9]{64}',value['timeoutPreflightSha256'])
             and value['effectiveStatementTimeoutMs']==8000 and value['effectiveLockTimeoutMs']==8000
             and type(value['effectiveStatementTimeoutMs'])is int and type(value['effectiveLockTimeoutMs'])is int
             and value['basisUrls']==list(POSTGREST_V16_BASIS),'D03_FAST_EXPLICIT_ROOT_REVIEW')
        return value


def collect_timeout_preflight(runtime):
    """읽기 원자료만 수집한다. root 검토나 실효 timeout을 자동 판정하지 않는다."""
    runtime.guard(runtime.review)
    roles=runtime.readonly.exact(runtime.sql("select coalesce(jsonb_agg(jsonb_build_object('database',d.datname,'role',r.rolname,'settings',s.setconfig)order by s.setdatabase,s.setrole),'[]'::jsonb)from pg_db_role_setting s left join pg_roles r on r.oid=s.setrole left join pg_database d on d.oid=s.setdatabase where(s.setdatabase=0 or d.datname=current_database())and(s.setrole=0 or r.rolname in('authenticated','authenticator'));"))
    routines=runtime.readonly.exact(runtime.core.port.read_sql("select coalesce(jsonb_agg(jsonb_build_object('identity',p.oid::regprocedure::text,'config',p.proconfig,'definition',pg_get_functiondef(p.oid))order by p.oid),'[]'::jsonb)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_'and n.nspname<>'information_schema'and p.prokind='f';"))
    rest=runtime.readonly.exact(runtime.core.r.call(['inspect',runtime.core.binding['containers']['rest']['id']]))[0]
    # DB_URI/JWT secret 등 비밀 환경 값은 이 별도 계약에 복사하지 않는다.
    allowed={'PGRST_DB_CONFIG','PGRST_DB_PRE_REQUEST','PGRST_DB_PRE_CONFIG','PGRST_DB_HOISTED_TX_SETTINGS','PGRST_DB_TX_END'}
    env=[entry for entry in rest['Config']['Env']if entry.split('=',1)[0]in allowed]
    from urllib.parse import urlsplit,parse_qs
    values={entry.split('=',1)[0]:entry.split('=',1)[1]for entry in rest['Config']['Env']if'='in entry}
    uri_options=bool(parse_qs(urlsplit(values.get('PGRST_DB_URI','')).query).get('options'))or bool(values.get('PGOPTIONS'))
    value={'roles':roles,'routines':routines,'restId':rest['Id'],'restImage':rest['Image'],
        'restConfigSha256':sha(canonical(rest['Config'])),'selectedRestEnvironment':sorted(env),
        'unreviewedUriOptionsPresent':uri_options,'externalRestConfigMounts':bool(rest.get('Mounts')),
        'restCommand':rest['Config'].get('Cmd'),'restEntrypoint':rest['Config'].get('Entrypoint'),
        'sourceHead':runtime.review.source_head,'preparedRoot':str(runtime.core.root),'basisUrls':list(POSTGREST_V16_BASIS)}
    runtime.save('d03-timeout-preflight-private.json',value)
    runtime.guard(runtime.review)
    return value


def validate_narrow_dispatch(row,elapsed_us,claims):
    need(type(row)is dict and set(row)=={'databaseNowUs','deadlineUs'}and all(type(x)is int for x in row.values())
         and type(elapsed_us)is int and elapsed_us>=0,'D03_FAST_CLOCK_SHAPE')
    remaining=row['deadlineUs']-row['databaseNowUs']-elapsed_us
    need(2000000<=remaining<=6000000,'D03_FAST_WINDOW_NOT_PROVEN_NO_DISPATCH')
    need(type(claims.get('exp'))is int and claims['exp']*1000000>row['deadlineUs']+60000000,'D03_FAST_ORIGINAL_JWT_WINDOW')
    return remaining


def fast_source_bytes(path,stamp):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    signature=lambda st:(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns)
    with os.fdopen(fd,'rb')as stream:
        need(signature(os.fstat(stream.fileno()))==stamp[:4],'D03_FAST_SOURCE_FD_CHANGED')
        raw=stream.read(stamp[2]+1)
        need(signature(os.fstat(stream.fileno()))==stamp[:4]and signature(path.lstat())==stamp[:4]
             and not path.is_symlink(),'D03_FAST_SOURCE_FD_CHANGED')
    return raw


class FastSourceSeal:
    """full guard로 검토한 bytes를 매 빠른 경계에서 재해시한다. 일반 guard 우회 포트가 아니다."""
    def __init__(self,runtime,profile):
        need(type(profile)is ReviewedD03FastPhase,'D03_FAST_TYPED_REVIEW_REQUIRED')
        self.profile=profile.descriptor();self.runtime=runtime;self.started=None;self.prepared=time.monotonic()
        self.review=runtime.review;self.executor=runtime.executor;self.core=runtime.core;self.account=runtime.account
        self.children=runtime.children;self.backend_ids=runtime.backend_ids;self.cleaning=False
        r=runtime.review;v=runtime.value
        need(self.profile['sourceHead']==r.source_head and self.profile['preparedRoot']==str(runtime.core.root)
             and self.profile['decisionId']==r.decision_id
             and self.profile['expectedRpcQuerySha256']==runtime.readonly.exact(runtime.authority.rpc_review_bytes)['querySha256'],
             'D03_FAST_REVIEW_TARGET_MISMATCH')
        runtime.guard(r)
        observed=collect_timeout_preflight(runtime)
        need(not observed['unreviewedUriOptionsPresent']and not observed['externalRestConfigMounts'],'D03_FAST_EXTERNAL_CONFIG_UNPROVEN')
        need(sha(canonical(observed))==self.profile['timeoutPreflightSha256'],'D03_FAST_TIMEOUT_REVIEW_MISMATCH')
        self.pins={**v['pins'],**runtime.own_pins}
        self.binding_raw=runtime.core.read(runtime.core.root/'signed-ai-binding-private.json')
        self.identities=runtime.readonly.exact(runtime.core.r.call(['inspect',*[x['id']for x in runtime.core.binding['containers'].values()]]))
        self.sources={}
        for relative,pin in self.pins.items():
            path=ROOT/relative;st=path.lstat();raw=path.read_bytes()
            need(not path.is_symlink()and sha(raw)==pin,'D03_FAST_CAPTURED_SOURCE_CHANGED')
            self.sources[relative]=(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,pin)
        runtime.guard(r)
        need(len(self.identities)==4 and {x['Id']for x in self.identities}=={x['id']for x in runtime.core.binding['containers'].values()},'D03_FAST_EXACT_FOUR_IDENTITY')
        runtime.save('d03-fast-pre-seal-private.json',{'sourceHead':r.source_head,'capturedSourceSetSha256':sha(canonical(self.sources)),
            'ownFourIds':sorted(x['Id']for x in self.identities),'ownFourIdentitySha256':sha(canonical(self.identities)),
            'originalBindingSha256':sha(self.binding_raw),'timeoutPreflightSha256':self.profile['timeoutPreflightSha256'],
            'fullPreGuardCompleted':True,'requiredFullPostGuard':True,'memoryFreshnessSeconds':3})
    def enter(self):
        need(self.started is None,'D03_FAST_NO_REPLAY')
        self.started=time.monotonic();self.guard(self.runtime.review)
    def guard(self,review,cleanup=False):
        need(review==self.runtime.review and (time.monotonic()-self.prepared<=900 if self.started is None else time.monotonic()-self.started<=8),
             'D03_FAST_OBSERVATION_EXPIRED')
        c=self.runtime.core
        need(not self.runtime.raw_sticky and not c.failures and self.runtime.memory_last is not None
             and time.monotonic()-self.runtime.memory_last<=3,'D03_FAST_MEMORY_OR_CLOSURE_UNPROVEN')
        need(self.runtime.original_binding_bytes()==self.binding_raw,'D03_FAST_ORIGINAL_JWT_BYTES_CHANGED')
        for relative,stamp in self.sources.items():
            path=ROOT/relative;st=path.lstat()
            need(not path.is_symlink()and (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns)==stamp[:4]
                 and sha(fast_source_bytes(path,stamp))==stamp[4],'D03_FAST_SOURCE_CHANGED')
        need(subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=1).strip()==review.source_head,
             'D03_FAST_HEAD_CHANGED')
    def save(self,*args):return self.runtime.save(*args)
    def finish_raw_backend(self,command):return self.runtime.finish_raw_backend(command)
    def mark_raw_unclosed(self,*args):return self.runtime.mark_raw_unclosed(*args)
    def verify_dispatch_window(self):
        elapsed=int((time.monotonic()-self.clock_probe_started)*1000000)+1
        self.save('d03-fast-dispatch-clock-private.json',{**self.clock,'elapsedUs':elapsed,'automaticReplay':False})
        claims=self.core.ai.signed_claims(self.account['accessToken'])
        validate_narrow_dispatch(self.clock,int((time.monotonic()-self.clock_probe_started)*1000000)+1,claims)
        self.runtime.dispatch_us=self.clock['databaseNowUs'];self.runtime.http_dispatched=True


class FastReadObserver(PsqlHolder):
    """긴 준비 대기와 8초 관측만 수행하는 별도 read-only 연결. JWT GUC를 만들지 않는다."""
    def __init__(self,owner):
        # 고정 opening SQL만 대체한다. 일반 raw SQL constructor의 실행 권한을 확장하지 않는다.
        self.observer_owner=owner
        original=owner.executor
        class ObserverSQL:
            @staticmethod
            def holder_open_sql(review):
                return "begin read only;set local statement_timeout='390s';set local idle_in_transaction_session_timeout='390s';select json_build_object('pid',pg_backend_pid(),'backendStart',backend_start)from pg_stat_activity where pid=pg_backend_pid();\n"
        owner.executor=ObserverSQL
        try:super().__init__(owner,label='fast-observer')
        finally:owner.executor=original
    def query_json(self,sql,seconds=2):
        self.send(sql+';\n');return self.next_json(seconds)


def fast_activity_sql():
    return "select pg_stat_clear_snapshot();select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'backendStart',backend_start,'queryStartUs',(extract(epoch from query_start)*1000000)::bigint,'xactStartUs',(extract(epoch from xact_start)*1000000)::bigint,'observedUs',(extract(epoch from clock_timestamp())*1000000)::bigint,'state',state,'waitEventType',wait_event_type,'blockingPids',pg_blocking_pids(pid),'query',query,'querySha256',encode(sha256(convert_to(query,'UTF8')),'hex'))order by pid),'[]'::jsonb)from pg_stat_activity where datname=current_database()and pid<>pg_backend_pid()"


def classify_fast_result(response,query_start_us,deadline_us,release_us):
    body=response.get('body',{})
    valid=(type(query_start_us)is int and type(deadline_us)is int and type(release_us)is int
           and query_start_us<deadline_us<=release_us and release_us-query_start_us<7000000
           and response.get('status')==400 and body.get('code')=='22023'and body.get('message')=='review_unavailable')
    return {'status':'REPRODUCED_CORRELATED_DB_ENTRY_ONLY'if valid else'NOT_PROVEN',
        'scope':'CORRELATED_POSTGREST_DB_ENTRY_ONLY','httpIngressProven':False,'DBJWTclaimDirectObserved':False,
        'policyComplete':False,'timeoutBudgetMs':8000,'requiredMarginMs':1000,
        'releaseMarkerMeaning':'ACTUAL_COMMIT_COMPLETED_UPPER_BOUND','automaticReplay':False}


def run_sealed_fast_phase(runtime,seal):
    need(type(seal)is FastSourceSeal and seal.runtime is runtime,'D03_FAST_SEALED_CONTEXT_REQUIRED')
    holder=observer=request=None;result=None;original=None
    try:
        runtime.guard(runtime.review)
        holder=PsqlHolder(runtime);hid=holder.identity()
        runtime.save('d03-holder-private.json',hid)
        # DB 자체가 D 이후 commit하도록 먼저 예약한다. 느린 host 검토가 release를 지연하지 않는다.
        holder.send(runtime.executor.fast_holder_release_sql(runtime.review))
        observer=FastReadObserver(seal);observer.identity()
        runtime.guard(runtime.review)
        aid=runtime.executor.uid(runtime.review.appointment_id)
        # 이 대기는 읽기 전용 observer에서 실행한다. DB/역할/정책 TTL을 수정하지 않는다.
        wait="select pg_sleep(greatest(0,extract(epoch from(review_deadline_at-clock_timestamp()))-5))from public.appointments where id="+aid+";select json_build_object('ready',true)"
        observer.query_json(wait,seconds=330)
        seal.enter()
        seal.clock_probe_started=time.monotonic()
        seal.clock=observer.query_json("select json_build_object('databaseNowUs',(extract(epoch from clock_timestamp())*1000000)::bigint,'deadlineUs',(extract(epoch from review_deadline_at)*1000000)::bigint)from public.appointments where id="+aid)
        runtime.save('d03-fast-window-private.json',seal.clock)
        # 원 요청·query fingerprint의 권한 원천은 root literal이며 응답으로 승격하지 않는다.
        contract=reviewed_rpc(runtime.readonly.exact(runtime.authority.rpc_review_bytes))
        runtime.save('d03-fast-http-intent-private.json',{'userId':runtime.review.reviewer_id,
            'sessionId':runtime.review.original_session_id,'payloadSha256':sha(runtime.executor.review_payload_bytes(runtime.review)),
            'expectedQuerySha256':contract['querySha256'],'singleRequest':True})
        need(runtime.http_child is None and runtime.auth_verified,'D03_FAST_ORIGINAL_AUTH_OR_SINGLE_INTENT')
        request=OriginalHTTPChild(seal);runtime.children.append(request);runtime.http_child=request
        sample=None
        while time.monotonic()-seal.started<7:
            if request.error is not None:raise request.error
            rows=observer.query_json(fast_activity_sql())
            runtime.save('d03-fast-activity-'+str(runtime.raw_discharge_index)+'-'+str(int(time.monotonic()*1000000))+'.json',rows)
            waiters=[r for r in rows if hid['pid']in r['blockingPids']]
            need(len(waiters)<=1,'D03_FAST_AMBIGUOUS_HOLDER_WAITERS')
            if waiters:
                sample={k:waiters[0][k]for k in ('pid','backendStart','queryStartUs','xactStartUs','observedUs','waitEventType','blockingPids')}
                runtime.http_backend={'pid':sample['pid'],'backendStart':sample['backendStart']}
                correlated_waiter(rows,hid,sample,contract,runtime.dispatch_us,seal.clock['deadlineUs'])
                break
        need(sample is not None,'D03_FAST_WAITER_NOT_PROVEN')
        # observer가 확인한 queryStart부터 7초보다 짧게 release됐을 때만 업무 거절로 판정한다.
        request.finish()
        release=holder.next_json(2)
        runtime.save('d03-fast-release-private.json',release)
        need(type(release)is dict and set(release)=={'releasedUs','actualCommitCompletedUpperBound'}
             and release['actualCommitCompletedUpperBound']is True,'D03_FAST_COMMIT_UPPER_BOUND_UNPROVEN')
        result=classify_fast_result(request.result,sample['queryStartUs'],seal.clock['deadlineUs'],release['releasedUs'])
        runtime.save('d03-fast-proof-private.json',result)
    except BaseException as error:
        original=error
        runtime.save('d03-fast-observation-not-proven-private.json',{'status':'NOT_PROVEN','errorType':type(error).__name__,
            'httpDispatched':runtime.http_dispatched,'automaticReplay':False})
        result={'status':'NOT_PROVEN','scope':'CORRELATED_POSTGREST_DB_ENTRY_ONLY','policyComplete':False,'httpIngressProven':False}
    finally:
        errors=[]
        for child in (request,observer,holder):
            if child is not None:
                try:child.close()
                except BaseException as error:errors.append(type(error).__name__)
        # fastphase의 성공/실패 모두 full postguard를 반드시 통과해야 한다.
        try:runtime.guard(runtime.review)
        except BaseException as error:errors.append(type(error).__name__)
        if errors:raise ValueError('D03_FAST_POST_GUARD_OR_CLOSURE_UNPROVEN')from original
    return result
