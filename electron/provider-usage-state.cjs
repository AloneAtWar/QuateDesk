const mergeMainOwnedUsageConnections = (incoming, current) => {
  const currentAccounts = new Map((current?.accounts || []).map((account) => [account.id, account]));
  return {
    ...incoming,
    accounts: (incoming?.accounts || []).map((account) => {
      const { usageConnection: _staleUsageConnection, ...rendererAccount } = account;
      const currentAccount = currentAccounts.get(account.id);
      return currentAccount && Object.prototype.hasOwnProperty.call(currentAccount, 'usageConnection')
        ? { ...rendererAccount, usageConnection: currentAccount.usageConnection }
        : rendererAccount;
    }),
  };
};

module.exports = { mergeMainOwnedUsageConnections };
