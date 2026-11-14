### Fixed

- **`messages delete --rules` keeps mail from a sender the owner wrote to.** It judged senders from the stored mail,
  where the owner's own mail from an IMAP Sent folder looked received. So an envelope from someone the owner
  answered could be offered for Trash, and a preset rule could still catch that sender. cli-core now labels the
  owner's stored mail Sent, and the cleanup's "replied" and "sent" reasons hold for IMAP mailboxes too.
