import { defineReasons } from "@wirecat/cli-base/standards"

const ENTRIES: [reason: string, code: string, message: string][] = [
  ["mail.login-refused", "authentication_error", "the mail server refused the login"],
  ["mail.no-password", "authentication_error", "no app password is stored for this profile"],
  ["mail.oauth-refused", "authentication_error", "the mail server refused the OAuth token even after a refresh"],
  ["mail.smtp-auth-disabled", "authentication_error", "Microsoft refused the OAuth login for sending"],
  ["mail.uidvalidity-changed", "invalid_response", "the folder's UIDVALIDITY changed during the run"],
  ["mail.not-returned", "not_found", "the server did not return the email"],
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
  ["mail.smtp-login-refused", "authentication_error", "the submission server refused the login"],
  ["mail.no-drafts", "provider_unavailable", "the mailbox has no Drafts folder this tool can find"],
  ["mail.draft-unknown", "not_found", "no draft has this id in the Drafts folder"],
  ["mail.gmail-objectid", "provider_error", "Gmail announces OBJECTID, which this build cannot read"],
  ["mail.export-destination-exists", "validation_error", "the export folder already holds files"],
  ["download.exists", "validation_error", "the file to save already exists"],
  ["mail.unreadable", "invalid_response", "some emails could not be read"],
  ["mail.deletions-skipped", "outcome_unknown", "deletions on the server were not checked this run"],
  ["mail.rules-unreadable", "configuration_error", "some stored rules could not be read"],
  ["mail.export-unreadable", "outcome_unknown", "some emails could not be read for the export"],
]

/** mail's own error reasons, so an agent can tell one refusal from another by its id. */
export const REASONS = defineReasons(ENTRIES.map(([reason, code, message]) => ({ reason, code, message, details: [] })))
