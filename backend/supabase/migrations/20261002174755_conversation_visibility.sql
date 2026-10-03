-- 나가기는 본인의 목록만 숨긴다. 상대 기록·메시지·신청·약속·알림은 변경하지 않는다.
BEGIN;

CREATE TABLE private.conversation_visibility (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.join_requests(id) ON DELETE CASCADE,
  hidden_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX conversation_visibility_request_idx ON private.conversation_visibility(request_id);
ALTER TABLE private.conversation_visibility ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.conversation_visibility FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.leave_conversation(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := private.require_member_uid();
BEGIN
  IF private.request_role(p_request_id) IS NULL THEN
    RAISE EXCEPTION 'request_unavailable' USING ERRCODE = 'P0002';
  END IF;
  -- 유일 키가 같은 본인의 동시 요청을 직렬화한다. 재시도는 최초 숨김 시각을 보존한다.
  INSERT INTO private.conversation_visibility(user_id, request_id)
    VALUES (v_uid, p_request_id)
    ON CONFLICT (user_id, request_id) DO NOTHING;
  RETURN jsonb_build_object('requestId', p_request_id, 'hidden', true);
END;
$$;
REVOKE ALL ON FUNCTION public.leave_conversation(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.leave_conversation(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_conversations()
RETURNS TABLE (
  request_id uuid, my_role text, request_status text, post_id uuid, post_title text, post_starts_at timestamptz,
  counterpart_masked_name text, counterpart_avatar_url text, last_message text, last_message_at timestamptz, last_activity_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT r.id,
         CASE WHEN r.requester_id = (SELECT auth.uid()) THEN 'requester' ELSE 'author' END,
         r.status, p.id, p.title, p.starts_at,
         public.mask_real_name(pr.real_name), pr.avatar_url,
         m.content, m.created_at, greatest(r.updated_at, coalesce(m.created_at, r.created_at))
  FROM public.join_requests r
  JOIN public.posts p ON p.id = r.post_id
  JOIN public.profiles pr ON pr.id = CASE WHEN r.requester_id = (SELECT auth.uid()) THEN p.author_id ELSE r.requester_id END
  LEFT JOIN LATERAL (
    SELECT cm.content, cm.created_at FROM public.chat_messages cm
    WHERE cm.join_request_id = r.id ORDER BY cm.created_at DESC, cm.id DESC LIMIT 1
  ) m ON true
  WHERE (r.requester_id = (SELECT auth.uid()) OR p.author_id = (SELECT auth.uid()))
    AND p.status <> 'deleted'
    AND NOT EXISTS (
      SELECT 1 FROM private.conversation_visibility cv
      WHERE cv.user_id = (SELECT auth.uid()) AND cv.request_id = r.id
    )
  ORDER BY 11 DESC;
$$;

COMMIT;
