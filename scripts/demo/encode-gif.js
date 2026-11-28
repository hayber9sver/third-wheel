// Encodes record-demo.js frames into a GIF. The two encoders are not project dependencies:
// install them once into a folder of your choice and pass it as <helpersDir>:
//   npm install --prefix <helpersDir> pngjs@7.0.0 gifenc@1.0.3
//   node scripts/demo/encode-gif.js <framesDir> docs/images/demo.gif <helpersDir>
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, out, gifMods] = process.argv.slice(2);
const req = createRequire(join(gifMods, 'package.json'));
const { PNG } = req('pngjs');
const { GIFEncoder, quantize, applyPalette } = req('gifenc');
const frames = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'));
const gif = GIFEncoder();
for (const f of frames) {
  const png = PNG.sync.read(readFileSync(f.file));
  const palette = quantize(png.data, 256);
  gif.writeFrame(applyPalette(png.data, palette), png.width, png.height, {
    palette,
    delay: f.delay,
  });
}
gif.finish();
writeFileSync(out, gif.bytes());
console.log(out, (gif.bytes().length / 1e6).toFixed(2), 'MB');
