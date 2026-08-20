import { ApiError, GoogleGenAI, Modality, ThinkingLevel } from "@google/genai";
import { statSync } from "node:fs";
import OpenAI, { APIConnectionTimeoutError, toFile } from "openai";

export const runtime = "nodejs";

const VERTEX_MODEL_ID =
  process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image";
const OPENAI_MODEL_ID = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? "global";
const OPENAI_TIMEOUT_MS = 5 * 60 * 1000;
const VERTEX_RETRY_ATTEMPTS = 6;
const MAX_PROMPT_LENGTH = 2000;
const MAX_REFERENCE_IMAGE_BYTES = 5 * 1024 * 1024;

type RequestBody = {
  prompt?: unknown;
  referenceImage?: unknown;
  secondaryReferenceImage?: unknown;
  provider?: unknown;
};

type ImageProvider = "vertex" | "openai";

type InlineImage = {
  data: string;
  mimeType: string;
};

type ResponsePart = {
  inlineData?: {
    data?: string;
    mimeType?: string;
  };
};

type GenerateContentLike = {
  candidates?: Array<{
    content?: {
      parts?: ResponsePart[];
    };
    finishMessage?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
};

function jsonError(message: string, status: number, detail?: string) {
  return Response.json(
    {
      error: message,
      ...(detail ? { detail } : {}),
    },
    { status },
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function isVertexResourceExhausted(error: unknown) {
  if (error instanceof ApiError && error.status === 429) {
    return true;
  }

  return /(?:\b429\b|RESOURCE_EXHAUSTED|Too Many Requests|resource (?:has been )?exhausted)/i.test(
    getErrorMessage(error),
  );
}

function getCredentialFileError() {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!path) {
    return;
  }

  try {
    if (!statSync(path).isFile()) {
      return `GOOGLE_APPLICATION_CREDENTIALS must point to a JSON file, but this path is not a file: ${path}`;
    }
  } catch {
    return `GOOGLE_APPLICATION_CREDENTIALS points to a missing file: ${path}`;
  }
}

function parseReferenceImage(
  value: unknown,
  fieldName: "referenceImage" | "secondaryReferenceImage",
): InlineImage | undefined {
  if (value === undefined || value === null || value === "") {
    return;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a base64 image data URL.`);
  }

  const match = value.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/,
  );

  if (!match) {
    throw new Error(
      `${fieldName} must be a PNG, JPEG, or WebP data URL.`,
    );
  }

  const [, mimeType, data] = match;
  const byteLength = Buffer.from(data, "base64").byteLength;

  if (byteLength === 0 || byteLength > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`${fieldName} must be between 1 byte and 5 MB.`);
  }

  return { data, mimeType };
}

function findFirstImage(response: GenerateContentLike): InlineImage | undefined {
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inlineData = part.inlineData;

      if (inlineData?.data && inlineData.mimeType?.startsWith("image/")) {
        return {
          data: inlineData.data,
          mimeType: inlineData.mimeType,
        };
      }
    }
  }
}

export async function POST(request: Request) {
  let body: RequestBody;

  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return jsonError("Send a JSON body.", 400);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (!prompt) {
    return jsonError("prompt is required.", 400);
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return jsonError(
      `prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`,
      400,
    );
  }

  let referenceImage: InlineImage | undefined;
  let secondaryReferenceImage: InlineImage | undefined;

  try {
    referenceImage = parseReferenceImage(body.referenceImage, "referenceImage");
    secondaryReferenceImage = parseReferenceImage(
      body.secondaryReferenceImage,
      "secondaryReferenceImage",
    );
  } catch (error) {
    return jsonError(getErrorMessage(error), 400);
  }

  if (secondaryReferenceImage && !referenceImage) {
    return jsonError(
      "secondaryReferenceImage requires referenceImage.",
      400,
    );
  }

  const provider: ImageProvider =
    process.env.NODE_ENV === "development" && body.provider === "openai"
      ? "openai"
      : "vertex";

  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      return jsonError("Set OPENAI_API_KEY in .env.local.", 500);
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 0,
      timeout: OPENAI_TIMEOUT_MS,
    });

    try {
      let response;

      if (referenceImage) {
        const referenceImages = [
          referenceImage,
          ...(secondaryReferenceImage ? [secondaryReferenceImage] : []),
        ];
        const imageFiles = await Promise.all(
          referenceImages.map((image, index) => {
            const extension =
              image.mimeType === "image/jpeg"
                ? "jpg"
                : image.mimeType.split("/")[1];

            return toFile(
              Buffer.from(image.data, "base64"),
              `reference-${index + 1}.${extension}`,
              { type: image.mimeType },
            );
          }),
        );

        response = await openai.images.edit({
          model: OPENAI_MODEL_ID,
          image: imageFiles.length === 1 ? imageFiles[0] : imageFiles,
          prompt,
          background: "opaque",
          output_format: "png",
          quality: "high",
          size: "1024x1024",
        });
      } else {
        response = await openai.images.generate({
          model: OPENAI_MODEL_ID,
          prompt,
          background: "opaque",
          output_format: "png",
          quality: "high",
          size: "1024x1024",
        });
      }

      const imageData = response.data?.[0]?.b64_json;

      if (!imageData) {
        return Response.json(
          {
            error: "No image was returned. Try a different prompt.",
            model: OPENAI_MODEL_ID,
            provider,
          },
          { status: 502 },
        );
      }

      return Response.json({
        image: `data:image/png;base64,${imageData}`,
        mimeType: "image/png",
        model: OPENAI_MODEL_ID,
        provider,
      });
    } catch (error) {
      console.error("OpenAI image generation failed:", error);

      if (error instanceof APIConnectionTimeoutError) {
        return jsonError(
          "GPT Image 2 generation timed out. Please try again.",
          504,
          process.env.NODE_ENV === "development"
            ? `The request exceeded ${OPENAI_TIMEOUT_MS / 1000} seconds.`
            : undefined,
        );
      }

      return jsonError(
        "OpenAI image generation failed. Check server logs and OPENAI_API_KEY.",
        500,
        process.env.NODE_ENV === "development"
          ? getErrorMessage(error)
          : undefined,
      );
    }
  }

  if (!process.env.GOOGLE_CLOUD_PROJECT) {
    return jsonError(
      "Set GOOGLE_CLOUD_PROJECT in .env.local or the runtime environment.",
      500,
    );
  }

  const credentialFileError = getCredentialFileError();

  if (credentialFileError) {
    return jsonError(credentialFileError, 500);
  }

  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: LOCATION,
    httpOptions: {
      timeout: 120000,
      retryOptions: {
        attempts: VERTEX_RETRY_ATTEMPTS,
      },
    },
  });

  try {
    const response = await ai.models.generateContent({
      model: VERTEX_MODEL_ID,
      contents: referenceImage
        ? [
            {
              role: "user",
              parts: [
                { inlineData: referenceImage },
                ...(secondaryReferenceImage
                  ? [{ inlineData: secondaryReferenceImage }]
                  : []),
                { text: prompt },
              ],
            },
          ]
        : prompt,
      config: {
        responseModalities: [Modality.IMAGE],
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
        imageConfig: {
          aspectRatio: "1:1",
          imageSize: "512",
        },
      },
    });

    const image = findFirstImage(response);

    if (!image) {
      return Response.json(
        {
          error:
            response.promptFeedback?.blockReasonMessage ??
            "No image was returned. Try a different prompt.",
          model: VERTEX_MODEL_ID,
          provider,
        },
        { status: 502 },
      );
    }

    return Response.json({
      image: `data:${image.mimeType};base64,${image.data}`,
      mimeType: image.mimeType,
      model: VERTEX_MODEL_ID,
      provider,
    });
  } catch (error) {
    console.error("Vertex AI image generation failed:", error);

    if (isVertexResourceExhausted(error)) {
      return jsonError(
        "Vertex AI が混雑しています。自動再試行しても生成できませんでした。1〜2分待ってから、もう一度アバターを生成してください。",
        429,
        process.env.NODE_ENV === "development"
          ? getErrorMessage(error)
          : undefined,
      );
    }

    return jsonError(
      "Vertex AI image generation failed. Check server logs and Google Cloud credentials.",
      500,
      process.env.NODE_ENV === "development" ? getErrorMessage(error) : undefined,
    );
  }
}
