import { PaymentDetail } from '@/components/finance/PaymentDetail';

export const dynamic = 'force-static';

/** Static export cannot prerender arbitrary payment IDs (same pattern as /leave/[id]). */
export function generateStaticParams(): Array<{ id: string }> {
  return [{ id: '__placeholder__' }];
}

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return <PaymentDetail id={(await params).id} />;
}
