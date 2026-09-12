import Link from '@/components/AppLink';

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-5xl font-bold text-text-subtle">404</p>
      <h1 className="text-lg font-semibold text-text">Page not found</h1>
      <p className="text-sm text-text-muted">The page you&apos;re looking for doesn&apos;t exist.</p>
      <Link
        href="/dashboard"
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-fg hover:bg-primary-hover"
      >
        Go to dashboard
      </Link>
    </div>
  );
}
