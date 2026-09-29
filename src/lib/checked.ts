import { useCallback, useState } from 'react';

/** Rows the pit crew has ticked off, remembered per log on this computer. */
export function useChecked(logKey: string) {
  const storageKey = `pitview.checked.${logKey}`;
  const [checked, setChecked] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback(
    (id: string) =>
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* storage full or blocked: ticks just won't persist */
        }
        return next;
      }),
    [storageKey],
  );
  return [checked, toggle] as const;
}
