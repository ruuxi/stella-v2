export type MobileAudioMode = {
  allowsRecording?: boolean;
  playsInSilentMode?: boolean;
  [key: string]: unknown;
};

export type RecordingAudioLease = number;

type ApplyAudioMode = (mode: MobileAudioMode) => Promise<void>;

export class AudioSessionCoordinator {
  private activeRecordingLease: RecordingAudioLease | null = null;
  private nextLease = 0;
  private operations: Promise<void> = Promise.resolve();

  constructor(private readonly applyAudioMode: ApplyAudioMode) {}

  acquireRecording(
    mode: MobileAudioMode = { playsInSilentMode: true },
  ): Promise<RecordingAudioLease | null> {
    const lease = ++this.nextLease;

    this.activeRecordingLease = lease;

    return this.enqueue(async () => {
      if (this.activeRecordingLease !== lease) return null;
      try {
        await this.applyAudioMode({
          ...mode,
          allowsRecording: true,
        });
      } catch (error) {
        if (this.activeRecordingLease === lease) {
          this.activeRecordingLease = null;
        }
        throw error;
      }
      return this.activeRecordingLease === lease ? lease : null;
    });
  }

  refreshRecording(
    lease: RecordingAudioLease,
    mode: MobileAudioMode,
  ): Promise<boolean> {
    if (this.activeRecordingLease !== lease) return Promise.resolve(false);
    return this.enqueue(async () => {
      if (this.activeRecordingLease !== lease) return false;
      await this.applyAudioMode({ ...mode, allowsRecording: true });
      return this.activeRecordingLease === lease;
    });
  }

  releaseRecording(lease: RecordingAudioLease): Promise<void> {
    if (this.activeRecordingLease !== lease) return Promise.resolve();
    this.activeRecordingLease = null;

    return this.enqueue(async () => {

      if (this.activeRecordingLease !== null) return;
      await this.applyAudioMode({ allowsRecording: false });
    });
  }

  configurePlayback(): Promise<boolean> {
    if (this.activeRecordingLease !== null) return Promise.resolve(false);

    return this.enqueue(async () => {
      if (this.activeRecordingLease !== null) return false;
      await this.applyAudioMode({
        allowsRecording: false,
        playsInSilentMode: true,
      });

      return this.activeRecordingLease === null;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
