declare module "react-native-static-server" {
  type StaticServerOptions = {
    keepAlive?: boolean;
    localOnly?: boolean;
  };

  export default class StaticServer {
    constructor(
      port?: number,
      root?: string,
      options?: StaticServerOptions,
    );
    start(): Promise<string>;
    stop(): Promise<boolean>;
    isRunning(): Promise<boolean>;
  }
}
