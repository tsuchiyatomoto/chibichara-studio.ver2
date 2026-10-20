import { getVoiceOwnerId } from "../../_lib/voice-owner";
import { movieServerless } from "../../_lib/movie-serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const parts = (await context.params).path;
  if (
    !parts.every(
      (part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== "..",
    )
  ) {
    return Response.json({ error: "パスが不正です。" }, { status: 400 });
  }
  const origin = request.headers.get("origin");
  if (
    origin &&
    (!URL.canParse(origin) ||
      new URL(origin).host !== request.headers.get("host"))
  ) {
    return Response.json(
      { error: "この送信元からは操作できません。" },
      { status: 403 },
    );
  }
  try {
    if (process.env.MOVIE_BACKEND === "runpod") {
      return await movieServerless(request, parts, await getVoiceOwnerId());
    }
    const token = process.env.MOVIE_WORKER_TOKEN;
    if (!token) throw new Error("Movie worker token is not configured.");
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "X-Movie-Owner": await getVoiceOwnerId(),
    });
    for (const name of ["content-type", "range", "if-range"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const hasBody = !["GET", "HEAD"].includes(request.method);
    const url = `${(process.env.MOVIE_WORKER_URL || "http://127.0.0.1:8090").replace(/\/+$/, "")}/${parts.join("/")}${new URL(request.url).search}`;
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      cache: "no-store",
      signal: request.signal,
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
    };
    const response = await fetch(url, init);
    const resultHeaders = new Headers({ "Cache-Control": "private, no-store" });
    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "content-disposition",
      "etag",
      "last-modified",
    ]) {
      const value = response.headers.get(name);
      if (value) resultHeaders.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      headers: resultHeaders,
    });
  } catch {
    return Response.json(
      {
        error:
          "動画処理サーバーに接続できません。Movieサーバーの起動状態を確認してください。",
      },
      { status: 503 },
    );
  }
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
