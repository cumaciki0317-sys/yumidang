/** 연결 진단의 실패 보고·원문 비노출·실제 코어 실행을 검증한다. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { checkSearchCore, runSearchCoreCheck } from "../../../tools/local/check_search_core.ts";

test("정규화 실패를 BLOCKED로 기록하고 다른 검사는 계속한다", async () => {
  const report = await checkSearchCore({ normalize() { throw new Error("private-key-and-query"); } });
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.probes.length, 7);
  assert.equal(report.probes.find((probe) => probe.name === "default_created_desc_all")?.reason, "CORE_PROBE_FAILED");
  assert.equal(report.probes.find((probe) => probe.name === "sensitive_wire_field_rejected")?.status, "PASS");
  assert.doesNotMatch(JSON.stringify(report), /private-key-and-query/);
});

test("RPC를 호출하지 않는 어댑터는 통과시키지 않는다", async () => {
  const report = await checkSearchCore({ repository() { return { async searchPage() { return { items: [], nextCursor: null }; } }; } });
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.probes.find((probe) => probe.name === "dong_public_projection")?.status, "BLOCKED");
  assert.equal(report.probes.find((probe) => probe.name === "sensitive_wire_field_rejected")?.reason, "EXPECTED_REJECTION");
});

test("진단 CLI는 BLOCKED일 때 nonzero이고 실제 DB/HTTP 미실행을 명시한다", async () => {
  const output: string[] = [];
  const exit = await runSearchCoreCheck((line) => output.push(line), { normalize() { throw new Error("AUTH_REQUIRED"); } });
  assert.equal(exit, 1);
  assert.equal(output.length, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.realDatabase, "NOT_RUN");
  assert.equal(report.deployedHttp, "NOT_RUN");
});

test("실제 CLI의 종료 코드는 실제 코어 검사와 일치하며 오류 원문을 출력하지 않는다", async () => {
  const expected = await checkSearchCore();
  const result = spawnSync(process.execPath, ["tools/local/check_search_core.ts"], {
    cwd: new URL("../../../", import.meta.url), encoding: "utf8",
  });
  assert.equal(result.status, expected.status === "READY" ? 0 : 1);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(expected.status, expected.probes.every((probe) => probe.status === "PASS") ? "READY" : "BLOCKED");
});
