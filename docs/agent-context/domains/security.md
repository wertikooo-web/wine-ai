# Security and production

Never expose secret values, full environment files, tokens, credentials, authorization headers, or private user data.

Keep public and administrative routes separated. Validate external URLs and uploaded content at trust boundaries. Real user audio storage remains disabled unless explicit configuration and consent enable it.

Before merge or deploy, run current repository gates and required CI. Never merge code that imports an untracked or nonexistent file. Deployment, access changes, OAuth changes, and production data writes require explicit authorization.
