import type { Metadata } from "next";
import MovieStudio from "./movie-studio";

export const metadata: Metadata = {
  title: "Movie | Chibichara Studio",
};

export default function MoviePage() {
  return <MovieStudio />;
}
