import type { Metadata } from "next";
import VoiceStudio from "./voice-studio";

export const metadata: Metadata = {
  title: "Voice | Chibichara Studio",
};

export default function VoicePage() {
  return <VoiceStudio />;
}
