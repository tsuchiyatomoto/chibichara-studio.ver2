import { GoogleGenAI, Modality } from "@google/genai";
import { statSync } from "node:fs";

export const runtime = "nodejs";

const MODEL_ID = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image";
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? "global";
const MAX_PROMPT_LENGTH = 2000;

type RequestBody = {
  prompt?: unknown;
};

type InlineImage = {
  data: string;
  mimeType: string;
};

type ResponsePart = {
  text?: string;
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

function collectText(response: GenerateContentLike) {
  return (
    response.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text?.trim())
      .filter((text): text is string => Boolean(text))
      .join("\n") ?? ""
  );
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
    },
  });

  try {
    const response = await ai.models.generateContent({
      model: MODEL_ID,
      contents: prompt,
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
      },
    });

    const responseText = collectText(response);
    const image = findFirstImage(response);

    if (!image) {
      return Response.json(
        {
          error:
            response.promptFeedback?.blockReasonMessage ??
            "No image was returned. Try a different prompt.",
          text: responseText,
          model: MODEL_ID,
        },
        { status: 502 },
      );
    }

    return Response.json({
      image: `data:${image.mimeType};base64,${image.data}`,
      mimeType: image.mimeType,
      text: responseText,
      model: MODEL_ID,
    });
  } catch (error) {
    console.error("Vertex AI image generation failed:", error);

    return jsonError(
      "Vertex AI image generation failed. Check server logs and Google Cloud credentials.",
      500,
      process.env.NODE_ENV === "development" ? getErrorMessage(error) : undefined,
    );
  }
}
