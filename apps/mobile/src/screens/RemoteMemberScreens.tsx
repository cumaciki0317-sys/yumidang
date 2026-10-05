import React, { useCallback, useEffect, useRef, useState } from "react";
import { Image, View } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import { ApiError } from "../api";
import { installMemberSessionDetails, serviceSessionEpoch, useMemberPorts, useMemberService, useService, useServiceSession } from "../remote";
import { reconcilePhoto, replacePhoto, type PhotoInput, validateOriginalPhoto } from "../avatar-service";
import { retirementResult } from "../member-session";
import type { MemberService, Wire } from "../member-service";
import { useApp } from "../state";
import { Body, Button, Card, Chip, Empty, Field, Row, Screen, TextButton, Title } from "../ui";
import RemotePlacePicker from "./RemotePlacePicker";
import type { AppointmentLocationInput } from "../../../../backend/supabase/functions/_shared/contracts/matching";
import type { MemberReportInput } from "../../../../backend/supabase/functions/_shared/contracts/reports";
import type { FreePostInput } from "../../../../backend/supabase/functions/_shared/contracts/posts";

const text = (value: unknown) => typeof value === "string" ? value : "";
const idOf = (row: Wire, key: string) => text(row[key]);
const statusLabel = (value: unknown) => ({ pending: "신청 대기", active: "대화 중", confirmed: "동행 확정", completed: "완료", cancelled: "취소", disputed: "분쟁 검토 중", declined: "거절", rejected: "거절", withdrawn: "철회", expired: "기한 만료", recruiting: "모집 중", closed: "모집 종료", submitted: "신고 접수", received: "신고 접수", reviewing: "신고 검토 중", resolved: "처리 완료", accepted: "수락", awaiting_consent: "확정 응답 대기" } as Record<string, string>)[text(value)] ?? "현재 상태 확인 필요";
const failure = (error: unknown) => error instanceof ApiError && error.status === 401
  ? "다시 로그인해 주세요."
  : error instanceof ApiError && (error.status === 409 || error.status === 410)
  ? "상태가 바뀌었거나 응답 기한이 지났어요. 새로고침해서 확인해 주세요."
  : "처리하지 못했어요. 입력한 내용은 유지했으니 상태를 확인하고 다시 시도해 주세요.";

/** Reads and writes are fenced by the verified session epoch and screen focus. */
export function useMemberResource<T>(key: string, load: (service: MemberService, signal: AbortSignal) => Promise<T>) {
  const service = useMemberService(), session = useServiceSession();
  const [revision, setRevision] = useState(0);
  const fullKey = `${session.epoch}:${key}:${revision}`;
  const loader = useRef(load);
  useEffect(() => { loader.current = load; }, [load]);
  const [state, setState] = useState<{ key: string; data: T | null; error: string; busy: boolean }>({ key: "", data: null, error: "", busy: false });
  useFocusEffect(useCallback(() => {
    const active = new AbortController();
    setState({ key: fullKey, data: null, error: "", busy: true });
    if (!session.authenticated || !service) {
      setState({ key: fullKey, data: null, error: "로그인이 필요해요.", busy: false });
      return () => active.abort();
    }
    void loader.current(service, active.signal).then(data => {
      if (!active.signal.aborted && serviceSessionEpoch() === session.epoch) setState({ key: fullKey, data, error: "", busy: false });
    }).catch(error => {
      if (!active.signal.aborted && serviceSessionEpoch() === session.epoch) setState({ key: fullKey, data: null, error: failure(error), busy: false });
    });
    return () => active.abort();
  }, [fullKey, service, session.authenticated, session.epoch]));
  return { ...(state.key === fullKey ? state : { data: null, error: "", busy: true }), reload: () => setRevision(n => n + 1) };
}

export function useMemberAction() {
  const service = useMemberService(), session = useServiceSession();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [actionEpoch, setActionEpoch] = useState(session.epoch);
  const active = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  useFocusEffect(useCallback(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); lock.current = false; };
  }, []));
  useEffect(() => { active.current?.abort(); lock.current = false; }, [session.epoch]);
  const run = async <T,>(task: (s: MemberService, signal: AbortSignal) => Promise<T>, success?: (data: T) => void) => {
    if (lock.current || !service || !session.authenticated) return false;
    const controller = new AbortController(), epoch = serviceSessionEpoch();
    active.current = controller; lock.current = true; setActionEpoch(epoch); setBusy(true); setError("");
    try {
      const data = await task(service, controller.signal);
      if (controller.signal.aborted || epoch !== serviceSessionEpoch() || !mounted.current) return false;
      success?.(data); return true;
    } catch (e) {
      if (!controller.signal.aborted && epoch === serviceSessionEpoch() && mounted.current) setError(failure(e));
      return false;
    } finally {
      if (active.current === controller && epoch === serviceSessionEpoch() && mounted.current) { lock.current = false; setBusy(false); }
    }
  };
  return { busy: actionEpoch === session.epoch && busy, error: actionEpoch === session.epoch ? error : "", run };
}

function useIntentId() {
  const previous = useRef<{ fingerprint: string; id: string } | null>(null);
  return (input: unknown) => {
    const fingerprint = JSON.stringify(input);
    if (!previous.current || previous.current.fingerprint !== fingerprint) previous.current = { fingerprint, id: Crypto.randomUUID() };
    return previous.current.id;
  };
}

function Guard({ children }: { children: React.ReactNode }) {
  const session = useServiceSession(), app = useApp(), service = useMemberService();
  if (!session.authenticated) return <Screen title="로그인"><Empty title="로그인하고 동행을 이어가세요" action="네이버로 로그인" onPress={() => app.navigate("S05")} /></Screen>;
  if (!service) return <Screen title="연결 확인"><Empty title="서비스 연결을 준비하고 있어요" /></Screen>;
  return <>{children}</>;
}
function Status({ busy, error, reload }: { busy?: boolean; error?: string; reload?: () => void }) {
  return <>{busy && <Body muted>현재 상태를 확인하고 있어요…</Body>}{error && <Empty title={error} action={reload ? "다시 확인" : undefined} onPress={reload} />}</>;
}

export function RemoteChatsScreen() { return <Guard><RemoteChats /></Guard>; }
function RemoteChats() {
  const app = useApp(), list = useMemberResource("conversations", (s, signal) => s.conversations(signal));
  return <Screen title="채팅" tab right={<TextButton onPress={list.reload}>새로고침</TextButton>}>
    <Status {...list} />
    {list.data?.map(row => <Card key={idOf(row, "request_id")} onPress={() => app.navigate("S11", `request:${idOf(row, "request_id")}`)}>
      <Title>{text(row.post_title)}</Title><Body>{text(row.counterpart_masked_name)}</Body><Body muted>{text(row.last_message) || "대화를 확인해 주세요"}</Body>
    </Card>)}
    {list.data?.length === 0 && <Empty title="진행 중인 대화가 없어요" action="동행 둘러보기" onPress={() => app.navigate("S01")} />}
  </Screen>;
}

export function RemoteChatScreen({ postId, conversationId }: { postId?: string; conversationId?: string }) {
  return <Guard><RemoteChat key={`${postId}:${conversationId}:${serviceSessionEpoch()}`} postId={postId} conversationId={conversationId} /></Guard>;
}
function RemoteChat({ postId, conversationId }: { postId?: string; conversationId?: string }) {
  const app = useApp(), action = useMemberAction();
  const [requestId, setRequestId] = useState(conversationId ?? ""), [input, setInput] = useState("");
  const [confirmation, setConfirmation] = useState<"leave" | "withdraw" | null>(null);
  const message = useRef<{ content: string; id: string } | null>(null);
  const conversation = useMemberResource(`chat:${requestId}`, async (s, signal) => requestId ? s.conversation(requestId, signal) : null);
  const messages = useMemberResource(`messages:${requestId}`, async (s, signal) => requestId ? s.messages(requestId, undefined, signal) : { items: [], nextCursor: null });
  const consent = useMemberResource(`consent:${requestId}`, async (s, signal) => requestId ? s.consent(requestId, signal) : null);
  const viewer = useMemberResource("chat-viewer", (s, signal) => s.profile(signal));
  const [older, setOlder] = useState<Wire[]>([]), [before, setBefore] = useState<string | null | undefined>();
  const refresh = () => { conversation.reload(); messages.reload(); consent.reload(); setOlder([]); setBefore(undefined); };
  const olderCursor = before === undefined ? messages.data?.nextCursor : before;
  const send = () => {
    const content = input.trim(); if (!content || [...content].length > 1000) { app.showToast("메시지는 1~1000자로 입력해 주세요."); return; }
    if (!message.current || message.current.content !== content) message.current = { content, id: Crypto.randomUUID() };
    const attempt = message.current;
    void action.run((s, signal) => requestId ? s.sendMessage(requestId, attempt.id, content, signal) : s.firstMessage(postId ?? "", attempt.id, content, signal), result => {
      if (!requestId) setRequestId(text(result.id));
      setInput(""); message.current = null; refresh(); app.showToast("메시지를 보냈어요.");
    });
  };
  const version = text(consent.data?.conditionVersion);
  const pending = consent.data?.status === "awaiting_consent";
  const conditions = consent.data?.conditions as Wire | undefined;
  const conditionsValid = conditions?.costType === "free" && conditions.amount === 0 && Boolean(text(conditions.title)) && Boolean(text(conditions.publicArea)) && Number.isFinite(Date.parse(text(conditions.startsAt))) && Number.isFinite(Date.parse(text(conditions.endsAt))) && Date.parse(text(conditions.startsAt)) < Date.parse(text(conditions.endsAt));
  const expired = !text(consent.data?.expiresAt) || Date.parse(text(consent.data?.expiresAt)) <= app.now;
  const host = conversation.data?.my_role === "author";
  const sendAllowed = requestId ? conversation.data?.can_send === true : Boolean(postId);
  return <Screen title={text(conversation.data?.post_title) || "1:1 대화"} right={<TextButton onPress={refresh}>새로고침</TextButton>} footer={<View style={{ gap: 8 }}>
    <Field editable={!action.busy} label={requestId ? "메시지" : "첫 메시지"} value={input} onChangeText={setInput} multiline placeholder="함께 하고 싶은 활동을 이야기해 주세요" />
    {!requestId && <Body small muted>첫 메시지가 전송되면 동행 신청이 함께 생성돼요.</Body>}
    <Button disabled={!sendAllowed || !input.trim()} loading={action.busy} onPress={send}>메시지 보내기</Button>
  </View>}>
    <Status busy={conversation.busy && Boolean(requestId)} error={conversation.error || messages.error || consent.error} reload={refresh} />
    {pending && <Card><Title>동행 확정 요청</Title><Body>응답 마감 · {text(consent.data?.expiresAt)}</Body>
      <ConsentConditions conditions={consent.data?.conditions} />
      {host ? <Button secondary loading={action.busy} onPress={() => void action.run((s, signal) => s.requestAction(requestId, "consent/withdraw", version, signal), refresh)}>확정 요청 철회</Button>
        : <><Button disabled={expired || !version || !conditionsValid} loading={action.busy} onPress={() => void action.run((s, signal) => s.requestAction(requestId, "accept", version, signal), refresh)}>이 조건으로 동행 확정</Button>
          <TextButton onPress={() => void action.run((s, signal) => s.requestAction(requestId, "consent/decline", version, signal), refresh)}>확정 요청 거절</TextButton></>}
    </Card>}
    {host && !pending && conversation.data?.request_status === "pending" && <Button secondary loading={action.busy} onPress={() => void action.run((s, signal) => s.requestAction(requestId, "propose", undefined, signal), refresh)}>동행 확정 요청 보내기</Button>}
    {[...older, ...(messages.data?.items ?? [])].map(row => <Card key={idOf(row, "messageId")}><Body>{text(row.content)}</Body><Body small muted>{text(row.createdAt)}</Body>{viewer.data && row.senderId !== viewer.data.userId && <RemoteReport targetId={idOf(row, "messageId")} targetType="chat" />}</Card>)}
    {olderCursor && <Button secondary loading={action.busy} onPress={() => void action.run((s, signal) => s.messages(requestId, olderCursor, signal), page => { setOlder(items => [...page.items, ...items]); setBefore(page.nextCursor); })}>이전 메시지 보기</Button>}
    {requestId && <Row><TextButton onPress={() => setConfirmation("leave")}>대화방 나가기</TextButton>{!host && <TextButton onPress={() => setConfirmation("withdraw")}>신청 철회</TextButton>}</Row>}
    {text(conversation.data?.appointment_id) && <Button secondary onPress={() => app.navigate("S16", text(conversation.data?.appointment_id))}>확정 약속 보기</Button>}
    {confirmation && <Card><Title>{confirmation === "leave" ? "내 목록에서 이 대화를 숨길까요?" : "동행 신청을 철회할까요?"}</Title><Body muted>{confirmation === "leave" ? "약속은 취소되지 않고 상대의 대화방은 유지돼요." : "이미 확정된 동행은 약속에서 별도로 취소해야 해요."}</Body>
      <Button loading={action.busy} onPress={() => void action.run((s, signal) => confirmation === "leave" ? s.leave(requestId, signal) : s.requestAction(requestId, "withdraw", undefined, signal), () => { setConfirmation(null); app.navigate("S10"); })}>확인</Button><TextButton onPress={() => setConfirmation(null)}>계속 대화하기</TextButton></Card>}
    {host && text(conversation.data?.post_id) && <RemotePostManagement postId={text(conversation.data?.post_id)} onChanged={refresh} />}
    <Status busy={action.busy} error={action.error} />
  </Screen>;
}

export function RemoteMeScreen() { return <Guard><RemoteMe /></Guard>; }
function RemoteMe() {
  const app = useApp(), profile = useMemberResource("me", (s, signal) => s.profile(signal)), appointments = useMemberResource("appointments", (s, signal) => s.appointments(signal));
  return <Screen title="마이페이지" tab right={<TextButton onPress={() => { profile.reload(); appointments.reload(); }}>새로고침</TextButton>}>
    <Status {...profile} />
    {profile.data && <Card><Title>{profile.data.realName} 님</Title><Body>나의 당도 · {profile.data.sweetness}</Body><Body muted>{profile.data.bio || "소개를 작성해 보세요"}</Body></Card>}
    <Row><Button secondary onPress={() => app.navigate("S15")}>대표 사진</Button><Button secondary onPress={() => app.navigate("S15-2")}>취향·성향</Button></Row>
    <Title>내 약속</Title><Status {...appointments} />
    {appointments.data?.map(row => <Card key={idOf(row, "appointment_id")} onPress={() => app.navigate("S16", idOf(row, "appointment_id"))}><Title>{text(row.post_title)}</Title><Body>{statusLabel(row.status)}</Body><Body>{text(row.post_starts_at)}</Body></Card>)}
    {appointments.data?.length === 0 && <Body muted>확정된 약속이 없어요.</Body>}
    <RemoteRequestList />
    <Button secondary onPress={() => app.navigate("S12")}>알림</Button>
    <Button secondary onPress={() => app.navigate("S21")}>계정·AI 처리·차단 관리</Button>
  </Screen>;
}
function RemoteRequestList() {
  const app = useApp(), [direction, setDirection] = useState<"sent" | "received">("sent");
  const page = useMemberResource(`requests:${direction}`, (s, signal) => s.requests(direction, signal));
  return <View style={{ gap: 10 }}><Title>동행 신청</Title><Row><Chip selected={direction === "sent"} onPress={() => setDirection("sent")}>보낸 신청</Chip><Chip selected={direction === "received"} onPress={() => setDirection("received")}>받은 신청</Chip></Row><Status {...page} />
    {page.data?.map(row => <Card key={text(row.request_id ?? row.id)} onPress={() => app.navigate("S11", `request:${text(row.request_id ?? row.id)}`)}><Title>{text(row.post_title)}</Title><Body>{statusLabel(row.status ?? row.request_status)}</Body></Card>)}
  </View>;
}

/** Only a current server-owned author conversation establishes this management entry. */
export function RemotePostManagement({ postId, onChanged }: { postId: string; onChanged?: () => void }) {
  const app = useApp(), action = useMemberAction();
  const ownership = useMemberResource(`post-owner:${postId}`, (s, signal) => s.conversations(signal));
  const [choice, setChoice] = useState<"close" | "delete" | "reopen" | null>(null);
  if (!ownership.data?.some(row => row.my_role === "author" && row.post_id === postId)) return null;
  return <Card><Title>내 공고 관리</Title><Button secondary onPress={() => app.navigate("S03", `edit:${postId}`)}>공고 수정</Button>
    <Row><TextButton onPress={() => setChoice("close")}>모집 종료</TextButton><TextButton onPress={() => setChoice("reopen")}>모집 재개</TextButton><TextButton onPress={() => setChoice("delete")}>공고 삭제</TextButton></Row>
    {choice && <><Body>{choice === "delete" ? "공고를 삭제할까요? 기존 약속은 서버 정책에 따라 보호돼요." : choice === "close" ? "신규 신청을 받지 않도록 모집을 종료할까요?" : "이 공고의 모집을 다시 시작할까요? 서버에서 재개 조건을 확인해요."}</Body><Button loading={action.busy} onPress={() => void action.run((s, signal) => s.postAction(postId, choice, signal), () => { setChoice(null); onChanged?.(); app.showToast("공고 상태를 변경했어요."); })}>변경 확인</Button><TextButton onPress={() => setChoice(null)}>취소</TextButton></>}
    <Status error={action.error} />
  </Card>;
}

export function RemoteBlockControls({ profileId }: { profileId: string }) {
  const app = useApp(), action = useMemberAction(), self = useMemberResource("block-viewer", (s, signal) => s.profile(signal));
  const [confirm, setConfirm] = useState(false);
  if (!self.data || self.data.userId === profileId) return null;
  return <Card><TextButton onPress={() => setConfirm(true)}>이 회원 차단</TextButton>
    {confirm && <><Body>이 회원과의 접촉을 막을까요? 확정 동행 취소는 약속에서 별도로 처리해야 해요.</Body><Button loading={action.busy} onPress={() => void action.run((s, signal) => s.block(profileId, true, signal), () => { app.showToast("이 회원을 차단했어요."); app.navigate("S10"); })}>차단 확인</Button><TextButton onPress={() => setConfirm(false)}>취소</TextButton></>}
    <Status error={action.error} />
  </Card>;
}

export function RemoteProfilePhoto({ path }: { path: string | null }) {
  const ports = useMemberPorts();
  const photo = useMemberResource(`profile-image:${path ?? ""}:${Boolean(ports.photo)}`, async (_s, signal) => path && ports.photo ? ports.photo.display(path, signal) : null);
  return <>{photo.data && <Image source={{ uri: photo.data }} style={{ width: 96, height: 96, borderRadius: 48 }} />}{photo.error && <Body small muted>프로필 사진을 확인하지 못했어요.</Body>}</>;
}

export function RemotePostEditor({ id }: { id: string }) { return <Guard><PostEditor key={`${id}:${serviceSessionEpoch()}`} id={id} /></Guard>; }
function PostEditor({ id }: { id: string }) {
  const app = useApp(), publicService = useService(), action = useMemberAction();
  const source = useMemberResource(`post-edit:${id}`, async (s, signal) => {
    const conversations = await s.conversations(signal);
    if (!conversations.some(row => row.my_role === "author" && row.post_id === id) || !publicService) throw new ApiError(403, "POST_OWNERSHIP_NOT_VERIFIED");
    const post = await publicService.getPost(id, signal);
    if (!post.privateDetails) throw new ApiError(403, "POST_OWNERSHIP_NOT_VERIFIED");
    return post;
  });
  const [edited, setForm] = useState<FreePostInput | null>(null), [placeOpen, setPlaceOpen] = useState(false);
  const p = source.data;
  const form: FreePostInput | null = edited ?? (p ? { title: p.title, description: p.description, category: p.category, startsAt: p.startsAt, endsAt: p.endsAt, recruitmentEndsAt: p.recruitmentEndsAt, publicArea: p.publicArea, registeredPlaceName: p.privateDetails!.registeredPlaceName, registeredAddress: p.privateDetails!.registeredAddress, meetingDetail: p.privateDetails!.meetingDetail, preferenceNote: p.preferenceNote, tags: p.tags, costType: "free", amount: 0, eventId: p.eventId } : null);
  return <Screen title="내 공고 수정"><Status {...source} />{form && <>
    <Field editable={!action.busy} label="제목" value={form.title} onChangeText={title => setForm({ ...form, title })} />
    <Field editable={!action.busy} label="공고 소개" value={form.description} onChangeText={description => setForm({ ...form, description })} multiline />
    <Field editable={!action.busy} label="시작 일정" value={form.startsAt} onChangeText={startsAt => setForm({ ...form, startsAt })} />
    <Field editable={!action.busy} label="종료 일정" value={form.endsAt} onChangeText={endsAt => setForm({ ...form, endsAt })} />
    <Field editable={!action.busy} label="모집 마감" value={form.recruitmentEndsAt} onChangeText={recruitmentEndsAt => setForm({ ...form, recruitmentEndsAt })} />
    <Body>{form.registeredPlaceName} · {form.registeredAddress}</Body><Button secondary onPress={() => setPlaceOpen(true)}>장소 변경</Button>
    <Field editable={!action.busy} label="상세 만남 지점" value={form.meetingDetail} onChangeText={meetingDetail => setForm({ ...form, meetingDetail })} />
    <Field editable={!action.busy} label="희망 조건 (선택)" value={form.preferenceNote ?? ""} onChangeText={preferenceNote => setForm({ ...form, preferenceNote: preferenceNote || null })} multiline />
    <Button loading={action.busy} disabled={!source.data} onPress={() => void action.run((s, signal) => s.update(id, form, source.data!.updatedAt, signal), () => { app.showToast("공고를 수정했어요."); app.navigate("S02", id); })}>공고 수정 저장</Button>
  </>}{placeOpen && form && <RemotePlacePicker onCancel={() => setPlaceOpen(false)} onSelect={place => { setForm({ ...form, publicArea: place.publicArea, registeredPlaceName: place.placeName, registeredAddress: place.address }); setPlaceOpen(false); }} />}<Status error={action.error} /></Screen>;
}

export function RemoteAppointmentScreen({ id }: { id?: string }) { return <Guard><RemoteAppointment key={`${id}:${serviceSessionEpoch()}`} id={id ?? ""} /></Guard>; }
function RemoteAppointment({ id }: { id: string }) {
  const app = useApp(), action = useMemberAction(), detail = useMemberResource(`appointment:${id}`, (s, signal) => s.appointment(id, signal)), schedule = useMemberResource(`change:${id}`, (s, signal) => s.changeState(id, signal));
  const [editing, setEditing] = useState(false), [start, setStart] = useState(""), [end, setEnd] = useState(""), [location, setLocation] = useState<AppointmentLocationInput | null>(null), [placeOpen, setPlaceOpen] = useState(false);
  const proposalId = useIntentId();
  const refresh = () => { detail.reload(); schedule.reload(); };
  const proposal = schedule.data?.change, pending = proposal?.status === "awaiting_response";
  const peerProposal = pending && proposal?.requestedByMe === false;
  const expired = Date.parse(text(proposal?.expiresAt)) <= app.now;
  return <Screen title="약속 상세" right={<TextButton onPress={refresh}>새로고침</TextButton>}>
    <Status busy={detail.busy || schedule.busy} error={detail.error || schedule.error} reload={refresh} />
    {detail.data && <><Card><Title>{text(detail.data.post_title)}</Title><Body>{statusLabel(detail.data.status)}</Body>
      {detail.data.status === "cancelled" ? schedule.data?.scheduleProvenance === "captured_at_cancellation" && schedule.data.startsAt && schedule.data.endsAt ? <Body>취소 당시 일정 · {schedule.data.startsAt} ~ {schedule.data.endsAt}</Body> : <Body muted>취소 당시 일정은 확인할 수 없어요.</Body> : <Body>{text(detail.data.post_starts_at)} ~ {text(detail.data.post_ends_at)}</Body>}
      <Body>{text(detail.data.post_public_area)}</Body><Body>{text(detail.data.counterpart_masked_name)}</Body></Card>
      <Button disabled={detail.data.can_confirm_completion !== true} loading={action.busy} onPress={() => void action.run((s, signal) => s.confirmCompletion(id, signal), () => { refresh(); app.showToast("본인 완료 확인을 기록했어요."); })}>본인 동행 완료 확인</Button>
      <Body small muted>예상 종료 후 본인 확인을 하면 후기를 먼저 작성할 수 있어요. 공개는 실제 완료 후 후기 조건에 따라 처리돼요.</Body>
      <Button secondary onPress={() => app.navigate("S17", id)}>후기 작성·공개 상태 확인</Button>
      {detail.data.status === "confirmed" && <><Button secondary onPress={() => { setStart(schedule.data?.startsAt ?? ""); setEnd(schedule.data?.endsAt ?? ""); setEditing(!editing); }}>일정·장소 변경 제안</Button><Button secondary onPress={() => app.navigate("S18", `appointment:${id}`)}>약속 취소·신고</Button></>}
    </>}
    {pending && <Card><Title>변경 제안</Title><Body>응답 마감 · {text(proposal?.expiresAt)}</Body><Body>{text((proposal?.newSchedule as Wire | undefined)?.startsAt)} ~ {text((proposal?.newSchedule as Wire | undefined)?.endsAt)}</Body>
      {proposal?.locationChanged === true && proposal.newLocation !== null && <Body>{text((proposal.newLocation as Wire).registeredAddress)} · {text((proposal.newLocation as Wire).meetingDetail)}</Body>}
      <Row>{peerProposal && <Button disabled={expired} loading={action.busy} onPress={() => void action.run((s, signal) => s.changeAction(id, "accept", text(proposal?.changeId), text(proposal?.conditionVersion), signal), refresh)}>변경 수락</Button>}<Button secondary loading={action.busy} onPress={() => void action.run((s, signal) => s.changeAction(id, peerProposal ? "decline" : "withdraw", text(proposal?.changeId), text(proposal?.conditionVersion), signal), refresh)}>{peerProposal ? "변경 거절" : "제안 철회"}</Button></Row>
    </Card>}
    {editing && <Card><Field editable={!action.busy} label="변경 시작" value={start} onChangeText={setStart} placeholder="2026-10-06T14:00:00+09:00" /><Field editable={!action.busy} label="변경 종료" value={end} onChangeText={setEnd} placeholder="2026-10-06T16:00:00+09:00" />
      <Button secondary onPress={() => setPlaceOpen(true)}>만남 장소도 변경하기</Button>
      {location && <><Body>{location.registeredAddress}</Body><Field editable={!action.busy} label="상세 만남 지점" value={location.meetingDetail} onChangeText={meetingDetail => setLocation({ ...location, meetingDetail })} /><TextButton onPress={() => setLocation(null)}>장소는 그대로 유지</TextButton></>}
      <Button loading={action.busy} disabled={!schedule.data?.updatedAt || !start || !end || (location !== null && !location.meetingDetail.trim())} onPress={() => {
        const input = { startsAt: start, endsAt: end, expectedUpdatedAt: schedule.data!.updatedAt!, ...(location ? { location } : {}) };
        const changeId = proposalId(input);
        void action.run((s, signal) => s.proposeChange(id, { changeId, ...input }, signal), () => { setEditing(false); refresh(); });
      }}>변경 제안 보내기</Button>
    </Card>}
    {placeOpen && <RemotePlacePicker onCancel={() => setPlaceOpen(false)} onSelect={selected => { setLocation({ publicArea: selected.publicArea, registeredPlaceName: selected.placeName, registeredAddress: selected.address, meetingDetail: "" }); setPlaceOpen(false); }} />}
    <Status busy={action.busy} error={action.error} />
  </Screen>;
}

export function RemoteReviewScreen({ id }: { id?: string }) { return <Guard><RemoteReview key={`${id}:${serviceSessionEpoch()}`} id={id ?? ""} /></Guard>; }
function RemoteReview({ id }: { id: string }) {
  const app = useApp(), action = useMemberAction(), state = useMemberResource(`review:${id}`, (s, signal) => s.reviewState(id, signal)), catalog = useMemberResource("praises", (s, signal) => s.praises(signal));
  const [rating, setRating] = useState(0), [experience, setExperience] = useState<"positive" | "neutral" | "negative" | null>(null), [comment, setComment] = useState(""), [praises, setPraises] = useState<string[]>([]);
  return <Screen title="동행 상호 평가"><Status {...state} />
    {state.data && <><Body>작성 마감 · {text(state.data.deadline_at) || "실제 완료 후 확정돼요"}</Body><Body muted>{state.data.disputed === true ? "분쟁 검토 중에는 작성과 새 공개가 보류돼요." : state.data.released === true ? "후기가 공개되었어요." : "제출한 후기는 공개 조건을 충족할 때 상대에게 보여요."}</Body>
      {state.data.can_write === true && <><Title>동행은 어땠나요?</Title><Row>{(["positive", "neutral", "negative"] as const).map((value, i) => <Chip key={value} selected={experience === value} onPress={() => setExperience(value)}>{["좋았어요", "보통이에요", "아쉬웠어요"][i]}</Chip>)}</Row><Row>{[1, 2, 3, 4, 5].map(value => <Chip key={value} selected={rating === value} onPress={() => setRating(value)}>{value}점</Chip>)}</Row>
        <Field editable={!action.busy} label="후기 한마디 (선택)" value={comment} onChangeText={setComment} multiline />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{catalog.data?.map(row => <Chip key={text(row.code)} selected={praises.includes(text(row.code))} onPress={() => setPraises(values => values.includes(text(row.code)) ? values.filter(v => v !== row.code) : [...values, text(row.code)])}>{text(row.label)}</Chip>)}</View>
        <Button disabled={!experience || !rating} loading={action.busy} onPress={() => void action.run((s, signal) => s.review(id, { rating, experience: experience!, comment: comment.trim() || null, praises }, signal), () => { state.reload(); app.showToast("후기를 제출했어요. 공개 상태는 서버에서 확인해요."); })}>후기 제출</Button>
      </>}
      {state.data.released === true && state.data.peer_review && <Card><Title>상대 후기</Title><Body>{text((state.data.peer_review as Wire).comment)}</Body></Card>}
    </>}<Status error={action.error} />
  </Screen>;
}

export function RemoteCancelScreen({ id }: { id?: string }) { return <Guard><RemoteCancel key={`${id}:${serviceSessionEpoch()}`} id={id ?? ""} /></Guard>; }
function RemoteCancel({ id }: { id: string }) {
  const app = useApp(), action = useMemberAction(), [reason, setReason] = useState(""), [checked, setChecked] = useState(false);
  const cancellation = useIntentId();
  const appointmentId = id.startsWith("appointment:") ? id.slice(12) : "";
  return <Screen title="동행 취소·신고">{appointmentId ? <>
    <Body>취소와 신고는 별도로 처리돼요. 노쇼나 위협이 있었다면 신고 내용을 남겨 주세요.</Body>
    <Field editable={!action.busy} label="취소 사유" value={reason} onChangeText={setReason} multiline />
    <Chip selected={checked} onPress={() => setChecked(!checked)}>확정 약속을 취소하는 데 동의해요</Chip>
    <Button disabled={!reason.trim() || !checked} loading={action.busy} onPress={() => { const currentReason = reason.trim(), cancellationId = cancellation({ appointmentId, reason: currentReason }); void action.run((s, signal) => s.cancel(appointmentId, cancellationId, currentReason, signal), () => { app.showToast("약속을 취소했어요."); app.navigate("S16", appointmentId); }); }}>약속 취소</Button>
    <RemoteReport targetType="appointment" targetId={appointmentId} />
  </> : <Body muted>약속 상세에서 취소할 동행을 선택해 주세요.</Body>}<Status error={action.error} /></Screen>;
}

export function RemoteReport({ targetType, targetId }: { targetType: MemberReportInput["targetType"]; targetId: string }) {
  const action = useMemberAction(), app = useApp(), ports = useMemberPorts(), [open, setOpen] = useState(false), [description, setDescription] = useState(""), [reasons, setReasons] = useState<string[]>([]);
  const reportId = useIntentId();
  const [capture, setCapture] = useState<{ asset: ImagePicker.ImagePickerAsset; assetId: string } | null>(null);
  const uploaded = useRef(false);
  const pickCapture = async () => {
    const epoch = serviceSessionEpoch();
    try {
      const selected = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: false, quality: 1 });
      if (selected.canceled || epoch !== serviceSessionEpoch()) return;
      const asset = selected.assets[0];
      if (!["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType ?? "")) { app.showToast("JPG·PNG·WEBP 캡처를 선택해 주세요."); return; }
      setCapture({ asset, assetId: Crypto.randomUUID() });
    } catch { app.showToast("캡처를 선택하지 못했어요."); }
  };
  const offline = targetType === "appointment";
  return <View style={{ gap: 8 }}><TextButton onPress={() => setOpen(!open)}>문제 신고하기</TextButton>{open && <Card>
    <Title>신고 내용</Title><Body muted>접수는 위반 확정과 달라요. 운영자가 제출한 설명과 자료를 검토해요.</Body>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{[{ value: "sexual_harassment", label: "성희롱" }, { value: "threat", label: "협박·위협" }, { value: "money_or_personal_data", label: "금전·개인정보 요구" }, { value: "impersonation", label: "사칭" }, { value: "spam", label: "스팸" }, { value: "no_show", label: "노쇼" }, { value: "other", label: "기타" }].map(item => <Chip key={item.value} selected={reasons.includes(item.value)} onPress={() => setReasons(items => items.includes(item.value) ? items.filter(value => value !== item.value) : [...items, item.value])}>{item.label}</Chip>)}</View>
    <Field editable={!action.busy} label="상황 설명" value={description} onChangeText={setDescription} multiline />
    <Body muted>{offline ? "설명과 제출할 수 있는 자료로 접수해요." : "온라인 신고에는 설명과 캡처가 필요해요."}</Body>
    {!ports.reportCapture && <Body muted>캡처 업로드 연결을 준비 중이에요.</Body>}
    <Button secondary disabled={!ports.reportCapture || Boolean(capture)} onPress={() => void pickCapture()}>캡처 선택</Button>
    {capture && <><Body small>캡처를 선택했어요.</Body><Button secondary disabled={action.busy} onPress={() => void action.run(async (s, signal) => { if (uploaded.current) await s.cancelReportCapture(capture.assetId, signal); }, () => { setCapture(null); uploaded.current = false; })}>선택한 캡처 취소</Button></>}
    <Button disabled={!reasons.length || !description.trim() || (!offline && (!ports.reportCapture || !capture))} loading={action.busy} onPress={() => {
      const input = { targetType, targetId, context: offline ? "offline" as const : "online" as const, reasonCodes: [...reasons].sort(), description: description.trim(), assetIds: capture ? [capture.assetId] : [], hideTarget: false };
      const clientRequestId = reportId(input);
      void action.run(async (s, signal) => {
      const assetIds: string[] = [];
      if (capture) {
        if (!ports.reportCapture) throw new ApiError(503, "CAPTURE_NOT_CONFIGURED");
        const profile = await s.profile(signal);
        uploaded.current = true;
        const upload = await ports.reportCapture({ asset: capture.asset, assetId: capture.assetId, userId: profile.userId, signal });
        assetIds.push(upload.assetId);
      }
      return s.report({ clientRequestId, ...input, assetIds }, signal);
    }, () => { app.showToast("신고를 접수했어요."); setCapture(null); uploaded.current = false; setOpen(false); }); }}>신고 접수</Button>
    <Status error={action.error} />
  </Card>}</View>;
}

export function RemotePreferencesScreen() { return <Guard><RemotePreferences key={serviceSessionEpoch()} /></Guard>; }
function RemotePreferences() {
  const app = useApp(), action = useMemberAction(), initial = useMemberResource("preferences", async (s, signal) => ({ ...await s.getTraits(signal), bio: (await s.profile(signal)).bio }));
  const [edited, setValues] = useState<{ interests: string; conversationStyles: string; mbti: string; bio: string } | null>(null);
  const values = edited ?? (initial.data ? { interests: initial.data.interests.join(", "), conversationStyles: initial.data.conversationStyles.join(", "), mbti: initial.data.mbti ?? "", bio: initial.data.bio ?? "" } : null);
  const parts = (value: string) => value.split(",").map(v => v.trim()).filter(Boolean);
  return <Screen title="취향·성향 편집"><Status {...initial} />{values && <>
    <Body muted>선택 입력이에요. 여러 항목은 쉼표로 구분해 주세요.</Body>
    <Field editable={!action.busy} label="관심사" value={values.interests} onChangeText={interests => setValues({ ...values, interests })} />
    <Field editable={!action.busy} label="대화 방식" value={values.conversationStyles} onChangeText={conversationStyles => setValues({ ...values, conversationStyles })} />
    <Field editable={!action.busy} label="MBTI (선택)" value={values.mbti} onChangeText={mbti => setValues({ ...values, mbti })} />
    <Field editable={!action.busy} label="소개 (최대 300자)" value={values.bio} onChangeText={bio => setValues({ ...values, bio })} multiline />
    <Button loading={action.busy} disabled={[...values.bio].length > 300} onPress={() => void action.run((s, signal) => s.preferences({ interests: parts(values.interests), conversationStyles: parts(values.conversationStyles), mbti: values.mbti.trim().toUpperCase() || null, bio: values.bio.trim() || null }, signal), saved => { setValues({ interests: saved.interests.join(", "), conversationStyles: saved.conversationStyles.join(", "), mbti: saved.mbti ?? "", bio: saved.bio ?? "" }); initial.reload(); app.showToast("성향과 소개를 저장했어요."); })}>저장하기</Button>
  </>}<Status error={action.error} /></Screen>;
}

export function RemotePhotoScreen() { return <Guard><RemotePhoto key={serviceSessionEpoch()} /></Guard>; }
function RemotePhoto() {
  const app = useApp(), ports = useMemberPorts(), action = useMemberAction(), profile = useMemberResource("photo-profile", (s, signal) => s.profile(signal));
  const [input, setInput] = useState<PhotoInput | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<{ path: string; uncertain: boolean } | null>(null);
  const display = useMemberResource(`photo-display:${profile.data?.avatarUrl ?? ""}:${Boolean(ports.photo)}`, async (_s, signal) => profile.data?.avatarUrl && ports.photo ? ports.photo.display(profile.data.avatarUrl, signal) : null);
  const pick = async () => {
    const epoch = serviceSessionEpoch();
    try {
      const selected = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, allowsEditing: false });
      if (selected.canceled || epoch !== serviceSessionEpoch()) return;
      const asset = selected.assets[0], originalBytes = asset.fileSize ?? asset.file?.size;
      const chosen = { uri: asset.uri, mimeType: asset.mimeType ?? "", originalBytes: originalBytes ?? 0 };
      validateOriginalPhoto(chosen); setInput(chosen); attempt.current = null; setUncertain(false);
    } catch { app.showToast("크기를 확인할 수 있는 10MB 이하 JPG·PNG 사진을 선택해 주세요."); }
  };
  return <Screen title="대표 사진"><Status {...profile} /><Body muted>원본 JPG·PNG는 10MB 이하예요. 저장할 때 위치 등 사진 부가정보를 제거해요.</Body>
    {!input && display.data && <Image source={{ uri: display.data }} style={{ width: 180, height: 180, borderRadius: 12 }} />}
    {input && <Image source={{ uri: input.uri }} style={{ width: 180, height: 180, borderRadius: 12 }} />}
    <Button secondary disabled={action.busy || uncertain} onPress={() => void pick()}>사진 선택</Button>
    {!ports.photo && <Body muted>사진 저장 연결을 준비 중이에요. 현재 사진은 변경되지 않아요.</Body>}
    <Button disabled={!ports.photo || !profile.data || !input} loading={action.busy} onPress={() => void action.run(async (s, signal) => {
      if (!attempt.current) attempt.current = { path: `${profile.data!.userId}/${Crypto.randomUUID()}.jpg`, uncertain: false };
      if (attempt.current.uncertain) {
        const result = await reconcilePhoto(attempt.current.path, profile.data!.userId, s, signal);
        if (result.status !== "applied") throw new ApiError(503, "PHOTO_SWAP_UNCERTAIN");
        return { cleanupPending: true };
      }
      try { return await replacePhoto(input!, attempt.current.path, profile.data!.userId, ports.photo!, s, signal); }
      catch (error) { if (error instanceof ApiError && error.code === "PHOTO_SWAP_UNCERTAIN") { attempt.current.uncertain = true; setUncertain(true); } throw error; }
    }, result => { profile.reload(); display.reload(); setInput(null); attempt.current = null; setUncertain(false); app.showToast(result.cleanupPending ? "대표 사진은 저장했어요. 이전 사진 정리가 남아 있어요." : "대표 사진을 저장했어요."); })}>{uncertain ? "사진 저장 상태 다시 확인" : "대표 사진 저장"}</Button>
    <Status error={action.error} />
  </Screen>;
}

export function RemoteNotificationsScreen() { return <Guard><RemoteNotifications /></Guard>; }
function RemoteNotifications() {
  const app = useApp(), action = useMemberAction(), [cursor, setCursor] = useState<string | undefined>();
  const page = useMemberResource(`notifications:${cursor ?? ""}`, (s, signal) => s.notifications(cursor, signal));
  const notificationLabel = (kind: unknown) => ({ join_request: "새 동행 신청이 도착했어요", match_consent_requested: "동행 확정 요청을 확인해 주세요", match_confirmed: "동행이 확정되었어요", appointment_completed: "동행이 완료되었어요", match_consent_expired: "확정 요청의 응답 기한이 지났어요", match_consent_withdrawn: "확정 요청이 철회되었어요", match_consent_declined: "확정 요청이 거절되었어요", post_conditions_changed: "공고 조건이 변경되었어요", appointment_change_requested: "약속 변경 제안이 도착했어요", appointment_change_accepted: "약속 변경이 수락되었어요", appointment_cancelled: "약속이 취소되었어요" } as Record<string, string>)[text(kind)] ?? "동행의 최신 상태를 확인해 주세요";
  return <Screen title="알림" right={<TextButton onPress={() => void action.run((s, signal) => s.readNotification(null, signal), page.reload)}>모두 읽음</TextButton>}><Status {...page} />
    {page.data?.items.map(row => <Card key={text(row.notificationId)}><Title>{notificationLabel(row.kind)}</Title><Body small muted>{text(row.createdAt)} · {row.readAt === null ? "읽지 않음" : "읽음"}</Body>
      {text(row.requestId) && <Button secondary loading={action.busy} onPress={() => void action.run((s, signal) => s.readNotification(text(row.notificationId), signal), () => app.navigate("S11", `request:${text(row.requestId)}`))}>현재 대화·약속 확인</Button>}
      <TextButton onPress={() => void action.run((s, signal) => s.readNotification(text(row.notificationId), signal), page.reload)}>읽음 표시</TextButton></Card>)}
    {page.data?.items.length === 0 && <Body muted>알림이 없어요.</Body>}
    {page.data?.nextCursor && <Button secondary onPress={() => setCursor(page.data!.nextCursor!)}>이전 알림 보기</Button>}
    <Status error={action.error} />
  </Screen>;
}

export function RemoteAccountScreen() { return <Guard><RemoteAccount key={serviceSessionEpoch()} /></Guard>; }
function RemoteAccount() {
  const app = useApp(), action = useMemberAction(), ports = useMemberPorts();
  const [blocksCursor, setBlocksCursor] = useState<string | undefined>(), [reportsCursor, setReportsCursor] = useState<string | undefined>(), [reportId, setReportId] = useState("");
  const safety = useMemberResource("safety", (s, signal) => s.safety(signal)), blocks = useMemberResource(`blocks:${blocksCursor ?? ""}`, (s, signal) => s.blocks(blocksCursor, signal)), reports = useMemberResource(`reports:${reportsCursor ?? ""}`, (s, signal) => s.reports(reportsCursor, signal));
  const report = useMemberResource(`report:${reportId}`, (s, signal) => reportId ? s.getReport(reportId, signal) : Promise.resolve(null));
  const [withdraw, setWithdraw] = useState<"exploration" | "review_summary" | null>(null);
  const [retiring, setRetiring] = useState(false);
  const withdrawalId = useRef(Crypto.randomUUID());
  return <Screen title="계정 관리"><Status {...safety} />{safety.data && <Card><Title>계정 이용 상태</Title><Body>{safety.data.permanent === true ? "영구 이용 제한" : safety.data.restrictedUntil ? `제한 종료 · ${text(safety.data.restrictedUntil)}` : "이용 가능"}</Body><Body>{safety.data.hasWarning === true ? "운영 안내가 있어요" : "현재 경고 없음"}</Body></Card>}
    <Title>AI 처리 동의 철회</Title><Body muted>선택한 AI의 새 전송을 중단하고 관련 요약을 숨겨요. 계정과 일반 동행은 유지돼요.</Body>
    <Button secondary onPress={() => setWithdraw("exploration")}>AI 탐색 처리 철회</Button><Button secondary onPress={() => setWithdraw("review_summary")}>후기 요약 처리 철회</Button>
    {withdraw && <Card><Title>이 AI 처리를 철회할까요?</Title><Button loading={action.busy} onPress={() => void action.run((s, signal) => s.withdrawAi(withdraw, signal), () => { setWithdraw(null); app.showToast("AI 처리 철회를 요청했어요."); })}>철회 요청</Button><TextButton onPress={() => setWithdraw(null)}>취소</TextButton></Card>}
    <Title>차단한 회원</Title><Status {...blocks} />{blocks.data?.items.map(row => <Card key={text(row.targetId ?? row.target_id)}><Body>{text(row.displayName ?? row.display_name) || "차단한 회원"}</Body><TextButton onPress={() => void action.run((s, signal) => s.block(text(row.targetId ?? row.target_id), false, signal), blocks.reload)}>차단 해제</TextButton></Card>)}
    {blocks.data?.nextCursor && <Button secondary onPress={() => setBlocksCursor(blocks.data!.nextCursor!)}>다음 차단 목록</Button>}
    <Body small muted>차단을 해제해도 종료된 신청과 약속은 자동 복원되지 않아요.</Body>
    <Title>내 신고</Title><Status {...reports} />{reports.data?.items.map(row => <Card key={text(row.reportId ?? row.id)} onPress={() => setReportId(text(row.reportId ?? row.id))}><Body>{statusLabel(row.status)}</Body><Body small muted>{text(row.createdAt)}</Body></Card>)}
    {reports.data?.nextCursor && <Button secondary onPress={() => setReportsCursor(reports.data!.nextCursor!)}>이전 신고 목록</Button>}
    {reportId && <><Status {...report} />{report.data && <Card><Title>접수한 신고</Title><Body>{statusLabel(report.data.status)}</Body><Body>{text(report.data.description)}</Body><TextButton onPress={() => setReportId("")}>닫기</TextButton></Card>}</>}
    <Button secondary disabled={!ports.session} loading={action.busy} onPress={() => void action.run(async (_s, signal) => { if (!ports.session) throw new ApiError(503, "SESSION_NOT_CONFIGURED"); await ports.session.logout(signal); }, () => { installMemberSessionDetails(null); app.navigate("S05"); })}>로그아웃</Button>
    {!ports.session?.retire && <Body muted>탈퇴 서버 연결을 준비 중이에요. 연결되기 전에는 계정을 삭제하지 않아요.</Body>}<Button secondary disabled={!ports.session?.retire} onPress={() => setRetiring(true)}>회원 탈퇴</Button>
    {retiring && <Card><Title>회원 탈퇴를 요청할까요?</Title><Body>진행 중인 확정 동행은 먼저 정리해야 해요. 프로필·사진은 삭제하며 재가입해도 기존 후기는 복구하지 않아요.</Body><Button loading={action.busy} onPress={() => void action.run(async (_s, signal) => { if (!ports.session?.retire) throw new ApiError(503, "RETIREMENT_NOT_CONFIGURED"); return retirementResult(await ports.session.retire(withdrawalId.current, signal), withdrawalId.current); }, () => { installMemberSessionDetails(null); app.navigate("S05"); })}>탈퇴 요청 확인</Button><TextButton onPress={() => setRetiring(false)}>계정 유지하기</TextButton></Card>}
    <Status error={action.error} />
  </Screen>;
}

function ConsentConditions({ conditions }: { conditions: unknown }) {
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) return <Body muted>확정 조건을 확인하지 못했어요. 새로고침해 주세요.</Body>;
  const c = conditions as Wire;
  return <View style={{ gap: 8 }}><Title>{text(c.title)}</Title><Body>{text(c.startsAt)} ~ {text(c.endsAt)}</Body><Body>{text(c.publicArea)}</Body><Body>{text(c.description)}</Body>{text(c.preferenceNote) && <Body>희망 조건 · {text(c.preferenceNote)}</Body>}<Body>{c.costType === "free" && c.amount === 0 ? "무료 1:1 동행" : "현재 신청할 수 없는 비용 조건이에요"}</Body></View>;
}
