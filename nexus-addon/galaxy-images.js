const prefixes = { planets: '/api/images/planets/', moons: '/images/moons/' };
const failedImages = new Set();
const starTypes = new Set(['yellow', 'orange', 'red_dwarf', 'blue_giant', 'white_dwarf', 'neutron']);

export function galaxyImagePath(group, body) {
  if (group === 'systems') return starTypes.has(body.starType) ? '/api/images/planets/gas_giant.webp' : null;
  const prefix = prefixes[group];
  if (!prefix) return null;
  const type = group === 'planets' ? body.planetType : body.moonType;
  if (typeof type === 'string' && /^[a-z0-9_]+$/.test(type)) return `${prefix}${type}.webp`;
  if (typeof body.imagePath === 'string' && body.imagePath.startsWith(prefix) &&
      /^[a-z0-9_]+\.webp$/.test(body.imagePath.slice(prefix.length))) return body.imagePath;
  return null;
}

export function appendGalaxyImage(cell, group, body, origin) {
  const path = galaxyImagePath(group, body);
  if (!path || !origin) return;
  const text = cell.textContent;
  cell.textContent = '';
  const content = document.createElement('span');
  content.className = 'finder-body-name';
  const image = document.createElement('img');
  image.className = 'finder-body-image' + (group === 'systems' ? ` finder-star-${body.starType}` : '');
  if (group === 'systems') content.title = `${body.starType.replace(/_/g, ' ')} · Tinted gas giant placeholder`;
  image.width = image.height = 28;
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  const url = new URL(path, origin).href;
  image.addEventListener('error', () => {
    image.hidden = true;
    content.title = 'Image unavailable';
    if (!failedImages.has(url)) {
      failedImages.add(url);
      console.warn(`[NexusOverseer] Galaxy image could not be loaded: ${url}`);
    }
  }, { once: true });
  image.src = url;
  const label = document.createElement('span');
  label.textContent = text;
  content.append(image, label);
  cell.appendChild(content);
}
