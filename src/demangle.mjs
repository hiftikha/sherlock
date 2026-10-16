export function demangle(symbol) {
  if (!symbol) return symbol;
  const s = symbol.replace(/^_+(?=[RZ])/, '');
  if (s.startsWith('R')) return demangleRustV0(s.slice(1)) ?? symbol;
  if (s.startsWith('ZN')) return demangleLegacy(s.slice(2)) ?? symbol;
  return symbol;
}

function demangleLegacy(s) {
  const parts = [];
  let i = 0;
  while (i < s.length && s[i] !== 'E') {
    const m = s.slice(i).match(/^(\d+)/);
    if (!m) return null;
    const len = Number(m[1]);
    i += m[1].length;
    const ident = s.slice(i, i + len);
    i += len;
    if (/^h[0-9a-f]{16}$/.test(ident)) continue;
    parts.push(
      ident
        .replace(/\$LT\$/g, '<')
        .replace(/\$GT\$/g, '>')
        .replace(/\$u20\$/g, ' ')
        .replace(/\$RF\$/g, '&')
        .replace(/\$C\$/g, ',')
        .replace(/\.\./g, '::'),
    );
  }
  return parts.length ? parts.join('::') : null;
}

function demangleRustV0(s) {
  let i = 0;
  const idents = [];

  const base62 = () => {
    if (s[i] === '_') {
      i++;
      return 0;
    }
    while (i < s.length && s[i] !== '_') i++;
    i++;
    return 1;
  };

  const ident = () => {
    if (s[i] === 's') {
      i++;
      base62();
    }
    const punycode = s[i] === 'u';
    if (punycode) i++;
    const m = s.slice(i).match(/^(\d+)/);
    if (!m) return null;
    i += m[1].length;
    const len = Number(m[1]);
    if (s[i] === '_') i++;
    const name = s.slice(i, i + len);
    i += len;
    return name;
  };

  const path = (depth = 0) => {
    if (depth > 40 || i >= s.length) return false;
    const tag = s[i++];
    if (tag === 'C') {
      const n = ident();
      if (n == null) return false;
      idents.push(n);
      return true;
    }
    if (tag === 'N') {
      i++;
      if (!path(depth + 1)) return false;
      const n = ident();
      if (n == null) return false;
      if (n) idents.push(n);
      return true;
    }
    if (tag === 'B') {
      base62();
      return true;
    }
    if (tag === 'M' || tag === 'X' || tag === 'Y') {
      if (tag !== 'Y') {
        if (s[i] === 's') {
          i++;
          base62();
        }
        if (!path(depth + 1)) return false;
      }
      if ('CNMXYIB'.includes(s[i])) return path(depth + 1);
      return true;
    }
    if (tag === 'I') {
      if (!path(depth + 1)) return false;
      return true;
    }
    return false;
  };

  try {
    path();
  } catch {
    return null;
  }
  if (!idents.length) return null;
  return idents.join('::');
}
