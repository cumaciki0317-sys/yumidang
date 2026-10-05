import { RemoteChatsScreen, RemoteChatScreen, RemoteMeScreen, RemotePhotoScreen, RemotePreferencesScreen, RemoteAppointmentScreen, RemoteReviewScreen, RemoteCancelScreen, RemoteNotificationsScreen, RemoteAccountScreen } from "./RemoteMemberScreens";
import { serviceMode } from "../remote";
import { RemoteProfileScreen } from "./RemoteScreens";
import React, { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useApp } from "../state";
import type { OperationResult, Review } from "../types";
import {
  canWriteReview,
  maskName,
  parseDateInput,
  PRAISES,
  reviewDeadline,
  reviewVisible,
  summarySources,
} from "../domain";
import {
  Avatar,
  Badge,
  Body,
  Button,
  Card,
  Chip,
  colors,
  dateLabel,
  Divider,
  Empty,
  Field,
  Icon,
  MemberBox,
  PostCard,
  rangeLabel,
  Row,
  Screen,
  Section,
  TextButton,
  timeLabel,
  Title,
} from "../ui";

function LoginGuard({ title, tab = false }: { title: string; tab?: boolean }) {
  const app = useApp();
  return (
    <Screen title={title} tab={tab}>
      <Empty
        title="로그인하고 동행을 이어가세요"
        description="네이버로 로그인하면 대화, 약속과 내 프로필을 확인할 수 있어요."
        action="네이버로 로그인"
        onPress={() => app.navigate("S05")}
        icon="person-outline"
      />
    </Screen>
  );
}
function feedback(
  app: ReturnType<typeof useApp>,
  result: OperationResult,
  success?: () => void,
) {
  if (result.message) app.showToast(result.message);
  if (result.ok) success?.();
}
function Info({ children }: { children: React.ReactNode }) {
  return (
    <View style={st.info}>
      <Icon name="shield-checkmark-outline" color={colors.primary} size={17} />
      <Body small style={{ flex: 1, color: colors.muted }}>
        {children}
      </Body>
    </View>
  );
}
function MenuRow({
  title,
  description,
  icon,
  onPress,
  danger = false,
}: {
  title: string;
  description?: string;
  icon: React.ComponentProps<typeof Icon>["name"];
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={st.menu}>
      <View style={st.menuIcon}>
        <Icon
          name={icon}
          size={20}
          color={danger ? colors.red : colors.primary}
        />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Body
          style={{ fontWeight: "600", color: danger ? colors.red : colors.ink }}
        >
          {title}
        </Body>
        {description && (
          <Body small muted>
            {description}
          </Body>
        )}
      </View>
      <Icon name="chevron-forward" color={colors.faint} size={16} />
    </Pressable>
  );
}
function notificationTitle(status: string) {
  return (
    (
      {
        active: "대화 중",
        confirmed: "동행 확정",
        ended: "모집 종료",
        withdrawn: "신청 철회",
        rejected: "거절됨",
      } as Record<string, string>
    )[status] || status
  );
}

async function pickImage(
  showToast: (text: string) => void,
): Promise<string | null> {
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.85,
    });
    if (result.canceled) return null;
    const asset = result.assets[0];
    const type = asset.mimeType?.toLowerCase();
    const extension = (asset.fileName || asset.uri).split("?")[0].toLowerCase();
    if (
      type
        ? !["image/jpeg", "image/png"].includes(type)
        : !/\.(jpe?g|png)$/.test(extension)
    ) {
      showToast("JPG 또는 PNG 사진을 선택해 주세요.");
      return null;
    }
    const size = asset.fileSize ?? asset.file?.size;
    if (size === undefined) {
      showToast(
        "원본 사진 크기를 확인할 수 없어요. 크기가 확인되는 JPG·PNG 파일을 선택해 주세요.",
      );
      return null;
    }
    if (size > 10_000_000) {
      showToast("10MB 이하 사진을 선택해 주세요.");
      return null;
    }
    return asset.uri;
  } catch {
    showToast("사진을 불러오지 못했어요. 다시 선택해 주세요.");
    return null;
  }
}

function ReportForm({
  target,
  online = false,
  onClose,
  onSubmitted,
}: {
  target: string;
  online?: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
}) {
  const app = useApp();
  const [description, setDescription] = useState("");
  const [attachment, setAttachment] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  if (submitted)
    return (
      <Card>
        <Badge>모의 접수 완료</Badge>
        <Title>제출한 자료로 검토할 수 있어요</Title>
        <Body muted>
          신고 접수는 위반 확정과 달라요. 운영자가 고객 DB의 채팅 원문을 직접
          열람하는 흐름은 제공하지 않아요.
        </Body>
        <Button secondary onPress={onClose}>
          닫기
        </Button>
      </Card>
    );
  return (
    <Card>
      <Row between>
        <Title>신고 자료 제출</Title>
        <TextButton onPress={onClose}>닫기</TextButton>
      </Row>
      <Body small muted>
        {online
          ? "문제가 생긴 구간의 캡처와 설명을 첨부해 주세요. 선택한 캡처만 제출돼요."
          : "대면 위협·노쇼 상황을 설명하고 제출할 수 있는 자료를 첨부해 주세요."}
      </Body>
      <Field
        label="상황 설명 (필수)"
        placeholder="언제 어떤 일이 있었는지 알려주세요"
        value={description}
        onChangeText={setDescription}
        multiline
      />
      {attachment && (
        <Image
          source={{ uri: attachment }}
          style={{ height: 180, borderRadius: 12 }}
          resizeMode="contain"
        />
      )}
      <Button
        secondary
        icon="image-outline"
        onPress={async () => {
          const image = await pickImage(app.showToast);
          if (image) setAttachment(image);
        }}
      >
        {attachment ? "캡처 교체" : "문제 구간 캡처 선택"}
        {online ? " (필수)" : " (선택)"}
      </Button>
      {attachment && (
        <TextButton onPress={() => setAttachment(null)}>첨부 제거</TextButton>
      )}
      <Button
        disabled={!description.trim() || (online && !attachment)}
        onPress={() =>
          feedback(
            app,
            app.report(
              online ? target : "대면·불발:" + target,
              description,
              attachment || undefined,
            ),
            () => {
              setSubmitted(true);
              onSubmitted?.();
            },
          )
        }
      >
        신고 접수하기
      </Button>
    </Card>
  );
}

export function ChatsScreen() { return serviceMode ? <RemoteChatsScreen /> : <PreviewChatsScreen />; }
function PreviewChatsScreen() {
  const app = useApp();
  const [filter, setFilter] = useState("전체");
  if (!app.member) return <LoginGuard title="채팅" tab />;
  const list = app.conversations
    .filter(
      (c) =>
        !c.hiddenBy.includes(app.viewerId!) &&
        (c.applicantId === app.viewerId ||
          app.posts.some(
            (p) => p.id === c.postId && p.authorId === app.viewerId,
          )),
    )
    .filter(
      (c) =>
        filter === "전체" ||
        (filter === "대화 중" && c.status === "active") ||
        (filter === "확정" && c.status === "confirmed") ||
        (filter === "종료" && !["active", "confirmed"].includes(c.status)),
    );
  return (
    <Screen
      title="채팅"
      tab
      right={
        <Pressable
          accessibilityLabel="알림"
          onPress={() => app.navigate("S12")}
        >
          <Icon name="notifications-outline" />
        </Pressable>
      }
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
      >
        {["전체", "대화 중", "확정", "종료"].map((x) => (
          <Chip key={x} selected={filter === x} onPress={() => setFilter(x)}>
            {x}
          </Chip>
        ))}
      </ScrollView>
      <View style={{ gap: 12 }}>
        {list.map((c) => {
          const p = app.posts.find((p) => p.id === c.postId);
          const otherId =
            p?.authorId === app.viewerId ? c.applicantId : p?.authorId;
          const other = otherId ? app.members[otherId] : null;
          const last = c.messages[c.messages.length - 1];
          return (
            <Card
              key={c.id}
              onPress={() => app.navigate("S11", c.postId)}
              style={{ padding: 16 }}
            >
              <Row>
                <Avatar member={other} size={48} />
                <View style={{ flex: 1, gap: 7 }}>
                  <Row between>
                    <Body style={{ fontWeight: "700" }}>
                      {other
                        ? c.status === "confirmed"
                          ? other.name
                          : maskName(other.name)
                        : "탈퇴한 사용자입니다."}
                    </Body>
                    <Badge
                      tone={
                        c.status === "confirmed"
                          ? "green"
                          : c.status === "active"
                            ? "purple"
                            : "gray"
                      }
                    >
                      {notificationTitle(c.status)}
                    </Badge>
                  </Row>
                  <Body small muted>
                    {p?.title || "삭제된 공고"}
                  </Body>
                  <Body small muted style={{ color: colors.faint }}>
                    {last?.text || "대화를 시작해 보세요"}
                  </Body>
                </View>
              </Row>
            </Card>
          );
        })}
      </View>
      {!list.length && (
        <Empty
          title="아직 대화가 없어요"
          description="마음에 드는 공고에 첫 메시지를 보내면 대화가 시작돼요."
          action="동행 둘러보기"
          onPress={() => app.navigate("S01")}
          icon="chatbubbles-outline"
        />
      )}
      <Info>
        안전한 동행을 위해 앱 안에서 일정을 조율하세요. 대화방 나가기는 내
        목록만 숨겨요.
      </Info>
    </Screen>
  );
}

export function ChatScreen({ id, conversationId }: { id?: string; conversationId?: string }) {
  const requestId = id?.startsWith("request:") ? id.slice(8) : conversationId;
  return serviceMode ? <RemoteChatScreen postId={requestId ? undefined : id} conversationId={requestId} /> : <PreviewChatScreen id={id} conversationId={conversationId} />;
}
function PreviewChatScreen({
  id,
  conversationId,
}: {
  id?: string;
  conversationId?: string;
}) {
  const app = useApp();
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState<string | null>(
    conversationId || null,
  );
  const [menu, setMenu] = useState(false);
  const [report, setReport] = useState(false);
  const [error, setError] = useState("");
  const [leave, setLeave] = useState(false);
  const [change, setChange] = useState(false);
  const [exitConfirm, setExitConfirm] = useState(false);
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [newPlace, setNewPlace] = useState("");
  useFocusEffect(
    useCallback(
      () => () => {
        setInput("");
        setError("");
        setExitConfirm(false);
      },
      [],
    ),
  );
  if (!app.member) return <LoginGuard title="1:1 대화" />;
  const post = app.posts.find((p) => p.id === id);
  if (!post)
    return (
      <Screen title="1:1 대화">
        <Empty
          title="공고를 찾을 수 없어요"
          description="삭제되거나 접근할 수 없는 공고예요."
        />
      </Screen>
    );
  const host = post.authorId === app.viewerId;
  const conversations = app.conversations.filter(
    (c) => c.postId === id && (host || c.applicantId === app.viewerId),
  );
  const conversation =
    conversations.find((c) => c.id === selected) ||
    conversations.find((c) => c.status === "confirmed") ||
    conversations[0];
  const appointment = app.appointments.find(
    (a) =>
      a.postId === id &&
      a.applicantId === conversation?.applicantId &&
      a.status === "confirmed",
  );
  const otherId = host ? conversation?.applicantId : post.authorId;
  const blocked = !!otherId && app.blockedIds.includes(otherId);
  const cooldown =
    conversation?.status === "withdrawn" &&
    conversation.withdrawnAt !== undefined &&
    app.now < conversation.withdrawnAt + 60000;
  const readonly =
    blocked ||
    conversation?.status === "rejected" ||
    conversation?.status === "ended" ||
    (conversation?.status === "withdrawn" && !!cooldown) ||
    post.status === "deleted" ||
    post.status === "completed" ||
    (host && conversation?.status === "withdrawn") ||
    (!conversation && host);
  const pending =
    !!conversation?.requestExpiresAt && conversation.requestExpiresAt > app.now;
  const send = () => {
    const result = app.sendMessage(post.id, input, conversation?.id);
    if (result.ok) {
      setInput("");
      setError("");
    } else
      setError(
        result.message || "메시지를 보내지 못했어요. 다시 시도해 주세요.",
      );
  };
  return (
    <Screen
      title="1:1 대화"
      onBack={() => {
        if (!conversation && input.trim()) setExitConfirm(true);
        else app.back();
      }}
      right={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="대화 메뉴"
          onPress={() => setMenu(!menu)}
        >
          <Icon name="ellipsis-vertical" />
        </Pressable>
      }
      footer={
        readonly ? (
          <Body small muted style={{ textAlign: "center" }}>
            이 대화는 읽기 전용이에요. 기록 확인과 신고는 가능해요.
          </Body>
        ) : (
          <View style={{ gap: 8 }}>
            <Row>
              <View style={{ flex: 1 }}>
                <Field
                  placeholder="메시지를 입력해 주세요"
                  value={input}
                  onChangeText={setInput}
                  multiline
                  style={{ minHeight: 46, maxHeight: 110 }}
                />
              </View>
              <Pressable
                testID="send-message"
                accessibilityRole="button"
                accessibilityLabel="메시지 보내기"
                disabled={!input.trim()}
                onPress={send}
                style={[st.send, !input.trim() && { opacity: 0.4 }]}
              >
                <Icon name="send" color="#fff" size={21} />
              </Pressable>
            </Row>
            {error && (
              <Body small style={{ color: colors.red }}>
                {error}
              </Body>
            )}
            {!conversation && (
              <Body small muted>
                첫 전송 성공 시 신청돼요. 전송 전 이탈하면 입력 내용이 삭제돼요.
              </Body>
            )}
          </View>
        )
      }
    >
      {exitConfirm && (
        <Card style={{ backgroundColor: colors.pink }}>
          <Title>보내지 않은 메시지가 있어요</Title>
          <Body>
            지금 나가면 입력 내용이 삭제되고 신청은 만들어지지 않아요.
          </Body>
          <Button
            onPress={() => {
              setInput("");
              app.back();
            }}
          >
            입력 삭제하고 나가기
          </Button>
          <Button secondary onPress={() => setExitConfirm(false)}>
            계속 작성하기
          </Button>
        </Card>
      )}
      {host && conversations.length > 1 && (
        <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
          {conversations.map((c) => (
            <Chip
              key={c.id}
              selected={c.id === conversation?.id}
              onPress={() => {
                setSelected(c.id);
                setInput("");
              }}
            >
              {maskName(app.members[c.applicantId]?.name || "탈퇴")}
            </Chip>
          ))}
        </ScrollView>
      )}
      {otherId && <MemberBox memberId={otherId} confirmed={!!appointment} />}
      <Card
        onPress={() => app.navigate("S02", post.id)}
        style={{ backgroundColor: colors.lavender, borderWidth: 0 }}
      >
        <Row between>
          <Badge>무료 1:1</Badge>
          <Body small style={{ color: colors.primary }}>
            공고 보기 ›
          </Body>
        </Row>
        <Title style={{ fontSize: 17 }}>{post.title}</Title>
        <Body small muted>
          {rangeLabel(
            appointment?.startsAt || post.startsAt,
            appointment?.endsAt || post.endsAt,
          )}
        </Body>
        <Body small muted>
          {post.publicArea}
        </Body>
      </Card>
      <Info>
        {appointment
          ? "확정된 당사자에게만 전체 이름과 상세 만남 지점을 보여드려요."
          : "최종 동의가 완료될 때까지 이름은 마스킹하고 상세 만남 지점은 숨겨요."}
      </Info>
      {menu && (
        <Card>
          <Title>대화 관리</Title>
          {otherId && (
            <Button
              secondary
              onPress={() => {
                if (blocked) {
                  app.unblock(otherId);
                  app.showToast(
                    "차단을 해제했어요. 종료된 신청은 자동 복원되지 않아요.",
                  );
                } else feedback(app, app.block(otherId));
              }}
            >
              {blocked ? "차단 해제" : "상대 차단"}
            </Button>
          )}
          <Body small muted>
            차단하면 즉시 접촉을 막아요. 확정 약속 취소는 별도로 처리해 주세요.
          </Body>
          <Button secondary onPress={() => setReport(!report)}>
            온라인 문제 신고
          </Button>
          {conversation && (
            <Button secondary onPress={() => setLeave(true)}>
              대화방 나가기
            </Button>
          )}
          {leave && (
            <View style={{ gap: 10 }}>
              <Body small>
                내 목록에서만 숨겨요. 상대 목록과 대화 기록은 유지돼요.
              </Body>
              <Button
                onPress={() => {
                  app.leaveChat(conversation!.id);
                  app.navigate("S10");
                }}
              >
                목록에서 숨기기
              </Button>
              <TextButton onPress={() => setLeave(false)}>
                계속 대화하기
              </TextButton>
            </View>
          )}
        </Card>
      )}
      {report && (
        <ReportForm
          target={conversation?.id || post.id}
          online
          onClose={() => setReport(false)}
        />
      )}
      {!conversation && (
        <Empty
          title={
            host ? "아직 받은 신청이 없어요" : "반가운 첫인사를 보내보세요"
          }
          description={
            host
              ? "신청자가 메시지를 보내면 이곳에서 이야기할 수 있어요."
              : "첫 메시지를 보내기 전에는 신청이나 작성자 알림이 생성되지 않아요."
          }
          icon="chatbubble-outline"
        />
      )}
      {conversation?.messages.map((m) => (
        <View
          key={m.id}
          style={{
            alignItems: m.senderId === app.viewerId ? "flex-end" : "flex-start",
            gap: 4,
          }}
        >
          <View
            style={[st.bubble, m.senderId === app.viewerId ? st.ownBubble : {}]}
          >
            <Body
              style={{
                color: m.senderId === app.viewerId ? "#fff" : colors.ink,
              }}
            >
              {m.text}
            </Body>
          </View>
          <Body small muted>
            {timeLabel(m.at)}
          </Body>
        </View>
      ))}
      {cooldown && (
        <Info>
          신청을 철회했어요.{" "}
          {Math.ceil(
            ((conversation?.withdrawnAt || 0) + 60000 - app.now) / 1000,
          )}
          초 뒤 같은 대화에 다시 메시지를 보내 재신청할 수 있어요.
        </Info>
      )}
      {conversation && !appointment && conversation.status === "active" && (
        <Card>
          <Row>
            <Icon name="people-outline" color={colors.primary} />
            <Title>대화 후 서로 결정해요</Title>
          </Row>
          {pending ? (
            <>
              <Body muted>
                {host
                  ? "상대의 최종 동의를 기다리고 있어요."
                  : "작성자가 동행 확정을 요청했어요. 일정과 조건을 확인해 주세요."}
              </Body>
              <Body small style={{ color: colors.primary }}>
                수락 마감: {dateLabel(conversation.requestExpiresAt!)}{" "}
                {timeLabel(conversation.requestExpiresAt!)} · 마감 시각부터 수락
                불가
              </Body>
              {host ? (
                <Button
                  secondary
                  onPress={() =>
                    feedback(app, app.withdrawMatch(conversation.id))
                  }
                >
                  확정 요청 철회
                </Button>
              ) : (
                <Row>
                  <Button
                    style={{ flex: 1 }}
                    onPress={() =>
                      feedback(app, app.acceptMatch(conversation.id))
                    }
                  >
                    최종 동의 수락
                  </Button>
                  <Button
                    secondary
                    style={{ flex: 1 }}
                    onPress={() =>
                      feedback(app, app.withdrawMatch(conversation.id))
                    }
                  >
                    요청 거절
                  </Button>
                </Row>
              )}
            </>
          ) : (
            <>
              <Body small muted>
                작성자의 요청 후 6시간과 동행 시작 중 빠른 때까지 신청자가
                수락하면 확정돼요.
              </Body>
              {host ? (
                <>
                  <Button
                    onPress={() =>
                      feedback(app, app.requestMatch(conversation.id))
                    }
                  >
                    이 신청자에게 확정 요청
                  </Button>
                  <TextButton
                    onPress={() =>
                      feedback(app, app.rejectApplicant(conversation.id))
                    }
                  >
                    신청 거절
                  </TextButton>
                </>
              ) : (
                <TextButton onPress={() => app.navigate("S18", post.id)}>
                  신청 철회
                </TextButton>
              )}
            </>
          )}
        </Card>
      )}
      {appointment && (
        <Card>
          <Badge tone="green">동행 확정</Badge>
          <Title>우리 약속이 정해졌어요</Title>
          <Body>{post.meetingPoint}</Body>
          <Body small muted>
            {post.address}
          </Body>
          <Button onPress={() => app.navigate("S16", appointment.id)}>
            약속 상세 보기
          </Button>
          {app.now < appointment.startsAt && (
            <Button
              secondary
              onPress={() => {
                setChange(!change);
                setNewPlace(post.placeName);
              }}
            >
              일정·장소 변경 제안
            </Button>
          )}
          {change && (
            <View style={{ gap: 12 }}>
              <Field
                label="새 시작 (한국시간)"
                placeholder="2026-10-07 14:00"
                value={newStart}
                onChangeText={setNewStart}
              />
              <Field
                label="새 종료 (한국시간)"
                placeholder="2026-10-07 16:00"
                value={newEnd}
                onChangeText={setNewEnd}
              />
              <Body small muted>
                예시 등록 장소를 선택해 주세요.
              </Body>
              <View style={st.chips}>
                {Array.from(new Set(app.posts.map((p) => p.placeName))).map(
                  (name) => (
                    <Chip
                      key={name}
                      selected={newPlace === name}
                      onPress={() => setNewPlace(name)}
                    >
                      {name}
                    </Chip>
                  ),
                )}
              </View>
              <Button
                onPress={() =>
                  feedback(
                    app,
                    app.proposeChange(
                      appointment.id,
                      parseDateInput(newStart),
                      parseDateInput(newEnd),
                      newPlace,
                    ),
                    () => setChange(false),
                  )
                }
              >
                변경 제안 보내기
              </Button>
            </View>
          )}
          {appointment.proposal && (
            <View style={{ gap: 12 }}>
              <Divider />
              <Title style={{ fontSize: 16 }}>변경 제안 대기</Title>
              <Body>
                {rangeLabel(
                  appointment.proposal.startsAt,
                  appointment.proposal.endsAt,
                )}
              </Body>
              <Body>{appointment.proposal.placeName}</Body>
              <Body small muted>
                {appointment.proposal.address}
              </Body>
              <Body small muted>
                {appointment.proposal.meetingPoint}
              </Body>
              <Body small muted>
                마감 {dateLabel(appointment.proposal.expiresAt)}{" "}
                {timeLabel(appointment.proposal.expiresAt)} · 미응답 시 기존
                약속 유지
              </Body>
              {appointment.proposal.proposedBy === app.viewerId ? (
                <Button
                  secondary
                  onPress={() =>
                    feedback(app, app.rejectChange(appointment.id))
                  }
                >
                  제안 철회
                </Button>
              ) : (
                <Row>
                  <Button
                    style={{ flex: 1 }}
                    disabled={app.now >= appointment.proposal.expiresAt}
                    onPress={() =>
                      feedback(app, app.acceptChange(appointment.id))
                    }
                  >
                    변경 수락
                  </Button>
                  <Button
                    secondary
                    style={{ flex: 1 }}
                    onPress={() =>
                      feedback(app, app.rejectChange(appointment.id))
                    }
                  >
                    변경 거절
                  </Button>
                </Row>
              )}
            </View>
          )}
          <TextButton
            color={colors.red}
            onPress={() => app.navigate("S18", post.id)}
          >
            {app.now < appointment.startsAt ? "동행 취소" : "중단·불발 신고"}
          </TextButton>
        </Card>
      )}
    </Screen>
  );
}

export function NotificationsScreen() { return serviceMode ? <RemoteNotificationsScreen /> : <PreviewNotificationsScreen />; }
function PreviewNotificationsScreen() {
  const app = useApp();
  const [unread, setUnread] = useState(false);
  if (!app.member) return <LoginGuard title="알림" />;
  const list = app.notifications.filter((n) => !unread || !n.read);
  return (
    <Screen
      title="알림"
      right={
        <TextButton onPress={() => app.markNotificationsRead()}>
          모두 읽음
        </TextButton>
      }
    >
      <Row>
        <Chip selected={!unread} onPress={() => setUnread(false)}>
          전체 {app.notifications.length}
        </Chip>
        <Chip selected={unread} onPress={() => setUnread(true)}>
          읽지 않음 {app.notifications.filter((n) => !n.read).length}
        </Chip>
      </Row>
      <View style={{ gap: 12 }}>
        {list.map((n) => (
          <Card
            key={n.id}
            style={{
              backgroundColor: n.read ? colors.surface : colors.lavender,
            }}
            onPress={() => {
              app.markNotificationsRead(n.id);
              app.navigate(n.screen, n.targetId);
            }}
          >
            <Row>
              <View style={st.noticeIcon}>
                <Icon name="notifications-outline" color={colors.primary} />
              </View>
              <View style={{ flex: 1, gap: 6 }}>
                <Body style={{ fontWeight: "700" }}>{n.title}</Body>
                <Body small muted>
                  {n.text}
                </Body>
                <Body small muted>
                  {dateLabel(n.at)} {timeLabel(n.at)}
                </Body>
              </View>
              {!n.read && <View style={st.dot} />}
            </Row>
          </Card>
        ))}
      </View>
      {!list.length && (
        <Empty
          title="새 알림이 없어요"
          description="신청, 확정과 후기 소식을 이곳에서 알려드려요."
          icon="notifications-outline"
        />
      )}
      <Info>
        알림을 누르면 대상 화면으로 이동해요. 수락이나 완료는 직접 확인해야
        처리돼요.
      </Info>
    </Screen>
  );
}

export function MeScreen() { return serviceMode ? <RemoteMeScreen /> : <PreviewMeScreen />; }
function PreviewMeScreen() {
  const app = useApp();
  const [tab, setTab] = useState("내 동행");
  if (!app.member) return <LoginGuard title="나" tab />;
  const own = app.posts.filter(
    (p) => p.authorId === app.viewerId && p.status !== "deleted",
  );
  const sent = app.conversations.filter((c) => c.applicantId === app.viewerId);
  const received = app.conversations.filter((c) =>
    own.some((p) => p.id === c.postId),
  );
  const appointments = app.appointments.filter((a) =>
    [a.hostId, a.applicantId].includes(app.viewerId!),
  );
  return (
    <Screen
      title="나"
      tab
      right={
        <Pressable
          accessibilityLabel="계정 상태"
          onPress={() => app.navigate("S21")}
        >
          <Icon name="settings-outline" />
        </Pressable>
      }
    >
      <Card onPress={() => app.navigate("S14", app.viewerId!)}>
        <Row>
          <Avatar member={app.member} size={60} />
          <View style={{ flex: 1, gap: 5 }}>
            <Title>
              {app.member.name} 님{" "}
              <Body small muted>
                만 {app.member.age}세
              </Body>
            </Title>
            <Body small muted>
              내 공개 프로필 보기 ›
            </Body>
          </View>
        </Row>
        <Divider />
        <Row between>
          <Body style={{ fontWeight: "600" }}>나의 당도</Body>
          <Badge>완료 {app.member.completedCount}회</Badge>
        </Row>
        <Title large style={{ color: colors.primary }}>
          {app.member.sweetness}
          <Body muted> / 100</Body>
        </Title>
        <View style={st.track}>
          <View style={[st.fill, { width: `${app.member.sweetness}%` }]} />
        </View>
        <Body small muted>
          당도 15는 평가가 없는 초기값이에요. 완료 횟수와 칭찬은 당도에 가산하지
          않아요.
        </Body>
      </Card>
      <Row>
        {["내 동행", "내 공고", "프로필"].map((x) => (
          <Chip key={x} selected={tab === x} onPress={() => setTab(x)}>
            {x}
          </Chip>
        ))}
      </Row>
      {tab === "내 동행" && (
        <>
          <Section title="나의 약속">
            {appointments.map((a) => {
              const p = app.posts.find((p) => p.id === a.postId);
              const mine = app.reviews.some(
                (r) => r.appointmentId === a.id && r.authorId === app.viewerId,
              );
              return (
                <Card key={a.id} onPress={() => app.navigate("S16", a.id)}>
                  <Row between>
                    <Badge tone={a.status === "completed" ? "gray" : "green"}>
                      {
                        {
                          confirmed: "예정·진행",
                          completed: "동행 완료",
                          cancelled: "취소됨",
                          disputed: "분쟁 검토 중",
                        }[a.status]
                      }
                    </Badge>
                    <Body small muted>
                      {dateLabel(a.startsAt)}
                    </Body>
                  </Row>
                  <Title style={{ fontSize: 17 }}>
                    {p?.title || "탈퇴 회원의 동행"}
                  </Title>
                  <Body small muted>
                    {rangeLabel(a.startsAt, a.endsAt)}
                  </Body>
                  {canWriteReview(a, app.viewerId!, app.now) && !mine && (
                    <Button onPress={() => app.navigate("S17", a.id)}>
                      후기 작성하기
                    </Button>
                  )}
                </Card>
              );
            })}
            {!appointments.length && (
              <Body muted>아직 확정된 약속이 없어요.</Body>
            )}
          </Section>
          <Section title={`보낸 신청 · ${sent.length}`}>
            <View style={{ gap: 10 }}>
              {sent.map((c) => (
                <MenuRow
                  key={c.id}
                  icon="paper-plane-outline"
                  title={
                    app.posts.find((p) => p.id === c.postId)?.title ||
                    "삭제된 공고"
                  }
                  description={notificationTitle(c.status)}
                  onPress={() => app.navigate("S11", c.postId)}
                />
              ))}
              {!sent.length && <Body muted>보낸 신청이 없어요.</Body>}
            </View>
          </Section>
          <Section title={`받은 신청 · ${received.length}`}>
            <View style={{ gap: 10 }}>
              {received.map((c) => (
                <MenuRow
                  key={c.id}
                  icon="chatbubble-outline"
                  title={`${maskName(app.members[c.applicantId]?.name || "탈퇴")} 님의 신청`}
                  description={notificationTitle(c.status)}
                  onPress={() => app.navigate("S11", c.postId)}
                />
              ))}
              {!received.length && <Body muted>받은 신청이 없어요.</Body>}
            </View>
          </Section>
        </>
      )}
      {tab === "내 공고" && (
        <>
          <Button icon="add" onPress={() => app.navigate("S03")}>
            새 동행 모집
          </Button>
          {own.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
          {!own.length && (
            <Empty
              title="아직 작성한 공고가 없어요"
              description="같이 하고 싶은 활동을 모집해 보세요."
            />
          )}
        </>
      )}
      {tab === "프로필" && (
        <Card style={{ padding: 0 }}>
          <MenuRow
            icon="person-circle-outline"
            title="내 공개 프로필·받은 후기"
            onPress={() => app.navigate("S14", app.viewerId!)}
          />
          <Divider />
          <MenuRow
            icon="camera-outline"
            title="프로필 사진"
            onPress={() => app.navigate("S15")}
          />
          <Divider />
          <MenuRow
            icon="sparkles-outline"
            title="취향·성향 편집"
            onPress={() => app.navigate("S15-2")}
          />
        </Card>
      )}
      <Section title="안전·계정">
        <Card style={{ padding: 0 }}>
          <MenuRow
            icon="shield-checkmark-outline"
            title="안심 동행 수칙"
            onPress={() => app.navigate("S19")}
          />
          <Divider />
          <MenuRow
            icon="settings-outline"
            title="계정 상태·AI 동의·탈퇴"
            onPress={() => app.navigate("S21")}
          />
          <Divider />
          <MenuRow
            icon="log-out-outline"
            title="로그아웃"
            onPress={() => {
              void app.logout();
            }}
          />
        </Card>
      </Section>
    </Screen>
  );
}

export function ProfileScreen({ id }: { id?: string }) { return serviceMode ? <RemoteProfileScreen id={id || ""} /> : <PreviewProfileScreen id={id} />; }
function PreviewProfileScreen({ id }: { id?: string }) {
  const app = useApp();
  const [limit, setLimit] = useState(5);
  const [expanded, setExpanded] = useState(false);
  const [report, setReport] = useState(false);
  if (!app.member)
    return (
      <Screen title="프로필">
        <MemberBox memberId={id || ""} />
        <Button onPress={() => app.navigate("S05")}>로그인하고 확인하기</Button>
      </Screen>
    );
  const member = app.members[id || ""];
  if (!member)
    return (
      <Screen title="프로필">
        <Empty
          title="탈퇴한 사용자입니다."
          description="기존 공개 후기는 익명으로 유지돼요."
        />
      </Screen>
    );
  const own = member.id === app.viewerId;
  const confirmed = app.appointments.some(
    (a) =>
      a.status === "confirmed" &&
      [a.hostId, a.applicantId].includes(app.viewerId!) &&
      [a.hostId, a.applicantId].includes(member.id),
  );
  const reviews = app.reviews.filter(
    (r) =>
      r.targetId === member.id &&
      app.appointments.some((a) => reviewVisible(a, app.reviews, r, app.now)),
  );
  const texts = summarySources(reviews, member.id, app.aiSummaryWithdrawnIds);
  const counts = PRAISES.map((name) => ({
    name,
    count: reviews.filter((r) => r.praises.includes(name)).length,
  }))
    .filter((x) => x.count)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const summaryEligible = texts.length >= 3;
  return (
    <Screen
      title="프로필"
      right={
        !own ? (
          <Pressable
            accessibilityLabel="프로필 신고"
            onPress={() => setReport(!report)}
          >
            <Icon name="flag-outline" />
          </Pressable>
        ) : undefined
      }
    >
      <Card>
        <Row>
          <Avatar member={member} size={76} />
          <View style={{ flex: 1, gap: 8 }}>
            <Title>
              {own || confirmed ? member.name : maskName(member.name)}
            </Title>
            <Body small muted>
              만 {member.age}세 · {member.completedCount}회 동행 완료
            </Body>
            <Badge>무료 1:1 동행</Badge>
          </View>
        </Row>
        {member.introduction && <Body muted>{member.introduction}</Body>}
        <View style={st.chips}>
          {member.interests.map((x) => (
            <Badge key={x}>#{x}</Badge>
          ))}
          {member.conversationStyles.map((x) => (
            <Badge key={x} tone="gray">
              {x}
            </Badge>
          ))}
          {member.mbti && <Badge tone="gray">{member.mbti}</Badge>}
        </View>
        <Divider />
        <Row between>
          <Body style={{ fontWeight: "700" }}>현재 당도</Body>
          <Title style={{ color: colors.primary }}>
            {member.sweetness} / 100
          </Title>
        </Row>
        <View style={st.track}>
          <View style={[st.fill, { width: `${member.sweetness}%` }]} />
        </View>
        {member.sweetness === 15 && !reviews.length && (
          <Body small muted>
            아직 평가가 없는 초기 당도 15예요.
          </Body>
        )}
      </Card>
      <Section title="함께한 사람이 남긴 칭찬">
        <Card>
          {counts.map((x) => (
            <View key={x.name} style={{ gap: 7 }}>
              <Row between>
                <Body>{x.name}</Body>
                <Body style={{ fontWeight: "700", color: colors.primary }}>
                  {x.count}
                </Body>
              </Row>
              <View style={st.track}>
                <View
                  style={[
                    st.fill,
                    { width: `${(x.count / (counts[0]?.count || 1)) * 100}%` },
                  ]}
                />
              </View>
            </View>
          ))}
          {!counts.length && <Body muted>아직 공개된 칭찬이 없어요.</Body>}
        </Card>
      </Section>
      <Card style={{ backgroundColor: colors.lavender }}>
        <Row between>
          <Row>
            <Icon name="sparkles-outline" color={colors.primary} />
            <Title style={{ fontSize: 16 }}>후기 요약</Title>
          </Row>
          <Badge>모의 미리보기</Badge>
        </Row>
        {summaryEligible ? (
          <>
            <Body small muted>
              공개 텍스트 후기 {texts.length}개를 확인할 수 있어요. 아래는 원문
              발췌 미리보기이며 실제 AI가 만든 요약이 아니에요.
            </Body>
            <Button secondary onPress={() => setExpanded(!expanded)}>
              {expanded ? "접기" : "원문 발췌 펼치기"}
            </Button>
            {expanded && (
              <Body>
                {texts
                  .map((r) => r.comment)
                  .join(" · ")
                  .slice(0, 300)}
              </Body>
            )}
          </>
        ) : (
          <Body small muted>
            {app.aiSummaryWithdrawnIds.includes(member.id)
              ? "후기 요약 사용을 철회한 상태예요. 공개 원문과 칭찬은 계속 볼 수 있어요."
              : "공개 텍스트 후기 3개부터 요약을 준비해요."}
          </Body>
        )}
      </Card>
      <Section title={`동행 후기 · ${reviews.length}`}>
        <View style={{ gap: 12 }}>
          {reviews.slice(0, limit).map((r) => (
            <Card key={r.id}>
              <Row between>
                <Body small muted>
                  {app.members[r.authorId]
                    ? maskName(app.members[r.authorId].name)
                    : "탈퇴한 사용자입니다."}{" "}
                  · {dateLabel(r.submittedAt)}
                </Body>
                <Body style={{ color: colors.primary }}>
                  {"★".repeat(r.stars)}
                  {"☆".repeat(5 - r.stars)}
                </Body>
              </Row>
              <Badge tone={r.mood === "good" ? "purple" : "gray"}>
                {
                  { good: "좋아요", neutral: "보통이에요", bad: "별로예요" }[
                    r.mood
                  ]
                }
              </Badge>
              {r.comment && <Body>{r.comment}</Body>}
              <View style={st.chips}>
                {r.praises.map((x) => (
                  <Badge key={x}>{x}</Badge>
                ))}
              </View>
            </Card>
          ))}
        </View>
        {reviews.length > limit && (
          <Button secondary onPress={() => setLimit(limit + 5)}>
            후기 5개 더 보기
          </Button>
        )}
        {!reviews.length && (
          <Empty
            title="아직 공개된 후기가 없어요"
            description="실제 완료 후 양쪽 제출 또는 작성 기한 종료 시 공개돼요."
          />
        )}
      </Section>
      {report && (
        <ReportForm
          target={member.id}
          online
          onClose={() => setReport(false)}
        />
      )}
      <Info>
        프로필과 당도는 동행 선택을 돕는 정보예요. 신원이나 안전을 보증하지
        않아요.
      </Info>
    </Screen>
  );
}

export function PhotoScreen() { return serviceMode ? <RemotePhotoScreen /> : <PreviewPhotoScreen />; }
function PreviewPhotoScreen() {
  const app = useApp();
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!app.member) return <LoginGuard title="프로필 사진" />;
  return (
    <Screen
      title="프로필 사진"
      footer={
        <Button
          disabled={!photo}
          onPress={() => {
            if (app.failNext) {
              app.setPreview({ failNext: false });
              setError(
                "저장하지 못했어요. 기존 사진은 유지돼요. 다시 시도해 주세요.",
              );
              return;
            }
            app.updateMember({ photo: photo! });
            app.showToast("프로필 사진을 저장했어요.");
            app.back();
          }}
        >
          변경 사진 저장
        </Button>
      }
    >
      <View style={{ alignItems: "center", gap: 18, paddingVertical: 28 }}>
        <Avatar
          member={{ ...app.member, photo: photo || app.member.photo }}
          size={168}
        />
        <Title>나를 소개하는 대표 사진</Title>
        <Body small muted>
          JPG·PNG 원본 10MB 이하
        </Body>
        <Button
          secondary
          icon="camera-outline"
          onPress={async () => {
            const selected = await pickImage(app.showToast);
            if (selected) {
              setPhoto(selected);
              setError("");
            }
          }}
        >
          사진 선택·교체
        </Button>
      </View>
      <Info>
        사진 선택 후 저장 버튼을 눌러야 반영돼요. 필수 대표 사진은 지우는 대신
        새 사진으로 교체해 주세요.
      </Info>
      {error && <Body style={{ color: colors.red }}>{error}</Body>}
    </Screen>
  );
}

export function TagsEditor({
  title,
  values,
  setValues,
  suggestions,
}: {
  title: string;
  values: string[];
  setValues: (v: string[]) => void;
  suggestions: string[];
}) {
  const app = useApp();
  const [custom, setCustom] = useState("");
  const toggle = (x: string) => {
    if (values.includes(x)) setValues(values.filter((v) => v !== x));
    else if (values.length < 20) setValues([...values, x]);
    else app.showToast("최대 20개까지 선택할 수 있어요.");
  };
  return (
    <Section title={`${title} · ${values.length}/20`}>
      <View style={st.chips}>
        {Array.from(new Set([...suggestions, ...values])).map((x) => (
          <Chip key={x} selected={values.includes(x)} onPress={() => toggle(x)}>
            {x}
          </Chip>
        ))}
      </View>
      <Row>
        <View style={{ flex: 1 }}>
          <Field
            placeholder="직접 추가 (40자 이내)"
            maxLength={40}
            value={custom}
            onChangeText={setCustom}
          />
        </View>
        <TextButton
          onPress={() => {
            const x = custom.trim();
            if (!x) return;
            if (values.includes(x)) {
              app.showToast("이미 추가한 항목이에요.");
              return;
            }
            toggle(x);
            if (values.length < 20) setCustom("");
          }}
        >
          추가
        </TextButton>
      </Row>
    </Section>
  );
}
export function PreferencesScreen() { return serviceMode ? <RemotePreferencesScreen /> : <PreviewPreferencesScreen />; }
function PreviewPreferencesScreen() {
  const app = useApp();
  const [interests, setInterests] = useState(app.member?.interests || []);
  const [styles, setStyles] = useState(app.member?.conversationStyles || []);
  const [mbti, setMbti] = useState(app.member?.mbti || "");
  const [intro, setIntro] = useState(app.member?.introduction || "");
  const [error, setError] = useState("");
  if (!app.member) return <LoginGuard title="취향·성향 편집" />;
  return (
    <Screen
      title="취향·성향 편집"
      footer={
        <Button
          onPress={() => {
            if (app.failNext) {
              app.setPreview({ failNext: false });
              setError(
                "저장에 실패했어요. 입력 내용을 유지했으니 다시 시도해 주세요.",
              );
              return;
            }
            if (mbti.trim() && !/^[EI][SN][TF][JP]$/.test(mbti)) {
              setError("MBTI의 네 가지를 모두 선택하거나 비워 주세요.");
              return;
            }
            app.updateMember({
              interests,
              conversationStyles: styles,
              mbti,
              introduction: intro.trim(),
            });
            app.showToast("취향과 성향을 저장했어요.");
            app.back();
          }}
        >
          변경사항 저장
        </Button>
      }
    >
      <Info>모두 선택 항목이에요. 비워두어도 동행을 이용할 수 있어요.</Info>
      <TagsEditor
        title="나의 관심사"
        values={interests}
        setValues={setInterests}
        suggestions={[
          "전시",
          "영화",
          "카페",
          "공연",
          "맛집",
          "산책",
          "여행",
          "독서",
          "사진",
          "운동",
        ]}
      />
      <TagsEditor
        title="대화·만남 스타일"
        values={styles}
        setValues={setStyles}
        suggestions={[
          "차분한 대화",
          "유쾌한 대화",
          "경청하는 편",
          "계획적인 만남",
          "편안한 만남",
          "사진 찍기 좋아요",
        ]}
      />
      <Section title="MBTI (선택)">
        <View style={{ gap: 10 }}>
          {[
            ["E", "I"],
            ["S", "N"],
            ["T", "F"],
            ["J", "P"],
          ].map((pair, i) => (
            <Row key={i}>
              {pair.map((x) => (
                <Chip
                  key={x}
                  selected={mbti[i] === x}
                  onPress={() => {
                    const next = mbti.padEnd(4, " ").split("");
                    next[i] = x;
                    setMbti(next.join(""));
                  }}
                >
                  {x}
                </Chip>
              ))}
            </Row>
          ))}
          <TextButton onPress={() => setMbti("")}>MBTI 비우기</TextButton>
          <Body small muted>
            {mbti.trim() ? `선택: ${mbti}` : "아직 선택하지 않았어요."}
          </Body>
        </View>
      </Section>
      <Field
        label="한 줄 소개 (선택)"
        value={intro}
        onChangeText={setIntro}
        multiline
        placeholder="어떤 동행을 즐기는지 알려주세요"
      />
      {error && <Body style={{ color: colors.red }}>{error}</Body>}
    </Screen>
  );
}

export function AppointmentScreen({ id }: { id?: string }) { return serviceMode ? <RemoteAppointmentScreen id={id} /> : <PreviewAppointmentScreen id={id} />; }
function PreviewAppointmentScreen({ id }: { id?: string }) {
  const app = useApp();
  if (!app.member) return <LoginGuard title="약속 상세" />;
  const a = app.appointments.find((a) => a.id === id);
  if (!a || ![a.hostId, a.applicantId].includes(app.viewerId!))
    return (
      <Screen title="약속 상세">
        <Empty
          title="약속을 확인할 수 없어요"
          description="약속이 없거나 당사자만 접근할 수 있어요."
        />
      </Screen>
    );
  const p = app.posts.find((p) => p.id === a.postId);
  const other = a.hostId === app.viewerId ? a.applicantId : a.hostId;
  const confirmed = a.status === "confirmed";
  const mine = app.reviews.find(
    (r) => r.appointmentId === a.id && r.authorId === app.viewerId,
  );
  const deadline = reviewDeadline(a);
  const canWrite = canWriteReview(a, app.viewerId!, app.now) && !mine;
  return (
    <Screen
      title="약속 상세"
      footer={
        <Button secondary onPress={() => app.navigate("S11", a.postId)}>
          채팅방으로 이동
        </Button>
      }
    >
      <Card>
        <Row between>
          <Badge>{p?.category || "동행"}</Badge>
          <Badge tone={a.status === "completed" ? "green" : "gray"}>
            {
              {
                confirmed: "확정된 약속",
                completed: "동행 완료",
                cancelled: "취소됨",
                disputed: "분쟁 검토 중",
              }[a.status]
            }
          </Badge>
        </Row>
        <Title>{p?.title || "동행 약속"}</Title>
        <View style={st.detail}>
          <Icon name="calendar-outline" color={colors.primary} />
          <View style={{ flex: 1, gap: 4 }}>
            <Body style={{ fontWeight: "600" }}>일시</Body>
            <Body>{rangeLabel(a.startsAt, a.endsAt)}</Body>
          </View>
        </View>
        <View style={st.detail}>
          <Icon name="location-outline" color={colors.primary} />
          <View style={{ flex: 1, gap: 4 }}>
            <Body style={{ fontWeight: "600" }}>만남 장소</Body>
            <Body>{p?.publicArea || "공개 지역 없음"}</Body>
            {confirmed && (
              <>
                <Body>{p?.placeName}</Body>
                <Body small muted>
                  {p?.address}
                </Body>
                <Body>{p?.meetingPoint}</Body>
              </>
            )}
          </View>
        </View>
        <MemberBox memberId={other} confirmed={confirmed} />
      </Card>
      <Info>
        무료 1:1 동행이에요. 행사 입장료는 별도예요. 만남 일정은 상대와 앱
        안에서 확인하세요.
      </Info>
      <Button
        secondary
        icon="shield-checkmark-outline"
        onPress={() => app.navigate("S19")}
      >
        안심 동행 수칙 확인
      </Button>
      {a.status === "disputed" ? (
        <Card>
          <Title>검토가 진행 중이에요</Title>
          <Body muted>
            자동 완료, 새 후기 작성·공개와 작성 기한은 보류돼요. 이미 공개된
            후기는 운영 결정이 있을 때만 숨겨요.
          </Body>
        </Card>
      ) : a.status === "cancelled" ? (
        <Card>
          <Title>취소된 동행이에요</Title>
          <Body muted>
            전체 이름과 상세 만남 지점을 다시 숨겼어요. 완료 확인이나 평가는 할
            수 없어요.
          </Body>
        </Card>
      ) : (
        <Card>
          <Title>동행 완료 확인</Title>
          {app.now < a.endsAt ? (
            <Body muted>
              예상 종료 {timeLabel(a.endsAt)} 이후 본인이 완료를 확인할 수
              있어요.
            </Body>
          ) : a.completedAt !== null ? (
            <>
              <Badge tone="green">실제 완료</Badge>
              <Body small muted>
                {dateLabel(a.completedAt)} {timeLabel(a.completedAt)}에
                완료됐어요.
              </Body>
            </>
          ) : (
            <>
              <Body muted>
                {a.confirmations.includes(app.viewerId!)
                  ? "내 완료 확인은 끝났어요. 상대 확인을 기다리고 있어요."
                  : "동행을 마쳤다면 완료를 확인해 주세요."}
              </Body>
              <Button
                disabled={a.confirmations.includes(app.viewerId!)}
                onPress={() => feedback(app, app.confirmCompletion(a.id))}
              >
                본인 완료 확인
              </Button>
              <Body small muted>
                양쪽 확인 또는 예상 종료+24시간의 실제 처리로 완료돼요.
                취소·불발·분쟁은 제외해요.
              </Body>
            </>
          )}
          {canWrite && (
            <Button onPress={() => app.navigate("S17", a.id)}>
              {a.completedAt === null ? "비공개 후기 선제출" : "후기 작성하기"}
            </Button>
          )}
          {mine && <Badge tone="gray">내 후기 제출 완료 · 수정 불가</Badge>}
          {deadline && (
            <Body small muted>
              후기 작성 마감 {dateLabel(deadline)} {timeLabel(deadline)}
              {app.now >= deadline ? " · 마감됨" : ""}
            </Body>
          )}
          {a.completedAt === null &&
            a.confirmations.includes(app.viewerId!) && (
              <Body small muted>
                실제 완료 전에 선제출한 후기는 비공개로 기다려요.
              </Body>
            )}
        </Card>
      )}
      {confirmed && (
        <TextButton
          color={colors.red}
          onPress={() => app.navigate("S18", a.postId)}
        >
          {app.now < a.startsAt ? "시작 전 동행 취소" : "중단·불발 신고"}
        </TextButton>
      )}
    </Screen>
  );
}

export function ReviewScreen({ id }: { id?: string }) { return serviceMode ? <RemoteReviewScreen id={id} /> : <PreviewReviewScreen id={id} />; }
function PreviewReviewScreen({ id }: { id?: string }) {
  const app = useApp();
  const [mood, setMood] = useState<Review["mood"] | null>(null);
  const [stars, setStars] = useState(0);
  const [praises, setPraises] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  if (!app.member) return <LoginGuard title="동행 상호 평가" />;
  const a = app.appointments.find((a) => a.id === id);
  if (!a || ![a.hostId, a.applicantId].includes(app.viewerId!))
    return (
      <Screen title="동행 상호 평가">
        <Empty title="평가할 약속이 없어요" />
      </Screen>
    );
  const submitted = app.reviews.find(
    (r) => r.appointmentId === a.id && r.authorId === app.viewerId,
  );
  const allowed = canWriteReview(a, app.viewerId!, app.now);
  const p = app.posts.find((p) => p.id === a.postId);
  if (submitted)
    return (
      <Screen title="동행 상호 평가">
        <Card>
          <Badge tone="green">제출 완료</Badge>
          <Title>후기를 남겨주셨어요</Title>
          <Body muted>
            제출한 후기는 수정하거나 다시 제출할 수 없어요. 실제 완료 후 양쪽이
            제출하면 바로, 한쪽만 제출하면 작성 기한 종료에 공개돼요.
          </Body>
          <Button onPress={() => app.navigate("S16", a.id)}>
            약속으로 돌아가기
          </Button>
        </Card>
      </Screen>
    );
  if (!allowed)
    return (
      <Screen title="동행 상호 평가">
        <Empty
          title={
            a.status === "disputed"
              ? "검토 중에는 후기를 쓸 수 없어요"
              : "지금은 평가할 수 없어요"
          }
          description="예상 종료 후 본인 완료 확인이 필요해요. 취소·분쟁 상태 또는 작성 기한 종료 후에는 제출할 수 없어요."
        />
      </Screen>
    );
  return (
    <Screen
      title="동행 상호 평가"
      footer={
        <Button
          disabled={!mood || !stars}
          onPress={() => {
            const result = app.submitReview(
              a.id,
              mood!,
              stars,
              comment,
              mood === "good" ? praises : [],
            );
            if (result.ok) {
              app.showToast("후기를 제출했어요. 제출 후에는 수정할 수 없어요.");
              app.navigate("S16", a.id);
            } else
              setError(
                result.message ||
                  "제출에 실패했어요. 내용을 유지했으니 다시 시도해 주세요.",
              );
          }}
        >
          평가 제출하기
        </Button>
      }
    >
      <Card style={{ backgroundColor: colors.lavender }}>
        <Badge>{p?.category || "동행"}</Badge>
        <Title style={{ fontSize: 16 }}>{p?.title || "동행 약속"}</Title>
        <Body small muted>
          {rangeLabel(a.startsAt, a.endsAt)}
        </Body>
      </Card>
      <Section title="동행은 어떠셨나요?">
        <Row>
          {(
            [
              ["good", "☺", "좋아요"],
              ["neutral", "😐", "보통이에요"],
              ["bad", "☹", "별로예요"],
            ] as const
          ).map(([value, emoji, label]) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: mood === value }}
              onPress={() => {
                setMood(value);
                if (value !== "good") setPraises([]);
              }}
              style={[st.mood, mood === value && st.selected]}
            >
              <Title>{emoji}</Title>
              <Body
                small
                style={{
                  color: mood === value ? colors.primary : colors.muted,
                }}
              >
                {label}
              </Body>
            </Pressable>
          ))}
        </Row>
      </Section>
      <Card style={{ alignItems: "center", backgroundColor: colors.lavender }}>
        <Body>전체 경험의 별점 (필수)</Body>
        <Row>
          {[1, 2, 3, 4, 5].map((x) => (
            <Pressable
              key={x}
              accessibilityRole="button"
              accessibilityLabel={`${x}점`}
              accessibilityState={{ selected: stars === x }}
              onPress={() => setStars(x)}
              style={{ padding: 5 }}
            >
              <Icon
                name={stars >= x ? "star" : "star-outline"}
                color={colors.primary}
                size={34}
              />
            </Pressable>
          ))}
        </Row>
        <Body small style={{ color: colors.primary }}>
          {stars ? `${stars}.0점` : "별점을 선택해 주세요"}
        </Body>
      </Card>
      {mood === "good" && (
        <Section title={`어떤 점이 좋았나요? · ${praises.length}/3`}>
          <Body small muted>
            공식 칭찬은 선택이며 최대 3개예요.
          </Body>
          <View style={st.chips}>
            {PRAISES.map((x) => (
              <Chip
                key={x}
                selected={praises.includes(x)}
                onPress={() => {
                  if (praises.includes(x))
                    setPraises(praises.filter((v) => v !== x));
                  else if (praises.length < 3) setPraises([...praises, x]);
                  else app.showToast("칭찬은 최대 3개까지 선택할 수 있어요.");
                }}
              >
                {x}
              </Chip>
            ))}
          </View>
        </Section>
      )}
      <Field
        label="한마디 후기 (선택)"
        value={comment}
        onChangeText={setComment}
        multiline
        placeholder="함께한 경험을 솔직하게 남겨주세요"
      />
      <Info>
        실제 완료부터 7일 동안 작성할 수 있어요. 양쪽 제출 또는 작성 마감에
        공개되며 분쟁 중에는 작성·기한·새 공개를 보류해요.
      </Info>
      {error && <Body style={{ color: colors.red }}>{error}</Body>}
    </Screen>
  );
}

export function CancelScreen({ id }: { id?: string }) { return serviceMode ? <RemoteCancelScreen id={id} /> : <PreviewCancelScreen id={id} />; }
function PreviewCancelScreen({ id }: { id?: string }) {
  const app = useApp();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  if (!app.member) return <LoginGuard title="동행 취소·신고" />;
  const p = app.posts.find((p) => p.id === id);
  const a = app.appointments.find(
    (a) =>
      a.postId === id &&
      a.status === "confirmed" &&
      [a.hostId, a.applicantId].includes(app.viewerId!),
  );
  const conversation = app.conversations.find(
    (c) =>
      c.postId === id &&
      c.applicantId === app.viewerId &&
      c.status === "active",
  );
  if (!p || (!a && !conversation))
    return (
      <Screen title="동행 취소·신고">
        <Empty
          title="처리할 신청·약속이 없어요"
          description="이미 철회·취소됐거나 당사자만 접근할 수 있어요."
        />
      </Screen>
    );
  const afterStart = !!a && app.now >= a.startsAt;
  const withdraw = !a;
  if (afterStart)
    return (
      <Screen title="중단·불발 신고">
        <Title large>시작 이후에는 신고로 접수해요</Title>
        <Body muted>
          노쇼나 동행 중단 상황을 알려주세요. 신고 접수만으로 위반이 확정되지는
          않아요.
        </Body>
        <ReportForm
          target={a!.id}
          onClose={() => app.back()}
          onSubmitted={() =>
            feedback(app, app.cancel(p.id, "대면 중단·불발 신고"))
          }
        />
        <Info>
          위급한 상황에는 신고 접수보다 공식 긴급 도움을 먼저 요청하세요.
        </Info>
      </Screen>
    );
  const title = withdraw ? "신청 철회" : "확정 동행 취소";
  return (
    <Screen
      title={title}
      footer={
        <Button
          disabled={!reason.trim()}
          onPress={() => {
            if (!confirm) {
              setConfirm(true);
              return;
            }
            const result = app.cancel(
              p.id,
              [reason, message.trim()].filter(Boolean).join(" · "),
            );
            if (result.ok) {
              app.showToast(`${title}를 처리했어요.`);
              app.navigate("S10");
            } else {
              setError(
                result.message || "처리하지 못했어요. 다시 시도해 주세요.",
              );
              setConfirm(false);
            }
          }}
        >
          {confirm ? `${title} 최종 확인` : `${title}하기`}
        </Button>
      }
    >
      <Badge tone="gray">{withdraw ? "확정 전" : "시작 전 확정 취소"}</Badge>
      <Title large>
        {withdraw ? "신청을 철회할까요?" : "취소 사유를 알려주세요"}
      </Title>
      <Body muted>
        {withdraw
          ? "철회는 연속 확정 취소 제재에 포함되지 않아요. 철회 후 1분이 지나면 같은 대화에서 재신청할 수 있어요."
          : "취소 즉시 이름을 다시 마스킹하고 상세 만남 지점을 숨겨요. 상대에게도 알림이 전달돼요."}
      </Body>
      <View style={{ gap: 10 }}>
        {[
          "개인 일정 변경·급한 사정",
          "상대와 일정 조율이 어려워요",
          "행사 일정 취소·변경",
          "다른 동행 일정 확정",
          "기타",
        ].map((x) => (
          <Pressable
            key={x}
            accessibilityRole="button"
            onPress={() => {
              setReason(x);
              setConfirm(false);
            }}
            style={[st.reason, reason === x && st.selected]}
          >
            <Icon
              name={reason === x ? "radio-button-on" : "radio-button-off"}
              color={reason === x ? colors.primary : colors.faint}
            />
            <Body style={{ flex: 1 }}>{x}</Body>
            {reason === x && <Icon name="checkmark" color={colors.primary} />}
          </Pressable>
        ))}
      </View>
      <Field
        label="상대에게 전할 메시지 (선택)"
        value={message}
        onChangeText={setMessage}
        multiline
      />
      {confirm && (
        <Card style={{ backgroundColor: colors.pink }}>
          <Title style={{ color: colors.red }}>
            선택한 동행을 {withdraw ? "철회" : "취소"}해요
          </Title>
          <Body>{p.title}</Body>
          <Body small muted>
            {reason}
          </Body>
          <TextButton onPress={() => setConfirm(false)}>
            다시 생각하기
          </TextButton>
        </Card>
      )}
      {!withdraw && (
        <Info>
          첫 연속 3회 취소는 경고, 경고 후 다시 연속 3회마다 7일 제한이에요.
          취소 후 24시간 안에 사유 이의를 접수할 수 있어요.
        </Info>
      )}
      {error && <Body style={{ color: colors.red }}>{error}</Body>}
    </Screen>
  );
}

export function SafetyScreen() {
  const app = useApp();
  const rules = [
    {
      icon: "business-outline",
      title: "첫 만남은 공공장소에서",
      text: "사람이 많고 밝은 전시장 로비, 카페 등 공개된 장소에서 만나요.",
    },
    {
      icon: "heart-outline",
      title: "상대의 선택을 존중해요",
      text: "불편한 활동, 장소 변경이나 개인정보 공유를 강요하지 마세요.",
    },
    {
      icon: "lock-closed-outline",
      title: "금전·민감정보 요구에 주의해요",
      text: "무료 1:1 동행에 대가를 요구하거나 계좌·신분증 등 민감정보를 요청하면 주의해 주세요. 행사 입장료는 별도예요.",
    },
    {
      icon: "calendar-outline",
      title: "일정과 귀가 계획을 공유해요",
      text: "만남 시간·장소·귀가 계획을 믿을 수 있는 사람에게 알려두고 변경은 앱 안에서 확인하세요.",
    },
    {
      icon: "alert-circle-outline",
      title: "위급하면 공식 도움을 요청해요",
      text: "위협을 느끼면 안전한 곳으로 이동하고 긴급 도움을 요청하세요. 온라인 문제는 해당 구간 캡처와 설명으로 신고해 주세요.",
    },
  ] as const;
  return (
    <Screen
      title="안심 동행 수칙"
      footer={<Button onPress={app.back}>확인했어요</Button>}
    >
      <View style={{ alignItems: "center", gap: 13, paddingVertical: 10 }}>
        <View style={st.heroIcon}>
          <Icon
            name="shield-checkmark-outline"
            size={34}
            color={colors.primary}
          />
        </View>
        <Title large style={{ textAlign: "center" }}>
          편안한 동행을 위한\n다섯 가지 약속
        </Title>
        <Body muted style={{ textAlign: "center" }}>
          무료 1:1 동행을 함께 존중해요.
        </Body>
      </View>
      {rules.map((rule, i) => (
        <Card key={rule.title}>
          <Row>
            <View style={st.menuIcon}>
              <Icon name={rule.icon} color={colors.primary} />
            </View>
            <Title style={{ fontSize: 17, flex: 1 }}>
              {i + 1}. {rule.title}
            </Title>
          </Row>
          <Body muted>{rule.text}</Body>
        </Card>
      ))}
      <Info>
        수칙과 프로필은 안전을 보증하지 않아요. 신고 자료는 운영 검토에 필요한
        범위로 제출해 주세요.
      </Info>
    </Screen>
  );
}

export function AccountScreen() { return serviceMode ? <RemoteAccountScreen /> : <PreviewAccountScreen />; }
function PreviewAccountScreen() {
  const app = useApp();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [withdraw, setWithdraw] = useState<"discovery" | "summary" | null>(
    null,
  );
  const [support, setSupport] = useState(false);
  const [error, setError] = useState("");
  if (!app.member) return <LoginGuard title="계정 상태" />;
  const privacyUrl = process.env.EXPO_PUBLIC_PRIVACY_URL;
  const privacyReady = !!privacyUrl && /^https:\/\//.test(privacyUrl);
  const status = {
    normal: "정상 이용",
    warning: "경고 이력 있음",
    restricted: "기간제 이용 제한",
    permanent: "영구 이용 제한",
  }[app.accountStatus];
  const active = app.appointments.filter(
    (a) =>
      a.status === "confirmed" &&
      a.completedAt === null &&
      [a.hostId, a.applicantId].includes(app.viewerId!),
  );
  const mail = (subject: string) => {
    void Linking.openURL(
      `mailto:cumaciki0317@gmail.com?subject=${encodeURIComponent(subject)}`,
    ).catch(() =>
      app.showToast(
        "메일 앱을 열지 못했어요. cumaciki0317@gmail.com으로 보내주세요.",
      ),
    );
  };
  return (
    <Screen title="계정 상태·관리">
      <Card>
        <Row>
          <Avatar member={app.member} size={50} />
          <View style={{ flex: 1, gap: 7 }}>
            <Title>{app.member.name}</Title>
            <Badge>네이버 계정 · 만 {app.member.age}세</Badge>
          </View>
        </Row>
        <Body small muted>
          이 화면은 모의 회원 상태예요. 실제 네이버 본인·성인 확인 완료를 뜻하지
          않아요.
        </Body>
      </Card>
      <Card style={{ backgroundColor: colors.lavender }}>
        <Row>
          <Icon name="shield-checkmark-outline" color={colors.primary} />
          <Title>{status}</Title>
        </Row>
        <Body muted>
          {app.accountStatus === "normal"
            ? "현재 모의 계정에 적용된 이용 제한이 없어요."
            : "이용 제한 중에도 기존 확정 약속 관리, 본인 자료 확인과 이의 접수를 제공해요."}
        </Body>
        {app.restrictionsEndAt && (
          <Body small>
            제한 종료: {dateLabel(app.restrictionsEndAt)}{" "}
            {timeLabel(app.restrictionsEndAt)}
          </Body>
        )}
      </Card>
      <Section title="취소·제재 기준">
        <Card>
          <Body>
            확정 동행의 첫 연속 3회 취소는 경고예요. 이후 다시 연속 3회 취소할
            때마다 7일 제한해요.
          </Body>
          <Body small muted>
            결과 확정 직전 합의된 예정 시작 순서로 집계해요. 정상 완료 시 횟수만
            0이 되며 경고 이력은 유지돼요. 확정 전 철회·상대 취소는 포함하지
            않아요.
          </Body>
          <Body small muted>
            취소 이의는 처리 후 24시간 이내예요. 신청 기한 또는 검토가 끝날
            때까지 관련 경고·제재 판정을 보류해요. 취소 외 제재 이의는 안내 후
            7일 이내예요.
          </Body>
          <TextButton onPress={() => mail("유미당 제재·취소 사유 이의 접수")}>
            사유 이의·운영 문의
          </TextButton>
        </Card>
      </Section>
      <Section title="AI 사용 동의">
        <Card>
          <MenuRow
            icon="sparkles-outline"
            title="AI 동행 탐색"
            description={
              app.aiDiscoveryAllowed ? "사용 가능 · 철회 요청" : "새 전송 중단"
            }
            onPress={() => setWithdraw("discovery")}
          />
          <Divider />
          <MenuRow
            icon="document-text-outline"
            title="AI 후기 요약"
            description={
              app.aiSummaryAllowed ? "사용 가능 · 철회 요청" : "관련 요약 숨김"
            }
            onPress={() => setWithdraw("summary")}
          />
          <Body small muted>
            철회해도 계정과 일반 동행은 유지돼요. 해당 AI의 새 전송을 멈추고
            관련 요약을 숨겨요. 실제 공급사 전송·사본 삭제는 별도 운영 확인이
            필요해요.
          </Body>
          {withdraw && (
            <View style={{ gap: 10 }}>
              <Title style={{ fontSize: 16 }}>
                {withdraw === "discovery" ? "AI 탐색" : "AI 후기 요약"} 사용을
                철회할까요?
              </Title>
              <Button
                onPress={() => {
                  app.withdrawAi(withdraw);
                  app.showToast("해당 AI의 모의 사용을 중단했어요.");
                  setWithdraw(null);
                }}
              >
                해당 AI 철회 요청
              </Button>
              <TextButton onPress={() => setWithdraw(null)}>
                돌아가기
              </TextButton>
            </View>
          )}
        </Card>
      </Section>
      <Section title="안전·지원">
        <Card style={{ padding: 0 }}>
          <MenuRow
            icon="shield-outline"
            title="안심 동행 수칙"
            onPress={() => app.navigate("S19")}
          />
          <Divider />
          <MenuRow
            icon="mail-outline"
            title="고객지원·개인정보 문의"
            description="cumaciki0317@gmail.com"
            onPress={() => setSupport(!support)}
          />
          {support && (
            <View style={{ padding: 18, gap: 10 }}>
              <Body small muted>
                앱 밖에서도 고객지원 이메일로 탈퇴·개인정보 삭제를 요청할 수
                있어요. 앱을 재설치할 필요가 없어요.
              </Body>
              {privacyReady ? (
                <Button
                  secondary
                  onPress={() => {
                    void Linking.openURL(privacyUrl!).catch(() =>
                      app.showToast(
                        "안내 페이지를 열지 못했어요. 지원 이메일로 요청해 주세요.",
                      ),
                    );
                  }}
                >
                  앱 밖 개인정보·계정 삭제 안내
                </Button>
              ) : (
                <Body small muted>
                  외부 개인정보처리방침의 삭제 안내는 게시 준비 중이에요. 현재는
                  아래 지원 메일로 접수해 주세요.
                </Body>
              )}
              <Button
                secondary
                onPress={() => mail("유미당 계정·개인정보 삭제 요청")}
              >
                계정 삭제 요청 메일 열기
              </Button>
            </View>
          )}
        </Card>
      </Section>
      <Section title="회원 탈퇴">
        <Card>
          <Body>
            진행 중인 확정 동행만 먼저 정리해 주세요. 후기 기간이나 분쟁만 남아
            있어도 탈퇴를 요청할 수 있어요.
          </Body>
          <Body small muted>
            프로필·사진 활성 저장본은 즉시 삭제해요. 기존 공개 후기는 익명으로
            유지하며, 제재·경고는 같은 네이버 재가입 시 승계돼요. 재가입은 당도
            15·완료 0의 새 프로필이고 과거 후기를 복구하지 않아요.
          </Body>
          {active.length > 0 && (
            <View style={{ gap: 10 }}>
              <Badge tone="pink">확정 동행 {active.length}개 정리 필요</Badge>
              {active.map((a) => (
                <TextButton
                  key={a.id}
                  onPress={() => app.navigate("S16", a.id)}
                >
                  {app.posts.find((p) => p.id === a.postId)?.title ||
                    "약속 확인"}{" "}
                  ›
                </TextButton>
              ))}
            </View>
          )}
          <Button secondary onPress={() => setDeleteConfirm(!deleteConfirm)}>
            회원 탈퇴 안내·확인
          </Button>
          {deleteConfirm && (
            <View style={{ gap: 12 }}>
              <Body style={{ color: colors.red, fontWeight: "600" }}>
                내 계정과 프로필을 삭제할까요?
              </Body>
              <Button
                disabled={active.length > 0}
                onPress={async () => {
                  const result = await app.deleteAccount();
                  if (result.ok) {
                    app.showToast("모의 계정 삭제를 처리했어요.");
                    app.navigate("S00");
                  } else
                    setError(result.message || "탈퇴를 처리하지 못했어요.");
                }}
              >
                계정 삭제 최종 확인
              </Button>
              <TextButton onPress={() => setDeleteConfirm(false)}>
                계정 유지
              </TextButton>
            </View>
          )}
          {error && <Body style={{ color: colors.red }}>{error}</Body>}
        </Card>
      </Section>
      <Button
        secondary
        onPress={() => {
          void app.logout();
        }}
      >
        로그아웃
      </Button>
    </Screen>
  );
}

const st = StyleSheet.create({
  info: {
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.lavender,
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
  },
  menu: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
    minHeight: 72,
  },
  menuIcon: {
    height: 35,
    width: 35,
    borderRadius: 10,
    backgroundColor: colors.lavender,
    alignItems: "center",
    justifyContent: "center",
  },
  send: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  bubble: {
    maxWidth: "85%",
    padding: 14,
    borderRadius: 17,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: colors.line,
    borderBottomLeftRadius: 4,
  },
  ownBubble: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    borderBottomLeftRadius: 17,
    borderBottomRightRadius: 4,
  },
  noticeIcon: {
    height: 40,
    width: 40,
    borderRadius: 14,
    backgroundColor: "#E5D9FF",
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    height: 7,
    width: 7,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  track: {
    height: 6,
    borderRadius: 5,
    backgroundColor: "#E6DCF8",
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 5, backgroundColor: colors.primary },
  detail: {
    flexDirection: "row",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.lavender,
  },
  mood: {
    flex: 1,
    alignItems: "center",
    gap: 8,
    paddingVertical: 17,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  selected: { borderColor: colors.primary, backgroundColor: colors.lavender },
  reason: {
    minHeight: 60,
    padding: 16,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "#fff",
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  heroIcon: {
    height: 76,
    width: 76,
    borderRadius: 25,
    backgroundColor: colors.lavender,
    alignItems: "center",
    justifyContent: "center",
  },
});
