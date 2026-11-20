/** Reads `<prefix><KEY>` for each key, so a source sees only its own credentials. */
export function credentials(
  env: Record<string, string | undefined>,
  prefix: string,
  keys: string[],
): string[] {
  const missing = keys.filter((k) => !env[`${prefix}${k}`]);
  if (missing.length)
    throw new Error(`set ${missing.map((k) => prefix + k).join(" and ")} in .env.local`);
  return keys.map((k) => env[`${prefix}${k}`]!);
}

/** JSON request with a timeout. A non-2xx response throws with its status and a body excerpt. */
export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = await res.text();
  if (!res.ok) {
    const path = new URL(url).pathname;
    throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return JSON.parse(body) as T;
}
