import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crypto Desk — live market chatbot",
  description:
    "Ask about crypto markets and get answers grounded in live CoinGecko prices and current headlines, or generate a newsletter digest on demand.",
};

export const viewport: Viewport = {
  themeColor: "#0a0b0f",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
