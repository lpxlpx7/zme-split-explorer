/**
 * Owner colours. Cool hues first (blue → teal → indigo → green → cyan → purple …) so the
 * common 1–6 position splits stay in one calm family; warm hues only when those run out.
 * Values are Apple system colours, which read on both the light and dark basemap.
 */
export const PALETTE = [
  '#0A84FF', // blue
  '#30B0C7', // teal
  '#5E5CE6', // indigo
  '#34C759', // green
  '#64D2FF', // cyan
  '#AF52DE', // purple
  '#00C7BE', // mint
  '#7D7AFF', // periwinkle
  '#FF9F0A', // orange
  '#FF6482', // pink
  '#FFD60A', // yellow
  '#AC8E68', // brown
];

/**
 * Stable colours: an owner keeps its colour while it stays online; owners that go offline
 * release theirs and newcomers take the first free one (so the first few are always cool).
 */
export class ColorBook {
  private readonly colors = new Map<string, string>();

  update(ids: Iterable<string>) {
    const keep = new Set(ids);
    for (const id of [...this.colors.keys()]) if (!keep.has(id)) this.colors.delete(id);
    for (const id of keep) {
      if (this.colors.has(id)) continue;
      const used = new Set(this.colors.values());
      this.colors.set(id, PALETTE.find((c) => !used.has(c)) ?? PALETTE[this.colors.size % PALETTE.length]);
    }
  }

  get(id: string | null | undefined): string | null {
    return id ? (this.colors.get(id) ?? null) : null;
  }
}
