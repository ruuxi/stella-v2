import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/c/$handle")({
  beforeLoad: () => {
    throw redirect({ to: "/chat", replace: true });
  },
});
