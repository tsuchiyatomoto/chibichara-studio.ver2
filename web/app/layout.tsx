import type { Metadata } from "next";
import "./globals.css";
import StudioNavigation from "./ui/studio-navigation";

export const metadata: Metadata = {
  title: "Chibi Character Studio",
  description: "Create chibi avatars, voices, and movies.",
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full">
        <div className="min-h-screen bg-[#f6f7fb] pb-24 md:pb-0 md:pl-28">
          <StudioNavigation />
          <div className="min-w-0">{children}</div>
        </div>
      </body>
    </html>
  );
}
