/**
 * Uniform-grid broad phase.
 *
 * Rooms hold up to a few hundred props and dozens of enemies, and the ball is
 * tested against them several times per simulation step (up to 8 substeps at
 * 240 Hz). A flat scan would work at the low end but degrades exactly when the
 * game is at its most exciting - a crowded room mid chain reaction - so the
 * broad phase is grid-based and allocation-free after warm-up.
 */

export interface GridItem {
  id: number;
}

export class SpatialGrid<T extends GridItem> {
  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: T[][];
  /** Scratch set of ids already returned by the current query. */
  private readonly seen = new Set<number>();
  private readonly result: T[] = [];

  constructor(width: number, height: number, cellSize = 96) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(width / cellSize) + 2);
    this.rows = Math.max(1, Math.ceil(height / cellSize) + 2);
    this.cells = new Array(this.cols * this.rows);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
  }

  clear(): void {
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i].length) this.cells[i].length = 0;
    }
  }

  /** Inserts an item covering the given bounding box. */
  insert(item: T, minX: number, minY: number, maxX: number, maxY: number): void {
    const c0 = this.colIndex(minX);
    const c1 = this.colIndex(maxX);
    const r0 = this.rowIndex(minY);
    const r1 = this.rowIndex(maxY);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        this.cells[r * this.cols + c].push(item);
      }
    }
  }

  /**
   * Returns items whose cells intersect the query box. The returned array is
   * reused between calls, so consume it before querying again.
   */
  query(minX: number, minY: number, maxX: number, maxY: number): T[] {
    this.seen.clear();
    this.result.length = 0;
    const c0 = this.colIndex(minX);
    const c1 = this.colIndex(maxX);
    const r0 = this.rowIndex(minY);
    const r1 = this.rowIndex(maxY);
    for (let r = r0; r <= r1; r++) {
      const rowBase = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        const bucket = this.cells[rowBase + c];
        for (let i = 0; i < bucket.length; i++) {
          const item = bucket[i];
          if (this.seen.has(item.id)) continue;
          this.seen.add(item.id);
          this.result.push(item);
        }
      }
    }
    return this.result;
  }

  queryCircle(x: number, y: number, radius: number): T[] {
    return this.query(x - radius, y - radius, x + radius, y + radius);
  }

  private colIndex(x: number): number {
    const i = Math.floor(x / this.cellSize) + 1;
    return i < 0 ? 0 : i >= this.cols ? this.cols - 1 : i;
  }

  private rowIndex(y: number): number {
    const i = Math.floor(y / this.cellSize) + 1;
    return i < 0 ? 0 : i >= this.rows ? this.rows - 1 : i;
  }
}
