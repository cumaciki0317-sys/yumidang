#!/usr/bin/env python3
"""전용 로컬 Auth + 민규 TS 인증/DB 클라이언트 + 실제 검색 RPC 검증. GET API 검사가 아님."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import tomllib
import uuid

from runtime_e2e import http, db, ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workdir', required=True, type=Path)
    args = parser.parse_args()
    root = args.workdir.resolve()
    config = root / 'supabase/config.toml'
    db.require(root.is_relative_to(Path('/private/tmp')) and not config.is_symlink(), '전용 임시 루트 필요')
    db.require(tomllib.loads(config.read_text()).get('project_id') == db.PROJECT, '전용 project 필요')
    endpoint = db.docker('context', 'inspect', db.CONTEXT, '--format', '{{.Endpoints.docker.Host}}')
    inspection = db.docker('inspect', db.CONTAINER)
    db.validate_target(endpoint.stdout.strip(), json.loads(inspection.stdout)[0])
    env = dict(os.environ, SUPABASE_TELEMETRY_DISABLED='1', DO_NOT_TRACK='1',
               DOCKER_HOST='unix://' + str(Path.home() / '.colima/yumidang-minkyu/docker.sock'))
    result = subprocess.run(['npx', '--yes', 'supabase@2.116.0', 'status', '--workdir', str(root), '-o', 'json'],
                            capture_output=True, text=True, env=env, timeout=30, check=True)
    keys = json.loads(result.stdout)
    api, anon, service = keys['API_URL'], keys['ANON_KEY'], keys['SERVICE_ROLE_KEY']
    db.require(api in ('http://127.0.0.1:55421', 'http://localhost:55421'), '원격 API 금지')
    users = []
    with db.SessionLock(73109000), tempfile.TemporaryDirectory(prefix='yumidang-search-client-') as temp:
        db.require(db.sql('select (select count(*) from auth.users)+(select count(*) from public.posts);').stdout.strip() == '0', '빈 전용 DB 필요')
        try:
            tokens = []
            for _ in range(2):
                email, password = secrets.token_hex(12)+'@example.invalid', secrets.token_urlsafe(32)
                status, user, _ = http(api+'/auth/v1/admin/users', 'POST', {'email':email,'password':password,'email_confirm':True}, service, service)
                db.require(status == 200, '가상 사용자 생성 실패')
                users.append(str(uuid.UUID(user['id'])))
                status, session, _ = http(api+'/auth/v1/token?grant_type=password', 'POST', {'email':email,'password':password}, apikey=anon)
                db.require(status == 200 and 'access_token' in session, '가상 세션 실패')
                tokens.append(session['access_token'])
            author, viewer = users
            posts = [str(uuid.uuid4()) for _ in range(3)]
            db.sql(f"""begin;
              insert into public.profiles(id,real_name,birth_date,gender) values
              ('{author}','김서연','1990-01-01','female'),('{viewer}','박민규','1980-01-01','female');
              insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,created_at,cost_type,amount) values
              ('{posts[0]}','{author}','최신 등록 전시','가상 검사','전시',now()+interval '2 days',now()+interval '2 days 1 hour',now()+interval '12 hours','서울특별시 종로구 삼청동',now(),'free',0),
              ('{posts[1]}','{author}','빠른 시작 전시','가상 검사','전시',now()+interval '1 day',now()+interval '1 day 1 hour',now()+interval '12 hours','서울특별시 종로구 삼청동',now()-interval '1 day','free',0),
              ('{posts[2]}','{author}','지난 비용 미확인 전시','가상 검사','전시',now()-interval '3 days',now()-interval '2 days',now()-interval '4 days','서울특별시 종로구 삼청동',now()-interval '2 days',null,null);
              insert into private.post_search_locations(post_id,registered_place_name,registered_address) values
              ('{posts[0]}','가상 전시장','서울특별시 종로구 등록주소비밀 12');
              commit;""")
            shared = ROOT / 'backend/supabase/functions/_shared'
            script = Path(temp) / 'check.ts'
            imports = '\n'.join([
                'import {loadRuntimeConfig} from '+json.dumps(str(shared/'config/env.ts'))+';',
                'import {requireOptionalPrincipal} from '+json.dumps(str(shared/'auth/principal.ts'))+';',
                'import {createPublicClient} from '+json.dumps(str(shared/'db/public-client.ts'))+';',
                'import {createUserClient} from '+json.dumps(str(shared/'db/user-client.ts'))+';',
                'import {toPublicError} from '+json.dumps(str(shared/'http/errors.ts'))+';',
            ])
            script.write_text(imports + r'''
const check = (ok: unknown) => { if (!ok) throw new Error("assertion"); };
const config = loadRuntimeConfig((key) => Deno.env.get(key));
const ids = JSON.parse(Deno.env.get("SEARCH_FIXTURE_IDS")!);
const token = Deno.env.get("SEARCH_VIEWER_TOKEN")!;
let passed = 0;
let stage = "initial";
const pass = (name: string) => { passed++; console.log(JSON.stringify({status:"PASS", test:name})); };
const request = (header?: string) => new Request("http://127.0.0.1/search-test", {headers:header === undefined ? {} : {Authorization:header}});
async function reject(work: () => Promise<unknown>, code: string) {
  try { await work(); } catch (error) { if (toPublicError(error).error.code !== code) throw new Error("unexpected_"+toPublicError(error).error.code); return; }
  throw new Error("expected rejection");
}
try {
  check(await requireOptionalPrincipal(request(),config) === null);
  const publicDb = createPublicClient(config);
  const base = {query:"", category:null, cost:"all", availability:"all", periodStart:null, periodEnd:null, authorAge:"all", sort:"created_desc"};
  const search = async (client: typeof publicDb, filters: object, cursor: unknown = null, limit = 50) =>
    await client.rpc("search_public_posts_v2",{p_filters:filters,p_cursor:cursor,p_limit:limit} as never) as any;
  const all = await search(publicDb,base);
  check(all.items.length === 3 && all.items[0].id === ids[0]);
  check(all.items.every((p:any) => p.publicArea === "서울특별시 종로구 삼청동" && /^동행 \d+$/.test(p.authorDisplayName) && p.canApply === false));
  const serialized = JSON.stringify(all);
  check(!serialized.includes("김서연") && !serialized.includes("birth") && !serialized.includes("등록주소비밀"));
  pass("anonymous_all_states_dong_alias_private_fields_excluded");
  stage = "anonymous_period";
  const period = { ...base, periodStart:new Date(Date.now()+3600000).toISOString(), periodEnd:new Date(Date.now()+4*86400000).toISOString() };
  check((await search(publicDb,period)).items.length === 2);
  stage = "anonymous_age_rejection";
  await reject(() => search(publicDb,{...base,authorAge:"30s"}),"AUTH_REQUIRED");
  pass("anonymous_period_allowed_age_restricted");
  check((await search(publicDb,{...base,sort:"starts_asc"})).items[0].id === ids[2]);
  check((await search(publicDb,{...base,availability:"recruiting",sort:"starts_asc"})).items[0].id === ids[1]);
  const page = await search(publicDb,base,null,1);
  const next = await search(publicDb,base,page.nextCursor,1);
  check(page.items[0].id === ids[0] && next.items[0].id === ids[1]);
  check((await search(publicDb,{...base,query:"등록주소비밀"})).items.length === 1);
  pass("explicit_sort_cursor_and_private_address_matching");
  const principal = await requireOptionalPrincipal(request("Bearer "+token),config);
  check(principal !== null);
  const member = createUserClient(config,principal!);
  const aged = await search(member,{...base,authorAge:"30s"});
  check(aged.items.length === 3 && aged.items[0].authorDisplayName === "김*연");
  check(aged.items[0].canApply === true);
  pass("real_member_jwt_age_mask_and_application_rights");
  for (const header of ["", "Basic nope", "Bearer broken.token.signature", "Bearer "+config.supabaseAnonKey]) {
    await reject(() => requireOptionalPrincipal(request(header),config),"AUTH_REQUIRED");
  }
  pass("invalid_auth_never_falls_back_to_anonymous");
  await reject(() => publicDb.rpc("create_service_post",{}),"ACCESS_DENIED");
  pass("public_client_cannot_mutate");
  console.log(JSON.stringify({status:"PASS",scenarios:passed}));
} catch (error) { console.log(JSON.stringify({status:"FAIL",stage,code:toPublicError(error).error.code,check:error instanceof Error && /^unexpected_[A-Z_]+$/.test(error.message) ? error.message : "assertion"})); Deno.exit(1); }
''')
            child_env = {key:os.environ[key] for key in ('PATH','HOME','TMPDIR') if key in os.environ}
            child_env.update(SUPABASE_URL=api,SUPABASE_ANON_KEY=anon,ALLOWED_ORIGINS='[]',MAX_REQUEST_BYTES='16384',UPSTREAM_TIMEOUT_MS='5000',
                             SEARCH_FIXTURE_IDS=json.dumps(posts),SEARCH_VIEWER_TOKEN=tokens[1])
            run = subprocess.run(['deno','run','--no-prompt','--allow-env','--allow-net=127.0.0.1:55421,localhost:55421',str(script)],
                                 capture_output=True,text=True,env=child_env,timeout=60)
            for line in run.stdout.splitlines():
                try: value = json.loads(line)
                except ValueError: continue
                if value.get('status') in ('PASS','FAIL'): print(json.dumps(value),flush=True)
            db.require(run.returncode == 0, '실제 검색 클라이언트 검사 실패(원문 출력 생략)')
        finally:
            if users:
                ids = ','.join("'"+value+"'" for value in users)
                db.sql(f'delete from public.posts where author_id in ({ids});')
                for uid in users:
                    status, _, _ = http(api+'/auth/v1/admin/users/'+uid,'DELETE',token=service,apikey=service)
                    db.require(status == 200, '가상 사용자 정리 실패')
        db.require(db.sql('select (select count(*) from auth.users)+(select count(*) from public.posts);').stdout.strip() == '0', 'fixture 잔존')
    print(json.dumps({'status':'PASS','fixtures_remaining':0,'get_search_http':'NOT_RUN'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Never print credentials, commands, user records, or external response bodies.
        print(json.dumps({'status':'FAIL','error':str(exc) if isinstance(exc,(AssertionError,RuntimeError)) else type(exc).__name__},ensure_ascii=False))
        raise SystemExit(1)
