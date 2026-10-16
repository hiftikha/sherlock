const on = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('38;2;255;90;78'),
  amber: wrap('38;2;255;178;36'),
  ice: wrap('38;2;142;197;255'),
  green: wrap('38;2;155;212;138'),
  violet: wrap('38;2;180;140;255'),
  grey: wrap('38;2;107;114;123'),
  rgb: (r, g, b) => wrap(`38;2;${r};${g};${b}`),
};

// One colour per interaction segment, shared with the dashboard (ui/app.css).
export const SEGMENT_COLORS = {
  input: [255, 90, 78],
  handlers: [255, 178, 36],
  script: [217, 138, 28],
  render: [180, 140, 255],
  network: [142, 197, 255],
  idle: [58, 65, 75],
  other: [107, 114, 123],
  frame: [155, 212, 138],
};

export function segmentBar(segments, totalMs, width = 48) {
  if (!segments?.length || !totalMs) return '';
  let out = '';
  let used = 0;
  segments.forEach((s, i) => {
    const target = i === segments.length - 1 ? width : Math.round((s.end / totalMs) * width);
    const n = Math.max(0, target - used);
    used += n;
    out += c.rgb(...(SEGMENT_COLORS[s.key] ?? [200, 200, 200]))('█'.repeat(n));
  });
  return out;
}

export const SEVERITY = { high: c.red, medium: c.amber, low: c.dim, info: c.dim, ok: c.green };
