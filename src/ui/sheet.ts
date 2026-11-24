/**
 * iOS-style bottom sheet with detents (Apple Maps style), active on narrow screens only.
 *
 * - Drag the grabber/header — or the content while it is not scrolled — to move the sheet.
 * - On release the sheet snaps to the detent nearest to where the gesture was heading
 *   (position projected by the release velocity, like UIKit's sheet presentation).
 * - Content scrolls only at the top detent; pulling down from scrollTop 0 drags the sheet again.
 */

export interface SheetOptions {
  /** Visible heights in px, ascending. A 0 detent makes the sheet dismissible. */
  detents: () => number[];
  initial: number;
  /** Elements that always drag the sheet (grabber, header). */
  handles: HTMLElement[];
  /** The scrollable content area. */
  scroller?: HTMLElement;
  onChange?: (index: number, visible: number) => void;
}

const MOBILE = window.matchMedia('(max-width: 760px)');
const SPRING = 'transform 0.5s cubic-bezier(0.32, 0.72, 0, 1)';

export class BottomSheet {
  private index: number;
  private visible = 0;
  private suppressClick = false;
  private drag: { startY: number; startVisible: number; samples: { y: number; t: number }[]; moved: boolean } | null = null;

  constructor(private readonly el: HTMLElement, private readonly opts: SheetOptions) {
    this.index = opts.initial;
    for (const h of opts.handles) {
      h.addEventListener('pointerdown', (e) => this.start(e.clientY, e));
      h.addEventListener('click', (e) => {
        // A tap (no drag) on the grabber steps through the detents.
        if (this.suppressClick) {
          this.suppressClick = false;
          return;
        }
        if ((e.target as HTMLElement).closest('.grabber') && MOBILE.matches) this.cycle();
      });
    }
    window.addEventListener('pointermove', (e) => this.move(e.clientY));
    window.addEventListener('pointerup', () => this.end());
    window.addEventListener('pointercancel', () => this.end());

    const sc = opts.scroller;
    if (sc) {
      // Touch on the content: drag the sheet unless the content is expanded and scrolled.
      let y0 = 0;
      sc.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
      sc.addEventListener('touchmove', (e) => {
        if (!MOBILE.matches) return;
        const y = e.touches[0].clientY;
        if (this.drag) {
          e.preventDefault();
          this.move(y);
          return;
        }
        const atTop = this.index === this.detents().length - 1;
        const pullingDown = y > y0 && sc.scrollTop <= 0;
        if (!atTop || pullingDown) {
          e.preventDefault();
          this.start(y0);
          this.move(y);
        }
      }, { passive: false });
      sc.addEventListener('touchend', () => this.end());
      sc.addEventListener('touchcancel', () => this.end());
    }

    MOBILE.addEventListener('change', () => this.layout());
    window.addEventListener('resize', () => this.layout());
    this.layout();
  }

  get detentIndex() {
    return this.index;
  }

  get isMobile() {
    return MOBILE.matches;
  }

  setDetent(i: number, animate = true) {
    const ds = this.detents();
    this.index = Math.max(0, Math.min(ds.length - 1, i));
    this.apply(ds[this.index], animate);
    this.opts.onChange?.(this.index, ds[this.index]);
  }

  private detents() {
    return this.opts.detents();
  }

  private cycle() {
    const n = this.detents().length;
    const min = this.detents()[0] === 0 ? 1 : 0;
    this.setDetent(this.index + 1 >= n ? min : this.index + 1);
  }

  private layout() {
    if (!MOBILE.matches) {
      this.el.style.transform = '';
      this.el.style.transition = '';
      this.el.classList.remove('expanded');
      return;
    }
    this.setDetent(this.index, false);
  }

  private apply(visible: number, animate: boolean) {
    this.visible = visible;
    const h = this.el.offsetHeight;
    this.el.style.transition = animate ? SPRING : 'none';
    this.el.style.transform = `translate3d(0, ${Math.max(0, h - visible)}px, 0)`;
    const top = this.index === this.detents().length - 1 && !this.drag;
    this.el.classList.toggle('expanded', top);
    this.el.classList.toggle('closed', visible === 0);
    this.el.style.setProperty('--sheet-visible', `${visible}px`);
    document.documentElement.style.setProperty(`--${this.el.id}-visible`, `${visible}px`);
  }

  private start(y: number, e?: PointerEvent) {
    if (!MOBILE.matches) return;
    if (e && e.pointerType === 'mouse' && e.button !== 0) return;
    // Fields in the handle (search box, altitude slider/box) keep their own gestures.
    if (e && (e.target as HTMLElement).closest('input, textarea, select')) return;
    this.drag = { startY: y, startVisible: this.visible, samples: [{ y, t: performance.now() }], moved: false };
  }

  private move(y: number) {
    const d = this.drag;
    if (!d) return;
    const dy = d.startY - y;
    if (Math.abs(dy) > 4) d.moved = true;
    const ds = this.detents();
    const [lo, hi] = [ds[0], ds[ds.length - 1]];
    let v = d.startVisible + dy;
    // Rubber-band past the first/last detent.
    if (v > hi) v = hi + rubber(v - hi);
    if (v < lo) v = lo - rubber(lo - v);
    d.samples.push({ y, t: performance.now() });
    if (d.samples.length > 6) d.samples.shift();
    this.apply(v, false);
  }

  private end() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.suppressClick = d.moved;
    if (!d.moved) {
      this.apply(this.detents()[this.index], true);
      return;
    }
    const s = d.samples;
    const dt = Math.max(1, s[s.length - 1].t - s[0].t);
    const velocity = (s[0].y - s[s.length - 1].y) / dt; // px/ms, + = upward
    const projected = this.visible + velocity * 220;
    const ds = this.detents();
    let best = 0;
    ds.forEach((h, i) => { if (Math.abs(h - projected) < Math.abs(ds[best] - projected)) best = i; });
    this.setDetent(best);
  }
}

const rubber = (x: number) => 60 * (1 - Math.exp(-x / 160));
