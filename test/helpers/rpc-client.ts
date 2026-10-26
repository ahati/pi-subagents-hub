/**
 * rpc-client.ts — the client half of the `subagents:rpc:*` protocol, for tests
 * that play the "second extension" role against a booted print-mode session.
 *
 * The bus is in-process (docs/rpc.md), so a client is just an emitter with a
 * request id and a reply-channel subscription. This wraps exactly that:
 *
 *   const rpc = createRpcClient(run.eventBus);
 *   const reply = await rpc.call("spawn", { type: "general-purpose", prompt: "..." });
 *   if (!reply.success) throw new Error(reply.error);
 *
 * Every call gets a unique request id — omitting one (or sharing one) collides
 * on the literal reply channel, which docs/rpc.md calls out as the classic
 * integration mistake.
 */
import type { EventBus, RpcReply } from "../../src/cross-extension-rpc.js";

let seq = 0;

export interface RpcClient {
  call<T = unknown>(
    channel: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<RpcReply<T>>;
  /** Subscribe to a lifecycle event (`subagents:completed`, …). Returns the unsubscriber. */
  onEvent(event: string, handler: (data: unknown) => void): () => void;
  /** Resolves with the first payload emitted on `event` after this call. */
  nextEvent(event: string, timeoutMs?: number): Promise<unknown>;
}

export function createRpcClient(bus: EventBus): RpcClient {
  return {
    async call<T = unknown>(
      channel: string,
      params: Record<string, unknown> = {},
      timeoutMs = 20_000,
    ): Promise<RpcReply<T>> {
      const requestId = `rpc-test-${++seq}`;
      const replyChannel = `subagents:rpc:${channel}:reply:${requestId}`;
      return new Promise<RpcReply<T>>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsub();
          reject(new Error(`RPC "${channel}" timed out after ${timeoutMs}ms (requestId ${requestId})`));
        }, timeoutMs);
        const unsub = bus.on(replyChannel, raw => {
          clearTimeout(timer);
          unsub();
          resolve(raw as RpcReply<T>);
        });
        bus.emit(`subagents:rpc:${channel}`, { requestId, ...params });
      });
    },
    onEvent(event: string, handler: (data: unknown) => void) {
      return bus.on(event, handler);
    },
    nextEvent(event: string, timeoutMs = 20_000): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unsub();
          reject(new Error(`Event "${event}" did not arrive within ${timeoutMs}ms`));
        }, timeoutMs);
        const unsub = bus.on(event, data => {
          clearTimeout(timer);
          unsub();
          resolve(data);
        });
      });
    },
  };
}
