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

const raise = (from: string, level: Level) => {
  const [a = 0, b = 0, c = 0] = parse(from)
  if (level === "major") return `${a + 1}.0.0`
  return level === "minor" ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`
}

const later = (x: string, y: string) => {
  const [a, b] = [parse(x), parse(y)]
  const i = a.findIndex((n, k) => n !== b[k])
  return i === -1 || (a[i] ?? 0) > (b[i] ?? 0) ? x : y
}

const sections = (changelog: string) => {
  const [top, below] = [...changelog.matchAll(/^## (\S+).*$/gm)]
  if (!top || !below?.[1]) return undefined
  return { version: top[1], previous: below[1], section: changelog.slice(top.index, below.index) }
}

// The next free number on npm is a patch; the top section may need a minor or major over the version below it.
export const nextVersion = (changelog: string, next: string): string => {
  const parts = sections(changelog)
  if (!parts) return next
  return later(next, raise(parts.previous, needed(next, parts.section)))
}

export const versionLevelProblem = (changelog: string): string | undefined => {
  const parts = sections(changelog)
  if (!parts?.version || !/^\d+\.\d+\.\d+$/.test(parts.version)) return undefined
  const { version, previous, section } = parts
  const want = needed(version, section)
  const got = raised(previous, version)
  if (LEVELS.indexOf(got) >= LEVELS.indexOf(want)) return undefined
  return `${version} raises the ${got} version over ${previous}, but its changelog needs a ${want} release`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const changelog = readFileSync(resolve(import.meta.dirname, "../CHANGELOG.md"), "utf8")
  const [flag, next] = process.argv.slice(2)
  if (flag === "--next" && next) {
    console.log(nextVersion(changelog, next))
    process.exit(0)
  }
  const problem = versionLevelProblem(changelog)
  if (problem) {
    console.error(`${problem} (docs/dev/skills/release/SKILL.md, step 6)`)
    process.exit(1)
  }
}
