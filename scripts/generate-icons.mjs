import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = 'com.willvoorhees.kneeboard-streamdeck.sdPlugin/imgs';
const motifs = {
  'overlay-control': '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M7 9h10M7 12h6"/>',
  'placement-dial': '<circle cx="12" cy="12" r="8"/><path d="M12 12l4-4M12 3v2M3 12h2M19 12h2M12 19v2"/>',
  'placement-reset': '<path d="M5 9a8 8 0 1 1-1 6M5 4v5h5"/><circle cx="12" cy="12" r="2"/>',
  recentre: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
  'view-select': '<rect x="3" y="5" width="13" height="11" rx="1"/><path d="M7 19h13V8M9 10h4"/>',
  'view-visibility': '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  'view-opacity': '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M12 5a7 7 0 0 1 0 14" fill="white" stroke="none"/>',
};
const wrap = (body, size, opts = {}) => {
  const background = opts.background ? '<rect width="24" height="24" rx="4" fill="#122a35" stroke="none"/>' : '';
  const medallion = opts.medallion ? `<circle cx="12" cy="12" r="10" fill="#175e67"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${background}<g transform="translate(0 0)" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none">${medallion}${body}</g></svg>`;
};
async function svgPair(base, size, body, opts = {}) {
  await mkdir(join(root, base.substring(0, base.lastIndexOf('/'))), { recursive: true });
  for (const multiplier of [1, 2]) {
    const file = `${base}${multiplier === 2 ? '@2x' : ''}.svg`;
    await writeFile(join(root, file), wrap(body, size * multiplier, opts));
  }
}
await svgPair('category', 28, motifs['overlay-control']);
for (const [name, body] of Object.entries(motifs)) {
  await svgPair(`actions/${name}/icon`, 20, body);
  await svgPair(`actions/${name}/key`, 72, body, { background: true, medallion: true });
}
const pluginSvg = wrap(motifs['overlay-control'], 256, { background: true, medallion: true });
for (const size of [256, 512]) {
  const output = new Resvg(pluginSvg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  await writeFile(join(root, `plugin${size === 512 ? '@2x' : ''}.png`), output);
}
