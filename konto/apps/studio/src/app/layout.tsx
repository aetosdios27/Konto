import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Konto Studio",
  description: "Brutalist ledger interface",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-mono">
        <header className="border-b border-border">
          <div className="container flex h-14 items-center gap-6 px-4 max-w-6xl mx-auto">
            <a href="/" className="font-bold text-primary tracking-tight">KONTO_STUDIO</a>
            <nav className="flex gap-4 text-sm font-medium text-muted-foreground">
              <a href="/" className="hover:text-foreground transition-colors">Accounts</a>
              <a href="/intents" className="hover:text-foreground transition-colors">Intents</a>
              <a href="/holds" className="hover:text-foreground transition-colors">Holds</a>
            </nav>
          </div>
        </header>
        <main className="flex-1 container max-w-6xl mx-auto p-4 md:p-8">
          {children}
        </main>
        <Toaster theme="dark" position="bottom-right" />
      </body>
    </html>
  );
}
