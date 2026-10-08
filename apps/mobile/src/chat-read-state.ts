export interface MessageReadReceipt { confirmedMessageIds: string[]; unreadCount: number }
/** Adapter is installed only after the common per-message server contract is supplied. */
export interface MessageReadPort {
  markVisible(conversationId: string, messageIds: string[], signal: AbortSignal): Promise<MessageReadReceipt>;
}
export interface ViewBounds { x: number; y: number; width: number; height: number }
/** Positive body intersection; padding and timestamp-only exposure do not qualify. */
export function bodyIntersectsViewport(body: ViewBounds, viewport: ViewBounds): boolean {
  return [body, viewport].every(rect => Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0)
    && Math.min(body.x + body.width, viewport.x + viewport.width) > Math.max(body.x, viewport.x)
    && Math.min(body.y + body.height, viewport.y + viewport.height) > Math.max(body.y, viewport.y);
}
export async function dispatchVisibleMessages(port: MessageReadPort | null, conversationId: string, ids: string[], signal: AbortSignal): Promise<MessageReadReceipt | null> {
  if (!port || ids.length === 0 || signal.aborted) return null;
  const unique = [...new Set(ids)];
  const receipt = await port.markVisible(conversationId, unique, signal);
  if (signal.aborted) throw new Error("READ_CANCELLED");
  if (!receipt || !Array.isArray(receipt.confirmedMessageIds) || receipt.confirmedMessageIds.length !== unique.length || new Set(receipt.confirmedMessageIds).size !== unique.length || receipt.confirmedMessageIds.some(id => !unique.includes(id)) || !Number.isSafeInteger(receipt.unreadCount) || receipt.unreadCount < 0) throw new Error("INVALID_READ_RECEIPT");
  return receipt;
}
