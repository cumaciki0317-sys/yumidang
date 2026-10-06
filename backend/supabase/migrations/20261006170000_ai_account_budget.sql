-- 민규: 기존 누적 호출 제한 + 계정/전체 KST 일일 예산. 외부 처리 guard는 기존 scoped RPC 그대로 유지.
begin;
create table private.ai_budget_accounts(account_id text primary key check(account_id in('yumi','jonghyun','minkyu','sungho')),
 account_order integer not null unique check(account_order between 1 and 4),registered boolean not null default false,unit_limit bigint not null default 3200000 check(unit_limit=3200000));
insert into private.ai_budget_accounts(account_id,account_order)values('yumi',1),('jonghyun',2),('minkyu',3),('sungho',4);
create table private.ai_global_daily_budget(kst_day date primary key,reserved_units bigint not null default 0 check(reserved_units>=0),charged_units bigint not null default 0 check(charged_units>=0));
create table private.ai_account_daily_budget(account_id text not null references private.ai_budget_accounts(account_id),kst_day date not null,
 reserved_units bigint not null default 0 check(reserved_units>=0),charged_units bigint not null default 0 check(charged_units>=0),primary key(account_id,kst_day));
create table private.ai_account_budget_reservations(reservation_id uuid primary key,
 ledger_id text not null references private.ai_budget_ledgers(ledger_id),account_id text not null references private.ai_budget_accounts(account_id),account_day date not null,
 reserved_units bigint not null check(reserved_units>0),unknown_at timestamptz,input_tokens bigint,output_tokens bigint,settled_at timestamptz,
 check((settled_at is null and input_tokens is null and output_tokens is null)or(settled_at is not null and unknown_at is null and input_tokens is not null and output_tokens is not null and input_tokens>=0 and output_tokens>=0)),
 foreign key(account_id,account_day)references private.ai_account_daily_budget(account_id,kst_day));
create function private.guard_ai_account_budget_receipt()returns trigger language plpgsql security definer set search_path=''as $$begin
 if tg_op='DELETE'then
  if old.settled_at is null or clock_timestamp()<((old.account_day+1)::timestamp at time zone'Asia/Seoul')+interval '2160 hours'then raise exception 'budget_receipt_retention_pending'using errcode='55000';end if;
  return old;
 end if;
 if(new.reservation_id,new.ledger_id,new.account_id,new.account_day,new.reserved_units)is distinct from(old.reservation_id,old.ledger_id,old.account_id,old.account_day,old.reserved_units)
 or(old.unknown_at is not null and new is distinct from old)or(old.settled_at is not null and new is distinct from old)then raise exception 'budget_receipt_immutable'using errcode='55000';end if;
 return new;
end;$$;
create trigger ai_account_receipt_guard before update or delete on private.ai_account_budget_reservations for each row execute function private.guard_ai_account_budget_receipt();
-- 호출자는 등록 계정 목록만 설정한다. 비밀키/회원 원문을 원장에 저장하지 않는다.
create function public.configure_ai_budget_accounts(p_account_ids text[])returns jsonb
language plpgsql volatile security definer set search_path=''as $$begin
 if p_account_ids is null or cardinality(p_account_ids)not between 1 and 4 or array_position(p_account_ids,null)is not null
 or exists(select 1 from unnest(p_account_ids)x where x not in('yumi','jonghyun','minkyu','sungho'))or cardinality(p_account_ids)<>(select count(distinct x)from unnest(p_account_ids)x)then
 raise exception 'invalid_account_registration'using errcode='22023';end if;
 perform 1 from private.ai_budget_accounts order by account_order for update;
 update private.ai_budget_accounts set registered=account_id=any(p_account_ids);
 return jsonb_build_object('registeredCount',cardinality(p_account_ids),'globalDailyUnits',cardinality(p_account_ids)::bigint*3200000);
end;$$;
create function private.reserve_ai_account_budget(p_ledger_id text,p_provider_id text,p_task text,p_units bigint,p_account_id text)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare l private.ai_budget_ledgers;a private.ai_budget_accounts;g private.ai_global_daily_budget;d private.ai_account_daily_budget;
 day date;global_limit numeric;legacy jsonb;reservation uuid;begin
 if p_account_id is null or p_units is null or p_units<1 then raise exception 'invalid_account_budget'using errcode='22023';end if;
 -- 기존 누적 원장을 먼저 잠그고 정산도 같은 순서를 따른다.
 select *into l from private.ai_budget_ledgers where ledger_id=p_ledger_id for update;
 if not found then raise exception 'budget_ledger_unavailable'using errcode='P0002';end if;
 perform 1 from private.ai_budget_accounts order by account_order for share;
 select *into a from private.ai_budget_accounts where account_id=p_account_id and registered;
 if not found then raise exception 'account_not_registered'using errcode='55000';end if;
 if l.reserved_units::numeric+l.charged_units+p_units>l.unit_limit or l.open_calls::numeric+l.settled_calls+1>l.call_limit then return jsonb_build_object('status','global_budget_denied','reservationId',null);end if;
 select sum(unit_limit)::numeric into global_limit from private.ai_budget_accounts where registered;
 loop
  day:=(clock_timestamp()at time zone'Asia/Seoul')::date;
  insert into private.ai_global_daily_budget(kst_day)values(day)on conflict do nothing;
  select *into g from private.ai_global_daily_budget where kst_day=day for update;
  insert into private.ai_account_daily_budget(account_id,kst_day)values(p_account_id,day)on conflict do nothing;
  select *into d from private.ai_account_daily_budget where account_id=p_account_id and kst_day=day for update;
  exit when day=(clock_timestamp()at time zone'Asia/Seoul')::date;
 end loop;
 if g.reserved_units::numeric+g.charged_units+p_units>global_limit then return jsonb_build_object('status','global_budget_denied','reservationId',null);end if;
 if d.reserved_units::numeric+d.charged_units+p_units>a.unit_limit then return jsonb_build_object('status','account_budget_denied','reservationId',null);end if;
 legacy:=public.reserve_ai_budget(p_ledger_id,p_provider_id,p_task,p_units);reservation:=(legacy->>'reservationId')::uuid;
 if reservation is null then return jsonb_build_object('status','global_budget_denied','reservationId',null);end if;
 update private.ai_global_daily_budget set reserved_units=reserved_units+p_units where kst_day=day;
 update private.ai_account_daily_budget set reserved_units=reserved_units+p_units where account_id=p_account_id and kst_day=day;
 insert into private.ai_account_budget_reservations(reservation_id,ledger_id,account_id,account_day,reserved_units)values(reservation,p_ledger_id,p_account_id,day,p_units);
 -- scoped chat의 기존 reservationId 성공 판정과 회원20회 원자 집계를 유지하는 내부 반환 형식.
 return jsonb_build_object('status','reserved','reservationId',reservation,'accountId',p_account_id,'accountDay',day);
end;$$;
-- 기존 정산 정의를 내부 core로 복사하고 기존 공개 정산으로 새 연결을 우회하지 못하게 한다.
do $$declare definition text;patched text;begin
 definition:=pg_get_functiondef('public.settle_ai_budget(uuid,text,bigint,bigint)'::regprocedure);
 execute replace(definition,'FUNCTION public.settle_ai_budget(','FUNCTION private.settle_legacy_ai_budget_core(');
 patched:=replace(definition,'  delete from private.ai_budget_reservations where id = p_reservation_id returning units into v_units;',
 '  if exists(select 1 from private.ai_account_budget_reservations where reservation_id=p_reservation_id)then raise exception ''account_settlement_required''using errcode=''42501'';end if;'||chr(10)||'  delete from private.ai_budget_reservations where id = p_reservation_id returning units into v_units;');
 if patched=definition then raise exception 'settlement_source_changed'using errcode='55000';end if;execute patched;
end;$$;
create function public.settle_ai_account_budget(p_reservation_id uuid,p_account_id text,p_account_day date,p_outcome text,p_input_tokens bigint,p_output_tokens bigint)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare receipt private.ai_account_budget_reservations;ledger text;charge numeric;g private.ai_global_daily_budget;d private.ai_account_daily_budget;begin
 if p_reservation_id is null or p_account_id is null or p_account_day is null or p_outcome is null or p_outcome not in('usage_reported','usage_unknown')
 or(p_outcome='usage_unknown'and(p_input_tokens is not null or p_output_tokens is not null))or(p_outcome='usage_reported'and(p_input_tokens is null or p_output_tokens is null or p_input_tokens<0 or p_output_tokens<0))then raise exception 'invalid_budget_settlement'using errcode='22023';end if;
 select ledger_id into ledger from private.ai_account_budget_reservations where reservation_id=p_reservation_id;
 if ledger is null then raise exception 'account_reservation_unavailable'using errcode='P0002';end if;
 perform 1 from private.ai_budget_ledgers where ledger_id=ledger for update;
 if not found then raise exception 'account_reservation_conflict'using errcode='40001';end if;
 select *into g from private.ai_global_daily_budget where kst_day=p_account_day for update;
 if not found then raise exception 'account_reservation_conflict'using errcode='40001';end if;
 select *into d from private.ai_account_daily_budget where account_id=p_account_id and kst_day=p_account_day for update;
 if not found then raise exception 'account_reservation_conflict'using errcode='40001';end if;
 select *into strict receipt from private.ai_account_budget_reservations where reservation_id=p_reservation_id for update;
 if receipt.account_id<>p_account_id or receipt.account_day<>p_account_day then raise exception 'account_reservation_conflict'using errcode='40001';end if;
 if receipt.settled_at is not null then
  if p_outcome<>'usage_reported'or receipt.input_tokens is distinct from p_input_tokens or receipt.output_tokens is distinct from p_output_tokens then raise exception 'budget_settlement_conflict'using errcode='40001';end if;
  return jsonb_build_object('settled',true,'pending',false);
 end if;
 if receipt.unknown_at is not null then
  if p_outcome<>'usage_unknown'then raise exception 'unknown_reservation_requires_review'using errcode='55000';end if;
  return jsonb_build_object('settled',false,'pending',true);
 end if;
 if not exists(select 1 from private.ai_budget_reservations where id=receipt.reservation_id and ledger_id=receipt.ledger_id and units=receipt.reserved_units)then raise exception 'account_reservation_conflict'using errcode='40001';end if;
 if p_outcome='usage_unknown'then
  update private.ai_account_budget_reservations set unknown_at=clock_timestamp()where reservation_id=p_reservation_id;
  return jsonb_build_object('settled',false,'pending',true);
 end if;
 charge:=p_input_tokens::numeric+p_output_tokens;
 if charge>9223372036854775807::numeric or g.charged_units::numeric+charge>9223372036854775807::numeric or d.charged_units::numeric+charge>9223372036854775807::numeric
 or g.reserved_units<receipt.reserved_units or d.reserved_units<receipt.reserved_units then raise exception 'invalid_budget_settlement'using errcode='22023';end if;
 perform private.settle_legacy_ai_budget_core(p_reservation_id,p_outcome,p_input_tokens,p_output_tokens);
 update private.ai_global_daily_budget set reserved_units=reserved_units-receipt.reserved_units,charged_units=charged_units+charge::bigint where kst_day=receipt.account_day;
 update private.ai_account_daily_budget set reserved_units=reserved_units-receipt.reserved_units,charged_units=charged_units+charge::bigint where account_id=receipt.account_id and kst_day=receipt.account_day;
 update private.ai_account_budget_reservations set input_tokens=p_input_tokens,output_tokens=p_output_tokens,settled_at=clock_timestamp()where reservation_id=p_reservation_id;
 return jsonb_build_object('settled',true,'pending',false);
end;$$;
-- 원 동의·lease·근거·회원 횟수 검사 본문을 고정 복사한다. 기존 함수는 보존한다.
do $$declare original regprocedure;definition text;patched text;target text;begin
 foreach original in array array['public.reserve_ai_chat_model(text,text,text,bigint,uuid,uuid,uuid,text)'::regprocedure,
 'public.reserve_review_summary_model(text,text,text,bigint,uuid,uuid,uuid,text,uuid,text,text,uuid[],text)'::regprocedure]loop
  definition:=pg_get_functiondef(original);
  if(length(definition)-length(replace(definition,'p_contract_version text)','')))/length('p_contract_version text)')<>1 or (length(definition)-length(replace(definition,'public.reserve_ai_budget(p_ledger_id,p_provider_id,p_task,p_units)','')))/length('public.reserve_ai_budget(p_ledger_id,p_provider_id,p_task,p_units)')<>1 then raise exception 'scoped_budget_source_changed'using errcode='55000';end if;
  target:=case when original::text like '%reserve_ai_chat_model%'then 'reserve_ai_chat_account_model'else'reserve_review_summary_account_model'end;
  patched:=replace(definition,'FUNCTION public.'||case when target='reserve_ai_chat_account_model'then'reserve_ai_chat_model'else'reserve_review_summary_model'end||'(','FUNCTION public.'||target||'(');
  patched:=replace(patched,'p_contract_version text)','p_contract_version text, p_account_id text)');
  patched:=replace(patched,'public.reserve_ai_budget(p_ledger_id,p_provider_id,p_task,p_units)','private.reserve_ai_account_budget(p_ledger_id,p_provider_id,p_task,p_units,p_account_id)');
  if patched=definition or position('p_account_id text)'in patched)=0 or position('private.reserve_ai_account_budget('in patched)=0 then raise exception 'scoped_budget_source_changed'using errcode='55000';end if;
  execute patched;
 end loop;
end;$$;
do $$declare own text;t regclass;f regprocedure;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.reserve_ai_budget(text,text,text,bigint)'::regprocedure;
 foreach t in array array['private.ai_budget_accounts'::regclass,'private.ai_global_daily_budget'::regclass,'private.ai_account_daily_budget'::regclass,'private.ai_account_budget_reservations'::regclass]loop
 execute format('alter table %s owner to %I',t,own);execute format('alter table %s enable row level security',t);execute format('revoke all on %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',t);end loop;
 foreach f in array array['private.guard_ai_account_budget_receipt()'::regprocedure,'public.configure_ai_budget_accounts(text[])'::regprocedure,'private.reserve_ai_account_budget(text,text,text,bigint,text)'::regprocedure,'private.settle_legacy_ai_budget_core(uuid,text,bigint,bigint)'::regprocedure,
 'public.settle_ai_account_budget(uuid,text,date,text,bigint,bigint)'::regprocedure,'public.reserve_ai_chat_account_model(text,text,text,bigint,uuid,uuid,uuid,text,text)'::regprocedure,
 'public.reserve_review_summary_account_model(text,text,text,bigint,uuid,uuid,uuid,text,uuid,text,text,uuid[],text,text)'::regprocedure]loop
 execute format('alter function %s owner to %I',f,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f);end loop;
end;$$;
grant execute on function public.configure_ai_budget_accounts(text[]),public.settle_ai_account_budget(uuid,text,date,text,bigint,bigint),
 public.reserve_ai_chat_account_model(text,text,text,bigint,uuid,uuid,uuid,text,text),public.reserve_review_summary_account_model(text,text,text,bigint,uuid,uuid,uuid,text,uuid,text,text,uuid[],text,text)to service_role;
commit;
