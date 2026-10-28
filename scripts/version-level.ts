import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const LEVELS = ["patch", "minor", "major"] as const
type Level = (typeof LEVELS)[number]

const parse = (version: string) => version.split(".").map(Number)

const raised = (from: string, to: string): Level => {
  const [a = 0, b = 0] = parse(from)
  const [x = 0, y = 0] = parse(to)
  if (x !== a) return "major"
  return y !== b ? "minor" : "patch"
}

// Before 1.0.0 the minor carries what a major would; a fix-only release is the only patch.
const needed = (version: string, section: string): Level => {
  const breaks = /^### (Changed — may break callers|Removed)$/m.test(section)
  if (breaks) return (parse(version)[0] ?? 0) >= 1 ? "major" : "minor"
  return /^### Added$/m.test(section) ? "minor" : "patch"
}

export const versionLevelProblem = (changelog: string): string | undefined => {
  const headings = [...changelog.matchAll(/^## (\S+).*$/gm)]
  const [top, below] = headings
  const version = top?.[1]
  const previous = below?.[1]
  if (!top || !below || !version || !previous || !/^\d+\.\d+\.\d+$/.test(version)) return undefined
  const section = changelog.slice(top.index, below.index)
  const want = needed(version, section)
  const got = raised(previous, version)
  if (LEVELS.indexOf(got) >= LEVELS.indexOf(want)) return undefined
  return `${version} raises the ${got} version over ${previous}, but its changelog needs a ${want} release`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problem = versionLevelProblem(readFileSync(resolve(import.meta.dirname, "../CHANGELOG.md"), "utf8"))
  if (problem) {
    console.error(`${problem} (docs/dev/skills/release/SKILL.md, step 6)`)
    process.exit(1)
  }
}
