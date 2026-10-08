declare module "@conway/automaton/config.js" {
  export interface AutomatonCliConfig {
    name: string;
    walletAddress: string;
    creatorAddress: string;
    sandboxId: string;
    dbPath: string;
    inferenceModel: string;
    conwayApiUrl: string;
    conwayApiKey: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
    socialRelayUrl?: string;
  }

  export function loadConfig(): AutomatonCliConfig | null;
  export function resolvePath(p: string): string;
}

declare module "@conway/automaton/state/database.js" {
  export interface CliToolCall {
    name: string;
    result: string;
    error?: string;
  }

  export interface CliTurn {
    id: string;
    timestamp: string;
    state: string;
    input?: string;
    inputSource?: string;
    thinking: string;
    toolCalls: CliToolCall[];
    tokenUsage: { totalTokens: number };
    costCents: number;
  }

  export interface CliHeartbeatEntry {
    enabled: boolean;
  }

  export interface CliInstalledTool {
    id: string;
    name: string;
  }

  export interface AutomatonCliDatabase {
    getAgentState(): string;
    getTurnCount(): number;
    getInstalledTools(): CliInstalledTool[];
    getHeartbeatEntries(): CliHeartbeatEntry[];
    getRecentTurns(limit: number): CliTurn[];
    close(): void;
  }

  export function createDatabase(path: string): AutomatonCliDatabase;
}

declare module "@conway/automaton/identity/chain.js" {
  export type ChainType = "solana";
  export interface ChainIdentity {
    readonly chainType: ChainType;
    readonly address: string;
    signMessage(message: string): Promise<string>;
    signBytes(bytes: Uint8Array): Promise<Uint8Array>;
  }
  export function isValidSolanaAddress(address: string): boolean;
  export class SolanaChainIdentity implements ChainIdentity {
    readonly chainType: ChainType;
    readonly address: string;
    constructor(secretKey: Uint8Array);
    signMessage(message: string): Promise<string>;
    signBytes(bytes: Uint8Array): Promise<Uint8Array>;
    getSecretKey(): Uint8Array;
    getPublicKey(): Uint8Array;
  }
}

declare module "@conway/automaton/social/signing.js" {
  import type { ChainIdentity } from "@conway/automaton/identity/chain.js";
  export interface SignedMessagePayload {
    from: string;
    to: string;
    content: string;
    signed_at: string;
    signature: string;
    reply_to?: string;
  }
  export function signSendPayload(
    signer: ChainIdentity,
    to: string,
    content: string,
    replyTo?: string,
  ): Promise<SignedMessagePayload>;
}
