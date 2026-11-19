import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vicecut — GTA Clip Studio",
  description: "Cut GTA livestreams into focused, fast-paced vertical clips.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
