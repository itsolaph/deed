// Who may see the holder-only operator console on a outlive. Pure so the rule is testable
// without a wallet, a DOM or an RPC: the owner comes from nft_token(owner_id).

/** Case-insensitive account comparison; null or empty on either side is never a holder. */
export function isHolder(ownerId: string | null, connectedId: string | null): boolean {
  if (!ownerId || !connectedId) return false;
  return ownerId.toLowerCase() === connectedId.toLowerCase();
}
