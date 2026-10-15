import type { Metadata } from "next";
import Image from "next/image";
import MovieStudio from "./movie-studio";

export const metadata: Metadata = {
  title: "Movie | Chibichara Studio",
};

export default function MoviePage() {
  return (
    <div className="min-h-screen bg-[#f6f7fb] text-[#171717]">
      <header className="border-b border-black/10 bg-white" aria-label="chibichara studio">
        <div className="mx-auto flex h-24 w-full max-w-7xl items-center gap-4 px-5 sm:px-8 lg:px-10">
          <Image
            src="/favicon.png"
            alt=""
            width={72}
            height={72}
            preload
            className="h-[72px] w-[72px] shrink-0 rounded-md object-contain"
          />
          <p className="hidden text-4xl font-semibold tracking-tight sm:block">
            chibichara studio
          </p>
        </div>
      </header>
      <MovieStudio />
    </div>
  );
}
