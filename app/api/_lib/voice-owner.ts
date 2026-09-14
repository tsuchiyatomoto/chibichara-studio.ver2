import "server-only";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

import { getIrodoriHeaders } from "./irodori";

const OWNER_COOKIE = "chibichara-voice-owner";
const OWNER_PATTERN = /^anon_[a-f0-9]{32}$/;

export async function getVoiceOwnerId() {
  const cookieStore = await cookies();
  const existing = cookieStore.get(OWNER_COOKIE)?.value;
  if (existing && OWNER_PATTERN.test(existing)) {
    return existing;
  }

  const ownerId = `anon_${randomUUID().replaceAll("-", "")}`;
  cookieStore.set(OWNER_COOKIE, ownerId, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  return ownerId;
}

export async function getScopedIrodoriHeaders(includeJsonContentType = false) {
  const headers = getIrodoriHeaders();
  if (includeJsonContentType) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("X-Irodori-Owner-ID", await getVoiceOwnerId());
  return headers;
}
