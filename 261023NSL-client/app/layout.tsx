import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "담다 · DAMDA Table Order",
  description:
    "내 언어로 편하게 주문하는 담다 테이블 오더. 한국어, English, 日本語, 中文.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
