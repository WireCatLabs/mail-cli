import { CliError, isCliError } from "@wirecat/cli-base"
import { SEND_OTHERS_KEY } from "../config.js"
import { PROVIDER_NAMES } from "../discovery.js"
import { IDENTITY } from "../identity.js"

export const signInWords = (profile: string) => `${IDENTITY.command} ${profile} session start`

const run = (profile: string, words: string) => `\`${IDENTITY.command} ${profile} ${words}\``

/** The commands and flags a lower layer's reason points to; only this layer names them (WC-ARCH-16). */
const WORDS: Record<string, (message: string, profile: string, error: CliError) => string> = {
  "mail.flag-deleted": (message) => `${message}; messages delete moves it to Trash`,
  "mail.no-selection": (message) => `${message}: their msg:email/… references, or --filter <query>`,
  "mail.refs-and-filter": () => "give message references or --filter, not both",
  "mail.move-to-trash": (message) => `${message}: use messages delete, which messages restore undoes`,
  "mail.original-gone": (message, profile) => `${message}; run ${run(profile, "sync")}`,
  "mail.others-for-agent": (message, profile) =>
    `${message}; to let an agent mail others: ${IDENTITY.command} ${profile} config set permissions.${SEND_OTHERS_KEY} allow`,
  "mail.no-submission": (message, profile) => `${message} with ${run(profile, "config set")}`,
  "mail.config-unreadable": (message) => `${message}; run \`${IDENTITY.command} doctor\``,
  "mail.profile-exists": (message) => `${message}; pass --replace to overwrite it`,
  "download.exists": (message) => `${message}; pass --replace to overwrite it`,
  "mail.server-unknown": (message) =>
    `${message}; pass --provider (${PROVIDER_NAMES.join(", ")}), or --host, --port and --security yourself`,
  "mail.export-other": (message) => `${message}; resume it with the same --format and profile`,
  "mail.export-destination-exists": (message, _profile, error) =>
    error.details.resumable === true
      ? `${message}; --resume goes on with it, --replace starts over in it`
      : `${message}; --replace writes into it anyway, over files of the same name`,
}

/** A lower layer's error in the words of this CLI's commands; anything else passes through. */
export const inWords = (error: unknown, profile: string): unknown => {
  if (!isCliError(error)) return error
  const words = WORDS[String(error.details.reason)]
  return words ? new CliError(error.code, words(error.message, profile, error), error.details) : error
}

/** Runs `work`, and words what it throws for `profile`. */
export const worded = async <T>(profile: string, work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    throw inWords(error, profile)
  }
}

/** A flag's parser whose refusal names the flag. */
export const flagParser =
  <T>(flag: string, parse: (value: string) => T) =>
  (value: string): T => {
    try {
      return parse(value)
    } catch (error) {
      if (isCliError(error)) throw new CliError(error.code, `${flag}: ${error.message}`, error.details)
      throw error
    }
  }
