export function parseAmStart(text) {
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const num = (key) => {
    const v = get(key);
    return v == null ? null : Number(v);
  };
  const error = text.match(/^Error[^:]*:\s*(.+)$/m);
  return {
    status: get('Status'),
    launchState: get('LaunchState'),
    activity: get('Activity'),
    totalTimeMs: num('TotalTime'),
    waitTimeMs: num('WaitTime'),
    thisTimeMs: num('ThisTime'),
    error: error ? error[1].trim() : null,
  };
}

export function parseDumpsysMeminfo(text) {
  const pick = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) * 1024 : null;
  };
  return {
    totalPssBytes: pick(/TOTAL PSS:\s+(\d+)/) ?? pick(/^\s*TOTAL\s+(\d+)/m),
    totalRssBytes: pick(/TOTAL RSS:\s+(\d+)/),
    javaHeapBytes: pick(/Java Heap:\s+(\d+)/),
    nativeHeapBytes: pick(/Native Heap:\s+(\d+)/),
    graphicsBytes: pick(/Graphics:\s+(\d+)/),
    codeBytes: pick(/^\s*Code:\s+(\d+)/m),
  };
}

export function parseResolveActivity(text) {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last && last.includes('/') ? last : null;
}

export function parsePidof(text) {
  const m = text.trim().match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

export function parseSimctlLaunch(text) {
  const m = text.trim().match(/^(\S+):\s*(\d+)\s*$/m);
  return m ? { bundleId: m[1], pid: Number(m[2]) } : null;
}

export function parseBootedDevices(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const out = [];
  for (const [runtime, devices] of Object.entries(data.devices ?? {})) {
    for (const d of devices) {
      if (d.state === 'Booted') out.push({ udid: d.udid, name: d.name, runtime: runtime.replace(/^.*SimRuntime\./, '') });
    }
  }
  return out;
}
