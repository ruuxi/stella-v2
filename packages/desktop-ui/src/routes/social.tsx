import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/social")({
  beforeLoad: () => {
    throw redirect({ to: "/chat", replace: true });
  },
});
