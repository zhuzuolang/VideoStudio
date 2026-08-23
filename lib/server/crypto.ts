import { encryptionSecret } from "./runtime";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function aesKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(encryptionSecret()));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function encryptApiKey(apiKey: string): Promise<{
  ciphertext: string;
  iv: string;
  hint: string;
}> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(),
    encoder.encode(apiKey),
  );
  return {
    ciphertext: `v1.${toBase64(new Uint8Array(ciphertext))}`,
    iv: toBase64(iv),
    // Never persist the complete value as a display hint, even for an unusually short key.
    hint: apiKey.length > 4 ? apiKey.slice(-4) : "",
  };
}

export async function decryptApiKey(ciphertext: string, iv: string): Promise<string> {
  const [version, payload] = ciphertext.split(".", 2);
  if (version !== "v1" || !payload) throw new Error("Unsupported encrypted API key format");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv).buffer as ArrayBuffer },
    await aesKey(),
    fromBase64(payload).buffer as ArrayBuffer,
  );
  return decoder.decode(plaintext);
}

export function maskedApiKey(hint: unknown): string | null {
  return typeof hint === "string" && hint ? `••••••••${hint}` : null;
}
