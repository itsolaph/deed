// Pure identity reconciliation. Input: [{ worker: 'worker-a', rows: parsedJournalRows }].
// Pass { vault, pricePerCall } with the fixed integer price in base units. A supplied
// vault is an assertion, not a filter: foreign signed payloads invalidate the evidence.
// Journals are evidence here, not cryptographically verified by this module. Only a
// settled status='charged' is a debit; a 'duplicate' acknowledgement is not another one.
export function reconcile(workers, { vault, pricePerCall } = {}) {
  const deliveries = new Map();
  const workerDeliveries = new Map();
  for (const { worker, rows } of workers) {
    if (!workerDeliveries.has(worker)) workerDeliveries.set(worker, new Map());
    const local = workerDeliveries.get(worker);
    for (const row of rows) {
      if (!row.id) continue; // floor/state watermarks are not delivery identities
      const payload = row.receipt?.payload ?? row.proof?.payload;
      if (vault && payload?.vault && payload.vault !== vault) {
        throw new Error(`vault mismatch for ${row.id}: expected ${vault}, got ${payload.vault}`);
      }
      let d = deliveries.get(row.id);
      if (!d) {
        d = {
          id: row.id, customer: null, accepted: false, charged: false, finalAttempt: null,
          workers: new Set(), chargedBy: new Set(), claims: new Map(), chargeClaims: [],
        };
        deliveries.set(row.id, d);
      }
      d.workers.add(worker);
      if (!local.has(row.id)) local.set(row.id, { accepted: false, charged: false, state: 'pending' });
      const held = local.get(row.id);
      if (row.t === 'accepted') {
        d.customer = payload.customer;
        d.accepted = true;
        held.accepted = true;
      }
      if (row.t === 'accepted' || row.t === 'reseq') {
        const claim = { worker, customer: payload.customer, seq: String(payload.seq) };
        d.claims.set(JSON.stringify(claim), claim);
      }
      if (row.t === 'attempt') {
        // A successor restarts attempt numbering. Signed wall-clock time orders proofs
        // across workers; journal order breaks equal/missing timestamp ties.
        if (!d.finalAttempt || (payload.at ?? 0) >= (d.finalAttempt.at ?? 0)) d.finalAttempt = { ...payload };
        held.state = payload.status_code === 200 ? 'delivered' : 'pending';
      }
      if (row.t === 'state') held.state = row.state;
      if (row.t === 'charged') d.chargeClaims.push({ worker, seq: String(row.seq) });
      if (row.t === 'charged' && row.status === 'charged') {
        d.charged = true;
        d.chargedBy.add(worker);
        held.charged = true;
      }
    }
  }
  const records = [...deliveries.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const d of records) {
    for (const { worker, seq } of d.chargeClaims) {
      const customer = [...d.claims.values()].find((c) => c.worker === worker)?.customer ?? d.customer;
      if (customer) {
        const claim = { worker, customer, seq };
        d.claims.set(JSON.stringify(claim), claim);
      }
    }
  }
  const deliveryIds = records.map((d) => d.id);
  const acceptedIds = records.filter((d) => d.accepted).map((d) => d.id);
  const deliveredIds = records.filter((d) => d.finalAttempt?.status_code === 200).map((d) => d.id);
  const chargedIds = records.filter((d) => d.charged).map((d) => d.id);
  const count = (items) => ({
    distinct: items.length,
    accepted: items.filter((d) => d.accepted).length,
    delivered: items.filter((d) => d.finalAttempt?.status_code === 200).length,
    charged: items.filter((d) => d.charged).length,
    expectedRevenue: String(BigInt(items.filter((d) => d.charged).length) * BigInt(pricePerCall ?? 0)),
  });
  const perCustomer = {};
  for (const customer of [...new Set(records.map((d) => d.customer).filter(Boolean))].sort()) {
    perCustomer[customer] = count(records.filter((d) => d.customer === customer));
  }
  const sequences = new Map();
  for (const d of records) {
    for (const { customer, seq } of d.claims.values()) {
      const key = JSON.stringify([customer, seq]);
      if (!sequences.has(key)) sequences.set(key, { customer, seq, ids: new Set() });
      sequences.get(key).ids.add(d.id);
    }
  }
  return {
    deliveryIds, acceptedIds, deliveredIds, chargedIds,
    workers: Object.fromEntries([...workerDeliveries].map(([worker, local]) => [worker, {
      acceptedIds: [...local].filter(([, d]) => d.accepted).map(([id]) => id).sort(),
      // Match retirement's pending work plus delivered work whose charge never landed.
      openIds: [...local].filter(([, d]) => d.accepted &&
        (d.state === 'pending' || (d.state === 'delivered' && !d.charged))).map(([id]) => id).sort(),
    }])),
    acceptedButNeverChargedIds: records.filter((d) => d.accepted && !d.charged).map((d) => d.id),
    chargedButNotDeliveredIds: records.filter((d) => d.charged && d.finalAttempt?.status_code !== 200).map((d) => d.id),
    multiWorkerIds: records.filter((d) => d.workers.size > 1).map((d) => d.id),
    multiWorkerChargedIds: records.filter((d) => d.chargedBy.size > 1).map((d) => d.id),
    sequenceCollisions: [...sequences.values()].filter((s) => s.ids.size > 1)
      .map(({ customer, seq, ids }) => ({ customer, seq, deliveryIds: [...ids].sort() })),
    seqConflictIds: records.filter((d) => {
      const claims = [...d.claims.values()];
      return claims.some((a) => claims.some((b) => a.worker !== b.worker && (a.seq !== b.seq || a.customer !== b.customer)));
    }).map((d) => d.id),
    deliveries: records.map(({ claims, chargeClaims, ...d }) => ({
      ...d, workers: [...d.workers].sort(), chargedBy: [...d.chargedBy].sort(),
      sequenceClaims: [...claims.values()],
    })),
    totals: count(records), perCustomer,
  };
}

/** A's retired journal freezes the source obligations; only B's accepted IDs prove custody. */
export function rotationCoverage(report, fromWorker, toWorker) {
  const originalIds = report.workers[fromWorker]?.openIds ?? [];
  const successor = new Set(report.workers[toWorker]?.acceptedIds ?? []);
  const heldIds = originalIds.filter((id) => successor.has(id));
  const missingIds = originalIds.filter((id) => !successor.has(id));
  const doubleChargedIds = report.multiWorkerChargedIds;
  const unavailableWorkers = [fromWorker, toWorker].filter((worker) => !report.workers[worker]);
  return {
    originalIds, heldIds, missingIds, doubleChargedIds, unavailableWorkers,
    ok: unavailableWorkers.length === 0 && missingIds.length === 0 && doubleChargedIds.length === 0 &&
      report.seqConflictIds.length === 0 && report.sequenceCollisions.length === 0,
  };
}
