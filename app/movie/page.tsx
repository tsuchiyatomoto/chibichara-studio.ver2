import type { Metadata } from "next";
import StudioPlaceholder from "@/app/ui/studio-placeholder";

export const metadata: Metadata = {
  title: "Movie | Chibichara Studio",
};

export default function MoviePage() {
  return <StudioPlaceholder section="movie" />;
}
