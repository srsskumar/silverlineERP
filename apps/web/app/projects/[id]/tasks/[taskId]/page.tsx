import { TaskDetailView } from './DetailClient';

export const dynamic = 'force-static';

/**
 * Static export cannot prerender arbitrary project/task IDs (same pattern as
 * /employees/[id] and /leave/[id]): prerender a placeholder shell once; the
 * client component fetches whatever IDs are in the URL.
 */
export function generateStaticParams(): Array<{ id: string; taskId: string }> {
  return [{ id: '__placeholder__', taskId: '__placeholder__' }];
}

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string; taskId: string }> }) {
  return <TaskDetailView projectId={(await params).id} taskId={(await params).taskId} />;
}
