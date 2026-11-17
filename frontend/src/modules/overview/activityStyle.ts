import type { MetricTone } from '@/components/ui/primitives';

/**
 * The icon and colour an audit action is drawn with — read from the words of
 * the action itself, so "verified" is always a green shield and "deleted" a
 * red cross, on every screen that lists activity.
 */
export function activityStyle(action: string): { icon: string; tone: MetricTone } {
  const a = action.toLowerCase();
  if (/verif/.test(a)) return { icon: 'ShieldCheck', tone: 'green' };
  if (/approv|accept|resolv|clos/.test(a)) return { icon: 'CheckCircle2', tone: 'green' };
  if (/delet|remov|clear|reject|fail/.test(a)) return { icon: 'XCircle', tone: 'red' };
  if (/gap|finding|risk/.test(a)) return { icon: 'AlertTriangle', tone: 'orange' };
  if (/owner|assign/.test(a)) return { icon: 'UserCheck', tone: 'brand' };
  if (/import|upload|upsert|sync/.test(a)) return { icon: 'UploadCloud', tone: 'purple' };
  if (/creat|add/.test(a)) return { icon: 'Plus', tone: 'purple' };
  if (/map|link|relat/.test(a)) return { icon: 'Link2', tone: 'teal' };
  if (/profile|company/.test(a)) return { icon: 'Building2', tone: 'brand' };
  if (/updat|edit|chang|sav|renam|mov/.test(a)) return { icon: 'Pencil', tone: 'teal' };
  return { icon: 'Activity', tone: 'gray' };
}
