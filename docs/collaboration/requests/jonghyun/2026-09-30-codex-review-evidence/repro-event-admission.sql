begin;
set local role service_role;
select public.upsert_events('[{"provider": "synthetic-audit", "sourceId": "invalid-admission", "sourceStatus": "active", "precision": "date", "startsOn": "2026-10-05", "endsOn": "2026-10-11", "title": "가상 비용 검증", "category": "연극", "region": "가상시", "placeName": null, "publicAddress": null, "admission": {}, "sourceUrl": null, "collectedAt": "2026-09-30T00:00:00Z"}]'::jsonb);
reset role;
select admission from private.events where provider='synthetic-audit';
rollback;
