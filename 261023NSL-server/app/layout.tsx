import type { Metadata } from "next";
import "./globals.css";
import "./operations.css";

export const metadata: Metadata = {
  title: "담다 | 매장 운영",
  description:
    "주문과 테이블, 조리 진행과 손님의 부탁을 한곳에서 챙기는 비공개 매장 운영 화면입니다.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
