import { logToFile } from './logger.js';

export interface WorkspaceConfig {
  clientId: string;
}

const DEFAULT_CONFIG: WorkspaceConfig = {
  clientId:
    '398468929332-q768etk5go3lbjbdh9nth3d505pc7aqk.apps.googleusercontent.com',
};

export function loadConfig(): WorkspaceConfig {
  const config: WorkspaceConfig = {
    clientId: process.env['WORKSPACE_CLIENT_ID'] || DEFAULT_CONFIG.clientId,
  };

  const maskedClientId =
    config.clientId.length > 2
      ? `...${config.clientId.slice(-2)}`
      : config.clientId;
  logToFile(`Loaded config: clientId=${maskedClientId}`);
  return config;
}
