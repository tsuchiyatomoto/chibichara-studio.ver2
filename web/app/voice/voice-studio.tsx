"use client";

import Image from "next/image";
import { loadVoiceSession, saveVoiceSession } from "./voice-storage";
import { acknowledgeSpeechJobs, cancelPendingJobs, pendingJobs, requestJobResult } from "../ui/job-request";
import { type FormEvent, useEffect, useRef, useState } from "react";

type ConnectionState = "checking" | "connected" | "disconnected";
const IS_DEVELOPMENT = process.env.NODE_ENV === "development";

type ApiErrorResponse = {
  error?: string;
  detail?: string;
};

type VoiceAttributeId =
  "category" | "age" | "pitch" | "quality" | "brightness" | "character";

type VoiceAttributeGroup = {
  id: VoiceAttributeId;
  label: string;
  options: ReadonlyArray<{
    label: string;
    prompt: string;
  }>;
};

type VoiceInputMode = "guided" | "free";

type VoiceGeneration = {
  id: string;
  blob: Blob;
  audioUrl: string;
  text: string;
  caption: string;
};

type TrainingSample = VoiceGeneration;

type SpeakerInversionJob = {
  id: string;
  voice_id: string;
  status:
    "queued" | "running" | "cancelling" | "cancelled" | "failed" | "completed";
  phase: string;
  sample_count: number;
  message: string;
  error: string | null;
  progress: {
    current: number;
    total: number;
    ratio: number;
  };
  result: null | {
    voice_id: string;
    registered: boolean;
    saved: boolean;
    saved_asset_id: string | null;
    expires_at: string | null;
  };
};

type SpeakerInversionCapability = {
  ready: boolean;
  reason: string | null;
  min_samples: number;
  max_samples: number;
  max_steps: number;
  busy: boolean;
};

type StoredVoiceSession = {
  version: 1;
  trainingSamples: Omit<TrainingSample, "audioUrl">[];
  trainedAudio: Record<string, Blob>;
  referenceVoiceAssetId: string | null;
  referenceBlob: Blob | null;
  speakerJob: SpeakerInversionJob | null;
  activeTrainingSampleIndex: number;
  sampleView: "training" | "trained";
  attributeSelections: Record<VoiceAttributeId, string>;
  customModes: Record<VoiceAttributeId, boolean>;
  customPrompts: Record<VoiceAttributeId, string>;
  voiceInputMode: VoiceInputMode;
  globalVoicePrompt: string;
};

const MAX_CUSTOM_ATTRIBUTE_LENGTH = 120;
const MAX_GLOBAL_VOICE_PROMPT_LENGTH = 1000;
const MIN_TRAINING_SAMPLES = 5;
const SPEAKER_JOB_STORAGE_KEY = "chibichara-speaker-inversion-job";
const TRAINING_SAMPLE_TEXTS = [
  "\u671d\u306e\u5149\u304c\u7a93\u304b\u3089\u5dee\u3057\u8fbc\u307f\u3001\u9759\u304b\u306a\u90e8\u5c4b\u3092\u512a\u3057\u304f\u7167\u3089\u3057\u307e\u3059\u3002",
  "\u5c0f\u3055\u306a\u9ce5\u304c\u679d\u3092\u98db\u3073\u79fb\u308a\u3001\u6f84\u3093\u3060\u58f0\u3067\u697d\u3057\u305d\u3046\u306b\u9cf4\u304d\u307e\u3057\u305f\u3002",
  "\u51b7\u305f\u3044\u98a8\u304c\u5439\u304f\u65e5\u306f\u3001\u6e29\u304b\u3044\u7d05\u8336\u3092\u3086\u3063\u304f\u308a\u98f2\u307f\u305f\u304f\u306a\u308a\u307e\u3059\u3002",
  "\u99c5\u524d\u306e\u5e83\u5834\u3067\u306f\u3001\u5b50\u3069\u3082\u305f\u3061\u304c\u5143\u6c17\u3044\u3063\u3071\u3044\u8d70\u308a\u56de\u3063\u3066\u3044\u307e\u3059\u3002",
  "\u660e\u65e5\u3082\u7b11\u9854\u3067\u4f1a\u3048\u308b\u3088\u3046\u306b\u3001\u4eca\u65e5\u3067\u304d\u308b\u3053\u3068\u3092\u4e00\u3064\u305a\u3064\u9032\u3081\u307e\u3057\u3087\u3046\u3002",
] as const;
const GLOBAL_VOICE_PROMPT_PLACEHOLDER =
  "例：20代後半の落ち着いた女性。少し低めで柔らかく、透明感とわずかな息遣いがある。親しい相手に語りかけるように、ゆっくり穏やかに話す。";

const VOICE_ATTRIBUTE_GROUPS = [
  {
    id: "category",
    label: "性別印象",
    options: [
      { label: "女性的", prompt: "女性的な声" },
      { label: "中性的", prompt: "中性的な声" },
      { label: "男性的", prompt: "男性的な声" },
    ],
  },
  {
    id: "age",
    label: "年齢印象",
    options: [
      { label: "子ども", prompt: "幼い子どものような年齢印象" },
      { label: "少年少女", prompt: "少年少女のような若い年齢印象" },
      { label: "若者", prompt: "若者らしい年齢印象" },
      { label: "大人", prompt: "大人らしい年齢印象" },
      { label: "中年", prompt: "中年らしい年齢印象" },
      { label: "高齢", prompt: "高齢者らしい年齢印象" },
    ],
  },
  {
    id: "pitch",
    label: "声の高さ",
    options: [
      { label: "とても低い", prompt: "とても低い声" },
      { label: "低い", prompt: "低い声" },
      { label: "普通", prompt: "標準的な高さの声" },
      { label: "高い", prompt: "高い声" },
      { label: "とても高い", prompt: "とても高い声" },
    ],
  },
  {
    id: "quality",
    label: "声質",
    options: [
      { label: "透明", prompt: "透明感のある声質" },
      { label: "柔らかい", prompt: "柔らかい声質" },
      { label: "ハスキー", prompt: "ハスキーな声質" },
      { label: "クリア", prompt: "クリアな声質" },
      { label: "太い", prompt: "太い声質" },
      { label: "細い", prompt: "細い声質" },
      { label: "息っぽい", prompt: "息っぽい声質" },
      { label: "艶がある", prompt: "艶のある声質" },
    ],
  },
  {
    id: "brightness",
    label: "声の明暗",
    options: [
      { label: "明るい", prompt: "明るい声色" },
      { label: "ニュートラル", prompt: "明暗がニュートラルな声色" },
      { label: "暗い", prompt: "暗い声色" },
    ],
  },
  {
    id: "character",
    label: "カテゴリ",
    options: [
      { label: "かわいい", prompt: "かわいいキャラクター性" },
      { label: "クール", prompt: "クールなキャラクター性" },
      { label: "優しい", prompt: "優しいキャラクター性" },
      { label: "元気", prompt: "元気なキャラクター性" },
      { label: "落ち着いた", prompt: "落ち着いたキャラクター性" },
      { label: "知的", prompt: "知的なキャラクター性" },
      { label: "ミステリアス", prompt: "ミステリアスなキャラクター性" },
      { label: "ワイルド", prompt: "ワイルドなキャラクター性" },
    ],
  },
] as const satisfies ReadonlyArray<VoiceAttributeGroup>;

const INITIAL_ATTRIBUTE_SELECTIONS: Record<VoiceAttributeId, string> = {
  category: "中性的",
  age: "若者",
  pitch: "普通",
  quality: "クリア",
  brightness: "ニュートラル",
  character: "優しい",
};

const INITIAL_CUSTOM_MODES: Record<VoiceAttributeId, boolean> = {
  category: false,
  age: false,
  pitch: false,
  quality: false,
  brightness: false,
  character: false,
};

const INITIAL_CUSTOM_PROMPTS: Record<VoiceAttributeId, string> = {
  category: "",
  age: "",
  pitch: "",
  quality: "",
  brightness: "",
  character: "",
};

const CUSTOM_PROMPT_PLACEHOLDERS: Record<VoiceAttributeId, string> = {
  category: "例：性別を限定しない、ジェンダーニュートラルな声",
  age: "例：20代後半くらいの、少し大人びた年齢印象",
  pitch: "例：普段は低めだが、感情が高ぶると少し高くなる",
  quality: "例：少しかすれていて、息遣いを感じる柔らかな声質",
  brightness: "例：明るさの中に少し影を感じる声色",
  character: "例：人懐っこく、少しいたずら好きな印象",
};

async function readApiError(response: Response) {
  try {
    const data = (await response.json()) as ApiErrorResponse;

    return [data.error, data.detail].filter(Boolean).join("\n");
  } catch {
    return `リクエストに失敗しました（${response.status}）。`;
  }
}

function requestSpeech(init: RequestInit) {
  return requestJobResult("speech", JSON.parse(String(init.body)), init.signal ?? undefined);
}

async function requestConnectionStatus() {
  try {
    const response = await fetch("/api/generate-speech", {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const data = (await response.json()) as {
      connected?: boolean;
      model?: string;
      speakerInversion?: SpeakerInversionCapability | null;
    };

    return {
      connected: data.connected === true,
      model: data.model,
      speakerInversion: data.speakerInversion ?? undefined,
    };
  } catch {
    return {
      connected: false,
      model: undefined,
      speakerInversion: undefined,
    };
  }
}

async function requestSpeakerJob(jobId: string) {
  const response = await fetch(
    `/api/speaker-inversion/${encodeURIComponent(jobId)}`,
    { method: "GET", cache: "no-store" },
  );

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as SpeakerInversionJob;
}

async function deleteReferenceVoiceAsset(assetId: string | null) {
  if (!assetId) return;

  await fetch("/api/voice-reference", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voiceAssetId: assetId }),
  }).catch(() => undefined);
}

async function deleteSavedVoiceAsset(voiceAssetId: string) {
  const response = await fetch("/api/speaker-assets", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voiceAssetId }),
  });
  if (!response.ok) throw new Error(await readApiError(response));
}

function speakerPhaseLabel(job: SpeakerInversionJob) {
  if (job.status === "completed") return "完成";
  if (job.status === "failed") return "失敗";
  if (job.status === "cancelled") return "中止済み";
  if (job.phase === "waiting_for_inference") return "生成処理の終了待ち";
  if (job.phase === "preparing") return "音声をlatentへ変換中";
  if (job.phase === "training") return "Speaker Inversionを学習中";
  if (job.phase === "finalizing") return "一時成果物を準備中";
  if (job.phase === "cancelling") return "中止処理中";
  return "準備中";
}

function MicrophoneIcon({ className = "h-10 w-10" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="8" y="3" width="8" height="12" rx="4" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </svg>
  );
}

export default function VoiceStudio() {
  const [isProductionUiPreview, setIsProductionUiPreview] = useState(false);
  const [completionPreview, setCompletionPreview] = useState<"off" | "saving" | "saved">("off");
  const isCompletionPreview = IS_DEVELOPMENT && completionPreview !== "off";
  const [activeAttribute, setActiveAttribute] =
    useState<VoiceAttributeId>("category");
  const [attributeSelections, setAttributeSelections] = useState(
    INITIAL_ATTRIBUTE_SELECTIONS,
  );
  const [customModes, setCustomModes] = useState(INITIAL_CUSTOM_MODES);
  const [customPrompts, setCustomPrompts] = useState(INITIAL_CUSTOM_PROMPTS);
  const [voiceInputMode, setVoiceInputMode] =
    useState<VoiceInputMode>("guided");
  const [globalVoicePrompt, setGlobalVoicePrompt] = useState("");
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connected");
  const [model, setModel] = useState("irodori-tts");
  const [speakerCapability, setSpeakerCapability] =
    useState<SpeakerInversionCapability | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDeletingVoice, setIsDeletingVoice] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [trainingSamples, setTrainingSamples] = useState<TrainingSample[]>([]);
  const [activeTrainingSampleIndex, setActiveTrainingSampleIndex] = useState(0);
  const [sampleView, setSampleView] = useState<"training" | "trained">("training");
  const [trainedAudio, setTrainedAudio] = useState<Record<string, { blob: Blob; audioUrl: string }>>({});
  const [generatingTrainedKey, setGeneratingTrainedKey] = useState<string | null>(null);
  const trainedUrlsRef = useRef<string[]>([]);
  const trainedAudioRef = useRef(trainedAudio);
  const referenceBlobRef = useRef<Blob | null>(null);
  const restoredReferenceRef = useRef(false);
  const [storageReady, setStorageReady] = useState(false);
  const [storageWritable, setStorageWritable] = useState(false);
  const [storageError, setStorageError] = useState("");
  const trainedRequestRef = useRef<AbortController | null>(null);
  const sampleRequestRef = useRef<AbortController | null>(null);
  const restoredJobContext = useRef<{ texts: string[]; savedVoice: string | null; reference: string | null }>({ texts: [], savedVoice: null, reference: null });
  const [referenceVoiceAssetId, setReferenceVoiceAssetId] = useState<
    string | null
  >(null);
  const [speakerJob, setSpeakerJob] = useState<SpeakerInversionJob | null>(
    null,
  );
  const [isStartingTraining, setIsStartingTraining] = useState(false);
  const [isCancellingTraining, setIsCancellingTraining] = useState(false);
  const [error, setError] = useState("");
  const sampleUrlsRef = useRef<string[]>([]);
  const isTrainingActive =
    speakerJob !== null &&
    ["queued", "running", "cancelling"].includes(speakerJob.status);
  const unsavedSpeakerJobId =
    speakerJob?.status === "completed" &&
    speakerJob.result &&
    !speakerJob.result.saved
      ? speakerJob.id
      : null;
  const completedVoiceName = speakerJob?.result?.voice_id ?? "my-character";
  const isSavingSpeaker = unsavedSpeakerJobId !== null;
  const controlsDisabled =
    !storageReady || isCompletionPreview || generatingTrainedKey !== null || isGenerating || isDeletingVoice || isTrainingActive || isStartingTraining || isSavingSpeaker;
  const displayedSpeakerJob: SpeakerInversionJob | null = isCompletionPreview
    ? {
        id: "preview",
        voice_id: "my-character",
        status: "completed",
        phase: "completed",
        sample_count: TRAINING_SAMPLE_TEXTS.length,
        message: "",
        error: null,
        progress: { current: 3000, total: 3000, ratio: 1 },
        result: {
          voice_id: "my-character",
          registered: true,
          saved: completionPreview === "saved",
          saved_asset_id: null,
          expires_at: null,
        },
      }
    : speakerJob;
  const displayedSavingSpeaker = isCompletionPreview
    ? completionPreview === "saving"
    : isSavingSpeaker;
  const savedVoiceAssetId = speakerJob?.result?.saved
    ? speakerJob.result.saved_asset_id
    : null;
  const canPreviewTrained = isCompletionPreview
    ? completionPreview === "saved"
    : Boolean(savedVoiceAssetId);
  const showingTrained = sampleView === "trained" && canPreviewTrained;
  const trainedAudioKey = `${savedVoiceAssetId}:${activeTrainingSampleIndex}`;
  const activeTrainedAudio = trainedAudio[trainedAudioKey];
  const requiredTrainingSamples =
    speakerCapability?.min_samples ?? MIN_TRAINING_SAMPLES;
  const completedPresetSampleCount = TRAINING_SAMPLE_TEXTS.filter((text) =>
    trainingSamples.some((sample) => sample.text === text),
  ).length;
  const remainingTrainingSampleTexts = TRAINING_SAMPLE_TEXTS.filter(
    (text) => !trainingSamples.some((sample) => sample.text === text),
  );
  const activeTrainingSampleText =
    TRAINING_SAMPLE_TEXTS[activeTrainingSampleIndex] ??
    TRAINING_SAMPLE_TEXTS[0];
  const activeTrainingSample = trainingSamples.find(
    (sample) => sample.text === activeTrainingSampleText,
  );
  const generatedTrainingSampleIndexes = TRAINING_SAMPLE_TEXTS.map((_, index) => index);
  const previousTrainingSampleIndex = [...generatedTrainingSampleIndexes]
    .reverse()
    .find((index) => index < activeTrainingSampleIndex);
  const nextTrainingSampleIndex = generatedTrainingSampleIndexes.find(
    (index) => index > activeTrainingSampleIndex,
  );
  const hasNonPresetTrainingSamples = trainingSamples.some(
    (sample) => !TRAINING_SAMPLE_TEXTS.some((text) => text === sample.text),
  );
  const isDevelopmentUi = IS_DEVELOPMENT && !isProductionUiPreview;
  const activeGroup =
    VOICE_ATTRIBUTE_GROUPS.find(({ id }) => id === activeAttribute) ??
    VOICE_ATTRIBUTE_GROUPS[0];

  useEffect(() => {
    let ignoreResult = false;

    void requestConnectionStatus().then((result) => {
      if (ignoreResult) {
        return;
      }

      setConnectionState(result.connected ? "connected" : "disconnected");

      if (result.model) {
        setModel(result.model);
      }

      if (result.speakerInversion) {
        setSpeakerCapability(result.speakerInversion);
      }
    });

    return () => {
      ignoreResult = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      sampleUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      trainedRequestRef.current?.abort();
      trainedUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    let ignoreResult = false;
    const restore = async () => {
      let cached: StoredVoiceSession | undefined;
      try {
        cached = await loadVoiceSession<StoredVoiceSession>();
        if (ignoreResult) return;
        if (cached && cached.version !== 1) throw new Error("保存形式を読み込めませんでした。");
        if (cached?.version === 1) {
          const samples = cached.trainingSamples.map((sample) => {
            const audioUrl = URL.createObjectURL(sample.blob);
            sampleUrlsRef.current.push(audioUrl);
            return { ...sample, audioUrl };
          });
          const previews = Object.fromEntries(Object.entries(cached.trainedAudio).map(([key, blob]) => {
            const audioUrl = URL.createObjectURL(blob);
            trainedUrlsRef.current.push(audioUrl);
            return [key, { blob, audioUrl }];
          }));
          setTrainingSamples(samples);
          trainedAudioRef.current = previews;
          setTrainedAudio(previews);
          setReferenceVoiceAssetId(cached.referenceVoiceAssetId);
          referenceBlobRef.current = cached.referenceBlob ?? samples[0]?.blob ?? null;
          restoredReferenceRef.current = true;
          setSpeakerJob(cached.speakerJob);
          setActiveTrainingSampleIndex(cached.activeTrainingSampleIndex);
          setSampleView(cached.sampleView);
          setAttributeSelections(cached.attributeSelections);
          setCustomModes(cached.customModes);
          setCustomPrompts(cached.customPrompts);
          setVoiceInputMode(cached.voiceInputMode);
          setGlobalVoicePrompt(cached.globalVoicePrompt);
        }
        restoredJobContext.current = {
          texts: cached?.trainingSamples.map((sample) => sample.text) ?? [],
          savedVoice: cached?.speakerJob?.result?.saved_asset_id ?? null,
          reference: cached?.referenceVoiceAssetId ?? null,
        };
        setStorageWritable(true);
      } catch {
        if (!ignoreResult) setStorageError("ブラウザに保存した声を読み込めませんでした。ブラウザの保存設定を確認してください。");
      }
      if (ignoreResult) return;
      try {
        // Completed jobs can expire on the server. Keep their saved voice and
        // local previews; only unfinished jobs need a status refresh.
        const jobId = cached?.speakerJob?.id ?? window.localStorage.getItem(SPEAKER_JOB_STORAGE_KEY);
        if (jobId && !cached?.speakerJob?.result?.saved) {
          const job = await requestSpeakerJob(jobId);
          if (!ignoreResult) setSpeakerJob(job);
        }
      } catch {
        // A transient server outage must not erase the locally saved session.
      } finally {
        if (!ignoreResult) setStorageReady(true);
      }
    };
    void restore();
    return () => { ignoreResult = true; };
  }, []);

  useEffect(() => {
    if (!storageReady || !storageWritable || isCompletionPreview) return;
    const snapshot: StoredVoiceSession = {
      version: 1,
      trainingSamples: trainingSamples.map(({ id, blob, text, caption }) => ({ id, blob, text, caption })),
      trainedAudio: Object.fromEntries(Object.entries(trainedAudio).map(([key, value]) => [key, value.blob])),
      referenceVoiceAssetId,
      referenceBlob: referenceBlobRef.current,
      speakerJob, activeTrainingSampleIndex, sampleView,
      attributeSelections, customModes, customPrompts, voiceInputMode, globalVoicePrompt,
    };
    void saveVoiceSession(snapshot).then(
      async () => {
        await acknowledgeSpeechJobs(({ body }) => {
          const index = TRAINING_SAMPLE_TEXTS.findIndex((text) => text === body.input);
          const saved = snapshot.speakerJob?.result?.saved_asset_id;
          return saved && body.voiceAssetId === saved
            ? Boolean(snapshot.trainedAudio[`${String(saved)}:${index}`])
            : snapshot.trainingSamples.some((sample) => sample.text === body.input);
        }).catch(() => {});
        setStorageError("");
      },
      () => setStorageError("声をブラウザに保存できませんでした。空き容量やブラウザの保存設定を確認してください。"),
    );
  }, [storageReady, storageWritable, isCompletionPreview, trainingSamples, trainedAudio, referenceVoiceAssetId,
    speakerJob, activeTrainingSampleIndex, sampleView, attributeSelections, customModes,
    customPrompts, voiceInputMode, globalVoicePrompt]);

  useEffect(() => {
    const controller = new AbortController();
    sampleRequestRef.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!storageReady || isCompletionPreview) return;
    const controller = new AbortController();
    const resume = async () => {
      const context = restoredJobContext.current;
      const pending = (await pendingJobs("speech")).filter(({ body }) =>
        TRAINING_SAMPLE_TEXTS.some((text) => text === body.input) &&
        !context.texts.includes(String(body.input)) &&
        (!context.savedVoice || body.voiceAssetId !== context.savedVoice));
      if (!pending.length || controller.signal.aborted) return;
      setIsGenerating(true);
      try {
        for (const record of pending) {
          const text = String(record.body.input);
          const index = TRAINING_SAMPLE_TEXTS.findIndex((value) => value === text);
          setActiveTrainingSampleIndex(index);
          setGenerationProgress({ current: index + 1, total: TRAINING_SAMPLE_TEXTS.length });
          const response = await requestJobResult("speech", record.body, controller.signal);
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          if (!context.reference) {
            const form = new FormData();
            form.append("file", blob, "reference.wav");
            const uploaded = await fetch("/api/voice-reference", { method: "POST", body: form, signal: controller.signal });
            if (!uploaded.ok) throw new Error(await readApiError(uploaded));
            const data = await uploaded.json() as { voiceAssetId: string };
            context.reference = data.voiceAssetId;
            referenceBlobRef.current = blob;
            restoredReferenceRef.current = false;
            setReferenceVoiceAssetId(data.voiceAssetId);
          }
          const audioUrl = URL.createObjectURL(blob);
          sampleUrlsRef.current.push(audioUrl);
          setTrainingSamples((current) => current.some((sample) => sample.text === text) ? current : [
            ...current, { id: crypto.randomUUID(), blob, audioUrl, text, caption: String(record.body.caption ?? "") },
          ]);
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "生成状況を復元できませんでした。");
      } finally {
        if (!controller.signal.aborted) { setIsGenerating(false); setGenerationProgress(null); }
      }
    };
    void resume().catch(() => {});
    return () => controller.abort();
  }, [storageReady, isCompletionPreview]);

  useEffect(() => {
    if (
      !speakerJob ||
      !["queued", "running", "cancelling"].includes(speakerJob.status)
    ) {
      return;
    }

    let ignoreResult = false;
    const poll = async () => {
      try {
        const nextJob = await requestSpeakerJob(speakerJob.id);
        if (!ignoreResult) {
          setSpeakerJob(nextJob);
        }
      } catch (pollError) {
        if (!ignoreResult) {
          setError(
            pollError instanceof Error
              ? pollError.message
              : "学習状況を取得できませんでした。",
          );
        }
      }
    };
    const interval = window.setInterval(() => void poll(), 2_000);

    return () => {
      ignoreResult = true;
      window.clearInterval(interval);
    };
  }, [speakerJob]);

  useEffect(() => {
    if (!storageReady || !unsavedSpeakerJobId) return;

    let ignoreResult = false;
    let retryTimeout: number | undefined;

    const saveLatestSpeaker = async () => {
      try {
        const response = await fetch(
          `/api/speaker-inversion/${encodeURIComponent(unsavedSpeakerJobId)}/save`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: completedVoiceName }),
          },
        );
        if (!response.ok) throw new Error(await readApiError(response));
        const asset = (await response.json()) as { id: string };
        if (ignoreResult) return;

        setReferenceVoiceAssetId(null);
        void deleteReferenceVoiceAsset(referenceVoiceAssetId);
        setSpeakerJob((current) =>
          current?.id === unsavedSpeakerJobId && current.result
            ? {
                ...current,
                result: {
                  ...current.result,
                  saved: true,
                  saved_asset_id: asset.id,
                },
              }
            : current,
        );
        setError("");
      } catch (saveError) {
        if (ignoreResult) return;
        const message =
          saveError instanceof Error
            ? saveError.message
            : "最新の声を保存できませんでした。";
        setError(`${message}\n自動保存を再試行します。`);
        retryTimeout = window.setTimeout(() => void saveLatestSpeaker(), 5_000);
      }
    };

    void saveLatestSpeaker();
    return () => {
      ignoreResult = true;
      window.clearTimeout(retryTimeout);
    };
  }, [completedVoiceName, referenceVoiceAssetId, unsavedSpeakerJobId, storageReady]);

  useEffect(() => {
    if (!storageReady || !savedVoiceAssetId || isCompletionPreview) return;
    if (TRAINING_SAMPLE_TEXTS.every((_, index) => trainedAudioRef.current[`${savedVoiceAssetId}:${index}`])) return;

    const controller = new AbortController();
    trainedRequestRef.current = controller;

    const generatePreviews = async () => {
      setSampleView("trained");
      setActiveTrainingSampleIndex(0);
      setError("");
      const failures: number[] = [];
      try {
        for (const [index, input] of TRAINING_SAMPLE_TEXTS.entries()) {
          if (controller.signal.aborted) return;
          const key = `${savedVoiceAssetId}:${index}`;
          if (trainedAudioRef.current[key]) continue;
          setGeneratingTrainedKey(key);
          try {
            const response = await requestSpeech({
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: controller.signal,
              body: JSON.stringify({ input, voiceAssetId: savedVoiceAssetId }),
            });
            if (!response.ok) throw new Error(await readApiError(response));
            const blob = await response.blob();
            if (controller.signal.aborted) return;
            if (!blob.size) throw new Error("生成された音声が空でした。");
            const url = URL.createObjectURL(blob);
            trainedUrlsRef.current.push(url);
            trainedAudioRef.current = { ...trainedAudioRef.current, [key]: { blob, audioUrl: url } };
            setTrainedAudio(trainedAudioRef.current);
          } catch {
            if (controller.signal.aborted) return;
            failures.push(index + 1);
          }
        }
        if (failures.length) {
          setError(`文章${failures.join("・")}の音声を生成できませんでした。該当する文章の「この文章で声を確認」から再試行してください。`);
        }
      } finally {
        if (trainedRequestRef.current === controller) {
          trainedRequestRef.current = null;
          setGeneratingTrainedKey(null);
        }
      }
    };

    void generatePreviews();
    return () => {
      controller.abort();
      if (trainedRequestRef.current === controller) {
        trainedRequestRef.current = null;
      }
    };
  }, [savedVoiceAssetId, isCompletionPreview, storageReady]);

  async function handleConnectionCheck() {
    setConnectionState("checking");
    const result = await requestConnectionStatus();

    setConnectionState(result.connected ? "connected" : "disconnected");

    if (result.model) {
      setModel(result.model);
    }

    if (result.speakerInversion) {
      setSpeakerCapability(result.speakerInversion);
    }
  }

  function handleAttributeSelection(groupId: VoiceAttributeId, label: string) {
    setAttributeSelections((current) => ({
      ...current,
      [groupId]: label,
    }));
    setError("");
  }

  function handleCustomModeToggle(groupId: VoiceAttributeId) {
    setCustomModes((current) => ({
      ...current,
      [groupId]: !current[groupId],
    }));
    setError("");
  }

  function handleRemoveTrainingSample(sampleId: string) {
    setTrainingSamples((current) => {
      const removed = current.find((sample) => sample.id === sampleId);
      if (removed) {
        URL.revokeObjectURL(removed.audioUrl);
        sampleUrlsRef.current = sampleUrlsRef.current.filter(
          (url) => url !== removed.audioUrl,
        );
      }
      return current.filter((sample) => sample.id !== sampleId);
    });
    setError("");
  }

  async function clearTrainingSession() {
    if (isDeletingVoice) return false;
    setIsDeletingVoice(true);
    try {
      await cancelPendingJobs("speech");
      // Keep the local model and samples until the server confirms deletion.
      if (savedVoiceAssetId) await deleteSavedVoiceAsset(savedVoiceAssetId);
    } catch (error) {
      setError(error instanceof Error ? error.message : "ボイスモデルを削除できませんでした。もう一度お試しください。");
      setIsDeletingVoice(false);
      return false;
    }
    trainedRequestRef.current?.abort();
    trainedUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    trainedUrlsRef.current = [];
    trainedAudioRef.current = {};
    setTrainedAudio({});
    referenceBlobRef.current = null;
    restoredReferenceRef.current = false;
    setSpeakerJob(null);
    window.localStorage.removeItem(SPEAKER_JOB_STORAGE_KEY);
    setSampleView("training");
    const oldReferenceVoiceAssetId = referenceVoiceAssetId;
    setReferenceVoiceAssetId(null);
    trainingSamples.forEach((sample) => URL.revokeObjectURL(sample.audioUrl));
    sampleUrlsRef.current = [];
    setTrainingSamples([]);
    setActiveTrainingSampleIndex(0);
    setError("");
    await deleteReferenceVoiceAsset(oldReferenceVoiceAssetId);
    setIsDeletingVoice(false);
    return true;
  }

  async function handleResetSamples() {
    if (controlsDisabled) return false;
    if (
      (trainingSamples.length > 0 || Object.keys(trainedAudio).length > 0) &&
      !window.confirm("生成したボイスをすべて削除しますか？")
    ) {
      return false;
    }

    return clearTrainingSession();
  }

  async function handleGenerateTrainedSample() {
    if (!savedVoiceAssetId || controlsDisabled || trainedRequestRef.current) return;
    const key = trainedAudioKey;
    const controller = new AbortController();
    trainedRequestRef.current = controller;
    setGeneratingTrainedKey(key);
    setError("");
    try {
      const response = await requestSpeech({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          input: activeTrainingSampleText,
          voiceAssetId: savedVoiceAssetId,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (!blob.size) throw new Error("生成された音声が空でした。もう一度お試しください。");
      const url = URL.createObjectURL(blob);
      trainedUrlsRef.current.push(url);
      trainedAudioRef.current = { ...trainedAudioRef.current, [key]: { blob, audioUrl: url } };
      setTrainedAudio(trainedAudioRef.current);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : "確認用の音声を生成できませんでした。");
      }
    } finally {
      trainedRequestRef.current = null;
      setGeneratingTrainedKey(null);
    }
  }

  async function handleStartTraining() {
    if (speakerCapability && !speakerCapability.ready) {
      setError(
        speakerCapability.reason ??
          "TTSサーバーでSpeaker Inversionを利用できません。",
      );
      return;
    }

    if (trainingSamples.length < requiredTrainingSamples) {
      setError(`学習には最低${requiredTrainingSamples}本の音声が必要です。`);
      return;
    }

    if (!referenceVoiceAssetId) {
      setError(
        "「ボイスをすべて削除」を押して声を生成し直してください。新しく生成した音声から学習します。",
      );
      return;
    }

    setError("");
    setIsStartingTraining(true);

    try {
      const body = new FormData();
      body.append("voice_id", "my-character");
      body.append(
        "texts",
        JSON.stringify(trainingSamples.map((sample) => sample.text)),
      );
      body.append(
        "captions",
        JSON.stringify(trainingSamples.map((sample) => sample.caption)),
      );
      trainingSamples.forEach((sample, index) => {
        body.append("files", sample.blob, `sample-${index + 1}.wav`);
      });
      const response = await fetch("/api/speaker-inversion", {
        method: "POST",
        body,
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const job = (await response.json()) as SpeakerInversionJob;
      setSpeakerJob(job);
      window.localStorage.setItem(SPEAKER_JOB_STORAGE_KEY, job.id);
    } catch (trainingError) {
      setError(
        trainingError instanceof Error
          ? trainingError.message
          : "Speaker Inversionを開始できませんでした。",
      );
    } finally {
      setIsStartingTraining(false);
    }
  }

  async function handleCancelTraining() {
    if (!speakerJob || !isTrainingActive) {
      return;
    }

    setIsCancellingTraining(true);
    setError("");
    try {
      const response = await fetch(
        `/api/speaker-inversion/${encodeURIComponent(speakerJob.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      setSpeakerJob((await response.json()) as SpeakerInversionJob);
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : "学習を中止できませんでした。",
      );
    } finally {
      setIsCancellingTraining(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (controlsDisabled) return;

    if (voiceInputMode === "free" && !globalVoicePrompt.trim()) {
      setError("声全体の文章を入力してください。");
      return;
    }

    const emptyCustomGroup =
      voiceInputMode === "guided"
        ? VOICE_ATTRIBUTE_GROUPS.find(
            (group) => customModes[group.id] && !customPrompts[group.id].trim(),
          )
        : undefined;

    if (emptyCustomGroup) {
      setActiveAttribute(emptyCustomGroup.id);
      setError(`${emptyCustomGroup.label}の文章を入力してください。`);
      return;
    }

    const caption =
      voiceInputMode === "free"
        ? globalVoicePrompt.trim()
        : VOICE_ATTRIBUTE_GROUPS.map((group) => {
            if (customModes[group.id]) {
              return customPrompts[group.id].trim();
            }

            return group.options.find(
              ({ label }) => label === attributeSelections[group.id],
            )?.prompt;
          })
            .filter((prompt): prompt is string => Boolean(prompt))
            .join("。");

    let sampleTexts = [...remainingTrainingSampleTexts];
    // Training samples must start from the selected voice description, then
    // reuse that batch's first WAV. Never bootstrap from a saved embedding:
    // its defects would otherwise propagate into every sample and retraining.
    let generationVoiceAssetId = referenceVoiceAssetId;
    if (restoredReferenceRef.current && referenceBlobRef.current && sampleTexts.length > 0) {
      setIsGenerating(true);
      try {
        const body = new FormData();
        body.append("file", referenceBlobRef.current, "reference.wav");
        const response = await fetch("/api/voice-reference", { method: "POST", body });
        if (!response.ok) throw new Error(await readApiError(response));
        const data = await response.json() as { voiceAssetId: string };
        if (!data.voiceAssetId) throw new Error("基準音声を復元できませんでした。");
        generationVoiceAssetId = data.voiceAssetId;
        setReferenceVoiceAssetId(data.voiceAssetId);
        restoredReferenceRef.current = false;
      } catch (error) {
        setError(error instanceof Error ? error.message : "基準音声を復元できませんでした。");
        return;
      } finally {
        setIsGenerating(false);
      }
    }
    const needsFreshBatch =
      hasNonPresetTrainingSamples ||
      (trainingSamples.length > 0 && !generationVoiceAssetId);

    if (needsFreshBatch) {
      if (
        !window.confirm(
          `現在の学習サンプルを破棄して、${TRAINING_SAMPLE_TEXTS.length}本の音声を最初から作り直しますか？`,
        )
      ) {
        return;
      }
      if (!(await clearTrainingSession())) return;
      sampleTexts = [...TRAINING_SAMPLE_TEXTS];
      generationVoiceAssetId = null;
    }

    if (sampleTexts.length === 0) return;

    setError("");
    setIsGenerating(true);
    setSpeakerJob(null);
    window.localStorage.removeItem(SPEAKER_JOB_STORAGE_KEY);
    let currentSampleNumber = 0;

    try {
      for (const sampleText of sampleTexts) {
        currentSampleNumber = TRAINING_SAMPLE_TEXTS.indexOf(sampleText) + 1;
        setActiveTrainingSampleIndex(currentSampleNumber - 1);
        setGenerationProgress({
          current: currentSampleNumber,
          total: TRAINING_SAMPLE_TEXTS.length,
        });

        // Describe the voice for the first sample; subsequent samples follow
        // its waveform reference so the selected identity stays consistent.
        const sampleCaption = generationVoiceAssetId ? "" : caption;
        const response = await requestSpeech({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: sampleRequestRef.current?.signal,
          body: JSON.stringify({
            input: sampleText,
            ...(sampleCaption ? { caption: sampleCaption } : {}),
            voice: "none",
            ...(generationVoiceAssetId
              ? { voiceAssetId: generationVoiceAssetId }
              : {}),
          }),
        });

        if (!response.ok) {
          throw new Error(await readApiError(response));
        }

        const audioBlob = await response.blob();

        if (audioBlob.size === 0) {
          throw new Error("生成された音声が空でした。もう一度お試しください。");
        }

        if (!generationVoiceAssetId) {
          const body = new FormData();
          body.append("file", audioBlob, "reference.wav");
          const referenceResponse = await fetch("/api/voice-reference", {
            method: "POST",
            body,
          });

          if (!referenceResponse.ok) {
            throw new Error(await readApiError(referenceResponse));
          }

          const referenceData = (await referenceResponse.json()) as {
            voiceAssetId?: string;
          };
          if (!referenceData.voiceAssetId) {
            throw new Error("基準音声IDが返されませんでした。");
          }
          referenceBlobRef.current = audioBlob;
          generationVoiceAssetId = referenceData.voiceAssetId;
          setReferenceVoiceAssetId(referenceData.voiceAssetId);
        }

        const sampleUrl = URL.createObjectURL(audioBlob);
        sampleUrlsRef.current.push(sampleUrl);
        setTrainingSamples((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            blob: audioBlob,
            audioUrl: sampleUrl,
            text: sampleText,
            caption: sampleCaption,
          },
        ]);
      }
      setConnectionState("connected");
    } catch (generationError) {
      const message =
        generationError instanceof Error
          ? generationError.message
          : "音声生成に失敗しました。";
      setError(
        currentSampleNumber > 0
          ? `${currentSampleNumber}本目の生成で停止しました。\n${message}\nもう一度押すと不足分から再開します。`
          : message,
      );
    } finally {
      setGenerationProgress(null);
      setIsGenerating(false);
    }
  }

  const connectionLabel =
    connectionState === "connected"
      ? "API接続済み"
      : connectionState === "checking"
        ? "接続確認中"
        : "未接続";

  return (
    <div className="min-h-screen bg-[#f6f7fb] text-[#171717]">
      <header className="border-b border-black/10 bg-white">
        <div className="mx-auto flex h-24 w-full max-w-7xl items-center justify-between gap-4 px-5 sm:px-8 lg:px-10">
          <div className="flex min-w-0 items-center gap-4">
            <Image
              src="/favicon.png"
              alt=""
              width={72}
              height={72}
              priority
              className="h-18 w-18 shrink-0 rounded-md object-contain"
            />
            <p className="hidden text-4xl font-semibold tracking-tight sm:block">
              chibichara studio
            </p>
          </div>

          {isDevelopmentUi ? (
            <section
              aria-label="API接続状況"
              className="ml-auto shrink-0 rounded-xl border-2 border-[#0891b2]/30 bg-[#e6faff]/55 px-3 py-2 text-xs text-[#47616e] shadow-sm"
            >
              <div className="flex items-center gap-3">
                <div className="hidden text-right leading-5 lg:block">
                  <p className="text-[10px] font-black tracking-[0.16em] text-[#0891b2]">
                    DEVELOPMENT
                  </p>
                  <p className="font-black text-[#083344]">{model}</p>
                  <p>
                    {connectionState === "connected"
                      ? "Irodori-TTS APIへ接続できています。"
                      : "Irodori-TTSサーバーを起動すると生成できます。"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleConnectionCheck()}
                  className={`flex items-center gap-2 rounded-full border-2 px-4 py-2 text-xs font-black transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                    connectionState === "connected"
                      ? "border-[#0891b2] bg-[#22d3ee] text-[#083344]"
                      : connectionState === "checking"
                        ? "border-[#d8b146] bg-[#ffd84d] text-[#513a00]"
                        : "border-[#b91c1c] bg-[#ef4444] text-white"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-2.5 w-2.5 rounded-full ${
                      connectionState === "checking"
                        ? "animate-pulse bg-[#9b6b16]"
                        : "bg-white"
                    }`}
                  />
                  {connectionLabel}
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-8 sm:px-8 lg:px-10">
        {isDevelopmentUi ? (
          <section aria-label="学習完了UIプレビュー" className="mb-4 rounded-xl border border-[#0891b2]/40 bg-[#e6faff] p-4 text-sm">
            <label className="flex flex-wrap items-center gap-3 font-bold">
              開発用：学習完了UI
              <select
                value={completionPreview}
                disabled={isGenerating || isTrainingActive || isStartingTraining || isSavingSpeaker}
                onChange={(event) => setCompletionPreview(event.target.value as "off" | "saving" | "saved")}
                className="rounded-lg border border-black/15 bg-white px-3 py-2"
              >
                <option value="off">通常表示</option>
                <option value="saving">学習完了・自動保存中</option>
                <option value="saved">学習完了・保存済み</option>
              </select>
            </label>
            <p className="mt-2 text-xs">
              {isCompletionPreview
                ? "表示のみのプレビューです。学習・保存は実行しません。生成・削除操作は無効です。通常表示に戻すと元の状態に戻ります。"
                : "学習を待たずに完了後の表示を確認できます。"}
            </p>
          </section>
        ) : null}
        <form
          onSubmit={handleSubmit}
          className="mx-auto grid w-full max-w-5xl items-stretch gap-6 lg:grid-cols-2"
        >
          <div className="h-full overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm">
            <section className="space-y-5 border-b border-black/10 bg-[#fffdf5] p-5 sm:p-6">
              <div>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="mb-1 text-xs font-bold tracking-[0.18em] text-[#9b6b16] uppercase">
                      VOICE ATTRIBUTES
                    </p>
                    <h2 className="text-xl font-bold tracking-tight">
                      声の属性
                    </h2>
                  </div>
                  <button
                    type="button"
                    aria-pressed={voiceInputMode === "free"}
                    aria-controls="global-voice-prompt-panel"
                    aria-label="声全体を文章で指定"
                    title="声全体を文章で指定"
                    disabled={controlsDisabled}
                    onClick={() => {
                      setVoiceInputMode((current) =>
                        current === "guided" ? "free" : "guided",
                      );
                      setError("");
                    }}
                    className={`flex h-10 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] disabled:cursor-not-allowed disabled:opacity-60 ${
                      voiceInputMode === "free"
                        ? "border-[#0891b2] bg-[#ffd84d] text-[#083344] shadow-[0_2px_0_#0891b2]"
                        : "border-[#0891b2]/30 bg-white text-[#083344] hover:border-[#0891b2] hover:bg-[#e6faff]"
                    }`}
                  >
                    <span className="font-serif text-base font-black">T</span>
                    <span>全体指定</span>
                  </button>
                </div>
                <p className="mt-2 text-sm leading-6 text-[#686052]">
                  {voiceInputMode === "free"
                    ? "カテゴリに縛られず、声全体の特徴や話し方を文章で指定できます。"
                    : "カテゴリを切り替えて、作りたい声の特徴を選んでください。"}
                </p>
              </div>

              {voiceInputMode === "free" ? (
                <div
                  id="global-voice-prompt-panel"
                  className="rounded-xl border border-[#d8b146]/70 bg-white p-4 shadow-sm"
                >
                  <label
                    htmlFor="global-voice-prompt"
                    className="mb-3 block text-sm font-bold text-[#083344]"
                  >
                    声全体を文章で指定
                  </label>
                  <textarea
                    id="global-voice-prompt"
                    autoFocus
                    value={globalVoicePrompt}
                    onChange={(event) => {
                      setGlobalVoicePrompt(event.target.value);
                      setError("");
                    }}
                    rows={8}
                    maxLength={MAX_GLOBAL_VOICE_PROMPT_LENGTH}
                    disabled={controlsDisabled}
                    placeholder={GLOBAL_VOICE_PROMPT_PLACEHOLDER}
                    aria-describedby="global-voice-prompt-help global-voice-prompt-reading"
                    className="w-full resize-y rounded-lg border border-black/15 bg-[#fffefa] px-3 py-2.5 text-sm leading-6 outline-none transition placeholder:text-[#9a9389] focus:border-[#d4a51c] focus:ring-2 focus:ring-[#ffd84d]/30 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[#777067]">
                    <span>この文章だけを声の指示として使用します</span>
                    <span>
                      {globalVoicePrompt.length}/
                      {MAX_GLOBAL_VOICE_PROMPT_LENGTH}
                    </span>
                  </div>
                  <div className="mt-4 space-y-2 rounded-lg bg-[#fff7d6]/70 p-3 text-xs leading-5 text-[#62584d]">
                    <p id="global-voice-prompt-help">
                      <span className="font-bold text-[#083344]">指定例：</span>
                      性別印象、年齢感、声の高さ、声質、明暗、話す速さ、感情、キャラクター性
                    </p>
                    <p id="global-voice-prompt-reading">
                      <span className="font-bold text-[#083344]">
                        読み上げ文：
                      </span>
                      学習用に用意した{TRAINING_SAMPLE_TEXTS.length}
                      つの文章を自動で使用します。
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div
                    className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                    aria-label="声の属性カテゴリ"
                  >
                    {VOICE_ATTRIBUTE_GROUPS.map((group) => {
                      const isActive = activeAttribute === group.id;
                      const isCustom = customModes[group.id];

                      return (
                        <button
                          key={group.id}
                          type="button"
                          aria-pressed={isActive}
                          disabled={controlsDisabled}
                          onClick={() => {
                            setActiveAttribute(group.id);
                            setError("");
                          }}
                          className={`min-h-15 rounded-lg border px-3 py-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] disabled:cursor-not-allowed disabled:opacity-60 ${
                            isActive
                              ? "border-[#0891b2] bg-[#22d3ee] text-[#083344] shadow-[0_2px_0_#0891b2]"
                              : "border-black/10 bg-white text-[#403b35] hover:border-[#d8b146] hover:bg-[#fff7d6]"
                          }`}
                        >
                          <span className="block text-sm font-bold">
                            {group.label}
                          </span>
                          <span
                            className={`mt-0.5 block truncate text-[11px] ${
                              isActive ? "text-[#075985]" : "text-[#777067]"
                            }`}
                          >
                            {isCustom
                              ? "T  文章指定"
                              : attributeSelections[group.id]}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="rounded-xl border border-black/10 bg-white p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-sm font-bold">{activeGroup.label}</h3>
                      <button
                        type="button"
                        aria-pressed={customModes[activeGroup.id]}
                        aria-label={`${activeGroup.label}を文章で指定`}
                        title="文章で指定"
                        disabled={controlsDisabled}
                        onClick={() => handleCustomModeToggle(activeGroup.id)}
                        className={`flex h-9 w-9 items-center justify-center rounded-lg border font-serif text-base font-black transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] disabled:cursor-not-allowed disabled:opacity-60 ${
                          customModes[activeGroup.id]
                            ? "border-[#0891b2] bg-[#ffd84d] text-[#083344] shadow-[0_2px_0_#0891b2]"
                            : "border-[#0891b2]/30 bg-white text-[#083344] hover:border-[#0891b2] hover:bg-[#e6faff]"
                        }`}
                      >
                        T
                      </button>
                    </div>

                    {customModes[activeGroup.id] ? (
                      <div className="rounded-lg border border-[#d8b146]/60 bg-[#fffdf5] p-3">
                        <label
                          htmlFor={`voice-custom-${activeGroup.id}`}
                          className="mb-2 block text-xs font-bold text-[#087ea4]"
                        >
                          文章で指定
                        </label>
                        <textarea
                          id={`voice-custom-${activeGroup.id}`}
                          autoFocus
                          value={customPrompts[activeGroup.id]}
                          onChange={(event) => {
                            setCustomPrompts((current) => ({
                              ...current,
                              [activeGroup.id]: event.target.value,
                            }));
                            setError("");
                          }}
                          rows={4}
                          maxLength={MAX_CUSTOM_ATTRIBUTE_LENGTH}
                          disabled={controlsDisabled}
                          placeholder={
                            CUSTOM_PROMPT_PLACEHOLDERS[activeGroup.id]
                          }
                          className="w-full resize-y rounded-lg border border-black/15 bg-white px-3 py-2.5 text-sm leading-6 outline-none transition placeholder:text-[#9a9389] focus:border-[#d4a51c] focus:ring-2 focus:ring-[#ffd84d]/30 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[#777067]">
                          <span>候補ボタンの指定は使用しません</span>
                          <span>
                            {customPrompts[activeGroup.id].length}/
                            {MAX_CUSTOM_ATTRIBUTE_LENGTH}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div
                        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                        aria-label={`${activeGroup.label}の選択肢`}
                      >
                        {activeGroup.options.map(({ label }) => {
                          const isSelected =
                            attributeSelections[activeGroup.id] === label;

                          return (
                            <button
                              key={label}
                              type="button"
                              aria-pressed={isSelected}
                              disabled={controlsDisabled}
                              onClick={() =>
                                handleAttributeSelection(activeGroup.id, label)
                              }
                              className={`min-h-11 rounded-lg border px-2 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] disabled:cursor-not-allowed disabled:opacity-60 ${
                                isSelected
                                  ? "border-[#0891b2] bg-[#ffd84d] text-[#083344] shadow-[0_2px_0_#0891b2]"
                                  : "border-black/10 bg-white text-[#403b35] hover:border-[#d8b146] hover:bg-[#fff7d6]"
                              }`}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}
            </section>

            <div className="flex flex-col gap-3 p-5 sm:p-6">
              <button
                type="submit"
                disabled={
                  controlsDisabled || remainingTrainingSampleTexts.length === 0
                }
                className="flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-[#b91c1c] bg-[#dc2626] px-4 text-sm font-bold text-white shadow-[0_3px_0_#b91c1c] transition hover:bg-[#ef4444] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b91c1c] active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:border-[#a9a29e] disabled:bg-[#d6d3d1] disabled:text-[#68635f] disabled:shadow-none"
              >
                <MicrophoneIcon className="h-5 w-5" />
                {isGenerating && generationProgress
                  ? `${generationProgress.current}/${generationProgress.total}本目を生成中…`
                  : remainingTrainingSampleTexts.length === 0
                    ? `${TRAINING_SAMPLE_TEXTS.length}本の声を生成済み`
                    : completedPresetSampleCount > 0
                      ? `残り${remainingTrainingSampleTexts.length}本を生成`
                      : `声を生成（${TRAINING_SAMPLE_TEXTS.length}本）`}
              </button>

              {storageError ? (
                <p role="alert" className="mt-3 text-sm text-[#b91c1c]">{storageError}</p>
              ) : null}
              {error ? (
                <p
                  role="alert"
                  className="whitespace-pre-wrap rounded-md border border-[#f3b5b5] bg-[#fff1f1] px-3 py-2 text-sm font-bold leading-6 text-[#9b1c1c]"
                >
                  {error}
                </p>
              ) : null}

              <p className="text-center text-xs leading-5 text-[#6b7280]">
                学習用の{TRAINING_SAMPLE_TEXTS.length}
                つの文章を順番に生成します。初回は時間がかかる場合があります。
              </p>
            </div>
          </div>

          <div className="flex h-full flex-col">
            <aside className="flex h-full flex-col overflow-hidden rounded-xl border border-black/10 bg-white text-left text-[#403b35] shadow-sm">
              <section className="flex-1 border-b border-black/10 bg-[#fffdf5] p-5 sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-black tracking-[0.16em] text-[#9b6b16]">
                      SPEAKER INVERSION
                    </p>
                    <h3 className="mt-1 text-lg font-black">
                      声を学習して保存
                    </h3>
                  </div>
                  <span className="rounded-full bg-[#ffd84d] px-3 py-1 text-xs font-black text-[#513a00]">
                    {trainingSamples.length}/{requiredTrainingSamples}本以上
                  </span>
                </div>

                {speakerCapability && !speakerCapability.ready ? (
                  <p className="mt-2 text-[11px] font-bold text-[#b91c1c]">
                    {`学習を利用できません：${speakerCapability.reason ?? "サーバー設定を確認してください"}`}
                  </p>
                ) : null}

                <section
                  aria-label={`${showingTrained ? "学習後の声" : "学習前の声"} ${activeTrainingSampleIndex + 1}`}
                  className="mt-4 flex h-44 overflow-hidden rounded-lg border border-black/10 bg-white"
                >
                  <div className="flex w-12 shrink-0 flex-col items-center justify-center gap-1 border-r border-black/10 bg-[#fffdf5]">
                    <button
                      type="button"
                      aria-label="前の文章へ"
                      title="前の音声"
                      disabled={previousTrainingSampleIndex === undefined}
                      onClick={() => {
                        if (previousTrainingSampleIndex !== undefined) {
                          setActiveTrainingSampleIndex(
                            previousTrainingSampleIndex,
                          );
                        }
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-black/10 bg-white text-[#075985] transition hover:border-[#0891b2] hover:bg-[#e6faff] disabled:cursor-not-allowed disabled:opacity-25"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-4 w-4"
                      >
                        <path d="m6 15 6-6 6 6" />
                      </svg>
                    </button>

                    <span
                      aria-live="polite"
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-black ${showingTrained ? "bg-[#22c55e] text-white" : "bg-[#ffd84d] text-[#513a00]"}`}
                    >
                      {activeTrainingSampleIndex + 1}
                    </span>

                    <button
                      type="button"
                      aria-label="次の文章へ"
                      title="次の音声"
                      disabled={nextTrainingSampleIndex === undefined}
                      onClick={() => {
                        if (nextTrainingSampleIndex !== undefined) {
                          setActiveTrainingSampleIndex(nextTrainingSampleIndex);
                        }
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-black/10 bg-white text-[#075985] transition hover:border-[#0891b2] hover:bg-[#e6faff] disabled:cursor-not-allowed disabled:opacity-25"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-4 w-4"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col p-3">
                    <div role="group" aria-label="比較する音声" className="mb-2 flex shrink-0 gap-1 rounded-md bg-black/5 p-1">
                      <button
                        type="button"
                        aria-pressed={!showingTrained}
                        onClick={() => setSampleView("training")}
                        className={`min-w-0 flex-1 rounded px-2 py-1 text-xs font-bold ${!showingTrained ? "bg-[#ffd84d] text-[#513a00]" : "text-[#47616e]"}`}
                      >学習前の声</button>
                      <button
                        type="button"
                        aria-pressed={showingTrained}
                        disabled={!canPreviewTrained}
                        title={!canPreviewTrained ? "ボイスモデルの保存後に確認できます" : undefined}
                        onClick={() => setSampleView("trained")}
                        className={`min-w-0 flex-1 rounded px-2 py-1 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40 ${showingTrained ? "bg-[#22c55e] text-white" : "text-[#47616e]"}`}
                      >学習後の声</button>
                    </div>
                    <div className="flex min-h-0 flex-1 items-start gap-3 pb-2">
                      <div className="h-full min-w-0 flex-1 overflow-y-auto">
                        <p className="text-base font-bold leading-6">
                          {activeTrainingSampleText}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {!showingTrained && activeTrainingSample ? (
                          <button
                            type="button"
                            aria-label={`音声${activeTrainingSampleIndex + 1}を削除`}
                            disabled={controlsDisabled}
                            onClick={() =>
                              handleRemoveTrainingSample(
                                activeTrainingSample.id,
                              )
                            }
                            className="rounded-md px-2 py-1 text-sm font-black text-[#b91c1c] hover:bg-[#fff1f2] disabled:opacity-40"
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {showingTrained && generatingTrainedKey ? (
                      <p role="status" className="mb-1 text-xs text-[#15803d]">
                        学習後の声を生成中…（{Number(generatingTrainedKey.split(":").at(-1)) + 1}/{TRAINING_SAMPLE_TEXTS.length}）
                      </p>
                    ) : null}
                    {showingTrained ? (
                      activeTrainedAudio && !isCompletionPreview ? (
                        <audio
                          key={`trained:${trainedAudioKey}`}
                          aria-label={`学習後の声 ${activeTrainingSampleIndex + 1}を再生`}
                          src={activeTrainedAudio.audioUrl}
                          controls
                          preload="none"
                          className="mt-auto h-8 w-full shrink-0"
                        />
                      ) : (
                        <button
                          type="button"
                          disabled={controlsDisabled}
                          onClick={() => void handleGenerateTrainedSample()}
                          title={isCompletionPreview ? "表示のみのプレビューです" : undefined}
                          className="mt-auto h-8 w-full shrink-0 rounded-md border border-[#15803d] bg-[#f0fdf4] text-xs font-bold text-[#15803d] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {generatingTrainedKey
                            ? `学習後の声を生成中…（${Number(generatingTrainedKey.split(":").at(-1)) + 1}/${TRAINING_SAMPLE_TEXTS.length}）`
                            : "この文章で声を確認"}
                        </button>
                      )
                    ) : activeTrainingSample ? (
                      <audio
                        key={activeTrainingSample.id}
                        aria-label={`学習前の声 ${activeTrainingSampleIndex + 1}を再生`}
                        src={activeTrainingSample.audioUrl}
                        controls
                        preload="none"
                        className="mt-auto h-8 w-full shrink-0"
                      />
                    ) : (
                      <div className="mt-auto flex h-8 shrink-0 items-center justify-center rounded-md bg-black/[0.035] text-xs font-bold text-[#777067]">
                        {isGenerating &&
                        generationProgress?.current ===
                          activeTrainingSampleIndex + 1
                          ? "この音声を生成しています…"
                          : "まだ生成されていません"}
                      </div>
                    )}
                  </div>
                </section>

                {displayedSpeakerJob ? (
                  <div
                    className={`mt-4 rounded-xl border p-3 ${
                      displayedSpeakerJob.status === "failed"
                        ? "border-[#ef4444] bg-[#fff1f2]"
                        : displayedSpeakerJob.status === "completed"
                          ? "border-[#16a34a] bg-[#f0fdf4]"
                          : "border-[#0891b2]/40 bg-[#f5fdff]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3 text-xs font-black">
                      <span>{speakerPhaseLabel(displayedSpeakerJob)}</span>
                      <span>
                        {displayedSpeakerJob.progress.total > 0
                          ? `${displayedSpeakerJob.progress.current}/${displayedSpeakerJob.progress.total}`
                          : "—"}
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/10">
                      <div
                        className="h-full rounded-full bg-[#22d3ee] transition-[width]"
                        style={{
                          width: `${Math.round(displayedSpeakerJob.progress.ratio * 100)}%`,
                        }}
                      />
                    </div>
                    <p className="mt-2 text-[11px] leading-5 text-[#47616e]">
                      {displayedSpeakerJob.error ??
                        (displayedSpeakerJob.status === "completed"
                          ? "学習が完了しました。"
                          : displayedSpeakerJob.message)}
                    </p>
                  </div>
                ) : null}
              </section>

              <div className="flex flex-col gap-3 p-5 sm:p-6">
                <button
                  type="button"
                  disabled={
                    controlsDisabled ||
                    (trainingSamples.length === 0 && !referenceVoiceAssetId && !speakerJob && Object.keys(trainedAudio).length === 0)
                  }
                  onClick={() => void handleResetSamples()}
                  className="min-h-11 w-full rounded-xl border border-[#b91c1c] bg-white px-4 py-2 text-sm font-bold text-[#b91c1c] transition hover:bg-[#fff1f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b91c1c] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {displayedSpeakerJob?.result?.saved
                    ? "ボイスモデルを削除"
                    : "ボイスをすべて削除"}
                </button>
                {displayedSpeakerJob?.status === "completed" && displayedSpeakerJob.result ? (
                  <div role="status">
                    <button
                      type="button"
                      disabled
                      className={`min-h-12 w-full cursor-default rounded-xl border-2 px-4 py-2 text-sm font-black ${
                        displayedSavingSpeaker
                          ? "border-[#9b6b16] bg-[#ffd84d] text-[#513a00]"
                          : "border-[#15803d] bg-[#22c55e] text-white shadow-[0_4px_0_#15803d]"
                      }`}
                    >
                      {displayedSavingSpeaker
                        ? "ボイスモデルを保存中"
                        : "ボイスモデル保存済み"}
                    </button>
                  </div>
                ) : isTrainingActive ? (
                  <button
                    type="button"
                    onClick={() => void handleCancelTraining()}
                    disabled={isCancellingTraining}
                    className="min-h-11 w-full rounded-xl border-2 border-[#b91c1c] bg-white px-4 py-2 text-sm font-black text-[#b91c1c] disabled:opacity-50"
                  >
                    {isCancellingTraining ? "中止処理中…" : "学習を中止"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleStartTraining()}
                    disabled={
                      controlsDisabled ||
                      speakerCapability?.ready === false ||
                      trainingSamples.length < requiredTrainingSamples
                    }
                    className="min-h-12 w-full rounded-xl border-2 border-[#9b6b16] bg-[#ffd84d] px-4 py-2 text-sm font-black text-[#513a00] shadow-[0_4px_0_#9b6b16] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none"
                  >
                    {isStartingTraining
                      ? "学習データを送信中…"
                      : "ボイスモデルを生成"}
                  </button>
                )}
              </div>
            </aside>
          </div>
        </form>
      </main>
      {IS_DEVELOPMENT ? (
        <button
          type="button"
          disabled={isGenerating || isTrainingActive || isStartingTraining || isSavingSpeaker}
          onClick={() => {
            setIsProductionUiPreview((current) => !current);
            setError("");
          }}
          className="fixed right-4 bottom-24 z-50 flex items-center gap-2 rounded-full border border-[#0891b2] bg-white px-3 py-2 text-xs font-bold text-[#083344] shadow-lg transition hover:bg-[#e6faff] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] disabled:cursor-not-allowed disabled:opacity-60 sm:right-6 md:bottom-6"
        >
          <span className="rounded-full bg-[#22d3ee] px-2 py-1">
            {isProductionUiPreview
              ? "本番UIプレビュー中"
              : "開発UIプレビュー中"}
          </span>
          <span>{isProductionUiPreview ? "開発UIに戻る" : "本番UIを確認"}</span>
        </button>
      ) : null}
    </div>
  );
}
