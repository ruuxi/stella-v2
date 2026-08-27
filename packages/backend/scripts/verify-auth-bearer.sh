#!/usr/bin/env bash
# Proves the bearer and first-party OTT paths work end to end without using
# cookies as client credentials.
set -uo pipefail
SITE="${1:-https://impartial-crab-34.convex.site}"
CLOUD="$(echo "$SITE" | sed s/.convex.site/.convex.cloud/)"
cd "$(mktemp -d)"
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

echo "== 1. sign in, look for set-auth-token =="
curl -s -i -X POST "$SITE/api/auth/sign-in/anonymous" \
  -H 'content-type: application/json' -H "origin: $SITE" -d '{}' -o b_signin.txt
TOKEN=$(grep -i '^set-auth-token:' b_signin.txt | sed -E 's/^[^:]*: *//' | tr -d '\r')
[ -n "$TOKEN" ] && pass "server emitted set-auth-token" || fail "no set-auth-token header"

echo "== 2. is it exposed to browsers via CORS? =="
EXPOSED=$(grep -i '^access-control-expose-headers:' b_signin.txt | tr -d '\r' | sed -E 's/^[^:]*: *//')
echo "     expose-headers: $EXPOSED"
echo "$EXPOSED" | grep -qi 'set-auth-token' && pass "set-auth-token is readable by JS" || fail "not in expose list"

echo "== 3. token is a signed wrapper (token.sig), not a raw session id =="
case "$TOKEN" in *.*) pass "has signature segment" ;; *) fail "unsigned token" ;; esac

echo "== 4. exchange the first-party one-time token for a bearer token =="
OTT=$(grep -i '^set-ott:' b_signin.txt | sed -E 's/^[^:]*: *//' | tr -d '\r')
[ -n "$OTT" ] && pass "server emitted set-ott" || fail "no set-ott header"
OTT_CODE=$(curl -s -D b_ott_headers.txt -o b_ott.json -w '%{http_code}' \
  -X POST "$SITE/api/auth/one-time-token/verify" \
  -H 'content-type: application/json' -d "{\"token\":\"$OTT\"}")
OTT_TOKEN=$(grep -i '^set-auth-token:' b_ott_headers.txt | sed -E 's/^[^:]*: *//' | tr -d '\r')
echo "     HTTP $OTT_CODE, bearer present: $([ -n "$OTT_TOKEN" ] && echo yes || echo no)"
[ "$OTT_CODE" = "200" ] && [ -n "$OTT_TOKEN" ] \
  && pass "OTT exchanged through the first-party endpoint" \
  || fail "OTT exchange failed"

echo "== 5. the removed cross-domain endpoint stays gone =="
OLD_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$SITE/api/auth/cross-domain/one-time-token/verify" \
  -H 'content-type: application/json' -d "{\"token\":\"$OTT\"}")
echo "     HTTP $OLD_CODE"
[ "$OLD_CODE" = "404" ] && pass "legacy endpoint is absent" || fail "legacy endpoint returned $OLD_CODE"

if [ -n "$OTT_TOKEN" ]; then TOKEN="$OTT_TOKEN"; fi

echo "== 6. authenticate with ONLY the bearer header (no cookie) =="
CODE=$(curl -s -o b_sess.json -w '%{http_code}' "$SITE/api/auth/get-session" \
  -H "authorization: Bearer $TOKEN" -H "origin: $SITE")
HASUSER=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync("b_sess.json","utf8"));process.stdout.write(j&&j.user&&j.user.id?"yes":"no")}catch{process.stdout.write("no")}')
echo "     HTTP $CODE, session resolved: $HASUSER"
[ "$HASUSER" = "yes" ] && pass "cookie-free session works" || fail "bearer did not authenticate"

echo "== 7. mint a Convex JWT with ONLY the bearer header =="
JWT=$(curl -s "$SITE/api/auth/convex/token" -H "authorization: Bearer $TOKEN" -H "origin: $SITE" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})')
[ -n "$JWT" ] && pass "minted Convex JWT without cookies (len ${#JWT})" || fail "could not mint JWT via bearer"

echo "== 8. that JWT actually authenticates a Convex function =="
RES=$(curl -s -X POST "$CLOUD/api/query" -H 'content-type: application/json' \
  -H "authorization: Bearer $JWT" \
  -d '{"path":"auth:getCurrentUser","args":{},"format":"json"}')
echo "     $(echo "$RES" | head -c 200)"
echo "$RES" | grep -q '"status":"success"' && echo "$RES" | grep -q '"id"' && pass "end-to-end cookie-free auth confirmed" || fail "query did not authenticate"

echo "== 9. a garbage bearer token is rejected =="
BADCODE=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/auth/convex/token" \
  -H "authorization: Bearer not-a-real-token.deadbeef" -H "origin: $SITE")
echo "     HTTP $BADCODE"
[ "$BADCODE" != "200" ] && pass "forged token rejected ($BADCODE)" || fail "forged token accepted"

echo
[ "$FAILED" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $FAILED
