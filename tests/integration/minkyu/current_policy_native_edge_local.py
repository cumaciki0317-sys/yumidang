"""민규 소유. 실제 로컬 Auth·DB·Edge 합성 회귀; 네이버/운영 검증과 구분한다."""
import argparse,base64,hashlib,hmac,json,os,secrets,stat,subprocess,tempfile,time,urllib.request,urllib.error,uuid
from pathlib import Path
from datetime import datetime,timedelta,timezone
parser=argparse.ArgumentParser(description='민규: 빈 독립 로컬56 DB/Auth/Edge에서 합성 회원·당도·차단·재개를 검증한다.')
parser.add_argument('--status-file',type=Path,required=True,help='독립 로컬 CLI status JSON, private0600; 값을 출력하지 않는다.')
args=parser.parse_args()
status_path=args.status_file
if status_path.is_symlink() or status_path.parent.is_symlink():parser.error('private regular status file required')
st=status_path.stat();parent=status_path.parent.stat()
if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=0o600 or parent.st_uid!=os.getuid() or stat.S_IMODE(parent.st_mode)!=0o700:
 parser.error('status file0600 and parent0700 owned by current user required')
settings=json.loads(status_path.read_text())
ROOT=Path(tempfile.mkdtemp(prefix='yumidang-native-edge56-',dir='/private/tmp'))
assert settings['API_URL']=='http://127.0.0.1:56531'
API=settings['API_URL'];ANON=settings['ANON_KEY'];SERVICE=settings['SERVICE_ROLE_KEY']
USERS=[];POSTS=[];RESULTS=[];CAPTURE_PATHS=[];PREFIX='native-edge56-probe-'+uuid.uuid4().hex

def write(name,value):
 with os.fdopen(os.open(ROOT/name,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as f:json.dump(value,f,ensure_ascii=False,indent=2)
def sql(query):
 r=subprocess.run(['docker','--host','unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock','exec','-i','supabase_db_yumidang-minkyu-drift','psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=query.encode(),capture_output=True)
 if r.returncode:raise RuntimeError('LOCAL_SQL_FAILED')
 return r.stdout.decode().strip()
def literal(s):return "'"+s.replace("'","''")+"'"
def request(path,token=ANON,data=None,method='POST'):
 body=None if data is None else json.dumps(data).encode()
 req=urllib.request.Request(API+path,data=body,method=method,headers={'apikey':SERVICE if token==SERVICE else ANON,'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=15) as response:return response.status,json.loads(response.read() or b'null')
 except urllib.error.HTTPError as e:
  try:b=json.loads(e.read())
  except Exception:b={}
  return e.code,b

def rpc(name,data,token):return request('/rest/v1/rpc/'+name,token,data)
def ok(label,pair):
 status,body=pair;RESULTS.append({'check':label,'status':status,'pass':200<=status<300})
 if not 200<=status<300:raise RuntimeError(label+':'+str(status)+':'+str(body.get('code') if isinstance(body,dict) else 'UNEXPECTED'))
 return body
def deny(label,pair,codes,statuses=(401,403)):
 status,body=pair;code=body.get('code') if isinstance(body,dict) else None;passed=status in statuses and code in codes
 RESULTS.append({'check':label,'status':status,'code':code,'pass':passed})
 if not passed:raise RuntimeError(label+':'+str(status)+':'+str(code))
def hidden_semantic(label,pair,message):
 status,body=pair
 assert body=={'code':'P0002','details':None,'hint':None,'message':message}
 assert status==500
 RESULTS.append({'check':label,'status':status,'code':'P0002','pass':True,'no_pii':True,'native_http_status_gap':True,'expected_native_http_status':404})
def claims(token):
 part=token.split('.')[1];return json.loads(base64.urlsafe_b64decode(part+'='*(-len(part)%4)))
def anonymous_control(token):
 # Auth generated session/subject plus a locally signed is_anonymous=true control.
 value=claims(token);value.update(is_anonymous=True,exp=int(time.time())+600,role='authenticated')
 def encode(v):return base64.urlsafe_b64encode(json.dumps(v,separators=(',',':')).encode()).rstrip(b'=')
 unsigned=encode({'alg':'HS256','typ':'JWT'})+b'.'+encode(value)
 return (unsigned+b'.'+base64.urlsafe_b64encode(hmac.new(settings['JWT_SECRET'].encode(),unsigned,hashlib.sha256).digest()).rstrip(b'=')).decode()
def create_member(index):
 subject=PREFIX+'-'+str(index)
 account=ok('resolve_synthetic_member_'+str(index),rpc('resolve_naver_account',{'p_subject':subject,'p_name':'합성회원'+str(index),'p_gender':'F','p_birth_date':'1990-01-01'},SERVICE))
 u={'subject':subject,'email':account['authEmail'],'password':secrets.token_urlsafe(32)};USERS.append(u);write('edge56-probe-private-users.json',USERS)
 auth=ok('auth_admin_create_'+str(index),request('/auth/v1/admin/users',SERVICE,{'email':u['email'],'password':u['password'],'email_confirm':True}))
 u['id']=auth['id'];write('edge56-probe-private-users.json',USERS)
 session=ok('auth_password_signin_'+str(index),request('/auth/v1/token?grant_type=password',ANON,{'email':u['email'],'password':u['password']}))
 u['token']=session['access_token'];u['session_id']=claims(u['token'])['session_id'];u['avatar']=u['id']+'/'+str(uuid.uuid4())+'.jpg';write('edge56-probe-private-users.json',USERS)
 sql("begin;insert into storage.objects(bucket_id,name,owner_id,metadata)values('profile-images',"+literal(u['avatar'])+','+literal(u['id'])+",'{\"mimetype\":\"image/jpeg\",\"size\":128}'::jsonb);commit;")
 ok('register_auth_session_'+str(index),rpc('record_naver_session',{'p_subject':subject,'p_user_id':u['id'],'p_session_id':u['session_id']},SERVICE))
 state=ok('complete_signup_'+str(index),rpc('complete_naver_signup',{'p_avatar_path':u['avatar'],'p_interests':[],'p_conversation_styles':[],'p_mbti':None},u['token']))
 assert state['status']=='ready'
 return u

def app(path,user=None,data=None,method='GET'):
 req=urllib.request.Request('http://127.0.0.1:56531/functions/v1/service-api'+path,data=None if data is None else json.dumps(data).encode(),method=method,headers={'Authorization':'Bearer '+user['token'] if user else '', 'Content-Type':'application/json','apikey':ANON,'Origin':'http://127.0.0.1:5173'})
 try:
  with urllib.request.urlopen(req,timeout=20) as response:return response.status,json.loads(response.read())
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
def app_ok(label,pair):
 status,body=pair
 if not 200<=status<300:
  raise RuntimeError(label+':'+str(status)+':'+str(body.get('error',{}).get('code')))
 body=ok(label,pair);assert set(body)=={'data','requestId'};uuid.UUID(body['requestId']);return body['data']
def app_deny(label,pair,status,code):
 actual,body=pair
 assert actual==status and set(body)=={'error','requestId'} and set(body['error'])=={'code','message','retryable'} and body['error']['code']==code
 assert not any(x in json.dumps(body)for x in ['P0002','profile_unavailable','post_unavailable','SQL','details','hint'])
 assert not any(u['id'] in json.dumps(body)for u in USERS)
 RESULTS.append({'check':label,'status':actual,'code':code,'pass':True,'no_sql_detail_or_member_pii':True})

# Real Storage bytes use only the isolated local gateway and synthetic image fixture.
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvBcAAAAASUVORK5CYII=')
def storage_bytes(path,user,data=None,method='GET',mime='image/png',upsert=False):
 req=urllib.request.Request(API+'/storage/v1/'+path,data=data,method=method,headers={'apikey':ANON,'Authorization':'Bearer '+user['token'],'Content-Type':mime,'x-upsert':'true'if upsert else'false'})
 try:
  with urllib.request.urlopen(req,timeout=20)as response:return response.status,response.read()
 except urllib.error.HTTPError as e:return e.code,e.read()
def storage_pass(label,pair,expected=None):
 status,body=pair;passed=200<=status<300 and(expected is None or body==expected)
 RESULTS.append({'check':label,'status':status,'pass':passed})
 if not passed:raise RuntimeError(label+':'+str(status))
 return body
def storage_deny(label,pair):
 status,_=pair;passed=status in(400,401,403,404)
 RESULTS.append({'check':label,'status':status,'pass':passed})
 if not passed:raise RuntimeError(label+':'+str(status))

def cleanup():
 ids=[u['id'] for u in USERS if 'id'in u]
 if not ids:return
 if CAPTURE_PATHS:
  ok('storage_service_synthetic_blob_cleanup',request('/storage/v1/object/report-evidence',SERVICE,{'prefixes':CAPTURE_PATHS},'DELETE'))
  for path in CAPTURE_PATHS:
   owner=next(u for u in USERS if path.startswith(u['id']+'/'))
   storage_deny('storage_cleaned_blob_unavailable',storage_bytes('object/authenticated/report-evidence/'+path,owner))
 idlist=','.join(literal(i)+'::uuid' for i in ids)
 sql('begin;delete from private.report_capture_assets where owner_id in('+idlist+');delete from private.member_reports where reporter_id in('+idlist+');commit;')
 sql("begin;set local storage.allow_delete_query='true';delete from public.posts where author_id in("+idlist+");delete from public.profiles where id in("+idlist+");delete from storage.objects where owner_id in("+','.join(literal(i) for i in ids)+");delete from private.member_episodes where profile_id in("+idlist+");delete from private.naver_identity_keys where subject like "+literal(PREFIX+'-%')+";delete from private.naver_accounts where subject like "+literal(PREFIX+'-%')+";commit;")
 for u in USERS:
  if'id'in u:ok('auth_admin_cleanup',request('/auth/v1/admin/users/'+u['id'],SERVICE,method='DELETE'))
 left=sql("begin read only;select (select count(*) from auth.users where id in("+idlist+"))+(select count(*) from public.profiles where id in("+idlist+"))+(select count(*) from storage.objects where owner_id in("+','.join(literal(i) for i in ids)+"))+(select count(*) from private.naver_accounts where subject like "+literal(PREFIX+'-%')+");rollback;")
 assert left=='0'
 assert sql('select count(*) from private.member_episodes where profile_id in('+idlist+');')=='0'
 assert sql('select count(*) from private.naver_identity_keys where subject like '+literal(PREFIX+'-%')+';')=='0'
 assert sql('select (select count(*) from private.report_capture_assets where owner_id in('+idlist+'))+(select count(*) from private.member_reports where reporter_id in('+idlist+'))+(select count(*) from private.report_access_audit where actor_id in('+idlist+'));')=='0'
 RESULTS.append({'check':'synthetic_cleanup','pass':True,'remaining_rows':0})

# 고정된 독립 프로젝트와 빈56 상태만 허용한다. 원본 DB/회원 자료에서는 실행하지 않는다.
state=json.loads(sql("begin read only;select jsonb_build_object('versions',(select count(*) from supabase_migrations.schema_migrations),'latest',(select max(version) from supabase_migrations.schema_migrations),'rows',(select count(*) from public.profiles)+(select count(*) from auth.users)+(select count(*) from private.member_episodes));rollback;"))
if state!={'versions':56,'latest':'20261005020136','rows':0}:parser.error('empty independent reviewed56 database required')
failed=None
try:
 A,B,C=[create_member(i) for i in range(1,4)]
 protected={'real_name':'변조회원','birth_date':'1980-01-01','gender':'male','avatar_url':A['avatar'],'id':str(uuid.uuid4()),'created_at':'2000-01-01T00:00:00Z','updated_at':'2000-01-01T00:00:00Z'}
 for field,value in protected.items():deny('profile_direct_patch_'+field,request('/rest/v1/profiles?id=eq.'+A['id'],A['token'],{field:value},'PATCH'),['42501'])
 ok('profile_owner_bio_patch',request('/rest/v1/profiles?id=eq.'+A['id'],A['token'],{'bio':'합성 프로필 소개'},'PATCH'))
 ok('profile_other_owner_bio_rls',request('/rest/v1/profiles?id=eq.'+B['id'],A['token'],{'bio':'타인 프로필 변경 시도'},'PATCH'))
 assert ok('profile_other_owner_bio_unchanged',rpc('get_my_profile',{},B['token']))['bio'] is None
 deny('profile_anon_patch',request('/rest/v1/profiles?id=eq.'+A['id'],ANON,{'real_name':'변조회원'},'PATCH'),['42501'])
 now=datetime.now(timezone.utc);ts=lambda days,hours=0:(now+timedelta(days=days,hours=hours)).isoformat()
 post=str(uuid.uuid4());POSTS.append(post)
 data={'title':'합성 native 동행','description':'독립 로컬 합성 테스트','category':'산책','startsAt':ts(6),'endsAt':ts(6,2),'recruitmentEndsAt':ts(5),'publicArea':'서울특별시 강남구 역삼동','registeredPlaceName':'합성 장소','registeredAddress':'합성 비공개 주소 123','meetingDetail':'합성 비공개 지점','preferenceNote':None,'tags':[],'costType':'free','amount':0}
 ok('create_post_native',rpc('create_service_post',{'p_post_id':post,'p_input':data},A['token']))
 for fn,args in [('get_post_author_cards',{'p_post_ids':[post]}),('get_post_author_discovery_cards',{'p_post_ids':[post]}),('get_post_author_profile',{'p_post_id':post})]:
  ok(fn+'_member',rpc(fn,args,B['token']))
  deny(fn+'_anon',rpc(fn,args,ANON),['28000','42501'])
  deny(fn+'_anonymous_claim_control',rpc(fn,args,anonymous_control(B['token'])),['28000','42501'])
 forged=dict(A);forged['token']=A['token'][:-5]+'wrong'
 app_deny('edge_http_forged_token_denied',app('/me',forged),401,'AUTH_REQUIRED')
 app_deny('edge_http_user_jwt_internal_fail_closed',app('/internal/maintenance',A,{},'POST'),503,'EXTERNAL_UNAVAILABLE')
 app_deny('edge_http_anon_me_denied',app('/me'),401,'AUTH_REQUIRED')
 me=app_ok('edge_http_member_me',app('/me',A));assert me['userId']==A['id'] and me['sweetness']==15
 RESULTS.append({'check':'edge56_initial_sweetness15','pass':True})
 before=ok('before_block_profile',rpc('get_public_profile',{'p_profile_id':A['id']},B['token']))
 block=ok('block_native',rpc('block_member',{'p_target_id':A['id']},B['token']));assert block['blocked']and not block['alreadyApplied']
 assert ok('block_retry_native',rpc('block_member',{'p_target_id':A['id']},B['token']))['alreadyApplied']
 app_deny('edge_http_blocked_profile404',app('/profiles/'+A['id'],B),404,'RESOURCE_NOT_FOUND')
 app_deny('edge_http_blocked_request403',app('/posts/'+post+'/requests',B,{'messageId':str(uuid.uuid4()),'message':'합성 차단 신청'},'POST'),403,'ACCESS_DENIED')
 hidden_semantic('blocked_profile_hidden_semantic',rpc('get_public_profile',{'p_profile_id':A['id']},B['token']),'profile_unavailable')
 assert sql('begin read only;select count(*) from private.member_blocks where blocker_id='+literal(B['id'])+'::uuid and blocked_id='+literal(A['id'])+'::uuid;rollback;')=='1'
 RESULTS.append({'check':'blocked_read_has_no_mutation','pass':True})
 deny('blocked_request_denied',rpc('request_service_post',{'p_post_id':post,'p_message_id':str(uuid.uuid4()),'p_message':'차단된 신청'},B['token']),['42501'])
 assert app_ok('edge_http_unblock',app('/profiles/'+A['id']+'/unblock',B,{},'POST'))['blocked'] is False
 assert ok('unblock_native',rpc('unblock_member',{'p_target_id':A['id']},B['token']))['blocked']is False
 # Native owner setup uses only synthetic historical fixtures, not a service operator workflow.
 sweet_post,sweet_request,sweet_appointment,sweet_review=[str(uuid.uuid4())for _ in range(4)]
 q=lambda x:literal(x)+'::uuid'
 sql("begin;select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);"
     +"insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status) values("
     +q(sweet_post)+','+q(A['id'])+",'합성 당도 이력','실제 Edge 당도 검증','산책',now()-interval '4 days',now()-interval '3 days',now()-interval '5 days','서울특별시 강남구 역삼동','closed');"
     +"insert into public.join_requests(id,post_id,requester_id,message,status) values("+q(sweet_request)+','+q(sweet_post)+','+q(B['id'])+",'합성 당도 신청','matched');"
     +"insert into public.appointments(id,post_id,join_request_id,status,confirmed_at,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at) values("
     +q(sweet_appointment)+','+q(sweet_post)+','+q(sweet_request)+",'completed',now()-interval '4 days',now()-interval '2 days','automatic',now()-interval '2 days',now()-interval '1 day',now()+interval '5 days');"
     +"insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,experience) values("+q(sweet_review)+','+q(sweet_appointment)+','+q(A['id'])+",5,'positive');"
     +"insert into public.appointment_reviews(appointment_id,reviewer_id,rating,experience) values("+q(sweet_appointment)+','+q(B['id'])+",3,'neutral');commit;")
 assert app_ok('edge56_released_review_sweetness',app('/me',B))['sweetness']==17
 public_score=app_ok('edge56_public_profile_sweetness',app('/profiles/'+B['id'],C));assert public_score['sweetness']==17 and public_score['completedCount']==1
 ok('edge56_hide_review_native',rpc('set_review_publication',{'p_review_id':sweet_review,'p_is_public':False},SERVICE))
 assert app_ok('edge56_hidden_review_score_preserved',app('/me',B))['sweetness']==17
 sql("begin;select private.decide_review_sweetness(gen_random_uuid(),"+q(sweet_review)+",1,false);commit;")
 assert app_ok('edge56_final_invalid_score',app('/me',B))['sweetness']==15
 sql("begin;select private.decide_review_sweetness(gen_random_uuid(),"+q(sweet_review)+",2,true);commit;")
 assert app_ok('edge56_corrected_score',app('/me',B))['sweetness']==17
 assert app_ok('edge56_corrected_hidden_review_stays_hidden',app('/profiles/'+B['id']+'/reviews',C))['reviews']==[]

 rB=ok('request_B',rpc('request_service_post',{'p_post_id':post,'p_message_id':str(uuid.uuid4()),'p_message':'합성 B 신청'},B['token']))['id']
 rC=ok('request_C',rpc('request_service_post',{'p_post_id':post,'p_message_id':str(uuid.uuid4()),'p_message':'합성 C 신청'},C['token']))['id']
 consent=ok('propose_native',rpc('propose_match',{'p_request_id':rB},A['token']))
 appointment=ok('accept_native',rpc('accept_match',{'p_request_id':rB,'p_condition_version':consent['conditionVersion']},B['token']))['appointmentId']
 # Actual Edge location-only proposal preserves the current post until the other party accepts.
 change_path='/appointments/'+appointment+'/schedule-change'
 state=app_ok('edge56_change_state',app(change_path,A))
 old_place=app_ok('edge56_original_place',app('/posts/'+post,B))['privateDetails']
 location={'publicArea':'서울특별시 종로구 청운동','registeredPlaceName':'합성 새 장소','registeredAddress':'합성 새 비공개 주소 456','meetingDetail':'합성 새 상세지점'}
 change_id=str(uuid.uuid4())
 app_deny('edge56_incomplete_area_rejected',app(change_path+'/propose',A,{'changeId':str(uuid.uuid4()),'startsAt':state['startsAt'],'endsAt':state['endsAt'],'expectedUpdatedAt':state['updatedAt'],'location':{**location,'publicArea':'서울특별시 종로구'}},'POST'),400,'INVALID_REQUEST')
 deny('native53_incomplete_area_rejected',rpc('propose_appointment_schedule_change',{'p_appointment_id':appointment,'p_change_id':str(uuid.uuid4()),'p_starts_at':state['startsAt'],'p_ends_at':state['endsAt'],'p_expected_updated_at':state['updatedAt'],'p_location':{**location,'publicArea':'서울특별시 종로구'}},A['token']),['22023'],statuses=(400,))
 proposed=app_ok('edge56_location_proposal',app(change_path+'/propose',A,{'changeId':change_id,'startsAt':state['startsAt'],'endsAt':state['endsAt'],'expectedUpdatedAt':state['updatedAt'],'location':location},'POST'))
 pending=app_ok('edge56_pending_location_read',app(change_path,B))['change']
 assert pending['locationChanged'] is True and pending['newLocation']==location
 assert app_ok('edge56_before_accept_place_unchanged',app('/posts/'+post,B))['privateDetails']==old_place
 app_deny('edge56_nonparty_location_denied',app(change_path,C),404,'RESOURCE_NOT_FOUND')
 app_deny('edge56_self_accept_denied',app(change_path+'/accept',A,{'changeId':change_id,'conditionVersion':pending['conditionVersion']},'POST'),403,'ACCESS_DENIED')
 accepted=app_ok('edge56_other_party_location_accept',app(change_path+'/accept',B,{'changeId':change_id,'conditionVersion':pending['conditionVersion']},'POST'))
 assert accepted['status']=='accepted' and accepted['newLocation'] is None
 updated=app_ok('edge56_accepted_place',app('/posts/'+post,B))
 assert updated['publicArea']==location['publicArea'] and updated['privateDetails']=={k:v for k,v in location.items() if k!='publicArea'}
 terminal=app_ok('edge56_terminal_location_cleared',app(change_path,B))['change']
 assert terminal['newLocation'] is None
 ok('cancel_native',rpc('cancel_appointment',{'p_appointment_id':appointment,'p_cancellation_id':str(uuid.uuid4()),'p_reason':'합성 native 취소'},A['token']))
 # Cancellation does not implicitly reopen the post or restore the other requester.
 detail=ok('post_after_cancel',rpc('get_service_post',{'p_post_id':post},A['token']));assert detail['status']=='closed'
 reopened=app_ok('edge_http_reopen',app('/posts/'+post+'/reopen',A,{},'POST'));assert reopened['status']=='recruiting'and reopened['restoredCount']==1 and not reopened['alreadyReopened']
 repeated=ok('reopen_retry_native',rpc('reopen_service_post',{'p_post_id':post},A['token']));assert repeated['alreadyReopened']and repeated['restoredCount']==0
 ok('restored_chat_native',rpc('send_conversation_message',{'p_request_id':rC,'p_message_id':str(uuid.uuid4()),'p_content':'복원된 합성 채팅'},C['token']))
 # A different author cannot reopen an existing post.
 app_deny('edge_http_other_author_reopen404',app('/posts/'+post+'/reopen',B,{},'POST'),404,'RESOURCE_NOT_FOUND')
 hidden_semantic('reopen_other_author_denied_semantic',rpc('reopen_service_post',{'p_post_id':post},B['token']),'post_unavailable')
 # Online report: actual binary upload, ownership, immutable submitted evidence and own history.
 asset_id=str(uuid.uuid4())
 reserved=app_ok('edge56_reserve_report_capture',app('/report-captures',B,{'assetId':asset_id,'extension':'png'},'POST'))
 capture=reserved['path'];CAPTURE_PATHS.append(capture)
 app_deny('edge56_capture_confirm_before_upload_denied',app('/report-captures/'+asset_id+'/confirm',B,{},'POST'),403,'ACCESS_DENIED')
 storage_deny('storage56_foreign_upload_denied',storage_bytes('object/report-evidence/'+capture,C,PNG,'POST'))
 storage_deny('storage56_unreserved_upload_denied',storage_bytes('object/report-evidence/'+B['id']+'/'+str(uuid.uuid4())+'.png',B,PNG,'POST'))
 storage_deny('storage56_invalid_mime_denied',storage_bytes('object/report-evidence/'+capture,B,PNG,'POST',mime='image/gif'))
 storage_pass('storage56_real_capture_uploaded',storage_bytes('object/report-evidence/'+capture,B,PNG,'POST'))
 storage_pass('storage56_owner_reads_exact_bytes',storage_bytes('object/authenticated/report-evidence/'+capture,B),PNG)
 storage_deny('storage56_foreign_read_denied',storage_bytes('object/authenticated/report-evidence/'+capture,C))
 assert app_ok('edge56_capture_confirm_uploaded',app('/report-captures/'+asset_id+'/confirm',B,{},'POST'))['state']=='uploaded'
 report_body={'clientRequestId':str(uuid.uuid4()),'targetType':'post','targetId':post,'context':'online','reasonCodes':['spam','other'],'description':'합성 신고 상황 설명','assetIds':[asset_id],'hideTarget':False}
 report=app_ok('edge56_report_submit',app('/reports',B,report_body,'POST'));assert report['status']=='received'and not report['alreadySubmitted']
 repeated=app_ok('edge56_report_same_request_idempotent',app('/reports',B,report_body,'POST'));assert repeated['reportId']==report['reportId']and repeated['alreadySubmitted']
 app_deny('edge56_report_changed_retry_conflict',app('/reports',B,{**report_body,'description':'다른 합성 설명'},'POST'),409,'STATE_CONFLICT')
 detail=app_ok('edge56_own_report_detail',app('/me/reports/'+report['reportId'],B));assert detail['description']==report_body['description']and detail['assetIds']==[asset_id]
 listed=app_ok('edge56_own_report_history',app('/me/reports',B));assert any(item['reportId']==report['reportId']for item in listed['items'])
 app_deny('edge56_foreign_report_detail_hidden',app('/me/reports/'+report['reportId'],C),404,'RESOURCE_NOT_FOUND')
 app_deny('edge56_attached_capture_cancel_denied',app('/report-captures/'+asset_id+'/cancel',B,{},'POST'),409,'STATE_CONFLICT')
 storage_deny('storage56_attached_capture_overwrite_denied',storage_bytes('object/report-evidence/'+capture,B,PNG,'POST',upsert=True))
 delete_pair=request('/storage/v1/object/report-evidence',B['token'],{'prefixes':[capture]},'DELETE')
 assert delete_pair[0] in(200,400,401,403,404)
 storage_pass('storage56_submitted_capture_survives_member_delete',storage_bytes('object/authenticated/report-evidence/'+capture,B),PNG)
 assert sql('select count(*) from private.report_access_audit where actor_id='+literal(B['id'])+'::uuid;')!='0'
 RESULTS.append({'check':'storage56_evidence_access_audited','pass':True})
except Exception as e:
 failed=str(e) if isinstance(e,(AssertionError,RuntimeError)) else type(e).__name__
finally:
 try:cleanup()
 except Exception as e:failed=(failed or'')+';CLEANUP_FAILED:'+type(e).__name__
 write('edge56-policy-probe-results.json',{'status':('SEMANTIC_PASS_WITH_NATIVE_HTTP_GAPS' if any(x.get('native_http_status_gap') for x in RESULTS) else 'PASS')if failed is None else'FAIL','failure_code':failed,'results':RESULTS,'real_naver_login':'NOT_RUN','auth_mode':'local Auth admin/password + synthetic qualified account reservation','anonymous_control':'locally signed is_anonymous control; distinct from real Auth session'})
 print(json.dumps({'status':('SEMANTIC_PASS_WITH_NATIVE_HTTP_GAPS' if any(x.get('native_http_status_gap') for x in RESULTS) else 'PASS')if failed is None else'FAIL','failure_code':failed,'checks':len(RESULTS),'passed':sum(x['pass']for x in RESULTS),'cleanup':any(x['check']=='synthetic_cleanup'for x in RESULTS)}))
 if not failed:(ROOT/'edge56-probe-private-users.json').unlink(missing_ok=True)
 print(json.dumps({'private_result_file':str(ROOT/'edge56-policy-probe-results.json')}))
 if failed:raise SystemExit(1)
