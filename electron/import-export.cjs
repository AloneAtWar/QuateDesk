'use strict';

// Import/export logic deliberately stays independent from Electron.  The main
// process is responsible for reading/writing files and encrypting credentials;
// this module only deals with the JSON-compatible data that crosses that seam.

const EXPORT_FORMAT = 'quotadesk-backup';
const EXPORT_VERSION = 1;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const clone = (value) => {
  if (value === undefined) return undefined;
  // State, history, and credentials are JSON data.  JSON cloning also makes
  // sure callers cannot mutate the object used to construct a package.
  return JSON.parse(JSON.stringify(value));
};

const stableValue = (value, seen = new Set()) => {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key], seen)]));
};

const stableStringify = (value) => JSON.stringify(stableValue(value));

const normalizeIdSet = (value) => {
  if (value instanceof Set) return new Set([...value].map((item) => String(item)));
  if (Array.isArray(value)) return new Set(value.map((item) => String(item)));
  if (isObject(value)) return new Set(Object.keys(value).filter((key) => value[key]));
  return new Set();
};

const optionsObject = (value) => isObject(value)
  && ('builtinProviderIds' in value || 'includeCredentials' in value || 'credentials' in value
    || 'accountSecrets' in value || 'history' in value || 'cycles' in value || 'currentCredentials' in value);

const normalizeBuiltins = (options) => normalizeIdSet(options?.builtinProviderIds || options?.builtinIds);

const accountWithoutSecrets = (account) => {
  if (!isObject(account)) return null;
  const next = { ...clone(account) };
  // Older state versions could have put the primary credential on an account.
  // Secret variables are stored in credentials.json in current versions, but
  // omit the known fields here as a defensive measure for older backups.
  delete next.credential;
  delete next.secret;
  // Official provider usage connections are owned by the main process and
  // are reconstructed from the imported credential, never copied from a
  // renderer state snapshot.
  delete next.usageConnection;
  return next;
};

const publicState = (state, builtinProviderIds) => {
  const source = isObject(state) ? state : {};
  const builtins = normalizeIdSet(builtinProviderIds);
  const accounts = Array.isArray(source.accounts)
    ? source.accounts.map(accountWithoutSecrets).filter((account) => account && typeof account.id === 'string' && account.id)
    : [];
  const providerIds = new Set();
  const providers = Array.isArray(source.providers)
    ? source.providers
      .filter((provider) => {
        if (!isObject(provider) || typeof provider.id !== 'string' || !provider.id || builtins.has(provider.id) || providerIds.has(provider.id)) return false;
        providerIds.add(provider.id);
        return true;
      })
      .map(clone)
    : [];
  const result = { accounts, providers };
  // These are the public state fields used by cleanState.  Do not export the
  // renderer-only runtime snapshot or any future process-local fields.
  result.settings = isObject(source.settings) ? clone(source.settings) : {};
  if (source.lastSync !== undefined) result.lastSync = source.lastSync;
  return result;
};

const looksLikeExportOptions = (value) => optionsObject(value);

// Supported forms:
//   buildExportPackage(state, history, cycles, credentials, options)
//   buildExportPackage(state, history, cycles, options)
//   buildExportPackage(state, { history, cycles, credentials, ...options })
const normalizeExportArgs = (state, history, cycles, credentials, options) => {
  let nextHistory = history;
  let nextCycles = cycles;
  let nextCredentials = credentials;
  let nextOptions = options;

  if (looksLikeExportOptions(history) && cycles === undefined) {
    nextOptions = history;
    nextHistory = history.history || {};
    nextCycles = history.cycles || {};
    nextCredentials = history.credentials || history.accountSecrets;
  } else if (looksLikeExportOptions(credentials) && options === undefined) {
    nextOptions = credentials;
    nextCredentials = credentials.credentials || credentials.accountSecrets;
  }
  nextOptions = isObject(nextOptions) ? nextOptions : {};
  if (nextCredentials === undefined) nextCredentials = nextOptions.credentials || nextOptions.accountSecrets;
  return {
    state,
    history: isObject(nextHistory) ? nextHistory : {},
    cycles: isObject(nextCycles) ? nextCycles : {},
    credentials: isObject(nextCredentials) ? nextCredentials : {},
    options: nextOptions,
  };
};

const cleanHistory = (history) => {
  if (!isObject(history)) return {};
  const result = {};
  for (const [accountId, points] of Object.entries(history)) {
    if (typeof accountId !== 'string' || !accountId || !Array.isArray(points)) continue;
    result[accountId] = points.filter(isObject).map(clone);
  }
  return result;
};

const cleanCycles = (cycles) => {
  if (!isObject(cycles)) return {};
  const result = {};
  for (const [accountId, records] of Object.entries(cycles)) {
    if (typeof accountId !== 'string' || !accountId || !Array.isArray(records)) continue;
    result[accountId] = records.filter(isObject).map(clone);
  }
  return result;
};

const cleanCredentials = (credentials) => {
  if (!isObject(credentials)) return {};
  const result = {};
  for (const [accountId, value] of Object.entries(credentials)) {
    if (!accountId || value === undefined) continue;
    result[accountId] = clone(value);
  }
  return result;
};

const buildExportPackage = (state, history, cycles, credentials, options) => {
  const args = normalizeExportArgs(state, history, cycles, credentials, options);
  const builtins = normalizeBuiltins(args.options);
  const sanitizedState = publicState(args.state, builtins);
  const result = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: args.options.exportedAt || new Date().toISOString(),
    state: sanitizedState,
    history: cleanHistory(args.history),
    cycles: cleanCycles(args.cycles),
  };
  if (args.options.includeCredentials === true) {
    const accountIds = new Set(sanitizedState.accounts.map((account) => account.id));
    result.credentials = Object.fromEntries(Object.entries(cleanCredentials(args.credentials))
      .filter(([accountId]) => accountIds.has(accountId)));
  }
  return result;
};

const validateExportPackage = (value, options = {}) => {
  const errors = [];
  const warnings = [];
  if (!isObject(value)) return { ok: false, valid: false, errors: ['导入包必须是对象'], warnings };
  if (value.format !== EXPORT_FORMAT) errors.push(`不支持的导入包格式: ${String(value.format ?? '')}`);
  if (value.version !== EXPORT_VERSION) errors.push(`不支持的导入包版本: ${String(value.version ?? '')}`);
  if (!isObject(value.state)) errors.push('缺少 state 对象');
  const state = value.state;
  if (isObject(state)) {
    for (const field of ['accounts', 'providers']) {
      if (!Array.isArray(state[field])) errors.push(`state.${field} 必须是数组`);
    }
    if (state.settings !== undefined && !isObject(state.settings)) errors.push('state.settings 必须是对象');
    if (state.accounts && Array.isArray(state.accounts)) {
      state.accounts.forEach((account, index) => {
        if (!isObject(account) || typeof account.id !== 'string' || !account.id) errors.push(`state.accounts[${index}] 缺少有效 id`);
        if (isObject(account) && (typeof account.providerId !== 'string' || !account.providerId)) errors.push(`state.accounts[${index}] 缺少有效 providerId`);
        if (isObject(account) && (account.credential !== undefined || account.secret !== undefined)) warnings.push(`state.accounts[${index}] 含有凭据字段，将被忽略`);
      });
    }
    if (state.providers && Array.isArray(state.providers)) {
      state.providers.forEach((provider, index) => {
        if (!isObject(provider) || typeof provider.id !== 'string' || !provider.id) errors.push(`state.providers[${index}] 缺少有效 id`);
      });
      const builtins = normalizeBuiltins(options);
      for (const provider of state.providers || []) {
        if (isObject(provider) && builtins.has(provider.id)) warnings.push(`内置厂商 ${provider.id} 不应出现在自定义厂商列表中`);
      }
    }
  }
  for (const field of ['history', 'cycles']) {
    if (!isObject(value[field])) errors.push(`${field} 必须是对象`);
    else for (const [accountId, rows] of Object.entries(value[field])) {
      if (!accountId || !Array.isArray(rows)) errors.push(`${field}.${accountId} 必须是数组`);
      else rows.forEach((row, index) => {
        if (!isObject(row)) { errors.push(`${field}.${accountId}[${index}] 必须是对象`); return; }
        if (field === 'history' && (typeof row.at !== 'string' || Number.isNaN(Date.parse(row.at)) || !isObject(row.windows))) errors.push(`${field}.${accountId}[${index}] 格式无效`);
        if (field === 'cycles' && (typeof row.end !== 'string' || Number.isNaN(Date.parse(row.end)) || typeof row.window !== 'string')) errors.push(`${field}.${accountId}[${index}] 格式无效`);
      });
    }
  }
  if (value.credentials !== undefined && !isObject(value.credentials)) errors.push('credentials 必须是对象');
  if (isObject(value.credentials)) {
    for (const [accountId, secret] of Object.entries(value.credentials)) {
      if (!accountId || !isObject(secret) || (secret.variables !== undefined && !isObject(secret.variables)) || (secret.credential !== undefined && typeof secret.credential !== 'string')) {
        errors.push(`credentials.${accountId} 格式无效`);
      }
    }
  }
  if (value.exportedAt !== undefined && (typeof value.exportedAt !== 'string' || Number.isNaN(Date.parse(value.exportedAt)))) warnings.push('exportedAt 不是有效时间');
  const ok = errors.length === 0;
  return { ok, valid: ok, errors, warnings };
};

const assertValidExportPackage = (value, options = {}) => {
  const result = validateExportPackage(value, options);
  if (!result.ok) {
    const error = new Error(result.errors.join('; '));
    error.code = 'INVALID_EXPORT_PACKAGE';
    error.details = result;
    throw error;
  }
  return value;
};

const providerFingerprint = (provider) => {
  if (!isObject(provider)) return '';
  const name = String(provider.name || '').trim().toLowerCase();
  const endpoint = String(provider.requestConfig?.endpoint || '').trim().replace(/\/+$/, '').toLowerCase();
  if (name && endpoint) return `${name}\u0000${endpoint}`;
  if (name) return `name:${name}`;
  const copy = clone(provider);
  delete copy.id;
  delete copy.logo;
  delete copy.monogram;
  delete copy.tone;
  delete copy.legalName;
  return stableStringify(copy);
};

const accountFingerprint = (account, providerId) => {
  if (!isObject(account)) return '';
  const cliFingerprint = typeof account.cliFingerprint === 'string' ? account.cliFingerprint.trim() : '';
  if (cliFingerprint) return `${providerId}\u0000cli\u0000${cliFingerprint}`;
  return '';
};

const validAccountId = (value) => typeof value === 'string' && value.length > 0;

const normalizeImportArgs = (currentState, currentHistory, currentCycles, pkg, currentCredentials, options) => {
  let nextState = currentState;
  let nextHistory = currentHistory;
  let nextCycles = currentCycles;
  let nextPackage = pkg;
  let nextCredentials = currentCredentials;
  let nextOptions = options;

  // Also accept mergeImportPackage(current, package, options), useful to
  // callers that already keep history/cycles inside a single object.
  if (pkg === undefined && isObject(currentHistory) && (currentHistory.format || currentHistory.state)) {
    nextPackage = currentHistory;
    nextHistory = currentState?.history || {};
    nextCycles = currentState?.cycles || {};
    nextState = currentState?.state || currentState;
    nextCredentials = currentState?.credentials || {};
    nextOptions = currentCycles;
  }
  if (optionsObject(nextCredentials) && options === undefined) {
    nextOptions = nextCredentials;
    nextCredentials = nextOptions.currentCredentials || nextOptions.credentials || {};
  }
  if (optionsObject(nextPackage) && nextPackage.options && options === undefined) {
    nextOptions = nextPackage.options;
  }
  nextOptions = isObject(nextOptions) ? nextOptions : {};
  return {
    state: isObject(nextState) ? nextState : {},
    history: isObject(nextHistory) ? nextHistory : {},
    cycles: isObject(nextCycles) ? nextCycles : {},
    pkg: nextPackage,
    credentials: isObject(nextCredentials) ? nextCredentials : {},
    options: nextOptions,
  };
};

const parseTime = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return null;
};

const historyPointKey = (point) => {
  const at = parseTime(point?.at);
  return at === null ? `raw:${stableStringify(point)}` : `at:${new Date(at).toISOString()}`;
};

const cycleKey = (record) => {
  if (!isObject(record)) return '';
  if (record.window !== undefined || record.kind !== undefined || record.end !== undefined) {
    return `cycle:${String(record.window ?? '')}:${String(record.kind ?? '')}:${String(record.end ?? '')}`;
  }
  return `raw:${stableStringify(record)}`;
};

const sortHistory = (points) => points.sort((left, right) => {
  const leftAt = parseTime(left?.at);
  const rightAt = parseTime(right?.at);
  if (leftAt !== null && rightAt !== null && leftAt !== rightAt) return leftAt - rightAt;
  if (leftAt !== null) return -1;
  if (rightAt !== null) return 1;
  return stableStringify(left).localeCompare(stableStringify(right));
});

const sortCycles = (records) => records.sort((left, right) => {
  const leftAt = parseTime(left?.end);
  const rightAt = parseTime(right?.end);
  if (leftAt !== null && rightAt !== null && leftAt !== rightAt) return leftAt - rightAt;
  if (leftAt !== null) return -1;
  if (rightAt !== null) return 1;
  return cycleKey(left).localeCompare(cycleKey(right));
});

const mergeHistory = (existing, imported, accountIdMap, validAccountIds) => {
  const result = {};
  const add = (targetId, points, countAdded) => {
    if (!validAccountIds.has(targetId) || !Array.isArray(points)) return 0;
    if (!result[targetId]) result[targetId] = [];
    const seen = new Set(result[targetId].map(historyPointKey));
    let added = 0;
    for (const point of points) {
      if (!isObject(point)) continue;
      const key = historyPointKey(point);
      if (seen.has(key)) continue;
      seen.add(key);
      result[targetId].push(clone(point));
      if (countAdded) added += 1;
    }
    return added;
  };
  let added = 0;
  for (const [accountId, points] of Object.entries(isObject(existing) ? existing : {})) add(accountId, points, false);
  for (const [accountId, points] of Object.entries(isObject(imported) ? imported : {})) {
    const targetId = accountIdMap[accountId];
    if (targetId) added += add(targetId, points, true);
  }
  for (const points of Object.values(result)) sortHistory(points);
  return { history: result, added };
};

const mergeCycles = (existing, imported, accountIdMap, validAccountIds) => {
  const result = {};
  const add = (targetId, records, countAdded) => {
    if (!validAccountIds.has(targetId) || !Array.isArray(records)) return 0;
    if (!result[targetId]) result[targetId] = [];
    const seen = new Set(result[targetId].map(cycleKey));
    let added = 0;
    for (const record of records) {
      if (!isObject(record)) continue;
      const key = cycleKey(record);
      if (seen.has(key)) continue;
      seen.add(key);
      result[targetId].push(clone(record));
      if (countAdded) added += 1;
    }
    return added;
  };
  let added = 0;
  for (const [accountId, records] of Object.entries(isObject(existing) ? existing : {})) add(accountId, records, false);
  for (const [accountId, records] of Object.entries(isObject(imported) ? imported : {})) {
    const targetId = accountIdMap[accountId];
    if (targetId) added += add(targetId, records, true);
  }
  for (const records of Object.values(result)) sortCycles(records);
  return { cycles: result, added };
};

const mergeImportPackage = (currentState, currentHistory, currentCycles, pkg, currentCredentials, options) => {
  const args = normalizeImportArgs(currentState, currentHistory, currentCycles, pkg, currentCredentials, options);
  const validation = validateExportPackage(args.pkg, args.options);
  if (!validation.ok) {
    const error = new Error(validation.errors.join('; '));
    error.code = 'INVALID_EXPORT_PACKAGE';
    error.details = validation;
    throw error;
  }
  const importedState = args.pkg.state;
  const builtins = normalizeBuiltins(args.options);
  const existingState = args.state;
  const existingProviders = Array.isArray(existingState.providers) ? existingState.providers.map(clone) : [];
  const providers = [...existingProviders];
  const usedProviderIds = new Set(providers.map((provider) => provider?.id).filter(validAccountId));
  const providerIdMap = {};
  let duplicateProviders = 0;
  const providerByFingerprint = new Map();
  for (const provider of providers) {
    if (isObject(provider) && validAccountId(provider.id)) providerByFingerprint.set(providerFingerprint(provider), provider.id);
  }
  const importedProviders = Array.isArray(importedState.providers) ? importedState.providers : [];
  for (const rawProvider of importedProviders) {
    if (!isObject(rawProvider) || !validAccountId(rawProvider.id)) continue;
    const provider = clone(rawProvider);
    const sourceId = provider.id;
    const fingerprint = providerFingerprint(provider);
    const existingSameId = providers.find((entry) => entry?.id === sourceId);
    if (existingSameId) {
      providerIdMap[sourceId] = sourceId;
      duplicateProviders += 1;
      continue;
    }
    const matchingId = providerByFingerprint.get(fingerprint);
    if (matchingId) {
      providerIdMap[sourceId] = matchingId;
      duplicateProviders += 1;
      continue;
    }
    // Built-in IDs are owned by the running application.  A backup should not
    // overwrite them; accounts still point at the built-in ID.
    if (builtins.has(sourceId)) {
      providerIdMap[sourceId] = sourceId;
      duplicateProviders += 1;
      continue;
    }
    providers.push(provider);
    usedProviderIds.add(sourceId);
    providerByFingerprint.set(fingerprint, sourceId);
    providerIdMap[sourceId] = sourceId;
  }

  const existingAccounts = Array.isArray(existingState.accounts) ? existingState.accounts.filter(isObject).map(clone) : [];
  const accounts = [...existingAccounts];
  const usedAccountIds = new Set(accounts.map((account) => account?.id).filter(validAccountId));
  const accountIdMap = {};
  let duplicateAccounts = 0;
  const accountByFingerprint = new Map();
  for (const account of accounts) {
    if (!validAccountId(account?.id)) continue;
    const fingerprint = accountFingerprint(account, account.providerId);
    if (fingerprint) accountByFingerprint.set(fingerprint, account.id);
  }
  const importedAccounts = Array.isArray(importedState.accounts) ? importedState.accounts : [];
  for (const rawAccount of importedAccounts) {
    if (!isObject(rawAccount) || !validAccountId(rawAccount.id)) continue;
    const sourceId = rawAccount.id;
    const providerId = providerIdMap[rawAccount.providerId] || rawAccount.providerId;
    const account = { ...accountWithoutSecrets(rawAccount), providerId };
    const fingerprint = accountFingerprint(account, providerId);
    const existingSameId = accounts.find((entry) => entry.id === sourceId);
    const sameAccount = existingSameId && existingSameId.providerId === providerId
      && String(existingSameId.identity || '').trim() === String(account.identity || '').trim()
      && (account.identity || existingSameId.name === account.name);
    if (sameAccount) {
      accountIdMap[sourceId] = sourceId;
      duplicateAccounts += 1;
      continue;
    }
    const matchingId = fingerprint ? accountByFingerprint.get(fingerprint) : undefined;
    if (matchingId) {
      accountIdMap[sourceId] = matchingId;
      duplicateAccounts += 1;
      continue;
    }
    let targetId = sourceId;
    // A backup from another installation can reuse an ID for a different
    // account. Keep both and redirect imported history to the new ID.
    if (usedAccountIds.has(targetId)) {
      let suffix = 1;
      while (usedAccountIds.has(`${targetId}-imported-${suffix}`)) suffix += 1;
      targetId = `${targetId}-imported-${suffix}`;
    }
    account.id = targetId;
    accounts.push(account);
    usedAccountIds.add(targetId);
    if (fingerprint) accountByFingerprint.set(fingerprint, targetId);
    accountIdMap[sourceId] = targetId;
  }

  const validAccountIds = new Set(accounts.map((account) => account.id).filter(validAccountId));
  const historyResult = mergeHistory(args.history, args.pkg.history, accountIdMap, validAccountIds);
  const cyclesResult = mergeCycles(args.cycles, args.pkg.cycles, accountIdMap, validAccountIds);

  const credentials = cleanCredentials(args.credentials);
  let credentialsAdded = 0;
  if (isObject(args.pkg.credentials)) {
    for (const [sourceId, value] of Object.entries(args.pkg.credentials)) {
      const targetId = accountIdMap[sourceId];
      if (!targetId || Object.prototype.hasOwnProperty.call(credentials, targetId)) continue;
      credentials[targetId] = clone(value);
      credentialsAdded += 1;
    }
  }

  const mergedState = {
    ...clone(existingState),
    accounts,
    providers,
    // Existing settings are authoritative.  A completely empty state can
    // still receive settings/lastSync from a backup.
    settings: isObject(existingState.settings) ? clone(existingState.settings) : clone(importedState.settings || {}),
  };
  if (existingState.lastSync !== undefined) mergedState.lastSync = existingState.lastSync;
  else if (importedState.lastSync !== undefined) mergedState.lastSync = importedState.lastSync;

  const newProviders = providers.length - existingProviders.length;
  const newAccounts = accounts.length - existingAccounts.length;
  return {
    state: mergedState,
    history: historyResult.history,
    cycles: cyclesResult.cycles,
    credentials,
    providerIdMap,
    accountIdMap,
    stats: {
      providers: newProviders,
      accounts: newAccounts,
      history: historyResult.added,
      cycles: cyclesResult.added,
      credentials: credentialsAdded,
      importedProviders: newProviders,
      importedAccounts: newAccounts,
      importedHistory: historyResult.added,
      importedCycles: cyclesResult.added,
      importedCredentials: credentialsAdded,
      duplicateProviders,
      duplicateAccounts,
    },
  };
};

module.exports = {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  buildExportPackage,
  createExportPackage: buildExportPackage,
  validateExportPackage,
  validatePackage: validateExportPackage,
  assertValidExportPackage,
  mergeImportPackage,
  mergeImport: mergeImportPackage,
  // Exported for focused tests and for callers that need to display a preview.
  publicState,
  normalizeIdSet,
};
