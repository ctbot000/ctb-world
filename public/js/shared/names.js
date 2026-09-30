// Name generation for peoples, settlements and worlds. Each kind of people has
// its own sounds, so a map reads like several cultures rather than one.

const STYLES = {
  plainsfolk: {
    start: ['Al', 'Bran', 'Cal', 'Dar', 'Ed', 'Fal', 'Gal', 'Hal', 'Ir', 'Lan', 'Mer', 'Nor', 'Ol', 'Per', 'Ran', 'Sal', 'Tam', 'Val', 'Wil', 'Cor'],
    mid: ['a', 'e', 'i', 'o', 'an', 'en', 'ar', 'el'],
    town: ['ford', 'ton', 'wick', 'dale', 'mere', 'stead', 'bury', 'field', 'ham', 'brook', 'ley', 'well'],
    folk: ['i', 'ar', 'en', 'ish', 'ari', 'ori'],
  },
  seafarers: {
    start: ['Thal', 'Mar', 'Nav', 'Cor', 'Syr', 'Pel', 'Kai', 'Lun', 'Ond', 'Vey', 'Brin', 'Sal', 'Tid', 'Ael', 'Mer', 'Nes'],
    mid: ['a', 'e', 'i', 'o', 'ae', 'ia', 'ea', 'or'],
    town: ['haven', 'port', 'mouth', 'sund', 'reach', 'wick', 'ness', 'strand', 'cove', 'holm', 'bay', 'quay'],
    folk: ['ari', 'ene', 'ossi', 'ae', 'ians', 'i'],
  },
  highlanders: {
    start: ['Dur', 'Kaz', 'Brom', 'Thor', 'Grim', 'Bar', 'Dun', 'Kor', 'Mor', 'Rok', 'Gor', 'Bal', 'Hald', 'Stor', 'Varn', 'Dwal'],
    mid: ['a', 'i', 'o', 'u', 'ak', 'ur', 'im', 'ag'],
    town: ['heim', 'dal', 'dun', 'grad', 'hold', 'berg', 'karak', 'mund', 'rok', 'gard', 'forge', 'deep'],
    folk: ['im', 'ak', 'un', 'ur', 'ar', 'i'],
  },
  sylvan: {
    start: ['Ael', 'Syl', 'Lith', 'Ith', 'Eil', 'Ny', 'Fae', 'Il', 'Lor', 'Thal', 'Ela', 'Mir', 'Quel', 'Ser', 'Yav', 'Cae'],
    mid: ['a', 'e', 'i', 'ia', 'ae', 'el', 'ith', 'ar'],
    town: ['wen', 'iel', 'ith', 'ara', 'enor', 'lin', 'dell', 'riel', 'lond', 'thas', 'glade', 'ost'],
    folk: ['i', 'ae', 'eth', 'ari', 'ians', 'wyn'],
  },
  nomads: {
    start: ['Zar', 'Kha', 'Suf', 'Tar', 'Qas', 'Rah', 'Mir', 'Jah', 'Sab', 'Dar', 'Ash', 'Bak', 'Yaz', 'Kir', 'Hal', 'Tem'],
    mid: ['a', 'i', 'u', 'al', 'ar', 'ra', 'ha', 'in'],
    town: ['abad', 'sar', 'kand', 'ra', 'esh', 'an', 'ir', 'oum', 'ah', 'ur', 'stan', 'dar'],
    folk: ['i', 'ar', 'un', 'ids', 'ani', 'eshi'],
  },
  frostkin: {
    start: ['Skal', 'Hrim', 'Vor', 'Frey', 'Ulf', 'Sig', 'Tor', 'Bjar', 'Isk', 'Nif', 'Kald', 'Rim', 'Hvit', 'Jot', 'Gel', 'Ask'],
    mid: ['a', 'e', 'i', 'o', 'u', 'ar', 'ir', 'un'],
    town: ['vik', 'heim', 'fjall', 'gard', 'stad', 'ness', 'borg', 'havn', 'mark', 'holt', 'fell', 'rime'],
    folk: ['ings', 'ar', 'ir', 'un', 'i', 'ungar'],
  },
  world: {
    start: ['Aer', 'Eld', 'Mir', 'Tel', 'Val', 'Ost', 'Car', 'Ny', 'Sol', 'Ith', 'Ul', 'Zeph', 'Ar', 'Bel', 'Kor', 'Lun'],
    mid: ['a', 'e', 'i', 'o', 'an', 'or', 'el', 'ith'],
    town: ['dor', 'ia', 'thas', 'os', 'mar', 'heim', 'ion', 'ara', 'esh', 'une', 'wyn', 'ea'],
    folk: [],
  },
};

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

function join(parts) {
  let out = '';
  for (const part of parts) {
    const last = out[out.length - 1];
    const first = part[0];
    // Avoid doubled vowels at a seam ("Kha" + "abad") and triple letters.
    if (last && last === first && VOWELS.has(last)) out += part.slice(1);
    else if (last && out.length > 1 && out[out.length - 2] === last && last === first) out += part.slice(1);
    else out += part;
  }
  return out.charAt(0).toUpperCase() + out.slice(1).toLowerCase();
}

// kind: 'town' | 'folk' | 'world'. `taken` is a Set of lowercase names in use.
export function makeName(rng, style, kind, taken = new Set()) {
  const s = STYLES[style] ?? STYLES.plainsfolk;
  const ends = kind === 'folk' ? s.folk : s.town;
  let name = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    const parts = [rng.pick(s.start)];
    if (rng.chance(kind === 'folk' ? 0.45 : 0.35)) parts.push(rng.pick(s.mid));
    parts.push(rng.pick(ends));
    name = join(parts);
    if (name.length <= 13 && !taken.has(name.toLowerCase())) return name;
  }
  // Out of fresh combinations: number it.
  let n = 2;
  while (taken.has(`${name} ${n}`.toLowerCase())) n++;
  return `${name} ${n}`;
}

export function worldName(rng) {
  return makeName(rng, 'world', 'town');
}
