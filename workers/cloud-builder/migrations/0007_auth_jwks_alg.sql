-- Better Auth 1.7 records each JWKS key's algorithm and curve.
alter table "jwks" add column "alg" text;
alter table "jwks" add column "crv" text;
