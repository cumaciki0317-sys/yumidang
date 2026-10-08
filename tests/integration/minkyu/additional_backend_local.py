"""민규 추가 백엔드 격리 HTTP 검증. 운영 주소와 임의 DB 대상은 받지 않는다."""
import base64,json,secrets,subprocess,urllib.request,urllib.error,uuid,concurrent.futures
from pathlib import Path
REPO=Path(__file__).resolve().parents[3]
STATE=Path('/private/tmp/yumidang-additional-backend-20261008')
STATUS=Path('/private/tmp/yumidang-release88-http-isolated/status-private.json')
s=json.loads(STATUS.read_text());assert s['API_URL']=='http://127.0.0.1:59621'
BASE=['docker','--host','unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock','exec','-i','supabase_db_yumidang-release88-http','psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
def sql(query):
 r=subprocess.run(BASE,input=query,text=True,capture_output=True,timeout=120)
 if r.returncode:
  (STATE/'sql-private.log').write_text(r.stderr);raise RuntimeError('LOCAL_SQL_FAILED')
 return r.stdout.strip()
def uid(n):return 'fda10000-0000-4000-8000-'+str(n).zfill(12)
if not (STATE/'http-fixture-started.json').exists():
 f=(REPO/'tests/database/minkyu/assigned_report_notice_receipts.sql').read_text().split('insert into auth.users(id,email)values(pg_temp.safety_uid(3)')[0]
 f=f.replace('fe910000','fda10000').replace('fe920000','fda20000').replace('fe930000','fda30000').replace('review-start-sql-','additional-backend-sql-')
 sql(f+(REPO/'tests/database/minkyu/member_own_posts.sql').read_text()+'commit;')
 (STATE/'http-fixture-started.json').write_text('{"syntheticOnly":true}')
sql("insert into auth.users(id,email)values('"+uid(3)+"','additional-backend-staff@test.invalid')on conflict(id)do nothing;")
TOKENS={}
for n in [1,2,3]:
 password=secrets.token_urlsafe(30);email=sql("select email from auth.users where id='"+uid(n)+"';")
 sql("update auth.users set instance_id='00000000-0000-0000-0000-000000000000',aud='authenticated',role='authenticated',created_at=clock_timestamp(),updated_at=clock_timestamp(),email_confirmed_at=clock_timestamp(),confirmation_token='',recovery_token='',email_change_token_new='',email_change='',email_change_token_current='',phone_change='',phone_change_token='',reauthentication_token='',encrypted_password=crypt('"+password+"',gen_salt('bf'))where id='"+uid(n)+"';")
 req=urllib.request.Request(s['API_URL']+'/auth/v1/token?grant_type=password',data=json.dumps({'email':email,'password':password}).encode(),headers={'apikey':s['ANON_KEY'],'content-type':'application/json'})
 with urllib.request.urlopen(req,timeout=30)as response:session=json.loads(response.read())
 TOKENS[n]=session['access_token'];claims=json.loads(base64.urlsafe_b64decode(TOKENS[n].split('.')[1]+'=='))
 if n==3:continue
 req=urllib.request.Request(s['API_URL']+'/rest/v1/rpc/record_naver_session',data=json.dumps({'p_subject':'additional-backend-sql-'+str(n),'p_user_id':uid(n),'p_session_id':claims['session_id']}).encode(),headers={'authorization':'Bearer '+s['SERVICE_ROLE_KEY'],'apikey':s['SERVICE_ROLE_KEY'],'content-type':'application/json'})
 with urllib.request.urlopen(req,timeout=30)as response:assert response.status==200
# Credentials remain process memory only.
def request(path,n=1,body=None,method='GET',rpc=False):
 url=s['API_URL']+'/rest/v1/rpc/'+path if rpc else 'http://127.0.0.1:59642/functions/v1/service-api'+path
 headers={'apikey':s['ANON_KEY'],'content-type':'application/json'}
 if n is not None:headers['authorization']='Bearer '+TOKENS[n]
 req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),method=method,headers=headers)
 try:
  with urllib.request.urlopen(req,timeout=30)as r:return r.status,json.loads(r.read())
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
def checked(path,n=1,body=None,method='GET'):
 code,value=request(path,n,body,method)
 if code!=200:raise AssertionError((path,code,value.get('error',{}).get('code')))
 return value['data']
receipt={'actualAuthJWT':True,'realHTTP':True,'syntheticMembers':True,'operating':False}
a=checked('/me/posts?limit=1');assert len(a['items'])==1 and a['items'][0]['isOwner'] is True and 'privateDetails'in a['items'][0]
b=checked('/me/posts?limit=1&before='+a['nextCursor']);assert len(b['items'])==1 and b['items'][0]['postId']!=a['items'][0]['postId']
assert checked('/me/posts',2)['items']==[]
assert request('/me/posts?before='+a['nextCursor'],2)[0]==404
assert request('/me/posts',None)[0]==401
assert request('/me/posts?userId='+uid(2))[0]==400
receipt['ownPosts']='PASS'
# Actual first-chat application and message read path.
sql("delete from private.member_hidden_targets where identity_id in(select identity_id from private.member_episodes where profile_id in('"+uid(1)+"','"+uid(2)+"'));delete from private.conversation_read_states where user_id in('"+uid(1)+"','"+uid(2)+"');")
post='fd810000-0000-4000-8000-000000000003'
first='fda40000-0000-4000-8000-000000000001';later='fda40000-0000-4000-8000-000000000002'
joined=checked('/posts/'+post+'/requests',2,{'messageId':first,'message':'합성 첫 메시지'},'POST');rid=joined['id']
path='/conversations/'+rid
before=checked(path,1)[0];assert before['unread_count']>=1 and before['last_read_message_id']is None
body={'lastReadMessageId':first};one=checked(path+'/read',1,body,'POST');again=checked(path+'/read',1,body,'POST');assert one==again
checked(path+'/messages',2,{'messageId':later,'content':'합성 새 메시지'},'POST')
assert checked(path,1)[0]['unread_count']==1
with concurrent.futures.ThreadPoolExecutor(max_workers=6)as pool:
 results=list(pool.map(lambda mid:checked(path+'/read',1,{'lastReadMessageId':mid},'POST'),[first,later,first,later,later,first]))
last=checked(path,1)[0];assert last['last_read_message_id']==later and last['unread_count']==0
assert checked(path+'/read',1,body,'POST')['last_read_message_id']==later
assert request(path+'/read',1,{'lastReadMessageId':str(uuid.uuid4())},'POST')[0]==404
assert request(path+'/read',1,{'lastReadMessageId':later,'readAt':'2026-10-01'},'POST')[0]==400
assert request('/conversations/'+str(uuid.uuid4())+'/read',1,body,'POST')[0]==404
# FK deletion removes read cursor without changing original fixture messages.
assert sql("begin;delete from public.chat_messages where id='"+later+"';select count(*)from private.conversation_read_states where user_id='"+uid(1)+"'and request_id='"+rid+"';rollback;").splitlines()[-1]=='0'
receipt['conversationRead']='PASS';receipt['readConcurrentRequests']=6
# Hide a single chat message, preserve the rest of the conversation.
sql("insert into private.member_hidden_targets(identity_id,target_type,target_id)select identity_id,'chat','"+later+"'from private.member_episodes where profile_id='"+uid(1)+"'and ended_at is null on conflict do nothing;")
items=checked(path+'/messages?limit=1',1)['items'];assert all(item['messageId']!=later for item in items)and len(items)==1
assert any(item['messageId']==later for item in checked(path+'/messages?limit=10',2)['items'])
checked('/me/hidden-targets/unhide',1,{'targetType':'chat','targetId':later},'POST')
assert any(item['messageId']==later for item in checked(path+'/messages?limit=10',1)['items'])
# Hide post only in the viewer's content; management endpoints are unaffected.
sql("insert into private.member_hidden_targets(identity_id,target_type,target_id)select identity_id,'post','"+post+"'from private.member_episodes where profile_id='"+uid(2)+"'and ended_at is null on conflict do nothing;")
assert request('/posts/'+post,2)[0]==404
assert checked('/posts/'+post,1)['postId']==post
assert len(checked('/requests/sent',2))>=1
assert checked('/me/hidden-targets',2)['items']
checked('/me/hidden-targets/unhide',2,{'targetType':'post','targetId':post},'POST')
assert checked('/posts/'+post,2)['postId']==post
receipt['hiddenContentBasic']='PASS'
# Member-profile hide and final report metadata deletion preserve minimal hide record.
sql("insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,hide_target,fingerprint)select 'fda50000-0000-4000-8000-000000000001','"+uid(1)+"',id,'fda50000-0000-4000-8000-000000000002','member','"+uid(2)+"','offline',array['other'],true,'additional-hidden-fixture'from private.member_episodes where profile_id='"+uid(1)+"'and ended_at is null on conflict do nothing;delete from private.member_reports where id='fda50000-0000-4000-8000-000000000001';")
assert request('/profiles/'+uid(2),1)[0]==404
assert any(h['targetType']=='member'and h['targetId']==uid(2)for h in checked('/me/hidden-targets',1)['items'])
checked('/me/hidden-targets/unhide',1,{'targetType':'member','targetId':uid(2)},'POST')
assert request('/profiles/'+uid(2),1)[0]==200
# Stable stored-event fixture copied only from this isolated owned source.
eid='fda60000-0000-4000-8000-000000000001'
sql("insert into private.source_events(id,provider,source_id,collected_at,record)select '"+eid+"',provider,'additional-backend-event-1',collected_at,record||jsonb_build_object('sourceId','additional-backend-event-1','title','추가 백엔드 행사','sourceStatus','active')from private.source_events order by id limit 1 on conflict(id)do update set record=excluded.record;")
event=checked('/events/'+eid,None);assert event['id']==eid and 'meetingDetail'not in event
assert checked('/events/rankings',None)=={'status':'not_enabled','reason':'KOPIS_RANKING_PROVIDER_VERIFICATION_PENDING'}
sql("update private.source_events set record=record||jsonb_build_object('title','추가 백엔드 최신 행사','sourceStatus','cancelled')where id='"+eid+"';")
latest=checked('/events/'+eid,None);assert latest['title']=='추가 백엔드 최신 행사'and latest['sourceStatus']=='cancelled'
sql("insert into private.member_hidden_targets(identity_id,target_type,target_id)select identity_id,'event','"+eid+"'from private.member_episodes where profile_id='"+uid(1)+"'and ended_at is null on conflict do nothing;")
assert request('/events/'+eid,1)[0]==404 and request('/events/'+eid,2)[0]==200 and request('/events/'+eid,None)[0]==200
checked('/me/hidden-targets/unhide',1,{'targetType':'event','targetId':eid},'POST');assert request('/events/'+eid,1)[0]==200
receipt['hiddenMemberEventAndReportDeletion']='PASS';receipt['publicEventDetailAndRankingHold']='PASS'
# Search filtering occurs in DB before LIMIT; continue from the visible cursor.
search='/posts?query=%EB%B3%B8%EC%9D%B8&availability=all&limit=1'
visible=checked(search,2);assert len(visible['posts'])==1
hidden_post=visible['posts'][0]['id']
sql("insert into private.member_hidden_targets(identity_id,target_type,target_id)select identity_id,'post','"+hidden_post+"'from private.member_episodes where profile_id='"+uid(2)+"'and ended_at is null on conflict do nothing;")
filtered=checked(search,2);assert len(filtered['posts'])==1 and filtered['posts'][0]['id']!=hidden_post
checked('/me/hidden-targets/unhide',2,{'targetType':'post','targetId':hidden_post},'POST')
# Hidden appointment removes conversation content but preserves required management.
aid=sql("select id from public.appointments where join_request_id='"+rid+"';")
if not aid:
 consent=checked('/requests/'+rid+'/propose',1,{},'POST')
 match=checked('/requests/'+rid+'/accept',2,{'conditionVersion':consent['conditionVersion']},'POST');aid=match['appointmentId']
sql("insert into private.member_hidden_targets(identity_id,target_type,target_id)select identity_id,'appointment','"+aid+"'from private.member_episodes where profile_id='"+uid(2)+"'and ended_at is null on conflict do nothing;")
assert request(path,2)[0]==404
assert checked('/appointments/'+aid,2)
assert checked('/me/posts',1)['items']
checked('/me/hidden-targets/unhide',2,{'targetType':'appointment','targetId':aid},'POST');assert request(path,2)[0]==200
receipt['hiddenBeforeSearchLimitAndManagementPreserved']='PASS'
# AI fixture owns only state metadata; no model, prompt or conversation is stored.
def internal_rpc(name,body):
 req=urllib.request.Request(supabase_api+'/rest/v1/rpc/'+name,data=json.dumps(body).encode(),headers={'apikey':service_key,'authorization':'Bearer '+service_key,'content-type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=30)as r:return r.status,json.loads(r.read())
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
supabase_api=s['API_URL'];service_key=s['SERVICE_ROLE_KEY']
def ai_request(body,n=1,path='/functions/v1/ai-chat/feedback'):
 req=urllib.request.Request('http://127.0.0.1:59641'+path,data=json.dumps(body).encode(),headers={'apikey':s['ANON_KEY'],'authorization':'Bearer '+TOKENS[n],'content-type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=30)as r:return r.status,json.loads(r.read())
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
ai_id='fda70000-0000-4000-8000-000000000001';lease='fda70000-0000-4000-8000-000000000002'
if not sql("select count(*)from private.ai_result_receipts where request_id='"+ai_id+"';")=='1':
 sql("insert into private.ai_member_processing(user_id,active_request_id)values('"+uid(1)+"','"+ai_id+"')on conflict(user_id)do update set active_request_id=excluded.active_request_id;insert into private.ai_chat_requests(request_id,user_id,client_request_hash,lease_token,expires_at)values('"+ai_id+"','"+uid(1)+"',repeat('8',64),'"+lease+"',clock_timestamp()+interval'3 minutes')on conflict do nothing;")
 code,value=internal_rpc('record_ai_chat_result_available',{'p_user_id':uid(1),'p_request_id':ai_id,'p_lease_token':lease});assert code==200
 code,value=internal_rpc('finish_ai_chat_request',{'p_user_id':uid(1),'p_request_id':ai_id,'p_lease_token':lease,'p_outcome':'finished'});assert code==200
payload={'clientRequestId':'additional-helpful-'+str(uuid.uuid4()),'requestId':ai_id,'action':'helpful'}
with concurrent.futures.ThreadPoolExecutor(max_workers=6)as pool:
 replies=list(pool.map(lambda _:ai_request(payload),range(6)))
assert all(c==200 and v['data']['status']=='accepted'for c,v in replies)
assert len({v['data']['feedbackId']for c,v in replies})==1
assert ai_request(payload,2)[0]==403
assert ai_request({**payload,'requestId':str(uuid.uuid4())})[0]==409
assert ai_request({**payload,'userId':uid(2)})[0]==400
report={'clientRequestId':'additional-report-'+str(uuid.uuid4()),'requestId':ai_id,'action':'report','confirmed':True,'attachment':{'kind':'answer','text':'회원이 제출한 합성 답변 증거'}}
code,value=ai_request(report);assert code==200 and value['data']['status']=='not_enabled'
assert value['data']['reason']=='AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED'
# Temporarily ready fixture capability: no provider call or operational approval.
sql("update private.ai_report_handling_control set enabled=true where singleton;")
try:
 code,value=ai_request(report);assert code==200 and value['data']['status']=='accepted'and value['data']['hideAnswer']is True
 fid=value['data']['feedbackId'];code,repeated=ai_request(report);assert code==200 and repeated['data']==value['data']
 assert ai_request({**report,'attachment':{'kind':'answer','text':'다른 증거'}})[0]==409
 assert ai_request({**report,'clientRequestId':str(uuid.uuid4()),'attachment':{'kind':'capture','assetId':str(uuid.uuid4())}})[0]==403
 report_id=sql("select report_id from private.ai_feedback_receipts where feedback_id='"+fid+"';")
 assert sql("select target_type from private.member_reports where id='"+report_id+"';")=='ai_answer'
finally:sql("update private.ai_report_handling_control set enabled=false where singleton;")
# Capture variant: actual member upload→confirmation→AI attachment→assigned binary read.
asset_id=str(uuid.uuid4());reserved=checked('/report-captures',1,{'assetId':asset_id,'extension':'png'},'POST')
image=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC+0AAAAASUVORK5CYII=')
object_name=uid(1)+'/'+asset_id+'.png'
upload=urllib.request.Request(s['API_URL']+'/storage/v1/object/report-evidence/'+object_name,data=image,method='POST',headers={'apikey':s['ANON_KEY'],'authorization':'Bearer '+TOKENS[1],'content-type':'image/png'})
with urllib.request.urlopen(upload,timeout=30)as response:assert response.status==200
checked('/report-captures/'+asset_id+'/confirm',1,{},'POST')
capture_report={'clientRequestId':str(uuid.uuid4()),'requestId':ai_id,'action':'report','confirmed':True,'attachment':{'kind':'capture','assetId':asset_id}}
sql("update private.ai_report_handling_control set enabled=true where singleton;")
try:
 code,captured=ai_request(capture_report);assert code==200 and captured['data']['status']=='accepted'
finally:sql("update private.ai_report_handling_control set enabled=false where singleton;")
capture_rid=sql("select report_id from private.ai_feedback_receipts where feedback_id='"+captured['data']['feedbackId']+"';")
sql("select private.set_report_operator_approval('"+uid(3)+"',true);select private.set_report_operator_assignment('"+uid(3)+"','"+capture_rid+"',true);")
assert request('/operator/reports/'+capture_rid,2)[0]==403
capture_meta=checked('/operator/reports/'+capture_rid,3);assert len(capture_meta['assets'])==1
for member in [2,3]:
 req=urllib.request.Request('http://127.0.0.1:59642/functions/v1/service-api/operator/reports/'+capture_rid+'/captures/'+asset_id,headers={'apikey':s['ANON_KEY'],'authorization':'Bearer '+TOKENS[member]})
 if member==2:
  try:urllib.request.urlopen(req,timeout=30);raise AssertionError('foreign capture access')
  except urllib.error.HTTPError as error:assert error.code==403
 else:
  with urllib.request.urlopen(req,timeout=30)as response:assert response.status==200 and response.read()==image
assert sql("select count(*)from private.report_access_audit where report_id='"+capture_rid+"'and actor_id='"+uid(3)+"';")!='0'
receipt['aiCaptureActualUploadAclAudit']='PASS'
# Assigned operator's real JWT can inspect and close AI evidence without member sanctions.
sql("select private.set_report_operator_approval('"+uid(3)+"',true);select private.set_report_operator_assignment('"+uid(3)+"','"+report_id+"',true);")
op='/operator/reports/'+report_id
assert request(op,2)[0]==403
inspected=checked(op,3);assert inspected['targetType']=='ai_answer'and inspected['description']==report['attachment']['text']
started=checked(op+'/review/start',3,{'clientRequestId':str(uuid.uuid4()),'expectedVersion':1},'POST')
decision=checked(op+'/adjudications',3,{'clientRequestId':str(uuid.uuid4()),'mode':'initial','expectedReportVersion':started['version'],'expectedHoldVersion':None,'expectedIncidentRevision':0,'appointmentOutcome':'unchanged','incidentOutcome':'none','responsibleRole':'none','representativeReasonCode':'no_action','violationClass':'none','violationType':None},'POST')
closed=checked(op+'/final-closures',3,{'clientRequestId':str(uuid.uuid4()),'expectedReportVersion':decision['version'],'expectedIncidentRevision':0,'resolutionSummary':'합성 AI 신고 검토 완료'},'POST')
assert sql("select retention_due_at=final_closed_at+interval'2160 hours'from private.member_reports where id='"+report_id+"';")=='t'
assert sql("select count(*)from private.report_access_audit where report_id='"+report_id+"'and actor_id='"+uid(3)+"'and action='report_read';")!='0'
# Due checks and cascading evidence removal are local transaction probes, not runner delivery evidence.
attachment_sql=json.dumps(report['attachment'],ensure_ascii=False).replace("'","''")
key_sql=report['clientRequestId'].replace("'","''")
purge_check=sql(f"""begin;
with stamp as(select clock_timestamp()-interval'91 days'as closed)update private.member_reports set final_closed_at=stamp.closed,retention_due_at=stamp.closed+interval'2160 hours'from stamp where id='{report_id}';
select private.report_purge_eligible('{report_id}');
delete from private.member_reports where id='{report_id}';
select count(*)from private.member_report_details where report_id='{report_id}';
select count(*)from private.ai_feedback_receipts where feedback_id='{fid}'and report_id is null;
set local role service_role;
do $$begin begin
 perform public.submit_ai_feedback('{uid(1)}','{ai_id}','{key_sql}','report','{attachment_sql}'::jsonb,'2026-10-05');
 raise exception 'duplicate_was_recreated';exception when sqlstate 'PT404'then null;end;end;$$;
rollback;""")
assert purge_check.splitlines()[-3:]==['t','0','1']
receipt['aiAssignedReviewClosureAndRetention']='PASS'
# Helpful deletion uses accepted time. Source expiry prevents recreation after metadata purge.
sql("begin;update private.ai_feedback_receipts set accepted_at=clock_timestamp()-interval'91 days'where user_id='"+uid(1)+"'and action='helpful';update private.ai_result_receipts set available_at=clock_timestamp()-interval'91 days'where request_id='"+ai_id+"';set local role service_role;select public.purge_expired_ai_feedback(100);reset role;select count(*)from private.ai_feedback_receipts where user_id='"+uid(1)+"'and action='helpful';rollback;")
# No raw-model transport is configured, and feedback did not consume member budget.
code,unavailable=ai_request({'clientRequestId':str(uuid.uuid4()),'messages':[{'role':'user','content':'합성 탐색'}],'currentFilters':{'target':'posts','region':'서울특별시'}},path='/functions/v1/ai-chat')
assert code==200 and unavailable['data']['status']=='unavailable'
with urllib.request.urlopen('http://127.0.0.1:59641/fixture-metrics')as response:assert json.loads(response.read())['externalRequests']==0
receipt['aiHelpfulConcurrent']='PASS';receipt['aiReportStorageOnly']='PASS';receipt['aiGuardClosedAndExternalRequestsZero']='PASS'
(STATE/'http-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
