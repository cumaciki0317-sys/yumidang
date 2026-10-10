import { test } from "node:test";
import assert from "node:assert/strict";
import { readCompletionConfig } from "../../../backend/supabase/functions/scheduled-jobs/completion-runner.mjs";
const config = { COMPLETION_DATABASE_URL: "postgresql://synthetic_login:synthetic_secret@127.0.0.1:56532/postgres", COMPLETION_RECONNECT_MS: "5000", COMPLETION_QUERY_TIMEOUT_MS: "10000" };

test("explicit TLS requires verification on every supported loopback authority", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const env = { ...config, COMPLETION_DATABASE_URL: `postgresql://synthetic_login:synthetic_secret@${host}:56532/postgres` };
    assert.equal(readCompletionConfig(env).ssl, false);
    assert.deepEqual(readCompletionConfig({ ...env, COMPLETION_REQUIRE_TLS: "true" }).ssl, { rejectUnauthorized: true });
  }
});
test("remote TLS remains mandatory and malformed requirement values never downgrade it", () => {
  for (const host of ["127.0.0.1", "db.test"]) {
    const env = { ...config, COMPLETION_DATABASE_URL: `postgresql://synthetic_login:synthetic_secret@${host}/postgres` };
    if (host === "db.test") assert.deepEqual(readCompletionConfig(env).ssl, { rejectUnauthorized: true });
    for (const value of ["false", "0", "1", "TRUE", "true ", ""]) assert.throws(() => readCompletionConfig({ ...env, COMPLETION_REQUIRE_TLS: value }), /^Error: INVALID_COMPLETION_CONFIG$/);
  }
});
test("TLS requirement cannot authorize connection query overrides or URL fragments", () => {
  for (const suffix of ["?sslmode=disable", "?host=other.test", "#ignored"]) assert.throws(() => readCompletionConfig({ ...config, COMPLETION_REQUIRE_TLS: "true", COMPLETION_DATABASE_URL: config.COMPLETION_DATABASE_URL + suffix }), /^Error: INVALID_COMPLETION_CONFIG$/);
});
