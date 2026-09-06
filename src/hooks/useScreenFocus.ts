import { useEffect, useRef } from "react";

/**
 * Moves focus to the screen once, on mount, when a navigation put it there.
 *
 * Each screen owns this rather than App holding one ref: Settings is a lazy
 * chunk, so a route-change effect in App runs before the screen exists and
 * finds a null ref. `active` is false on first paint, because taking focus
 * from someone who has not asked to go anywhere is its own small rudeness.
 */
export function useScreenFocus(active: boolean) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (active) {
      ref.current?.focus();
    }
    // Deliberately mount-only: re-focusing on every render would fight the
    // user for the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ref;
}
