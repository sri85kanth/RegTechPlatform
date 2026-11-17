import { useEffect } from 'react';
import { useUpdateNodeInternals } from 'reactflow';

/**
 * React Flow measures nodes with a ResizeObserver and draws no edge until it
 * has; where that observer never fires (some embedded browsers), every edge
 * is silently skipped. This measures each node explicitly, a few times as
 * the layout settles. Render it inside <ReactFlow>.
 */
export function NodeMeasurer({ ids }: { ids: string[] }) {
  const update = useUpdateNodeInternals();
  const key = ids.join('|');
  useEffect(() => {
    const run = () => ids.forEach((id) => update(id));
    run();
    const timers = [30, 120, 300, 600].map((ms) => setTimeout(run, ms));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, update]);
  return null;
}
