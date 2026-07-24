export const DRAG_ACTIVATION_THRESHOLD_PX = 10;
export const MANUAL_PAUSE_MS = 4_000;

export function marqueeTileKey(completeKey: string, occurrence: number): string {
  return `${completeKey}#${occurrence}`;
}

export function suppressActivationAfterDrag(distance: number): boolean {
  return distance > DRAG_ACTIVATION_THRESHOLD_PX;
}

export function shouldAnimateMarquee(input: {
  reducedMotion: boolean;
  viewportHeight: number;
  tallestColumnHeight: number;
}): boolean {
  return !input.reducedMotion
    && input.viewportHeight > 0
    && input.tallestColumnHeight > input.viewportHeight;
}
