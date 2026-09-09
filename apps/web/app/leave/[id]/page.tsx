import { LeaveDetailView } from './DetailClient';

export const dynamic = 'force-static';

/**
 * Static export cannot prerender arbitrary request IDs (same pattern as
 * /employees/[id] and /attendance/records/[id]): prerender a placeholder
 * shell once; the client component fetches whatever ID is in the URL.
 */
export function generateStaticParams(): Array<{ id: string }> {
  return [{ id: '__placeholder__' }];
}

export default async function LeaveDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return <LeaveDetailView id={(await params).id} />;
}
