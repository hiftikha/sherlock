import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

const readJson = (p) => {
  const t = read(p);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

function tomlValue(text, section, key) {
  if (!text) return null;
  const sec = text.indexOf(`[${section}]`);
  if (sec === -1) return null;
  const rest = text.slice(sec + section.length + 2);
  const end = rest.search(/^\[/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  const m = body.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'));
  return m ? m[1] : null;
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function findFirst(dir, re, depth = 2) {
  for (const entry of listDir(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.') || entry === 'target' || entry === 'build') continue;
    const p = join(dir, entry);
    if (re.test(entry)) return p;
    if (depth > 0) {
      try {
        if (statSync(p).isDirectory()) {
          const f = findFirst(p, re, depth - 1);
          if (f) return f;
        }
      } catch {}
    }
  }
  return null;
}

export function detectProject(dir = process.cwd()) {
  const stacks = [];
  const suggestions = [];
  const pkg = readJson(join(dir, 'package.json'));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const scripts = pkg?.scripts ?? {};
  const pm = existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(dir, 'yarn.lock')) ? 'yarn' : existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock')) ? 'bun' : 'npm';
  const runScript = (name) => (pm === 'npm' ? `npm run ${name}` : `${pm} ${name}`);

  const cargoPath = existsSync(join(dir, 'Cargo.toml')) ? join(dir, 'Cargo.toml') : existsSync(join(dir, 'src-tauri/Cargo.toml')) ? join(dir, 'src-tauri/Cargo.toml') : null;
  const cargo = cargoPath ? read(cargoPath) : null;
  const isTauri = !!deps['@tauri-apps/api'] || !!deps['@tauri-apps/cli'] || existsSync(join(dir, 'src-tauri')) || /\btauri\s*=/.test(cargo ?? '');
  const isWasm = /wasm-bindgen|crate-type\s*=\s*\[[^\]]*cdylib/.test(cargo ?? '') && /wasm/.test(cargo ?? '');

  if (isTauri) {
    stacks.push('tauri');
    const name = tomlValue(read(join(dir, 'src-tauri/Cargo.toml')) ?? cargo, 'package', 'name');
    suggestions.push({
      platform: 'native',
      tool: 'sherlock_launch',
      command: name ? `./src-tauri/target/release/${name}` : 'cargo tauri build && ./src-tauri/target/release/<app>',
      build: 'cargo tauri build --no-bundle',
      readyHint: 'Tauri apps print nothing by default. Use CPU settle, or add a println!("READY") after the window is created and pass --ready-log READY.',
      why: 'Tauri app: profile the release binary so the webview and Rust core are both in the process tree.',
    });
  } else if (cargo) {
    const name = tomlValue(cargo, 'package', 'name');
    if (isWasm) {
      stacks.push('rust-wasm');
      suggestions.push({
        platform: 'web',
        tool: 'sherlock_web',
        command: 'serve the built page, then profile its URL',
        build: existsSync(join(dir, 'Trunk.toml')) || existsSync(join(dir, 'index.html')) ? 'trunk serve --release' : 'wasm-pack build --release',
        readyHint: 'Sherlock reports .wasm download and compile time under web.wasm.',
        why: 'Rust compiled to WebAssembly runs in the browser; profile it as a web page.',
      });
    } else {
      stacks.push('rust');
      suggestions.push({
        platform: 'native',
        tool: 'sherlock_launch',
        command: name ? `./target/release/${name}` : 'cargo run --release',
        build: 'cargo build --release',
        readyHint: 'Pass --ready-log with a line your app prints when it is ready, or --ready-port for a server.',
        why: 'Rust binary: profile the release build, not `cargo run`, so compile time is not counted as startup.',
      });
    }
  }

  if (deps.electron) {
    stacks.push('electron');
    suggestions.push({
      platform: 'native',
      tool: 'sherlock_launch',
      command: scripts.start ? runScript('start') : 'npx electron .',
      readyHint: 'Add console.log("READY") in the BrowserWindow ready-to-show handler and pass --ready-log READY.',
      why: 'Electron app: main, renderer and GPU processes are all in the process tree.',
    });
  }

  if (deps['react-native'] || deps.expo) {
    stacks.push(deps.expo ? 'expo' : 'react-native');
    const appJson = readJson(join(dir, 'app.json'));
    const iosId = appJson?.expo?.ios?.bundleIdentifier;
    const androidId = appJson?.expo?.android?.package;
    if (iosId) suggestions.push({ platform: 'ios', tool: 'sherlock_ios', command: iosId, why: 'Expo iOS bundle id from app.json.' });
    if (androidId) suggestions.push({ platform: 'android', tool: 'sherlock_android', command: androidId, why: 'Expo Android package from app.json.' });
  }

  const web = [
    ['next', 3000, 'next'],
    ['vite', 5173, 'vite'],
    ['@remix-run/dev', 3000, 'remix'],
    ['astro', 4321, 'astro'],
    ['@sveltejs/kit', 5173, 'sveltekit'],
    ['nuxt', 3000, 'nuxt'],
    ['react-scripts', 3000, 'create-react-app'],
    ['@angular/core', 4200, 'angular'],
  ].find(([d]) => deps[d]);
  if (web && !deps.electron && !isTauri) {
    const [, port, name] = web;
    stacks.push(name);
    const devScript = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
    suggestions.push({
      platform: 'native',
      tool: 'sherlock_launch',
      command: devScript ? runScript(devScript) : `npx ${name} dev`,
      readyPort: port,
      why: `Dev server startup: time until ${name} accepts connections on :${port}.`,
    });
    suggestions.push({
      platform: 'web',
      tool: 'sherlock_web',
      command: `http://localhost:${port}/`,
      why: 'Page load in headless Chrome: TTFB, FCP, LCP, long tasks, JS heap, request weight.',
    });
  } else if (pkg && !deps.electron && !isTauri && !stacks.length) {
    stacks.push('node');
    const main = pkg.main ?? (existsSync(join(dir, 'index.js')) ? 'index.js' : null);
    suggestions.push({
      platform: 'native',
      tool: 'sherlock_launch',
      command: scripts.start ? runScript('start') : main ? `node ${main}` : 'node .',
      why: 'Node process: startup to first output or ready signal, then live CPU and memory.',
    });
  }

  const xcodeproj = findFirst(dir, /\.xcodeproj$/, 2);
  if (xcodeproj) {
    stacks.push('ios');
    const pbx = read(join(xcodeproj, 'project.pbxproj'));
    const ids = [...(pbx ?? '').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)].map((m) => m[1]).filter((id) => !/Tests?$/.test(id) && !id.includes('$('));
    const id = ids[0];
    suggestions.push({
      platform: 'ios',
      tool: 'sherlock_ios',
      command: id ?? '<bundle id>',
      build: `xcodebuild -project ${basename(xcodeproj)} -scheme <scheme> -sdk iphonesimulator -configuration Release build, then xcrun simctl install booted <App.app>`,
      why: 'iOS app: cold launch in the booted Simulator; the app process is sampled on the Mac.',
    });
  } else if (existsSync(join(dir, 'Package.swift'))) {
    stacks.push('swift');
    suggestions.push({ platform: 'native', tool: 'sherlock_launch', command: 'swift build -c release && .build/release/<product>', why: 'Swift package executable.' });
  }

  const gradle = ['app/build.gradle', 'app/build.gradle.kts', 'android/app/build.gradle', 'android/app/build.gradle.kts'].map((p) => join(dir, p)).find(existsSync);
  if (gradle) {
    stacks.push('android');
    const text = read(gradle);
    const id = text?.match(/applicationId\s*=?\s*["']([^"']+)["']/)?.[1];
    suggestions.push({
      platform: 'android',
      tool: 'sherlock_android',
      command: id ?? '<application id>',
      build: './gradlew installRelease (or installDebug)',
      why: 'Android app: cold start with am start -W, then live CPU and memory over adb.',
    });
  }

  if (existsSync(join(dir, 'go.mod'))) {
    stacks.push('go');
    suggestions.push({ platform: 'native', tool: 'sherlock_launch', command: 'go build -o /tmp/app . && /tmp/app', why: 'Go binary: build first, then profile the binary.' });
  }
  if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'requirements.txt'))) {
    stacks.push('python');
    const entry = ['main.py', 'app.py', 'manage.py'].find((f) => existsSync(join(dir, f)));
    suggestions.push({ platform: 'native', tool: 'sherlock_launch', command: entry ? `python ${entry}${entry === 'manage.py' ? ' runserver' : ''}` : 'python -m <module>', why: 'Python process: import time often dominates startup.' });
  }

  return { dir, name: pkg?.name ?? tomlValue(cargo, 'package', 'name') ?? basename(dir), stacks: [...new Set(stacks)], suggestions };
}
