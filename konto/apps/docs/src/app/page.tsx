import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold tracking-tighter text-primary">Konto Docs</h1>
      <p className="mt-4 text-muted-foreground mb-8">The brutalist ledger engine.</p>
      
      <Link href="/docs" className="border border-border hover:bg-muted text-foreground px-6 py-3 font-bold transition-colors">
        Read the Manual
      </Link>
    </main>
  );
}
