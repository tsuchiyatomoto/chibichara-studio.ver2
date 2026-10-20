import "server-only";
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const MOVIE_PREFIX = "movie-temp/";
export const MOVIE_TTL = 24 * 60 * 60;
export const CHUNK_BYTES = 8 * 1024 ** 2;

export class MovieHttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

let configuredStorage: { bucket: string; client: S3Client } | undefined;

function storage() {
  if (configuredStorage) return configuredStorage;
  const bucket = process.env.MOVIE_S3_BUCKET;
  if (!bucket) throw new MovieHttpError(503, "動画の一時保存先が設定されていません。");
  configuredStorage = { bucket, client: new S3Client({
    maxAttempts: 2,
    // R2-compatible optional checksum behavior. Movie inputs have SHA-256
    // integrity checks in addition to the storage transport.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
    region: process.env.MOVIE_S3_REGION || "auto",
    endpoint: process.env.MOVIE_S3_ENDPOINT || undefined,
    forcePathStyle: process.env.MOVIE_S3_FORCE_PATH_STYLE === "true",
    credentials: process.env.MOVIE_S3_ACCESS_KEY_ID ? {
      accessKeyId: process.env.MOVIE_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.MOVIE_S3_SECRET_ACCESS_KEY || "",
    } : undefined,
  }) };
  return configuredStorage;
}

export async function readJson<T>(key: string): Promise<{ value: T; etag: string }> {
  const { bucket, client } = storage();
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { value: JSON.parse(await result.Body!.transformToString()), etag: result.ETag! };
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") throw new MovieHttpError(404, "動画が見つからないか、保存期限が終了しました。");
    throw error;
  }
}

export async function readFile(key: string, limit: number) {
  const { bucket, client } = storage();
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const stream = result.Body!.transformToWebStream();
    if ((result.ContentLength ?? 0) > limit) { await stream.cancel(); throw new MovieHttpError(413, "ファイルが大きすぎます。"); }
    return limitedBody(new Request("http://internal", { method: "POST", body: stream, duplex: "half" } as RequestInit), limit);
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") throw new MovieHttpError(404, "ファイルが見つかりません。");
    throw error;
  }
}

export async function putFile(key: string, body: Uint8Array | string, contentType: string, condition?: { IfMatch?: string; IfNoneMatch?: string }) {
  const { bucket, client } = storage();
  try {
    return await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ...condition }));
  } catch (error) {
    if (["PreconditionFailed", "ConditionalRequestConflict"].includes((error as { name?: string }).name || "")) {
      throw new MovieHttpError(409, "別の操作が進行しています。状態を再取得してください。");
    }
    throw error;
  }
}

export async function listKeys(prefix: string) {
  const { bucket, client } = storage();
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const item of page.Contents || []) if (item.Key) keys.push(item.Key);
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}

export async function deletePrefix(prefix: string) {
  const keys = await listKeys(prefix);
  const { bucket, client } = storage();
  for (let index = 0; index < keys.length; index += 1000) {
    const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(index, index + 1000).map(Key => ({ Key })) } }));
    if (result.Errors?.length) throw new MovieHttpError(503, "一時ファイルを削除できませんでした。");
  }
}

export async function downloadUrl(key: string, expires: number, name: string) {
  const { bucket, client } = storage();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key,
    ResponseContentDisposition: `attachment; filename="${name}"`,
  }), { expiresIn: Math.max(1, Math.min(900, Math.floor(expires - Date.now() / 1000))) });
}

export async function limitedBody(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new MovieHttpError(400, "データがありません。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new MovieHttpError(413, "送信サイズが上限を超えています。"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}
