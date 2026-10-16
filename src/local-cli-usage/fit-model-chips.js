// 保留完整标签；有溢出时预留末尾省略号和间距。
export function fitModelChips(widths, availableWidth, gap, moreWidth) {
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
  if (total <= availableWidth) return widths.length;
  let used = 0;
  let count = 0;
  for (const width of widths) {
    const next = used + (count ? gap : 0) + width;
    if (next + gap + moreWidth > availableWidth) break;
    used = next;
    count += 1;
  }
  return count;
}
