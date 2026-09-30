// Copies the browser build of PeerJS from node_modules into public/vendor/, so
// the site needs no build step and no third-party CDN.
// Run after upgrading the package: npm run vendor
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const modules = new URL('../node_modules/', import.meta.url);
const vendor = new URL('../public/vendor/', import.meta.url);

const files = [
  {
    pkg: 'peerjs',
    from: 'dist/peerjs.min.js',
    to: 'peerjs.min.js',
    banner: (version) => `/*! PeerJS ${version} | MIT License | https://github.com/peers/peerjs */\n`,
  },
];

await mkdir(vendor, { recursive: true });
for (const file of files) {
  const root = new URL(`${file.pkg}/`, modules);
  const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const source = await readFile(new URL(file.from, root), 'utf8');
  // The source map is not copied, so drop the comment that points at it.
  const body = source.replace(/^\/\/# sourceMappingURL=.*$/m, '').trimEnd();
  await writeFile(new URL(file.to, vendor), `${file.banner(version)}${body}\n`);
  console.log(`vendored ${file.pkg}@${version} -> public/vendor/${file.to}`);
}
