export type ScrollAnchor = { key: string; top: number };

export function chooseScrollAnchor(
  visible: readonly { key: string; top: number; bottom: number }[],
): ScrollAnchor | null {
  const first = visible.find((item) =>
    item.key.length > 0
    && Number.isFinite(item.top)
    && Number.isFinite(item.bottom)
    && item.bottom > 0
  );
  return first ? { key: first.key, top: first.top } : null;
}

export function anchoredScrollTop(input: {
  previousScrollTop: number;
  beforeTop: number;
  afterTop: number;
}): number {
  if (
    input.previousScrollTop <= 0
    || !Number.isFinite(input.previousScrollTop)
    || !Number.isFinite(input.beforeTop)
    || !Number.isFinite(input.afterTop)
  ) {
    return 0;
  }
  return Math.max(
    0,
    input.previousScrollTop + input.afterTop - input.beforeTop
  );
}
