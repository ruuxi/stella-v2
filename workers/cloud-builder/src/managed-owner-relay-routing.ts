type OwnerRelayNamespace<Id> = Readonly<{
  idFromName(name: string): Id;
  get(id: Id): Readonly<{ fetch(request: Request): Promise<Response> }>;
}>;

/** Route an eligible signed request to its owner DO; the DO retains all checks. */
export const fetchManagedOwnerRelay = <Id>(args: {
  request: Request;
  ownerId: string;
  namespace?: OwnerRelayNamespace<Id>;
  eligible: boolean;
  fallback: (request: Request) => Promise<Response>;
}): Promise<Response> => {
  if (!args.eligible || !args.namespace) return args.fallback(args.request);
  const id = args.namespace.idFromName(args.ownerId);
  return args.namespace.get(id).fetch(args.request);
};
