import { timezoneOf } from "@wirecat/cli-base/query"
import { type Body, environmentOf, outputFor, renderAnswer } from "@wirecat/cli-core/cli"
import type { Command } from "commander"

const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

const wallClock = (zone: string) => {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  return (iso: string) => {
    const part = Object.fromEntries(format.formatToParts(Date.parse(iso)).map(({ type, value }) => [type, value]))
    return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`
  }
}

const localised = (value: unknown, shown: (iso: string) => string, seen: { time: boolean }): unknown => {
  if (typeof value === "string" && UTC_TIME.test(value)) {
    seen.time = true
    return shown(value)
  }
  if (Array.isArray(value)) return value.map((one) => localised(one, shown, seen))
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, localised(one, shown, seen)]))
  return value
}

/**
 * Answers as `renderAnswer` does; a person reads the times of the item in the zone in use, with one line naming it
 * (WC-TIME-4). JSON, JSONL, compact rows and agents keep UTC (WC-TIME-2), and `next` is left alone: its args run.
 */
export const answerLocally = (command: Command, body: Body) => {
  const output = outputFor(command)
  if (output.format !== "pretty" || output.compact || environmentOf(command).agent)
    return renderAnswer(command, output, body)
  const zone = timezoneOf()
  const shown = wallClock(zone)
  const seen = { time: false }
  const local: Body =
    "items" in body
      ? { ...body, items: body.items.map((one) => localised(one, shown, seen)) }
      : { ...body, item: localised(body.item, shown, seen) }
  renderAnswer(command, output, local)
  if (seen.time) output.renderer.note(`times in ${zone}`)
}
