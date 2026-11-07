// Maps a subset's characters to the OpenType script tags (GSUB/GPOS
// ScriptList entries) a shaper could select for them, using the JS engine's
// Unicode Script/Script_Extensions data and HarfBuzz's
// hb_ot_all_tags_from_script (hb-ot-tag.cc) tag mapping. Every uncertainty
// resolves toward keeping scripts.

// Unicode Script property values (ISO 15924 codes) known to V8/ICU as of
// Unicode 17, excluding the non-specific Zyyy (Common), Zinh (Inherited) and
// Zzzz (Unknown) and the aliases Qaac, Qaai and Miao (= Plrd).
const UNICODE_SCRIPTS = [
  'Adlm', 'Aghb', 'Ahom', 'Arab', 'Armi', 'Armn', 'Avst', 'Bali', 'Bamu',
  'Bass', 'Batk', 'Beng', 'Berf', 'Bhks', 'Bopo', 'Brah', 'Brai', 'Bugi',
  'Buhd', 'Cakm', 'Cans', 'Cari', 'Cham', 'Cher', 'Chrs', 'Copt', 'Cpmn',
  'Cprt', 'Cyrl', 'Deva', 'Diak', 'Dogr', 'Dsrt', 'Dupl', 'Egyp', 'Elba',
  'Elym', 'Ethi', 'Gara', 'Geor', 'Glag', 'Gong', 'Gonm', 'Goth', 'Gran',
  'Grek', 'Gujr', 'Gukh', 'Guru', 'Hang', 'Hani', 'Hano', 'Hatr', 'Hebr',
  'Hira', 'Hluw', 'Hmng', 'Hmnp', 'Hung', 'Ital', 'Java', 'Kali', 'Kana',
  'Kawi', 'Khar', 'Khmr', 'Khoj', 'Kits', 'Knda', 'Krai', 'Kthi', 'Lana',
  'Laoo', 'Latn', 'Lepc', 'Limb', 'Lina', 'Linb', 'Lisu', 'Lyci', 'Lydi',
  'Mahj', 'Maka', 'Mand', 'Mani', 'Marc', 'Medf', 'Mend', 'Merc', 'Mero',
  'Mlym', 'Modi', 'Mong', 'Mroo', 'Mtei', 'Mult', 'Mymr', 'Nagm',
  'Nand', 'Narb', 'Nbat', 'Newa', 'Nkoo', 'Nshu', 'Ogam', 'Olck', 'Onao',
  'Orkh', 'Orya', 'Osge', 'Osma', 'Ougr', 'Palm', 'Pauc', 'Perm', 'Phag',
  'Phli', 'Phlp', 'Phnx', 'Plrd', 'Prti', 'Rjng', 'Rohg', 'Runr', 'Samr',
  'Sarb', 'Saur', 'Sgnw', 'Shaw', 'Shrd', 'Sidd', 'Sidt', 'Sind', 'Sinh',
  'Sogd', 'Sogo', 'Sora', 'Soyo', 'Sund', 'Sunu', 'Sylo', 'Syrc', 'Tagb',
  'Takr', 'Tale', 'Talu', 'Taml', 'Tang', 'Tavt', 'Tayo', 'Telu', 'Tfng',
  'Tglg', 'Thaa', 'Thai', 'Tibt', 'Tirh', 'Tnsa', 'Todr', 'Tols', 'Toto',
  'Tutg', 'Ugar', 'Vaii', 'Vith', 'Wara', 'Wcho', 'Xpeo', 'Xsux', 'Yezi',
  'Yiii', 'Zanb',
]; // prettier-ignore

// hb_ot_new_tag_from_script: scripts with an Indic v2 shaping tag. HarfBuzz
// also tries the v3 tag (`dev3`, …) for all of these except Myanmar.
const NEW_TAGS: Record<string, string> = {
  Beng: 'bng2',
  Deva: 'dev2',
  Gujr: 'gjr2',
  Guru: 'gur2',
  Knda: 'knd2',
  Mlym: 'mlm2',
  Mymr: 'mym2',
  Orya: 'ory2',
  Taml: 'tml2',
  Telu: 'tel2',
};

// hb_ot_old_tag_from_script exceptions; every other script's old tag is its
// ISO 15924 code with a lowercase first letter. 'jamo' is the OpenType tag
// for Hangul Jamo, which some Korean fonts register alongside 'hang'.
const OLD_TAGS: Record<string, string[]> = {
  Hang: ['hang', 'jamo'],
  Hira: ['kana'],
  Laoo: ['lao '],
  Nkoo: ['nko '],
  Vaii: ['vai '],
  Yiii: ['yi  '],
};

// HarfBuzz falls back to DFLT, dflt and latn when none of a run's script tags
// exist in the font (hb_ot_layout_table_select_script). Math layout selects
// 'math' (e.g. ssty in MathML scripts) whatever the characters' Script.
const ALWAYS_KEPT = ['DFLT', 'dflt', 'latn', 'math'];

// ISO 15924 codes that Intl.Locale#maximize reports for zh, ja and ko, which
// name combinations of the scripts above.
const COMBINED_SCRIPTS: Record<string, string[]> = {
  Hanb: ['Hani', 'Bopo'],
  Hans: ['Hani'],
  Hant: ['Hani'],
  Jpan: ['Hani', 'Hira', 'Kana'],
  Kore: ['Hang', 'Hani'],
};

export function _otTagsForScript(script: string): string[] {
  const tags: string[] = [];
  const newTag = NEW_TAGS[script];
  if (newTag) {
    if (newTag !== 'mym2') tags.push(`${newTag.slice(0, 3)}3`);
    tags.push(newTag);
  }
  tags.push(...(OLD_TAGS[script] ?? [script.toLowerCase()]));
  return tags;
}

interface ScriptMatcher {
  script: string;
  sc: RegExp;
  scx: RegExp;
}

interface Matchers {
  scripts: ScriptMatcher[];
  // A character outside every known script: either an assigned script the
  // table lacks, or a codepoint this runtime's Unicode data leaves unassigned
  // (on Node 18, every Unicode 16+ script). Private-use characters are fine.
  unknownScript: RegExp;
  commonOrInherited: RegExp;
}

let _matchers: Matchers | undefined;

function compileMatchers(): Matchers {
  if (_matchers) return _matchers;
  const scripts: ScriptMatcher[] = [];
  for (const script of UNICODE_SCRIPTS) {
    try {
      scripts.push({
        script,
        sc: new RegExp(`\\p{sc=${script}}`, 'u'),
        scx: new RegExp(`\\p{scx=${script}}`, 'u'),
      });
    } catch (err) {
      // This runtime's ICU predates the script; its characters are
      // unassigned here and trip unknownScript instead.
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  const known = scripts.map(({ script }) => `\\p{sc=${script}}`).join('');
  _matchers = {
    scripts,
    unknownScript: new RegExp(
      `[^${known}\\p{sc=Zyyy}\\p{sc=Zinh}\\p{Co}]`,
      'u'
    ),
    commonOrInherited: /[\p{sc=Zyyy}\p{sc=Zinh}]/gu,
  };
  return _matchers;
}

function scriptsIn(text: string, { scripts }: Matchers): Set<string> {
  return new Set(
    scripts.filter(({ sc }) => sc.test(text)).map((m) => m.script)
  );
}

// Scripts a Common/Inherited character could be shaped under although none
// of them is present. Script_Extensions lists the scripts a character such
// as U+0964 DEVANAGARI DANDA is used with; when one of them is present
// (U+0301 COMBINING ACUTE beside Latin) the character's run is covered.
function extensionScriptsToKeep(
  text: string,
  { scripts, commonOrInherited }: Matchers,
  present: Set<string>
): string[] {
  const added: string[] = [];
  for (const ch of new Set(text.match(commonOrInherited))) {
    const extensions = scripts.filter(({ scx }) => scx.test(ch));
    if (extensions.some(({ script }) => present.has(script))) continue;
    for (const { script } of extensions) added.push(script);
  }
  return added;
}

// The scripts the `lang` values imply, which browsers use for runs of
// Common characters; undefined when a value names no script this table has.
function scriptsOfLangs(
  langs: readonly string[],
  { scripts }: Matchers
): string[] | undefined {
  const known = new Set(scripts.map(({ script }) => script));
  const result: string[] = [];
  for (const lang of langs) {
    if (lang === '') continue;
    let script: string | undefined;
    try {
      script = new Intl.Locale(lang).maximize().script;
    } catch (err) {
      if (err instanceof RangeError) return undefined;
      throw err;
    }
    const implied = script && (COMBINED_SCRIPTS[script] ?? [script]);
    if (!implied || !implied.every((s) => known.has(s))) return undefined;
    result.push(...implied);
  }
  return result;
}

export interface ScriptContext {
  // All text that can share a paragraph with the subset's characters.
  text: string;
  // Every `lang`/`xml:lang` value on the pages using the font.
  langs: readonly string[];
}

// Returns the OpenType script tags to keep for a subset covering `text`, or
// undefined when every script record must be retained: when `text` has no
// script-specific characters, or the text or context has a character or
// `lang` of an unknown script. The page context counts because browsers
// resolve a digit or punctuation run's script from its paragraph and `lang`.
export function otScriptTagsForText(
  text: string,
  context: ScriptContext
): string[] | undefined {
  const matchers = compileMatchers();
  if (matchers.unknownScript.test(text + context.text)) return undefined;
  const present = scriptsIn(text, matchers);
  if (present.size === 0) return undefined;
  const langScripts = scriptsOfLangs(context.langs, matchers);
  if (!langScripts) return undefined;
  for (const script of langScripts) present.add(script);
  for (const script of scriptsIn(context.text, matchers)) present.add(script);
  for (const script of extensionScriptsToKeep(text, matchers, present)) {
    present.add(script);
  }
  const tags = new Set(ALWAYS_KEPT);
  for (const script of present) {
    for (const tag of _otTagsForScript(script)) tags.add(tag);
  }
  return [...tags].sort();
}
