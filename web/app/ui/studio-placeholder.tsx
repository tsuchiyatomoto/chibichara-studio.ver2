import Image from "next/image";

type StudioSection = "voice" | "movie";

const SECTION_DETAILS: Record<
  StudioSection,
  {
    eyebrow: string;
    title: string;
    description: string;
    panelTitle: string;
    panelDescription: string;
  }
> = {
  voice: {
    eyebrow: "VOICE STUDIO",
    title: "ボイス",
    description: "キャラクターに合う声を作るためのスペースです。",
    panelTitle: "ボイス機能をここに追加できます",
    panelDescription:
      "台詞の入力、声質の選択、音声プレビューなどを配置する予定の画面です。",
  },
  movie: {
    eyebrow: "MOVIE STUDIO",
    title: "ムービー",
    description: "アバターとボイスを組み合わせて映像を作るスペースです。",
    panelTitle: "ムービー機能をここに追加できます",
    panelDescription:
      "アバター、音声、背景を組み合わせる編集機能を配置する予定の画面です。",
  },
};

function SectionIcon({ section }: { section: StudioSection }) {
  if (section === "voice") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-14 w-14"
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

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-14 w-14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="m3 10 4-4m2 4 4-4m2 4 4-4" />
      <path d="m10 13 5 2.5-5 2.5v-5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function StudioPlaceholder({
  section,
}: {
  section: StudioSection;
}) {
  const details = SECTION_DETAILS[section];

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
          <p className="text-4xl font-semibold tracking-tight">
            chibichara studio
          </p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-5 py-8 sm:px-8 lg:px-10">
        <section className="overflow-hidden rounded-2xl border border-black/10 bg-white shadow-sm">
          <div className="border-b-4 border-[#22d3ee] bg-[#fffdf5] px-6 py-7 sm:px-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="mb-1 text-xs font-black tracking-[0.2em] text-[#9b6b16]">
                  {details.eyebrow}
                </p>
                <h1 className="text-3xl font-black tracking-tight">
                  {details.title}
                </h1>
                <p className="mt-2 text-sm font-medium text-[#5f5848]">
                  {details.description}
                </p>
              </div>
              <span className="rounded-full bg-[#ef4444] px-4 py-2 text-xs font-black text-white shadow-[0_4px_0_#b91c1c]">
                準備中
              </span>
            </div>
          </div>

          <div className="p-6 sm:p-8">
            <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[#0891b2]/40 bg-[#e6faff]/60 px-6 text-center text-[#083344]">
              <div className="mb-5 flex h-24 w-24 items-center justify-center rounded-full border-4 border-[#22d3ee] bg-white shadow-[0_6px_0_#ffd84d]">
                <SectionIcon section={section} />
              </div>
              <h2 className="text-xl font-black">{details.panelTitle}</h2>
              <p className="mt-2 max-w-xl text-sm leading-7 text-[#47616e]">
                {details.panelDescription}
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
