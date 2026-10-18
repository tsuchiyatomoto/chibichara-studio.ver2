import type { Metadata } from "next";
import AvatarStudio from "./avatar-studio";

export const metadata: Metadata = {
  title: "Avatar | Chibichara Studio",
};

export default function AvatarPage() {
  return <AvatarStudio />;
}
