// holodeck-reader.js — eoreader7's own relation reader, assembled for a browser tab.
// A line-for-line port of eoreader7/native/the-fold/reader-bundle.js: the same organs, the same options,
// the same GFP dispatch with clause-aware adjacency. The only difference is how the received priors
// arrive (fetch instead of fs). Built once; every turn reads its passages through it.
import { makeRelationReader } from './vendor/eoreader7/native/organs/hypergraph.js';
import { tokenize, blankLabelRows } from './vendor/eoreader7/native/organs/source.js';
import { splitSentences } from './vendor/eoreader7/native/adapters/text/spans.js';
import { extractSurfaces, discoverReferents, namesCorefer, diaNorm } from './vendor/eoreader7/native/adapters/text/surfaces.js';
import { resolvePronouns } from './vendor/eoreader7/native/adapters/text/pronouns.js';
import { relationExtractorsFor } from './vendor/eoreader7/native/adapters/text/relations-language.js';
import { classifyWord, dominantClass } from './vendor/eoreader7/native/adapters/text/wordclass.js';
import { createLemmatizer, morphologyFromPrior } from './vendor/eoreader7/native/adapters/text/morphology.js';
import * as P from './vendor/eoreader7/native/adapters/text/priors.js';

const DETERMINERS = new Set([...P.DEFINITE_DETERMINERS, ...P.INDEFINITE_DETERMINERS]);
const here = p => new URL(p, import.meta.url).href;
let _priors = null;
export function loadPriors() {
  if (_priors) return _priors;
  _priors = (async () => {
    const get = async p => { try { const r = await fetch(here(p)); return r.ok ? await r.json() : null; } catch (e) { return null; } };
    const [posPrior, morphRaw] = await Promise.all([get('./vendor/eoreader7/native/priors/pos-eng.json'), get('./vendor/eoreader7/native/priors/morphology-eng.json')]);
    const morph = morphRaw ? morphologyFromPrior(morphRaw) : null;
    const forms = new Set();
    for (const k of Object.keys((morph && morph.forms) || {})) { forms.add(String(k).toLowerCase()); const v = morph.forms[k]; for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string') forms.add(x.toLowerCase()); }
    const lemmatizer = morph ? createLemmatizer(morph.forms, { language: morph.language }) : null;
    return { posPrior, verbForms: forms.size ? forms : null, lemmatizer };
  })();
  return _priors;
}
let _dispatch = null;
const dispatch = () => _dispatch || (_dispatch = relationExtractorsFor({ language: 'eng', roleConfig: null, posPrior: null, classifyWord, dominantClass }));

export async function makeEngineRelationReader(extra = {}) {
  const { posPrior, verbForms, lemmatizer } = await loadPriors();
  return makeRelationReader({
    splitSentences, extractSurfaces, discoverReferents, namesCorefer, diaNorm,
    discoverRelationVocab: (...a) => dispatch().discoverRelationVocab(...a),
    extractRelations: (text, opts = {}) => { const d = dispatch(); return d.extractRelations(text, d.mode === 'gfp' ? { ...opts, clauseAware: true } : opts); },
    extractorsMode: 'dispatch', tokenize, posPriorFor: () => posPrior, verbForms, oovLexicon: verbForms, attestedVerbs: true,
    determiners: DETERMINERS, definiteDeterminers: new Set(P.DEFINITE_DETERMINERS), negationWords: P.NEGATION_WORDS, firstPerson: P.FIRST_PERSON,
    ...(lemmatizer ? { createLemmatizer: () => ({ sameAct: (a, b) => lemmatizer.sameAct(a, b) }), morphologyIndex: {} } : {}),
    blankFurniture: text => blankLabelRows(text, { minRun: 4, maxCell: 60 }),
    resolvePronouns, nounPhraseSubjects: true, phrasalPredicates: true, ...extra,
  });
}
