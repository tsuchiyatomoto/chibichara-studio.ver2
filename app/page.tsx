"use client";

import Image from "next/image";
import { FormEvent, useEffect, useState } from "react";

type GenerateImageResponse = {
  image?: string;
  model?: string;
  provider?: ImageProvider;
  error?: string;
  detail?: string;
};

type ImageProvider = "vertex" | "openai";

const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
const IMAGE_PROVIDER_OPTIONS: ReadonlyArray<{
  id: ImageProvider;
  label: string;
}> = [
  { id: "vertex", label: "Nano Banana 2" },
  { id: "openai", label: "GPT Image 2" },
];

const AVATAR_FRAME_LABELS = [
  "目開き・口閉じ",
  "目開き・口開き",
  "目閉じ・口閉じ",
  "目閉じ・口開き",
] as const;

const OPEN_MOUTH_FRAME_PROMPT =
  "Change only the mouth from fully closed to a small, natural open speaking mouth. Preserve both eyes exactly as they appear in the reference image.";
const CLOSE_EYES_FRAME_PROMPT =
  "Change only both eyes from open to naturally closed as in a blink. Preserve the mouth exactly as it appears in the reference image.";
const COMBINE_CLOSED_EYES_FRAME_PROMPT =
  "Use the two provided images of the same posed avatar together. Treat the first reference image as the canonical source for the fully closed mouth and lower face. Treat the second reference image as the canonical source for the already-closed eyes and upper face. Create one coherent frame with the first reference's closed mouth and the second reference's closed eyes. Preserve the second reference's exact closed-eye shapes, inner and outer eye corners, eyelid height, spacing, and canvas positions. Preserve the exact character position, scale, pose, head angle, hair, clothing, outline, colors, lighting, framing, canvas size, and pure-white background shared by the references.";

async function requestGeneratedImage(
  prompt: string,
  provider: ImageProvider,
  referenceImage?: string,
  secondaryReferenceImage?: string,
) {
  const response = await fetch("/api/generate-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      ...(IS_DEVELOPMENT ? { provider } : {}),
      ...(referenceImage ? { referenceImage } : {}),
      ...(secondaryReferenceImage ? { secondaryReferenceImage } : {}),
    }),
  });
  const data = (await response.json()) as GenerateImageResponse;

  if (!response.ok) {
    throw new Error([data.error, data.detail].filter(Boolean).join("\n"));
  }

  if (!data.image) {
    throw new Error("生成結果に画像が含まれていません。再度お試しください。");
  }

  return data as GenerateImageResponse & { image: string };
}

const BASE_PROMPT =
  "Create one polished full-body chibi character illustration with a clean silhouette and expressive features on a flat, uniform pure-white background with no shadows, gradients, texture, text, borders, or additional characters. Center the single character in the square canvas, leave comfortable whitespace around the entire body, and keep every body part fully visible. Turn the character's face and torso slightly toward the left side of the image in a subtle three-quarter view. Use a consistent, production-ready chibi character design.";

const OUTFIT_CATEGORIES = [
  { label: "Tシャツ", prompt: "a casual T-shirt" },
  { label: "ファンタジー", prompt: "a fantasy outfit" },
  { label: "シャツ", prompt: "a shirt" },
  { label: "パーカー", prompt: "a hoodie" },
  { label: "ジャケット", prompt: "a jacket" },
  { label: "制服", prompt: "a school uniform" },
  { label: "スーツ", prompt: "a tailored suit" },
  { label: "ゴシック", prompt: "gothic fashion" },
  { label: "和服", prompt: "traditional Japanese clothing" },
] as const;

const GENDER_OPTIONS = [
  { label: "女の子", prompt: "a girl" },
  { label: "男の子", prompt: "a boy" },
] as const;

const MALE_HAIRSTYLE_OPTIONS = [
  { label: "短髪", prompt: "short-cropped hair" },
  { label: "ツーブロック", prompt: "a two-block haircut" },
  { label: "マッシュ", prompt: "a mushroom haircut" },
  { label: "オールバック", prompt: "slicked-back hair" },
  { label: "無造作ヘア", prompt: "tousled hair" },
] as const;

const FEMALE_HAIRSTYLE_OPTIONS = [
  { label: "ボブ", prompt: "a bob haircut" },
  { label: "ロング", prompt: "long hair" },
  { label: "ポニーテール", prompt: "a ponytail" },
  { label: "ツインテール", prompt: "twin tails" },
  { label: "三つ編み", prompt: "braided hair" },
  { label: "ウェーブ", prompt: "wavy hair" },
] as const;

const HAIRSTYLE_OPTIONS = [
  ...MALE_HAIRSTYLE_OPTIONS,
  ...FEMALE_HAIRSTYLE_OPTIONS,
] as const;

const HAIR_COLOR_OPTIONS = [
  { label: "黒", prompt: "black hair" },
  { label: "ダークブラウン", prompt: "dark brown hair" },
  { label: "茶", prompt: "brown hair" },
  { label: "ライトブラウン", prompt: "light brown hair" },
  { label: "金", prompt: "blonde hair" },
  { label: "白", prompt: "white hair" },
  { label: "銀", prompt: "silver hair" },
  { label: "グレー", prompt: "gray hair" },
  { label: "赤", prompt: "red hair" },
  { label: "オレンジ", prompt: "orange hair" },
  { label: "黄", prompt: "yellow hair" },
  { label: "ピンク", prompt: "pink hair" },
  { label: "紫", prompt: "purple hair" },
  { label: "青", prompt: "blue hair" },
  { label: "水色", prompt: "light blue hair" },
  { label: "紺", prompt: "navy blue hair" },
  { label: "緑", prompt: "green hair" },
  { label: "ミント", prompt: "mint-colored hair" },
  { label: "ワインレッド", prompt: "wine-red hair" },
] as const;

const EYE_SHAPE_OPTIONS = [
  { label: "丸目", prompt: "round eyes" },
  { label: "たれ目", prompt: "drooping eyes" },
  { label: "つり目", prompt: "upturned eyes" },
  { label: "猫目", prompt: "cat-like eyes" },
  { label: "ジト目", prompt: "unimpressed half-lidded eyes" },
  { label: "細目", prompt: "narrow eyes" },
  { label: "半目", prompt: "half-open eyes" },
  { label: "三白眼", prompt: "sanpaku eyes" },
  { label: "大きな目", prompt: "large eyes" },
] as const;

const EYE_COLOR_OPTIONS = [
  { label: "黒", prompt: "black irises" },
  { label: "ダークブラウン", prompt: "dark brown irises" },
  { label: "茶", prompt: "brown irises" },
  { label: "ライトブラウン", prompt: "light brown irises" },
  { label: "金", prompt: "golden irises" },
  { label: "白", prompt: "white irises" },
  { label: "銀", prompt: "silver irises" },
  { label: "グレー", prompt: "gray irises" },
  { label: "赤", prompt: "red irises" },
  { label: "オレンジ", prompt: "orange irises" },
  { label: "黄", prompt: "yellow irises" },
  { label: "ピンク", prompt: "pink irises" },
  { label: "紫", prompt: "purple irises" },
  { label: "青", prompt: "blue irises" },
  { label: "水色", prompt: "light blue irises" },
  { label: "紺", prompt: "navy blue irises" },
  { label: "緑", prompt: "green irises" },
  { label: "ミント", prompt: "mint-green irises" },
  { label: "ワインレッド", prompt: "wine-red irises" },
] as const;

type AttributeId =
  | "gender"
  | "hairstyle"
  | "hairColor"
  | "eyeShape"
  | "eyeColor"
  | "outfit";

type ColorSwatch = readonly [string, string?];

const COLOR_SWATCHES: Partial<
  Record<AttributeId, Record<string, ColorSwatch>>
> = {
  hairColor: {
    黒: ["#1d1b1b"],
    ダークブラウン: ["#3b2418"],
    茶: ["#74462e"],
    ライトブラウン: ["#b77b50"],
    金: ["#f2c94c"],
    白: ["#faf8f2"],
    銀: ["#c8cdd3"],
    グレー: ["#747a82"],
    赤: ["#c83b3b"],
    オレンジ: ["#f28c28"],
    黄: ["#f4dc4e"],
    ピンク: ["#f08fb6"],
    紫: ["#8154b8"],
    青: ["#3571c8"],
    水色: ["#82cdeb"],
    紺: ["#273d75"],
    緑: ["#3a9d64"],
    ミント: ["#82d7c2"],
    ワインレッド: ["#7d2638"],
  },
  eyeColor: {
    黒: ["#1d1b1b"],
    ダークブラウン: ["#3b2418"],
    茶: ["#74462e"],
    ライトブラウン: ["#b77b50"],
    金: ["#f2c94c"],
    白: ["#faf8f2"],
    銀: ["#c8cdd3"],
    グレー: ["#747a82"],
    赤: ["#c83b3b"],
    オレンジ: ["#f28c28"],
    黄: ["#f4dc4e"],
    ピンク: ["#f08fb6"],
    紫: ["#8154b8"],
    青: ["#3571c8"],
    水色: ["#82cdeb"],
    紺: ["#273d75"],
    緑: ["#3a9d64"],
    ミント: ["#82d7c2"],
    ワインレッド: ["#7d2638"],
  },
};

function getSwatchBackground(colors: ColorSwatch) {
  return colors[1]
    ? `linear-gradient(135deg, ${colors[0]} 0 50%, ${colors[1]} 50% 100%)`
    : colors[0];
}

type AttributeGroup = {
  id: AttributeId;
  label: string;
  options: ReadonlyArray<{ label: string; prompt: string }>;
};

const ATTRIBUTE_GROUPS = [
  { id: "gender", label: "性別・タイプ", options: GENDER_OPTIONS },
  { id: "hairstyle", label: "髪型", options: HAIRSTYLE_OPTIONS },
  { id: "hairColor", label: "髪色", options: HAIR_COLOR_OPTIONS },
  { id: "eyeShape", label: "目の形", options: EYE_SHAPE_OPTIONS },
  { id: "eyeColor", label: "目の色", options: EYE_COLOR_OPTIONS },
  { id: "outfit", label: "服装", options: OUTFIT_CATEGORIES },
] as const satisfies ReadonlyArray<AttributeGroup>;

type EditorSection = "attributes" | "pose";
type AttributeInputMode = "guided" | "free";
type ResultView = "character" | "avatar";
type PoseGroupId = "basic" | "gesture" | "reaction";

type PoseGroup = {
  id: PoseGroupId;
  label: string;
  options: ReadonlyArray<{ label: string; prompt: string }>;
};

const POSE_GROUPS: ReadonlyArray<PoseGroup> = [
  {
    id: "basic",
    label: "ポーズ1",
    options: [
      {
        label: "正面立ち",
        prompt: "standing upright in a mostly front-facing pose",
      },
      { label: "両手を合わせる", prompt: "both hands clasped together" },
      { label: "首かしげ", prompt: "tilting the head slightly" },
      { label: "横向き", prompt: "a side-facing standing pose" },
      { label: "手振り", prompt: "waving with one hand" },
      { label: "片手ピース", prompt: "making a peace sign with one hand" },
    ],
  },
  {
    id: "gesture",
    label: "ポーズ2",
    options: [
      { label: "両手ピース", prompt: "making peace signs with both hands" },
      { label: "片手を胸に当てる", prompt: "placing one hand over the chest" },
      {
        label: "両手を胸の前でそろえる",
        prompt: "holding both hands neatly together in front of the chest",
      },
      { label: "腕組み", prompt: "standing with arms crossed" },
      { label: "指さし", prompt: "pointing outward with one finger" },
      { label: "自分を指さす", prompt: "pointing at oneself" },
    ],
  },
  {
    id: "reaction",
    label: "ポーズ3",
    options: [
      { label: "ガッツポーズ", prompt: "a celebratory fist-pump pose" },
      { label: "サムズアップ", prompt: "giving a thumbs-up" },
      { label: "両手を広げる", prompt: "spreading both arms wide open" },
      { label: "あごに手を当てる", prompt: "touching the chin thoughtfully" },
      { label: "両手を頬に当てる", prompt: "placing both hands on the cheeks" },
      { label: "手を口元に添える", prompt: "holding one hand near the mouth" },
    ],
  },
];

const POSE_CUSTOM_PLACEHOLDER =
  "例：少し前かがみになり、片手で帽子を押さえながら笑顔で振り返る";

const INITIAL_POSE_SELECTIONS: Record<PoseGroupId, string | null> = {
  basic: "正面立ち",
  gesture: null,
  reaction: null,
};

const INITIAL_POSE_CUSTOM_MODES: Record<PoseGroupId, boolean> = {
  basic: false,
  gesture: false,
  reaction: false,
};

const INITIAL_POSE_CUSTOM_PROMPTS: Record<PoseGroupId, string> = {
  basic: "",
  gesture: "",
  reaction: "",
};

const INITIAL_ATTRIBUTE_SELECTIONS: Record<AttributeId, string> = {
  gender: "女の子",
  hairstyle: "ボブ",
  hairColor: "銀",
  eyeShape: "大きな目",
  eyeColor: "水色",
  outfit: "ファンタジー",
};

const CUSTOM_PROMPT_PLACEHOLDERS: Record<AttributeId, string> = {
  gender: "例：大人っぽく落ち着いた雰囲気の女性",
  hairstyle: "例：長めの前髪が片目にかかる、柔らかなウェーブヘア",
  hairColor: "例：根元は黒く、毛先に向かって淡いピンクになるグラデーション",
  eyeShape: "例：伏し目がちで、長いまつ毛のある優しい目",
  eyeColor: "例：透明感のある青緑色で、星形のハイライトが入った瞳",
  outfit: "例：白いケープと金色の装飾が付いた冒険者風の衣装",
};

const GLOBAL_CHARACTER_PROMPT_MAX_LENGTH = 800;
const GLOBAL_CHARACTER_PROMPT_PLACEHOLDER =
  "例：小柄な竜人の女の子。薄い褐色肌で、額に短い角があり、頬には星形の模様がある。先端がハート形の尻尾と片耳の大きなピアスが特徴。紺色の軍服風ワンピースに金色の肩章を付けている。";

const INITIAL_CUSTOM_MODES: Record<AttributeId, boolean> = {
  gender: false,
  hairstyle: false,
  hairColor: false,
  eyeShape: false,
  eyeColor: false,
  outfit: false,
};

const INITIAL_CUSTOM_PROMPTS: Record<AttributeId, string> = {
  gender: "",
  hairstyle: "",
  hairColor: "",
  eyeShape: "",
  eyeColor: "",
  outfit: "",
};

export default function Home() {
  const [imageProvider, setImageProvider] =
    useState<ImageProvider>("vertex");
  const [isProductionUiPreview, setIsProductionUiPreview] = useState(false);
  const [activeEditorSection, setActiveEditorSection] =
    useState<EditorSection>("attributes");
  const [activeAttribute, setActiveAttribute] =
    useState<AttributeId>("gender");
  const [attributeSelections, setAttributeSelections] = useState(
    INITIAL_ATTRIBUTE_SELECTIONS,
  );
  const [customModes, setCustomModes] = useState(INITIAL_CUSTOM_MODES);
  const [customPrompts, setCustomPrompts] = useState(INITIAL_CUSTOM_PROMPTS);
  const [attributeInputMode, setAttributeInputMode] =
    useState<AttributeInputMode>("guided");
  const [globalCharacterPrompt, setGlobalCharacterPrompt] = useState("");
  const [activePoseGroupId, setActivePoseGroupId] =
    useState<PoseGroupId>("basic");
  const [poseSelections, setPoseSelections] = useState(
    INITIAL_POSE_SELECTIONS,
  );
  const [poseCustomModes, setPoseCustomModes] = useState(
    INITIAL_POSE_CUSTOM_MODES,
  );
  const [poseCustomPrompts, setPoseCustomPrompts] = useState(
    INITIAL_POSE_CUSTOM_PROMPTS,
  );
  const [results, setResults] = useState<
    Record<ResultView, GenerateImageResponse | null>
  >({
    character: null,
    avatar: null,
  });
  const [avatarFrames, setAvatarFrames] = useState<string[]>([]);
  const [isAvatarMouthOpen, setIsAvatarMouthOpen] = useState(false);
  const [areAvatarEyesClosed, setAreAvatarEyesClosed] = useState(false);
  const [isAvatarPreviewPlaying, setIsAvatarPreviewPlaying] = useState(true);
  const [selectedAvatarFrameIndex, setSelectedAvatarFrameIndex] = useState(0);
  const [activeResultView, setActiveResultView] =
    useState<ResultView>("character");
  const [generatingResultView, setGeneratingResultView] =
    useState<ResultView | null>(null);
  const [generationProgress, setGenerationProgress] = useState(100);
  const [generationProgressTarget, setGenerationProgressTarget] =
    useState(100);
  const [generationProgressRunId, setGenerationProgressRunId] = useState(0);
  const [error, setError] = useState("");

  const activeGroup =
    ATTRIBUTE_GROUPS.find(({ id }) => id === activeAttribute) ??
    ATTRIBUTE_GROUPS[0];
  const activeColorSwatches = COLOR_SWATCHES[activeGroup.id];
  const activeOptions: ReadonlyArray<{ label: string; prompt: string }> =
    activeGroup.id === "hairstyle"
      ? customModes.gender
        ? HAIRSTYLE_OPTIONS
        : attributeSelections.gender === "男の子"
        ? MALE_HAIRSTYLE_OPTIONS
        : FEMALE_HAIRSTYLE_OPTIONS
      : activeGroup.options;
  const activePoseGroup =
    POSE_GROUPS.find(({ id }) => id === activePoseGroupId) ?? POSE_GROUPS[0];
  const generationTarget: ResultView =
    activeEditorSection === "attributes" ? "character" : "avatar";
  const generationTargetLabel =
    generationTarget === "character" ? "キャラクター" : "アバター";
  const activeResult = results[activeResultView];
  const activeResultLabel =
    activeResultView === "character" ? "キャラクター" : "アバター";
  const isGenerating = generatingResultView !== null;
  const animatedAvatarFrameIndex =
    (areAvatarEyesClosed ? 2 : 0) + (isAvatarMouthOpen ? 1 : 0);
  const isAvatarFrameInspectionPaused =
    IS_DEVELOPMENT &&
    !isProductionUiPreview &&
    !isAvatarPreviewPlaying;
  const activeAvatarFrameIndex = isAvatarFrameInspectionPaused
    ? selectedAvatarFrameIndex
    : animatedAvatarFrameIndex;
  const visibleGenerationProgress =
    generatingResultView === activeResultView ? generationProgress : 100;

  useEffect(() => {
    if (!isGenerating) {
      return;
    }

    const progressTimer = window.setInterval(() => {
      setGenerationProgress((current) => {
        if (current >= generationProgressTarget) {
          return current;
        }

        const remaining = generationProgressTarget - current;
        return Math.min(
          generationProgressTarget,
          current + Math.max(0.15, remaining * 0.035),
        );
      });
    }, 250);

    return () => window.clearInterval(progressTimer);
  }, [generationProgressTarget, isGenerating]);

  useEffect(() => {
    if (
      avatarFrames.length !== AVATAR_FRAME_LABELS.length ||
      isAvatarFrameInspectionPaused
    ) {
      return;
    }

    const mouthTimer = window.setInterval(() => {
      setIsAvatarMouthOpen((current) => !current);
    }, 260);
    let blinkResetTimer: number | undefined;
    const blinkTimer = window.setInterval(() => {
      setAreAvatarEyesClosed(true);
      window.clearTimeout(blinkResetTimer);
      blinkResetTimer = window.setTimeout(() => {
        setAreAvatarEyesClosed(false);
      }, 160);
    }, 2800);

    return () => {
      window.clearInterval(mouthTimer);
      window.clearInterval(blinkTimer);
      window.clearTimeout(blinkResetTimer);
    };
  }, [avatarFrames.length, isAvatarFrameInspectionPaused]);

  function handleCustomModeToggle(groupId: AttributeId) {
    const nextIsCustom = !customModes[groupId];

    setCustomModes((current) => ({
      ...current,
      [groupId]: nextIsCustom,
    }));
    setError("");

    if (groupId === "gender" && !nextIsCustom) {
      setAttributeSelections((current) => ({
        ...current,
        hairstyle: current.gender === "男の子" ? "短髪" : "ボブ",
      }));
    }
  }

  function handleAttributeSelection(groupId: AttributeId, label: string) {
    setAttributeSelections((current) => {
      if (groupId === "gender") {
        return {
          ...current,
          gender: label,
          hairstyle: label === "男の子" ? "短髪" : "ボブ",
        };
      }

      return {
        ...current,
        [groupId]: label,
      };
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = generationTarget;
    const selectedImageProvider = isProductionUiPreview
      ? "vertex"
      : imageProvider;
    const baseCharacterImage = results.character?.image;

    if (target === "avatar" && !baseCharacterImage) {
      setActiveResultView("character");
      setError("先にキャラクターを生成してください。");
      return;
    }

    if (
      target === "character" &&
      attributeInputMode === "free" &&
      !globalCharacterPrompt.trim()
    ) {
      setActiveEditorSection("attributes");
      setError("キャラクター全体の文章を入力してください。");
      return;
    }

    const emptyCustomGroup =
      target === "character" && attributeInputMode === "guided"
        ? ATTRIBUTE_GROUPS.find(
            (group) =>
              customModes[group.id] && !customPrompts[group.id].trim(),
          )
        : undefined;

    if (emptyCustomGroup) {
      setActiveEditorSection("attributes");
      setActiveAttribute(emptyCustomGroup.id);
      setError(`${emptyCustomGroup.label}の文章を入力してください。`);
      return;
    }

    const emptyCustomPoseGroup =
      target === "avatar" &&
      poseCustomModes.basic &&
      !poseCustomPrompts.basic.trim()
        ? POSE_GROUPS.find(({ id }) => id === "basic")
        : undefined;

    if (emptyCustomPoseGroup) {
      setActiveEditorSection("pose");
      setActivePoseGroupId(emptyCustomPoseGroup.id);
      setError(`${emptyCustomPoseGroup.label}の文章を入力してください。`);
      return;
    }

    setError("");
    setGenerationProgress(0);
    setGenerationProgressTarget(target === "avatar" ? 20 : 92);
    setGenerationProgressRunId((current) => current + 1);
    setGeneratingResultView(target);
    setActiveResultView(target);
    setResults((current) => ({
      ...current,
      [target]: null,
    }));

    if (target === "avatar") {
      setAvatarFrames([]);
      setIsAvatarMouthOpen(false);
      setAreAvatarEyesClosed(false);
      setIsAvatarPreviewPlaying(true);
      setSelectedAvatarFrameIndex(0);
    }

    try {
      if (target === "character") {
        const characterDescription =
          attributeInputMode === "free"
            ? `User-specified character design: ${globalCharacterPrompt.trim()}`
            : `Character attributes: ${ATTRIBUTE_GROUPS.flatMap((group) => {
                if (customModes[group.id]) {
                  return [
                    `${group.label}: ${customPrompts[group.id].trim()}`,
                  ];
                }

                const selectedOption = group.options.find(
                  ({ label }) => label === attributeSelections[group.id],
                );

                return selectedOption ? [selectedOption.prompt] : [];
              }).join("; ")}`;
        const generationPrompt = `${BASE_PROMPT}\n\n${characterDescription}. Make every requested visual detail clearly recognizable.\nCreate the canonical base character design in a simple neutral standing pose, with the arms relaxed, both eyes clearly open, the mouth fully closed, and a calm expression. These composition, pose, eye, and mouth requirements override any conflicting details in the user-specified character design.`;
        const data = await requestGeneratedImage(
          generationPrompt,
          selectedImageProvider,
        );
        setGenerationProgress(100);
        setGenerationProgressTarget(100);

        setAvatarFrames([]);
        setIsAvatarMouthOpen(false);
        setAreAvatarEyesClosed(false);
        setResults({
          character: data,
          avatar: null,
        });
      } else {
        const poseOneGroup = POSE_GROUPS.find(({ id }) => id === "basic");
        const selectedPoseOne = poseOneGroup?.options.find(
          ({ label }) => label === poseSelections.basic,
        );
        const poseOneInstruction = poseCustomModes.basic
          ? poseCustomPrompts.basic.trim()
          : (selectedPoseOne?.prompt ?? "a natural relaxed standing pose");
        const posedAvatarPrompt = `Use the provided image as the canonical character reference. Create one full-body square avatar of exactly the same character performing this pose: ${poseOneInstruction}. Preserve the character's identity, face, hairstyle, hair color, eye design and color, clothing, body proportions, chibi art style, line work, and colors. Keep the same character scale and centered framing on a flat, uniform pure-white background. Show only one character with the full body visible. Keep both eyes fully open and the mouth fully closed. Do not add text, borders, guides, props, or extra characters.`;
        const posedAvatar = await requestGeneratedImage(
          posedAvatarPrompt,
          selectedImageProvider,
          baseCharacterImage,
        );
        setGenerationProgress(25);
        setGenerationProgressTarget(45);
        const frameEditPrefix =
          "Edit the provided posed avatar into one frame-difference image for blinking and lip-sync animation. Preserve the exact canvas coordinates. Do not redraw, move, rescale, crop, rotate, recolor, or otherwise alter the character, pose, head angle, hands, body, hair, clothing, outline, lighting, framing, or pure-white background. ";
        const openMouthFrame = await requestGeneratedImage(
          `${frameEditPrefix}${OPEN_MOUTH_FRAME_PROMPT} Return only the edited square image with no text or guides.`,
          selectedImageProvider,
          posedAvatar.image,
        );
        setGenerationProgress(50);
        setGenerationProgressTarget(70);
        const closedEyesOpenMouthFrame = await requestGeneratedImage(
          `${frameEditPrefix}${CLOSE_EYES_FRAME_PROMPT} Return only the edited square image with no text or guides.`,
          selectedImageProvider,
          openMouthFrame.image,
        );
        setGenerationProgress(75);
        setGenerationProgressTarget(92);
        const closedEyesClosedMouthFrame = await requestGeneratedImage(
          `${COMBINE_CLOSED_EYES_FRAME_PROMPT} Return only the completed square frame with no text or guides.`,
          selectedImageProvider,
          posedAvatar.image,
          closedEyesOpenMouthFrame.image,
        );
        setGenerationProgress(100);
        setGenerationProgressTarget(100);

        setAvatarFrames([
          posedAvatar.image,
          openMouthFrame.image,
          closedEyesClosedMouthFrame.image,
          closedEyesOpenMouthFrame.image,
        ]);
        setResults((current) => ({
          ...current,
          avatar: posedAvatar,
        }));
      }
    } catch (generationError) {
      setError(
        generationError instanceof Error
          ? generationError.message
          : "Generation failed.",
      );
    } finally {
      setGeneratingResultView(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#f6f7fb] text-[#171717]">
      <header className="border-b border-black/10 bg-white">
        <div className="mx-auto flex h-24 w-full max-w-7xl items-center gap-4 px-5 sm:px-8 lg:px-10">
          <Image
            src="/favicon.png"
            alt=""
            width={72}
            height={72}
            priority
            className="h-[72px] w-[72px] rounded-md object-contain"
          />
          <h1 className="text-4xl font-semibold tracking-tight">
            chibichara studio
          </h1>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-8 sm:px-8 lg:px-10">
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,500px)_minmax(0,1fr)]">
          <form
            onSubmit={handleSubmit}
            className="overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm"
          >
            {IS_DEVELOPMENT && !isProductionUiPreview ? (
              <div className="border-b border-black/10 bg-[#f3ecdc] p-4 sm:px-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      id="image-provider-label"
                      className="text-sm font-bold text-[#083344]"
                    >
                      画像モデル
                    </span>
                    <span className="rounded-full border border-[#d8b146] bg-[#fff7d6] px-2 py-0.5 text-[10px] font-bold text-[#74500d]">
                      開発環境のみ
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div
                      role="radiogroup"
                      aria-labelledby="image-provider-label"
                      className="grid grid-cols-2 gap-1 rounded-lg bg-white/80 p-1"
                    >
                      {IMAGE_PROVIDER_OPTIONS.map((provider) => {
                        const isSelected = imageProvider === provider.id;

                        return (
                          <button
                            key={provider.id}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            disabled={isGenerating}
                            onClick={() => {
                              setImageProvider(provider.id);
                              setError("");
                            }}
                            className={`rounded-md px-3 py-2 text-xs font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] disabled:cursor-not-allowed disabled:opacity-60 ${
                              isSelected
                                ? "bg-[#22d3ee] text-[#083344] shadow-sm"
                                : "text-[#35515f] hover:bg-[#e6faff]"
                            }`}
                          >
                            {provider.label}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      disabled={isGenerating}
                      onClick={() => {
                        setIsProductionUiPreview(true);
                        setIsAvatarMouthOpen(false);
                        setAreAvatarEyesClosed(false);
                        setIsAvatarPreviewPlaying(true);
                        setError("");
                      }}
                      className="rounded-lg border border-[#0891b2] bg-white px-3 py-2 text-xs font-bold text-[#083344] transition hover:bg-[#e6faff] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      本番UIを確認
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            <section className="border-b border-black/10 bg-[#fffdf5] p-5 sm:p-6">
              <div
                className="mb-6 grid grid-cols-2 gap-1 rounded-xl border border-[#0891b2]/30 bg-white p-1"
                aria-label="編集項目"
              >
                <button
                  type="button"
                  aria-pressed={activeEditorSection === "attributes"}
                  onClick={() => setActiveEditorSection("attributes")}
                  className={`rounded-lg px-4 py-2.5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                    activeEditorSection === "attributes"
                      ? "bg-[#22d3ee] text-[#083344] shadow-sm"
                    : "text-[#083344] hover:bg-[#e6faff]"
                  }`}
                >
                  <span className="block text-sm font-bold">属性</span>
                </button>
                <button
                  type="button"
                  aria-pressed={activeEditorSection === "pose"}
                  onClick={() => setActiveEditorSection("pose")}
                  className={`rounded-lg px-4 py-2.5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                    activeEditorSection === "pose"
                      ? "bg-[#22d3ee] text-[#083344] shadow-sm"
                    : "text-[#083344] hover:bg-[#e6faff]"
                  }`}
                >
                  <span className="block text-sm font-bold">ポーズ</span>
                </button>
              </div>

              {activeEditorSection === "attributes" ? (
                <>
              <div className="mb-2 flex items-start justify-between gap-4">
                <div>
                  <p className="mb-1 text-xs font-bold tracking-[0.18em] text-[#9b6b16] uppercase">
                    Character attributes
                  </p>
                  <h2 className="text-xl font-bold tracking-tight">属性</h2>
                </div>
                <button
                  type="button"
                  aria-pressed={attributeInputMode === "free"}
                  aria-controls="global-character-prompt-panel"
                  aria-label="キャラクター全体を文章で指定"
                  title="キャラクター全体を文章で指定"
                  onClick={() => {
                    setAttributeInputMode((current) =>
                      current === "guided" ? "free" : "guided",
                    );
                    setError("");
                  }}
                  className={`flex h-10 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                    attributeInputMode === "free"
                      ? "border-[#0891b2] bg-[#ffd84d] text-[#083344] shadow-[0_2px_0_#0891b2]"
                      : "border-[#0891b2]/30 bg-white text-[#083344] hover:border-[#0891b2] hover:bg-[#e6faff]"
                  }`}
                >
                  <span className="font-serif text-base font-black">T</span>
                  <span>全体指定</span>
                </button>
              </div>
              <p className="mb-5 text-sm leading-6 text-[#686052]">
                {attributeInputMode === "free"
                  ? "カテゴリに縛られず、キャラクター全体の特徴を文章で指定できます。"
                  : "カテゴリを切り替えて、キャラクターの特徴を選んでください。"}
              </p>

              {attributeInputMode === "free" ? (
                <div
                  id="global-character-prompt-panel"
                  className="rounded-xl border border-[#d8b146]/70 bg-white p-4 shadow-sm"
                >
                  <label
                    htmlFor="global-character-prompt"
                    className="mb-3 block text-sm font-bold text-[#083344]"
                  >
                    キャラクター全体を文章で指定
                  </label>
                  <textarea
                    id="global-character-prompt"
                    autoFocus
                    value={globalCharacterPrompt}
                    onChange={(event) => {
                      setGlobalCharacterPrompt(event.target.value);
                      setError("");
                    }}
                    rows={8}
                    maxLength={GLOBAL_CHARACTER_PROMPT_MAX_LENGTH}
                    placeholder={GLOBAL_CHARACTER_PROMPT_PLACEHOLDER}
                    aria-describedby="global-character-prompt-help global-character-prompt-fixed"
                    className="w-full resize-y rounded-lg border border-black/15 bg-[#fffefa] px-3 py-2.5 text-sm leading-6 outline-none transition placeholder:text-[#9a9389] focus:border-[#d4a51c] focus:ring-2 focus:ring-[#ffd84d]/30"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[#777067]">
                    <span>この文章だけを属性として使用します</span>
                    <span>
                      {globalCharacterPrompt.length}/
                      {GLOBAL_CHARACTER_PROMPT_MAX_LENGTH}
                    </span>
                  </div>
                  <div className="mt-4 space-y-2 rounded-lg bg-[#fff7d6]/70 p-3 text-xs leading-5 text-[#62584d]">
                    <p id="global-character-prompt-help">
                      <span className="font-bold text-[#083344]">指定例：</span>
                      種族、年齢感、体格、肌、顔、耳、角、尻尾、模様、装飾、衣装、素材、雰囲気
                    </p>
                    <p id="global-character-prompt-fixed">
                      <span className="font-bold text-[#083344]">固定：</span>
                      ちびキャラ・1人・全身・白背景・少し左向き・目開き・口閉じ。ポーズはポーズ画面で指定します。
                    </p>
                  </div>
                </div>
              ) : (
                <>
              <div
                className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                aria-label="属性カテゴリ"
              >
                {ATTRIBUTE_GROUPS.map((group) => {
                  const isActive = activeAttribute === group.id;
                  const isCustom = customModes[group.id];
                  const selectedSwatch = isCustom
                    ? undefined
                    : COLOR_SWATCHES[group.id]?.[
                        attributeSelections[group.id]
                      ];

                  return (
                    <button
                      key={group.id}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => setActiveAttribute(group.id)}
                      className={`min-h-15 rounded-lg border px-3 py-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                        isActive
                          ? "border-[#0891b2] bg-[#22d3ee] text-[#083344] shadow-[0_2px_0_#0891b2]"
                          : "border-black/10 bg-white text-[#403b35] hover:border-[#d8b146] hover:bg-[#fff7d6]"
                      }`}
                    >
                      <span className="block text-sm font-bold">
                        {group.label}
                      </span>
                      <span
                        className={`mt-0.5 flex min-h-4 items-center text-[11px] ${
                          isActive ? "text-[#075985]" : "text-[#777067]"
                        }`}
                      >
                        {isCustom ? (
                          <span className="font-semibold">T&nbsp; 文章指定</span>
                        ) : selectedSwatch ? (
                          <>
                            <span
                              aria-hidden="true"
                              className="h-3.5 w-3.5 rounded-full border border-black/20 shadow-sm"
                              style={{
                                background:
                                  getSwatchBackground(selectedSwatch),
                              }}
                            />
                            <span className="sr-only">
                              {attributeSelections[group.id]}
                            </span>
                          </>
                        ) : (
                          <span className="truncate">
                            {attributeSelections[group.id]}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-5 rounded-xl border border-black/10 bg-white p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-bold">{activeGroup.label}</h3>
                  <button
                    type="button"
                    aria-pressed={customModes[activeGroup.id]}
                    aria-label={`${activeGroup.label}を文章で指定`}
                    title="文章で指定"
                    onClick={() => handleCustomModeToggle(activeGroup.id)}
                    className={`flex h-9 w-9 items-center justify-center rounded-lg border font-serif text-base font-black transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
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
                      htmlFor={`custom-prompt-${activeGroup.id}`}
                      className="mb-2 block text-xs font-bold text-[#087ea4]"
                    >
                      文章で指定
                    </label>
                    <textarea
                      id={`custom-prompt-${activeGroup.id}`}
                      autoFocus
                      value={customPrompts[activeGroup.id]}
                      onChange={(event) =>
                        setCustomPrompts((current) => ({
                          ...current,
                          [activeGroup.id]: event.target.value,
                        }))
                      }
                      rows={4}
                      maxLength={160}
                      placeholder={CUSTOM_PROMPT_PLACEHOLDERS[activeGroup.id]}
                      className="w-full resize-y rounded-lg border border-black/15 bg-white px-3 py-2.5 text-sm leading-6 outline-none transition placeholder:text-[#9a9389] focus:border-[#d4a51c] focus:ring-2 focus:ring-[#ffd84d]/30"
                    />
                    <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[#777067]">
                      <span>候補ボタンの指定は使用しません</span>
                      <span>{customPrompts[activeGroup.id].length}/160</span>
                    </div>
                  </div>
                ) : (
                  <div
                    className={
                      activeColorSwatches
                        ? "grid grid-cols-5 gap-3 sm:grid-cols-7"
                        : activeOptions.length === 2
                          ? "grid grid-cols-2 gap-2"
                          : "grid grid-cols-2 gap-2 sm:grid-cols-3"
                    }
                    aria-label={`${activeGroup.label}の選択肢`}
                  >
                    {activeOptions.map(({ label }) => {
                      const isSelected =
                        attributeSelections[activeGroup.id] === label;
                      const swatch = activeColorSwatches?.[label];

                      return (
                        <button
                          key={label}
                          type="button"
                          aria-pressed={isSelected}
                          aria-label={
                            swatch
                              ? `${activeGroup.label}: ${label}`
                              : undefined
                          }
                          title={swatch ? label : undefined}
                          onClick={() =>
                            handleAttributeSelection(activeGroup.id, label)
                          }
                          className={
                            swatch
                              ? `relative aspect-square rounded-xl border p-1.5 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                                  isSelected
                                    ? "border-[#0891b2] bg-white shadow-[0_0_0_2px_#ffd84d]"
                                    : "border-black/15 bg-white hover:-translate-y-0.5 hover:border-[#d8b146] hover:shadow-sm"
                                }`
                              : `min-h-11 rounded-lg border px-2 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                                  isSelected
                                    ? "border-[#0891b2] bg-[#ffd84d] text-[#083344] shadow-[0_2px_0_#0891b2]"
                                    : "border-black/10 bg-[#fffefa] text-[#403b35] hover:border-[#d8b146] hover:bg-[#fff7d6]"
                                }`
                          }
                        >
                          {swatch ? (
                            <>
                              <span
                                aria-hidden="true"
                                className="block h-full w-full rounded-lg border border-black/15 shadow-inner"
                                style={{
                                  background: getSwatchBackground(swatch),
                                }}
                              />
                              {isSelected ? (
                                <span
                                  aria-hidden="true"
                                  className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-[#22d3ee] text-[11px] font-bold text-[#083344] shadow-sm"
                                >
                                  ✓
                                </span>
                              ) : null}
                              <span className="sr-only">{label}</span>
                            </>
                          ) : (
                            label
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
                </>
              )}
                </>
              ) : (
                <>
                  <div className="mb-2">
                    <div>
                      <p className="mb-1 text-xs font-bold tracking-[0.18em] text-[#9b6b16] uppercase">
                        Character pose
                      </p>
                      <h2 className="text-xl font-bold tracking-tight">
                        ポーズ
                      </h2>
                    </div>
                  </div>
                  <p className="mb-5 text-sm leading-6 text-[#686052]">
                    ポーズ1〜3から各1つ、合計最大3つまで指定できます。
                  </p>

                  <div
                    className="grid grid-cols-3 gap-2"
                    aria-label="ポーズ項目"
                  >
                    {POSE_GROUPS.map((group) => {
                      const isActive = activePoseGroupId === group.id;
                      const isCustom = poseCustomModes[group.id];
                      const selectedForGroup = poseSelections[group.id];

                      return (
                        <button
                          key={group.id}
                          type="button"
                          aria-pressed={isActive}
                          onClick={() => setActivePoseGroupId(group.id)}
                          className={`min-h-15 rounded-lg border px-3 py-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                            isActive
                              ? "border-[#0891b2] bg-[#22d3ee] text-[#083344] shadow-[0_2px_0_#0891b2]"
                              : "border-black/10 bg-white text-[#403b35] hover:border-[#d8b146] hover:bg-[#fff7d6]"
                          }`}
                        >
                          <span className="block truncate text-sm font-bold">
                            {group.label}
                          </span>
                          <span
                            className={`mt-0.5 block truncate text-[11px] ${
                              isActive ? "text-[#075985]" : "text-[#777067]"
                            }`}
                          >
                            {isCustom
                              ? "T  文章指定"
                              : (selectedForGroup ?? "未選択")}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-5 rounded-xl border border-black/10 bg-white p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-sm font-bold">
                        {activePoseGroup.label}
                      </h3>
                      <button
                        type="button"
                        aria-pressed={poseCustomModes[activePoseGroup.id]}
                        aria-label={`${activePoseGroup.label}を文章で指定`}
                        title="文章で指定"
                        onClick={() => {
                          setPoseCustomModes((current) => ({
                            ...current,
                            [activePoseGroup.id]:
                              !current[activePoseGroup.id],
                          }));
                          setError("");
                        }}
                        className={`flex h-9 w-9 items-center justify-center rounded-lg border font-serif text-base font-black transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                          poseCustomModes[activePoseGroup.id]
                            ? "border-[#0891b2] bg-[#ffd84d] text-[#083344] shadow-[0_2px_0_#0891b2]"
                            : "border-[#0891b2]/30 bg-white text-[#083344] hover:border-[#0891b2] hover:bg-[#e6faff]"
                        }`}
                      >
                        T
                      </button>
                    </div>

                    {poseCustomModes[activePoseGroup.id] ? (
                      <div className="rounded-lg border border-[#d8b146]/60 bg-[#fffdf5] p-3">
                        <label
                          htmlFor={`custom-pose-${activePoseGroup.id}`}
                          className="mb-2 block text-xs font-bold text-[#087ea4]"
                        >
                          文章で指定
                        </label>
                        <textarea
                          id={`custom-pose-${activePoseGroup.id}`}
                          autoFocus
                          value={poseCustomPrompts[activePoseGroup.id]}
                          onChange={(event) =>
                            setPoseCustomPrompts((current) => ({
                              ...current,
                              [activePoseGroup.id]: event.target.value,
                            }))
                          }
                          rows={4}
                          maxLength={160}
                          placeholder={POSE_CUSTOM_PLACEHOLDER}
                          className="w-full resize-y rounded-lg border border-black/15 bg-white px-3 py-2.5 text-sm leading-6 outline-none transition placeholder:text-[#9a9389] focus:border-[#d4a51c] focus:ring-2 focus:ring-[#ffd84d]/30"
                        />
                        <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[#777067]">
                          <span>候補ボタンの指定は使用しません</span>
                          <span>
                            {poseCustomPrompts[activePoseGroup.id].length}/160
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div
                          className="grid grid-cols-2 gap-2"
                          aria-label={`${activePoseGroup.label}の選択肢`}
                        >
                          {activePoseGroup.options.map(({ label }) => {
                            const isSelected =
                              poseSelections[activePoseGroup.id] === label;

                            return (
                              <button
                                key={label}
                                type="button"
                                aria-pressed={isSelected}
                                onClick={() => {
                                  setPoseSelections((current) => ({
                                    ...current,
                                    [activePoseGroup.id]:
                                      current[activePoseGroup.id] === label
                                        ? null
                                        : label,
                                  }));
                                  setError("");
                                }}
                                className={`min-h-11 rounded-lg border px-2 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                                  isSelected
                                    ? "border-[#0891b2] bg-[#ffd84d] text-[#083344] shadow-[0_2px_0_#0891b2]"
                                    : "border-black/10 bg-[#fffefa] text-[#403b35] hover:border-[#d8b146] hover:bg-[#fff7d6]"
                                }`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </section>

            <div className="flex flex-col gap-3 p-5 sm:p-6">
              <button
                type="submit"
                disabled={isGenerating}
                className="h-12 rounded-lg border border-[#b91c1c] bg-[#dc2626] px-4 text-sm font-bold text-white shadow-[0_3px_0_#b91c1c] transition hover:bg-[#ef4444] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b91c1c] active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:border-[#a9a29e] disabled:bg-[#d6d3d1] disabled:text-[#68635f] disabled:shadow-none"
              >
                {isGenerating
                  ? `${
                      generatingResultView === "character"
                        ? "キャラクター"
                        : "アバター"
                    }生成中...`
                  : `${generationTargetLabel}生成`}
              </button>
              {error ? (
                <p className="rounded-md border border-[#f3b5b5] bg-[#fff1f1] px-3 py-2 text-sm leading-6 text-[#9b1c1c]">
                  {error}
                </p>
              ) : null}
            </div>
          </form>

          <section className="flex flex-col items-center gap-4">
            <div className="relative aspect-square w-[600px] max-w-[calc(100%-1rem)] flex-none">
              <div
                id="generated-image-panel"
                role="tabpanel"
                className="absolute inset-[7.333%] z-10 flex items-center justify-center overflow-hidden rounded-full border-[10px] border-[#22d3ee] bg-white shadow-md"
              >
                {activeResult?.image ? (
                  activeResultView === "avatar" &&
                  avatarFrames.length === AVATAR_FRAME_LABELS.length ? (
                    avatarFrames.map((frame, index) => (
                      <Image
                        key={`${AVATAR_FRAME_LABELS[index]}-${index}`}
                        src={frame}
                        alt={`生成したアバター（${AVATAR_FRAME_LABELS[index]}）`}
                        fill
                        sizes="(max-width: 640px) calc(100vw - 5rem), 512px"
                        unoptimized
                        aria-hidden={index !== activeAvatarFrameIndex}
                        className={`object-contain ${
                          index === activeAvatarFrameIndex
                            ? "opacity-100"
                            : "opacity-0"
                        }`}
                      />
                    ))
                  ) : (
                    <Image
                      src={activeResult.image}
                      alt={`生成した${activeResultLabel}`}
                      fill
                      sizes="(max-width: 640px) calc(100vw - 5rem), 512px"
                      unoptimized
                      className="object-contain"
                    />
                  )
                ) : (
                  <div className="flex h-full w-full items-center justify-center px-10 text-center text-sm text-[#686f7b]">
                    {generatingResultView === activeResultView
                      ? `${activeResultLabel}を生成しています。`
                      : activeResultView === "character"
                        ? "属性から生成した基本キャラクターがここに表示されます。"
                        : "ポーズから生成したアバターがここに表示されます。"}
                  </div>
                )}
              </div>
              <svg
                viewBox="0 0 600 600"
                aria-hidden="true"
                focusable="false"
                className="pointer-events-none absolute inset-0 z-20 h-full w-full"
              >
                <path
                  d="M 136.6 524.91 A 278 278 0 1 1 463.4 524.91"
                  fill="none"
                  stroke="#ffd84d"
                  strokeWidth="42"
                  strokeLinecap="round"
                  opacity="0.28"
                />
                <path
                  key={`${generationProgressRunId}-${activeResultView}`}
                  d="M 136.6 524.91 A 278 278 0 1 1 463.4 524.91"
                  pathLength="100"
                  fill="none"
                  stroke="#ffd84d"
                  strokeWidth="42"
                  strokeLinecap="round"
                  strokeDasharray="100"
                  strokeDashoffset={100 - visibleGenerationProgress}
                  style={{
                    transition: "stroke-dashoffset 600ms linear",
                  }}
                />
              </svg>
            </div>

            <div className="flex w-full max-w-[512px] flex-col items-center gap-2">
              <div
                className="grid grid-cols-2 gap-1 rounded-lg border border-[#0891b2]/30 bg-white p-1"
                role="tablist"
                aria-label="生成画像の表示"
              >
                {(["character", "avatar"] as const).map((view) => {
                  const label =
                    view === "character" ? "キャラクター" : "アバター";
                  const isActive = activeResultView === view;

                  return (
                    <button
                      key={view}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      aria-controls="generated-image-panel"
                      onClick={() => setActiveResultView(view)}
                      className={`rounded-md px-4 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                        isActive
                          ? "bg-[#22d3ee] text-[#083344] shadow-sm"
                          : "text-[#083344] hover:bg-[#e6faff]"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {IS_DEVELOPMENT &&
              !isProductionUiPreview &&
              activeResult?.image &&
              activeResult.provider ? (
                <span className="rounded-full border border-black/10 bg-[#fff7d6] px-2.5 py-1 text-[11px] font-bold text-[#62420e]">
                  {activeResult.provider === "openai"
                    ? "GPT Image 2"
                    : "Nano Banana 2"}
                </span>
              ) : null}

              {IS_DEVELOPMENT &&
              !isProductionUiPreview &&
              activeResultView === "avatar" &&
              avatarFrames.length === AVATAR_FRAME_LABELS.length ? (
                <div className="w-full rounded-xl border border-[#0891b2]/30 bg-white p-3 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-sm font-bold text-[#083344]">
                      4フレーム確認
                    </p>
                    <span className="rounded-full border border-[#d8b146] bg-[#fff7d6] px-2 py-0.5 text-[10px] font-bold text-[#74500d]">
                      開発環境のみ
                    </span>
                  </div>

                  <div
                    role="group"
                    aria-label="アバターの再生状態"
                    className="grid grid-cols-2 gap-1 rounded-lg border border-[#0891b2]/20 bg-[#e6faff] p-1"
                  >
                    <button
                      type="button"
                      aria-pressed={isAvatarPreviewPlaying}
                      onClick={() => {
                        setIsAvatarMouthOpen(false);
                        setAreAvatarEyesClosed(false);
                        setIsAvatarPreviewPlaying(true);
                      }}
                      className={`rounded-md px-3 py-2 text-xs font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                        isAvatarPreviewPlaying
                          ? "bg-[#22d3ee] text-[#083344] shadow-sm"
                          : "bg-white text-[#35515f] hover:bg-[#f5fdff]"
                      }`}
                    >
                      自動再生
                    </button>
                    <button
                      type="button"
                      aria-pressed={!isAvatarPreviewPlaying}
                      onClick={() => {
                        if (isAvatarPreviewPlaying) {
                          setSelectedAvatarFrameIndex(
                            animatedAvatarFrameIndex,
                          );
                        }
                        setIsAvatarPreviewPlaying(false);
                      }}
                      className={`rounded-md px-3 py-2 text-xs font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d8b146] ${
                        !isAvatarPreviewPlaying
                          ? "bg-[#ffd84d] text-[#513a00] shadow-sm"
                          : "bg-white text-[#5f5848] hover:bg-[#fffdf2]"
                      }`}
                    >
                      停止
                    </button>
                  </div>

                  <div
                    role="group"
                    aria-label="確認するアバターフレーム"
                    className="mt-2 grid grid-cols-2 gap-2"
                  >
                    {AVATAR_FRAME_LABELS.map((label, index) => {
                      const isSelected =
                        !isAvatarPreviewPlaying &&
                        selectedAvatarFrameIndex === index;

                      return (
                        <button
                          key={label}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => {
                            setSelectedAvatarFrameIndex(index);
                            setIsAvatarPreviewPlaying(false);
                          }}
                          className={`rounded-lg border px-2 py-2 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                            isSelected
                              ? "border-[#0891b2] bg-[#22d3ee] text-[#083344] shadow-sm"
                              : "border-black/10 bg-white text-[#403b35] hover:border-[#0891b2]/50 hover:bg-[#e6faff]"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </main>
      {IS_DEVELOPMENT && isProductionUiPreview ? (
        <button
          type="button"
          onClick={() => setIsProductionUiPreview(false)}
          className="fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-full border border-[#0891b2] bg-white px-3 py-2 text-xs font-bold text-[#083344] shadow-lg transition hover:bg-[#e6faff] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] sm:right-6 sm:bottom-6"
        >
          <span className="rounded-full bg-[#22d3ee] px-2 py-1">
            本番UIプレビュー中
          </span>
          <span>開発UIに戻る</span>
        </button>
      ) : null}
    </div>
  );
}
