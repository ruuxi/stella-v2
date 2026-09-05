/** A `fetch` double that keeps every request it saw and answers with `respond`. */
export const fetchRecorder = (
  respond: (request: Request, index: number) => Response | Promise<Response>,
): { fetch: typeof fetch; requests: Request[] } => {
  const requests: Request[] = [];
  const transport = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
      requests.push(request);
      return await respond(request, requests.length - 1);
    },
    fetch,
  );
  return { fetch: transport, requests };
};
