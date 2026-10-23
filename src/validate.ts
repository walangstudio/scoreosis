import { ApiError } from './errors.js';

/** Reads a JSON object body, rejecting oversized payloads before parsing. */
export async function readJson(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes)
    throw new ApiError('payload_too_large', `body exceeds ${maxBytes} bytes`);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ApiError('payload_too_large', `body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError('bad_request', 'body must be JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('bad_request', 'body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

export function int(body: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = body[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ApiError('bad_request', `${key} must be an integer in ${min}..${max}`);
  }
  return v;
}

export function optionalInt(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  return body[key] === undefined ? undefined : int(body, key, min, max);
}

export function str(body: Record<string, unknown>, key: string, pattern: RegExp): string {
  const v = body[key];
  if (typeof v !== 'string' || !pattern.test(v))
    throw new ApiError('bad_request', `${key} is invalid`);
  return v;
}

/**
 * A player-chosen public name: 2-16 ASCII letters and digits, words separated by
 * single spaces after trimming. Names starting with "guest" are reserved.
 */
export function displayName(body: Record<string, unknown>): string {
  const extra = Object.keys(body).filter((k) => k !== 'display_name');
  if (extra.length) throw new ApiError('bad_request', `unexpected field ${extra[0]}`);
  const v = body.display_name;
  const name = typeof v === 'string' ? v.replace(/^ +| +$/g, '').replace(/ {2,}/g, ' ') : '';
  if (!/^[A-Za-z0-9]+( [A-Za-z0-9]+)*$/.test(name) || name.length < 2 || name.length > 16) {
    throw new ApiError(
      'bad_request',
      'display_name must be 2-16 letters, digits and single spaces',
    );
  }
  if (/^guest/i.test(name)) throw new ApiError('bad_request', 'display_name is reserved');
  return name;
}

/** Parsed "count:bits,..." input runs. */
export type InputRun = [count: number, bits: number];

export function parseInputs(text: string, maxBits: number, maxTicks: number): InputRun[] {
  if (!/^\d{1,4}:\d{1,5}(,\d{1,4}:\d{1,5})*$/.test(text)) {
    throw new ApiError('bad_request', 'inputs must be "count:bits" runs separated by commas');
  }
  let total = 0;
  const runs = text.split(',').map((pair): InputRun => {
    const [count, bits] = pair.split(':').map(Number) as [number, number];
    if (count < 1 || bits > maxBits) throw new ApiError('bad_request', 'input run out of range');
    total += count;
    return [count, bits];
  });
  if (total > maxTicks)
    throw new ApiError('bad_request', `a chunk may hold at most ${maxTicks} ticks`);
  return runs;
}

export const tickCount = (runs: InputRun[]) => runs.reduce((n, [count]) => n + count, 0);

export const formatInputs = (runs: InputRun[]) => runs.map(([c, b]) => `${c}:${b}`).join(',');

/** Drops the first `ticks` ticks of a run list. */
export function skipTicks(runs: InputRun[], ticks: number): InputRun[] {
  const out: InputRun[] = [];
  let skip = ticks;
  for (const [count, bits] of runs) {
    if (skip >= count) {
      skip -= count;
      continue;
    }
    out.push([count - skip, bits]);
    skip = 0;
  }
  return out;
}
