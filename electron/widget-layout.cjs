const WIDGET_BASE_SIZE = { width: 350, height: 52 };

const clampGridNumber = (value, fallback = 1) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(5, Math.max(1, Math.round(number))) : fallback;
};

const resolveWidgetGrid = (count, layout = 'nx1', customRows = 1, customColumns = 1, carousel = false) => {
  const total = carousel ? 1 : Math.max(1, Number(count) || 0);
  if (carousel) return { rows: 1, columns: 1 };
  const rowMatch = /^([1-5])xn$/.exec(String(layout));
  if (rowMatch) {
    const rows = Math.min(total, clampGridNumber(rowMatch[1]));
    return { rows, columns: Math.ceil(total / rows) };
  }
  const columnMatch = /^nx([1-5])$/.exec(String(layout));
  if (columnMatch) {
    const columns = Math.min(total, clampGridNumber(columnMatch[1]));
    return { rows: Math.ceil(total / columns), columns };
  }
  const rows = clampGridNumber(customRows);
  const columns = clampGridNumber(customColumns);
  return { rows: Math.max(rows, Math.ceil(total / columns)), columns };
};

const widgetWindowSize = (scale, length = 0.9, accounts = [], layout = 'nx1', customRows = 1, customColumns = 1, carousel = false) => {
  const grid = resolveWidgetGrid(accounts.filter((account) => !account.disabled).length, layout, customRows, customColumns, carousel);
  return {
    width: Math.round(WIDGET_BASE_SIZE.width * scale * length * grid.columns),
    height: Math.round(WIDGET_BASE_SIZE.height * scale * grid.rows),
  };
};

module.exports = { WIDGET_BASE_SIZE, resolveWidgetGrid, widgetWindowSize };
