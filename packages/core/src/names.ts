/**
 * One name generator for every agent in the Office: managed session leads and
 * their subagents get a fictional full name ("first last") that no other agent
 * uses. First names are grouped by an explicit gender tag (used for the avatar
 * look); the gender is metadata chosen here or by the user, never guessed from
 * a name. Surnames are invented, so no combination names a real person.
 */
export type MemberGender = 'female' | 'male';

export const MEMBER_GENDERS: readonly MemberGender[] = ['female', 'male'];

export const FEMALE_FIRST_NAMES: readonly string[] = [
  'Elena', 'Aria', 'Selene', 'Mira', 'Liora', 'Naela', 'Vessa', 'Talia', 'Seren', 'Amara', 'Brielle', 'Calla',
  'Daria', 'Eira', 'Faye', 'Ilse', 'Kira', 'Lyra', 'Maelis', 'Nerys', 'Oriel', 'Petra', 'Quinna', 'Rhea',
  'Saria', 'Tamsin', 'Una', 'Veya', 'Wrenna', 'Xenia', 'Yara', 'Zelie', 'Anouk', 'Briar', 'Cassia', 'Delphine',
  'Esme', 'Fenna', 'Ione', 'Junia', 'Lisette', 'Marisol', 'Noemi', 'Odessa', 'Perrine', 'Rosalind', 'Sabine', 'Thea',
];

export const MALE_FIRST_NAMES: readonly string[] = [
  'Kaelen', 'Orin', 'Darian', 'Bastian', 'Caspian', 'Ezren', 'Falk', 'Gideon', 'Halden', 'Idris', 'Lucan', 'Matthis',
  'Navid', 'Oskar', 'Perrin', 'Quillon', 'Rowan', 'Soren', 'Tobias', 'Ulric', 'Varian', 'Wystan', 'Yorick', 'Zev',
  'Aurel', 'Brannoc', 'Cael', 'Dax', 'Emrys', 'Fintan', 'Garrick', 'Hale', 'Ivo', 'Joren', 'Kian', 'Leif',
  'Marek', 'Nils', 'Osric', 'Pell', 'Rurik', 'Stellan', 'Teodor', 'Anselm', 'Benedek', 'Corwin', 'Desmond', 'Evander',
];

export const FAMILY_NAMES: readonly string[] = [
  'Vael', 'Orrel', 'Kestren', 'Marrowby', 'Ashvale', 'Brightmere', 'Corvane', 'Dunwick', 'Elveth', 'Fairlorn', 'Galvane', 'Ilvar',
  'Kaldor', 'Lunmere', 'Morwen', 'Norvell', 'Oakhurst', 'Pellar', 'Quenby', 'Rothmere', 'Sablewood', 'Tarrow', 'Umbrell', 'Valecrest',
  'Westhollow', 'Yarrowby', 'Zennor', 'Brisvane', 'Draycott', 'Embervale', 'Frostell', 'Greyholm', 'Harrowind', 'Islewyn', 'Juniver', 'Kellbrook',
  'Larkspire', 'Mistravel', 'Orvane', 'Pryndale', 'Ravelle', 'Silvermarsh', 'Thornefield', 'Vantrell', 'Wilderne', 'Aldermoor', 'Caldrith', 'Delvaine',
  'Everholt', 'Fennimore', 'Glenwarde', 'Hollinar', 'Ivorell', 'Kestrafel', 'Lindqvar', 'Moravell', 'Nethercroft', 'Ostrevan', 'Quarrington', 'Stormvale',
];

/** FNV-1a, so the same seed gives the same name on every platform. */
export function nameHash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}

/** A prime larger than any list product: stepping by it visits every first/last pair once. */
const STRIDE = 7919;

/**
 * A full name for `seed` that no name in `taken` uses (case-insensitive).
 * Deterministic: the same seed, taken set and gender give the same result.
 * Without `gender`, the seed picks one. When every pair of a gender is taken,
 * a number is added ("Elena Vael 2").
 */
export function generateFullName(seed: string, taken: ReadonlySet<string>, gender?: MemberGender): { name: string; gender: MemberGender } {
  const used = new Set<string>();
  for (const name of taken) used.add(name.trim().toLowerCase());
  const hash = nameHash(seed);
  const picked: MemberGender = gender ?? (nameHash(`${seed}#gender`) % 2 ? 'female' : 'male');
  const firsts = picked === 'female' ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES;
  const total = firsts.length * FAMILY_NAMES.length;
  for (let round = 1; ; round++) {
    for (let step = 0; step < total; step++) {
      const index = (hash + step * STRIDE) % total;
      const base = `${firsts[index % firsts.length]} ${FAMILY_NAMES[Math.floor(index / firsts.length)]}`;
      const name = round === 1 ? base : `${base} ${round}`;
      if (!used.has(name.toLowerCase())) return { name, gender: picked };
    }
  }
}
