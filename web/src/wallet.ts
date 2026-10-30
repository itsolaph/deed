// Wallet connection with NEAR Connect (@hot-labs/near-connect), the connector NEAR's docs
// recommend for new apps. Wallet code runs in a sandboxed iframe that the library manages.

import { NearConnector } from "@hot-labs/near-connect";
import { NETWORK, TGAS } from "./config";

export interface Call {
  method: string;
  args: Record<string, unknown>;
  gasTgas: number;
  depositYocto: bigint;
}

type Listener = (accountId: string | null) => void;

let connector: NearConnector | null = null;
let account: string | null = null;
const listeners: Listener[] = [];

function notify(): void {
  for (const l of listeners) l(account);
}

export function onAccount(l: Listener): void {
  listeners.push(l);
}

export function currentAccount(): string | null {
  return account;
}

export async function initWallet(): Promise<void> {
  connector = new NearConnector({ network: NETWORK, footerBranding: null });
  connector.on("wallet:signIn", (e: { accounts: { accountId: string }[] }) => {
    account = e.accounts[0]?.accountId ?? null;
    notify();
  });
  connector.on("wallet:signOut", () => {
    account = null;
    notify();
  });
  try {
    const wallet = await connector.wallet();
    const accounts = await wallet.getAccounts();
    account = accounts[0]?.accountId ?? null;
    notify();
  } catch {
    // Not signed in yet.
  }
}

export async function connect(): Promise<void> {
  if (!connector) await initWallet();
  await connector!.connect();
}

export async function disconnect(): Promise<void> {
  if (!connector) return;
  const wallet = await connector.wallet();
  await wallet.signOut();
  account = null;
  notify();
}

/** Signs and sends one transaction with function calls to `receiverId`. Returns the tx hash. */
export async function send(receiverId: string, calls: Call[]): Promise<string | null> {
  if (!connector || !account) throw new Error("connect a wallet first");
  const wallet = await connector.wallet();
  const outcome = await wallet.signAndSendTransaction({
    signerId: account,
    receiverId,
    actions: calls.map((c) => ({
      type: "FunctionCall" as const,
      params: {
        methodName: c.method,
        args: c.args,
        gas: (BigInt(c.gasTgas) * TGAS).toString(),
        deposit: c.depositYocto.toString(),
      },
    })),
  });
  const hash = (outcome as { transaction?: { hash?: string } } | undefined)?.transaction?.hash;
  return hash ?? null;
}
