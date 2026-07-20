export type LaunchCredentials = {
  edgeToken: string;
  backendToken: string;
  instanceId: string;
};

export type BridgeIdentity = {
  service: "forge-desktop-bridge";
  protocolVersion: 1;
  instanceId: string;
  enginePid: number;
};

export type SecurityLogEvent = {
  timestamp: string;
  component: "proxy" | "client";
  level: "info" | "warn" | "error";
  code: string;
  method?: string;
  path?: string;
};

export type ProxyAddress = {
  host: "127.0.0.1";
  port: number;
  origin: string;
};

