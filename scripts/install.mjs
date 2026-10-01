// Browser binaries are always explicit. Installing the package never launches a browser.
import { existsSync } from 'node:fs';
if (!existsSync(new URL('../build/Release/dub.node', import.meta.url))) {
  console.error('Dub: run npm run build:native to compile the native bridge; see README for the fork build.');
}
