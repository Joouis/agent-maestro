---
"agent-maestro": patch
---

Keep Responses reasoning replay state compact by framing the original provider ID with its UTF-8 byte length instead of Base64-encoding the entire ID and ciphertext. Preserve ciphertext unchanged and reject malformed length prefixes or split UTF-8 IDs.
