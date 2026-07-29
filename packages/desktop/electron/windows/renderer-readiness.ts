export type RendererWindowMode = "full" | "mini" | "overlay" | "pet";

type RendererMountedSignal = {
  senderId: number;
  mode: RendererWindowMode;
  token: string;
};

type RendererMountedWaiter = RendererMountedSignal & {
  onMounted: () => void;
};

export class RendererReadinessWaiters {
  private readonly waiters = new Map<number, RendererMountedWaiter>();

  register(waiter: RendererMountedWaiter): () => void {
    this.waiters.set(waiter.senderId, waiter);
    return () => {
      if (this.waiters.get(waiter.senderId) === waiter) {
        this.waiters.delete(waiter.senderId);
      }
    };
  }

  signal(signal: RendererMountedSignal): boolean {
    const waiter = this.waiters.get(signal.senderId);
    if (
      !waiter ||
      waiter.mode !== signal.mode ||
      waiter.token !== signal.token
    ) {
      return false;
    }
    this.waiters.delete(signal.senderId);
    waiter.onMounted();
    return true;
  }
}
