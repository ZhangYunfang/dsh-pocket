module.exports = {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/changelog',
      { changelogFile: 'CHANGELOG.md' },
    ],
    // fork 不拥有 npm 上的 dsh-pocket 包名（属上游），只做版本、CHANGELOG 与 GitHub Release
    ['@semantic-release/npm', { npmPublish: false }],
    '@semantic-release/github',
    [
      '@semantic-release/git',
      { assets: ['CHANGELOG.md', 'package.json', 'package-lock.json'] },
    ],
  ],
}
