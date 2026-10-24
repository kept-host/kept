/**
 * A hand-built zip writer for the file-set reader's hostile fixtures — E08
 * task 003 (`lib/publish/fileset/*.test.ts`).
 *
 * Test-only: nothing in the app imports it, and its name keeps it outside the
 * unit-test glob. `client-zip` builds the well-formed archives; it cannot build
 * the ones that matter here — a deflated run of zeros (a ratio bomb), a symlink
 * (Unix mode in the external attributes), an entry flagged encrypted, a header
 * that lies about its size, a `../` name — so this writes the local headers,
 * central directory and end record byte by byte (APPNOTE 6.3.10 §4.3).
 */
import { crc32, deflateRawSync } from "node:zlib";

export interface FixtureEntry {
  name: string;
  data: Uint8Array | string;
  /** Deflate (method 8) instead of storing (method 0). */
  deflate?: boolean;
  /** Unix mode for the external attributes' high 16 bits, e.g. `0o120777` for a symlink. */
  unixMode?: number;
  /** Set general-purpose bit 0, "encrypted". The data is not actually encrypted. */
  encrypted?: boolean;
  /** Write this uncompressed size into both headers instead of the true one. */
  declaredSize?: number;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION = 20;
const MADE_BY_UNIX = 3 << 8;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;

/** The archive's bytes. */
export function buildZip(entries: readonly FixtureEntry[]): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
    const body = entry.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, "utf8");
    const flags = FLAG_UTF8 | (entry.encrypted ? FLAG_ENCRYPTED : 0);
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(raw);
    const size = entry.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(MADE_BY_UNIX | VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
