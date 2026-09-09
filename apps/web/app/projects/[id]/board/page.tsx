import { BoardView } from './BoardClient';

export const dynamic = 'force-static';

/**
 * Static export cannot prerender arbitrary project IDs (same pattern as
 * /projects/[id]): prerender a placeholder shell once; the client component
 * fetches whatever ID is in the URL.
 */
export function generateStaticParams(): Array<{ id: string }> {
  return [{ id: '__placeholder__' }];
}

export default async function ProjectBoardPage({ params }: { params: Promise<{ id: string }> }) {
  return <BoardView projectId={(await params).id} />;
}
