#!/usr/bin/env bash
# End-to-end proof that session revocation actually revokes.
# Replays the exact attack sequence from the audit:
#   1. sign in            -> session cookie
#   2. mint JWT           -> works
#   3. revoke             -> deletes the Better Auth session + tombstones ids
#   4. re-mint with the SAME cookie  -> MUST FAIL (this is what used to succeed)
#   5. reuse the OLD JWT on a sensitive op -> MUST be rejected by the tombstone
set -uo pipefail
SITE="${1:-https://impartial-crab-34.convex.site}"
CLOUD="$(echo "$SITE" | sed s/.convex.site/.convex.cloud/)"
cd "$(mktemp -d)"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

echo "== 1. anonymous sign-in =="
curl -s -i -X POST "$SITE/api/auth/sign-in/anonymous" \
  -H 'content-type: application/json' -H "origin: $SITE" -d '{}' -o e2e_signin.txt
COOKIE=$(grep -i '^set-cookie:' e2e_signin.txt | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]*).*/\1/' | paste -sd'; ' -)
[ -n "$COOKIE" ] && pass "got session cookie" || { fail "no cookie"; exit 1; }

echo "== 2. mint JWT from that session =="
JWT=$(curl -s "$SITE/api/auth/convex/token" -H "cookie: $COOKIE" -H "origin: $SITE" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})')
[ -n "$JWT" ] && pass "minted JWT (len ${#JWT})" || { fail "no JWT"; exit 1; }
SID=$(node -e 'const t=process.argv[1];console.log(JSON.parse(Buffer.from(t.split(".")[1],"base64url")).sessionId)' "$JWT")
echo "     sessionId=$SID"

echo "== 3. call revokeActiveSessions with that JWT =="
REVOKE=$(curl -s -X POST "$CLOUD/api/action" -H 'content-type: application/json' \
  -H "authorization: Bearer $JWT" \
  -d '{"path":"auth:revokeActiveSessions","args":{},"format":"json"}')
echo "     $REVOKE"
echo "$REVOKE" | grep -q '"status":"success"' && pass "revocation call succeeded" || fail "revocation call failed"

echo "== 4. THE FIX: re-mint with the same cookie (previously returned a fresh JWT) =="
CODE=$(curl -s -o e2e_remint.txt -w '%{http_code}' "$SITE/api/auth/convex/token" \
  -H "cookie: $COOKIE" -H "origin: $SITE")
REMINT=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync("e2e_remint.txt","utf8"));process.stdout.write(typeof j.token==="string"?j.token:"")}catch{process.stdout.write("")}')
echo "     HTTP $CODE, token present: $([ -n "$REMINT" ] && echo yes || echo no)"
if [ -z "$REMINT" ]; then pass "session is dead - cannot mint a new JWT"; else fail "STILL MINTING - revocation did not work"; fi

echo "== 5. reuse the OLD JWT on a sensitive operation =="
REPLAY=$(curl -s -X POST "$CLOUD/api/action" -H 'content-type: application/json' \
  -H "authorization: Bearer $JWT" \
  -d '{"path":"auth:revokeActiveSessions","args":{},"format":"json"}')
echo "     $(echo "$REPLAY" | head -c 220)"
echo "$REPLAY" | grep -q 'Session has been revoked' && pass "in-flight JWT rejected by tombstone" || fail "in-flight JWT still accepted"

echo
[ "$FAILED" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $FAILED
