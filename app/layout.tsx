import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ShowTiva", template: "%s — ShowTiva" },
  description: "Trusted, curated films and shows the whole family can watch together. Every title vetted before it is published.",
  // In development: keep every page out of search results. next.config.ts
  // sends the same rule as a header, which also covers images and video.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  auth,
  children,
}: Readonly<{
  auth: React.ReactNode;
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        {auth}
      </body>
    </html>
  );
}
