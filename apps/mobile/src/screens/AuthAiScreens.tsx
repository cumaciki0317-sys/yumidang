import React, { useCallback, useState } from "react";
import { Image, Modal, Pressable, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useApp } from "../state";
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

export function LoginScreen() {
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

export function SignupScreen() {
  const app = useApp();
  const [photo, setPhoto] = useState("");
  const [interests, setInterests] = useState<string[]>([]);
  const [styles, setStyles] = useState<string[]>([]);
  const [mbti, setMbti] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
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
        size > 10 * 1024 * 1024 ||
        (format
          ? !["image/jpeg", "image/png"].includes(format)
          : !/\.(jpe?g|png)$/i.test(
              (asset.fileName || asset.uri).split("?")[0],
            ))
      ) {
        setError("JPG·JPEG·PNG 형식의 10MB 이하 사진을 선택해 주세요.");
        return;
      }
      setPhoto(asset.uri);
      setError("");
    } catch {
      setError("사진을 선택하지 못했어요. 다시 시도해 주세요.");
    }
  };
  return (
    <Screen
      title="가입 프로필"
      footer={
        <Button
          onPress={() => {
            if (!photo) {
              setError("프로필 사진을 선택해 주세요.");
              return;
            }
            if (mbti.trim() && !/^[EI][SN][TF][JP]$/.test(mbti)) {
              setError("MBTI를 모두 선택하거나 비워 주세요.");
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="프로필 사진 선택"
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
      <Body small muted style={{ textAlign: "center" }}>
        JPG·JPEG·PNG · 10MB 이하
      </Body>
      {error && <Body style={{ color: colors.red }}>{error}</Body>}
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

export function AiScreen() {
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
