import {
  acceptanceConversationTitle,
  acceptanceOwnerMarkerSha256,
  authorizeDevAcceptanceProbe,
  DEV_ACCEPTANCE_DEPLOYMENT_IDENTITY,
  DEV_ACCEPTANCE_PROBE_VERSION,
} from "../../src/dev-acceptance-probes.js";
import { verifyServiceBearerAuthorization } from "../../src/service-bearer.js";

const fixtureSecret = "workerd-fixture-service-secret";
const runId = "00000000-0000-4000-8000-000000000001";
const ownerId = "workerd-fixture-owner";
const ownerGeneration = "workerd-fixture-generation";

const authorizeProbe = async (suppliedServiceSecret: string) =>
  await authorizeDevAcceptanceProbe({
    env: {
      BUILDER_SERVICE_SECRET: fixtureSecret,
      ENABLE_DEV_ACCEPTANCE_PROBES: "1",
      STELLA_DEPLOYMENT_IDENTITY: DEV_ACCEPTANCE_DEPLOYMENT_IDENTITY,
    },
    suppliedServiceSecret,
    body: {
      version: DEV_ACCEPTANCE_PROBE_VERSION,
      operation: "status",
      runId,
      requestId: "workerd-probe-request",
      ownerId,
      ownerGeneration,
      acceptanceOwnerMarkerSha256: await acceptanceOwnerMarkerSha256(
        runId,
        ownerId,
      ),
    },
    meta: {
      ownerId,
      ownerGeneration,
      conversationId: "workerd-fixture-conversation",
      title: acceptanceConversationTitle(runId),
    },
  });

export default {
  async fetch(): Promise<Response> {
    const nativeTimingSafeEqual =
      typeof crypto.subtle.timingSafeEqual === "function";
    const matchingProbe = await authorizeProbe(fixtureSecret);
    const lengthMismatchProbe = await authorizeProbe(
      fixtureSecret.slice(0, -1),
    );
    return Response.json({
      nativeTimingSafeEqual,
      matching: await verifyServiceBearerAuthorization(
        `Bearer ${fixtureSecret}`,
        fixtureSecret,
      ),
      mismatched: await verifyServiceBearerAuthorization(
        "Bearer wrong-fixture-secret",
        fixtureSecret,
      ),
      malformed: await verifyServiceBearerAuthorization(
        "Bearer two credentials",
        fixtureSecret,
      ),
      probeMatching: matchingProbe.ok,
      probeLengthMismatch: lengthMismatchProbe.ok,
      probeLengthMismatchCode: lengthMismatchProbe.ok
        ? null
        : lengthMismatchProbe.code,
    });
  },
} satisfies ExportedHandler;
