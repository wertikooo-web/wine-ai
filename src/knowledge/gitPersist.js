'use strict';

// `railway up` replaces the running container with a fresh snapshot of the
// LOCAL machine's directory on every deploy — it does not pull from GitHub
// or from the container's own git history. So a `git commit` made only
// inside the running container is not enough: that commit lives in the
// container's ephemeral filesystem and is destroyed by the very next
// deploy, exactly like the raw file was. The only way a knowledge doc
// survives is if it reaches the GitHub remote, so this also pushes.
// Requires a GITHUB_PUSH_TOKEN env var (a GitHub PAT with repo write
// access) to be set on the Railway service — without it, the commit still
// happens locally (harmless) but the push step fails and is logged; the
// file remains vulnerable to the next deploy until that token is
// configured. Best-effort throughout: any failure here must not fail
// whatever caller triggered it — the doc is already indexed and usable now
// regardless of whether it survives the next deploy.
const { execFileSync } = require('child_process');

function commitKnowledgeFiles(repoRoot, absoluteFilePaths, commitMessage) {
    const paths = Array.isArray(absoluteFilePaths) ? absoluteFilePaths : [absoluteFilePaths];
    if (paths.length === 0) return;

    try {
        execFileSync('git', ['add', '--', ...paths], { cwd: repoRoot, stdio: 'pipe' });
        execFileSync('git', [
            '-c', 'user.name=WINE AI Knowledge Bot',
            '-c', 'user.email=knowledge-bot@wine-ai.local',
            'commit', '-m', commitMessage,
        ], { cwd: repoRoot, stdio: 'pipe' });
    } catch (error) {
        console.error('[knowledge persist] git commit failed (file was still written to disk, but will NOT survive the next deploy):', error.message);
        return;
    }

    const pushToken = process.env.GITHUB_PUSH_TOKEN;
    if (!pushToken) {
        console.error('[knowledge persist] committed locally, but GITHUB_PUSH_TOKEN is not set — this commit lives only in the current container and will be destroyed by the next deploy.');
        return;
    }
    const remoteUrl = `https://x-access-token:${pushToken}@github.com/wertikooo-web/wine-ai.git`;
    try {
        execFileSync('git', ['push', remoteUrl, 'HEAD:main'], { cwd: repoRoot, stdio: 'pipe' });
    } catch (error) {
        const redacted = String(error.message || '').split(pushToken).join('***');
        console.error('[knowledge persist] git push to GitHub failed — commit will NOT survive the next deploy:', redacted);
    }
}

module.exports = { commitKnowledgeFiles };
