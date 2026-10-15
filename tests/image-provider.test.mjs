import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Match Next's extensionless local import while running the actual route in Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./vertex-retry" && context.parentURL?.includes("/app/api/generate-image/route.ts")) {
      return nextResolve(new URL("./vertex-retry.ts", context.parentURL).href, context);
    }
    if (specifier === "./toonout" && context.parentURL?.includes("/app/api/generate-image/route.ts")) {
      return nextResolve(new URL("./toonout.ts", context.parentURL).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const model = "gpt-image-2.5-sunburst";
const image = "data:image/png;base64,dGVzdA==";
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxKqWQAAAABJRU5ErkJggg==",
  "base64",
);
const transparentImage = `data:image/png;base64,${transparentPng.toString("base64")}`;
let routeVersion = 0;

async function setup(t, {
  environment = "production",
  key = "unused-test-key",
  failure = false,
  toonoutFailure = false,
} = {}) {
  const overrides = {
    NODE_ENV: environment,
    OPENAI_API_KEY: key,
    OPENAI_IMAGE_MODEL: "development-only-model",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    GOOGLE_CLOUD_PROJECT: undefined,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
    TOONOUT_WORKER_URL: "http://127.0.0.1:8091",
    TOONOUT_WORKER_TOKEN: "test-toonout-token",
  };
  const original = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
  function apply(values) {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  apply(overrides);
  t.after(() => apply(original));
  t.mock.method(console, "error", () => {});
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.origin === "http://127.0.0.1:8091") {
      assert.equal(request.headers.get("authorization"), "Bearer test-toonout-token");
      if (toonoutFailure) {
        return Response.json({ detail: "Model unavailable" }, { status: 503 });
      }
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", model: "joelseytre/toonout" });
      }
      assert.equal(url.pathname, "/remove-background");
      assert.equal(request.method, "POST");
      return new Response(transparentPng, { headers: { "content-type": "image/png" } });
    }

    assert.equal(url.origin, "https://api.openai.com", "No request may reach Vertex or another host");
    requests.push({
      path: url.pathname,
      body: request.headers.get("content-type")?.includes("multipart/form-data")
        ? await request.formData()
        : await request.json(),
    });
    return failure
      ? Response.json({ error: { message: "Test upstream failure", type: "server_error" } }, { status: 500 })
      : Response.json({ data: [{ b64_json: "dGVzdA==" }] });
  });
  const { POST } = await import(`../app/api/generate-image/route.ts?case=${++routeVersion}`);
  return {
    requests,
    post: (body) => POST(new Request("http://localhost/api/generate-image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Test character", ...body }),
    })),
  };
}

for (const provider of [undefined, "vertex", "openai"]) {
  for (const references of [0, 1, 2]) {
    test(`production forces GPT Image 2.5 with provider ${provider} and ${references} references`, async (t) => {
      const state = await setup(t);
      const response = await state.post({
        provider,
        ...(references > 0 ? { referenceImage: image } : {}),
        ...(references > 1 ? { secondaryReferenceImage: image } : {}),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        image: transparentImage,
        sourceImage: image,
        mimeType: "image/png",
        model,
        provider: "openai",
        backgroundRemovalModel: "joelseytre/toonout",
      });
      assert.equal(state.requests.length, 1);
      const request = state.requests[0];
      assert.equal(request.path, references ? "/v1/images/edits" : "/v1/images/generations");
      const payload = references ? Object.fromEntries(request.body) : request.body;
      assert.equal(payload.model, model, "Production ignores the development model override");
      assert.equal(payload.quality, "high");
      assert.equal(payload.size, "1024x1024");
      if (references) {
        const files = [...request.body.values()].filter((value) => value instanceof File);
        assert.equal(files.length, references);
      }
    });
  }
}

test("production without an OpenAI key fails without contacting Vertex", async (t) => {
  const state = await setup(t, { key: "" });
  const response = await state.post({ provider: "vertex" });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /OPENAI_API_KEY/);
  assert.equal(state.requests.length, 0);
});

test("an OpenAI failure never falls back to Vertex in production", async (t) => {
  const state = await setup(t, { failure: true });
  const response = await state.post({ provider: "vertex" });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /OpenAI image generation failed/);
  assert.equal(state.requests.length, 1);
});

test("development allows the OpenAI provider and model override", async (t) => {
  const state = await setup(t, { environment: "development" });
  const response = await state.post({ provider: "openai" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, "development-only-model");
  assert.equal(state.requests.length, 1);
});

test("development still allows Vertex selection", async (t) => {
  const state = await setup(t, { environment: "development" });
  const response = await state.post({ provider: "vertex" });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /GOOGLE_CLOUD_PROJECT/);
  assert.equal(state.requests.length, 0);
});

test("an unavailable ToonOut worker prevents a paid image request", async (t) => {
  const state = await setup(t, { toonoutFailure: true });
  const response = await state.post({ provider: "openai" });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ToonOut/);
  assert.equal(state.requests.length, 0);
});
