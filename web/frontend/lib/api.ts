import { CLIENT_HEADER } from "@prlens/shared";

/** Typed access to the backend. Server components call the backend directly; the browser goes via /api. */
const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:4000";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `request failed (${res.status})`);
  return body as T;
}

/** Server-side GET (server components). */
export async function serverGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(`${BACKEND}${path}`, { cache: "no-store" }));
}

/** Browser-side request through the Next rewrite. Writes carry the header the backend requires. */
export async function clientFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined
      ? { "Content-Type": "application/json", [CLIENT_HEADER]: "1" }
      : { [CLIENT_HEADER]: "1" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  return parse<T>(res);
}
