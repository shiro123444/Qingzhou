/** Independent budgets keep the animated player from waiting for slower background panes. */
export class GlassFrameBudget {
  private capsuleScale = 1;
  private sharedScale = 1;
  private sharedCost = 0;
  private lastShared = -Infinity;
  private capsuleHealthy = 0;
  private sharedHealthy = 0;

  capsulePixels() {
    return 90_000 * this.capsuleScale;
  }

  sharedPixels() {
    return 35_000 * this.sharedScale;
  }

  /** No cadence cap on the player. Lower its resolution before sacrificing interaction frames. */
  recordCapsule(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    if (milliseconds > 7) {
      this.capsuleScale = Math.max(0.2, this.capsuleScale * 0.8);
      this.capsuleHealthy = 0;
    } else if (milliseconds < 4 && ++this.capsuleHealthy >= 60) {
      this.capsuleScale = Math.min(1, this.capsuleScale + 0.05);
      this.capsuleHealthy = 0;
    }
  }

  recordShared(now: number, milliseconds: number) {
    this.lastShared = now;
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.sharedCost = this.sharedCost ? this.sharedCost * 0.7 + milliseconds * 0.3 : milliseconds;
    if (milliseconds > 5) {
      this.sharedScale = Math.max(0.2, this.sharedScale * 0.8);
      this.sharedHealthy = 0;
    } else if (milliseconds < 3 && ++this.sharedHealthy >= 30) {
      this.sharedScale = Math.min(1, this.sharedScale + 0.05);
      this.sharedHealthy = 0;
    }
  }

  shouldDrawShared(now: number, interacting: boolean, contentChanged: boolean) {
    // Newly captured content is presented immediately. Under load, only the secondary panes
    // yield to input/player animation; their last valid optical frame stays on screen.
    if (!interacting || contentChanged || this.sharedCost <= 5) return true;
    return now - this.lastShared >= Math.min(100, Math.max(1000 / 30, this.sharedCost * 5));
  }
}

/** Small dirty layers can update every refresh; slow captures are never queued concurrently. */
export const captureDelay = (elapsed: number, previousDuration: number) =>
  Math.max(0, Math.min(100, Math.max(1000 / 60, previousDuration / 2)) - elapsed);
