-- KOPIS trusted service publisher 전용. 기존 requested-only/worker held/HTTP 응답은 보존한다.
begin;
create table private.kopis_verified_categories (
 mode text primary key, official_condition text not null
);
insert into private.kopis_verified_categories values
 ('all','전체 공연'),('theatre','연극'),('musical','뮤지컬'),('classical','클래식'),
 ('traditional','국악'),('popular_music','대중음악'),('dance','무용'),('popular_dance','대중무용'),
 ('circus_magic','서커스/마술'),('mixed','복합'),('children','아동'),('daehakro','대학로'),('visiting','내한'),('festival','축제');
create table private.kopis_verified_snapshots (
 mode text primary key references private.kopis_verified_categories(mode),
 snapshot jsonb not null, checked_at timestamptz not null,
 period_start date not null, period_end date not null,
 refresh_failed boolean not null default false,
 check(period_end-period_start=6)
);
alter table private.kopis_verified_categories enable row level security;
alter table private.kopis_verified_categories force row level security;
alter table private.kopis_verified_snapshots enable row level security;
alter table private.kopis_verified_snapshots force row level security;
revoke all on private.kopis_verified_categories,private.kopis_verified_snapshots from public,anon,authenticated,service_role;

create function public.publish_verified_kopis_snapshot(p_snapshot jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare s jsonb:=p_snapshot;c text;v_mode text;d date;e date;t timestamptz;n timestamptz:=clock_timestamp();old private.kopis_verified_snapshots;item jsonb;previous_rank integer:=0;ids text[]:='{}';rank_number integer;
begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_required'using errcode='42501';end if;
 -- JSON verified:true 등은 계약에 없고 서비스 자격 자체가 기존 신뢰 경계다.
 if jsonb_typeof(s)is distinct from'object' or octet_length(s::text)>50000 or
   not s?&array['status','mode','sourceName','period','collectedAt','items','officialUrl','checkedAt','refreshDelayed','officialCondition','apiPeriodVerified'] or
   s-array['status','mode','sourceName','period','collectedAt','items','officialUrl','checkedAt','refreshDelayed','officialCondition','apiPeriodVerified']<>'{}'::jsonb then
  raise exception 'invalid_verified_kopis_snapshot'using errcode='22023';end if;
 v_mode:=s->>'mode';select official_condition into c from private.kopis_verified_categories where kopis_verified_categories.mode=v_mode;
 if c is null or s->>'officialCondition'is distinct from c or s->>'status'is distinct from'available' or s->>'sourceName'is distinct from'KOPIS'
   or s->>'officialUrl'is distinct from'https://www.kopis.or.kr/por/boxoffice/boxoffice.do'
   or s->'refreshDelayed'is distinct from'false'::jsonb or jsonb_typeof(s->'apiPeriodVerified')is distinct from'boolean'
   or jsonb_typeof(s->'period')is distinct from'object' or not(s->'period')?&array['start','end'] or (s->'period')-array['start','end']<>'{}'::jsonb then
  raise exception 'invalid_verified_kopis_snapshot'using errcode='22023';end if;
 d:=private.event_calendar_date_v1(s#>>'{period,start}');e:=private.event_calendar_date_v1(s#>>'{period,end}');
 t:=private.event_instant_v1(s->>'checkedAt');
 if e-d<>6 or e<>(n at time zone'Asia/Seoul')::date-1 or t>n or t<n-interval'15 minutes'
   or private.event_instant_v1(s->>'collectedAt')>n or jsonb_typeof(s->'items')is distinct from'array'
   or jsonb_array_length(s->'items')not between 1 and 10 then raise exception 'invalid_verified_kopis_snapshot'using errcode='22023';end if;
 for item in select value from jsonb_array_elements(s->'items')loop
  if jsonb_typeof(item)is distinct from'object' or not item?&array['rank','sourceId','title','genre','originalGenre','performancePeriodText','placeName','region']
    or item-array['rank','sourceId','title','genre','originalGenre','performancePeriodText','placeName','region']<>'{}'::jsonb
    or jsonb_typeof(item->'rank')is distinct from'number' or (item->>'rank')!~'^[1-9][0-9]{0,3}$'
    or (item->>'sourceId')!~'^PF[0-9A-Za-z]+$' or item->>'sourceId'=any(ids) then raise exception 'invalid_verified_kopis_snapshot'using errcode='22023';end if;
  rank_number:=(item->>'rank')::integer;
  if rank_number<previous_rank or rank_number>1000 then raise exception 'invalid_verified_kopis_snapshot'using errcode='22023';end if;
  foreach c in array array['sourceId','title','genre','originalGenre','performancePeriodText','placeName','region']loop
   if jsonb_typeof(item->c)is distinct from'string' or not private.event_public_text_v1(item->>c,2000)then raise exception 'invalid_verified_kopis_snapshot'using errcode='22023';end if;
  end loop;
  ids:=array_append(ids,item->>'sourceId');previous_rank:=rank_number;
 end loop;
 -- 분류별 행 잠금은 최초 삽입 경쟁도 직렬화한다. 다른 분류의 실패와 독립이다.
 perform 1 from private.kopis_verified_categories where kopis_verified_categories.mode=v_mode for update;
 select *into old from private.kopis_verified_snapshots where kopis_verified_snapshots.mode=v_mode for update;
 if found and (old.period_end>e or old.checked_at>=t)then return jsonb_build_object('status','stale');end if;
 insert into private.kopis_verified_snapshots(mode,snapshot,checked_at,period_start,period_end,refresh_failed)
 values(v_mode,s,t,d,e,false)on conflict(mode)do update set snapshot=excluded.snapshot,checked_at=excluded.checked_at,
 period_start=excluded.period_start,period_end=excluded.period_end,refresh_failed=false;
 return jsonb_build_object('status','applied');
end;$$;

create function public.mark_verified_kopis_refresh_failed(p_mode text,p_attempt_started_at timestamptz,p_expected_checked_at timestamptz)returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare current_row private.kopis_verified_snapshots;
begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_required'using errcode='42501';end if;
 if p_attempt_started_at is null or p_attempt_started_at>clock_timestamp()then raise exception 'invalid_kopis_attempt'using errcode='22023';end if;
 perform 1 from private.kopis_verified_categories where mode=p_mode for update;
 if not found then raise exception 'invalid_kopis_mode'using errcode='22023';end if;
 select *into current_row from private.kopis_verified_snapshots where mode=p_mode for update;
 if not found or current_row.checked_at is distinct from p_expected_checked_at or p_attempt_started_at<=current_row.checked_at then
  return jsonb_build_object('status','stale');end if;
 update private.kopis_verified_snapshots set refresh_failed=true where mode=p_mode;
 return jsonb_build_object('status','recorded');
end;$$;

create function public.get_verified_kopis_ranking(p_mode text)returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s private.kopis_verified_snapshots;today date:=(statement_timestamp()at time zone'Asia/Seoul')::date;
begin
 if not exists(select 1 from private.kopis_verified_categories where mode=p_mode)then raise exception 'invalid_kopis_mode'using errcode='22023';end if;
 select *into s from private.kopis_verified_snapshots where mode=p_mode;
 if not found then return jsonb_build_object('status','unavailable','mode',p_mode,'sourceName','KOPIS','period',null,'collectedAt',null,
  'items','[]'::jsonb,'officialUrl','https://www.kopis.or.kr/por/boxoffice/boxoffice.do','checkedAt',null,'refreshDelayed',false);end if;
 return (s.snapshot-array['officialCondition','apiPeriodVerified'])||jsonb_build_object('refreshDelayed',s.refresh_failed or s.period_end<>today-1);
end;$$;

-- 기존 server SECDEF owner와 정렬. migration 실행 actor의 owner를 제품 권한으로 승격하지 않는다.
do $$declare own text;sig text;t text;r text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.complete_event_ranking_collection(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure;
 if not exists(select 1 from pg_roles where rolname=own and(rolsuper or rolbypassrls))then raise exception 'kopis_owner_incompatible'using errcode='55000';end if;
 foreach r in array array['anon','authenticated','service_role','authenticator']loop
  if pg_has_role(r,own,'USAGE')or pg_has_role(r,own,'SET')then raise exception 'kopis_owner_incompatible'using errcode='55000';end if;
 end loop;
 foreach t in array array['private.kopis_verified_categories','private.kopis_verified_snapshots']loop execute format('alter table %s owner to %I',t,own);end loop;
 foreach sig in array array['public.publish_verified_kopis_snapshot(jsonb)','public.mark_verified_kopis_refresh_failed(text,timestamptz,timestamptz)','public.get_verified_kopis_ranking(text)']loop
  execute format('alter function %s owner to %I',sig,own);execute format('revoke all on function %s from public,anon,authenticated,service_role',sig);
 end loop;
end;$$;
grant execute on function public.publish_verified_kopis_snapshot(jsonb),public.mark_verified_kopis_refresh_failed(text,timestamptz,timestamptz)to service_role;
grant execute on function public.get_verified_kopis_ranking(text)to anon,authenticated,service_role;
commit;
