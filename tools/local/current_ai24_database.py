"""AI24 current124 전용 DB 접점. 역사121 포트와 일반 SQL 권한은 변경하지 않는다.

별도 root typed review가 필수다. 이전 issuer/assembly 호출자는 새 review를 추가해야
current lane을 실행할 수 있다. 배치는 각 표 관측을 하나의 RR snapshot으로 묶고
그 snapshot 전후에 전체 보존 검사를 수행한다. 실제 성능/자정 실행 증거는 아니다.
"""
import ast
import hashlib
import importlib.util
import itertools
import inspect
import types
import copy
import base64
from datetime import datetime,timezone,timedelta
import json
import os
import stat
from pathlib import Path
import re
import subprocess
import time
import uuid

SELF='tools/local/current_ai24_database.py'
PURE='tests/integration/minkyu/deadline_readonly_transport.py'
KERNEL='tests/integration/jonghyun/isolated_ai_contracts.py'

# 독립 검토할 고정 콜사이트 method AST. 새 source만으로 자동 확장하지 않는다.
REVIEWED_METHODS = {'tests/integration/jonghyun/isolated_ai_contracts.py|CurrentSignedMidnightRunner|validate_original_accounts': '444730d6ca812ac4aade13ddcc7baf19e71394e3956ed9248570ce2b24b31525',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedLifecycleProvisioningPorts|added_rows': '2c94f216b8ad913f4ba5ed6b80f52819403bdb1a1318f7ac4d3b8965113fa139',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedLifecycleProvisioningPorts|cleanup_audits': 'b4426b33406ae4366ee6faca078a5c3f9ce8ad22be2939d2cdbbae82bb71cb88',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedLifecycleProvisioningPorts|metadata_proof': '2964b8f8cd2924b0d63d05dbabc832685f7107d4932c005fa4ffea6538846906',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedLifecycleProvisioningPorts|snapshot': '81d0f0a88e4f96c4416fff6d708a62870d462ae83a19131534b8cc3fcc55fc53',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedSignedProvisioningPorts|added_rows': '737299db036c49aacafbf75f58a38b987424e46528a88446dccc9c185875aa55',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedSignedProvisioningPorts|closed_controls': '24dfe64a5fefeaf0cae3511d9cd6f29127854b90261daf4d9096521e94c52b56',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedSignedProvisioningPorts|empty_auth': 'ecc790a3d93237c01a537251f23c4a91fb6fb8f968994efa31775a776372a6e0',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedSignedProvisioningPorts|link_profile': '03e2c6b5bf8eef00af20337a5ed46c240284fe6b0c934b481a651546ab3d4bdd',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedSignedProvisioningPorts|resolve_email': '089d9d020e580661d888007ad09964e0010cfc365e2661e0c8c8517b9b87b773',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedSignedProvisioningPorts|session_proof': '68ba189687012538b58bdfdbf6d4769a5ff56268ffec56140ae2cf39f54ea3ba',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedSignedProvisioningPorts|snapshot': '4a831af8c1235201c2656b7b64d938a3b304ab2e100969f5e6c089459eb57ffd',
 'tests/integration/jonghyun/isolated_ai_contracts.py|FixedSignedProvisioningPorts|unlink_profile': 'cd15010f750bbf9f6a3405d303cde8015ac8129ee65eeef3351bcb63f5452077',
 'tests/integration/jonghyun/isolated_ai_contracts.py|Runner|digest': '9581fe6e1db67cf153879f4aef2c32a3d679923f4071c11fe66d03762948353c',
 'tests/integration/jonghyun/isolated_ai_contracts.py|SignedMidnightRunner|activate_fixture_registration': '61261ea26b8f3c570d39baaefc8f5b5ee0f7e62a769cc3c95484ff019e118d75',
 'tests/integration/jonghyun/isolated_ai_contracts.py|SignedMidnightRunner|budget': '778a06bd996daa13c18083387f9d85773a18ed1556946023fb7cddd789aeb74e',
 'tests/integration/jonghyun/isolated_ai_contracts.py|SignedMidnightRunner|counts': '709068a00b432eeb6c19436e92e2c1b206d8d635ab2794b2fac6c38e7c761c5a',
 'tests/integration/jonghyun/isolated_ai_contracts.py|SignedMidnightRunner|prepare_units': '0b5a6059ca0cd15e9c08f012d76d5ce0ddd860c5ec52670e473eb8ca7088da85',
 'tests/integration/jonghyun/isolated_ai_contracts.py|SignedMidnightRunner|snapshot': 'c67eea0eba9ca48f33d7c2476037c980fb62ad67974876f5a244613f71b40464',
 'tests/integration/jonghyun/isolated_ai_contracts.py|SignedMidnightRunner|unknown_rows': '61cc4d5ddd6edbda8873c9e5748f2aebf0fd252790603e7ad5f9c086cdc3d05b',
 'tests/integration/jonghyun/isolated_ai_contracts.py|SignedMidnightRunner|validate_original_accounts': '78479d8e982037beaac16b8faea75f0497c116d6e0b7b459a165373f9043682f',
 'tests/integration/jonghyun/isolated_ai_contracts.py|SignedRunner|clean': '25ed22464f0774e844e24850e9151f0bc43df2628f7f39d9e4563fbd30c64394',
 'tests/integration/jonghyun/isolated_ai_contracts.py|SignedRunner|protected_rows': '7652afea7f6446a39c491b98c3442eb0073ef629bbdb9b7b6b33b63e87138ceb',
 'tests/integration/jonghyun/isolated_ai_contracts.py|function|signed_verify_history': '2e3ad004c551cafbbff35ed518009da85d3a1980139bc525eb325f8253c33d74',
 'tools/local/prepare_isolated_midnight.py|FixedSignedMidnightPorts|authority_hashes': '936a2561186612ffb863ae0da1487a4442d9a8a1c0229c49d5df484eceeb271c',
 'tools/local/prepare_isolated_midnight.py|FixedSignedMidnightPorts|clock': '909594ab21a3741343b0bc1c4734cf26377ab6f1e9559f23a4c25c032de32312',
 'tools/local/prepare_isolated_midnight.py|FixedSignedMidnightPorts|effect_proof': '31d433c79e246dcdd2c39123a2f54f5d400e188e6d34054d6bd4f0c10b5fdb8c',
 'tools/local/prepare_isolated_midnight.py|FixedSignedMidnightPorts|headroom': '770ee80385bb49e53a66866d6755f10d4188491b130d25e624c98a9f7fd64787',
 'tools/local/prepare_isolated_midnight.py|FixedSignedMidnightPorts|original_rows': 'f56b1e8e8f5c47b02d47a6671cf1406dd1eaa926e63f35e274b1c4f5edb92f51',
 'tools/local/prepare_isolated_midnight.py|FixedSignedMidnightPorts|owned_metadata': '5ab8d894f17e14bacae498c890a46f5caf087414acbfc4fb4a13bb60d6863287',
 'tools/local/prepare_isolated_midnight.py|FixedSignedMidnightPorts|reservation_proof': 'c0c3791f9078b6cf9c3c13c1e3faf0fa69e3c3cb3d6783a8fd5856ac164a0ea2',
 'tools/local/prepare_isolated_midnight.py|FixedSignedMidnightPorts|snapshot': 'f57fe7bf328d2c242629fc10c510cc523d403c25fdcda690488d6b6519a05a27',
 'tools/local/prepare_isolated_midnight.py|FixedSignedMidnightPorts|verify_signed_auth': '22b0705b02072ec04d8ae13a3e0132c12f99f4deb3e48fda2b1c3b24dfb1a350',
 'tools/local/provision_current_midnight.py|Ports|clock': '622b7858e7022b91ae6b6eb3c480f87d96816335d7c981785a024300b210d554'}

def need(ok, code):
    if not ok:raise ValueError(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def quote(v):return "'"+str(v).replace("'","''")+"'"

class IssuerOperation:pass
class MidnightOperation:pass

class ReviewedCurrentAI24Database:
    def __init__(self,decision_id,operation,source_head,pins,profile,prepared_root,scope_id,containers,users=(),boundary_epoch=None):
        need(type(operation)in(IssuerOperation,MidnightOperation),'AI24_DB_TYPED_OPERATION')
        need(type(decision_id)is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}',decision_id),'AI24_DB_DECISION')
        need(type(profile)is dict and set(profile)=={'sourceHead','migrationEntriesSha256','versions','expectedTables','fullTableSetSha256'}
            and profile['sourceHead']==source_head and type(profile['versions'])is list and len(profile['versions'])==124
            and all(type(v)is str and re.fullmatch('[0-9]{14}',v)for v in profile['versions'])
            and profile['versions']==sorted(set(profile['versions'])) and re.fullmatch('[a-f0-9]{64}',profile['migrationEntriesSha256']),
            'AI24_DB_CURRENT124')
        tables=profile['expectedTables']
        need(type(tables)is list and len(tables)==182 and tables==sorted(set(tables))
            and all(re.fullmatch('(auth|public|private|storage|cron|vault)[.][A-Za-z_0-9]+',t)for t in tables)
            and sha(canonical(tables))==profile['fullTableSetSha256'],'AI24_DB_TABLE_PROFILE')
        need(type(source_head)is str and re.fullmatch('[a-f0-9]{40}',source_head)
            and {SELF,PURE,KERNEL}<=set(pins) and all(re.fullmatch('[a-f0-9]{64}',h)for h in pins.values()),'AI24_DB_SOURCE_PINS')
        root=Path(prepared_root)
        need(root.is_absolute()and root.resolve()==root and re.fullmatch('[A-Za-z0-9_.:-]{1,48}',scope_id),'AI24_DB_SCOPE')
        need(set(containers)=={'db','auth','rest','gateway'}and len({v['id']for v in containers.values()})==4
            and all(re.fullmatch('[a-f0-9]{64}',v['id'])for v in containers.values()),'AI24_DB_OWN_FOUR')
        need(type(users)in(list,tuple)and len(set(users))==len(users)
            and all(str(uuid.UUID(u))==u for u in users)
            and (len(users)==0 if type(operation)is IssuerOperation else len(users)==3),'AI24_DB_MEMBER_SCOPE')
        need((type(boundary_epoch)is int and (boundary_epoch+32400)%86400==0)if type(operation)is MidnightOperation else boundary_epoch is None or type(boundary_epoch)is int,'AI24_DB_SEALED_BOUNDARY')
        self.operation=type(operation)
        self._sealed=canonical(dict(decisionId=decision_id,sourceHead=source_head,pins=pins,profile=profile,
            root=str(root),scopeId=scope_id,containers=containers,users=list(users),boundaryEpoch=boundary_epoch))
    def descriptor(self):return json.loads(self._sealed)


def checked_source(repo,relative,head,pins):
    need(type(relative)is str and relative in (SELF,PURE,KERNEL,'tools/local/provision_current_midnight.py','tools/local/prepare_isolated_midnight.py'),'AI24_DB_FIXED_SOURCE_PATH')
    path=repo/relative;need(path.resolve()==path and not path.is_symlink(),'AI24_DB_SOURCE_PATH')
    need(subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True,timeout=15).strip()==head,'AI24_DB_HEAD_CHANGED')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd);need(stat.S_ISREG(before.st_mode)and before.st_size<=4*1024*1024,'AI24_DB_SOURCE_SIZE')
        raw=os.pread(fd,before.st_size+1,0);after=os.fstat(fd);current=path.lstat()
        signature=lambda s:(s.st_dev,s.st_ino,s.st_uid,s.st_gid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        need(signature(before)==signature(after)==signature(current)and len(raw)==before.st_size,'AI24_DB_SOURCE_CHANGED')
    finally:os.close(fd)
    need(sha(raw)==pins.get(relative),'AI24_DB_SOURCE_CHANGED')
    committed=subprocess.check_output(['git','-C',str(repo),'show',head+':'+relative],timeout=15)
    need(raw==committed,'AI24_DB_SOURCE_NOT_COMMITTED')
    need(subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True,timeout=15).strip()==head,'AI24_DB_HEAD_CHANGED')
    return raw

def pinned_module(repo,relative,head,pins):
    raw=checked_source(repo,relative,head,pins)
    module=importlib.util.module_from_spec(importlib.util.spec_from_loader('current_ai24_pure',loader=None))
    module.__file__=str(repo/relative);exec(compile(raw,module.__file__,'exec'),module.__dict__);return module


def static_query(raw,classname,method,ordinal):
    tree=ast.parse(raw);cls=next(n for n in tree.body if isinstance(n,ast.ClassDef)and n.name==classname)
    fn=next(n for n in cls.body if isinstance(n,ast.FunctionDef)and n.name==method)
    queries=[n.args[0].value for n in ast.walk(fn)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)
        and n.func.attr=='read_sql'and n.args and isinstance(n.args[0],ast.Constant)and type(n.args[0].value)is str]
    return queries[ordinal].strip().removesuffix(';')


def snapshot_queries(raw,operation,tables):
    roster="select jsonb_agg(jsonb_build_array(schemaname,tablename)order by schemaname,tablename)from pg_tables where schemaname in('auth','public','private','storage','cron','vault')"
    terms=[]
    for name in tables:
        schema,table=name.split('.');identifier=lambda x:'"'+x+'"'
        bag="select coalesce(jsonb_object_agg(h,n),'{}'::jsonb)from(select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')h,count(*)n from "+identifier(schema)+'.'+identifier(table)+' r group by 1)s'
        terms.append('select '+quote(name)+'::text table_name,('+bag+')bag')
    rows='select jsonb_object_agg(table_name,bag)from('+' union all '.join(terms)+')q'
    if operation is IssuerOperation:
        return {'tables':roster,'rows':rows,
            'authority':static_query(raw,'FixedSignedProvisioningPorts','snapshot',0),
            'constraints':static_query(raw,'FixedLifecycleProvisioningPorts','snapshot',0),
            'catalog':static_query(raw,'FixedLifecycleProvisioningPorts','snapshot',1)}
    return {'tables':roster,'rows':rows,'catalog':static_query(raw,'SignedMidnightRunner','snapshot',0),
        'authority':static_query(raw,'SignedMidnightRunner','snapshot',1)}


def decode_snapshot(value,operation,tables):
    expected={'tables','rows','authority','constraints','catalog'}if operation is IssuerOperation else {'tables','rows','authority','catalog'}
    need(type(value)is dict and set(value)==expected and all(type(v)is str for v in value.values()),'AI24_DB_SNAPSHOT_FIELDS')
    need(json.loads(value['tables'])==[x.split('.')for x in tables],'AI24_DB_TABLE_UNIVERSE')
    rows=json.loads(value['rows']);need(type(rows)is dict and sorted(rows)==tables,'AI24_DB_ROW_UNIVERSE')
    for bag in rows.values():need(type(bag)is dict and all(re.fullmatch('[a-f0-9]{64}',h)and type(n)is int and n>0 for h,n in bag.items()),'AI24_DB_ROW_BAG')
    if operation is IssuerOperation:
        authority=value['authority'].strip();need(re.fullmatch('[a-f0-9]{64}',authority),'AI24_DB_AUTHORITY_HASH')
        return {'rows':rows,'authoritySha256':authority,'constraintsSha256':sha(value['constraints'].strip().encode()),
            'catalogSha256':sha(value['catalog'].strip().encode())},rows
    hashes={k:sha(canonical(v))for k,v in rows.items()}
    return {'rows':hashes,'catalogSha256':sha(value['catalog'].strip().encode()),
        'rolesAclSha256':sha(value['authority'].strip().encode()),
        'unknownRows':{k:hashes[k]for k in ('private.ai_budget_reservations','private.ai_account_budget_reservations')},
        'sequence':'NOT_VERIFIED','physical':'NOT_VERIFIED'},rows


class FixedOperationRegistry:
    """기존 콜사이트의 고정 표현식만 재생성한다. 미해석 변수는 허용하지 않는다."""
    def __init__(self,raws):
        self.expressions=[]
        approved={
            'Runner':{'digest'},
            'SignedRunner':{'clean','protected_rows'},
            'CurrentSignedMidnightRunner':{'validate_original_accounts'},
            'SignedMidnightRunner':{'validate_original_accounts','activate_fixture_registration','prepare_units','snapshot','counts','budget','unknown_rows'},
            'FixedSignedProvisioningPorts':{'empty_auth','closed_controls','resolve_email','session_proof','link_profile','unlink_profile','snapshot','metadata_proof','added_rows'},
            'FixedLifecycleProvisioningPorts':{'metadata_proof','snapshot','cleanup_audits','added_rows'},
            'FixedSignedMidnightPorts':{'clock','verify_signed_auth','snapshot','headroom','original_rows','authority_hashes','reservation_proof','owned_metadata','effect_proof'},
            'Ports':{'clock'},
        }
        self.sites=[];self.bound=[];self.static_controls=None
        self.source_map={}
        methods=[]
        for raw,path in zip(raws,(KERNEL,'tools/local/provision_current_midnight.py','tools/local/prepare_isolated_midnight.py')):
            self.source_map[path]=raw
            for cls in ast.walk(ast.parse(raw)):
                if isinstance(cls,ast.ClassDef)and cls.name in approved:
                    selected=[n for n in cls.body if isinstance(n,ast.FunctionDef)and n.name in approved[cls.name]]
                    methods.extend(selected)
                    for method in selected:self.sites.append({'path':path,'class':cls.name,'method':method})
            if path==KERNEL:
                fn=next(n for n in ast.parse(raw).body if isinstance(n,ast.FunctionDef)and n.name=='signed_verify_history')
                self.sites.append({'path':path,'class':'function','method':fn})
                control=next(n for n in ast.parse(raw).body if isinstance(n,ast.Assign)and any(isinstance(x,ast.Name)and x.id=='PROVISION_CLOSED_CONTROLS'for x in n.targets))
                controls=ast.literal_eval(control.value);parts=[]
                for table in controls:
                    column='external_processing_allowed'if table=='ai_processing_guard'else'external_deletion_approved'if table=='member_cleanup_guard'else'enabled'
                    parts.extend((quote(table),'(select '+column+' from private.'+table+' where singleton)'))
                parts.extend(("'cronLaunchActiveJobs'","to_jsonb(current_setting('cron.launch_active_jobs'))"))
                self.static_controls='select jsonb_build_object('+','.join(parts)+');'
        self.coverage_keys=set()
        for site in self.sites:
            key=site['path']+'|'+site['class']+'|'+site['method'].name
            need(REVIEWED_METHODS.get(key)==sha(ast.dump(site['method'],include_attributes=False).encode()),'AI24_DB_UNREVIEWED_METHOD_AST')
            self.coverage_keys.add(key)
        self.coverage_complete=self.coverage_keys==set(REVIEWED_METHODS)
        for method in methods:
            for call in ast.walk(method):
                if isinstance(call,ast.Call)and isinstance(call.func,ast.Attribute)and call.func.attr in('sql','read_sql')and call.args:
                    expression=call.args[0]
                    # source 자체에 있는 순수 문자열 생성만 평가한다. self 메서드 호출은 금지한다.
                    calls=[n for n in ast.walk(expression)if isinstance(n,ast.Call)]
                    if all((isinstance(n.func,ast.Name)and n.func.id in('quote','str','int'))or
                           (isinstance(n.func,ast.Attribute)and n.func.attr in('join','dumps'))for n in calls):
                        self.expressions.append(compile(ast.Expression(expression),'<reviewed-fixed-sql>','eval'))
    def permits(self,query,owner,users,scope,epoch):
        ids=','.join(quote(u)+'::uuid'for u in users);ledger='signed-midnight-'+scope
        accounts=getattr(owner,'accounts',[])
        if type(accounts)is not list:accounts=[]
        contexts=[dict(self=owner,ids=ids,ledger=ledger,boundary=str(epoch),quote=quote,str=str,int=int,json=json)]
        for uid in users:
            for a in accounts or [{}]:contexts.append({**contexts[0],'uid':uid,'user_id':uid,'key':quote(uid)+'::uuid','a':a})
        for context in contexts:
            for code in self.expressions:
                try:expected=eval(code,{'__builtins__':{}},context)
                except (NameError,AttributeError,KeyError,TypeError):continue
                if type(expected)is str and expected==query:return True
        return False

    def bind(self,owner,repo,ai):
        """실제 캡처 함수의 code object와 globals identity를 같이 봉인한다."""
        namespaces=[];classes=list(type(owner).__mro__)
        if hasattr(ai,'__dict__'):namespaces.append(vars(ai))
        for cls in classes:
            for value in vars(cls).values():
                if isinstance(value,types.FunctionType):namespaces.append(value.__globals__)
        frame=inspect.currentframe()
        try:
            for _ in range(64):
                if frame is None:break
                namespaces.append(frame.f_globals);frame=frame.f_back
        finally:del frame
        compiled={}
        def walk(code):
            yield code
            for item in code.co_consts:
                if isinstance(item,types.CodeType):yield from walk(item)
        for path,raw in self.source_map.items():compiled[path]=list(walk(compile(raw,str(repo/path),'exec')))
        seen=set()
        for namespace in namespaces:
            if id(namespace)in seen:continue
            seen.add(id(namespace))
            path=namespace.get('__file__')
            if type(path)is not str:continue
            relative=next((p for p in self.source_map if str(repo/p)==path),None)
            if relative is None:continue
            values=list(namespace.values())+classes
            functions=[]
            for value in values:
                if isinstance(value,types.FunctionType):functions.append(value)
                elif isinstance(value,type):
                    for fn in vars(value).values():
                        if isinstance(fn,(staticmethod,classmethod)):fn=fn.__func__
                        if isinstance(fn,types.FunctionType):functions.append(fn)
            for fn in functions:
                if fn.__globals__ is not namespace:continue
                for site in self.sites:
                    method=site['method']
                    if site['path']!=relative or fn.__code__.co_firstlineno!=method.lineno or fn.__code__.co_name!=method.name:continue
                    need(any(fn.__code__==expected and fn.__code__.co_filename==expected.co_filename for expected in compiled[relative]),'AI24_DB_FUNCTION_NOT_CAPTURED')
                    for captured_code in walk(fn.__code__):self.bound.append((captured_code,namespace,site))
        self.manifest_sha=sha(canonical([{'path':x['path'],'class':x['class'],'method':x['method'].name,
            'astSha256':sha(ast.dump(x['method'],include_attributes=False).encode())}for x in self.sites]))
        need(any(x[2]['class']=='FixedSignedProvisioningPorts'for x in self.bound)
             or any(x[2]['class']=='SignedMidnightRunner'for x in self.bound),'AI24_DB_CAPTURED_OWNER_REQUIRED')

    def authorize(self,query,validate):
        frame=inspect.currentframe()
        try:
            for _ in range(64):
                if frame is None:break
                for code,namespace,site in self.bound:
                    if frame.f_code is not code or frame.f_globals is not namespace:continue
                    method=site['method']
                    for call in ast.walk(method):
                        if not(isinstance(call,ast.Call)and isinstance(call.func,ast.Attribute)and call.func.attr in('sql','read_sql')and call.args
                               and call.lineno<=frame.f_lineno<=call.end_lineno):continue
                        # 일반 forwarding 함수의 query 인자는 권한 근거가 아니다.
                        expression=copy.deepcopy(call.args[0]);assignments={}
                        for node in ast.walk(method):
                            if isinstance(node,ast.Assign)and node.lineno<call.lineno:
                                for target in node.targets:
                                    if isinstance(target,ast.Name):assignments[target.id]=node.value
                        original=expression
                        class Resolve(ast.NodeTransformer):
                            def __init__(self):self.busy=set()
                            def visit_Name(self,node):
                                if node.id in ('query','catalog','authority','source','metadata','ids','ledger','boundary','scope','condition','schemas')and node.id in assignments and node.id not in self.busy:
                                    self.busy.add(node.id);result=self.visit(copy.deepcopy(assignments[node.id]));self.busy.remove(node.id);return result
                                return node
                        expression=Resolve().visit(expression)
                        if isinstance(original,ast.Name)and original.id in ('query','catalog','authority')and original.id not in assignments:continue
                        scope_args=validate(frame.f_locals,expression,site)
                        if site['class']=='FixedSignedProvisioningPorts'and method.name=='closed_controls':
                            expected=self.static_controls
                        else:
                            calls=[n for n in ast.walk(expression)if isinstance(n,ast.Call)]
                            allowed=all((isinstance(n.func,ast.Name)and n.func.id in('quote','str','int','sorted'))or
                                (isinstance(n.func,ast.Attribute)and n.func.attr in('join','dumps','items','values','get'))for n in calls)
                            if not allowed:continue
                            env={**frame.f_locals,'quote':quote,'str':str,'int':int,'sorted':sorted,'json':json}
                            try:expected=eval(compile(ast.fix_missing_locations(ast.Expression(expression)),'<captured-fixed-expression>','eval'),{'__builtins__':{},**env},env)
                            except (NameError,AttributeError,KeyError,TypeError):continue
                        if type(expected)is str and expected==query:
                            return {'path':site['path'],'class':site['class'],'method':method.name,'line':call.lineno,
                                    'argumentAstSha256':sha(ast.dump(expression,include_attributes=False).encode()),'scopeArgs':scope_args}
                frame=frame.f_back
        finally:del frame
        raise ValueError('AI24_DB_UNAPPROVED_CALLSITE')


def free_names(node,bound=frozenset()):
    if isinstance(node,ast.Name):return set()if node.id in bound else{node.id}
    if isinstance(node,(ast.ListComp,ast.SetComp,ast.DictComp,ast.GeneratorExp)):
        names=set();scope=set(bound)
        for generator in node.generators:
            names.update(free_names(generator.iter,frozenset(scope)))
            scope.update(n.id for n in ast.walk(generator.target)if isinstance(n,ast.Name))
            for condition in generator.ifs:names.update(free_names(condition,frozenset(scope)))
        fields=(node.key,node.value)if isinstance(node,ast.DictComp)else(node.elt,)
        for field in fields:names.update(free_names(field,frozenset(scope)))
        return names
    names=set()
    for child in ast.iter_child_nodes(node):names.update(free_names(child,bound))
    return names


def owned_predicates(ids,ledger):
    return {'public.profiles':'r.id in('+ids+')','private.member_episodes':'r.profile_id in('+ids+')',
        'private.ai_member_processing':'r.user_id in('+ids+')','private.ai_member_daily_usage':'r.user_id in('+ids+')',
        'private.ai_chat_requests':'r.user_id in('+ids+')','private.ai_result_receipts':'r.user_id in('+ids+')',
        'private.ai_budget_ledgers':'r.ledger_id='+quote(ledger),
        'private.ai_budget_accounts':"r.account_id in('yumi','jonghyun','minkyu','sungho')",'private.ai_processing_guard':'true'}

def write_operation(match,query):
    cls,method=match['class'],match['method']
    if method in('digest','protected_rows')or query.strip().lower().startswith('select'):
        return {'kind':'readonly','tables':[]}
    if cls=='function'and method=='signed_verify_history':return {'kind':'readonly','tables':[]}
    if cls=='FixedSignedProvisioningPorts'and method in('link_profile','unlink_profile'):
        return {'kind':method,'tables':['public.profiles','private.member_episodes'],'users':match['scopeArgs']['writeUserIds']}
    if cls=='SignedMidnightRunner'and method=='activate_fixture_registration':
        return {'kind':'activate','tables':['private.ai_processing_guard','private.ai_budget_accounts']}
    if cls=='SignedMidnightRunner'and method=='prepare_units':
        if query.startswith('insert into private.ai_member_processing('):return {'kind':'processing','tables':['private.ai_member_processing']}
        if query.startswith('insert into private.ai_budget_ledgers('):return {'kind':'ledger','tables':['private.ai_budget_ledgers']}
    if cls=='SignedRunner'and method=='clean':
        if query.startswith('update private.ai_processing_guard '):return {'kind':'close_guard','tables':['private.ai_processing_guard']}
        if query.startswith('begin;delete from private.ai_result_receipts '):return {'kind':'cleanup_members','tables':['private.ai_result_receipts','private.ai_chat_requests','private.ai_member_daily_usage','private.ai_member_processing']}
        if query.startswith('update private.ai_budget_accounts '):
            account=query.split(' where account_id=',1)[1].removesuffix(';')
            return {'kind':'restore_account','tables':['private.ai_budget_accounts'],'accountId':account[1:-1],
                'registered':query.split('set registered=',1)[1].split(' ',1)[0]=='true'}
    raise ValueError('AI24_DB_WRITE_OPCODE_UNREVIEWED')

def subtract_bag(full,owned):
    result=dict(full)
    for h,n in owned.items():
        need(type(n)is int and n>0 and result.get(h,0)>=n,'AI24_DB_OWN_BAG_NOT_SUBSET')
        result[h]-=n
        if result[h]==0:del result[h]
    return result

def verify_write_state(before,after,operation,scope,users,initial_accounts):
    need(set(before['rows'])==set(after['rows']),'AI24_DB_WRITE_TABLE_UNIVERSE_CHANGED')
    for key,value in before['snapshot'].items():
        if key not in('rows','unknownRows'):need(after['snapshot'].get(key)==value,'AI24_DB_WRITE_AUTHORITY_CHANGED')
    allowed=set(operation['tables'])
    for table,bag in before['rows'].items():
        if table in allowed:
            need(subtract_bag(bag,before['owned'][table])==subtract_bag(after['rows'][table],after['owned'][table]),'AI24_DB_FOREIGN_WRITE_DELTA')
        else:need(after['rows'][table]==bag,'AI24_DB_UNEXPECTED_TABLE_DELTA')
    # 미확정 예약·90일 원장은 원장 자체의 신규1행 외에는 갱신·삭제하지 않는다.
    for table in ('private.ai_budget_reservations','private.ai_account_budget_reservations','private.ai_account_daily_budget','private.ai_global_daily_budget'):
        need(before['rows'][table]==after['rows'][table],'AI24_DB_UNKNOWN_OR_COMMITTED_BUDGET_CHANGED')
    kind=operation['kind'];expected=copy.deepcopy(before['flags'])
    if kind=='activate':
        for a in expected['accounts']:a['registered']=True
        for g in expected['guard']:g['external_processing_allowed']=True
    elif kind=='close_guard':
        for g in expected['guard']:g['external_processing_allowed']=False
    elif kind=='restore_account':
        baseline=next((a for a in initial_accounts if a['account_id']==operation['accountId']),None)
        need(baseline is not None and operation['registered']is baseline['registered'],'AI24_DB_ACCOUNT_RESTORE_NOT_BASELINE')
        for a in expected['accounts']:
            if a['account_id']==operation['accountId']:a['registered']=baseline['registered']
    need(after['flags']==expected,'AI24_DB_FLAG_FIELDS_CHANGED')
    if kind=='link_profile':
        need(sum(before['owned']['public.profiles'].values())+1==sum(after['owned']['public.profiles'].values())
            and sum(before['owned']['private.member_episodes'].values())+1==sum(after['owned']['private.member_episodes'].values()),'AI24_DB_PROFILE_LINK_DELTA')
    elif kind in('unlink_profile','cleanup_members'):
        need(all(not after['owned'][t]for t in operation['tables']),'AI24_DB_OWN_CLEANUP_REMAINS')
    elif kind=='processing':
        need(not before['owned']['private.ai_member_processing']and sum(after['owned']['private.ai_member_processing'].values())==len(users),'AI24_DB_PROCESSING_INSERT_DELTA')
    elif kind=='ledger':
        need(not before['owned']['private.ai_budget_ledgers']and sum(after['owned']['private.ai_budget_ledgers'].values())==1,'AI24_DB_LEDGER_INSERT_DELTA')


class CurrentDatabase:
    """각 SQL/배치의 원문·PG·backend 종결과 sticky를 소유한다. 일반 실행 CLI는 없다."""
    def __init__(self,repo,reviewed,ai,owner,save,guard,active_guard):
        need(type(reviewed)is ReviewedCurrentAI24Database,'AI24_DB_TYPED_REVIEW')
        self.value=reviewed.descriptor();self.reviewed=reviewed;self.repo=Path(repo);self.ai=ai;self.owner=owner
        self._save=save;self.guard=guard;self.active_guard=active_guard;self.sticky=False;self.inflight=False;self.counter=0;self.raw_sticky=[]
        self.base=tuple(owner.base);self.db=owner.target['id']
        need(self.db==self.value['containers']['db']['id']and Path(owner.root if hasattr(owner,'root')else owner.reviewed.prepared_root)==Path(self.value['root']), 'AI24_DB_OWNER_SCOPE')
        self.pure=pinned_module(self.repo,PURE,self.value['sourceHead'],self.value['pins'])
        checked_source(self.repo,SELF,self.value['sourceHead'],self.value['pins'])
        raw=checked_source(self.repo,KERNEL,self.value['sourceHead'],self.value['pins'])
        self.queries=snapshot_queries(raw,reviewed.operation,self.value['profile']['expectedTables'])
        raws=[raw]
        for path in ('tools/local/provision_current_midnight.py','tools/local/prepare_isolated_midnight.py'):
            need(path in self.value['pins'],'AI24_DB_CALLSITE_PIN')
            data=checked_source(self.repo,path,self.value['sourceHead'],self.value['pins']);raws.append(data)
        self.registry=FixedOperationRegistry(raws);self.registry.bind(owner,self.repo,ai)
        required_classes={'FixedSignedProvisioningPorts','FixedLifecycleProvisioningPorts','Ports','function'}if reviewed.operation is IssuerOperation else{'Runner','SignedRunner','SignedMidnightRunner','CurrentSignedMidnightRunner','FixedSignedMidnightPorts','function'}
        required={key for key in REVIEWED_METHODS if key.split('|')[1]in required_classes}
        bound={site['path']+'|'+site['class']+'|'+site['method'].name for _,_,site in self.registry.bound}
        need(self.registry.coverage_complete and required<=bound,'AI24_DB_CAPTURED_COVERAGE_INCOMPLETE')
        # pure child helper consumes only this explicit finite context, not a D03 authority object.
        self.core=type('CurrentActive',(),{'active':lambda _:self.active()})()
        self.original=self
        self.preparation_status={'executionAllowed':True,'actualMidnight':'NOT_RUN','writeCoverage':'REVIEWED_FIXED_CALLS_ONLY',
            'coverageVersion':'CURRENT124_FIXED_SQL_V1','fixedOperationManifestSha256':self.registry.manifest_sha,
            'remaining':['ACTUAL_PERFORMANCE_NOT_MEASURED','ACTUAL_NATURAL_MIDNIGHT_NOT_RUN']}
        self.users=list(self.value['users'])
        self.epoch=self.value['boundaryEpoch']
        if reviewed.operation is MidnightOperation:
            need(owner.boundary_epoch==self.epoch and owner.users==self.users and owner.all_users==self.users,'AI24_DB_SEALED_MEMBER_DAY')
        self.initial_accounts=None
        self.proof_refs={}
        self._coverage_proven=True
        self.binding_accounts_sha=sha(canonical(owner.binding['accounts']))if reviewed.operation is MidnightOperation else None
        observed=ai.signed_exact_json(owner.call(['inspect',self.db])if hasattr(owner,'call')else owner.runner.call(['inspect',self.db]))
        need(len(observed)==1 and observed[0]['Id']==self.db and observed[0]['HostConfig']['PidMode']=='','AI24_DB_PRIVATE_PID_NAMESPACE')
    def active(self):
        # 진행 중인 자기 자식은 허용한다. 외부 guard는 새 SQL을 실행하면 안 된다.
        self.active_guard()
    def assert_closed_state(self):
        need(not self.sticky,'AI24_DB_STICKY_NO_PORTS')
        native=Path(self.value['root'])/'native119-runtime-provenance.json'
        need(not native.exists()and not native.is_symlink(),'AI24_DB_CURRENT_NATIVE_HISTORY_UNSUPPORTED')
    def save(self,name,value):return self._save(name,value)
    def child(self,*args,**kwargs):return self.pure.ReviewedDeadlineReadonlyTransport.child(self,*args,**kwargs)
    def absent(self,marker,prefix):return self.pure.ReviewedDeadlineReadonlyTransport.absent(self,marker,prefix)
    def execute(self,body,timeout,read_only):
        self.assert_closed_state();self.guard();self.counter+=1;prefix='ai24-db-'+str(self.counter).zfill(5);self.sticky=True;self.inflight=True
        try:
            argv=list(self.base)+['exec','-i',self.db,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-f','-']
            self.save(prefix+'-intent.json',{'sqlUtf8':body.decode(),'sqlSha256':sha(body),'singleAttempt':True,'readOnly':read_only})
            raw=self.child(argv,body,timeout,prefix,4*1024*1024,65536)
            first,sep,result=raw.partition(b'\n');need(sep,'AI24_DB_BACKEND_MARKER')
            marker=self.ai.signed_exact_json(first)
            need(type(marker)is dict and set(marker)=={'pid','backendStart'}and type(marker['pid'])is int and 1<marker['pid']<2147483648
                and type(marker['backendStart'])is str and marker['backendStart'],'AI24_DB_BACKEND_MARKER')
            self.absent(marker,prefix);self.save(prefix+'-closed.json',{'backend':marker,'backendAbsent':True,'processGroupClosed':True})
            self.inflight=False;self.sticky=False;self.guard();return result.decode().strip()
        except BaseException:self.inflight=False;self.sticky=True;raise
    def marker(self):return "select json_build_object('pid',pg_backend_pid(),'backendStart',(select backend_start from pg_stat_activity where pid=pg_backend_pid()));\n"
    def _private(self,path,limit=1024*1024):
        root=Path(self.value['root']);need(path.parent==root/('ai24-provision-'+self.value['scopeId']),'AI24_DB_RECEIPT_PATH')
        root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        directory=None;fd=None
        try:
            directory=os.open(path.parent.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root_fd)
            fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
            before=os.fstat(fd)
            need(stat.S_ISREG(before.st_mode)and before.st_uid==os.getuid()and stat.S_IMODE(before.st_mode)==0o600
                and before.st_nlink==1 and before.st_size<=limit,'AI24_DB_RECEIPT_FILE')
            raw=os.pread(fd,before.st_size+1,0);after=os.fstat(fd)
            sig=lambda x:(x.st_dev,x.st_ino,x.st_uid,x.st_mode,x.st_nlink,x.st_size,x.st_mtime_ns,x.st_ctime_ns)
            need(sig(before)==sig(after)==sig(os.stat(path.name,dir_fd=directory,follow_symlinks=False))and len(raw)==before.st_size,'AI24_DB_RECEIPT_CHANGED')
            need(os.stat(root,follow_symlinks=False).st_ino==os.fstat(root_fd).st_ino
                and os.stat(path.parent.name,dir_fd=root_fd,follow_symlinks=False).st_ino==os.fstat(directory).st_ino,'AI24_DB_RECEIPT_PARENT_CHANGED')
            digest=sha(raw);old=self.proof_refs.get(str(path));need(old is None or old==digest,'AI24_DB_RECEIPT_REPLACED')
            self.proof_refs[str(path)]=digest;return self.ai.signed_exact_json(raw)
        finally:
            if fd is not None:os.close(fd)
            if directory is not None:os.close(directory)
            os.close(root_fd)

    def population(self):
        if self.reviewed.operation is MidnightOperation:
            accounts=self.owner.binding['accounts']
            need(sha(canonical(accounts))==self.binding_accounts_sha,'AI24_DB_BOUND_ACCOUNTS_CHANGED')
            need(len(accounts)==6 and {a['userId']for a in accounts}==set(self.users)
                and len({a['sessionId']for a in accounts})==6,'AI24_DB_BOUND_POPULATION')
            return self.users,accounts
        users=[];accounts=[];scope=self.value['scopeId'];root=Path(self.value['root'])/('ai24-provision-'+scope)
        for index in range(3):
            case='ai24-member-'+str(index);path=root/(case+'-created.json')
            if not path.exists():continue
            created=self._private(path);need(set(created)=={'userId','authEmail'},'AI24_DB_CREATED_RECEIPT')
            uid=created['userId'];need(str(uuid.UUID(uid))==uid,'AI24_DB_CREATED_UUID')
            email='synthetic-ai-'+scope+'-m'+str(index)+'@example.invalid'
            need(created['authEmail']==email,'AI24_DB_CREATED_EMAIL')
            outcome=self._private(root/(case+'-create-outcome.json'))
            response_path=root/(case+'-create-response-private.json')
            response=self._private(response_path)
            need(outcome['status']==200 and outcome['responseSha256']==self.proof_refs[str(response_path)]
                and outcome['capturedBeforeVerdict']is True and response.get('id')==uid and response.get('email')==email
                and response.get('role')=='authenticated'and response.get('is_anonymous')is False
                and response.get('user_metadata')=={'fixture_scope_id':scope,'fixture_case':case,'email_verified':True},'AI24_DB_CREATED_ORIGINAL_RESPONSE')
            users.append(uid)
            for role in ('primary','secondary'):
                proof_path=root/(case+'-'+role+'-issued.json')
                if not proof_path.exists():continue
                proof=self._private(proof_path);wire_path=root/(case+'-'+role+'-response-private.json');wire=self._private(wire_path)
                token=wire.get('access_token');need(type(token)is str and len(token)<=16384,'AI24_DB_ORIGINAL_TOKEN')
                parts=token.split('.');need(len(parts)==3,'AI24_DB_ORIGINAL_TOKEN')
                claims=self.ai.signed_exact_json(base64.urlsafe_b64decode(parts[1]+'='*((-len(parts[1]))%4)))
                need(proof['kind']=='GOTRUE_ORIGINAL_TOKEN_ISSUED'and proof['scopeId']==scope and proof['memberCase']==case
                    and proof['sessionRole']==role and proof['userId']==uid and proof['responseSha256']==self.proof_refs[str(wire_path)]
                    and proof['tokenSha256']==sha(token.encode())and proof['httpStatus']==200
                    and proof['authContainerId']==self.value['containers']['auth']['id']and proof['authImage']==self.value['containers']['auth']['image']
                    and claims.get('sub')==uid and claims.get('session_id')==proof['sessionId']and claims.get('email')==email
                    and type(claims.get('iat'))is int and type(claims.get('exp'))is int
                    and claims['exp']-claims['iat']==3600 and claims['iat']==proof['issuedAt']and claims['exp']==proof['expiresAt'], 'AI24_DB_SESSION_RECEIPT')
                accounts.append({'userId':uid,'sessionId':proof['sessionId'],'authEmail':email})
        need(len(set(users))==len(users)and len({a['sessionId']for a in accounts})==len(accounts),'AI24_DB_RECEIPT_POPULATION')
        return users,accounts

    def validate_context(self,context,expression,site):
        users,accounts=self.population();self.operation_users=users
        own=self.owner;caller=context.get('self');runner=context.get('runner')
        if self.reviewed.operation is IssuerOperation:
            need(site['class']in('FixedSignedProvisioningPorts','FixedLifecycleProvisioningPorts','Ports','function'),'AI24_DB_OPERATION_MODE')
        else:
            need(site['class']in('Runner','SignedRunner','SignedMidnightRunner','CurrentSignedMidnightRunner','FixedSignedMidnightPorts','function'),'AI24_DB_OPERATION_MODE')
        need(caller is own or getattr(caller,'runner',None)is own or runner is own or runner is getattr(own,'runner',None),'AI24_DB_SAME_CAPTURED_OWNER')
        if self.reviewed.operation is MidnightOperation:
            need(own.users==self.users and own.all_users==self.users and own.boundary_epoch==self.epoch,'AI24_DB_RUNTIME_SCOPE_CHANGED')
            if caller is not own and caller is not None:
                need(caller.contract['scopeId']==self.value['scopeId']and caller.contract['signedSelectedUserIds']==self.users
                    and {k:v for k,v in caller.contract['currentProfile'].items()if k!='memberSessions'}==self.value['profile']
                    and datetime.fromisoformat(caller.contract['boundary']).timestamp()==self.epoch,'AI24_DB_PARENT_SCOPE_CHANGED')
        names=free_names(expression)
        for name in ('uid','user_id'):
            if name in names:need(context.get(name)in users,'AI24_DB_FOREIGN_USER')
        if 'ids'in names:need(context.get('ids')==','.join(quote(u)+'::uuid'for u in users),'AI24_DB_FOREIGN_USER_LIST')
        if 'key'in names:
            need(context.get('key')in('id','reservation_id','ledger_id')or context.get('key')in[quote(u)+'::uuid'for u in users],'AI24_DB_FOREIGN_KEY')
        if 'email'in names:
            need(context.get('email')in['synthetic-ai-'+self.value['scopeId']+'-m'+str(i)+'@example.invalid'for i in range(3)],'AI24_DB_FOREIGN_EMAIL')
        if 'epoch'in names:need(context.get('epoch')==self.epoch,'AI24_DB_FOREIGN_EPOCH')
        if 'sid'in names:need(any(a['sessionId']==context.get('sid')and a['userId']==context.get('uid')for a in accounts),'AI24_DB_FOREIGN_SESSION')
        if 'day'in names:
            day=datetime.fromtimestamp(self.epoch,timezone(timedelta(hours=9))).date()
            need(context.get('day')in(str(day),str(day-timedelta(days=1))),'AI24_DB_FOREIGN_DAY')
        if 'scope'in names:need(context.get('scope')==self.value['scopeId'],'AI24_DB_FOREIGN_SCOPE')
        if 'case'in names:need(context.get('case')in['ai24-member-'+str(i)for i in range(3)],'AI24_DB_FOREIGN_CASE')
        if 'ledger'in names:need(context.get('ledger')=='signed-midnight-'+self.value['scopeId'],'AI24_DB_FOREIGN_LEDGER')
        if 'boundary'in names:need(context.get('boundary')==str(self.epoch),'AI24_DB_FOREIGN_BOUNDARY')
        if 'table'in names:need(context.get('table')in self.value['profile']['expectedTables']or context.get('table')in('ai_budget_ledgers','ai_budget_reservations','ai_account_budget_reservations'),'AI24_DB_FOREIGN_TABLE')
        if 't'in names:need(context.get('t')in('ai_budget_ledgers','ai_budget_reservations','ai_account_budget_reservations','ai_account_daily_budget','ai_global_daily_budget'),'AI24_DB_FOREIGN_PROTECTED_TABLE')
        if 'a'in names:
            a=context.get('a');need(type(a)is dict,'AI24_DB_ACCOUNT_ARGUMENT')
            if 'userId'in a:need(any(all(a.get(k)==b.get(k)for k in('userId','sessionId','authEmail'))for b in accounts),'AI24_DB_FOREIGN_SESSION')
            else:need(a in(self.initial_accounts or getattr(self.owner,'accounts',[])),'AI24_DB_UNJOURNALED_ACCOUNT_FLAGS')
        for name in ('accounts','created'):
            if name in names:
                records=context[name].values()if type(context[name])is dict else context[name]
                need(all(type(a)is dict and a.get('userId')in users and(a.get('sessionId')is None or any(a['userId']==b['userId']and a['sessionId']==b['sessionId']for b in accounts))for a in records),'AI24_DB_FOREIGN_METADATA')
        if 'condition'in names:
            conditions=context.get('conditions',{})
            need(type(conditions)is dict and context.get('table')in conditions and context['condition']==conditions[context['table']],'AI24_DB_FOREIGN_CONDITION')
        for name in ('identifier','reservation','reservation_id','request','rid'):
            if name in names and type(context.get(name))is str:need(str(uuid.UUID(context[name]))==context[name],'AI24_DB_IDENTIFIER')
        return {'writeUserIds':[context['user_id']]if 'user_id'in names else users}

    def read_sql(self,query,timeout=3):
        self.assert_closed_state();need(type(timeout)in(int,float)and 0<timeout<=5,'AI24_DB_READ_TIMEOUT')
        need(type(query)is str,'AI24_DB_READ_ARGUMENT')
        match=self.registry.authorize(query,self.validate_context)
        statement=query.strip().removesuffix(';')
        need(re.match(r'(?i)^(select|with)\b',statement)and not any(x in statement for x in(';','--','/*','\\')),'AI24_DB_READ_ONLY')
        if match['class']=='SignedMidnightRunner'and match['method']=='unknown_rows':
            identifier=next((str(uuid.UUID(x))for x in re.findall("'([a-f0-9-]{36})'",query)),None)
            self.verify_reservation_owner(identifier)
        body=("begin read only;set local statement_timeout='"+str(max(1,int(timeout*500)))+"ms';set local lock_timeout='1500ms';"+self.marker()+statement+';rollback;').encode()
        result=self.execute(body,timeout,True)
        try:self.save('ai24-authorized-'+str(self.counter).zfill(5)+'.json',{'operation':match,'scopeSha256':sha(canonical(self.operation_users))})
        except BaseException:
            self.sticky=True;raise
        return result

    def verify_reservation_owner(self,identifier):
        need(identifier is not None and self.users,'AI24_DB_OWN_RESERVATION')
        ids=','.join(quote(u)+'::uuid'for u in self.users);ledger='signed-midnight-'+self.value['scopeId']
        q="select exists(select 1 from private.ai_budget_reservations r join private.ai_account_budget_reservations a on a.reservation_id=r.id where r.id="+quote(identifier)+'::uuid and r.ledger_id='+quote(ledger)+' and a.ledger_id='+quote(ledger)+' and a.user_id in('+ids+'));'
        body=("begin read only;set local statement_timeout='1500ms';set local lock_timeout='1500ms';"+self.marker()+q+'rollback;').encode()
        need(self.execute(body,3,True)=='t','AI24_DB_FOREIGN_UNKNOWN')

    def sql(self,query):
        self.assert_closed_state();need(getattr(self,'_coverage_proven',False),'AI24_DB_WRITE_COVERAGE_NOT_REVIEWED');need(type(query)is str,'AI24_DB_WRITE_ARGUMENT')
        try:
            match=self.registry.authorize(query,self.validate_context)
            operation=write_operation(match,query)
            readonly=operation['kind']=='readonly'
            body=("set statement_timeout='15s';set lock_timeout='10s';set plpgsql.check_asserts=on;"+self.marker()+query).encode()
            if readonly:
                # 원 digest의 TEMP+ROLLBACK 및 고정 SELECT는 지속 행을 변경하지 않는다.
                # 각 실제 SQL의 원 metadata pre/post 검사는 execute에서 유지한다.
                return self.execute(body,20,True)
            if self.reviewed.operation is IssuerOperation:
                need(operation['kind']in('link_profile','unlink_profile'),'AI24_DB_ISSUER_WRITE_OPCODE')
            else:need(operation['kind']not in('link_profile','unlink_profile'),'AI24_DB_MIDNIGHT_WRITE_OPCODE')
            before=self.write_state(operation)
            result=self.execute(body,20,False)
            after=self.write_state(operation)
            verify_write_state(before,after,operation,self.value['scopeId'],operation.get('users',self.operation_users),self.initial_accounts)
            self.save('ai24-write-delta-'+str(self.counter).zfill(5)+'.json',{'operation':match,'beforeSha256':sha(canonical(before)),'afterSha256':sha(canonical(after)),'unownedRowsPreserved':True,'unknownAndCommittedBudgetPreserved':True})
            return result
        except BaseException:
            self.sticky=True;raise

    def write_state(self,operation):
        users=operation.get('users',getattr(self,'operation_users',self.users));ids=','.join(quote(u)+'::uuid'for u in users)or'null'
        ledger='signed-midnight-'+self.value['scopeId'];spec=owned_predicates(ids,ledger)
        q=dict(self.queries)
        for table,predicate in spec.items():
            bag="select coalesce(jsonb_object_agg(h,n),'{}'::jsonb)from(select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')h,count(*)n from "+table+' r where '+predicate+' group by 1)s'
            q['owned:'+table]=bag
        q['flags']="select jsonb_build_object('accounts',(select jsonb_agg(to_jsonb(a)order by account_id)from private.ai_budget_accounts a),'guard',(select jsonb_agg(to_jsonb(g))from private.ai_processing_guard g))"
        fields=','.join(quote(k)+',('+v+')::text'for k,v in q.items())
        body=("begin isolation level repeatable read read only;set local statement_timeout='30s';set local lock_timeout='1500ms';"+self.marker()+'select jsonb_build_object('+fields+');rollback;').encode()
        raw=self.ai.signed_exact_json(self.execute(body,35,True));base={k:raw[k]for k in self.queries}
        snapshot,rows=decode_snapshot(base,self.reviewed.operation,self.value['profile']['expectedTables'])
        flags=self.ai.signed_exact_json(raw['flags'])
        need({a['account_id']for a in flags['accounts']}=={'yumi','jonghyun','minkyu','sungho'}and len(flags['accounts'])==4,'AI24_DB_EXACT_BUDGET_ACCOUNTS')
        if self.initial_accounts is None and operation['kind']!='readonly':
            baseline=getattr(self.owner,'accounts',flags['accounts'])if self.reviewed.operation is MidnightOperation else flags['accounts']
            need(type(baseline)is list and len(baseline)==4 and {a['account_id']for a in baseline}=={'yumi','jonghyun','minkyu','sungho'}
                and all(type(a['registered'])is bool for a in baseline),'AI24_DB_BASELINE_ACCOUNT_FLAGS')
            self.initial_accounts=copy.deepcopy(baseline)
        return {'snapshot':snapshot,'rows':rows,'owned':{k:self.ai.signed_exact_json(raw['owned:'+k])for k in spec},'flags':flags}
    def snapshot(self):
        fields=','.join(quote(k)+',('+v+')::text'for k,v in self.queries.items())
        body=("begin isolation level repeatable read read only;set local statement_timeout='30s';set local lock_timeout='1500ms';"+self.marker()+'select jsonb_build_object('+fields+');rollback;').encode()
        try:
            value=self.ai.signed_exact_json(self.execute(body,35,True))
            result,rows=decode_snapshot(value,self.reviewed.operation,self.value['profile']['expectedTables'])
            if self.reviewed.operation is MidnightOperation:self.owner.snapshot_original_rows=rows
            return result
        except BaseException:self.sticky=True;raise
    def original_rows(self):
        value=self.snapshot()
        return value['rows']if self.reviewed.operation is IssuerOperation else self.owner.snapshot_original_rows
