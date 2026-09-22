import esbuild from 'esbuild';
import path from 'path';
import process from 'process';
import builtins from 'builtin-modules';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

// Load .env.local if it exists
if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^=]+)=["']?(.+?)["']?$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const prod = process.argv[2] === 'production';

// Obsidian plugin folder path (set via OBSIDIAN_VAULT env var or .env.local)
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT;
const OBSIDIAN_PLUGIN_PATH = OBSIDIAN_VAULT && existsSync(OBSIDIAN_VAULT)
  ? path.join(OBSIDIAN_VAULT, '.obsidian', 'plugins', 'codexian')
  : null;

// Rewrite node: protocol imports to bare module names for Electron compatibility.
// Obsidian's Electron doesn't support require("node:process") etc.
const nodeProtocolPlugin = {
  name: 'node-protocol-rewrite',
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => {
      return { path: args.path.slice(5), external: true };
    });
  }
};

// Post-build: wrap createRequire calls in try-catch for Electron/bundled context.
// The Codex SDK uses createRequire(import.meta.url) internally to resolve platform
// binaries, which fails in esbuild CJS bundles. This patches it to fall back to require.
const patchCreateRequire = {
  name: 'patch-create-require',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      if (!existsSync('main.js')) return;

      let content = readFileSync('main.js', 'utf-8');
      const original = content;

      // Pattern: var X = (0, Y.createRequire)(Z);
      content = content.replace(
        /var (\w+) = \(0, (\w+)\.createRequire\)\(([^)]+)\);/g,
        'var $1; try { $1 = (0, $2.createRequire)($3); } catch(_e) { $1 = require; }'
      );

      if (content !== original) {
        writeFileSync('main.js', content);
        console.log('Patched createRequire calls for Electron compatibility');
      }
    });
  }
};

// Plugin to copy built files to Obsidian plugin folder
const copyToObsidian = {
  name: 'copy-to-obsidian',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0 || !OBSIDIAN_PLUGIN_PATH) return;

      if (!existsSync(OBSIDIAN_PLUGIN_PATH)) {
        mkdirSync(OBSIDIAN_PLUGIN_PATH, { recursive: true });
      }

      const files = ['main.js', 'manifest.json', 'styles.css'];
      for (const file of files) {
        if (existsSync(file)) {
          copyFileSync(file, path.join(OBSIDIAN_PLUGIN_PATH, file));
          console.log(`Copied ${file} to Obsidian plugin folder`);
        }
      }
    });
  }
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [nodeProtocolPlugin, patchCreateRequire, copyToObsidian],
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  // Shim import.meta.url for CJS — Codex SDK uses createRequire(import.meta.url).
  // Wrapped in try-catch: __filename may not resolve in all Electron contexts.
  banner: {
    js: [
      'var __import_meta_url;',
      'try { __import_meta_url = require("url").pathToFileURL(__filename).href; }',
      'catch(_) { __import_meta_url = "file:///codexian/main.js"; }',
    ].join(' '),
  },
  define: {
    'import.meta.url': '__import_meta_url',
  },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
