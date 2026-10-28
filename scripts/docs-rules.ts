import { type DocsRules, JOURNAL_IDS, markdownFiles } from "@wirecat/cli-base/release"

export const CHANGELOG = {
  headings: ["Added", "Changed — may break callers", "Fixed", "Security", "Removed"],
  unreleased: "Unreleased",
  ids: JOURNAL_IDS,
}

const USER_PAGES = /^(README|SECURITY|CHANGELOG)\.md$|^kit\/README\.md$|^docs\/[^/]+\.md$/

export const docsRules = (root: string): DocsRules => ({
  files: markdownFiles(root, new Set(["node_modules", "dist", "coverage", ".git"])),
  ids: JOURNAL_IDS,
  userPage: (name) => USER_PAGES.test(name.replaceAll("\\", "/")),
})
