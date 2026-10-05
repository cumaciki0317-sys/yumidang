import RemotePlacePicker from "./RemotePlacePicker";
import { serviceMode, serviceSessionEpoch, useServiceSession } from "../remote";
import { RemotePostEditor, useMemberAction } from "./RemoteMemberScreens";
import * as Crypto from "expo-crypto";
import { RemotePostResults, RemoteEventResults, RemotePostDetail, RemoteEventDetail, RemoteRankings, RemoteEventListScreen, RemoteEventPicker } from "./RemoteScreens";
import React, { useMemo, useRef, useState } from "react";
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useApp } from "../state";
import type {
  AppContextValue,
  Draft,
  Filters,
  OperationResult,
  Post,
} from "../types";
import {
  CATEGORIES,
  DAY,
  filterPosts,
  monthWeek,
  parseDateInput,
  selectEvents,
  validateDraft,
} from "../domain";
import {
  Artwork,
  Badge,
  Body,
  Button,
  Card,
  Chip,
  colors,
  dateLabel,
  Divider,
  Empty,
  EventCard,
  Field,
  Icon,
  MemberBox,
  PostCard,
  rangeLabel,
  Row,
  Screen,
  Section,
  TextButton,
  Title,
  timeLabel,
} from "../ui";

const BASE_FILTERS: Filters = {
  query: "",
  category: "",
  region: "",
  from: "",
  to: "",
  ageMin: "",
  ageMax: "",
  recruiting: false,
  sort: "created_desc",
};
const REGIONS = [
  "전체",
  "서울",
  "부산",
  "대구",
  "인천",
  "광주",
  "대전",
  "울산",
  "세종",
  "경기",
  "강원",
  "충북",
  "충남",
  "전북",
  "전남",
  "경북",
  "경남",
  "제주",
];
const CATEGORY_ICONS: React.ComponentProps<typeof Icon>["name"][] = [
  "flash-outline",
  "color-palette-outline",
  "sparkles-outline",
  "storefront-outline",
  "musical-notes-outline",
  "film-outline",
  "restaurant-outline",
  "cafe-outline",
  "bag-outline",
  "airplane-outline",
  "bicycle-outline",
  "walk-outline",
  "game-controller-outline",
  "paw-outline",
  "book-outline",
  "grid-outline",
];
const CATEGORY_COLORS = [
  "#FFF5E8",
  "#F1ECFF",
  "#FFF0F5",
  "#E8F6F2",
  "#EAF3FF",
  "#FFF4E9",
];
function feedback(
  app: AppContextValue,
  result: OperationResult,
  success?: string,
) {
  if (!result.ok)
    app.showToast(result.message || "처리하지 못했어요. 다시 시도해 주세요.");
  else if (success) app.showToast(success);
  return result.ok;
}
function localInput(at: number) {
  return new Date(at + 9 * 60 * 60 * 1000).toISOString().slice(0, 16);
}
function blankDraft(category = ""): Draft {
  return {
    category,
    title: "",
    introduction: "",
    placeName: "",
    publicArea: "",
    address: "",
    meetingPoint: "",
    startsAt: "",
    endsAt: "",
    deadlineAt: "",
    desiredAgeMin: "",
    desiredAgeMax: "",
    wishes: "",
    updatedAt: 0,
  };
}
function InfoLine({
  icon,
  label,
  value,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  value: string;
}) {
  return (
    <Row style={{ alignItems: "flex-start", gap: 12 }}>
      <View style={styles.infoIcon}>
        <Icon name={icon} color={colors.primary} size={18} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Body small muted>
          {label}
        </Body>
        <Body style={{ fontWeight: "600" }}>{value}</Body>
      </View>
    </Row>
  );
}
function ConfirmCard({
  title,
  description,
  confirm,
  cancel = "취소",
  onConfirm,
  onCancel,
  danger = false,
}: {
  title: string;
  description: string;
  confirm: string;
  cancel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  return (
    <Modal transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <Card style={styles.confirm}>
          <Title>{title}</Title>
          <Body muted>{description}</Body>
          <Row>
            <Button secondary onPress={onCancel} style={{ flex: 1 }}>
              {cancel}
            </Button>
            <Button
              onPress={onConfirm}
              style={{
                flex: 1,
                ...(danger ? { backgroundColor: colors.red } : {}),
              }}
            >
              {confirm}
            </Button>
          </Row>
        </Card>
      </View>
    </Modal>
  );
}
function AccountHeader() {
  const app = useApp();
  const session = useServiceSession();
  if (serviceMode && session.authenticated) return <Body small>로그인됨</Body>;
  return app.member ? (
    <Row>
      <Body small style={{ fontWeight: "700" }}>
        {app.member.name}
      </Body>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="알림"
        onPress={() => app.navigate("S12")}
        style={styles.iconTap}
      >
        <Icon name="notifications-outline" />
        {app.notifications.some((n) => !n.read) && (
          <View style={styles.notificationDot} />
        )}
      </Pressable>
    </Row>
  ) : (
    <Button
      onPress={() => app.navigate("S05")}
      style={{ minHeight: 31, paddingVertical: 5, paddingHorizontal: 14 }}
    >
      <Text style={{ fontSize: 12 }}>로그인</Text>
    </Button>
  );
}
function FloatingActions() {
  const app = useApp();
  const session = useServiceSession();
  const authenticated = Boolean(app.member) || (serviceMode && session.authenticated);
  return (
    <View style={styles.floating}>
      <Pressable
        accessibilityRole="button"
        onPress={() => app.navigate(authenticated ? "S20" : "S05")}
        style={styles.aiButton}
      >
        <Icon name="sparkles-outline" color={colors.primary} size={14} />
        <Text style={styles.aiLabel}>AI 동행 탐색</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="동행 공고 작성"
        onPress={() => app.navigate(authenticated ? "S03" : "S05")}
        style={styles.addButton}
      >
        <Icon name="add" size={29} color="white" />
      </Pressable>
    </View>
  );
}

export function HomeScreen() {
  const app = useApp();
  const session = useServiceSession();
  const events = selectEvents(app.events, app.now);
  const upcoming = app.appointments
    .filter(
      (a) =>
        a.status === "confirmed" &&
        a.endsAt > app.now &&
        (a.hostId === app.viewerId || a.applicantId === app.viewerId),
    )
    .sort((a, b) => a.startsAt - b.startsAt)[0];
  const upcomingPost = app.posts.find((p) => p.id === upcoming?.postId);
  return (
    <View style={{ flex: 1 }}>
      <Screen title="유미당" tab right={<AccountHeader />}>
        <Section
          title="이번 주 새로 시작한 행사"
          action="전체보기"
          onPress={() => app.navigate("S09-2")}
        >
          <Body small muted>
            {monthWeek(app.now).label} · 이번 주 신규 중 미종료
          </Body>
          {serviceMode ? <RemoteEventResults /> : events.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 12 }}
              style={{ marginHorizontal: -2 }}
            >
              {events.slice(0, 5).map((event) => (
                <Pressable
                  key={event.id}
                  accessibilityRole="button"
                  onPress={() => app.navigate("S09-3", event.id)}
                  style={styles.heroEvent}
                >
                  <Artwork
                    name={event.image}
                    height={190}
                    style={{ borderRadius: 16 }}
                  />
                  <View style={styles.heroShade} />
                  <View style={styles.heroBadge}>
                    <Badge tone="gray">
                      {event.startsAt <= app.now ? "진행 중" : "예정"}
                    </Badge>
                  </View>
                  <View style={styles.heroCopy}>
                    <Body small style={{ color: "#F7F3FF" }}>
                      {dateLabel(event.startsAt)}–{dateLabel(event.endsAt)} ·{" "}
                      {event.publicArea}
                    </Body>
                    <Title style={{ color: "#fff", fontSize: 19 }}>
                      {event.title}
                    </Title>
                    <Body small style={{ color: "#F0E8FF" }}>
                      문화 경험에 동행을 더해 보세요 ›
                    </Body>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          ) : (
            <Card>
              <Body muted>이번 주 새로 시작하는 미종료 행사가 없어요.</Body>
              <TextButton onPress={() => app.navigate("S09-2")}>
                진행 중인 행사도 둘러보기
              </TextButton>
            </Card>
          )}
        </Section>
        <Section
          title="다가오는 약속"
          action={app.member ? "나의 동행" : undefined}
          onPress={() => app.navigate("S13", "activity")}
        >
          {serviceMode && session.authenticated ? <Card><Body muted>약속 정보 연결을 준비 중이에요.</Body></Card> : !app.member ? (
            <Card style={{ backgroundColor: colors.lavender }}>
              <Body muted>로그인하면 다가오는 약속을 확인할 수 있어요.</Body>
              <TextButton onPress={() => app.navigate("S05")}>
                네이버로 로그인 ›
              </TextButton>
            </Card>
          ) : upcoming ? (
            <Card
              onPress={() => app.navigate("S16", upcoming.id)}
              style={{
                backgroundColor: colors.lavender,
                borderColor: "#E4D9FD",
              }}
            >
              <Row between>
                <Badge>동행 확정</Badge>
                <Badge tone="gray">
                  {upcoming.startsAt <= app.now
                    ? "진행 중"
                    : `D-${Math.max(0, Math.ceil((upcoming.startsAt - app.now) / DAY))}`}
                </Badge>
              </Row>
              <Title style={{ fontSize: 17 }}>
                {upcomingPost?.title || "확정된 동행 약속"}
              </Title>
              <Body small muted>
                {rangeLabel(upcoming.startsAt, upcoming.endsAt)}
              </Body>
              <Row between>
                <Body small muted>
                  {upcomingPost?.publicArea}
                </Body>
                <Body small style={{ color: colors.primary }}>
                  약속 상세 보기 ›
                </Body>
              </Row>
            </Card>
          ) : (
            <Card>
              <Row>
                <View style={styles.infoIcon}>
                  <Icon name="calendar-outline" color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Body style={{ fontWeight: "600" }}>
                    아직 확정된 약속이 없어요
                  </Body>
                  <Body small muted>
                    마음에 드는 동행을 찾아보세요.
                  </Body>
                </View>
              </Row>
              <TextButton onPress={() => app.navigate("S01")}>
                동행 둘러보기 ›
              </TextButton>
            </Card>
          )}
        </Section>
        <Section title="어떤 동행을 찾으세요?">
          <View style={styles.categoryGrid}>
            {CATEGORIES.map((category, index) => (
              <Pressable
                key={category}
                accessibilityRole="button"
                accessibilityLabel={`${category} 동행 보기`}
                onPress={() => app.navigate("S09", category)}
                style={styles.categoryItem}
              >
                <View
                  style={[
                    styles.categoryIcon,
                    {
                      backgroundColor:
                        CATEGORY_COLORS[index % CATEGORY_COLORS.length],
                    },
                  ]}
                >
                  <Icon
                    name={CATEGORY_ICONS[index]}
                    size={25}
                    color={index % 3 === 0 ? "#D07B30" : colors.primary}
                  />
                </View>
                <Body small>{category}</Body>
              </Pressable>
            ))}
          </View>
        </Section>
        <Card style={{ backgroundColor: colors.lavender, padding: 14 }}>
          <Row>
            <Icon
              name="shield-checkmark-outline"
              size={26}
              color={colors.primary}
            />
            <View style={{ flex: 1 }}>
              <Body style={{ fontWeight: "700", fontSize: 13 }}>
                함께 취향을 나누는 무료 1:1 동행
              </Body>
              <Body small muted>
                서로를 존중하며 편안한 시간을 보내요.
              </Body>
            </View>
          </Row>
        </Card>
      </Screen>
      <FloatingActions />
    </View>
  );
}

function BrowseList({ category }: { category?: string }) {
  const app = useApp();
  const session = useServiceSession();
  const hasMember = Boolean(app.member) || (serviceMode && session.authenticated);
  const [applied, setApplied] = useState<Filters>({
    ...BASE_FILTERS,
    category: category || "",
  });
  const [pending, setPending] = useState<Filters>(applied);
  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterError, setFilterError] = useState("");
  const [limit, setLimit] = useState(10);
  const [searchFocused, setSearchFocused] = useState(false);
  const [failed, setFailed] = useState(false);
  const results = useMemo(
    () =>
      filterPosts(
        app.posts,
        applied,
        app.members,
        app.viewerId,
        app.blockedIds,
        app.events,
      ),
    [app.posts, applied, app.members, app.viewerId, app.blockedIds, app.events],
  );
  const pendingResults = filterPosts(
    app.posts,
    pending,
    app.members,
    app.viewerId,
    app.blockedIds,
    app.events,
  );
  const set = (patch: Partial<Filters>) =>
    setPending((prev) => ({ ...prev, ...patch }));
  const runSearch = (value = query) => {
    setApplied((prev) => ({ ...prev, query: value }));
    setPending((prev) => ({ ...prev, query: value }));
    setQuery(value);
    setLimit(10);
    setSearchFocused(false);
    if (value.trim()) app.addSearch(value.trim());
    if (app.failNext) {
      app.setPreview({ failNext: false });
      setFailed(true);
    }
  };
  const openFilter = () => {
    setPending({ ...applied });
    setFilterError("");
    setFilterOpen(true);
  };
  const applyFilters = () => {
    if (hasMember && Boolean(pending.from) !== Boolean(pending.to)) { setFilterError("시작 날짜와 종료 날짜를 모두 입력해 주세요."); return; }
    if (hasMember && (pending.ageMin || pending.ageMax)) {
      const min = Number(pending.ageMin || 19),
        max = Number(pending.ageMax || 99);
      if (
        !Number.isInteger(min) ||
        !Number.isInteger(max) ||
        min < 19 ||
        max > 99 ||
        min > max
      ) {
        setFilterError(
          "작성자 나이는 만 19~99세, 최소 나이는 최대 나이 이하로 선택해 주세요.",
        );
        return;
      }
    }
    if (
      hasMember &&
      ((pending.from && !Number.isFinite(parseDateInput(pending.from))) ||
        (pending.to && !Number.isFinite(parseDateInput(pending.to))))
    ) {
      setFilterError("일정은 YYYY-MM-DD 형식으로 입력해 주세요.");
      return;
    }
    if (
      pending.from &&
      pending.to &&
      parseDateInput(pending.from) > parseDateInput(pending.to)
    ) {
      setFilterError("종료 날짜는 시작 날짜 이후로 입력해 주세요.");
      return;
    }
    setApplied({
      ...pending,
      ...(!hasMember ? { from: "", to: "", ageMin: "", ageMax: "" } : {}),
    });
    setLimit(10);
    setFilterOpen(false);
  };
  const reset = () => {
    const next = { ...BASE_FILTERS, category: category || "" };
    setApplied(next);
    setPending(next);
    setQuery("");
    setLimit(10);
  };
  const activeLabels = [
    applied.category,
    applied.region,
    ...(hasMember
      ? [
          applied.from || applied.to ? "일정 지정" : "",
          applied.ageMin || applied.ageMax
            ? `${applied.ageMin || 19}~${applied.ageMax || 99}세`
            : "",
        ]
      : []),
    applied.recruiting ? "모집 중" : "",
  ].filter((v) => v && v !== "전체");
  return (
    <View style={{ flex: 1 }}>
      <Screen
        title={category ? `${category} 동행` : "둘러보기"}
        tab={!category}
        right={<AccountHeader />}
      >
        <View style={{ gap: 12 }}>
          <Row>
            <View style={{ flex: 1 }}>
              <Field
                value={query}
                onChangeText={setQuery}
                onFocus={() => setSearchFocused(true)}
                onSubmitEditing={() => runSearch()}
                placeholder="공고 제목, 장소, 주소, 행사명 검색"
                returnKeyType="search"
                style={{ paddingLeft: 16 }}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="검색하기"
              onPress={() => runSearch()}
              style={styles.searchButton}
            >
              <Icon name="search-outline" color={colors.primary} />
            </Pressable>
          </Row>
          {searchFocused && app.recentSearches.length > 0 && (
            <Card style={{ padding: 14 }}>
              <Row between>
                <Body small style={{ fontWeight: "700" }}>
                  최근 검색어
                </Body>
                <TextButton
                  onPress={() => {
                    void app.clearSearches();
                  }}
                >
                  전체 삭제
                </TextButton>
              </Row>
              <View style={styles.wrap}>
                {app.recentSearches
                  .filter((s) => app.now - s.at < 7 * DAY)
                  .slice(0, 10)
                  .map((s) => (
                    <Chip key={s.text} onPress={() => runSearch(s.text)}>
                      {s.text}
                    </Chip>
                  ))}
              </View>
            </Card>
          )}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 7 }}
          >
            <Chip onPress={openFilter}>☷ 필터</Chip>
            <Chip selected={Boolean(applied.region)} onPress={openFilter}>
              {applied.region || "지역"} ⌄
            </Chip>
            <Chip
              selected={Boolean(applied.from || applied.to)}
              disabled={!hasMember}
              onPress={openFilter}
            >
              일정 ⌄
            </Chip>
            <Chip
              selected={Boolean(applied.ageMin || applied.ageMax)}
              disabled={!hasMember}
              onPress={openFilter}
            >
              나이 ⌄
            </Chip>
            <Chip selected={Boolean(applied.category)} onPress={openFilter}>
              {applied.category || "카테고리"} ⌄
            </Chip>
          </ScrollView>
          {!hasMember && (
            <Body small muted>
              일정·작성자 나이 상세 조건은 로그인 후 선택할 수 있어요.
            </Body>
          )}
          <Row between>
            <Chip
              selected={applied.recruiting}
              onPress={() => {
                setApplied((prev) => ({
                  ...prev,
                  recruiting: !prev.recruiting,
                }));
                setLimit(10);
              }}
            >
              모집 중만 보기
            </Chip>
            <TextButton
              color={colors.muted}
              onPress={() => {
                setApplied((prev) => ({
                  ...prev,
                  sort:
                    prev.sort === "created_desc"
                      ? "starts_asc"
                      : "created_desc",
                }));
                setLimit(10);
              }}
            >
              {applied.sort === "created_desc"
                ? "등록일 최신순"
                : "시작일 빠른순"}{" "}
              ⌄
            </TextButton>
          </Row>
          {!failed && !serviceMode && (
            <Row between>
              <Body style={{ fontWeight: "700" }}>
                총{" "}
                <Text style={{ color: colors.primary }}>
                  {results.length}개
                </Text>
                의 동행
              </Body>
              {activeLabels.length > 0 && (
                <TextButton onPress={reset}>조건 초기화</TextButton>
              )}
            </Row>
          )}
          {activeLabels.length > 0 && (
            <View style={styles.wrap}>
              {activeLabels.map((label) => (
                <Badge key={label}>{label}</Badge>
              ))}
            </View>
          )}
        </View>
        {serviceMode ? <RemotePostResults filters={applied} reset={reset} /> : failed ? (
          <Empty
            title="공고를 불러오지 못했어요"
            description="입력한 검색 조건은 그대로 남아 있어요."
            action="다시 시도"
            onPress={() => setFailed(false)}
            icon="cloud-offline-outline"
          />
        ) : results.length ? (
          <View style={{ gap: 14 }}>
            {results.slice(0, limit).map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
            {limit < results.length && (
              <Button secondary onPress={() => setLimit((n) => n + 10)}>
                공고 10개 더 보기
              </Button>
            )}
          </View>
        ) : (
          <Empty
            title="조건에 맞는 동행이 없어요"
            description="지역이나 카테고리를 바꿔서 찾아보세요."
            action="조건 초기화"
            onPress={reset}
            icon="search-outline"
          />
        )}
        {category && (
          <Button
            onPress={() =>
              app.navigate(
                hasMember ? "S03" : "S05",
                hasMember ? `category:${category}` : undefined,
              )
            }
            icon="add"
          >
            {category} 동행 모집하기
          </Button>
        )}
      </Screen>
      {!category && <FloatingActions />}
      <Modal
        visible={filterOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setFilterOpen(false)}
      >
        <View style={styles.sheetOverlay}>
          <View style={styles.filterSheet}>
            <View style={styles.handle} />
            <Row between style={{ paddingHorizontal: 22 }}>
              <Title>필터</Title>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="필터 닫기"
                onPress={() => setFilterOpen(false)}
                style={styles.iconTap}
              >
                <Icon name="close-outline" />
              </Pressable>
            </Row>
            <ScrollView
              contentContainerStyle={{ padding: 22, gap: 22 }}
              keyboardShouldPersistTaps="handled"
            >
              <Body small muted>
                선택 중인 조건이에요. 적용하기를 눌러야 결과에 반영돼요.
              </Body>
              <Section title="카테고리">
                <View style={styles.wrap}>
                  {["전체", ...CATEGORIES].map((v) => (
                    <Chip
                      key={v}
                      selected={(pending.category || "전체") === v}
                      onPress={() => set({ category: v === "전체" ? "" : v })}
                    >
                      {v}
                    </Chip>
                  ))}
                </View>
              </Section>
              <Section title="지역 (시·도)">
                <View style={styles.wrap}>
                  {REGIONS.map((v) => (
                    <Chip
                      key={v}
                      selected={(pending.region || "전체") === v}
                      onPress={() => set({ region: v === "전체" ? "" : v })}
                    >
                      {v}
                    </Chip>
                  ))}
                </View>
              </Section>
              <Section title="일정">
                <Chip
                  disabled={!hasMember}
                  selected={!pending.from && !pending.to}
                  onPress={() => set({ from: "", to: "" })}
                >
                  전체 일정
                </Chip>
                <Row>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="시작 날짜"
                      placeholder="2026-10-05"
                      value={pending.from}
                      editable={Boolean(hasMember)}
                      onChangeText={(from) => set({ from })}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="종료 날짜"
                      placeholder="2026-10-12"
                      value={pending.to}
                      editable={Boolean(hasMember)}
                      onChangeText={(to) => set({ to })}
                    />
                  </View>
                </Row>
              </Section>
              <Section title="작성자 나이 (만 19~99세)">
                <Chip
                  disabled={!hasMember}
                  selected={!pending.ageMin && !pending.ageMax}
                  onPress={() => set({ ageMin: "", ageMax: "" })}
                >
                  전체 나이
                </Chip>
                <Row>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="최소 나이"
                      keyboardType="number-pad"
                      placeholder="19"
                      value={pending.ageMin}
                      editable={Boolean(hasMember)}
                      onChangeText={(ageMin) => set({ ageMin })}
                    />
                  </View>
                  <Body muted>~</Body>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="최대 나이"
                      keyboardType="number-pad"
                      placeholder="99"
                      value={pending.ageMax}
                      editable={Boolean(hasMember)}
                      onChangeText={(ageMax) => set({ ageMax })}
                    />
                  </View>
                </Row>
                {!hasMember && (
                  <TextButton
                    onPress={() => {
                      setFilterOpen(false);
                      app.navigate("S05");
                    }}
                  >
                    로그인 후 일정·나이 선택하기
                  </TextButton>
                )}
              </Section>
              {filterError && (
                <Body small style={{ color: colors.red }}>
                  {filterError}
                </Body>
              )}
            </ScrollView>
            <View style={styles.filterFooter}>
              <Row>
                <Button
                  secondary
                  onPress={() => {
                    setPending({ ...BASE_FILTERS, query: applied.query });
                    setFilterError("");
                  }}
                  style={{ flex: 1 }}
                >
                  초기화
                </Button>
                <Button onPress={applyFilters} style={{ flex: 2 }}>
                  {serviceMode ? "적용하기" : `적용하기 (${pendingResults.length}건)`}
                </Button>
              </Row>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
export function ExploreScreen() {
  return <BrowseList />;
}
export function CategoryScreen({ id }: { id?: string }) {
  return <BrowseList key={id || "전시"} category={id || "전시"} />;
}

export function EventListScreen({ id }: { id?: string }) { return serviceMode ? <RemoteEventListScreen selecting={id === "select"} /> : <PreviewEventListScreen id={id} />; }
function PreviewEventListScreen({ id }: { id?: string }) {
  const app = useApp();
  const selecting = id === "select";
  const [category, setCategory] = useState("전체");
  const [ongoing, setOngoing] = useState(false);
  const [past, setPast] = useState(false);
  const [pastStart, setPastStart] = useState("");
  const [pastEnd, setPastEnd] = useState("");
  const [ranking, setRanking] = useState<"전체 공연" | "뮤지컬">("전체 공연");
  const [limit, setLimit] = useState(10);
  const [failed, setFailed] = useState(false);
  const events = selectEvents(app.events, app.now, ongoing, past).filter(
    (e) => category === "전체" || e.category === category,
  );
  const choose = async (eventId: string) => {
    const event = app.events.find((e) => e.id === eventId);
    if (!event || event.endsAt <= app.now) {
      app.showToast("종료된 행사는 새 모집에 연결할 수 없어요.");
      return;
    }
    await app.saveDraft({
      ...(app.draft || blankDraft()),
      eventId,
      updatedAt: app.now,
    });
    app.navigate("S03", `event:${eventId}`);
  };
  return (
    <Screen
      title={selecting ? "연결할 행사 선택" : "행사 둘러보기"}
      right={<AccountHeader />}
    >
      {!selecting && (
        <Card style={{ backgroundColor: colors.lavender }}>
          <Row>
            <Icon name="musical-notes-outline" color={colors.primary} />
            <Title style={{ fontSize: 17 }}>KOPIS 공식 공연 Top 10</Title>
          </Row>
          <Body small muted>
            어제까지 최근 7일 집계 · 매일 갱신 기준
          </Body>
          <Row>
            {(["전체 공연", "뮤지컬"] as const).map((v) => (
              <Chip
                key={v}
                selected={ranking === v}
                onPress={() => setRanking(v)}
              >
                {v}
              </Chip>
            ))}
          </Row>
          <View style={styles.rankingEmpty}>
            {serviceMode ? <RemoteRankings mode={ranking === "뮤지컬" ? "musical" : "all"} /> : <>
            <Icon name="cloud-offline-outline" color={colors.muted} size={24} />
            <Body small muted>
              {ranking} 순위 데이터가 아직 연결되지 않았어요.
            </Body></>}
          </View>
        </Card>
      )}
      <Section title={past ? "지난 문화 행사" : "이번 주 문화 행사"}>
        <Body small muted>
          {monthWeek(app.now).label} ·{" "}
          {past
            ? (serviceMode ? "선택한 과거 기간과 겹치는 행사예요." : "종료한 행사만 보여드려요.")
            : "기본 목록은 이번 주 신규 중 미종료 행사예요."}
        </Body>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 7 }}
        >
          {["전체", "전시", "축제", "팝업", "공연", "영화"].map((v) => (
            <Chip
              key={v}
              selected={category === v}
              onPress={() => {
                setCategory(v);
                setLimit(10);
              }}
            >
              {v}
            </Chip>
          ))}
        </ScrollView>
        <View style={styles.wrap}>
          <Chip
            selected={ongoing}
            disabled={past}
            onPress={() => {
              setOngoing((v) => !v);
              setLimit(10);
            }}
          >
            ✓ 진행 중인 행사도 포함
          </Chip>
          <Chip
            selected={past}
            onPress={() => {
              setPast((v) => !v);
              setLimit(10);
            }}
          >
            과거 행사 조회
          </Chip>
        </View>
      </Section>
      {selecting && (
        <Card style={{ padding: 14 }}>
          <Body small muted>
            행사를 연결해도 작성 중인 동행 일정은 바뀌지 않아요.
          </Body>
        </Card>
      )}
      {serviceMode ? <View style={{ gap: 14 }}>
        {past && <><Body muted>조회할 기간을 선택해 주세요.</Body><Row><Field label="시작 날짜" value={pastStart} onChangeText={setPastStart} placeholder="YYYY-MM-DD" /><Field label="종료 날짜" value={pastEnd} onChangeText={setPastEnd} placeholder="YYYY-MM-DD" /></Row></>}
        {!past || (Number.isFinite(parseDateInput(pastStart)) && Number.isFinite(parseDateInput(pastEnd)) && parseDateInput(pastStart) <= parseDateInput(pastEnd))
          ? <RemoteEventResults category={category} includeOngoing={!past && ongoing} period={past ? { start: pastStart, end: pastEnd } : undefined} />
          : <Body muted>올바른 시작·종료 날짜를 입력해 주세요.</Body>}
      </View> : failed ? (
        <Empty
          title="행사를 불러오지 못했어요"
          action="다시 시도"
          onPress={() => setFailed(false)}
          icon="cloud-offline-outline"
        />
      ) : events.length ? (
        <View style={{ gap: 16 }}>
          {events.slice(0, limit).map((event) => (
            <View key={event.id} style={{ gap: 8 }}>
              <Row between>
                <Badge
                  tone={
                    event.endsAt <= app.now
                      ? "gray"
                      : event.startsAt <= app.now
                        ? "green"
                        : "purple"
                  }
                >
                  {event.endsAt <= app.now
                    ? "종료"
                    : event.startsAt <= app.now
                      ? "진행 중"
                      : "예정"}
                </Badge>
                {!selecting && (
                  <Body small muted>
                    연결 공고{" "}
                    {
                      app.posts.filter(
                        (p) => p.eventId === event.id && p.status !== "deleted",
                      ).length
                    }
                    건
                  </Body>
                )}
              </Row>
              <EventCard
                event={event}
                onPress={() =>
                  selecting
                    ? void choose(event.id)
                    : app.navigate("S09-3", event.id)
                }
              />
              {selecting && (
                <Button
                  secondary
                  disabled={event.endsAt <= app.now}
                  onPress={() => {
                    void choose(event.id);
                  }}
                >
                  이 행사 연결하기
                </Button>
              )}
            </View>
          ))}
          {limit < events.length && (
            <Button
              secondary
              onPress={() => {
                if (app.failNext) {
                  app.setPreview({ failNext: false });
                  setFailed(true);
                } else setLimit((n) => n + 10);
              }}
            >
              행사 10개 더 보기
            </Button>
          )}
        </View>
      ) : (
        <Empty
          title={past ? "지난 행사가 없어요" : "조건에 맞는 행사가 없어요"}
          description="카테고리 또는 진행 중 포함 조건을 바꿔 보세요."
          action="조건 초기화"
          onPress={() => {
            setCategory("전체");
            setOngoing(true);
            setPast(false);
          }}
        />
      )}
    </Screen>
  );
}

export function EventDetailScreen({ id }: { id: string }) { return serviceMode ? <RemoteEventDetail id={id} /> : <PreviewEventDetail id={id} />; }
function PreviewEventDetail({ id }: { id: string }) {
  const app = useApp();
  const event = app.events.find((e) => e.id === id);
  const [limit, setLimit] = useState(10);
  if (!event)
    return (
      <Screen title="행사 상세">
        <Empty
          title="행사를 찾을 수 없어요"
          action="행사 목록 보기"
          onPress={() => app.navigate("S09-2")}
        />
      </Screen>
    );
  const ended = event.endsAt <= app.now;
  const posts = app.posts.filter(
    (p) =>
      p.eventId === id &&
      p.status !== "deleted" &&
      !app.blockedIds.includes(p.authorId),
  );
  const openSource = async () => {
    if (!event.sourceUrl || !/^https:\/\//i.test(event.sourceUrl)) {
      app.showToast("확인된 공식 출처 링크가 없어요.");
      return;
    }
    try {
      await Linking.openURL(event.sourceUrl);
    } catch {
      app.showToast("출처 링크를 열지 못했어요. 다시 시도해 주세요.");
    }
  };
  return (
    <Screen
      title="행사 상세"
      footer={
        <Button
          disabled={ended}
          onPress={() =>
            app.navigate(
              app.member ? "S03" : "S05",
              app.member ? `event:${id}` : undefined,
            )
          }
          icon="add"
        >
          {ended ? "종료한 행사예요" : "이 행사로 동행 모집하기"}
        </Button>
      }
    >
      <Artwork name={event.image} height={220} style={{ borderRadius: 20 }} />
      <Row>
        <Badge>{event.category}</Badge>
        <Badge tone={ended ? "gray" : "green"}>
          {ended ? "종료" : event.startsAt <= app.now ? "진행 중" : "예정"}
        </Badge>
      </Row>
      <Title large>{event.title}</Title>
      <Card>
        <InfoLine
          icon="calendar-outline"
          label="행사 기간"
          value={`${dateLabel(event.startsAt)}–${dateLabel(event.endsAt)}`}
        />
        <InfoLine
          icon="location-outline"
          label="장소"
          value={`${event.placeName} · ${event.publicArea}`}
        />
        <InfoLine icon="ticket-outline" label="입장 안내" value={event.price} />
      </Card>
      <Section title="행사 안내">
        <Body>{event.description}</Body>
        <Card style={{ padding: 14, backgroundColor: colors.lavender }}>
          <Body small muted>
            운영 일정·예약·입장 비용은 방문 전 공식 출처에서 확인해 주세요.
            동행은 무료 1:1이며 개인 비용은 별도로 확인해요.
          </Body>
          <Row between>
            <Body small>출처 · {event.sourceName}</Body>
            <TextButton
              onPress={() => {
                void openSource();
              }}
            >
              공식 출처 보기 ↗
            </TextButton>
          </Row>
        </Card>
      </Section>
      <Section title={`연결된 동행 공고 (${posts.length})`}>
        {posts.length ? (
          <View style={{ gap: 14 }}>
            {posts.slice(0, limit).map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
            {limit < posts.length && (
              <Button secondary onPress={() => setLimit((n) => n + 10)}>
                공고 10개 더 보기
              </Button>
            )}
          </View>
        ) : (
          <Empty
            title="아직 연결된 공고가 없어요"
            description={
              ended
                ? "종료한 행사는 새로 모집할 수 없어요."
                : "이 행사에 함께할 동행을 직접 모집해 보세요."
            }
          />
        )}
      </Section>
    </Screen>
  );
}

type PostWithWishes = Post & {
  desiredAgeMin?: string;
  desiredAgeMax?: string;
  wishes?: string;
};
export function PostDetailScreen({ id }: { id: string }) { return serviceMode ? <RemotePostDetail id={id} /> : <PreviewPostDetail id={id} />; }
function PreviewPostDetail({ id }: { id: string }) {
  const app = useApp();
  const post = app.posts.find((p) => p.id === id) as PostWithWishes | undefined;
  const [confirm, setConfirm] = useState<"delete" | "edit" | "close" | null>(
    null,
  );
  const [selectedApplicant, setSelectedApplicant] = useState<string | null>(
    null,
  );
  const [rejectingApplicant, setRejectingApplicant] = useState<string | null>(
    null,
  );
  if (!post || post.status === "deleted")
    return (
      <Screen title="공고 상세">
        <Empty
          title="삭제되었거나 없는 공고예요"
          description="기존 대화 기록은 채팅에서 확인할 수 있어요."
          action="둘러보기"
          onPress={() => app.navigate("S01")}
        />
      </Screen>
    );
  const owner = app.viewerId === post.authorId;
  const appointment = app.appointments.find(
    (a) =>
      a.postId === id &&
      ["confirmed", "completed", "disputed"].includes(a.status),
  );
  const participant = Boolean(
    appointment &&
    app.viewerId &&
    (appointment.hostId === app.viewerId ||
      appointment.applicantId === app.viewerId),
  );
  const conversation = app.conversations.find(
    (c) => c.postId === id && c.applicantId === app.viewerId,
  );
  const applicants = app.conversations.filter(
    (c) =>
      c.postId === id &&
      c.messages.length > 0 &&
      ["active", "confirmed"].includes(c.status),
  );
  const event = app.events.find((e) => e.id === post.eventId);
  const rejected = conversation?.status === "rejected";
  const cooldown =
    conversation?.withdrawnAt && conversation.status === "withdrawn"
      ? Math.max(
          0,
          Math.ceil((conversation.withdrawnAt + 60000 - app.now) / 1000),
        )
      : 0;
  const ageMismatch = Boolean(
    app.member &&
    ((post.desiredAgeMin && app.member.age < Number(post.desiredAgeMin)) ||
      (post.desiredAgeMax && app.member.age > Number(post.desiredAgeMax))),
  );
  const unavailable =
    post.status !== "recruiting" ||
    post.deadlineAt <= app.now ||
    post.startsAt <= app.now ||
    rejected ||
    cooldown > 0 ||
    ageMismatch ||
    app.blockedIds.includes(post.authorId);
  const existingChat =
    conversation && ["active", "confirmed"].includes(conversation.status);
  const applyLabel = !app.member
    ? "로그인 후 동행 신청하기"
    : existingChat
      ? "기존 채팅으로 이동"
      : rejected
        ? "거절된 공고는 재신청할 수 없어요"
        : cooldown > 0
          ? `${cooldown}초 후 재신청할 수 있어요`
          : ageMismatch
            ? "공고의 희망 나이 조건과 달라요"
            : unavailable
              ? statusLabelSafe(post, app.now)
              : "동행 신청하기";
  const footer = owner ? (
    <Row>
      <Button
        secondary
        onPress={() => setConfirm("edit")}
        disabled={Boolean(appointment)}
        style={{ flex: 1 }}
      >
        수정
      </Button>
      {post.status === "closed" ? (
        <Button
          onPress={() => {
            feedback(app, app.reopenPost(id), "모집을 다시 열었어요.");
          }}
          style={{ flex: 2 }}
        >
          모집 다시 열기
        </Button>
      ) : (
        <Button
          onPress={() => setConfirm("close")}
          disabled={Boolean(appointment)}
          style={{ flex: 2 }}
        >
          모집 마감하기
        </Button>
      )}
    </Row>
  ) : participant && appointment ? (
    <Button onPress={() => app.navigate("S16", appointment.id)}>
      확정 약속 상세 보기
    </Button>
  ) : (
    <Button
      disabled={Boolean(app.member && unavailable && !existingChat)}
      onPress={() =>
        app.navigate(
          app.member ? "S11" : "S05",
          app.member ? (existingChat ? conversation.id : id) : undefined,
        )
      }
      icon="arrow-forward"
    >
      {applyLabel}
    </Button>
  );
  return (
    <Screen title="동행 공고" footer={footer}>
      <Row between>
        <Row>
          <Badge>{post.category}</Badge>
          <Badge tone={post.status === "recruiting" ? "green" : "gray"}>
            {statusLabelSafe(post, app.now)}
          </Badge>
        </Row>
        <Body small muted>
          무료 1:1 동행
        </Body>
      </Row>
      <Title large style={{ fontSize: 25, lineHeight: 35 }}>
        {post.title}
      </Title>
      <MemberBox memberId={post.authorId} confirmed={participant} />
      <Section title="동행 조건">
        <Card>
          <InfoLine
            icon="calendar-outline"
            label="일정"
            value={rangeLabel(post.startsAt, post.endsAt)}
          />
          <InfoLine
            icon="location-outline"
            label={
              participant || owner ? "공개 지역" : "안내 지역 · 동까지 공개"
            }
            value={post.publicArea}
          />
          <InfoLine
            icon="people-outline"
            label="함께할 분"
            value={
              post.desiredAgeMin || post.desiredAgeMax
                ? `여성 · 만 ${post.desiredAgeMin || 19}~${post.desiredAgeMax || 99}세`
                : "여성 · 성인 전체"
            }
          />
          <InfoLine
            icon="time-outline"
            label="모집 마감"
            value={`${dateLabel(post.deadlineAt)} ${timeLabel(post.deadlineAt)}`}
          />
          {participant && (
            <>
              <Divider />
              <InfoLine
                icon="lock-open-outline"
                label="확정 당사자 만남 장소"
                value={`${post.placeName}\n${post.address}${post.meetingPoint ? `\n${post.meetingPoint}` : ""}`}
              />
            </>
          )}
        </Card>
        {!participant && (
          <Body small muted>
            정확한 주소와 상세 만남 지점은 확정 당사자에게만 보여요.
          </Body>
        )}
      </Section>
      <Section title="동행 소개">
        <Body style={{ lineHeight: 25 }}>{post.introduction}</Body>
        {post.wishes ? (
          <Card style={{ backgroundColor: colors.lavender }}>
            <Body small style={{ fontWeight: "700", color: colors.primary }}>
              함께할 분에게 바라는 점
            </Body>
            <Body>{post.wishes}</Body>
          </Card>
        ) : null}
      </Section>
      {event && (
        <Section title="연결된 문화 행사">
          <Card
            onPress={() => app.navigate("S09-3", event.id)}
            style={{ padding: 14 }}
          >
            <Row>
              <View style={{ width: 67 }}>
                <Artwork
                  name={event.image}
                  height={67}
                  style={{ borderRadius: 10 }}
                />
              </View>
              <View style={{ flex: 1, gap: 5 }}>
                <Body style={{ fontWeight: "700" }}>{event.title}</Body>
                <Body small muted>
                  {dateLabel(event.startsAt)}–{dateLabel(event.endsAt)}
                </Body>
              </View>
              <Icon name="chevron-forward" color={colors.primary} size={18} />
            </Row>
          </Card>
        </Section>
      )}
      {owner && (
        <Section title={`신청자 (${applicants.length})`}>
          {applicants.length ? (
            applicants.map((c) => (
              <Card key={c.id}>
                <MemberBox
                  memberId={c.applicantId}
                  compact
                  confirmed={participant && c.status === "confirmed"}
                />
                <Body small muted>
                  {c.requestAt &&
                  c.requestExpiresAt &&
                  c.requestExpiresAt > app.now
                    ? `최종 동의 대기 · ${dateLabel(c.requestExpiresAt)} ${timeLabel(c.requestExpiresAt)}까지`
                    : c.status === "confirmed"
                      ? "동행이 확정된 상대예요."
                      : "첫 메시지를 보내 신청한 상대예요."}
                </Body>
                <Row>
                  <Button
                    secondary
                    onPress={() => app.navigate("S11", c.id)}
                    style={{ flex: 1 }}
                  >
                    채팅 보기
                  </Button>
                  <Button
                    disabled={Boolean(appointment) || post.startsAt <= app.now}
                    onPress={() => setSelectedApplicant(c.id)}
                    style={{ flex: 1 }}
                  >
                    상대 선택
                  </Button>
                </Row>
                {!appointment && (
                  <TextButton
                    color={colors.red}
                    onPress={() => setRejectingApplicant(c.id)}
                  >
                    신청 거절
                  </TextButton>
                )}
              </Card>
            ))
          ) : (
            <Card>
              <Body muted>아직 첫 메시지를 보낸 신청자가 없어요.</Body>
            </Card>
          )}
          {!appointment && (
            <TextButton color={colors.red} onPress={() => setConfirm("delete")}>
              공고 삭제
            </TextButton>
          )}
        </Section>
      )}
      {!owner && !existingChat && (
        <Card style={{ backgroundColor: colors.lavender, padding: 14 }}>
          <Row>
            <Icon
              name="chatbubble-ellipses-outline"
              size={22}
              color={colors.primary}
            />
            <Body small style={{ flex: 1, color: colors.primary }}>
              신청 버튼으로 채팅을 열고 첫 메시지를 성공적으로 보내면 신청이
              성립해요.
            </Body>
          </Row>
        </Card>
      )}
      {confirm && (
        <ConfirmCard
          title={
            confirm === "delete"
              ? "공고를 삭제할까요?"
              : confirm === "edit"
                ? "공고 조건을 수정할까요?"
                : "새 신청을 마감할까요?"
          }
          description={
            confirm === "delete"
              ? "공개 목록에서 숨기고 미확정 요청을 종료해요. 기존 대화는 읽기 전용으로 보존돼요."
              : confirm === "edit"
                ? "핵심 조건이 바뀌면 신청자에게 알리고 기존 최종 동의를 무효화해요. 새 조건으로 다시 동의받아야 해요."
                : "새 신청을 막고 기존 신청자와의 대화는 유지해요. 시작 전에는 기존 신청자에게 최종 동의를 요청할 수 있어요."
          }
          confirm={
            confirm === "delete"
              ? "삭제하기"
              : confirm === "edit"
                ? "수정하기"
                : "마감하기"
          }
          danger={confirm === "delete"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const action = confirm;
            setConfirm(null);
            if (action === "edit") app.editPost(id);
            else
              feedback(
                app,
                action === "delete" ? app.deletePost(id) : app.closePost(id),
                action === "delete"
                  ? "공고를 삭제했어요."
                  : "새 신청을 마감했어요.",
              );
          }}
        />
      )}
      {rejectingApplicant && (
        <ConfirmCard
          title="이 신청을 거절할까요?"
          description="거절한 상대는 이 공고에 다시 신청할 수 없어요. 기존 대화 기록은 보존돼요."
          confirm="신청 거절"
          danger
          onCancel={() => setRejectingApplicant(null)}
          onConfirm={() => {
            const selected = rejectingApplicant;
            setRejectingApplicant(null);
            feedback(app, app.rejectApplicant(selected), "신청을 거절했어요.");
          }}
        />
      )}
      {selectedApplicant && (
        <ConfirmCard
          title="이 상대에게 최종 동의를 요청할까요?"
          description="대화로 일정과 장소를 합의했는지 확인해 주세요. 요청 후 6시간과 시작 시각 중 빠른 때까지 상대가 수락하면 확정돼요. 다른 신청자와의 대화는 유지돼요."
          confirm="최종 동의 요청"
          onCancel={() => setSelectedApplicant(null)}
          onConfirm={() => {
            const selected = selectedApplicant;
            setSelectedApplicant(null);
            if (
              feedback(
                app,
                app.requestMatch(selected),
                "최종 동의를 요청했어요.",
              )
            )
              app.navigate("S11", selected);
          }}
        />
      )}
    </Screen>
  );
}
function statusLabelSafe(post: Post, now: number) {
  if (post.status === "recruiting" && post.deadlineAt <= now)
    return "모집 마감";
  return {
    recruiting: "모집 중",
    closed: "모집 마감",
    awaiting_consent: "최종 동의 대기",
    confirmed: "동행 확정",
    completed: "동행 완료",
    deleted: "삭제된 공고",
  }[post.status];
}

const PREVIEW_PLACES = [
  {
    placeName: "국립현대미술관 서울",
    address: "서울 종로구 삼청로 30",
    publicArea: "서울 종로구 소격동",
    postal: "03062",
  },
  {
    placeName: "서울숲",
    address: "서울 성동구 뚝섬로 273",
    publicArea: "서울 성동구 성수동1가",
    postal: "04770",
  },
  {
    placeName: "예술의전당",
    address: "서울 서초구 남부순환로 2406",
    publicArea: "서울 서초구 서초동",
    postal: "06757",
  },
  {
    placeName: "혜화역",
    address: "서울 종로구 대학로 120",
    publicArea: "서울 종로구 명륜4가",
    postal: "03086",
  },
];
export function CreateScreen({ id }: { id?: string }) {
  if (serviceMode && id?.startsWith("edit:")) return <RemotePostEditor id={id.slice(5)} />;
  return <CreateForm key={`${id || "new"}:${serviceMode ? serviceSessionEpoch() : "preview"}`} id={id} />;
}
function CreateForm({ id }: { id?: string }) {
  const app = useApp();
  const serviceSession = useServiceSession();
  const [eventOpen, setEventOpen] = useState(false);
  const [liveEvent, setLiveEvent] = useState<{ id: string; title: string; placeName: string | null } | null>(null);
  const eventId = id?.startsWith("event:") ? id.slice(6) : undefined;
  const category = id?.startsWith("category:") ? id.slice(9) : "";
  const continuing = id === "resume" || Boolean(eventId);
  const [draft, setDraft] = useState<Draft>(() => ({
    ...(continuing && app.draft && (!serviceMode || app.draft.serviceDraftEpoch === serviceSession.epoch) ? app.draft : blankDraft(category)),
    ...(eventId ? { eventId } : {}),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [restore, setRestore] = useState(
    Boolean(
      !continuing && app.draft && (!serviceMode || app.draft.serviceDraftEpoch === serviceSession.epoch) && app.now - app.draft.updatedAt < 7 * DAY,
    ),
  );
  const [exit, setExit] = useState(false);
  const [overwrite, setOverwrite] = useState<
    null | "save" | "next" | "event" | "exit"
  >(null);
  const [placeOpen, setPlaceOpen] = useState(false);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeMode, setPlaceMode] = useState<"장소명" | "주소">("장소명");
  const [restoredDraft, setRestoredDraft] = useState(continuing);
  const [saving, setSaving] = useState(false);
  const event = serviceMode ? (liveEvent?.id === draft.eventId ? liveEvent : undefined) : app.events.find((e) => e.id === draft.eventId);
  const change = (patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setErrors({});
  };
  const saveThen = async (
    action: "save" | "next" | "event" | "exit",
    force = false,
  ) => {
    if (
      !force &&
      !restoredDraft &&
      app.draft &&
      app.now - app.draft.updatedAt < 7 * DAY
    ) {
      setOverwrite(action);
      return;
    }
    setSaving(true);
    try {
      await app.saveDraft({ ...draft, updatedAt: app.now, ...(serviceMode ? { serviceDraftEpoch: serviceSession.epoch } : {}) });
      setRestoredDraft(true);
      if (action === "next") app.navigate("S04");
      else if (action === "event") app.navigate("S09-2", "select");
      else if (action === "exit") app.back();
      else
        app.showToast(
          "이 기기에 초안을 임시저장했어요. 마지막 수정 후 7일간 보관해요.",
        );
    } catch {
      app.showToast("임시저장하지 못했어요. 작성 내용은 화면에 남아 있어요.");
    } finally {
      setSaving(false);
    }
  };
  const next = () => {
    const nextErrors = validateDraft(draft, app.now);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length)
      app.showToast("입력 내용을 확인해 주세요.");
    else void saveThen("next");
  };
  const places = PREVIEW_PLACES.filter((p) =>
    `${placeMode === "장소명" ? p.placeName : p.address} ${p.postal}`.includes(
      placeQuery.trim(),
    ),
  );
  if (serviceMode ? !serviceSession.authenticated : !app.member)
    return (
      <Screen title="동행 모집">
        <Empty
          title="로그인 후 공고를 작성해요"
          action="네이버로 로그인"
          onPress={() => app.navigate("S05")}
        />
      </Screen>
    );
  return (
    <Screen
      title="동행 모집"
      back={false}
      right={
        <Row>
          <Badge>1 / 2</Badge>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="작성 나가기"
            onPress={() => setExit(true)}
            style={styles.iconTap}
          >
            <Icon name="close-outline" />
          </Pressable>
        </Row>
      }
      footer={
        <Button loading={saving} onPress={next} icon="arrow-forward">
          다음 · 등록 전 확인
        </Button>
      }
    >
      <View style={styles.stepTrack}>
        <View style={[styles.stepFill, { width: "50%" }]} />
      </View>
      {restoredDraft && app.draft && (
        <Card style={{ padding: 14, backgroundColor: colors.lavender }}>
          <Body small style={{ color: colors.primary }}>
            작성 중인 초안을 이어서 보고 있어요.
          </Body>
          <Body small muted>
            만료 · {dateLabel(app.draft.updatedAt + 7 * DAY)}{" "}
            {timeLabel(app.draft.updatedAt + 7 * DAY)}
          </Body>
        </Card>
      )}
      <Section title="활동 카테고리 *">
        <View style={styles.wrap}>
          {CATEGORIES.map((v) => (
            <Chip
              key={v}
              selected={draft.category === v}
              onPress={() => change({ category: v })}
            >
              {v}
            </Chip>
          ))}
        </View>
        {errors.category && (
          <Body small style={{ color: colors.red }}>
            {errors.category}
          </Body>
        )}
      </Section>
      <Field
        label="공고 제목 *"
        value={draft.title}
        onChangeText={(title) => change({ title })}
        placeholder="어떤 동행을 함께하고 싶으신가요?"
        maxLength={50}
        error={errors.title}
        hint={`${draft.title.length}/50자`}
      />
      <Field
        label="동행 소개 *"
        value={draft.introduction}
        onChangeText={(introduction) => change({ introduction })}
        placeholder="활동과 원하는 분위기를 소개해 주세요."
        multiline
        maxLength={2000}
        error={errors.introduction}
        hint={`${draft.introduction.length}/2,000자 · 연락처·계좌·상세 위치는 적지 마세요.`}
      />
      <Card style={{ backgroundColor: colors.lavender, padding: 14 }}>
        <Row>
          <Icon name="heart-outline" color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Body small style={{ color: colors.primary, fontWeight: "700" }}>
              서로 존중하는 무료 1:1 동행
            </Body>
            <Body small muted>
              개인 티켓·음료 비용은 각자 확인해 주세요.
            </Body>
          </View>
        </Row>
      </Card>
      <Section title="일정 설정 *">
        <Field
          label="시작 일시"
          value={draft.startsAt}
          onChangeText={(startsAt) => change({ startsAt })}
          placeholder={`${localInput(app.now + DAY).slice(0, 10)}T14:00`}
          error={errors.startsAt}
          hint="한국시간 · YYYY-MM-DDTHH:mm"
        />
        <Field
          label="예상 종료 일시"
          value={draft.endsAt}
          onChangeText={(endsAt) => change({ endsAt })}
          placeholder={`${localInput(app.now + DAY).slice(0, 10)}T16:00`}
          error={errors.endsAt}
        />
        <Field
          label="모집 마감 일시 (선택)"
          value={draft.deadlineAt}
          onChangeText={(deadlineAt) => change({ deadlineAt })}
          placeholder="비워두면 동행 시작 시각에 마감"
          error={errors.deadlineAt}
        />
        <Card style={{ padding: 12 }}>
          <Row>
            <Icon name="time-outline" color={colors.primary} size={17} />
            <Body small muted>
              미입력 시 동행 시작 시각에 자동 마감해요.
            </Body>
          </Row>
        </Card>
      </Section>
      <Section title="만남 장소 *">
        <Button
          secondary
          icon="search-outline"
          onPress={() => {
            setPlaceQuery("");
            setPlaceOpen(true);
          }}
        >
          {draft.placeName
            ? "장소 다시 선택하기"
            : "장소명 또는 주소로 찾아보기"}
        </Button>
        {draft.placeName && (
          <Card style={{ backgroundColor: colors.lavender }}>
            <Row between>
              <Body style={{ fontWeight: "700" }}>{draft.placeName}</Body>
              <Badge>선택됨</Badge>
            </Row>
            <Body small muted>
              {draft.address}
            </Body>
            <Body small style={{ color: colors.primary }}>
              공개 지역 · {draft.publicArea}
            </Body>
          </Card>
        )}
        {errors.placeName && (
          <Body small style={{ color: colors.red }}>
            {errors.placeName}
          </Body>
        )}
        <Field
          label="상세 만남 지점 (선택)"
          value={draft.meetingPoint}
          onChangeText={(meetingPoint) => change({ meetingPoint })}
          placeholder="예: 정문 입구에서 만나요"
          multiline
          maxLength={300}
          error={errors.meetingPoint}
          hint={`${draft.meetingPoint.length}/300자`}
        />
        <Row style={{ alignItems: "flex-start" }}>
          <Icon
            name="shield-checkmark-outline"
            color={colors.primary}
            size={17}
          />
          <Body small muted style={{ flex: 1 }}>
            공개 지역은 동까지, 정확한 주소와 상세 지점은 확정 당사자에게만
            보여요.
          </Body>
        </Row>
      </Section>
      <Modal visible={eventOpen} transparent animationType="slide" onRequestClose={() => setEventOpen(false)}><View style={styles.sheetOverlay}><View style={styles.filterSheet}><ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}><Title>연결할 행사 선택</Title><TextButton onPress={() => setEventOpen(false)}>행사 선택 닫기</TextButton><RemoteEventPicker startsAt={draft.startsAt} endsAt={draft.endsAt} onSelect={(selected) => { setLiveEvent(selected); change({ eventId: selected.id }); setEventOpen(false); }} /></ScrollView></View></View></Modal>
      <Section title="연결 문화 행사 (선택)">
        {event ? (
          <Card style={{ backgroundColor: colors.lavender }}>
            <Row>
              <Icon name="ticket-outline" color={colors.primary} />
              <Body style={{ flex: 1, fontWeight: "600" }}>{event.title}</Body>
            </Row>
            <Row between>
              <TextButton
                onPress={() => {
                  if (serviceMode) setEventOpen(true); else void saveThen("event");
                }}
              >
                행사 변경
              </TextButton>
              <TextButton onPress={() => change({ eventId: undefined })}>
                연결 해제
              </TextButton>
            </Row>
          </Card>
        ) : (
          <Button
            secondary
            icon="ticket-outline"
            onPress={() => {
              if (serviceMode) setEventOpen(true); else void saveThen("event");
            }}
          >
            연결할 행사 선택하기
          </Button>
        )}
        {serviceMode && liveEvent?.placeName && <TextButton onPress={() => { setPlaceQuery(liveEvent.placeName!); setPlaceOpen(true); }}>행사장을 장소 후보로 찾기</TextButton>}
        <Body small muted>
          행사 선택은 작성 중인 동행 일정을 바꾸지 않아요.
        </Body>
      </Section>
      {errors.personalInfo && (
        <Card style={{ borderColor: "#F2CBD3", backgroundColor: colors.pink }}>
          <Body small style={{ color: colors.red }}>
            {errors.personalInfo}
          </Body>
          <TextButton
            color={colors.red}
            onPress={() => app.navigate("S21", "개인정보 감지 오탐 문의")}
          >
            오탐 문의하기
          </TextButton>
        </Card>
      )}
      <TextButton
        onPress={() => {
          void saveThen("save");
        }}
      >
        작성 중인 내용 임시저장
      </TextButton>
      {restore && app.draft && (
        <ConfirmCard
          title="작성 중이던 공고가 있어요"
          description={`마지막 수정 후 7일간 보관해요. 만료 시각은 ${dateLabel(app.draft.updatedAt + 7 * DAY)} ${timeLabel(app.draft.updatedAt + 7 * DAY)}예요. 이어서 작성할까요?`}
          confirm="불러오기"
          cancel="새로 작성"
          onConfirm={() => {
            setDraft(app.draft!);
            setRestore(false);
            setRestoredDraft(true);
          }}
          onCancel={() => {
            setRestore(false);
          }}
        />
      )}
      {overwrite && (
        <ConfirmCard
          title="저장된 초안을 대체할까요?"
          description="이 기기에는 최근 초안 1개만 저장해요. 새 내용으로 저장하면 이전 초안을 불러올 수 없어요."
          confirm="새 초안으로 저장"
          onCancel={() => setOverwrite(null)}
          onConfirm={() => {
            const action = overwrite;
            setOverwrite(null);
            void saveThen(action, true);
          }}
        />
      )}
      {exit && (
        <ConfirmCard
          title="작성을 나갈까요?"
          description="작성 중인 내용을 이 기기에 임시저장해요. 마지막 수정 후 7일간 보관하고, 등록 성공·로그아웃 시 삭제해요."
          confirm="저장하고 나가기"
          cancel="계속 작성"
          onCancel={() => setExit(false)}
          onConfirm={() => {
            setExit(false);
            void saveThen("exit");
          }}
        />
      )}
      <Modal
        visible={placeOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPlaceOpen(false)}
      >
        <View style={styles.sheetOverlay}>
          <View style={styles.filterSheet}>
            <View style={styles.handle} />
            <Row between style={{ paddingHorizontal: 22 }}>
              <Title>만남 장소 선택</Title>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="장소 선택 닫기"
                onPress={() => setPlaceOpen(false)}
                style={styles.iconTap}
              >
                <Icon name="close-outline" />
              </Pressable>
            </Row>
            <ScrollView
              contentContainerStyle={{ padding: 22, gap: 16 }}
              keyboardShouldPersistTaps="handled"
            >
              {serviceMode ? <RemotePlacePicker initialQuery={placeQuery} onSelect={(selected) => { change({ placeName: selected.placeName, address: selected.address, publicArea: selected.publicArea }); setPlaceOpen(false); }} onCancel={() => setPlaceOpen(false)} /> : <>
              <Badge tone="gray">프로토타입 장소 목록</Badge>
              <Body small muted>
                외부 장소 검색은 연결되지 않았어요. 준비된 장소를 선택해 작성
                동작을 확인할 수 있어요.
              </Body>
              <Row>
                {(["장소명", "주소"] as const).map((v) => (
                  <Chip
                    key={v}
                    selected={placeMode === v}
                    onPress={() => {
                      setPlaceMode(v);
                      setPlaceQuery("");
                    }}
                  >
                    {v} 검색
                  </Chip>
                ))}
              </Row>
              <Field
                label={`${placeMode} 검색`}
                placeholder={
                  placeMode === "장소명"
                    ? "미술관, 서울숲, 예술의전당, 혜화역"
                    : "주소 또는 우편번호 입력"
                }
                value={placeQuery}
                onChangeText={setPlaceQuery}
              />
              {places.length ? (
                places.map((place) => (
                  <Card
                    key={place.address}
                    onPress={() => {
                      change({
                        placeName: place.placeName,
                        address: place.address,
                        publicArea: place.publicArea,
                      });
                      setPlaceOpen(false);
                    }}
                  >
                    <Row between>
                      <Body style={{ fontWeight: "700" }}>
                        {place.placeName}
                      </Body>
                      <Icon
                        name="chevron-forward"
                        color={colors.primary}
                        size={17}
                      />
                    </Row>
                    <Body small muted>
                      {place.address} · {place.postal}
                    </Body>
                    <Body small style={{ color: colors.primary }}>
                      공개 지역 · {place.publicArea}
                    </Body>
                  </Card>
                ))
              ) : (
                <Empty
                  title="준비된 장소가 없어요"
                  description="검색어를 지우거나 다른 이름으로 찾아보세요."
                  action="검색어 지우기"
                  onPress={() => setPlaceQuery("")}
                />
              )}</>}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

export function PublishScreen() {
  const session = useServiceSession();
  return <PublishForm key={serviceMode ? session.epoch : "preview"} />;
}
function PublishForm() {
  const app = useApp();
  const action = useMemberAction();
  const session = useServiceSession();
  const attempt = useRef<{ fingerprint: string; postId: string } | null>(null);
  const [draft, setDraft] = useState<Draft>(() => app.draft || blankDraft());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [checked, setChecked] = useState(false);
  const [leave, setLeave] = useState(false);
  const event = app.events.find((e) => e.id === draft.eventId);
  const change = (patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setErrors({});
  };
  const edit = async () => {
    await app.saveDraft({ ...draft, updatedAt: app.now });
    app.navigate("S03", "resume");
  };
  const submit = () => {
    const nextErrors = validateDraft(draft, app.now);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      app.showToast("입력 내용을 확인해 주세요.");
      return;
    }
    if (!checked) {
      app.showToast("등록 정보와 공개 범위를 확인해 주세요.");
      return;
    }
    if (serviceMode) {
      if (!session.authenticated || draft.serviceDraftEpoch !== session.epoch) { app.showToast("이 계정에서 작성한 초안으로 다시 시작해 주세요."); return; }
      const input = {
        title: draft.title.trim(), description: draft.introduction.trim(), category: draft.category,
        startsAt: new Date(parseDateInput(draft.startsAt)).toISOString(), endsAt: new Date(parseDateInput(draft.endsAt)).toISOString(),
        recruitmentEndsAt: new Date(parseDateInput(draft.deadlineAt || draft.startsAt)).toISOString(),
        publicArea: draft.publicArea, registeredPlaceName: draft.placeName || null, registeredAddress: draft.address,
        meetingDetail: draft.meetingPoint, preferenceNote: [draft.wishes, draft.desiredAgeMin && draft.desiredAgeMax ? `희망 나이: 만 ${draft.desiredAgeMin}~${draft.desiredAgeMax}세` : ""].filter(Boolean).join(" · ") || null,
        tags: [], costType: "free" as const, amount: 0 as const, ...(draft.eventId ? { eventId: draft.eventId } : {}),
      };
      const fingerprint = JSON.stringify(input);
      if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, postId: Crypto.randomUUID() };
      const postId = attempt.current.postId;
      void action.run((s, signal) => s.create(postId, input, signal), () => { app.showToast("공고를 등록했어요."); app.navigate("S02", postId); });
      return;
    }
    setSubmitting(true);
    const result = app.publish(draft);
    if (feedback(app, result) && result.id) app.navigate("S02", result.id);
    setSubmitting(false);
  };
  if (!app.draft || (serviceMode && (!session.authenticated || draft.serviceDraftEpoch !== session.epoch)))
    return (
      <Screen title="등록 전 확인">
        <Empty
          title="작성 중인 공고가 없어요"
          action="공고 작성하기"
          onPress={() => app.navigate(app.member ? "S03" : "S05")}
        />
      </Screen>
    );
  const start = parseDateInput(draft.startsAt),
    end = parseDateInput(draft.endsAt),
    deadline = parseDateInput(draft.deadlineAt || draft.startsAt);
  const ageOptions = [
    { label: "성인 전체", min: "", max: "" },
    { label: "20대", min: "20", max: "29" },
    { label: "30대", min: "30", max: "39" },
    { label: "40대 이상", min: "40", max: "99" },
  ];
  return (
    <Screen
      title="등록 전 확인"
      back={false}
      right={
        <Row>
          <Badge>2 / 2</Badge>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="등록 확인 나가기"
            onPress={() => setLeave(true)}
            style={styles.iconTap}
          >
            <Icon name="close-outline" />
          </Pressable>
        </Row>
      }
      footer={
        <Row>
          <Button
            secondary
            onPress={() => {
              void edit();
            }}
            style={{ flex: 1 }}
          >
            수정하기
          </Button>
          <Button
            loading={submitting || action.busy}
            onPress={submit}
            disabled={!checked}
            style={{ flex: 2 }}
            icon="checkmark-outline"
          >
            공고 등록하기
          </Button>
        </Row>
      }
    >
      <View style={styles.stepTrack}>
        <View style={[styles.stepFill, { width: "100%" }]} />
      </View>
      <Title>{"입력하신 공고를\n최종 점검해 주세요"}</Title>
      {serviceMode && action.error && <Body style={{ color: colors.red }}>{action.error}</Body>}
      <Body muted>함께할 상대와 공개 범위를 확인해 주세요.</Body>
      <Section title="함께할 분의 희망 나이 (선택)">
        <View style={styles.wrap}>
          {ageOptions.map((o) => (
            <Chip
              key={o.label}
              selected={
                draft.desiredAgeMin === o.min && draft.desiredAgeMax === o.max
              }
              onPress={() =>
                change({ desiredAgeMin: o.min, desiredAgeMax: o.max })
              }
            >
              {o.label}
            </Chip>
          ))}
        </View>
        <Row>
          <View style={{ flex: 1 }}>
            <Field
              label="최소 만 나이"
              keyboardType="number-pad"
              value={draft.desiredAgeMin}
              onChangeText={(desiredAgeMin) => change({ desiredAgeMin })}
              placeholder="전체"
              error={errors.desiredAgeMin}
            />
          </View>
          <Body muted>~</Body>
          <View style={{ flex: 1 }}>
            <Field
              label="최대 만 나이"
              keyboardType="number-pad"
              value={draft.desiredAgeMax}
              onChangeText={(desiredAgeMax) => change({ desiredAgeMax })}
              placeholder="전체"
            />
          </View>
        </Row>
        <Body small muted>
          선택하지 않으면 성인 전체로 모집해요.
        </Body>
      </Section>
      <Field
        label="함께할 분에게 바라는 점 (선택)"
        multiline
        value={draft.wishes}
        onChangeText={(wishes) => change({ wishes })}
        placeholder="예: 조용히 감상하고, 관람 후 편하게 이야기해요."
      />
      <Section title="피드에 등록될 카드 미리보기">
        <Card>
          <Row between>
            <Row>
              <Badge>{draft.category}</Badge>
              <Badge tone="green">모집 중</Badge>
            </Row>
            <Body small muted>
              무료 1:1
            </Body>
          </Row>
          <Title>{draft.title}</Title>
          <InfoLine
            icon="calendar-outline"
            label="일정"
            value={
              Number.isFinite(start) && Number.isFinite(end)
                ? rangeLabel(start, end)
                : "일정을 확인해 주세요"
            }
          />
          <InfoLine
            icon="location-outline"
            label="공개 지역"
            value={draft.publicArea}
          />
          <Body>{draft.introduction}</Body>
          {event && <Badge>연결 행사 · {event.title}</Badge>}
          <Divider />
          {app.member && <MemberBox memberId={app.member.id} compact />}
        </Card>
      </Section>
      <Card style={{ backgroundColor: colors.lavender }}>
        <Row>
          <Icon name="shield-checkmark-outline" color={colors.primary} />
          <Body style={{ fontWeight: "700", color: colors.primary }}>
            안심 규칙 및 정보 공개 안내
          </Body>
        </Row>
        <Body small>
          모집 마감 ·{" "}
          {Number.isFinite(deadline)
            ? `${dateLabel(deadline)} ${timeLabel(deadline)}`
            : "일정 확인 필요"}
          {!draft.deadlineAt ? " (동행 시작 시각)" : ""}
        </Body>
        <Body small>
          공개 지역은 {draft.publicArea || "선택한 동"}까지예요. 정확한 주소와
          상세 만남 지점은 양쪽 최종 동의로 확정된 후 당사자에게만 보여요.
        </Body>
        <Body small>
          무료 1:1 동행으로 모집해요. 개인 티켓·음료 비용은 각자 확인해요.
        </Body>
      </Card>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        onPress={() => setChecked((v) => !v)}
        style={styles.checkRow}
      >
        <View
          style={[
            styles.checkbox,
            checked && {
              backgroundColor: colors.primary,
              borderColor: colors.primary,
            },
          ]}
        >
          {checked && <Icon name="checkmark" color="#fff" size={17} />}
        </View>
        <Body style={{ flex: 1 }}>등록 정보와 공개 범위를 확인했어요.</Body>
      </Pressable>
      {Object.keys(errors).length > 0 && (
        <Card style={{ backgroundColor: colors.pink, borderColor: "#F2CBD3" }}>
          {Object.entries(errors).map(([key, message]) => (
            <Body key={key} small style={{ color: colors.red }}>
              {message}
            </Body>
          ))}
          {errors.personalInfo && (
            <TextButton
              color={colors.red}
              onPress={() => app.navigate("S21", "개인정보 감지 오탐 문의")}
            >
              오탐 문의하기
            </TextButton>
          )}
          <TextButton
            onPress={() => {
              void edit();
            }}
          >
            기본 정보 수정하기
          </TextButton>
        </Card>
      )}
      {leave && (
        <ConfirmCard
          title="등록 전에 나갈까요?"
          description="지금까지 작성한 내용은 이 기기에 임시저장해요. 마지막 수정 후 7일간 보관해요."
          confirm="저장하고 나가기"
          cancel="계속 확인"
          onCancel={() => setLeave(false)}
          onConfirm={() => {
            setLeave(false);
            void app
              .saveDraft({ ...draft, updatedAt: app.now })
              .then(() => app.navigate("S01"));
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  iconTap: {
    width: 35,
    height: 35,
    alignItems: "center",
    justifyContent: "center",
  },
  notificationDot: {
    position: "absolute",
    top: 4,
    right: 6,
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  infoIcon: {
    width: 35,
    height: 35,
    borderRadius: 10,
    backgroundColor: colors.lavender,
    alignItems: "center",
    justifyContent: "center",
  },
  heroEvent: {
    width: 304,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: colors.lavender,
  },
  heroShade: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 108,
    backgroundColor: "#23143BD9",
  },
  heroBadge: { position: "absolute", top: 12, left: 12 },
  heroCopy: { position: "absolute", bottom: 14, left: 16, right: 14, gap: 4 },
  categoryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: 17,
    columnGap: "4%",
  },
  categoryItem: { width: "22%", alignItems: "center", gap: 7 },
  categoryIcon: {
    width: 57,
    height: 57,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  floating: {
    position: "absolute",
    right: 18,
    bottom: 88,
    gap: 9,
    alignItems: "flex-end",
  },
  aiButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FFF",
    borderColor: "#D2BCFE",
    borderWidth: 1,
    borderRadius: 25,
    paddingHorizontal: 14,
    paddingVertical: 10,
    boxShadow: "0px 3px 14px #6C2CF512",
  },
  aiLabel: { fontSize: 11, fontWeight: "700", color: colors.primary },
  addButton: {
    width: 55,
    height: 55,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    boxShadow: "0px 6px 18px #6C2CF548",
  },
  searchButton: {
    width: 44,
    height: 47,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.lavender,
  },
  overlay: {
    flex: 1,
    backgroundColor: "#18102766",
    justifyContent: "center",
    alignItems: "center",
    padding: 22,
  },
  confirm: { width: "100%", maxWidth: 380, gap: 19, padding: 23 },
  sheetOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "#18102766",
    alignItems: "center",
  },
  filterSheet: {
    maxHeight: "90%",
    width: "100%",
    maxWidth: 440,
    backgroundColor: colors.background,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingTop: 10,
  },
  handle: {
    height: 4,
    width: 36,
    borderRadius: 3,
    alignSelf: "center",
    backgroundColor: "#D5CFDF",
    marginBottom: 17,
  },
  filterFooter: {
    padding: 20,
    backgroundColor: "#FFF",
    borderTopWidth: 1,
    borderColor: colors.line,
  },
  rankingEmpty: {
    padding: 15,
    gap: 10,
    alignItems: "center",
    backgroundColor: "#FFFFFF80",
    borderRadius: 12,
  },
  stepTrack: {
    height: 3,
    backgroundColor: "#E9E3F4",
    borderRadius: 2,
    overflow: "hidden",
  },
  stepFill: { height: 3, backgroundColor: colors.primary },
  checkRow: {
    flexDirection: "row",
    gap: 11,
    alignItems: "center",
    paddingVertical: 6,
  },
  checkbox: {
    height: 23,
    width: 23,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "#C8BDE0",
    justifyContent: "center",
    alignItems: "center",
  },
});
