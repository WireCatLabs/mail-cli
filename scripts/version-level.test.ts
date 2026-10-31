import { expect, it } from "vitest"
import { nextVersion, versionLevelProblem } from "./version-level.js"

const changelog = (version: string, headings: string[], previous = "0.1.8") =>
  [`## ${version} — 26.10.2026`, ...headings.flatMap((h) => [`### ${h}`, "- x"]), `## ${previous} — 25.10.2026`].join(
    "\n",
  )

it("refuses 0.1.8 as it shipped: a patch release with changes that may break callers", () => {
  expect(versionLevelProblem(changelog("0.1.8", ["Changed — may break callers", "Fixed"], "0.1.7"))).toBe(
    "0.1.8 raises the patch version over 0.1.7, but its changelog needs a minor release",
  )
})

it.each([
  ["0.1.9", ["Fixed", "Security"]],
  ["0.2.0", ["Added", "Changed — may break callers"]],
  ["0.2.0", ["Removed"]],
  ["1.0.0", ["Changed — may break callers"]],
])("accepts %s with %j", (version, headings) => {
  expect(versionLevelProblem(changelog(version, headings))).toBeUndefined()
})

it("refuses a patch release that adds something", () => {
  expect(versionLevelProblem(changelog("0.1.9", ["Added"]))).toMatch(/needs a minor release/)
})

it("checks nothing while the top section is Unreleased", () => {
  expect(versionLevelProblem("## Unreleased\n\n### Removed\n\n- x\n\n## 0.1.8 — 25.10.2026\n")).toBeUndefined()
})

const unreleased = (headings: string[], previous = "0.1.1") =>
  ["## Unreleased", ...headings.flatMap((h) => [`### ${h}`, "- x"]), `## ${previous} — 29.10.2026`].join("\n")

it.each([
  [["Fixed"], "0.1.2", "0.1.2"],
  [["Added"], "0.1.2", "0.2.0"],
  [["Removed"], "0.1.2", "0.2.0"],
  [["Added"], "0.3.1", "0.3.1"],
])("raises the next free number for %j from %s to %s", (headings, next, expected) => {
  expect(nextVersion(unreleased(headings), next)).toBe(expected)
})

it("raises a 1.x release that may break callers to the next major", () => {
  expect(nextVersion(unreleased(["Changed — may break callers"], "1.4.2"), "1.4.3")).toBe("2.0.0")
})
