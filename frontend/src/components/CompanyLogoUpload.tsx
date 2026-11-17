import { useRef, useState } from 'react';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useT, type TFunction } from '@/i18n';

const MAX_SVG_BYTES = 300_000;

/** A picked image as a small data URL: photos and PNGs shrunk to 256 px, SVGs kept as they are. */
async function toLogo(file: File, t: TFunction): Promise<string> {
  if (file.type === 'image/svg+xml') {
    if (file.size > MAX_SVG_BYTES) throw new Error(t('That SVG is larger than 300 KB.'));
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error(t('The file could not be read.')));
      r.readAsDataURL(file);
    });
  }
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error(t('Choose a PNG, JPG, WebP or SVG image.'));
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** Pick, preview and remove the company logo. Saving is the caller's: now, or once a new company exists. */
export function CompanyLogoUpload({ value, onChange, busy, name }: {
  value: string | null; onChange: (logo: string | null) => Promise<void> | void; busy?: boolean; name: string;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (file?: File) => {
    if (!file) return;
    setError(null);
    try { await onChange(await toLogo(file, t)); } catch (e) { setError((e as Error).message.replace(/^\d{3}:\s*/, '')); }
    if (input.current) input.current.value = '';
  };

  return (
    <div className="flex flex-wrap items-center gap-4">
      <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-slate-50">
        {value ? <img src={value} alt={name ? t('{name} logo', { name }) : t('Company logo')} className="h-full w-full object-contain p-2" />
               : <ImagePlus className="h-6 w-6 text-slate-400" aria-hidden="true" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
            {t(value ? 'Change logo' : 'Upload logo')}
          </button>
          {value && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
                    onClick={async () => { setError(null); try { await onChange(null); } catch (e) { setError((e as Error).message); } }}>
              <Trash2 className="h-3.5 w-3.5" /> {t('Remove')}
            </button>
          )}
        </div>
        <p className="mt-1 text-[11.5px] text-muted">{t('PNG, JPG, WebP or SVG. Shown on the Companies screen and in the company menu.')}</p>
        {error && <p className="mt-1 text-[12px] text-critical-600">{error}</p>}
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden"
             onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  );
}
