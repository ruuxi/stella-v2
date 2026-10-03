-- Which owner each GitHub App installation belongs to. GitHub's installation
-- webhook carries nothing but the installation id, so this routes it to the
-- owner's object (src/projects/routes.ts). Written by the owner object when
-- the owner finishes the connect handshake; an installation binds to at most
-- one owner.
CREATE TABLE github_installations (
  installation_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL
);
