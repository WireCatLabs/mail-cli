import { type MailRule, type MailRuleMatch, ruleInput, storedMailRule } from "@wirecat/cli-core/mail"
import type { AccountKey, MessageStore } from "@wirecat/cli-core/store"

const accountKey = (address: string): AccountKey => ({ provider: "email", account: address.toLowerCase() })

// Named by its address, as memo names it, so both tools keep one row for the mailbox.
const accountIdOf = (store: MessageStore, address: string) =>
  store.accounts.saveAccount(accountKey(address), { name: address })

export const saveRule = async (store: MessageStore, address: string, rule: MailRule): Promise<MailRule> => {
  const stored = await store.mail.rules.upsert(await accountIdOf(store, address), ruleInput(rule), Date.now())
  return storedMailRule(stored) ?? rule
}

export const removeRule = async (store: MessageStore, address: string, match: MailRuleMatch): Promise<boolean> => {
  const { conditions } = ruleInput({ match, action: "skip", decided_at: new Date().toISOString() })
  return store.mail.rules.remove(await accountIdOf(store, address), conditions)
}

export const ruleCounts = async (store: MessageStore, address: string) =>
  new Map(
    (await store.mail.rules.counts(await accountIdOf(store, address))).map(({ ruleId, emails, bytes }) => [
      ruleId,
      { emails, bytes },
    ]),
  )
