import test from "node:test";
import assert from "node:assert/strict";
import {
  collectEventDetail,
  createKopisDetailProvider,
  parseKopisDetailXml,
} from "../../../backend/supabase/functions/_shared/integrations/events/detail.ts";
const now = "2026-10-05T00:00:00Z";
const xml = (extra = "") =>
  `<dbs><db><mt20id>PF123</mt20id><prfpdfrom>2026.10.01</prfpdfrom><prfpdto>2026.10.31</prfpdto><pcseguidance>전석 30,000원</pcseguidance><dtguidance>화요일 20:00</dtguidance><sty>가상 줄거리</sty><styurls><styurl>http://www.kopis.or.kr/upload/example.jpg</styurl></styurls>${extra}</db></dbs>`;
test("공식 원천 가격/운영시간/줄거리만 사용하며 HTTP 포스터를 임의 변환하지 않는다", () => {
  const data = parseKopisDetailXml(
    xml("<poster>http://www.kopis.or.kr/upload/example.jpg</poster>"),
    "PF123",
    now,
  );
  assert.deepEqual(data.admission, {
    kind: "described",
    text: "전석 30,000원",
  });
  assert.equal(data.operatingInfo, "화요일 20:00");
  assert.equal(data.posterUrl, null);
  assert.throws(() => parseKopisDetailXml(xml(), "PF999", now));
  assert.throws(() =>
    parseKopisDetailXml(xml("<unknown>1</unknown>"), "PF123", now)
  );
});
test("상세 영속 포트가 없으면 외부 호출하지 않는다", async () => {
  let n = 0;
  const provider = {
    provider: "kopis",
    async fetchDetail() {
      n++;
    },
  };
  assert.equal(
    (await collectEventDetail(provider, "PF123")).status,
    "not_enabled",
  );
  assert.equal(n, 0);
});
test("상세 HTTP는 고정 HTTPS API와 원천 ID만 요청", async () => {
  const calls = [];
  const provider = createKopisDetailProvider({
    apiKey: "SYNTHETIC",
    timeoutMs: 1000,
    now: () => new Date(now),
    fetch: async (url, init) => {
      calls.push([url, init]);
      return new Response(xml(), {
        headers: { "content-type": "application/xml" },
      });
    },
  });
  const data = await provider.fetchDetail("PF123");
  assert.equal(data.sourceId, "PF123");
  assert.equal(new URL(calls[0][0]).pathname, "/openApi/restful/pblprfr/PF123");
  assert.equal(calls[0][1].redirect, "error");
});

test("진행 중 상세 갱신도 줄거리·운영정보·공식 HTTPS포스터를 원천 저장 DTO까지 보존한다", async () => {
  const { toWireEvent } = await import(
    "../../../backend/supabase/functions/_shared/db/repositories/events.ts"
  );
  const provider = createKopisDetailProvider({
    apiKey: "SYNTHETIC",
    timeoutMs: 1000,
    now: () => new Date(now),
    fetch: async () =>
      new Response(
        xml(
          "<prfnm>합성공연</prfnm><fcltynm>합성극장</fcltynm><prfstate>공연중</prfstate><genrenm>뮤지컬</genrenm><area>서울</area><poster>https://www.kopis.or.kr/upload/example.jpg</poster>",
        ),
        { headers: { "content-type": "application/xml" } },
      ),
  });
  const source = await provider.fetchSourceEvent("PF123"),
    wire = toWireEvent(source);
  assert.equal(wire.description, "가상 줄거리");
  assert.equal(wire.operatingInfo, "화요일 20:00");
  assert.equal(wire.posterUrl, "https://www.kopis.or.kr/upload/example.jpg");
  assert.equal(
    Object.hasOwn(
      toWireEvent({ ...source, description: null, posterUrl: undefined }),
      "description",
    ),
    false,
  );
});
