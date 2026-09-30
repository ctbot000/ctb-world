// "How to play", built from the rules data so the numbers can never drift from
// what the engine enforces.

import { h } from './dom.js';
import * as R from './shared/rules.js';

const romans = ['I', 'II', 'III'];

function costCell(cost) {
  return cost == null ? '—' : cost === 0 ? 'free' : String(cost);
}

export function helpContent() {
  const deeds = Object.entries(R.ACTIONS).filter(([, def]) => !def.hidden);
  return h(
    'div',
    {},
    h('h2', {}, 'How to play'),
    h(
      'p',
      {},
      'You and your friends are young gods sharing one world. Over three Ages you spend power to shape the land, awaken peoples and raise wonders. ',
      'Between rounds a century passes: peoples grow, found new settlements, trade and go to war on their own. Everything that happens is written into the Chronicle.',
    ),
    h(
      'ul',
      {},
      h('li', {}, 'Create a world and share its code or link. Friends join from their own browsers.'),
      h('li', {}, 'Pick a deed on the left, then click or drag on the map. Drag with Inspect (or the right mouse button) to move; scroll or pinch to zoom.'),
      h('li', {}, 'Each round you get fresh power (unspent power carries over, up to 40). Press End turn when you are done; the round ends when everyone is ready or the timer runs out.'),
      h('li', {}, 'At the end of the third Age the gods are ranked by legacy: the size of their peoples’ settlements, their living peoples, wonders and named places.'),
    ),
    h('h3', {}, 'The three Ages'),
    h(
      'table',
      { className: 'rules-table' },
      h('tr', {}, h('th', {}, 'Age'), h('th', {}, 'Power'), h('th', {}, '')),
      R.AGES.map((age, k) => h('tr', {}, h('td', {}, `${romans[k]} · ${age.short}`), h('td', { className: 'n' }, `+${age.income}`), h('td', {}, age.blurb))),
    ),
    h('p', { className: 'muted' }, 'From Age II your income also grows with your followers (+1 per 6 settlement sizes, up to +4) and with each wonder you hold (+1).'),
    h('h3', {}, 'Deeds'),
    h(
      'table',
      { className: 'rules-table' },
      h('tr', {}, h('th', {}, 'Deed'), h('th', {}, 'I'), h('th', {}, 'II'), h('th', {}, 'III'), h('th', {}, '')),
      deeds.map(([, def]) =>
        h(
          'tr',
          {},
          h('td', {}, `${def.icon} ${def.name}`),
          def.cost.map((c) => h('td', { className: 'n' }, costCell(c))),
          h('td', {}, def.help + (def.perTile ? ' Cost is per tile changed.' : '') + (def.wrath ? ' (Wrath: the host can turn it off.)' : '')),
        ),
      ),
    ),
    h('h3', {}, 'Domains'),
    h(
      'table',
      { className: 'rules-table' },
      Object.values(R.DOMAINS).map((d) => h('tr', {}, h('td', {}, `${d.icon} ${d.name}`), h('td', {}, d.perk))),
    ),
    h('h3', {}, 'Peoples'),
    h('p', { className: 'muted' }, 'A settlement adds up how well its own tile and its six neighbours feed its people (0–3 each), plus rivers, wonders and trade. Rich land lets it grow from hamlet to village, town, city and metropolis.'),
    h(
      'table',
      { className: 'rules-table' },
      Object.values(R.ARCHETYPES).map((a) => {
        const best = a.hab
          .map((v, t) => [v, t])
          .filter(([v]) => v >= 2)
          .sort((x, y) => y[0] - x[0])
          .map(([, t]) => R.TERRAIN[t].name.toLowerCase());
        return h('tr', {}, h('td', {}, `${a.icon} ${a.name}`), h('td', {}, `${a.blurb} Thrive on ${best.join(', ')}.`));
      }),
    ),
    h('h3', {}, 'Wonders'),
    h('p', { className: 'muted' }, 'Each wonder exists once per world. It adds 5 legacy, +1 power per round and helps its settlement grow — and it changes hands if the settlement is captured.'),
    h(
      'table',
      { className: 'rules-table' },
      Object.values(R.WONDERS).map((w) => h('tr', {}, h('td', {}, `${w.icon} ${w.name}`), h('td', {}, w.need))),
    ),
    h('h3', {}, 'Legacy'),
    h(
      'ul',
      {},
      h('li', {}, '+1 for every size step of every settlement your peoples hold (a city counts 4).'),
      h('li', {}, '+3 for every people of yours still alive.'),
      h('li', {}, '+5 for every wonder your peoples hold.'),
      h('li', {}, '+1 for every place you named (up to 8), and for Stars gods +1 per legend (up to 5).'),
    ),
    h('h3', {}, 'Keys'),
    h('p', { className: 'muted' }, 'Esc: back to Inspect · 1–9, 0: pick a deed · [ and ]: brush size · arrows: move · + and −: zoom · Enter: chat'),
  );
}
