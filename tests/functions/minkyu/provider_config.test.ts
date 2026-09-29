/** 공급사 비밀값은 가상 값만 사용한다. 실제 키·네트워크·모델 지원 여부를 검사하지 않는다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { loadKakaoConfig, loadKopisConfig, loadSeoulOpenDataConfig, loadTourApiConfig, loadPotensLlmConfig } from "../../../backend/supabase/functions/_shared/config/providers.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { EnvReader } from "../../../backend/supabase/functions/_shared/config/env.ts";

const llm = { POTENS_API_KEY: "fixture-private-llm-key", POTENS_API_BASE_URL: "https://provider.example.invalid", POTENS_MODEL: "fixture/model-id", UPSTREAM_TIMEOUT_MS: "2500" };
const reader = (values: Record<string, string | undefined>): EnvReader => (key) => values[key];
const unavailable = (error: unknown) => {
  assert.deepEqual(toPublicError(error), { status: 503, error: { code: "EXTERNAL_UNAVAILABLE", message: "외부 서비스를 일시적으로 사용할 수 없습니다.", retryable: true } });
  assert.doesNotMatch(String(error), /fixture-private|secret-exception/);
  return true;
};
const simple = [
  [loadKakaoConfig, "KAKAO_REST_API_KEY", "kakao"],
  [loadKopisConfig, "KOPIS_API_KEY", "kopis"],
  [loadSeoulOpenDataConfig, "SEOUL_OPEN_DATA_API_KEY", "seoul-open-data"],
] as const;

test("기능별 loader는 자기 키만 읽어 다른 미설정 기능과 독립적이다", () => {
  for (const [load, key, provider] of simple) {
    const accessed: string[] = [];
    const config = load((name) => { accessed.push(name); assert.equal(name, key); return "fixture-private-feature-key"; });
    assert.equal(config.apiKey, "fixture-private-feature-key");
    assert.equal(config.provider, provider);
    assert.deepEqual(accessed, [key]);
    assert.ok(Object.isFrozen(config));
  }
  const accessed: string[] = [];
  loadPotensLlmConfig((key) => { accessed.push(key); assert.ok(key in llm); return llm[key as keyof typeof llm]; });
  assert.equal(accessed.length, 4);
});

test("필수 키의 누락·빈 값·양끝 공백·개행·제어 문자를 실패 처리한다", () => {
  for (const [load, key] of simple) {
    for (const value of [undefined, "", " private", "private ", "private\r\nsecret", "private\nsecret", "private\0secret"]) {
      assert.throws(() => load(reader({ [key]: value })), unavailable);
    }
  }
  assert.throws(() => loadTourApiConfig(reader({})), unavailable);
});

test("설정의 JSON·열거·기본 로그는 비밀값을 숨기고 명시적 접근은 유지한다", () => {
  const values = [
    ...simple.map(([load, key]) => load(reader({ [key]: "fixture-private-feature-key" }))),
    loadTourApiConfig(reader({ TOUR_API_SERVICE_KEY: "fixture-private-tour%2Bkey" })),
    loadPotensLlmConfig(reader(llm)),
  ];
  for (const config of values) {
    assert.deepEqual(Object.keys(config), ["provider"]);
    assert.deepEqual({ ...config }, { provider: config.provider });
    assert.deepEqual(JSON.parse(JSON.stringify(config)), { provider: config.provider, configured: true });
    assert.doesNotMatch(JSON.stringify(Object.entries(config)), /fixture-private/);
    assert.doesNotMatch(inspect(config), /fixture-private/);
    assert.doesNotMatch(inspect({ nested: config }), /fixture-private/);
    assert.ok(Object.isFrozen(config));
  }
});

test("TourAPI 형식 미입력은 unknown이며 키 원문을 추측·인코딩하지 않는다", () => {
  const original = "fixture-private+a/b=%2B%2F%3D";
  for (const keyFormat of [undefined, "", "unknown", "encoded", "decoded"]) {
    const config = loadTourApiConfig(reader({ TOUR_API_SERVICE_KEY: original, TOUR_API_KEY_FORMAT: keyFormat }));
    assert.equal(config.serviceKey, original);
    assert.equal(config.keyFormat, keyFormat || "unknown");
  }
  for (const keyFormat of ["ENCODED", " decoded", "decoded ", "guess", "unknown\n"]) {
    assert.throws(() => loadTourApiConfig(reader({ TOUR_API_SERVICE_KEY: original, TOUR_API_KEY_FORMAT: keyFormat })), unavailable);
  }
});

test("Potens는 명시된 LLM 키·origin·모델 ID·타임아웃만 사용한다", () => {
  const config = loadPotensLlmConfig(reader(llm));
  assert.equal(config.apiKey, llm.POTENS_API_KEY);
  assert.equal(config.baseUrl, llm.POTENS_API_BASE_URL);
  assert.equal(config.model, "fixture/model-id");
  assert.equal(config.upstreamTimeoutMs, 2500);
  assert.equal(loadPotensLlmConfig(reader({ ...llm, POTENS_API_BASE_URL: `${llm.POTENS_API_BASE_URL}/` })).baseUrl, `${llm.POTENS_API_BASE_URL}/`);
  for (const key of Object.keys(llm)) {
    for (const value of [undefined, "", " ", "\r\nfixture-private"]) {
      assert.throws(() => loadPotensLlmConfig(reader({ ...llm, [key]: value })), unavailable);
    }
  }
});

test("Potens URL은 HTTPS origin만 받고 인증 정보·query·fragment·경로를 거절한다", () => {
  for (const url of ["http://provider.example.invalid", "https://user:secret@provider.example.invalid", "https://provider.example.invalid/?key=secret", "https://provider.example.invalid/#key", "https://provider.example.invalid/v1", "https://provider.example.invalid/../", "https://provider.example.invalid?", "https://provider.example.invalid#", "not-a-url"]) {
    assert.throws(() => loadPotensLlmConfig(reader({ ...llm, POTENS_API_BASE_URL: url })), unavailable);
  }
});

test("모델 ID를 자동 추정하지 않고 잘못된 모델 입력·타임아웃을 거절한다", () => {
  for (const model of ["Sonnet 5", " provider-model", "provider\nmodel", "한글모델", "/model", "m".repeat(257)]) {
    assert.throws(() => loadPotensLlmConfig(reader({ ...llm, POTENS_MODEL: model })), unavailable);
  }
  for (const timeout of ["0", "-1", "1.5", "1e3", "01", "2147483648", "9007199254740992"]) {
    assert.throws(() => loadPotensLlmConfig(reader({ ...llm, UPSTREAM_TIMEOUT_MS: timeout })), unavailable);
  }
});

test("EnvReader 예외의 원문·비밀값을 공개 오류에 포함하지 않는다", () => {
  for (const load of [loadKakaoConfig, loadKopisConfig, loadSeoulOpenDataConfig, loadTourApiConfig, loadPotensLlmConfig]) {
    assert.throws(() => load(() => { throw new Error("secret-exception fixture-private-key"); }), unavailable);
  }
});
