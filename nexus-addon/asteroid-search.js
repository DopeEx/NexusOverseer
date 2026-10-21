export function asteroidMatches(field, config) {
  const left = field.total ? field.remaining / field.total * 100 : null;
  return (!config.types?.length || config.types.includes(field.type)) &&
    (!config.zones?.length || config.zones.includes(field.zone)) &&
    (config.multMin == null || (field.mult ?? -Infinity) >= config.multMin) &&
    (config.qtyMin == null || (field.remaining ?? -Infinity) >= config.qtyMin) &&
    (config.leftMin == null || (left ?? -Infinity) >= config.leftMin);
}

export function visibleAsteroidFields(fields, config, missionIds) {
  return fields.filter(field =>
    missionIds.has(field.fieldId) || (!field.missing && !field.unconfirmed && asteroidMatches(field, config)));
}

export function reconcileAsteroidRows(parent, rows) {
  const wanted = new Set(rows);
  for (const child of [...parent.children]) {
    if (!wanted.has(child)) child.remove();
  }
  rows.forEach((row, index) => {
    if (parent.children[index] !== row) parent.insertBefore(row, parent.children[index] || null);
  });
}
