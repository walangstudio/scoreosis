/** One structured log line per event; never pass credentials, headers or IPs. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
