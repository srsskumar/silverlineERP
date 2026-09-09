import { RunDetailView } from './DetailClient';

export const dynamic = 'force-static';

/**
 * Static export cannot prerender arbitrary run IDs (same pattern as
 * /leave/[id] and /employees/[id]): prerender a placeholder shell once;
 * the client component fetches whatever ID is in the URL.
 */
export function generateStaticParams(): Array<{ id: string }> {
  return [{ id: '__placeholder__' }];
}

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  return <RunDetailView id={(await params).id} />;
}
