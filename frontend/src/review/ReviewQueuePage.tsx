import { Topbar } from '@/layouts/Topbar';
import { MetricCard, EmptyState } from '@/components/ui/primitives';
import { DOMAINS } from '@/config/domains';
import type { DomainId } from '@/types/entity';
import { Icon } from '@/config/icons';
import { useData } from '@/app/store/data';

export function ReviewQueuePage() {
  const { reviewItems, approveReview, rejectReview } = useData();
  const avg = reviewItems.length ? Math.round(reviewItems.reduce((a, r) => a + r.confidence, 0) / reviewItems.length) : 0;

  return (
    <>
      <Topbar title="Review Queue" subtitle="AI proposes · humans approve — nothing enters the graph unreviewed" icon="Inbox" />
      <div className="space-y-4 p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricCard label="Pending Review" value={reviewItems.length} tone="amber" />
          <MetricCard label="Avg Confidence" value={`${avg}%`} tone="green" />
          <MetricCard label="Entities" value={reviewItems.filter((r) => r.kind === 'entity').length} />
          <MetricCard label="Relationships" value={reviewItems.filter((r) => r.kind === 'relationship').length} />
        </div>

        <div className="card divide-y divide-line">
          {reviewItems.length === 0 && <EmptyState title="Queue is clear." hint="All AI-proposed items have been reviewed." />}
          {reviewItems.map((r) => (
            <div key={r.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                <Icon name={DOMAINS[r.domain as Exclude<DomainId, 'overview'>]?.icon ?? 'LayoutGrid'} className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-[14px]">{r.title}</b>
                  <span className="pill bg-slate-100 text-slate-600">{r.kind}</span>
                </div>
                <div className="mt-0.5 text-2xs text-muted">{r.proposed}</div>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-2xs text-muted">
                  <span>Source: {r.source}</span>
                  <span>
                    Confidence:{' '}
                    <b className={r.confidence >= 85 ? 'text-emerald-600' : 'text-amber-600'}>{r.confidence}%</b>
                  </span>
                  <span>{r.detail}</span>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button className="btn btn-sm btn-primary" onClick={() => approveReview(r.id)}>
                  Approve
                </button>
                <button className="btn btn-sm" onClick={() => approveReview(r.id)}>
                  Edit
                </button>
                <button className="btn btn-sm text-red-600" onClick={() => rejectReview(r.id)}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
