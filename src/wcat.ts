import type { ManifestIdentity } from "@wirecat/cli-base/wcat/manifest"
import { permissions } from "./config.js"
import { DESKTOP } from "./identity.js"

export const WCAT: ManifestIdentity = { ...DESKTOP, permissionOf: permissions.keyOf }
