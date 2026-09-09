import { EmployeeDetailView } from './DetailClient';

export const dynamic = 'force-static';

/**
 * Static export cannot prerender arbitrary employee IDs, and Next requires a
 * non-empty param list for `output: 'export'` (an empty array is treated as
 * missing). The placeholder prerenders the shell once; at runtime the client
 * component fetches whatever ID is in the URL, so in-app navigation to any
 * /employees/:id works. Hard refresh on a pure static host needs an SPA
 * fallback rewrite for this path.
 */
export function generateStaticParams(): Array<{ id: string }> {
  return [{ id: '__placeholder__' }];
}

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return <EmployeeDetailView id={(await params).id} />;
}
