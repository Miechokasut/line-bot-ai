import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Arayatime LINE Bot",
  description: "LINE Gemini FAQ bot for Arayatime / อารยธาม",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
