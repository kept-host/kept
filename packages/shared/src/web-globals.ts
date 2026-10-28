// @kept/shared — Web Crypto, `TextEncoder` and `URL`, typed narrowly. INTERNAL:
// shared by ./publish (tokens, hashes), ./files (set hashes, path byte length),
// ./profile and ./agent-copy (URL parts); the barrel does not re-export it.
//
// The package compiles with `lib: ["ES2022"]` — deliberately no `DOM` — so these
// globals are present at runtime in both Node ≥18 and Workers but carry no
// ambient typings here. Narrow structural types beat widening the lib.

type WebCryptoLike = {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: {
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  };
};

type TextEncoderCtor = new () => { encode(input: string): Uint8Array };

type UrlCtor = new (input: string) => {
  protocol: string;
  hostname: string;
  username: string;
  password: string;
};

export const webGlobals = globalThis as unknown as {
  crypto: WebCryptoLike;
  TextEncoder: TextEncoderCtor;
  URL: UrlCtor;
};

/** The UTF-8 bytes of a string. */
export function utf8(input: string): Uint8Array {
  return new webGlobals.TextEncoder().encode(input);
}

/** Lowercase hex of a digest. */
export function toHex(buffer: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(buffer)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
