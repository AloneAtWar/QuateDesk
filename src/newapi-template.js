// New API 系中转站额度模板（厂商弹窗一键填入）：quota/500000 = 美元
const newApiTemplateScript = `({
  request: {
    url: "{{endpoint}}/api/user/self",
    method: "GET",
    headers: { Authorization: "Bearer {{accessToken}}", "New-Api-User": "{{userId}}" }
  },
  extractor(response) {
    if (!response?.success || !response?.data) throw new Error(response?.message || "New API 站点查询失败");
    const remainingUsd = response.data.quota / 500000;
    const usedUsd = response.data.used_quota / 500000;
    const totalUsd = remainingUsd + usedUsd;
    return { key: "balance", remaining: totalUsd > 0 ? Number(((remainingUsd / totalUsd) * 100).toFixed(2)) : 100, total: 100, unit: "%", amount: Number(remainingUsd.toFixed(2)), limitAmount: Number(totalUsd.toFixed(2)) };
  }
})`;


export { newApiTemplateScript };
