/**
 * `readFileSet` — any publish or replace body → one `FileSet`, or the
 * `PublishFailure` that refuses it, before any store is touched (E08 D3).
 *
 * Seven forms, recognised as PRD §5.2 lists them:
 *
 * | form                    | recognised by                                   |
 * |-------------------------|-------------------------------------------------|
 * | legacy JSON             | `application/json` with `html`                  |
 * | legacy raw              | `text/html`                                     |
 * | legacy multipart        | a multipart `html` part (file or string)        |
 * | multipart file list     | `files` parts; each filename is a relative path |
 * | multipart zip           | one `archive` part named `*.zip`                |
 * | JSON file list          | `application/json` with `files`                 |
 * | presigned upload        | `application/json` with `upload_id`             |
 *
 * The three legacy forms keep their exact semantics (empty → `empty_page`, an
 * HTML string over `MAX_PAGE_BYTES` → `page_too_large`) and become
 * `{ "index.html": utf8(html) }`, so their hash is still `hashContent(html)`.
 * `spa` rides along in every form (multipart: the field `"true"`).
 *
 * Then the pure stages, in PRD §5.3's order: `normalise` (D7) → `checkSet`
 * (caps, D8, D9) → `hashSet` (D10).
 *
 * THE SIZE GATE COMES FIRST (D4, Q-new-2). `formData()`, `json()` and the zip
 * reader all buffer, so nothing parses until the body is known to be at most
 * `INLINE_BODY_MAX_BYTES` on the wire: a larger `Content-Length` is refused
 * unread, and a body without one is counted as it streams and dropped at the
 * cap. The bounded copy is what every parser reads.
 *
 * THE PRESIGNED LEG (D5, task 009) reads `uploads/{uploaderId}/{id}.zip` —
 * only under the caller's own prefix (Q-new-3) — from R2 through the same
 * spool and zip reader as the `archive` part, counting bytes against the plan's
 * upload ceiling. The set carries the object's key so the studio route can
 * delete it once the publish lands.
 */
import {
  INLINE_BODY_MAX_BYTES,
  SITE_INDEX,
  filesPublishRequestSchema,
  htmlPublishRequestSchema,
  uploadPublishRequestSchema,
  type FilesPublishRequest,
  type Plan,
} from "@kept/shared";

import {
  HTML_TYPE,
  JSON_TYPE,
  MULTIPART_TYPE,
  UnreadableBodyError,
  contentTypeOf,
  optionalField,
  readJson,
  unsupportedContentType,
} from "../http";
import { fail, requestError, type PublishFailure } from "../pipeline";
import { r2Store } from "../../storage/r2";
import { uploadMaxBytes, uploadObjectKey } from "../../uploads/upload";
import { checkSet, extensionOf, siteFileType } from "./checks";
import { inlineTooLarge, printablePath, uploadNotFound, uploadTooLarge } from "./copy";
import { hashSet } from "./hash";
import { normalise } from "./normalise";
import { isFailure, type FileSet, type FileSetCaller, type RawFile } from "./types";
import { readZipStream } from "./zip";

/** What an input delivered, before D7. */
interface RawInput {
  files: RawFile[];
  spa: boolean;
  turnstileToken?: string;
  reminderEmail?: string;
  uploadKey?: string;
}

/** The options every non-legacy form validates the same way the JSON envelope does. */
const optionsSchema = filesPublishRequestSchema.pick({ turnstileToken: true, reminderEmail: true });

/** Strict base64: whole quads, padding only at the end. `Buffer.from` alone accepts garbage. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalidRequest(message: string): PublishFailure {
  return fail(400, { error: "invalid_request", message });
}

export async function readFileSet(
  request: Request,
  caller: FileSetCaller,
): Promise<FileSet | PublishFailure> {
  let input: RawInput | PublishFailure;
  try {
    input = await readInput(request, caller);
  } catch (error) {
    if (error instanceof UnreadableBodyError) return invalidRequest(error.message);
    throw error;
  }
  if (isFailure(input)) return input;

  const normalised = normalise(input.files);
  if (isFailure(normalised)) return normalised;

  const checked = checkSet(normalised.files, caller.plan);
  if (isFailure(checked)) return checked;

  const { entries, contentHash } = await hashSet(checked);
  return {
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes.length, 0),
    contentHash,
    spa: input.spa,
    has404: normalised.has404,
    ignored: normalised.ignored,
    turnstileToken: input.turnstileToken,
    reminderEmail: input.reminderEmail,
    uploadKey: input.uploadKey,
  };
}

async function readInput(request: Request, caller: FileSetCaller): Promise<RawInput | PublishFailure> {
  const body = await readBounded(request, INLINE_BODY_MAX_BYTES);
  if (body === null) {
    return fail(413, { error: "site_too_large", message: inlineTooLarge(INLINE_BODY_MAX_BYTES) });
  }
  const contentType = contentTypeOf(request);
  // A Response over the bounded copy, carrying the original header so the
  // multipart boundary survives.
  const copy = new Response(body, {
    headers: { "content-type": request.headers.get("content-type") ?? "" },
  });

  if (contentType === JSON_TYPE) return readJsonInput(await readJson(copy), caller);
  if (contentType === MULTIPART_TYPE) return readMultipartInput(copy, caller.plan);
  if (contentType === HTML_TYPE) return legacy({ html: await copy.text() }, false);
  throw unsupportedContentType(contentType);
}

/**
 * The body, at most `max` bytes: `null` when `Content-Length` says more (the
 * body is cancelled unread) or when the stream passes `max` (cancelled there).
 */
async function readBounded(
  request: Request,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > max) {
    await request.body?.cancel();
    return null;
  }
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    throw new UnreadableBodyError("The request body could not be read.");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** A legacy single-HTML body, validated exactly as before E08. */
function legacy(raw: unknown, spa: boolean): RawInput | PublishFailure {
  const parsed = htmlPublishRequestSchema.safeParse(raw);
  if (!parsed.success) return requestError(parsed.error);
  return {
    files: [{ path: SITE_INDEX, bytes: new TextEncoder().encode(parsed.data.html) }],
    spa,
    turnstileToken: parsed.data.turnstileToken,
    reminderEmail: parsed.data.reminderEmail,
  };
}

async function readJsonInput(raw: unknown, caller: FileSetCaller): Promise<RawInput | PublishFailure> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return legacy(raw, false);
  const body = raw as Record<string, unknown>;
  const forms = ["html", "files", "upload_id"].filter((key) => body[key] !== undefined);
  if (forms.length > 1) {
    return invalidRequest("Send exactly one of `html`, `files` or `upload_id`.");
  }

  if (forms[0] === "files") {
    const parsed = filesPublishRequestSchema.safeParse(body);
    if (!parsed.success) return requestError(parsed.error);
    const files = decodeJsonFiles(parsed.data.files);
    if (isFailure(files)) return files;
    return {
      files,
      spa: parsed.data.spa ?? false,
      turnstileToken: parsed.data.turnstileToken,
      reminderEmail: parsed.data.reminderEmail,
    };
  }

  if (forms[0] === "upload_id") {
    const parsed = uploadPublishRequestSchema.safeParse(body);
    if (!parsed.success) return requestError(parsed.error);
    // D5: anonymous and keyless callers (`caller.uploaderId === null`) never
    // have an upload — the same refusal as an ID that names nothing.
    if (caller.uploaderId === null) return uploadNotFoundFailure();
    const uploadKey = uploadObjectKey(caller.uploaderId, parsed.data.upload_id);
    const files = await readUpload(uploadKey, caller.plan);
    if (isFailure(files)) return files;
    return {
      files,
      spa: parsed.data.spa ?? false,
      turnstileToken: parsed.data.turnstileToken,
      reminderEmail: parsed.data.reminderEmail,
      uploadKey,
    };
  }

  return legacy(body, body.spa === true);
}

/** Edge case 13: unknown, foreign, expired and used all read the same. */
function uploadNotFoundFailure(): PublishFailure {
  return fail(404, { error: "upload_not_found", message: uploadNotFound() });
}

/**
 * The uploaded zip at `key`, through the D6 reader. Streamed from R2 to the
 * reader's temp file, counted on the way: past `uploadMaxBytes(plan)` the read
 * is abandoned (the R2 body is cancelled) — the signed `content-length` already
 * bounds it, so this only bites when the plan shrank after the URL was signed.
 */
async function readUpload(key: string, plan: Plan): Promise<RawFile[] | PublishFailure> {
  const stream = await r2Store().getStream(key);
  if (stream === null) return uploadNotFoundFailure();

  const max = uploadMaxBytes(plan);
  let size = 0;
  const counted = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.length;
        if (size > max) controller.error(new Error("upload over the plan's ceiling"));
        else controller.enqueue(chunk);
      },
    }),
  );
  try {
    return await readZipStream(counted, plan);
  } catch (error) {
    if (size > max) return fail(413, { error: "site_too_large", message: uploadTooLarge(max) });
    throw error;
  }
}

/**
 * The JSON file list's contents as bytes. `utf8` (the default) is allowed only
 * for the types `SITE_FILE_TYPES` marks `text`; every other type must be sent
 * as strict base64. An unlisted extension decodes either way and is refused by
 * `checkSet` with its own code.
 */
function decodeJsonFiles(files: FilesPublishRequest["files"]): RawFile[] | PublishFailure {
  const out: RawFile[] = [];
  for (const { path, content, encoding } of files) {
    if (encoding === "base64") {
      if (!BASE64.test(content)) {
        return invalidRequest(`${printablePath(path)}: \`content\` is not valid base64.`);
      }
      out.push({ path, bytes: new Uint8Array(Buffer.from(content, "base64")) });
      continue;
    }
    if (siteFileType(extensionOf(path))?.text === false) {
      return invalidRequest(`${printablePath(path)}: send this file with \`"encoding": "base64"\`.`);
    }
    out.push({ path, bytes: new TextEncoder().encode(content) });
  }
  return out;
}

async function readMultipartInput(copy: Response, plan: Plan): Promise<RawInput | PublishFailure> {
  let form: FormData;
  try {
    form = await copy.formData();
  } catch {
    throw new UnreadableBodyError("The multipart body could not be parsed.");
  }
  const spa = form.get("spa") === "true";
  const options = {
    turnstileToken: optionalField(form.get("turnstileToken")),
    reminderEmail: optionalField(form.get("reminderEmail")),
  };
  const archives = form.getAll("archive");
  const fileParts = form.getAll("files");
  const html = form.get("html");

  const forms = [archives.length > 0, fileParts.length > 0, html !== null].filter(Boolean).length;
  if (forms > 1) {
    return invalidRequest("Send exactly one of `html`, `files` or `archive` parts.");
  }
  if (archives.length === 0 && fileParts.length === 0) {
    return legacy({ html: html instanceof File ? await html.text() : (optionalField(html) ?? ""), ...options }, spa);
  }

  const parsedOptions = optionsSchema.safeParse(options);
  if (!parsedOptions.success) return requestError(parsedOptions.error);
  const envelope = { spa, ...parsedOptions.data };

  if (archives.length > 0) {
    const archive = archives[0];
    if (archives.length > 1 || !(archive instanceof File) || !archive.name.toLowerCase().endsWith(".zip")) {
      return invalidRequest("Send one `archive` part holding a .zip file.");
    }
    const files = await readZipStream(archive.stream(), plan);
    return isFailure(files) ? files : { files, ...envelope };
  }

  const files: RawFile[] = [];
  for (const part of fileParts) {
    if (!(part instanceof File)) {
      return invalidRequest("Every `files` part must be a file whose filename is its path.");
    }
    files.push({ path: part.name, bytes: new Uint8Array(await part.arrayBuffer()) });
  }
  return { files, ...envelope };
}
