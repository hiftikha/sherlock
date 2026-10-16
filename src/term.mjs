const on = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('38;2;255;90;78'),
  amber: wrap('38;2;255;178;36'),
  ice: wrap('38;2;142;197;255'),
  green: wrap('38;2;155;212;138'),
};

export const SEVERITY = { high: c.red, medium: c.amber, low: c.dim, info: c.dim, ok: c.green };
