"use client";

import Image from "next/image";
import { FormEvent, useState } from "react";

type GenerateImageResponse = {
  image?: string;
  text?: string;
  model?: string;
  error?: string;
  detail?: string;
};

const DEFAULT_PROMPT =
  "A translucent chibi wizard character with large eyes, short silver hair, a star-shaped wand, and pale cyan and pink clothing. 1:1 game character standing art on a white background.";

export default function Home() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [result, setResult] = useState<GenerateImageResponse | null>(null);
  const [error, setError] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt) {
      setError("Enter a prompt.");
      return;
    }

    setError("");
    setIsGenerating(true);

    try {
      const response = await fetch("/api/generate-image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: trimmedPrompt }),
      });
      const data = (await response.json()) as GenerateImageResponse;

      if (!response.ok) {
        throw new Error([data.error, data.detail].filter(Boolean).join("\n"));
      }

      setResult(data);
    } catch (generationError) {
      setError(
        generationError instanceof Error
          ? generationError.message
          : "Generation failed.",
      );
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f7fb] text-[#171717]">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-3 border-b border-black/10 pb-6">
          <p className="text-sm font-medium text-[#0f8b8d]">
            Vertex AI / Gemini 3.1 Flash Image
          </p>
          <h1 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">
            Chibi Character Studio
          </h1>
          <p className="max-w-2xl text-base leading-7 text-[#555b66]">
            Calls `gemini-3.1-flash-image` through a server-side Route Handler.
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-4 rounded-lg border border-black/10 bg-white p-5 shadow-sm"
          >
            <label htmlFor="prompt" className="text-sm font-semibold">
              Prompt
            </label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={10}
              maxLength={2000}
              className="min-h-56 resize-y rounded-md border border-black/15 bg-white px-3 py-3 text-sm leading-6 outline-none transition focus:border-[#0f8b8d] focus:ring-2 focus:ring-[#0f8b8d]/20"
            />
            <div className="flex items-center justify-between gap-3 text-xs text-[#686f7b]">
              <span>{prompt.length}/2000</span>
              <span>{result?.model ?? "gemini-3.1-flash-image"}</span>
            </div>
            <button
              type="submit"
              disabled={isGenerating}
              className="h-11 rounded-md bg-[#171717] px-4 text-sm font-semibold text-white transition hover:bg-[#2d2d2d] disabled:cursor-not-allowed disabled:bg-[#9aa1ad]"
            >
              {isGenerating ? "Generating..." : "Generate Image"}
            </button>
            {error ? (
              <p className="rounded-md border border-[#f3b5b5] bg-[#fff1f1] px-3 py-2 text-sm leading-6 text-[#9b1c1c]">
                {error}
              </p>
            ) : null}
          </form>

          <section className="flex min-h-[520px] flex-col rounded-lg border border-black/10 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-black/10 px-5 py-4">
              <h2 className="text-sm font-semibold">Result</h2>
              {result?.image ? (
                <a
                  href={result.image}
                  download="chibi-character.png"
                  className="rounded-md border border-black/10 px-3 py-2 text-sm font-medium transition hover:bg-[#f6f7fb]"
                >
                  Download
                </a>
              ) : null}
            </div>

            <div className="flex flex-1 items-center justify-center p-5">
              {result?.image ? (
                <Image
                  src={result.image}
                  alt="Generated chibi character"
                  width={1024}
                  height={1024}
                  unoptimized
                  className="h-auto max-h-[70vh] w-full max-w-[720px] rounded-md object-contain"
                />
              ) : (
                <div className="flex aspect-square w-full max-w-[560px] items-center justify-center rounded-md border border-dashed border-black/15 bg-[#fafbff] text-center text-sm text-[#686f7b]">
                  {isGenerating
                    ? "Generating with Vertex AI."
                    : "Generated images appear here."}
                </div>
              )}
            </div>

            {result?.text ? (
              <p className="border-t border-black/10 px-5 py-4 text-sm leading-6 text-[#555b66]">
                {result.text}
              </p>
            ) : null}
          </section>
        </div>
      </section>
    </main>
  );
}
