import React from "react";
import { router } from "expo-router";
import { useApp, routes } from "../state";
import { DAY, HOUR, reviewDeadline } from "../domain";
import {
  Badge,
  Body,
  Button,
  Card,
  Chip,
  Row,
  Screen,
  Section,
  Title,
} from "../ui";
import type { ScreenId } from "../types";

const labels: Record<ScreenId, string> = {
  S00: "홈",
  S01: "둘러보기",
  S02: "공고 상세",
  S03: "공고 작성",
  S04: "등록 전 확인",
  S05: "로그인",
  S06: "가입 프로필",
  S09: "카테고리",
  "S09-2": "행사 목록",
  "S09-3": "행사 상세",
  S10: "채팅 목록",
  S11: "대화방",
  S12: "알림",
  S13: "마이페이지",
  S14: "동행인 프로필",
  S15: "사진 편집",
  "S15-2": "성향 편집",
  S16: "확정 약속",
  S17: "후기 작성",
  S18: "신청 철회·약속 취소",
  S19: "안전 안내",
  S20: "AI 동행 탐색",
  S21: "계정 관리",
};
const ids: Partial<Record<ScreenId, string>> = {
  S02: "post-2",
  S11: "post-2",
  S14: "host",
  S16: "appointment-1",
  S17: "appointment-completed",
  S18: "post-1",
  "S09-3": "gallery",
};
export function PreviewScreen() {
  const app = useApp();
  const a = app.appointments.find((a) => a.id === "appointment-1");
  const completed = app.appointments.find(
    (a) => a.id === "appointment-completed",
  );
  return (
    <Screen title="프로토타입 확인 도구">
      <Badge>서비스 밖의 확인 화면</Badge>
      <Title large>화면과 정책 흐름을{"\n"}함께 확인해 보세요</Title>
      <Body muted>
        실제 가입·신고·결제·외부 AI 호출은 실행하지 않아요. 역할과 시간을 바꾸면
        기기의 예시 상태만 바뀝니다. 초안·최근 검색어만 계정별 기기 저장이며
        나머지는 새로고침하면 초기화됩니다.
      </Body>
      <Section title="체험 역할">
        <Row style={{ flexWrap: "wrap" }}>
          <Chip selected={!app.viewerId} onPress={() => void app.logout()}>
            비로그인
          </Chip>
          {[
            ["me", "신청자"],
            ["host", "작성자"],
            ["peer", "다른 회원"],
          ].map(([id, label]) => (
            <Chip
              key={id}
              selected={app.viewerId === id}
              onPress={() => app.login(id)}
            >
              {label}
            </Chip>
          ))}
        </Row>
      </Section>
      <Card>
        <Body>
          예시 시각:{" "}
          {new Date(app.now).toLocaleString("ko-KR", {
            timeZone: "Asia/Seoul",
          })}
        </Body>
        <Row style={{ flexWrap: "wrap" }}>
          {[
            [HOUR, "+1시간"],
            [6 * HOUR, "+6시간"],
            [DAY, "+24시간"],
            [7 * DAY, "+7일"],
          ].map(([ms, label]) => (
            <Chip
              key={String(label)}
              onPress={() => app.setPreview({ now: app.now + Number(ms) })}
            >
              {String(label)}
            </Chip>
          ))}
        </Row>
        {a && (
          <Button
            secondary
            onPress={() => app.setPreview({ now: a.endsAt + 1000 })}
          >
            예상 종료 직후로 이동
          </Button>
        )}
        <Button
          secondary
          onPress={() => app.setPreview({ failNext: !app.failNext })}
        >
          다음 처리 실패: {app.failNext ? "켜짐" : "꺼짐"}
        </Button>
        <Row style={{ flexWrap: "wrap" }}>
          {(["normal", "warning", "restricted", "permanent"] as const).map(
            (state, i) => (
              <Chip
                key={state}
                selected={app.accountStatus === state}
                onPress={() =>
                  app.setPreview({
                    accountStatus: state,
                    restrictionsEndAt:
                      state === "restricted" ? app.now + 7 * DAY : null,
                  })
                }
              >
                {["정상", "경고", "7일 제한", "영구 제한"][i]}
              </Chip>
            ),
          )}
        </Row>
      </Card>
      {completed && (
        <Section title="후기·분쟁 경계 확인">
          <Body small muted>
            완료된 예시 약속을 사용합니다. 공개 후 분쟁만으로 후기가 자동으로
            숨겨지지 않는지 확인하세요.
          </Body>
          <Row style={{ flexWrap: "wrap" }}>
            <Chip
              onPress={() => {
                app.login("host");
                app.navigate("S17", completed.id);
              }}
            >
              상대 후기 작성
            </Chip>
            <Chip
              onPress={() =>
                app.setPreview({
                  now: (reviewDeadline(completed) || app.now) + 1,
                })
              }
            >
              작성 마감으로 이동
            </Chip>
            <Chip
              onPress={() =>
                app.setPreview({
                  appointments: app.appointments.map((v) =>
                    v.id === completed.id
                      ? {
                          ...v,
                          status: "disputed",
                          disputeStartedAt: app.now,
                          reviewRemainingMs: Math.max(
                            0,
                            (reviewDeadline(v) || app.now) - app.now,
                          ),
                        }
                      : v,
                  ),
                })
              }
            >
              분쟁 시작
            </Chip>
            <Chip
              onPress={() =>
                app.setPreview({
                  appointments: app.appointments.map((v) =>
                    v.id === completed.id
                      ? {
                          ...v,
                          status: "completed",
                          reviewDeadlineAt:
                            app.now + Math.max(DAY, v.reviewRemainingMs || 0),
                          disputeStartedAt: undefined,
                        }
                      : v,
                  ),
                })
              }
            >
              분쟁 해소
            </Chip>
            <Chip
              onPress={() =>
                app.setPreview({
                  reviews: app.reviews.map((v) =>
                    v.appointmentId === completed.id
                      ? { ...v, hidden: !v.hidden }
                      : v,
                  ),
                })
              }
            >
              운영 숨김 전환
            </Chip>
          </Row>
          <Body small muted>
            현재 후기 {app.reviews.length}개 · 공개{" "}
            {
              app.reviews.filter(
                (r) => r.publishedAt !== undefined && !r.hidden && !r.invalid,
              ).length
            }
            개
          </Body>
        </Section>
      )}
      <Section title="로그인 예외 화면">
        <Row style={{ flexWrap: "wrap" }}>
          {[
            ["missing", "필수 정보 누락"],
            ["ineligible", "가입 자격 불충족"],
            ["connection", "네이버 연동 실패"],
          ].map(([example, label]) => (
            <Chip
              key={example}
              onPress={() =>
                router.push({ pathname: "/login", params: { example } })
              }
            >
              {label}
            </Chip>
          ))}
        </Row>
      </Section>
      <Section title="23개 화면">
        <Body small muted>
          S08 별도 신청 화면과 과거 AI 필수 동의 팝업은 제외했습니다.
        </Body>
        {(Object.keys(routes) as ScreenId[]).map((id) => (
          <Card
            key={id}
            onPress={() => app.navigate(id, ids[id])}
            style={{ padding: 15 }}
          >
            <Row between>
              <Body style={{ fontWeight: "600" }}>{labels[id]}</Body>
              <Body small muted>
                {id} ›
              </Body>
            </Row>
          </Card>
        ))}
      </Section>
      <Button secondary onPress={() => void app.reset()}>
        예시 상태와 기기 초안 초기화
      </Button>
      <Button onPress={() => app.navigate("S00")}>홈으로 돌아가기</Button>
    </Screen>
  );
}
