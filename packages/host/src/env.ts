// Environment detection over the host wrapper's sandboxTransport.

/** Mirrors host-api-wrapper's `sandboxTransport` (isCorrectEnvironment sync; isReady handshake). */
export interface SandboxTransportLike {
  isCorrectEnvironment(): boolean;
  isReady(): Promise<boolean>;
}

export interface HostEnv {
  /** True when embedded in a host (iframe/webview). Synchronous. */
  isHost(): boolean;
  /** Resolves true once the host bridge handshake is complete. */
  isReady(): Promise<boolean>;
}

export function createHostEnv(sandbox: SandboxTransportLike): HostEnv {
  return {
    isHost: () => sandbox.isCorrectEnvironment(),
    isReady: () => sandbox.isReady(),
  };
}
