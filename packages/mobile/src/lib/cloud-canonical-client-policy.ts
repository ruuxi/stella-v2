export type CanonicalJournalClientPolicy = {
  hydrateLocalTranscript: boolean;
  persistLocalTranscript: boolean;
  drainOperationalOutbox: boolean;
};

/**
 * The DO journal owns signed-in cloud history. SQLite is only its rebuilt
 * projection, while the separately durable outbox remains inert until this
 * exact authority has connected and caught up.
 */
export const cloudCanonicalClientPolicy = (args: {
  canonicalJournal: boolean;
  authorityReady: boolean;
}): CanonicalJournalClientPolicy =>
  args.canonicalJournal
    ? {
        hydrateLocalTranscript: false,
        persistLocalTranscript: false,
        drainOperationalOutbox: args.authorityReady,
      }
    : {
        hydrateLocalTranscript: true,
        persistLocalTranscript: true,
        drainOperationalOutbox: true,
      };

/** A callback from a retired account/session mount can never mutate its successor. */
export const canonicalAuthorityLeaseAllowsWork = (args: {
  canonicalJournal: boolean;
  capturedLease: number | undefined;
  activeLease: number;
}): boolean =>
  !args.canonicalJournal || args.capturedLease === args.activeLease;
