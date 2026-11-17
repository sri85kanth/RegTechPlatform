import { Topbar } from '@/layouts/Topbar';
import { Section } from '@/components/ui/primitives';
import { useData } from '@/app/store/data';
import { tx, useT } from '@/i18n';

export function ActivityPage() {
  const t = useT();
  const { history } = useData();
  return (
    <>
      <Topbar title="Activity" subtitle="Complete historical record of Company Brain changes" icon="Activity" />
      <div className="p-6">
        <Section title="Change History">
          <ol className="space-y-3">
            {history.map((h) => (
              <li key={h.id} className="flex gap-3 border-b border-line pb-3 last:border-0 last:pb-0 text-[13px]">
                <div className="mt-1 h-2 w-2 rounded-full bg-brand-500" />
                <div className="flex-1">
                  <div className="font-semibold">{h.action}</div>
                  <div className="text-2xs text-muted">{t('by {name}', { name: h.by })}{h.detail ? ` · ${h.detail}` : ''}</div>
                </div>
                <div className="text-2xs text-muted-2">{h.at}</div>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </>
  );
}

export function SettingsPage() {
  const t = useT();
  const items = [
    [tx('Company Profile'), tx('Legal name, registration, jurisdictions')],
    [tx('Users & Roles'), tx('Manage users, roles and permissions')],
    [tx('Verification Rules'), tx('Configure automated verification')],
    [tx('Connectors'), tx('Manage data source connectors')],
    [tx('Notifications'), tx('Alerts, reminders and digests')],
  ];
  return (
    <>
      <Topbar title="Settings" subtitle="Configure the Company Brain, users, roles and verification" icon="Settings" />
      <div className="grid grid-cols-1 gap-3 p-6 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([title, d]) => (
          <div key={title} className="card cursor-default px-4 py-4">
            <div className="text-[15px] font-bold">{t(title)}</div>
            <div className="mt-1 text-2xs text-muted">{t(d)}</div>
            <div className="mt-2 text-2xs font-semibold text-muted-2">{t('Configuration — next phase')}</div>
          </div>
        ))}
      </div>
    </>
  );
}
