/** Keep raw storage errors (which may contain values) out of user-visible text. */
export class SettingsStorageError extends Error {
  constructor() {
    super("Could not save settings or site permissions. Storage may be full or unavailable. Review saved sites and unused servers in Inference Bridge Options, then retry. Some earlier changes may have been saved; check Options before retrying.");
    this.name = "SettingsStorageError";
    // In-flight inference catches `err.code` and would otherwise report this as
    // provider_error even though storage, not the model, failed.
    this.code = "unavailable";
  }
}
