const CLOUD_SPAWN_MODEL =
  /^(?:claude(?:\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,191}|[A-Za-z0-9][A-Za-z0-9._-]{0,187}\[1m\]))?|codex(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,191})?|stella\/[A-Za-z0-9._:/-]{1,185})(?::(?:low|medium|high|xhigh))?$/;

export const isValidCloudSpawnModel = (model: string): boolean =>
  CLOUD_SPAWN_MODEL.test(model);
