const WIDGET_BASE_SIZE = { width: 350, height: 52 };

const clampGridNumber = (value, fallback = 1) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(5, Math.max(1, Math.round(number))) : fallback;
};

const resolveWidgetGrid = (count, layout = '1x1', customRows = 1, customColumns = 1) => {
  const total = Math.max(1, Number(count) || 0);
  const fixedMatch = /^([1-5])x([1-5])$/.exec(String(layout));
  if (fixedMatch) {
    const rows = clampGridNumber(fixedMatch[1]);
    const columns = clampGridNumber(fixedMatch[2]);
    return { rows, columns, pageSize: rows * columns };
  }
  const rowMatch = /^([1-5])xn$/.exec(String(layout));
  if (rowMatch) {
    const rows = clampGridNumber(rowMatch[1]);
    const columns = Number(customColumns) === 1 ? 2 : clampGridNumber(customColumns, 2);
    return { rows, columns, pageSize: rows * columns };
  }
  const columnMatch = /^nx([1-5])$/.exec(String(layout));
  if (columnMatch) {
    const columns = clampGridNumber(columnMatch[1]);
    const rows = Number(customRows) === 1 ? 2 : clampGridNumber(customRows, 2);
    return { rows, columns, pageSize: rows * columns };
  }
  const rows = clampGridNumber(customRows);
  const columns = clampGridNumber(customColumns);
  return { rows, columns, pageSize: rows * columns };
};

const widgetWindowSize = (scale, length = 0.9, accounts = [], layout = '1x1', customRows = 1, customColumns = 1) => {
  const grid = resolveWidgetGrid(accounts.filter((account) => !account.disabled).length, layout, customRows, customColumns);
  return {
    width: Math.round(WIDGET_BASE_SIZE.width * scale * length * grid.columns),
    height: Math.round(WIDGET_BASE_SIZE.height * scale * grid.rows),
  };
};

module.exports = { WIDGET_BASE_SIZE, resolveWidgetGrid, widgetWindowSize };
