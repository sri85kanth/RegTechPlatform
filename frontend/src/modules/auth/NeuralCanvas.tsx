/**
 * A living knowledge graph, drawn on a canvas: nodes drift, nearby nodes are
 * linked, and signals travel along the links — the product's own picture of a
 * company brain at work. Decorative only (aria-hidden), and quiet about it:
 *
 *   - pauses while the tab is hidden, and draws one still frame for people who
 *     ask their system for reduced motion;
 *   - `converge` gathers the nodes into a slowly turning halo around the centre
 *     (the splash after sign-in: the brain "assembling" its workspace).
 */
import { useEffect, useRef } from 'react';
import { cn } from '@/utils/ui';

type Tone = 'dark' | 'light';
interface Node { x: number; y: number; vx: number; vy: number; r: number; c: string; a: number; orbit: number; spin: number }
interface Pulse { a: number; b: number; t: number; speed: number }

const PALETTE: Record<Tone, { nodes: string[]; link: string; pulse: string; linkAlpha: number; nodeAlpha: number }> = {
  dark: { nodes: ['#a5b4fc', '#67e8f9', '#c4b5fd', '#93c5fd'], link: '129,140,248', pulse: '#67e8f9', linkAlpha: 0.38, nodeAlpha: 0.95 },
  light: { nodes: ['#6366f1', '#0ea5e9', '#8b5cf6', '#3b82f6'], link: '99,102,241', pulse: '#0ea5e9', linkAlpha: 0.16, nodeAlpha: 0.45 },
};

export function NeuralCanvas({ tone = 'dark', density = 1, converge = false, className }: {
  tone?: Tone; density?: number; converge?: boolean; className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const pal = PALETTE[tone];
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = 0, h = 0;
    let nodes: Node[] = [];
    const pulses: Pulse[] = [];
    const LINK = 150;

    const seed = () => {
      const n = Math.round(Math.min(95, Math.max(28, (w * h) / 13000)) * density);
      nodes = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
        r: 0.9 + Math.random() * 1.9, c: pal.nodes[Math.floor(Math.random() * pal.nodes.length)],
        a: Math.random() * Math.PI * 2, orbit: 0.55 + Math.random() * 0.9, spin: (0.00006 + Math.random() * 0.00012) * (Math.random() < 0.5 ? -1 : 1),
      }));
    };
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const first = !w;
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (first) seed();
    };
    resize();

    let raf = 0;
    let last = performance.now();
    const start = last;
    const frame = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const halo = Math.min(w, h) * 0.2;
      const pull = converge ? Math.min(1, (now - start) / 1600) : 0;

      for (const n of nodes) {
        n.x += n.vx * dt * 0.06;
        n.y += n.vy * dt * 0.06;
        if (converge) {
          n.a += n.spin * dt;
          const tx = cx + Math.cos(n.a) * halo * n.orbit * 1.6;
          const ty = cy + Math.sin(n.a) * halo * n.orbit;
          const k = 0.0035 * dt * pull;
          n.x += (tx - n.x) * k;
          n.y += (ty - n.y) * k;
        } else {
          if (n.x < -20) n.x = w + 20; else if (n.x > w + 20) n.x = -20;
          if (n.y < -20) n.y = h + 20; else if (n.y > h + 20) n.y = -20;
        }
      }

      // links between near nodes, fainter with distance
      ctx.lineWidth = 0.8;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK * LINK) continue;
          const alpha = (1 - Math.sqrt(d2) / LINK) * pal.linkAlpha;
          ctx.strokeStyle = `rgba(${pal.link},${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // now and then a signal sets off along a link
      if (!still && Math.random() < 0.06 * (dt / 16) && nodes.length > 1) {
        const ai = Math.floor(Math.random() * nodes.length);
        let best = -1, bestD = LINK * LINK;
        for (let j = 0; j < nodes.length; j++) {
          if (j === ai) continue;
          const dx = nodes[ai].x - nodes[j].x, dy = nodes[ai].y - nodes[j].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD && Math.random() < 0.6) { bestD = d2; best = j; }
        }
        if (best >= 0) pulses.push({ a: ai, b: best, t: 0, speed: 0.0012 + Math.random() * 0.0016 });
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        p.t += p.speed * dt;
        if (p.t >= 1) { pulses.splice(i, 1); continue; }
        const a = nodes[p.a], b = nodes[p.b];
        const x = a.x + (b.x - a.x) * p.t, y = a.y + (b.y - a.y) * p.t;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 7);
        g.addColorStop(0, pal.pulse);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
      }

      // the nodes, with a soft halo
      for (const n of nodes) {
        ctx.globalAlpha = pal.nodeAlpha * 0.25;
        ctx.fillStyle = n.c;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = pal.nodeAlpha;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (!still) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !still) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      ro?.disconnect();
    };
  }, [tone, density, converge]);

  return <canvas ref={ref} aria-hidden="true" className={cn('pointer-events-none absolute inset-0 h-full w-full', className)} />;
}
