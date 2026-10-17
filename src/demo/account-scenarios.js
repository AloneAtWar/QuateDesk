// Dev preview only: vary the number of accounts without touching the fixed source snapshot.
export function accountCountSnapshot(snapshot, value) {
  if (value == null || !/^(0|[1-9]\d?)$/.test(value) || Number(value) > 48) return snapshot;
  const count = Number(value);
  const active = snapshot.accounts.filter((account) => !account.disabled);
  if (count && !active.length) return snapshot;
  const history = {};
  const cycles = {};
  const accounts = Array.from({ length: count }, (_, index) => {
    const source = active[index % active.length];
    const id = `demo-preview-account-${index + 1}`;
    history[id] = snapshot.history[source.id] || [];
    cycles[id] = snapshot.cycles[source.id] || [];
    return { ...source, id, name: `${snapshot.providers.find((provider) => provider.id === source.providerId)?.name || source.name} ${index + 1}`, identity: `account-${index + 1}@example.test` };
  });
  return { ...snapshot, accounts, history, cycles };
}
