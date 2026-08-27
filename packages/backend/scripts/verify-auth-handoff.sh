#!/usr/bin/env bash
# Live checks on the browser -> app session handoff endpoints.
#
# Scope note: this covers routing and input validation only. The claim
# LIFECYCLE (correct/wrong secret, single use, 3-minute window, attempt cap,
# and that /link/status never returns a credential) is covered by
# `convex/mobile_auth.convex.test.ts`, which drives the internal mutations
# directly.
#
# It used to complete a real handoff via the App Review sign-in endpoint, but
# that endpoint was a deliberate backdoor and has been deleted. There is no
# longer any way to complete a handoff without receiving an email or finishing
# a real OAuth round trip, so the lifecycle assertions moved into the Convex
# test where they are deterministic.
#
# Takes an optional deployment site URL as $1. Safe against dev.
set -uo pipefail
SITE="${1:-https://impartial-crab-34.convex.site}"
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0
WORK="$(mktemp -d)"

echo "== 1. /link/claim rejects a missing body =="
CODE=$(curl -s -o "$WORK/a" -w '%{http_code}' -X POST "$SITE/api/auth/link/claim" \
  -H 'content-type: application/json' -d '{}')
echo "     HTTP $CODE $(head -c 80 "$WORK/a")"
[ "$CODE" = "400" ] && pass "missing requestId/claimSecret rejected" || fail "expected 400, got $CODE"

echo "== 2. /link/claim rejects an unknown requestId =="
CODE=$(curl -s -o "$WORK/b" -w '%{http_code}' -X POST "$SITE/api/auth/link/claim" \
  -H 'content-type: application/json' \
  -d '{"requestId":"00000000-0000-4000-8000-000000000000","claimSecret":"nope"}')
echo "     HTTP $CODE $(head -c 80 "$WORK/b")"
# Deliberately indistinguishable from "wrong secret".
[ "$CODE" = "404" ] && pass "unknown handoff rejected as not-claimable" || fail "expected 404, got $CODE"

echo "== 3. /link/send requires a claimHash =="
CODE=$(curl -s -o "$WORK/c" -w '%{http_code}' -X POST "$SITE/api/auth/link/send" \
  -H 'content-type: application/json' -d '{"email":"nobody@example.test"}')
echo "     HTTP $CODE $(head -c 80 "$WORK/c")"
[ "$CODE" = "400" ] && pass "claimHash is mandatory" || fail "expected 400, got $CODE"

echo "== 4. /link/status never returns a credential field =="
S=$(curl -s "$SITE/api/auth/link/status?requestId=00000000-0000-4000-8000-000000000000")
echo "     $(echo "$S" | head -c 100)"
if echo "$S" | grep -qE 'sessionCookie|tokenEnc|"token"'; then
  fail "status response exposed a credential field"
else
  pass "no credential field in status response"
fi

echo "== 5. the App Review sign-in backdoor is gone =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SITE/api/auth/review/sign-in" \
  -H 'content-type: application/json' -d '{"email":"anything@example.test"}')
echo "     HTTP $CODE"
[ "$CODE" = "404" ] && pass "endpoint removed ($CODE)" || fail "review sign-in still reachable ($CODE)"

echo
[ "$FAILED" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
rm -rf "$WORK"
exit $FAILED
