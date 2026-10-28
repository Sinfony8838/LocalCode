export function slugify(title, options = {}) {
  const { maxLength = 60, fallback = 'untitled' } = options;
  let slug = String(title).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > maxLength) {
    const cut = slug.slice(0, maxLength + 1);
    const boundary = cut.lastIndexOf('-');
    slug = boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, maxLength);
    slug = slug.replace(/-+$/, '');
  }
  return slug || fallback;
}
