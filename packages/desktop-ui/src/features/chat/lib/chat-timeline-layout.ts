/**
 * Incremental variable-height layout for the full desktop chat timeline.
 *
 * History is stored in small immutable-order blocks. A prepend allocates
 * blocks for the new prefix and links them in front of the existing blocks;
 * it never reindexes, copies, estimates, or rebuilds positions for rows that
 * were already loaded. Block totals make offset lookup proportional to the
 * number of loaded pages and a measurement only rebuilds one small block.
 */

export const CHAT_TIMELINE_LAYOUT_BLOCK_SIZE = 128;
export const CHAT_TIMELINE_MAX_STRUCTURAL_PROBE = 1_024;

type TimelineBlock = {
  keys: string[];
  sizes: number[];
  measured: boolean[];
  prefix: number[];
  total: number;
};

type TimelineLocation = {
  block: TimelineBlock;
  localIndex: number;
};

export type TimelineLayoutOperation =
  | "none"
  | "prepend"
  | "append"
  | "prepend-append"
  | "trim-start"
  | "trim-end"
  | "rebuild";

export type TimelineLayoutReconcile = {
  operation: TimelineLayoutOperation;
  prependCount: number;
  appendCount: number;
  prependedSize: number;
  estimateCalls: number;
  existingRowsVisited: number;
};

export type TimelineMeasurement = {
  changed: boolean;
  delta: number;
  index: number;
  rowsVisited: number;
};

export type TimelineVisibleRange = {
  start: number;
  end: number;
};

export type TimelineLayoutDebug = {
  itemCount: number;
  blockCount: number;
  measuredCount: number;
  maxBlockSize: number;
  retainedKeyCount: number;
  contentSize: number;
  lastOperation: TimelineLayoutOperation;
  lastEstimateCalls: number;
  lastExistingRowsVisited: number;
};

type ReconcileInput = {
  itemCount: number;
  keyAt: (index: number) => string;
  estimateAt: (index: number) => number;
};

const clampSize = (size: number): number =>
  Number.isFinite(size) ? Math.max(8, size) : 8;

const rebuildBlockPrefix = (block: TimelineBlock, startIndex = 0): number => {
  const start = Math.max(0, Math.min(startIndex, block.sizes.length));
  let run = start === 0 ? 0 : (block.prefix[start] ?? 0);
  let visited = 0;
  for (let index = start; index < block.sizes.length; index += 1) {
    block.prefix[index] = run;
    run += block.sizes[index]!;
    visited += 1;
  }
  block.prefix[block.sizes.length] = run;
  block.total = run;
  return visited;
};

const upperBound = (values: readonly number[], target: number): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
};

export class ChatTimelineLayout {
  private blocks: TimelineBlock[] = [];
  private locations = new Map<string, TimelineLocation>();
  private count = 0;
  private total = 0;
  private first: string | null = null;
  private last: string | null = null;
  private lastReconcile: TimelineLayoutReconcile = {
    operation: "none",
    prependCount: 0,
    appendCount: 0,
    prependedSize: 0,
    estimateCalls: 0,
    existingRowsVisited: 0,
  };

  get length(): number {
    return this.count;
  }

  get contentSize(): number {
    return this.total;
  }

  get firstKey(): string | null {
    return this.first;
  }

  get lastKey(): string | null {
    return this.last;
  }

  clear(): void {
    this.blocks = [];
    this.locations.clear();
    this.count = 0;
    this.total = 0;
    this.first = null;
    this.last = null;
    this.lastReconcile = {
      operation: "none",
      prependCount: 0,
      appendCount: 0,
      prependedSize: 0,
      estimateCalls: 0,
      existingRowsVisited: 0,
    };
  }

  private buildBlocks(
    start: number,
    end: number,
    input: ReconcileInput,
  ): { blocks: TimelineBlock[]; total: number; estimateCalls: number } {
    const blocks: TimelineBlock[] = [];
    let total = 0;
    let estimateCalls = 0;

    for (
      let blockStart = start;
      blockStart < end;
      blockStart += CHAT_TIMELINE_LAYOUT_BLOCK_SIZE
    ) {
      const blockEnd = Math.min(
        end,
        blockStart + CHAT_TIMELINE_LAYOUT_BLOCK_SIZE,
      );
      const keys: string[] = [];
      const sizes: number[] = [];
      const measured: boolean[] = [];
      const prefix: number[] = [0];
      let blockTotal = 0;
      for (let index = blockStart; index < blockEnd; index += 1) {
        const key = input.keyAt(index);
        if (this.locations.has(key)) {
          throw new Error(`Duplicate chat timeline key: ${key}`);
        }
        const size = clampSize(input.estimateAt(index));
        keys.push(key);
        sizes.push(size);
        measured.push(false);
        blockTotal += size;
        prefix.push(blockTotal);
        estimateCalls += 1;
      }
      const block: TimelineBlock = {
        keys,
        sizes,
        measured,
        prefix,
        total: blockTotal,
      };
      for (let localIndex = 0; localIndex < keys.length; localIndex += 1) {
        this.locations.set(keys[localIndex]!, { block, localIndex });
      }
      blocks.push(block);
      total += blockTotal;
    }

    return { blocks, total, estimateCalls };
  }

  private rebuild(input: ReconcileInput): TimelineLayoutReconcile {
    this.clear();
    const built = this.buildBlocks(0, input.itemCount, input);
    this.blocks = built.blocks;
    this.count = input.itemCount;
    this.total = built.total;
    this.first = input.itemCount > 0 ? input.keyAt(0) : null;
    this.last =
      input.itemCount > 0 ? input.keyAt(input.itemCount - 1) : null;
    return {
      operation: "rebuild",
      prependCount: 0,
      appendCount: input.itemCount,
      prependedSize: 0,
      estimateCalls: built.estimateCalls,
      existingRowsVisited: 0,
    };
  }

  private prepend(
    count: number,
    input: ReconcileInput,
  ): { size: number; estimateCalls: number } {
    if (count <= 0) return { size: 0, estimateCalls: 0 };
    const built = this.buildBlocks(0, count, input);
    this.blocks = [...built.blocks, ...this.blocks];
    this.count += count;
    this.total += built.total;
    return { size: built.total, estimateCalls: built.estimateCalls };
  }

  private append(
    start: number,
    input: ReconcileInput,
  ): { size: number; estimateCalls: number } {
    if (start >= input.itemCount) return { size: 0, estimateCalls: 0 };
    const built = this.buildBlocks(start, input.itemCount, input);
    this.blocks.push(...built.blocks);
    this.count += input.itemCount - start;
    this.total += built.total;
    return { size: built.total, estimateCalls: built.estimateCalls };
  }

  private dropStart(dropCount: number): number {
    let remaining = Math.max(0, Math.min(dropCount, this.count));
    let removedSize = 0;
    while (remaining > 0) {
      const block = this.blocks[0];
      if (!block) break;
      if (remaining >= block.keys.length) {
        for (const key of block.keys) this.locations.delete(key);
        remaining -= block.keys.length;
        this.count -= block.keys.length;
        removedSize += block.total;
        this.blocks.shift();
        continue;
      }
      for (let index = 0; index < remaining; index += 1) {
        this.locations.delete(block.keys[index]!);
        removedSize += block.sizes[index]!;
      }
      block.keys.splice(0, remaining);
      block.sizes.splice(0, remaining);
      block.measured.splice(0, remaining);
      block.prefix = new Array(block.sizes.length + 1).fill(0);
      this.count -= remaining;
      for (let index = 0; index < block.keys.length; index += 1) {
        this.locations.set(block.keys[index]!, { block, localIndex: index });
      }
      rebuildBlockPrefix(block);
      remaining = 0;
    }
    this.total -= removedSize;
    return removedSize;
  }

  private dropEnd(dropCount: number): number {
    let remaining = Math.max(0, Math.min(dropCount, this.count));
    let removedSize = 0;
    while (remaining > 0) {
      const block = this.blocks[this.blocks.length - 1];
      if (!block) break;
      if (remaining >= block.keys.length) {
        for (const key of block.keys) this.locations.delete(key);
        remaining -= block.keys.length;
        this.count -= block.keys.length;
        removedSize += block.total;
        this.blocks.pop();
        continue;
      }
      const keep = block.keys.length - remaining;
      for (let index = keep; index < block.keys.length; index += 1) {
        this.locations.delete(block.keys[index]!);
        removedSize += block.sizes[index]!;
      }
      block.keys.splice(keep);
      block.sizes.splice(keep);
      block.measured.splice(keep);
      block.prefix.length = block.sizes.length + 1;
      this.count -= remaining;
      rebuildBlockPrefix(block, 0);
      remaining = 0;
    }
    this.total -= removedSize;
    return removedSize;
  }

  reconcile(input: ReconcileInput): TimelineLayoutReconcile {
    const nextCount = Math.max(0, Math.floor(input.itemCount));
    if (nextCount === 0) {
      const operation = this.count === 0 ? "none" : "rebuild";
      this.clear();
      this.lastReconcile = {
        operation,
        prependCount: 0,
        appendCount: 0,
        prependedSize: 0,
        estimateCalls: 0,
        existingRowsVisited: 0,
      };
      return this.lastReconcile;
    }
    if (this.count === 0) {
      this.lastReconcile = this.rebuild({ ...input, itemCount: nextCount });
      return this.lastReconcile;
    }

    const nextFirst = input.keyAt(0);
    const nextLast = input.keyAt(nextCount - 1);
    if (
      nextCount === this.count &&
      nextFirst === this.first &&
      nextLast === this.last
    ) {
      this.lastReconcile = {
        operation: "none",
        prependCount: 0,
        appendCount: 0,
        prependedSize: 0,
        estimateCalls: 0,
        existingRowsVisited: 0,
      };
      return this.lastReconcile;
    }

    // Find the old first key only inside the bounded newly-added prefix. Once
    // found, two endpoint probes prove that the whole previous sequence still
    // occupies one contiguous run; stable unique keys are the list contract.
    let oldFirstInNext = -1;
    const probeLimit = Math.min(
      nextCount,
      Math.max(
        1,
        Math.min(CHAT_TIMELINE_MAX_STRUCTURAL_PROBE, nextCount - this.count + 1),
      ),
    );
    for (let index = 0; index < probeLimit; index += 1) {
      if (input.keyAt(index) === this.first) {
        oldFirstInNext = index;
        break;
      }
    }
    if (
      oldFirstInNext >= 0 &&
      oldFirstInNext + this.count <= nextCount &&
      input.keyAt(oldFirstInNext + this.count - 1) === this.last
    ) {
      const prependCount = oldFirstInNext;
      const appendStart = oldFirstInNext + this.count;
      const appendCount = nextCount - appendStart;
      const prepended = this.prepend(prependCount, input);
      const appended = this.append(appendStart, input);
      this.first = nextFirst;
      this.last = nextLast;
      this.lastReconcile = {
        operation:
          prependCount > 0 && appendCount > 0
            ? "prepend-append"
            : prependCount > 0
              ? "prepend"
              : "append",
        prependCount,
        appendCount,
        prependedSize: prepended.size,
        estimateCalls: prepended.estimateCalls + appended.estimateCalls,
        existingRowsVisited: 0,
      };
      return this.lastReconcile;
    }

    // At-rest history decay removes an old prefix. The key map locates the
    // new first row without walking the retained transcript.
    const nextFirstLocation = this.locations.get(nextFirst);
    if (nextFirstLocation && nextLast === this.last && nextCount < this.count) {
      const nextFirstIndex = this.indexOfLocation(nextFirstLocation);
      if (nextFirstIndex === this.count - nextCount) {
        this.dropStart(nextFirstIndex);
        this.first = nextFirst;
        this.last = nextLast;
        this.lastReconcile = {
          operation: "trim-start",
          prependCount: 0,
          appendCount: 0,
          prependedSize: 0,
          estimateCalls: 0,
          existingRowsVisited: 0,
        };
        return this.lastReconcile;
      }
    }

    const nextLastLocation = this.locations.get(nextLast);
    if (nextLastLocation && nextFirst === this.first && nextCount < this.count) {
      const nextLastIndex = this.indexOfLocation(nextLastLocation);
      if (nextLastIndex === nextCount - 1) {
        this.dropEnd(this.count - nextCount);
        this.first = nextFirst;
        this.last = nextLast;
        this.lastReconcile = {
          operation: "trim-end",
          prependCount: 0,
          appendCount: 0,
          prependedSize: 0,
          estimateCalls: 0,
          existingRowsVisited: 0,
        };
        return this.lastReconcile;
      }
    }

    this.lastReconcile = this.rebuild({ ...input, itemCount: nextCount });
    return this.lastReconcile;
  }

  private indexOfLocation(location: TimelineLocation): number {
    let index = 0;
    for (const block of this.blocks) {
      if (block === location.block) return index + location.localIndex;
      index += block.keys.length;
    }
    return -1;
  }

  keyAt(index: number): string | null {
    const located = this.locateIndex(index);
    return located ? located.block.keys[located.localIndex]! : null;
  }

  private locateIndex(index: number): TimelineLocation | null {
    if (index < 0 || index >= this.count) return null;
    let remaining = index;
    for (const block of this.blocks) {
      if (remaining < block.keys.length) {
        return { block, localIndex: remaining };
      }
      remaining -= block.keys.length;
    }
    return null;
  }

  offsetForIndex(index: number): number {
    if (index <= 0) return 0;
    if (index >= this.count) return this.total;
    let remaining = index;
    let offset = 0;
    for (const block of this.blocks) {
      if (remaining <= block.keys.length) {
        return offset + (block.prefix[remaining] ?? block.total);
      }
      remaining -= block.keys.length;
      offset += block.total;
    }
    return this.total;
  }

  offsetForKey(key: string): number | null {
    const location = this.locations.get(key);
    if (!location) return null;
    let offset = 0;
    for (const block of this.blocks) {
      if (block === location.block) {
        return offset + (block.prefix[location.localIndex] ?? 0);
      }
      offset += block.total;
    }
    return null;
  }

  isMeasuredKey(key: string): boolean {
    const location = this.locations.get(key);
    return location
      ? location.block.measured[location.localIndex] === true
      : false;
  }

  indexForKey(key: string): number | null {
    const location = this.locations.get(key);
    if (!location) return null;
    const index = this.indexOfLocation(location);
    return index >= 0 ? index : null;
  }

  indexAtOffset(offset: number): number {
    if (this.count === 0) return 0;
    const target = Math.max(0, Math.min(offset, Math.max(0, this.total - 0.001)));
    let blockStartIndex = 0;
    let blockStartOffset = 0;
    for (const block of this.blocks) {
      if (target < blockStartOffset + block.total) {
        const localOffset = target - blockStartOffset;
        const localIndex = Math.max(
          0,
          Math.min(
            block.keys.length - 1,
            upperBound(block.prefix, localOffset) - 1,
          ),
        );
        return blockStartIndex + localIndex;
      }
      blockStartIndex += block.keys.length;
      blockStartOffset += block.total;
    }
    return this.count - 1;
  }

  measure(key: string, size: number): TimelineMeasurement {
    const location = this.locations.get(key);
    if (!location) {
      return { changed: false, delta: 0, index: -1, rowsVisited: 0 };
    }
    const next = clampSize(size);
    const previous = location.block.sizes[location.localIndex]!;
    const delta = next - previous;
    if (Math.abs(delta) < 0.25) {
      location.block.measured[location.localIndex] = true;
      return {
        changed: false,
        delta: 0,
        index: this.indexOfLocation(location),
        rowsVisited: 0,
      };
    }
    location.block.sizes[location.localIndex] = next;
    location.block.measured[location.localIndex] = true;
    const rowsVisited = rebuildBlockPrefix(
      location.block,
      location.localIndex,
    );
    this.total += delta;
    return {
      changed: true,
      delta,
      index: this.indexOfLocation(location),
      rowsVisited,
    };
  }

  visibleRange(args: {
    scrollOffset: number;
    viewportSize: number;
    overscan: number;
    maxItems: number;
  }): TimelineVisibleRange {
    if (this.count === 0) return { start: 0, end: 0 };
    const viewportStart = Math.max(0, args.scrollOffset);
    const viewportEnd = viewportStart + Math.max(1, args.viewportSize);
    let start = this.indexAtOffset(Math.max(0, viewportStart - args.overscan));
    let end = Math.min(
      this.count,
      this.indexAtOffset(Math.min(this.total, viewportEnd + args.overscan)) + 1,
    );
    const visibleStart = this.indexAtOffset(viewportStart);
    const visibleEnd = Math.min(
      this.count,
      this.indexAtOffset(Math.min(this.total, viewportEnd)) + 1,
    );
    const maxItems = Math.max(1, Math.floor(args.maxItems));
    if (end - start > maxItems) {
      const visibleCount = visibleEnd - visibleStart;
      if (visibleCount >= maxItems) {
        start = visibleStart;
        end = Math.min(this.count, start + maxItems);
      } else {
        const spare = maxItems - visibleCount;
        start = Math.max(0, visibleStart - Math.floor(spare / 2));
        end = Math.min(this.count, start + maxItems);
        start = Math.max(0, end - maxItems);
      }
    }
    return { start, end };
  }

  debug(): TimelineLayoutDebug {
    let measuredCount = 0;
    let maxBlockSize = 0;
    for (const block of this.blocks) {
      maxBlockSize = Math.max(maxBlockSize, block.keys.length);
      for (const measured of block.measured) {
        if (measured) measuredCount += 1;
      }
    }
    return {
      itemCount: this.count,
      blockCount: this.blocks.length,
      measuredCount,
      maxBlockSize,
      retainedKeyCount: this.locations.size,
      contentSize: this.total,
      lastOperation: this.lastReconcile.operation,
      lastEstimateCalls: this.lastReconcile.estimateCalls,
      lastExistingRowsVisited: this.lastReconcile.existingRowsVisited,
    };
  }
}
