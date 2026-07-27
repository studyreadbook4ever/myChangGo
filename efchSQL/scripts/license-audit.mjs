#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const IGNORED_DIRECTORIES = new Set([
  '.artifacts',
  '.git',
  'coverage',
  'node_modules',
]);
const EXECUTABLE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);
const JAVASCRIPT_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);
const TEXT_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
]);
const BUNDLED_ASSET_EXTENSIONS = new Set([
  '.avif',
  '.eot',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.svg',
  '.ttf',
  '.wasm',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
]);
const PACKAGE_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function normalizePath(filePath) {
  return relative(PROJECT_ROOT, filePath).split('\\').join('/');
}

async function walk(directory, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, files);
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

function isLocalSpecifier(specifier) {
  return (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('file:')
  );
}

function extractModuleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /^\s*import\s+(?:[^"'();]+?\s+from\s+)?["']([^"']+)["']/gm,
    /^\s*export\s+[^"']*?\s+from\s+["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function extractUrls(source) {
  return [...source.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]}]+/gi)].map(
    (match) => match[0].replace(/[.,;:]$/, ''),
  );
}

function isLoopbackUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '::1'
    );
  } catch {
    return false;
  }
}

async function auditPackage(errors) {
  const packagePath = resolve(PROJECT_ROOT, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch (error) {
    errors.push(`package.json is missing or invalid: ${error.message}`);
    return;
  }

  for (const field of PACKAGE_FIELDS) {
    const packages = Object.keys(packageJson[field] ?? {});
    if (packages.length > 0) {
      errors.push(`package.json ${field} is not empty: ${packages.join(', ')}`);
    }
  }

  if (packageJson.license !== 'MIT') {
    errors.push('package.json must declare "license": "MIT".');
  }
}

async function auditLicenseFiles(errors) {
  const licensePath = resolve(PROJECT_ROOT, 'LICENSE');
  const noticesPath = resolve(PROJECT_ROOT, 'THIRD_PARTY_NOTICES.md');
  try {
    const license = await readFile(licensePath, 'utf8');
    if (!license.includes('MIT License')) {
      errors.push('LICENSE does not contain the MIT License heading.');
    }
    if (!license.includes('Copyright (c) 2026 studyreadbook4ever')) {
      errors.push('LICENSE does not contain the expected project copyright.');
    }
  } catch (error) {
    errors.push(`LICENSE cannot be read: ${error.message}`);
  }

  try {
    const notices = await readFile(noticesPath, 'utf8');
    if (!notices.includes('no bundled third-party')) {
      errors.push('THIRD_PARTY_NOTICES.md is missing the no-bundling statement.');
    }
  } catch (error) {
    errors.push(`THIRD_PARTY_NOTICES.md cannot be read: ${error.message}`);
  }
}

async function main() {
  const errors = [];
  const documentationReferences = new Set();
  await auditPackage(errors);
  await auditLicenseFiles(errors);

  const files = await walk(PROJECT_ROOT);
  for (const filePath of files) {
    const projectPath = normalizePath(filePath);
    const extension = extname(filePath).toLowerCase();

    if (BUNDLED_ASSET_EXTENSIONS.has(extension)) {
      errors.push(
        `${projectPath}: bundled binary/media/font asset needs explicit provenance`,
      );
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extension)) continue;

    const source = await readFile(filePath, 'utf8');

    if (JAVASCRIPT_EXTENSIONS.has(extension)) {
      for (const specifier of extractModuleSpecifiers(source)) {
        if (!isLocalSpecifier(specifier) && !BUILTINS.has(specifier)) {
          errors.push(
            `${projectPath}: package or remote module import "${specifier}"`,
          );
        }
      }
    }

    const urls = extractUrls(source);
    if (EXECUTABLE_EXTENSIONS.has(extension)) {
      for (const url of urls) {
        if (!isLoopbackUrl(url)) {
          errors.push(`${projectPath}: executable asset contains external URL ${url}`);
        }
      }

      if (
        /\b(?:fetch|WebSocket|EventSource|XMLHttpRequest)\s*\(/.test(source) ||
        /\bnavigator\.sendBeacon\s*\(/.test(source)
      ) {
        errors.push(`${projectPath}: application network API usage detected`);
      }
      if (extension === '.css' && /@import\b/i.test(source)) {
        errors.push(`${projectPath}: CSS @import usage detected`);
      }
      if (
        extension === '.css' &&
        /url\s*\(\s*["']?\s*\/\//i.test(source)
      ) {
        errors.push(`${projectPath}: protocol-relative CSS URL detected`);
      }
      if (
        extension === '.html' &&
        /<(?:iframe|img|link|script|source)\b[^>]+(?:href|src)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(
          source,
        )
      ) {
        errors.push(`${projectPath}: remotely loaded HTML asset detected`);
      }
    } else {
      for (const url of urls) {
        if (!isLoopbackUrl(url)) documentationReferences.add(url);
      }
    }
  }

  if (errors.length > 0) {
    console.error('[license-audit] FAIL');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log('[license-audit] PASS');
  console.log(`  Files checked: ${files.length}`);
  console.log('  Package dependencies: 0');
  console.log('  Bundled third-party assets: 0');
  console.log(`  Documentation-only external references: ${documentationReferences.size}`);
}

main().catch((error) => {
  console.error('[license-audit] FAIL:', error);
  process.exitCode = 1;
});
