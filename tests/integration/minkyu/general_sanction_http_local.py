"""민규: 고유 release88-http 서버만 사용하는 실제 Auth/JWT/socket HTTP 검증.
새 격리 서버를 준비한 뒤 한 번 실행한다. 기존 서버/운영 서버에 적용하지 않는다.
시험 데이터는 자기 프로젝트 전체 정리로 삭제하며 회원 네이버 실로그인 증거와 구분한다.
"""
import json,subprocess,base64,hmac,hashlib,time,urllib.request,urllib.error,concurrent.futures,uuid,importlib.util
from pathlib import Path
ROOT=Path('/private/tmp/yumidang-release88-http-isolated');REPO=Path(__file__).resolve().parents[3];s=json.loads((ROOT/'status-private.json').read_text());assert s['API_URL']=='http://127.0.0.1:59621'
BASE=['docker','--host','unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock','exec','-i','supabase_db_yumidang-release88-http','psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
def sql(text):
 r=subprocess.run(BASE,input=text,text=True,capture_output=True,timeout=120)
 if r.returncode:(ROOT/'sql-failure-private.log').write_text(r.stderr);raise RuntimeError('SQL_FAILED')
 return r.stdout.strip()
fixture=(REPO/'tests/database/minkyu/assigned_report_notice_receipts.sql').read_text().split('-- 옛74 receipt')[0]
fixture+="""set local role authenticated;select pg_temp.safety_actor(3);
select pg_temp.adjudicate(1,501,'initial',2,1,0,'normal','confirmed','companion','spam','minor','spam');
select pg_temp.safety_actor(1);select public.submit_member_report(gen_random_uuid(),'member',pg_temp.safety_uid(2),'offline',array['spam'],'격리 숨김 신고','{}',true);
reset role;update private.general_notice_delivery_control set enabled=true;
select jsonb_build_object('noticeId',(select id from private.member_decision_notices where violation_outcome='confirmed'));
commit;"""
assert not(ROOT/'fixture-started.json').exists();assert sql('select count(*)from auth.users;')=='0';(ROOT/'fixture-started.json').write_text('{"ownedProjectOnly":true}');out=sql(fixture);(ROOT/'fixture-private.log').write_text(out);notice=json.loads(out.splitlines()[-1])['noticeId']
import secrets
TOKENS={}
for n in [1,2]:
 uid='fe910000-0000-4000-8000-'+str(n).zfill(12);password=secrets.token_urlsafe(30)
 email=sql("select email from auth.users where id='"+uid+"';")
 sql("update auth.users set instance_id='00000000-0000-0000-0000-000000000000',aud='authenticated',role='authenticated',created_at=clock_timestamp(),updated_at=clock_timestamp(),email_confirmed_at=clock_timestamp(),confirmation_token='',recovery_token='',email_change_token_new='',email_change='',email_change_token_current='',phone_change='',phone_change_token='',reauthentication_token='',encrypted_password=crypt('"+password+"',gen_salt('bf'))where id='"+uid+"';")
 req=urllib.request.Request(s['API_URL']+'/auth/v1/token?grant_type=password',data=json.dumps({'email':email,'password':password}).encode(),headers={'apikey':s['ANON_KEY'],'content-type':'application/json'})
 with urllib.request.urlopen(req,timeout=20)as response:session=json.loads(response.read())
 TOKENS[n]=session['access_token'];claims=json.loads(base64.urlsafe_b64decode(TOKENS[n].split('.')[1]+'=='))
 req=urllib.request.Request(s['API_URL']+'/rest/v1/rpc/record_naver_session',data=json.dumps({'p_subject':'review-start-sql-'+str(n),'p_user_id':uid,'p_session_id':claims['session_id']}).encode(),headers={'apikey':s['SERVICE_ROLE_KEY'],'authorization':'Bearer '+s['SERVICE_ROLE_KEY'],'content-type':'application/json'})
 with urllib.request.urlopen(req,timeout=20)as response:response.read()
def token(n):return TOKENS[n]
def request(path,n=2,body=None,method='GET',auth=False):
 url=s['API_URL']+path if auth else 'http://127.0.0.1:59630/functions/v1/service-api'+path
 req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),method=method,headers={'authorization':'Bearer '+token(n),'apikey':s['ANON_KEY'],'content-type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=30)as r:return r.status,json.loads(r.read())
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
results=[]
def expect(label,pair,status=200):
 code,body=pair;results.append({'check':label,'status':code,'pass':code==status});assert code==status,label+':'+str(code);return body.get('data',body)
for n in [1,2]:expect('actual_auth_user_'+str(n),request('/auth/v1/user',n,auth=True))
items=expect('hidden_list',request('/me/hidden-targets',1));assert len(items['items'])==1
hidden=items['items'][0];expect('unhide',request('/me/hidden-targets/unhide',1,hidden,'POST'));assert expect('unhide_requery',request('/me/hidden-targets',1))['items']==[]
expect('foreign_notice',request('/decision-notices/'+notice+'/prepare-delivery',1,{},'POST'),404)
prepared=expect('prepare_no_clock',request('/decision-notices/'+notice+'/prepare-delivery',2,{},'POST'));assert prepared['providedAt']is None and prepared['deadlineAt']is None
expect('read_no_clock',request('/decision-notices/'+notice+'/read',2,{},'POST'));assert expect('prepare_after_read',request('/decision-notices/'+notice+'/prepare-delivery',2,{},'POST'))['providedAt']is None
delivery={'deliveryId':prepared['deliveryId']};provided=expect('success_provided',request('/decision-notices/'+notice+'/provided',2,delivery,'POST'))
again=expect('provided_replay',request('/decision-notices/'+notice+'/provided',2,delivery,'POST'));assert again['providedAt']==provided['providedAt']and again['deadlineAt']==provided['deadlineAt']
body={'noticeId':notice,'clientRequestId':str(uuid.uuid4()),'reason':'격리 동시 이의'}
with concurrent.futures.ThreadPoolExecutor(max_workers=6)as pool:pairs=list(pool.map(lambda _:request('/me/general-sanction-appeals',2,body,'POST'),range(6)))
assert all(c in[200,409]for c,_ in pairs)and any(c==200 for c,_ in pairs)
ids={b['data']['appealId']for c,b in pairs if c==200};assert len(ids)==1
results.append({'check':'concurrent_6_one_appeal','pass':True,'successes':sum(c==200 for c,_ in pairs),'conflicts':sum(c==409 for c,_ in pairs)})
appeal=expect('appeal_replay',request('/me/general-sanction-appeals',2,body,'POST'));assert appeal['appealId']in ids and appeal['alreadyApplied']is True
expect('own_appeal',request('/me/general-sanction-appeals/'+appeal['appealId']));expect('foreign_appeal',request('/me/general-sanction-appeals/'+appeal['appealId'],1),404)
assert sql("select count(*)from private.safety_appeals where kind='general';")=='1'
(ROOT/'http-receipt.json').write_text(json.dumps({'status':'PASS','realAuthHttp':True,'localAuthPasswordGrant':True,'realServiceSocketHttp':True,'results':results,'operating':False},indent=2));print(json.dumps({'status':'PASS','checks':len(results),'ownedProjectOnly':True}))
