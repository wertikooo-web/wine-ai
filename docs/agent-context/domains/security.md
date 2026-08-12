# Security and production

Never expose secret values, full environment files, tokens, credentials, authorization headers, or private user data.

Keep public and administrative routes separated. Validate external URLs and uploaded content at trust boundaries. Real user audio storage remains disabled unless explicit configuration and consent enable it.

Select repository gates and exercise mission autonomy according to
`../AGENT_WORKFLOW.md`. Never merge code that imports an untracked or nonexistent
file. For access, permissions, secrets, OAuth, or production-data work, apply the
approved-scope and escalation tests in that workflow; this domain document does
not create a separate authority policy.
