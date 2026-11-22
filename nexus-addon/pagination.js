import { getSetting } from './settings.js';

export function paginate(rows, page = 0) {
  const size = getSetting('general.tablePageSize');
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.max(0, Math.min(page, pages - 1));
  return { rows: rows.slice(current * size, (current + 1) * size), page: current, pages, total: rows.length };
}

export function updatePagination(result, { count, controls, previous, next, page }, countText) {
  count.textContent = countText;
  controls.hidden = result.pages <= 1;
  previous.disabled = result.page === 0;
  next.disabled = result.page >= result.pages - 1;
  page.textContent = `Page ${result.page + 1} / ${result.pages}`;
}

export function createPaginationFooter(result, countText, onChange) {
  const footer = document.createElement('div');
  footer.className = 'table-footer';
  const count = document.createElement('span');
  count.className = 'dashboard-list-count';
  const controls = document.createElement('div');
  controls.className = 'table-pagination';
  const previous = document.createElement('button');
  const page = document.createElement('span');
  const next = document.createElement('button');
  previous.type = next.type = 'button';
  previous.className = next.className = 'toolbar-button secondary-button';
  page.className = 'dashboard-list-count';
  previous.textContent = 'Previous';
  next.textContent = 'Next';
  previous.addEventListener('click', () => onChange(result.page - 1));
  next.addEventListener('click', () => onChange(result.page + 1));
  controls.append(previous, page, next);
  footer.append(count, controls);
  updatePagination(result, { count, controls, previous, next, page }, countText);
  return footer;
}
