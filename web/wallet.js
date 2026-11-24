// Browser wallet discovery + signing. Wallet Standard first (Phantom, Solflare, Backpack, ... expose it),
// legacy injected providers (window.phantom.solana / window.solflare / window.solana) as fallback.
// This module never sees a private key: it only hands transaction bytes to the wallet for the user to approve.
// No imports, so it can be inlined into the static demo.

const CHAIN = 'solana:mainnet';
const found = new Map(); // name -> { name, icon, kind, wallet|provider }
const listeners = new Set();
const notify = () => listeners.forEach((f) => f(list()));

function registerStandard(...wallets) {
  for (const w of wallets) {
    const solana = (w.chains || []).some((c) => String(c).startsWith('solana:'));
    if (solana && w.features && w.features['standard:connect']) found.set(w.name, { name: w.name, icon: w.icon, kind: 'standard', wallet: w });
  }
  notify();
  return () => {};
}

export function startDiscovery() {
  const api = { register: registerStandard };
  try {
    window.addEventListener('wallet-standard:register-wallet', (e) => {
      try { e.detail(api); } catch {}
    });
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch {}
  const legacy = [
    ['Phantom', window.phantom && window.phantom.solana],
    ['Solflare', window.solflare],
    ['Injected Solana wallet', window.solana],
  ];
  for (const [name, p] of legacy) {
    if (p && typeof p.connect === 'function' && ![...found.values()].some((f) => f.name.startsWith(name))) {
      found.set(`${name} (legacy)`, { name: `${name} (legacy)`, kind: 'legacy', provider: p });
    }
  }
  notify();
}

export const list = () => [...found.values()];
export const onChange = (f) => (listeners.add(f), () => listeners.delete(f));

/** Connect and return a session object: { name, kind, address, signTransaction?, signAndSend? }. */
export async function connect(name) {
  const w = found.get(name);
  if (!w) throw new Error(`wallet ${name} not found`);
  if (w.kind === 'standard') {
    const { accounts } = await w.wallet.features['standard:connect'].connect();
    const account = (accounts || w.wallet.accounts || [])[0];
    if (!account) throw new Error('wallet returned no account');
    const f = w.wallet.features;
    return {
      name: w.name,
      kind: 'standard',
      address: account.address,
      canSignOnly: !!f['solana:signTransaction'],
      async signTransaction(bytes) {
        const [out] = await f['solana:signTransaction'].signTransaction({ account, transaction: bytes, chain: CHAIN });
        return out.signedTransaction;
      },
      async signAndSend(bytes) {
        const [out] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account, transaction: bytes, chain: CHAIN });
        return out.signature; // Uint8Array
      },
      async disconnect() {
        try { await f['standard:disconnect']?.disconnect(); } catch {}
      },
    };
  }
  // Legacy providers want a web3.js transaction object; load web3.js lazily only on this path.
  const p = w.provider;
  const r = await p.connect();
  const pk = (r && r.publicKey) || p.publicKey;
  const web3 = () => import('https://esm.sh/@solana/web3.js@1.98.0');
  return {
    name: w.name,
    kind: 'legacy',
    address: pk.toString(),
    canSignOnly: typeof p.signTransaction === 'function',
    async signTransaction(bytes) {
      const { VersionedTransaction } = await web3();
      const signed = await p.signTransaction(VersionedTransaction.deserialize(bytes));
      return signed.serialize();
    },
    async signAndSend(bytes) {
      const { VersionedTransaction } = await web3();
      const { signature } = await p.signAndSendTransaction(VersionedTransaction.deserialize(bytes));
      return signature; // base58 string on legacy providers
    },
    async disconnect() {
      try { await p.disconnect(); } catch {}
    },
  };
}
