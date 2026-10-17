import { z } from 'zod';
import { INTENTS } from '../intent/intent.types';
import { AnalysisClaims, Claim, ComparisonClaims, FIXED_RISKS } from './claims';
import {
  PolicyContext,
  PolicyViolation,
  checkTextPolicy,
  describeViolations,
} from './policy/ai-policy';

/** Kept for callers/tests that only need "is this phrase unsafe?" (category-based, see ai-policy). */
export { findForbiddenPhrase } from './policy/ai-policy';

/**
 * What the user reads. Every string in these objects is application-authored (claims.ts, data
 * limitations, labels): the model contributes only the ORDER and SELECTION of ids.
 */
export interface AnalysisOutput {
  summary: string;
  trend: string;
  momentum: string;
  technical_observations: string[];
  risk_factors: string[];
  data_limitations: string[];
}

export interface ComparisonOutput {
  summary: string;
  differences: string[];
  considerations: string[];
  data_limitations: string[];
}

/** How many ids of each list may be used. The first observation/difference becomes the summary line. */
export const MAX_OBSERVATIONS = 5;
/** A selection with fewer observations is completed, in catalogue order, up to this many. */
export const MIN_OBSERVATIONS = 3;
/** Room for every data-derived risk (at most 5 today) plus the two fixed sentences. */
export const MAX_RISKS = 8;
export const MAX_DIFFERENCES = 5;
export const MAX_CONSIDERATIONS = 2;

export const IntentOutputSchema = z.object({
  intent: z.enum(INTENTS),
  symbols: z.array(z.string()).default([]),
  parameters: z.record(z.string(), z.unknown()).default({}),
});

export type IntentOutput = z.infer<typeof IntentOutputSchema>;

/** Extracts the first top-level JSON object from model output (handles code fences / chatter). */
export function extractJson(raw: string): unknown {
  let s = raw.trim();
  s = s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const start = s.indexOf('{');
  if (start < 0) throw new Error('no JSON object found');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object');
}

/**
 * Validation outcome. `kind` separates "the model returned something unusable" (invalid: not JSON,
 * no known ids) from "the application's own rendered text failed the output policy" (unsafe; a
 * defence-in-depth check that should never fire for a correct catalogue).
 */
export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'invalid' | 'unsafe'; error: string; violations?: PolicyViolation[] };

/** Ids the model may use in one field. Accepts "O3", ["O3"], [{"id":"O3"}]; anything else is ignored. */
function pickIds(value: unknown, catalogue: readonly Claim[], max: number): Claim[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const byId = new Map(catalogue.map((c) => [c.id, c]));
  const out: Claim[] = [];
  for (const item of raw) {
    const id =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
          ? (item as { id: string }).id
          : null;
    const claim = id ? byId.get(id.trim().toUpperCase()) : undefined;
    if (claim && !out.includes(claim)) out.push(claim);
    if (out.length >= max) break;
  }
  return out;
}

/** The model's answer as a JSON object; anything that is not one is "invalid". */
type Parsed =
  { ok: true; obj: Record<string, unknown> } | { ok: false; kind: 'invalid'; error: string };

function parseSelection(raw: string): Parsed {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (e) {
    return {
      ok: false,
      kind: 'invalid',
      error: `Output bukan JSON valid (${(e as Error).message}).`,
    };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, kind: 'invalid', error: 'Output bukan objek JSON.' };
  }
  return { ok: true, obj: json as Record<string, unknown> };
}

/** Defence in depth: the rendered, application-authored text must itself pass the output policy. */
function policyGate<T>(value: T, texts: string[], policy?: PolicyContext): Validation<T> {
  const violations = checkTextPolicy(texts, policy);
  if (violations.length > 0) {
    return {
      ok: false,
      kind: 'unsafe',
      error: `Melanggar kebijakan keluaran: ${describeViolations(violations)}`,
      violations,
    };
  }
  return { ok: true, value };
}

/**
 * Turns the model's id selection into the analysis the user will read. Unknown ids, extra fields and
 * any prose are discarded: only catalogue sentences can come out.
 */
export function validateAnalysisSelection(
  raw: string,
  claims: AnalysisClaims,
  limitations: readonly string[] = [],
  policy?: PolicyContext,
): Validation<AnalysisOutput> {
  const parsed = parseSelection(raw);
  if (!parsed.ok) return parsed;
  const picked = pickIds(parsed.obj.observations, claims.observations, MAX_OBSERVATIONS);
  if (picked.length === 0) {
    return { ok: false, kind: 'invalid', error: 'Tidak ada id observasi yang valid.' };
  }
  // The model chooses what to put first, never what to leave out: a thin selection is completed in
  // catalogue order, and every data-derived risk is always shown (framing by selection).
  const observations = [...picked];
  for (const c of claims.observations) {
    if (observations.length >= MIN_OBSERVATIONS) break;
    if (!observations.includes(c)) observations.push(c);
  }
  const risks = pickIds(parsed.obj.risks, claims.risks, MAX_RISKS);
  // Data-derived risks are never dropped, whatever the model picked and however many it picked.
  for (const c of claims.risks) {
    if (!risks.includes(c) && !FIXED_RISKS.includes(c.text)) risks.push(c);
  }
  if (risks.length === 0) {
    const fixed = claims.risks.find((c) => FIXED_RISKS.includes(c.text));
    if (fixed) risks.push(fixed);
  }
  const out: AnalysisOutput = {
    summary: observations[0].text,
    trend: '',
    momentum: '',
    technical_observations: observations.slice(1).map((c) => c.text),
    risk_factors: risks.map((c) => c.text),
    data_limitations: [...limitations],
  };
  return policyGate(
    out,
    [out.summary, ...out.technical_observations, ...out.risk_factors, ...out.data_limitations],
    policy,
  );
}

/** Same for comparisons: ids of rows (differences) and fixed considerations. */
export function validateComparisonSelection(
  raw: string,
  claims: ComparisonClaims,
  policy?: PolicyContext,
): Validation<ComparisonOutput> {
  const parsed = parseSelection(raw);
  if (!parsed.ok) return parsed;
  const differences = pickIds(parsed.obj.differences, claims.differences, MAX_DIFFERENCES);
  if (differences.length === 0) {
    return { ok: false, kind: 'invalid', error: 'Tidak ada id perbedaan yang valid.' };
  }
  const considerations = pickIds(
    parsed.obj.considerations,
    claims.considerations,
    MAX_CONSIDERATIONS,
  );
  const out: ComparisonOutput = {
    summary: differences[0].text,
    differences: differences.slice(1).map((c) => c.text),
    considerations: considerations.map((c) => c.text),
    data_limitations: [],
  };
  return policyGate(out, [out.summary, ...out.differences, ...out.considerations], policy);
}
