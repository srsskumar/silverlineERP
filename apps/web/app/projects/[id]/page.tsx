import { ProjectDetailView } from './DetailClient';

export const dynamic = 'force-static';

/**
 * Static export cannot prerender arbitrary project IDs (same pattern as
 * /employees/[id] and /leave/[id]): prerender a placeholder shell once; the
 * client component fetches whatever ID is in the URL.
 */
export function generateStaticParams(): Array<{ id: string }> {
  return [{ id: '__placeholder__' }];
}

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return <ProjectDetailView id={(await params).id} />;
}
