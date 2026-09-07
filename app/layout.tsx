import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clipping",
  description: "Turn a YouTube video or Twitch VOD into AI-picked short clips.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
