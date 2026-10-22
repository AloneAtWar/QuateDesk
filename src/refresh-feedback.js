export function accountRefreshFeedback(accounts = [], { allFailed = false } = {}) {
  const active = accounts.filter((account) => !account.disabled);
  const failed = allFailed ? active.length : active.filter((account) => account.status === 'warning').length;
  const succeeded = active.length - failed;
  return {
    id: Date.now(),
    ok: failed === 0 && !allFailed,
    message: allFailed || (failed > 0 && succeeded === 0)
      ? `刷新失败，失败刷新${failed}个账号，请具体查看错误信息。`
      : failed > 0
        ? `刷新部分失败，成功刷新${succeeded}个账号，失败刷新${failed}个账号，请具体查看错误信息。`
        : `刷新成功，共刷新${succeeded}个账号。`,
  };
}
