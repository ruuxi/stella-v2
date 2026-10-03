-- Abuse admission's global data (src/owner-store/domains/abuse.ts). Each
-- owner's enforcement and risk counters live in its owner object; these are
-- the cross-owner reads. The Cron Trigger sweeps old rows (src/cron.ts).

-- One row per owner seen behind a device key or network at a session mint,
-- written only for identity levels 0-1. `kind` is "device" (device key hash),
-- "anon_ip" (anonymous owners by IP hash) or "hosting_ip" (owners on a
-- hosting network by IP hash). Sybil pressure counts the distinct owners
-- behind one key inside a window.
CREATE TABLE sybil_sightings (
  kind TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key_hash, owner_id)
);
CREATE INDEX sybil_sightings_last_seen ON sybil_sightings (last_seen_at);

-- The anonymous trial's request allowance: "owner:<ownerId>" buckets are
-- reserved in chunks when a session capability is minted; "ip:<ipHash>"
-- buckets count each settled anonymous request. A bucket restarts once its
-- window is 30 days old.
CREATE TABLE anon_allowance (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);
CREATE INDEX anon_allowance_window ON anon_allowance (window_start);

-- Each owner's latest risk score and enforcement status, for the admin top
-- list. Written by the owner object when usage settles or enforcement changes.
CREATE TABLE owner_risk (
  owner_id TEXT PRIMARY KEY,
  score INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX owner_risk_score ON owner_risk (score DESC, updated_at DESC);
CREATE INDEX owner_risk_updated ON owner_risk (updated_at);
