import Link from '@/components/AppLink';

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-5xl font-bold text-slate-300">404</p>
      <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
      <p className="text-sm text-slate-500">The page you&apos;re looking for doesn&apos;t exist.</p>
      <Link
        href="/dashboard"
        className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
      >
        Go to dashboard
      </Link>
    </div>
  );
}
