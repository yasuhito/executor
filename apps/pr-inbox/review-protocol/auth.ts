const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const signaturePattern = /^[0-9a-f]{64}$/i;
const maxClockSkewSeconds = 300;

function canonicalRequest(
  timestamp: string,
  nonce: string,
  method: string,
  pathname: string,
  body: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const prefix = new TextEncoder().encode(
    `executor-review-v1\n${timestamp}\n${nonce}\n${method}\n${pathname}\n`,
  );
  const message = new Uint8Array(new ArrayBuffer(prefix.byteLength + body.byteLength));
  message.set(prefix);
  message.set(body, prefix.byteLength);
  return message;
}

function fromHex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signRequest(
  secret: string,
  method: string,
  pathname: string,
  body: Uint8Array,
  timestampSeconds = Math.floor(Date.now() / 1000),
  nonce = crypto.randomUUID(),
): Promise<{ timestamp: string; nonce: string; signature: string }> {
  const timestamp = String(timestampSeconds);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    canonicalRequest(timestamp, nonce, method.toUpperCase(), pathname, body),
  );
  return { timestamp, nonce, signature: toHex(new Uint8Array(signature)) };
}

export async function verifyRequest(
  secret: string | undefined,
  request: Request,
  body: Uint8Array,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const timestamp = request.headers.get("x-executor-timestamp");
  const nonce = request.headers.get("x-executor-nonce");
  const signature = request.headers.get("x-executor-signature");
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    timestamp === null ||
    nonce === null ||
    signature === null ||
    !/^\d{1,12}$/.test(timestamp) ||
    !noncePattern.test(nonce) ||
    !signaturePattern.test(signature)
  )
    return false;

  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > maxClockSkewSeconds
  )
    return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(new TextEncoder().encode(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      fromHex(signature),
      canonicalRequest(
        timestamp,
        nonce,
        request.method.toUpperCase(),
        new URL(request.url).pathname,
        body,
      ),
    );
  } catch {
    return false;
  }
}

export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit) return null;
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
