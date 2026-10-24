import { serviceMode, serviceConfigurationError, useMemberPorts, useMemberSessionDetails, useServiceSession, installMemberSessionDetails, serviceSessionEpoch, useMemberService, useService } from "../remote";
import { subscribeWebMemberConnectionStatus, webMemberConnectionStatus } from "../web-member-connection";
import { createAuthCallbackTask } from "../auth-callback-task";
import { sessionResult, signupState, internalPath, type SessionResult } from "../member-session";
import { uploadPhoto, validateOriginalPhoto, type PhotoInput } from "../avatar-service";
import { ApiError } from "../api";
import { useUxFocus } from "../presentation/ux-form";
import { signupDraftStore, observeSignupDraftSession, type SignupDraft, type SignupDraftScope, emptySummaryConsents, type SummaryConsentKind, type SummaryConsentSelection } from "../signup-draft";
import * as Crypto from "expo-crypto";
import { RemoteAiScreen } from "./RemoteScreens";
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image, Modal, Platform, Pressable, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useApp, routes } from "../state";
import { TagsEditor } from "./CommunityScreens";
import {
  art,
  Badge,
  Body,
  Button,
  Card,
  Chip,
  colors,
  Empty,
  Field,
  Icon,
  PostCard,
  Row,
  Screen,
  Section,
  TextButton,
  Title,
} from "../ui";

export function LoginScreen() { return serviceMode ? <RemoteLoginScreen /> : <PreviewLoginScreen />; }
function PreviewLoginScreen() {
  const app = useApp();
  const { returnPath, example } = useLocalSearchParams<{
    returnPath?: string;
    example?: string;
  }>();
  const [issue, setIssue] = useState(
    example === "missing"
      ? "필수 정보가 누락되어 가입을 보류했어요. 네이버 정보와 동의 항목을 확인한 뒤 다시 시도해 주세요."
      : example === "ineligible"
        ? "여성·만 19세 이상 가입 자격을 충족하지 않아 가입할 수 없어요."
        : example === "connection"
          ? "네이버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요."
          : "",
  );
  const [busy, setBusy] = useState(false);
  const complete = () => {
    setBusy(true);
    setTimeout(() => {
      setBusy(false);
      const returning = !!app.members.me || !!app.member;
      app.login();
      if (!returning) return;
      if (
        returnPath &&
        returnPath.startsWith("/") &&
        !returnPath.startsWith("//") &&
        returnPath !== "/login"
      )
        router.replace(returnPath as any);
      else app.navigate("S00");
    }, 300);
  };
  return (
    <Screen
      title="로그인"
      footer={
        <Body small muted style={{ textAlign: "center" }}>
          현재 화면은 예시 계정으로 체험하는 디자인 미리보기예요.
        </Body>
      }
    >
      <View
        style={{
          paddingTop: 38,
          paddingBottom: 25,
          gap: 18,
          alignItems: "center",
        }}
      >
        <Image
          source={art.logo}
          style={{ height: 70, width: 70, borderRadius: 24 }}
        />
        <Title large style={{ textAlign: "center" }}>
          취향이 통하는 순간,{"\n"}함께라서 더 좋은 유미당
        </Title>
        <Body muted style={{ textAlign: "center" }}>
          부담 없는 무료 1:1 동행.{"\n"}같은 취향을 나눌 동행인을 만나 보세요.
        </Body>
      </View>
      <Card style={{ backgroundColor: colors.lavender, borderWidth: 0 }}>
        <Row>
          <Icon name="shield-checkmark-outline" color={colors.primary} />
          <Title style={{ fontSize: 15 }}>여성 · 만 19세 이상</Title>
        </Row>
        <Body small muted>
          네이버의 이름·성별·생일·출생연도로 가입 자격을 확인해요. 별도
          휴대폰·계좌 인증은 없어요.
        </Body>
      </Card>
      {issue && (
        <Card>
          <Body style={{ color: colors.red }}>{issue}</Body>
          <TextButton onPress={() => setIssue("")}>다시 확인하기</TextButton>
        </Card>
      )}
      <Button
        testID="naver-login"
        onPress={complete}
        loading={busy}
        style={{ backgroundColor: "#03C75A" }}
        icon="log-in-outline"
      >
        네이버로 로그인
      </Button>
      <Button secondary onPress={() => app.navigate("S06")}>
        처음이라면 가입 프로필 살펴보기
      </Button>
      <View style={{ gap: 12 }}>
        <Body small muted>
          네이버 실연동과 본인 정보 검증은 서버 연결 후 확인해요. 화면의 인증은
          실제 가입 자격을 증명하지 않아요.
        </Body>
      </View>
    </Screen>
  );
}

export function SignupScreen() { return serviceMode ? <RemoteSignupScreen /> : <PreviewSignupScreen />; }
function PreviewSignupScreen() {
  const app = useApp();
  const uxFocus = useUxFocus();
  const [photo, setPhoto] = useState("");
  const [interests, setInterests] = useState<string[]>([]);
  const [styles, setStyles] = useState<string[]>([]);
  const [mbti, setMbti] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const photoTarget = useRef<View | null>(null), mbtiTarget = useRef<View | null>(null);
  const [errorFocus, setErrorFocus] = useState<{ field: "photo" | "mbti" } | null>(null);
  useEffect(() => {
    if (errorFocus) uxFocus.focusTarget((errorFocus.field === "photo" ? photoTarget : mbtiTarget).current);
  }, [errorFocus, uxFocus]);
  const fail = (message: string, field: "photo" | "mbti") => { setError(message); setErrorFocus({ field }); };
  const mbtiPairs = [["E", "I"], ["S", "N"], ["T", "F"], ["J", "P"]];
  const firstIncompletePair = Math.max(0, mbtiPairs.findIndex((pair, index) => !pair.includes(mbti[index] || "")));
  const selectPhoto = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.9,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      const size = asset.fileSize ?? asset.file?.size;
      const format = asset.mimeType?.toLowerCase();
      if (
        size === undefined ||
        size > 10_000_000 ||
        (format
          ? !["image/jpeg", "image/png"].includes(format)
          : !/\.(jpe?g|png)$/i.test(
              (asset.fileName || asset.uri).split("?")[0],
            ))
      ) {
        fail("JPG·JPEG·PNG 형식의 10MB 이하 사진을 선택해 주세요.", "photo");
        return;
      }
      setPhoto(asset.uri);
      setError("");
    } catch {
      fail("사진을 선택하지 못했어요. 다시 시도해 주세요.", "photo");
    }
  };
  return (
    <Screen
      title="가입 프로필"
      focusController={uxFocus}
      footer={
        <Button
          onPress={() => {
            if (!photo) {
              fail("프로필 사진을 선택해 주세요.", "photo");
              return;
            }
            if (mbti.trim() && !/^[EI][SN][TF][JP]$/.test(mbti)) {
              fail("MBTI를 모두 선택하거나 비워 주세요.", "mbti");
              return;
            }
            if (!app.member) app.login();
            app.updateMember({
              photo,
              interests,
              conversationStyles: styles,
              mbti,
            });
            setDone(true);
          }}
          disabled={done}
        >
          가입 완료
        </Button>
      }
    >
      <View style={{ gap: 8 }}>
        <Badge>가입 마지막 단계</Badge>
        <Title large>어떤 취향을{"\n"}함께 나누고 싶나요?</Title>
        <Body muted>사진은 필수, 취향과 성향은 선택이에요.</Body>
      </View>
      <View style={{ gap: 8 }}>
      <Row><Title>프로필 사진</Title><Badge>필수</Badge></Row>
      <Body small muted>JPG·JPEG·PNG · 10MB 이하</Body>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="프로필 사진 선택, 필수"
        accessible
        accessibilityHint={errorFocus?.field === "photo" ? error : undefined}
        ref={photoTarget}
        onPress={selectPhoto}
        style={{ alignSelf: "center", gap: 12, alignItems: "center" }}
      >
        {photo ? (
          <Image
            source={{ uri: photo }}
            style={{ height: 110, width: 110, borderRadius: 55 }}
          />
        ) : (
          <View
            style={{
              height: 110,
              width: 110,
              borderRadius: 55,
              backgroundColor: colors.lavender,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="camera-outline" size={30} color={colors.primary} />
          </View>
        )}
        <Text style={{ color: colors.primary, fontWeight: "600" }}>
          프로필 사진 선택
        </Text>
      </Pressable>
      {error && errorFocus?.field === "photo" && <View accessibilityLiveRegion="polite"><Body style={{ color: colors.red }}>{error}</Body></View>}
      </View>
      <TagsEditor
        title="관심사 · 선택"
        values={interests}
        setValues={setInterests}
        suggestions={["전시", "공연", "산책", "카페", "여행", "영화"]}
      />
      <TagsEditor
        title="대화 방식 · 선택"
        values={styles}
        setValues={setStyles}
        suggestions={[
          "편안한 대화",
          "차분한 이야기",
          "유쾌한 수다",
          "천천히 알아가기",
        ]}
      />
      <Section title="MBTI · 선택">
        {mbtiPairs.map((pair, i) => (
          <Row key={i}>
            {pair.map((x) => (
              <Chip
                key={x}
                focusRef={i === firstIncompletePair && x === pair[0] ? mbtiTarget : undefined}
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
        {error && errorFocus?.field === "mbti" && <View accessibilityLiveRegion="polite"><Body style={{ color: colors.red }}>{error}</Body></View>}
      </Section>
      <Body small muted>
        AI 가입 동의 방식은 법적 확인 중이에요. 이 미리보기에서 필수 AI 동의로
        가입을 막거나 실제 회원 정보를 외부로 보내지 않아요.
      </Body>
      <Modal visible={done} transparent animationType="fade" onRequestClose={() => {setDone(false);app.navigate("S00");}}>
        <View style={{flex:1,backgroundColor:"#26163B66",alignItems:"center",justifyContent:"center",padding:24}}>
          <Card style={{ backgroundColor: colors.lavender, width:"100%", maxWidth:380 }}>
            <Title>가입 프로필을 완성했어요</Title>
            <Body>이제 취향이 통하는 동행을 찾아볼까요?</Body>
            <Button onPress={() => {setDone(false);app.navigate("S00");}}>유미당 시작하기</Button>
          </Card>
        </View>
      </Modal>
    </Screen>
  );
}

function authMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "NAVER_INFORMATION_REQUIRED") return "네이버 필수 정보가 누락됐어요. 네이버 정보와 동의 항목을 확인한 뒤 다시 로그인해 주세요.";
    if (error.code === "NAVER_INELIGIBLE") return "여성·만 19세 이상 가입 자격을 충족하지 않아 가입을 완료할 수 없어요.";
    if (["INVALID_PHOTO", "INVALID_PHOTO_PATH"].includes(error.code)) return "원본 10MB 이하 JPG·PNG 사진을 선택해 주세요. 저장용 사진은 2MiB 이하 JPEG로 변환해요.";
    if (error.code === "INVALID_LOGIN_CALLBACK") return "로그인 요청이 만료됐거나 이 화면의 요청과 일치하지 않아요. 새로 로그인해 주세요.";
    if (error.status === 401) return "로그인이 만료됐거나 로그인 상태 확인이 필요해요.";
    if (error.status === 403 || error.status === 404) return "지금은 이 요청을 이용할 수 없어요. 이용 가능한 범위를 확인해 주세요.";
  }
  return "연결하지 못했어요. 입력을 유지했으니 잠시 후 다시 시도해 주세요.";
}
type SignupRecovery = "retry" | "login" | "unavailable";
function signupFailure(error: unknown): { kind: SignupRecovery; message: string } {
  let kind: SignupRecovery = "retry";
  if (error instanceof ApiError) {
    if (["NAVER_INFORMATION_REQUIRED", "INVALID_LOGIN_CALLBACK"].includes(error.code)) kind = "login";
    else if (error.code === "NAVER_INELIGIBLE") kind = "unavailable";
    else if (!["INVALID_PHOTO", "INVALID_PHOTO_PATH"].includes(error.code)) {
      if (error.status === 401) kind = "login";
      else if (error.status === 403 || error.status === 404) kind = "unavailable";
    }
  }
  const message = authMessage(error);
  return { kind, message: kind === "login" ? `${message} 상단 뒤로가기로 로그인 화면으로 돌아가 주세요.` : message };
}
function authDestination(result: ReturnType<typeof sessionResult>) {
  if (result.status === "ready") router.replace(result.returnTo as any);
  else if (result.status === "photo_required" || result.status === "completion_required") router.replace("/signup");
}
function RemoteLoginScreen() {
  const connectionStatus = useSyncExternalStore(subscribeWebMemberConnectionStatus, webMemberConnectionStatus, () => "unconfigured");
  const { session } = useMemberPorts();
  const details = useMemberSessionDetails();
  const { returnPath } = useLocalSearchParams<{ returnPath?: string }>();
  const { epoch } = useServiceSession();
  const [request, setRequest] = useState<{ session: typeof session; epoch: number; busy: boolean; issue: string } | null>(null);
  const busy = request?.session === session && request.epoch === epoch && request.busy;
  const issue = request?.session === session && request.epoch === epoch ? request.issue : "";
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), [session, epoch]);
  const login = async () => {
    if (!session || busy) return;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    const epoch = serviceSessionEpoch(); setRequest({ session, epoch, busy: true, issue: "" });
    try {
      const result = await session.login(returnPath || "/", controller.signal);
      if (controller.signal.aborted || serviceSessionEpoch() !== epoch) return;
      if (result === null) return; // Supported web start redirects; this is not a successful login.
      const verified = sessionResult(result); installMemberSessionDetails(verified); authDestination(verified);
    } catch (error) { if (!controller.signal.aborted && serviceSessionEpoch() === epoch) setRequest({ session, epoch, busy: false, issue: authMessage(error) }); }
    finally { if (!controller.signal.aborted && serviceSessionEpoch() === epoch) setRequest(value => value?.session === session && value.epoch === epoch ? { ...value, busy: false } : value); }
  };
  return <Screen title="로그인">
    <Title>네이버로 유미당 시작하기</Title>
    <Body>네이버의 이름·성별·생일·출생연도로 여성·만 19세 이상 여부를 확인해요.</Body>
    {!session && <Body muted>{serviceConfigurationError ? "서비스 연결 설정을 확인하고 있어요. 준비되면 로그인할 수 있어요." : Platform.OS !== "web" ? "앱의 네이버 로그인 연결을 준비하고 있어요. 아직 실제 로그인을 사용할 수 없어요." : connectionStatus === "invalid" ? "네이버 로그인 연결 설정이 올바르지 않아요. 연결 설정을 확인한 뒤 다시 시도해 주세요." : connectionStatus === "unconfigured" ? "네이버 로그인 연결 설정이 아직 제공되지 않았어요. 준비되면 로그인할 수 있어요." : "네이버 연결을 준비하고 있어요. 준비되면 여기에서 로그인할 수 있어요."}</Body>}
    {details && ["information_required", "ineligible"].includes(details.status) && <Body>네이버 정보 확인이 필요해 새 공고·신청·확정을 보류했어요. 기존 약속 조회·취소·지원은 이용할 수 있어요.</Body>}
    {issue && <Body>{issue}</Body>}
    <Button disabled={!session || busy} loading={busy} onPress={() => { void login(); }}>네이버로 로그인</Button>
    <TextButton onPress={() => router.replace("/")}>둘러보기</TextButton>
  </Screen>;
}
export function RemoteNaverCallback() {
  const { session } = useMemberPorts();
  const { epoch: currentEpoch } = useServiceSession();
  const [failure, setFailure] = useState<{ session: typeof session; epoch: number; text: string } | null>(null);
  const issue = failure?.session === session && failure.epoch === currentEpoch ? failure.text : "";
  const task = useRef<{ session: typeof session; epoch: number; value: ReturnType<typeof createAuthCallbackTask<unknown>> } | null>(null);
  useEffect(() => {
    if (!session?.callback || typeof window === "undefined") return;
    const epoch = serviceSessionEpoch();
    if (!task.current || task.current.session !== session || task.current.epoch !== epoch) {
      const url = window.location.href;
      task.current = { session, epoch, value: createAuthCallbackTask(signal => session.callback!(url, signal)) };
    }
    return task.current.value.subscribe(result => {
      if (serviceSessionEpoch() !== epoch) return;
      const verified = sessionResult(result); installMemberSessionDetails(verified); authDestination(verified);
      if (["information_required", "ineligible"].includes(verified.status)) router.replace("/login");
    }, error => { if (serviceSessionEpoch() === epoch) setFailure({ session, epoch, text: authMessage(error) }); });
  }, [session]);
  return <Screen title="네이버 로그인 확인"><Body>{issue || (session?.callback ? "네이버 정보를 확인하고 있어요…" : "로그인 연결을 준비하고 있어요.")}</Body><TextButton onPress={() => router.replace("/login")}>로그인으로 돌아가기</TextButton></Screen>;
}
const summaryChoices: { kind: SummaryConsentKind; label: string; detail: string }[] = [
  { kind: "summary_view", label: "후기 요약 열람", detail: "다른 회원의 공개 가능한 후기 AI 요약을 볼 수 있어요." },
  { kind: "summary_generate", label: "내 프로필 요약 생성·노출", detail: "내 프로필의 후기 AI 요약을 생성하고 공개하는 데 동의해요. 철회하면 요약을 숨기고 새 생성·갱신을 중단해요." },
  { kind: "summary_source", label: "내가 작성한 후기의 요약 활용", detail: "내가 작성한 기존·향후 공개 후기를 AI 요약 재료로 활용하는 데 동의해요. 철회하면 해당 후기를 재료에서 제외하고 영향을 받은 요약을 먼저 숨겨요." },
];
type SignupCompletion = { userId: string; epoch: number; returnTo: string; selection: SummaryConsentSelection | null; confirmed: SummaryConsentSelection | null; busy: boolean; issue: string; returning: boolean; returnIssue: string };
function RemoteSignupScreen() {
  const uxFocus = useUxFocus();
  const member = useMemberService(), service = useService();
  const { session, photo: storage } = useMemberPorts(), details = useMemberSessionDetails();
  const { epoch } = useServiceSession();
  const userId = details?.userId;
  const scope: SignupDraftScope | null = session && details && details.status !== "ready" ? { userId: details.userId, epoch, session } : null;
  // The session installer also invalidates this store while auth screens are unmounted.
  observeSignupDraftSession(scope);
  const emptyDraft = (): SignupDraft => ({ photo: null, avatarPath: null, interests: [], conversationStyles: [], mbti: "", uploaded: null, summaryConsents: emptySummaryConsents(), summaryConsentsEdited: false });
  const [draftState, setDraftState] = useState(() => ({ epoch, userId, value: scope && signupDraftStore.read(scope) || emptyDraft() }));
  const draft = draftState.epoch === epoch && draftState.userId === userId ? draftState.value : scope && signupDraftStore.read(scope) || emptyDraft();
  const setDraft = (value: SignupDraft) => setDraftState({ epoch, userId, value });
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState("");
  const [loading, setLoading] = useState(false), [loadIssue, setLoadIssue] = useState(""), [loaded, setLoaded] = useState(false);
  const [failureKind, setFailureKind] = useState<SignupRecovery>("retry");
  const [recoveryIssue, setRecoveryIssue] = useState("");
  const [completion, setCompletion] = useState<SignupCompletion | null>(null);
  const [consentAttempt, setConsentAttempt] = useState(0);
  const [consentDetail, setConsentDetail] = useState<SummaryConsentKind | null>(null);
  const postActive = useRef<AbortController | null>(null);
  const active = useRef<AbortController | null>(null);
  const focused = useRef(false);
  const picker = useRef(0);
  const photoTarget = useRef<View | null>(null), mbtiTarget = useRef<View | null>(null), issueTarget = useRef<View | null>(null);
  const [errorFocus, setErrorFocus] = useState<{ field: "photo" | "mbti" | "issue" } | null>(null);
  useEffect(() => {
    if (!errorFocus) return;
    const target = errorFocus.field === "photo" ? photoTarget : errorFocus.field === "mbti" ? mbtiTarget : issueTarget;
    uxFocus.focusTarget(target.current);
  }, [errorFocus, uxFocus]);
  const focusError = (error: unknown) => setErrorFocus({ field: error instanceof ApiError && ["INVALID_PHOTO", "INVALID_PHOTO_PATH"].includes(error.code) ? "photo" : "issue" });
  const current = (controller: AbortController, expected: SignupDraftScope) => focused.current && !controller.signal.aborted && active.current === controller && serviceSessionEpoch() === expected.epoch && signupDraftStore.read(expected) !== null;
  const completionCurrent = (flow: SignupCompletion, controller: AbortController) => focused.current && !controller.signal.aborted && postActive.current === controller && serviceSessionEpoch() === flow.epoch;
  const finish = (verified: SessionResult, selection: SummaryConsentSelection | null) => {
    signupDraftStore.clear();
    installMemberSessionDetails(verified);
    setCompletion({ userId: verified.userId, epoch: serviceSessionEpoch(), returnTo: verified.returnTo, selection, confirmed: null, busy: true, issue: "", returning: false, returnIssue: "" });
    setBusy(false); setLoading(false);
  };
  const saveConsents = async (flow: SignupCompletion) => {
    postActive.current?.abort(); const controller = new AbortController(); postActive.current = controller;
    setCompletion(previous => previous?.epoch === flow.epoch ? { ...previous, busy: true, issue: "" } : previous);
    let confirmed: SummaryConsentSelection | null = null;
    try {
      if (!member) throw new ApiError(503, "SERVICE_NOT_CONFIGURED");
      let currentConsents = await member.aiConsents(controller.signal);
      if (!completionCurrent(flow, controller)) return;
      if (flow.selection) {
        for (const { kind } of summaryChoices) {
          if (!completionCurrent(flow, controller)) return;
          if (currentConsents[kind] === flow.selection[kind]) continue;
          try { currentConsents = await member.setAiConsent(kind, flow.selection[kind], controller.signal); }
          catch (error) { if (error instanceof ApiError && (error.status === 401 || error.status === 403)) break; }
        }
        if (!completionCurrent(flow, controller)) return;
        currentConsents = await member.aiConsents(controller.signal);
      }
      if (!completionCurrent(flow, controller)) return;
      confirmed = { summary_view: currentConsents.summary_view, summary_generate: currentConsents.summary_generate, summary_source: currentConsents.summary_source };
    } catch { /* A failed optional save never changes a successful signup. */ }
    if (!completionCurrent(flow, controller)) return;
    const pending = !confirmed || Boolean(flow.selection && summaryChoices.some(({ kind }) => confirmed![kind] !== flow.selection![kind]));
    setCompletion(previous => previous?.epoch === flow.epoch ? { ...previous, confirmed, busy: false, issue: pending ? "가입은 완료됐어요. 일부 AI 선택 동의의 저장을 확인하지 못했어요. 다시 시도하거나 나중에 계정 관리에서 설정할 수 있어요." : "" } : previous);
  };
  const load = async () => {
    if (!session || !scope) return;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    const expected = scope;
    setLoading(true); setLoadIssue(""); setLoaded(false); setIssue(""); setFailureKind("retry"); setRecoveryIssue("");
    try {
      const result = signupState(await session.signupState(controller.signal));
      if (!current(controller, expected)) return;
      if (result.status === "ready") {
        // Reuse only the already verified identity/token; this lookup does not issue credentials.
        const verified = sessionResult({ ...details!, status: result.status });
        const saved = signupDraftStore.read(expected);
        finish(verified, saved?.summaryConsentsEdited ? { ...saved.summaryConsents } : null); return;
      }
      const merged = signupDraftStore.merge(expected, result);
      if (merged) setDraft(merged);
      const eligible = result.status === "photo_required" || result.status === "completion_required";
      setLoaded(eligible);
      if (!eligible) { setLoadIssue(result.status === "ineligible" ? "여성·만 19세 이상 가입 자격을 충족하지 않아 가입을 완료할 수 없어요." : "네이버 필수 정보 확인이 필요해요. 정보를 확인한 뒤 다시 불러와 주세요."); setErrorFocus({ field: "issue" }); }
    } catch (error) {
      if (current(controller, expected)) { const failure = signupFailure(error); setFailureKind(failure.kind); setRecoveryIssue(failure.kind === "retry" ? "" : failure.message); setLoadIssue(failure.message); focusError(error); }
    } finally {
      if (current(controller, expected)) { active.current = null; setLoading(false); }
    }
  };
  useFocusEffect(useCallback(() => {
    focused.current = true;
    setBusy(false);
    if (completion && completion.epoch === epoch && completion.userId === userId) void saveConsents(completion);
    else { setCompletion(null); void load(); }
    return () => { focused.current = false; picker.current++; active.current?.abort(); active.current = null; postActive.current?.abort(); postActive.current = null; };
    // The epoch is the authoritative identity/authority boundary, not the details object's token refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, epoch, userId, completion?.epoch, consentAttempt]));
  const edit = <K extends "photo" | "interests" | "conversationStyles" | "mbti",>(field: K, value: SignupDraft[K]) => {
    if (!scope) return;
    const next = signupDraftStore.edit(scope, field, value);
    if (next) setDraft(next);
  };
  const select = async () => {
    if (!scope) return;
    const expected = scope, request = ++picker.current;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, allowsEditing: false, exif: false });
      if (!focused.current || serviceSessionEpoch() !== expected.epoch || request !== picker.current || !signupDraftStore.read(expected) || result.canceled) return;
      const asset = result.assets[0];
      const input: PhotoInput = { uri: asset.uri, mimeType: asset.mimeType || "", originalBytes: asset.fileSize ?? asset.file?.size ?? 0 };
      validateOriginalPhoto(input); edit("photo", input); setIssue("");
    } catch (error) { if (focused.current && serviceSessionEpoch() === expected.epoch && request === picker.current) { const failure = signupFailure(error); setIssue(failure.message); focusError(error); } }
  };
  const complete = async () => {
    if (!details || !session || !storage || !scope || !loaded || busy || loading || failureKind !== "retry") return;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    const expected = scope, input = signupDraftStore.read(expected);
    if (!input) return;
    if (input.mbti.trim() && !/^[EI][SN][TF][JP]$/.test(input.mbti)) { setIssue("MBTI를 모두 선택하거나 비워 주세요."); setErrorFocus({ field: "mbti" }); return; }
    setBusy(true); setIssue("");
    try {
      let avatarPath = input.avatarPath;
      if (input.photo) {
        const next = input.uploaded?.path || `${details.userId}/${Crypto.randomUUID()}.jpg`;
        if (!input.uploaded?.ready) {
          signupDraftStore.upload(expected, { path: next, ready: false });
          await uploadPhoto(input.photo, next, details.userId, storage, controller.signal);
          if (!current(controller, expected)) return;
          signupDraftStore.upload(expected, { path: next, ready: true });
        }
        avatarPath = next;
      }
      if (!current(controller, expected)) return;
      if (!avatarPath) throw new ApiError(400, "INVALID_PHOTO");
      const result = signupState(await session.complete({ avatarPath, interests: input.interests, conversationStyles: input.conversationStyles, mbti: input.mbti || null }, controller.signal));
      if (!current(controller, expected)) return;
      if (result.status !== "ready") { setIssue("가입 정보를 다시 확인해 주세요. 아직 가입 완료가 확인되지 않았어요."); setErrorFocus({ field: "issue" }); return; }
      const verified = sessionResult({ ...details, status: result.status });
      finish(verified, { ...input.summaryConsents });
    } catch (error) { if (current(controller, expected)) { const failure = signupFailure(error); setFailureKind(failure.kind); setRecoveryIssue(failure.kind === "retry" ? "" : failure.message); setIssue(failure.message); focusError(error); } }
    finally { if (focused.current && !controller.signal.aborted && serviceSessionEpoch() === expected.epoch) { active.current = null; setBusy(false); } }
  };
  const back = () => { active.current?.abort(); postActive.current?.abort(); router.push("/login"); };
  const mbtiPairs = [["E", "I"], ["S", "N"], ["T", "F"], ["J", "P"]];
  const firstIncompletePair = Math.max(0, mbtiPairs.findIndex((pair, index) => !pair.includes(draft.mbti[index] || "")));
  const chooseConsent = (selection: SummaryConsentSelection) => {
    if (!scope || busy) return;
    const next = signupDraftStore.setSummaryConsents(scope, selection); if (next) setDraft(next);
  };
  const proceed = async () => {
    const flow = completion;
    if (!flow || flow.busy || flow.returning || flow.epoch !== serviceSessionEpoch()) return;
    postActive.current?.abort(); const controller = new AbortController(); postActive.current = controller;
    setCompletion(previous => previous?.epoch === flow.epoch ? { ...previous, returning: true, returnIssue: "" } : previous);
    let target = "/";
    try {
      const safe = internalPath(flow.returnTo), parsed = new URL(safe, "https://internal.invalid");
      if (!Object.values(routes).includes(parsed.pathname) || ["/login", "/signup"].includes(parsed.pathname)) target = "/";
      else {
        target = safe;
        const id = parsed.searchParams.get("id");
        if (id) {
          if (!service || !member) throw new ApiError(503, "SERVICE_NOT_CONFIGURED");
          if (parsed.pathname === "/post") await service.getPost(id, controller.signal);
          else if (parsed.pathname === "/event") await service.getEvent(id, controller.signal);
          else if (parsed.pathname === "/profile") await service.getProfile(id, controller.signal);
          else if (parsed.pathname === "/create" && id.startsWith("event:")) await service.getEvent(id.slice(6), controller.signal);
          else if (parsed.pathname === "/create" && id.startsWith("edit:")) await service.getPost(id.slice(5), controller.signal);
          else if (parsed.pathname === "/chat") { if (id.startsWith("request:")) await member.conversation(id.slice(8), controller.signal); else await service.getPost(id, controller.signal); }
          else if (["/appointment", "/review"].includes(parsed.pathname)) await member.appointment(id, controller.signal);
          else if (parsed.pathname === "/cancel" && id.startsWith("appointment:")) await member.appointment(id.slice(12), controller.signal);
        }
      }
      if (completionCurrent(flow, controller)) router.replace(target as any);
    } catch (error) {
      if (!completionCurrent(flow, controller)) return;
      if (error instanceof ApiError && [400, 403, 404].includes(error.status)) { router.replace("/"); return; }
      setCompletion(previous => previous?.epoch === flow.epoch ? { ...previous, returning: false, returnIssue: "가입은 완료됐어요. 돌아갈 화면의 현재 상태를 확인하지 못했어요. 다시 확인하거나 홈으로 이동해 주세요." } : previous);
    }
  };
  if (completion && completion.epoch === epoch && completion.userId === userId) return <Screen title="가입 완료">
    <Modal visible transparent animationType="fade" onRequestClose={() => { if (!completion.busy) void proceed(); }}>
      <View style={{ flex: 1, backgroundColor: "#26163B66", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Card style={{ backgroundColor: colors.lavender, width: "100%", maxWidth: 380 }}>
          <Title>가입 프로필을 완성했어요</Title><Body>일반 동행 서비스를 이용할 수 있어요.</Body>
          {completion.busy ? <Body>AI 선택 동의 상태를 확인하고 있어요…</Body> : <>
            {summaryChoices.map(({ kind, label }) => <Body key={kind}>{label} · {completion.confirmed ? completion.confirmed[kind] ? "동의" : "미동의" : "확인 필요"}</Body>)}
            {completion.issue && <><Body>{completion.issue}</Body><Button secondary onPress={() => setConsentAttempt(value => value + 1)}>동의 저장 다시 시도</Button></>}
            {completion.returnIssue && <Body>{completion.returnIssue}</Body>}
            <Button loading={completion.returning} disabled={completion.returning} onPress={() => void proceed()}>{completion.returnIssue ? "목적 화면 다시 확인" : completion.issue ? "나중에 설정하고 계속" : "확인하고 계속"}</Button>
            {completion.returnIssue && <TextButton onPress={() => { postActive.current?.abort(); router.replace("/"); }}>홈으로 이동</TextButton>}
          </>}
        </Card>
      </View>
    </Modal>
  </Screen>;
  const photoIssue = errorFocus?.field === "photo" ? (issue !== recoveryIssue ? issue : "") || (loadIssue !== recoveryIssue ? loadIssue : "") : "";
  const neutralIssue = errorFocus?.field === "photo" || errorFocus?.field === "mbti" ? "" : issue;
  const neutralLoadIssue = errorFocus?.field === "photo" ? "" : loadIssue;
  const neutralMessages = [...new Set([recoveryIssue, neutralIssue, neutralLoadIssue].filter(Boolean))];
  if (!details) return <Screen title="가입 프로필" backLabel="로그인으로 돌아가기" onBack={back} focusController={uxFocus}><Body>네이버 로그인 후 가입 정보를 입력할 수 있어요.</Body></Screen>;
  return <Screen title="가입 프로필" backLabel="로그인으로 돌아가기" onBack={back} focusController={uxFocus}>
    <View ref={issueTarget} focusable tabIndex={-1} collapsable={false} accessible={neutralMessages.length > 0} accessibilityLabel={["가입 정보 확인 안내", ...neutralMessages].join(". ")} accessibilityLiveRegion="polite">
      {neutralMessages.map(message => <Body key={message}>{message}</Body>)}
    </View>
    {!session || !storage ? <Body muted>가입·사진 연결을 준비하고 있어요.</Body> : loading && <Body muted>현재 가입 정보를 확인하고 있어요…</Body>}
    {loadIssue && failureKind === "retry" && <Button secondary loading={loading} disabled={loading || busy || !session} onPress={() => { void load(); }}>다시 불러오기</Button>}
    <View style={{ gap: 8 }}>
      <Row><Title>프로필 사진</Title><Badge>필수</Badge></Row>
      <Body small>JPG·PNG 원본 10MB 이하. 사진을 선택한 뒤 가입 완료를 눌러 주세요.</Body>
      {draft.photo && <Image source={{ uri: draft.photo.uri }} style={{ width: 110, height: 110, borderRadius: 55 }} />}
      <Button focusRef={photoTarget} secondary disabled={!storage || busy} onPress={() => { void select(); }}>프로필 사진 선택</Button>
      {photoIssue && <View accessibilityLiveRegion="polite"><Body style={{ color: colors.red }}>{photoIssue}</Body></View>}
    </View>
    <TagsEditor title="관심사 · 선택" values={draft.interests} setValues={values => edit("interests", values)} suggestions={["전시", "공연", "산책", "카페", "여행", "영화"]} />
    <TagsEditor title="대화 방식 · 선택" values={draft.conversationStyles} setValues={values => edit("conversationStyles", values)} suggestions={["편안한 대화", "차분한 이야기", "유쾌한 수다", "천천히 알아가기"]} />
    <Section title="MBTI · 선택">
      {mbtiPairs.map((pair, index) => <Row key={index}>{pair.map(value => <Chip key={value} focusRef={index === firstIncompletePair && value === pair[0] ? mbtiTarget : undefined} selected={draft.mbti[index] === value} onPress={() => { const next = draft.mbti.padEnd(4, " ").split(""); next[index] = value; edit("mbti", next.join("")); }}>{value}</Chip>)}</Row>)}
      <TextButton onPress={() => edit("mbti", "")}>MBTI 비우기</TextButton>
      {errorFocus?.field === "mbti" && issue && <View accessibilityLiveRegion="polite"><Body style={{ color: colors.red }}>{issue}</Body></View>}
    </Section>
    <Section title="후기 AI 선택 동의">
      <Body muted>동의하지 않아도 가입하고 일반 동행을 이용할 수 있어요. 세 항목은 각각 철회할 수 있어요.</Body>
      <Chip selected={summaryChoices.every(({ kind }) => draft.summaryConsents[kind])} disabled={busy} onPress={() => { const allowed = !summaryChoices.every(({ kind }) => draft.summaryConsents[kind]); chooseConsent({ summary_view: allowed, summary_generate: allowed, summary_source: allowed }); }}>후기 AI 전체 동의</Chip>
      {summaryChoices.map(({ kind, label, detail }) => <View key={kind}><Chip selected={draft.summaryConsents[kind]} disabled={busy} onPress={() => chooseConsent({ ...draft.summaryConsents, [kind]: !draft.summaryConsents[kind] })}>{label}</Chip><TextButton onPress={() => setConsentDetail(previous => previous === kind ? null : kind)}>{label} 자세히 보기</TextButton>{consentDetail === kind && <Body>{detail}</Body>}</View>)}
      <Body small muted>AI 탐색 동의는 첫 사용 시 별도로 확인해요.</Body>
    </Section>
    <Button disabled={!session || !storage || !loaded || busy || loading || failureKind !== "retry" || !draft.photo && !draft.avatarPath} loading={busy} onPress={() => { void complete(); }}>가입 완료</Button>
  </Screen>;
}

export function AiScreen() { return serviceMode ? <RemoteAiScreen /> : <PreviewAiScreen />; }
function PreviewAiScreen() {
  const app = useApp();
  const { clearAi } = app;
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [reportId, setReportId] = useState<string | null>(null);
  const [reportText, setReportText] = useState("");
  useFocusEffect(useCallback(() => () => clearAi(), [clearAi]));
  const send = async (text: string, fixed = false) => {
    setError("");
    const result = await app.sendAi(text, !fixed);
    if (result.ok) setInput("");
    else setError(result.message || "답변을 확인하지 못했어요.");
  };
  if (!app.member)
    return (
      <Screen title="유미당 AI">
        <Empty
          title="취향에 맞는 동행을 찾아볼까요?"
          description="AI 동행 탐색은 로그인 후 이용할 수 있어요."
          action="로그인"
          onPress={() => app.navigate("S05")}
          icon="sparkles-outline"
        />
      </Screen>
    );
  return (
    <Screen
      title="유미당 AI"
      right={
        <TextButton
          onPress={() => {
            app.clearAi();
            setError("");
          }}
        >
          새 대화
        </TextButton>
      }
      footer={
        <View style={{ gap: 8 }}>
          <Row>
            <View style={{ flex: 1 }}>
              <Field
                placeholder="예: 서울에서 주말 전시 같이 볼 분"
                value={input}
                onChangeText={setInput}
                multiline
                style={{ flex: 1, minHeight: 44, maxHeight: 100 }}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="AI 메시지 보내기"
              disabled={app.aiBusy}
              onPress={() => send(input)}
              style={{
                height: 44,
                width: 44,
                borderRadius: 22,
                backgroundColor: app.aiBusy ? colors.faint : colors.primary,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="arrow-up" color="#fff" />
            </Pressable>
          </Row>
          <Body small muted>
            오늘 {app.aiUsed}/20회 · 대화는 화면을 나가면 지워져요.
          </Body>
        </View>
      }
    >
      <Card style={{ backgroundColor: colors.lavender, borderWidth: 0 }}>
        <Row>
          <Icon name="sparkles-outline" color={colors.primary} />
          <Title style={{ fontSize: 16 }}>취향을 나눌 동행을 함께 찾아요</Title>
        </Row>
        <Body small muted>
          공개된 카드로 추천 이유와 확인할 점을 안내해요. 실명·전화번호·상세
          만남 위치는 입력하지 마세요. 현재는 예시 카드로 동작하며 실제 모델에
          보내지 않아요.
        </Body>
      </Card>
      {!app.aiDiscoveryAllowed ? (
        <Empty
          title="새 AI 탐색을 중단했어요"
          description="철회 요청을 접수했어요. 계정과 일반 동행은 그대로 이용할 수 있어요."
          action="일반 둘러보기"
          onPress={() => app.navigate("S01")}
        />
      ) : (
        <>
          {app.aiMessages.length === 0 && (
            <View style={{ gap: 14 }}>
              <Title large>오늘은 어떤 동행이{"\n"}있으면 좋을까요?</Title>
              <Body muted>마음 가는 취향부터 골라 보세요.</Body>
              <Row style={{ flexWrap: "wrap" }}>
                {["서울 전시", "서울 산책", "서울 카페"].map((v) => (
                  <Chip key={v} onPress={() => send(v, true)}>
                    {v} ↗
                  </Chip>
                ))}
              </Row>
              <Body small muted>
                고정 조건 버튼은 모델 없이 처리해 이용 횟수를 차감하지 않아요.
              </Body>
            </View>
          )}
          {app.aiMessages
            .filter((m) => !m.hidden)
            .map((m) => (
              <View key={m.id} style={{ gap: 12 }}>
                <View
                  style={{
                    alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                    maxWidth: "93%",
                    padding: 16,
                    borderRadius: 18,
                    backgroundColor:
                      m.role === "user" ? colors.primary : "#fff",
                    borderWidth: m.role === "user" ? 0 : 1,
                    borderColor: colors.line,
                  }}
                >
                  <Body
                    style={{ color: m.role === "user" ? "#fff" : colors.ink }}
                  >
                    {m.text}
                  </Body>
                </View>
                {m.postIds?.map((id) => {
                  const post = app.posts.find((p) => p.id === id);
                  return post ? <PostCard key={id} post={post} /> : null;
                })}
                {m.role === "assistant" && (
                  <Row>
                    <TextButton
                      onPress={() =>
                        app.showToast("의견을 남겼어요. 고마워요.")
                      }
                    >
                      도움이 됐어요
                    </TextButton>
                    <TextButton
                      onPress={() => setReportId(m.id)}
                      color={colors.muted}
                    >
                      문제 있어요
                    </TextButton>
                  </Row>
                )}
              </View>
            ))}
          {app.aiBusy && (
            <Card>
              <Body muted>확인할 수 있는 카드를 살펴보고 있어요…</Body>
            </Card>
          )}
        </>
      )}
      {error && (
        <Card>
          <Body style={{ color: colors.red }}>{error}</Body>
          <Row>
            <TextButton onPress={() => send(input)}>다시 시도</TextButton>
            <TextButton onPress={() => app.navigate("S01")}>
              일반 둘러보기
            </TextButton>
          </Row>
        </Card>
      )}
      {reportId && (
        <Card>
          <Title>이 답변 신고하기</Title>
          <Body small muted>
            선택한 답변만 제출하며 전체 대화는 첨부하지 않아요.
          </Body>
          <Body>{app.aiMessages.find((m) => m.id === reportId)?.text}</Body>
          <Field
            label="상황 설명"
            value={reportText}
            onChangeText={setReportText}
            multiline
          />
          <Button
            onPress={() => {
              const r = app.report("AI 답변", reportText, reportId);
              if (r.ok) {
                app.hideAiReply(reportId);
                setReportId(null);
                setReportText("");
              } else setError(r.message || "접수하지 못했어요.");
            }}
          >
            확인한 답변과 함께 접수
          </Button>
          <TextButton onPress={() => setReportId(null)}>취소</TextButton>
        </Card>
      )}
    </Screen>
  );
}
