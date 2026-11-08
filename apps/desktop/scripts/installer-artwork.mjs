/** Extalia-authored installation artwork. Text comes from the app catalog; identity from the existing brand paths. */
export const INSTALLER_ART = [
  { name: 'dmg-background', width: 900, height: 620, format: 'png' },
  { name: 'dmg-background@2x', width: 1800, height: 1240, format: 'png' },
  { name: 'windows-sidebar', width: 164, height: 314, format: 'bmp' },
  { name: 'windows-header', width: 150, height: 57, format: 'bmp' },
];
const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const text = (x, y, value, size, colour = '#f5f8fc', extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${colour}" ${extra}>${xml(value)}</text>`;
function identity(brand, x, y, height, wordmark = true) {
  return `<g transform="translate(${x} ${y}) scale(${height})"><path d="${xml(brand.symbol)}" fill="url(#brand)"/>${wordmark ? `<g transform="translate(1.8 0)"><path d="${xml(brand.wordmark)}" fill="#f5f8fc" fill-rule="evenodd"/></g>` : ''}</g>`;
}
function network(x, y, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><circle r="142" fill="url(#aura)"/><g fill="none" stroke="#45858b" stroke-width="1.3" opacity=".45"><path d="M-94-64 4-105 102-42 75 63-27 106-105 22Z M-94-64 75 63 4-105-27 106 102-42-105 22Z"/><ellipse rx="116" ry="61" transform="rotate(-34)"/></g>${[[-94,-64,7], [4,-105,5], [102,-42,7], [75,63,8], [-27,106,5], [-105,22,5], [0,0,15]].map(([cx,cy,r]) => `<circle cx="${cx}" cy="${cy}" r="${r * 2}" fill="#5debd6" opacity=".06"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${r === 15 ? '#d8ed56' : '#51d9cc'}"/><circle cx="${cx}" cy="${cy}" r="${Math.max(1.5, r * .25)}" fill="#f0fff9" opacity=".9"/>`).join('')}</g>`;
}
export function installerArtwork(spec, copy, brand, photos = []) {
  const dmg = spec.name.startsWith('dmg');
  const viewWidth = dmg ? 900 : spec.width, viewHeight = dmg ? 620 : spec.height;
  const defs = `<defs><linearGradient id="brand" x1="0" y1="1" x2="0" y2="0">${brand.gradient.map(([offset, colour]) => `<stop offset="${offset}" stop-color="${colour}"/>`).join('')}</linearGradient><linearGradient id="back" x2="1" y2="1"><stop stop-color="#172b36"/><stop offset="1" stop-color="#0b1722"/></linearGradient><radialGradient id="aura"><stop stop-color="#20bba8" stop-opacity=".18"/><stop offset="1" stop-color="#20bba8" stop-opacity="0"/></radialGradient></defs>`;
  let body;
  if (dmg) {
    const photo = photos[0] ? `<defs><radialGradient id="photoFade"><stop offset=".3" stop-color="white"/><stop offset=".55" stop-color="white" stop-opacity=".85"/><stop offset="1" stop-color="white" stop-opacity="0"/></radialGradient><mask id="photoMask"><ellipse cx="655" cy="168" rx="280" ry="170" fill="url(#photoFade)"/></mask><linearGradient id="photoShade"><stop offset="0" stop-color="#172b36"/><stop offset=".32" stop-color="#142832"/><stop offset=".58" stop-color="#10232d" stop-opacity=".4"/><stop offset="1" stop-color="#0b1722" stop-opacity="0"/></linearGradient></defs><g mask="url(#photoMask)" opacity=".8"><svg x="350" y="6" width="550" height="318" viewBox="100 40 840 484" preserveAspectRatio="xMidYMid slice"><image width="1051" height="605" href="${xml(photos[0].data)}"/></svg></g><rect width="900" height="342" fill="url(#photoShade)"/>` : network(705, 168, .9);
    body = `<rect width="900" height="620" fill="#f4f7fb"/><rect width="900" height="342" fill="url(#back)"/>
      ${photo}
      ${identity(brand, 48, 38, 27)}
      ${text(49, 108, copy.eyebrow, 10, '#86aaa9', 'letter-spacing="2.2" font-weight="650"')}
      ${text(46, 165, copy.heroLineOne, 45, '#f5f8fc', 'font-weight="700" letter-spacing="-1.5"')}
      ${text(46, 218, copy.heroLineTwo, 45, '#f5f8fc', 'font-weight="700" letter-spacing="-1.5"')}
      ${text(49, 257, copy.heroDescription, 14, '#b3c5d1')}
      <g stroke="#44616b" fill="none"><path d="M49 292H447"/></g>
      ${text(49, 315, copy.featureAgents, 11, '#8be1d0')}${text(159, 315, copy.featureKnowledge, 11, '#b7c4d2')}${text(325, 315, copy.featureWorkspace, 11, '#b7c4d2')}
      ${text(47, 387, copy.macInstallTitle, 26, '#172c3b', 'font-weight="700" letter-spacing="-.6"')}
      ${text(49, 415, copy.macInstallDescription, 14, '#63798b')}
      <rect x="166" y="444" width="116" height="116" rx="25" fill="#e6edf3"/><rect x="513" y="444" width="116" height="116" rx="25" fill="#e6edf3"/>
      <path d="M322 502H469m-12-10 13 10-13 10" fill="none" stroke="#27a8a2" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      ${text(349, 479, copy.macDragHint, 12, '#3a8d91', 'font-weight="550"')}
      ${text(49, 604, copy.macFooter, 11, '#718596')}`;
  } else if (spec.name === 'windows-sidebar') {
    body = `<rect width="164" height="314" fill="url(#back)"/>${identity(brand, 24, 27, 31, false)}${text(23, 98, copy.brand, 26, '#f5f8fc', 'font-weight="700" letter-spacing="-1"')}${text(24, 119, copy.eyebrow.split(' ').slice(0, 2).join(' '), 8, '#8fc3bd', 'letter-spacing="1.1"')}${text(24, 133, copy.eyebrow.split(' ').slice(2).join(' '), 8, '#8fc3bd', 'letter-spacing="1.1"')}${network(86, 227, .46)}`;
  } else {
    body = `<rect width="150" height="57" fill="#f4f7fb"/><g transform="translate(117 16) scale(25)"><path d="${xml(brand.symbol)}" fill="url(#brand)"/></g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}" viewBox="0 0 ${viewWidth} ${viewHeight}"><title>${xml(copy.macWizardTitle)}</title>${defs}<g font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif">${body}</g></svg>`;
}
