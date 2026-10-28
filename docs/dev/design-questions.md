# Further design questions

Ask these only when the reference CLI does not already answer them, after the seven questions of the
[design interview](skills/design-interview/SKILL.md). Write each answer into [DESIGN.md](DESIGN.md).

## Storing, indexing, syncing and deleting

1. Which of the service's records are kept locally, and which core entity does each become (people, events,
   documents, files, messages, meetings)? (WC-DATA-1, WC-DATA-2)
2. How does it sync: everything each time, from a cursor, or by change token? On demand, on a schedule, or kept
   running?
3. When the service deletes something, what happens here? Proposed: mark it deleted, keep it, never wipe. (WC-DATA-7)
4. Can the person delete local data themselves, and how much: one record, one account, everything?

## Search

1. What should a search find: titles only, the full text, names of people?
2. Should `search all` and `memo context <person>` show its records?
3. What must work without a network?

## Security

1. Where are the secrets kept? Proposed: the system keyring. (WC-SECR)
2. Which writes need a permission, and which are never allowed whatever the permissions? (WC-PERM)
