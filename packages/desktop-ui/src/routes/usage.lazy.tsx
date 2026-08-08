import { createLazyFileRoute } from "@tanstack/react-router";
import { UsageApp } from "@/app/usage/App";

export const Route = createLazyFileRoute("/usage")({
  component: UsageApp,
});
