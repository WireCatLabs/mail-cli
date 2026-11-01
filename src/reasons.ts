import { defineReasons } from "@wirecat/cli-base/standards"

const ENTRIES: [reason: string, code: string, message: string][] = [
  ["mail.login-refused", "authentication_error", "the mail server refused the login"],
  ["mail.no-password", "authentication_error", "no app password is stored for this profile"],
  ["mail.oauth-refused", "authentication_error", "the mail server refused the OAuth token even after a refresh"],
  ["mail.smtp-auth-disabled", "authentication_error", "Microsoft refused the OAuth login for sending"],
  ["mail.oauth-no-client", "configuration_error", "no Microsoft app id is set up for OAuth sign-in"],
  ["mail.uidvalidity-changed", "invalid_response", "the folder's UIDVALIDITY changed during the run"],
  ["mail.not-returned", "not_found", "the server did not return the email"],
  ["mail.search-refused", "provider_error", "the mail server refused to search a folder"],
  ["mail.rules-file-invalid", "validation_error", "the rules file is not one rules export writes"],
  ["mail.filters-file-invalid", "validation_error", "the file is not a Gmail Takeout Filters.json"],
  ["mail.rule-not-found", "not_found", "no rule has exactly these conditions"],
  ["mail.no-trash", "provider_unavailable", "the mailbox has no Trash folder this tool can find"],
  ["mail.no-all-mail", "provider_unavailable", "Gmail's All Mail folder is not listed"],
  ["mail.no-uidplus", "provider_unavailable", "the server cannot expunge single messages"],
  ["mail.copy-not-undoable", "provider_unavailable", "the server gave no UIDs for the copies"],
  ["mail.folder-not-empty", "validation_error", "the folder still holds mail"],
  ["mail.run-unknown", "not_found", "no change run has this id for this mailbox"],
  ["mail.archive-unverified", "validation_error", "no store backup under 8 days old is recorded"],
  ["mail.cleanup-scheduled", "permission_error", "messages delete --rules does not run from a schedule"],
]

/** mail's own error reasons, so an agent can tell one refusal from another by its id. */
export const REASONS = defineReasons(ENTRIES.map(([reason, code, message]) => ({ reason, code, message, details: [] })))
