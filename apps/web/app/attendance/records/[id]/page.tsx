import { RecordDetailView } from './DetailClient';

export const dynamic = 'force-static';

/**
 * Static export cannot prerender arbitrary record IDs (same pattern as
 * /employees/[id]): prerender a placeholder shell once; the client
 * component fetches whatever ID is in the URL at runtime.
 */
export function generateStaticParams(): Array<{ id: string }> {
  return [{ id: '__placeholder__' }];
}

export default async function AttendanceRecordPage({ params }: { params: Promise<{ id: string }> }) {
  return <RecordDetailView id={(await params).id} />;
}
