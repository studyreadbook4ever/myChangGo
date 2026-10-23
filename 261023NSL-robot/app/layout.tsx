import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "담다 · 로봇 안내",
  description: "받은 요청을 고객의 언어로 안내하는 담다 로봇 발표 화면",
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
