// Map any position (including negative) into [0, period).
export function wrap(pos: number, period: number): number {
  if (period <= 0) return 0;
  return ((pos % period) + period) % period;
}
