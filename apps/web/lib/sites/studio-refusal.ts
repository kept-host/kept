/**
 * The typed failure every studio lib module throws — E06 task 005.
 *
 * A lib module (`./keep`, `./manage`, `./publish`, `./rename`,
 * `./account-deletion`, and the names / versions modules that follow) says WHY
 * it refused in the vocabulary the studio client switches on — a
 * `StudioErrorCode` and a sentence for the person — and nothing about HTTP.
 * `./owner-routes.ts` maps every `StudioRefusal` onto a status through ONE table
 * (`STUDIO_ERROR_STATUS`) and into the `{ error: { code, message } }` envelope.
 * So a new refusal is a `throw`, never a new branch in each route function.
 *
 * ⚠️ `message` IS SHOWN TO THE PERSON; `detail` IS FOR THE LOG. Anything that
 * names an id, a slug, a store step or a driver error goes in `detail`, which
 * `owner-routes.ts` logs server-side and never puts in a body.
 *
 * Dependency-free on purpose (only `@kept/shared`'s types): every studio lib
 * module imports it, so it must import none of them.
 */
import type { StudioErrorCode } from "@kept/shared";

export class StudioRefusal extends Error {
  constructor(
    /** The closed code the client branches on. Its HTTP status is `owner-routes.ts`'s. */
    public readonly code: StudioErrorCode,
    /** The sentence the person reads — verbatim into the envelope. */
    message: string,
    /** What went wrong, for the server log only. Never sent. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "StudioRefusal";
  }
}
