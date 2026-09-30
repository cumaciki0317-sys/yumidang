// 포텐스닷 어댑터 가상 검사. fetch는 주입한 가상 응답이며 실제 공급사 호출·모델 품질 검증이 아니다.
import test from "node:test";
import assert from "node:assert/strict";
import { createPotensModel, parseStructuredMessage, buildPotensPrompt, POTENS_PROMPT_OVERHEAD_BYTES }
  from "../../../backend/supabase/functions/_shared/ai/providers/potens-adapter.ts";

const KEY = "synthetic_key_value";
const base = { apiKey: KEY, baseUrl: "https://ai.potens.ai", model: "claude-5-sonnet", timeoutMs: 1000 };
const req = { task: "intent", system: "규칙", input: { messages: [{ role: "user", content: "PRIVATE_BODY" }] }, maxOutputTokens: 50 };
function model(respond, extra = {}) {
  const calls = [];
  const port = createPotensModel({ ...base, ...extra, fetch: async (url, init) => { calls.push({ url, init }); return respond(url, init); } });
  return { port, calls };
}
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("확인된 계약만 전송: POST /api/chat, Bearer, {prompt, model}. system/max_tokens 필드를 만들지 않음", async () => {
  const { port, calls } = model(() => ok({ message: '{"status":"search","filters":{"target":"posts"}}', token_usage: { a: 1 } }));
  const response = await port.generate(req);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ai.potens.ai/api/chat");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer " + KEY);
  assert.equal(calls[0].init.redirect, "error");
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(sent).sort(), ["model", "prompt"]);
  assert.equal(sent.model, "claude-5-sonnet");
  assert.equal(sent.prompt, buildPotensPrompt(req));
  assert.deepEqual(response.value, { status: "search", filters: { target: "posts" } });
  assert.equal(response.modelVersion, "potens.claude-5-sonnet");
  assert.equal(response.reportedModel, undefined);
});

test("token_usage 필드 이름이 설정으로 확인되지 않았으면 usage=null (0으로 채우지 않음)", async () => {
  const { port } = model(() => ok({ message: "{}", token_usage: { input_tokens: 10, output_tokens: 3 } }));
  assert.equal((await port.generate(req)).usage, null);
  const configured = model(() => ok({ message: "{}", token_usage: { in_t: 10, out_t: 3 } }), { usageFields: { input: "in_t", output: "out_t" } });
  assert.deepEqual((await configured.port.generate(req)).usage, { inputTokens: 10, outputTokens: 3 });
  const missing = model(() => ok({ message: "{}", token_usage: { in_t: 10 } }), { usageFields: { input: "in_t", output: "out_t" } });
  assert.equal((await missing.port.generate(req)).usage, null);
  const noUsage = model(() => ok({ message: "{}" }), { usageFields: { input: "in_t", output: "out_t" } });
  assert.equal((await noUsage.port.generate(req)).usage, null);
});

test("응답 model 필드는 보고값으로만 구분하고 요청 설정 표식과 섞지 않음", async () => {
  const { port } = model(() => ok({ message: "{}", token_usage: {}, model: "vendor-reported-x" }));
  const response = await port.generate(req);
  assert.equal(response.modelVersion, "potens.claude-5-sonnet");
  assert.equal(response.reportedModel, "vendor-reported-x");
});

test("message 구조화: JSON 객체 또는 코드 울타리 한 겹만 허용", () => {
  assert.deepEqual(parseStructuredMessage('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseStructuredMessage(' {"a":1} '), { a: 1 });
  for (const bad of ["설명 {\"a\":1}", "[1,2]", "null", "```\n{\"a\":1}\n``` 추가", "{\"a\":"]) {
    assert.throws(() => parseStructuredMessage(bad), /INVALID_MODEL_RESPONSE/, bad);
  }
});

test("HTTP 상태·본문 오류를 안전한 코드로 변환하고 키·원문을 오류에 넣지 않음", async () => {
  const cases = [
    [() => new Response("x", { status: 401 }), "PROVIDER_REJECTED"],
    [() => new Response("User is not approved", { status: 403 }), "PROVIDER_REJECTED"],
    [() => new Response("{}", { status: 429 }), "RATE_LIMITED"],
    [() => new Response("{}", { status: 502 }), "MODEL_UNAVAILABLE"],
    [() => new Response("{}", { status: 400 }), "PROVIDER_REJECTED"],
    [() => new Response("not json", { status: 200 }), "INVALID_MODEL_RESPONSE"],
    [() => ok({ message: "" }), "INVALID_MODEL_RESPONSE"],
    [() => ok({ message: "그냥 문장입니다 PRIVATE_BODY" }), "INVALID_MODEL_RESPONSE"],
    [() => ok([1]), "INVALID_MODEL_RESPONSE"],
    [() => { throw new TypeError("network " + KEY); }, "MODEL_UNAVAILABLE"],
  ];
  for (const [respond, code] of cases) {
    const { port } = model(respond);
    await assert.rejects(port.generate(req), (error) => {
      assert.equal(error.message, code);
      assert.doesNotMatch(String(error.stack) + JSON.stringify(error), new RegExp(KEY + "|PRIVATE_BODY|approved"));
      return true;
    });
  }
});

test("취소·시간 초과는 CANCELLED·TIMEOUT으로 구분", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const slow = createPotensModel({ ...base, timeoutMs: 20, fetch: hang });
  await assert.rejects(slow.generate(req), /TIMEOUT/);
  const controller = new AbortController();
  const cancellable = createPotensModel({ ...base, timeoutMs: 5000, fetch: hang });
  const pending = cancellable.generate({ ...req, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /CANCELLED/);
  const pre = new AbortController(); pre.abort(); let called = 0;
  await assert.rejects(createPotensModel({ ...base, fetch: async () => { called++; return ok({ message: "{}" }); } }).generate({ ...req, signal: pre.signal }), /CANCELLED/);
  assert.equal(called, 0);
});

test("확인된 공급사 origin·모델 ID 형식 밖의 설정은 호출 전에 거절(임의 호스트로 키 전송 금지)", () => {
  const fetch = async () => ok({ message: "{}" });
  for (const bad of [{ baseUrl: "https://potens.ai" }, { baseUrl: "http://ai.potens.ai" }, { baseUrl: "https://evil.example" },
    { model: "Sonnet 5" }, { apiKey: "has space" }, { apiKey: "" }, { timeoutMs: 0 }, { usageFields: { input: "a", output: "a" } }]) {
    assert.throws(() => createPotensModel({ ...base, fetch, ...bad }), /NOT_CONFIGURED/, JSON.stringify(Object.keys(bad)));
  }
  assert.ok(POTENS_PROMPT_OVERHEAD_BYTES > 0);
});
