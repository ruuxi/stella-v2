import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/apps/$slug")({
  beforeLoad: () => {
    throw redirect({ to: "/chat", replace: true });
  },
});
