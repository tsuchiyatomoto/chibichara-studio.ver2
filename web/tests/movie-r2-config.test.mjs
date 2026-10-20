import assert from "node:assert/strict";
import test from "node:test";
import { configureMovieR2, MOVIE_R2_RULE } from "../scripts/configure-movie-r2.mjs";

const env = { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "test-secret", MOVIE_S3_BUCKET: "movie-test" };
const response = rules => Response.json({ success: true, result: { rules } });

test("R2 check reads the current rule without changing the bucket", async () => {
  const methods = [];
  const result = await configureMovieR2({ env, fetcher: async (url, init) => {
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/movie-test/lifecycle`);
    methods.push(init.method);
    return response([]);
  } });
  assert.equal(result.configured, false);
  assert.deepEqual(methods, ["GET"]);
});

test("R2 apply preserves unrelated rules, sets a 24-hour expiry and verifies by read-back", async () => {
  const keep = { id: "existing-rule", enabled: true, conditions: { prefix: "other/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 604800 } } };
  let rules = [keep, { ...MOVIE_R2_RULE, enabled: false }];
  const methods = [];
  const fetcher = async (_url, init) => {
    methods.push(init.method);
    if (init.method === "PUT") { rules = JSON.parse(init.body).rules; return Response.json({ success: true, result: {} }); }
    return response(rules);
  };
  const result = await configureMovieR2({ env, fetcher, apply: true });
  assert.equal(result.configured, true);
  assert.deepEqual(methods, ["GET", "PUT", "GET"]);
  assert.deepEqual(rules, [keep, MOVIE_R2_RULE]);
  methods.length = 0;
  await configureMovieR2({ env, fetcher, apply: true });
  assert.deepEqual(methods, ["GET"]);
});

test("R2 apply fails when the read-back does not contain the requested rule", async () => {
  await assert.rejects(configureMovieR2({ env, apply: true, fetcher: async () => response([]) }), /could not be verified/);
});

test("missing credentials stop before any request; provider responses are not included in errors", async () => {
  let calls = 0;
  await assert.rejects(configureMovieR2({ env: {}, fetcher: () => { calls++; } }), /CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(calls, 0);
  await assert.rejects(configureMovieR2({ env, fetcher: async () => new Response(env.CLOUDFLARE_API_TOKEN, { status: 403 }) }), error => {
    assert.ok(error.message.includes("HTTP 403"));
    assert.ok(!error.message.includes(env.CLOUDFLARE_API_TOKEN));
    return true;
  });
});
