# Agent instructions

Read `CONTRIBUTING.md` for how to run, test, and evaluate the plugin.

## Versioning

The plugin follows [Semantic Versioning](https://semver.org). The only version is `version` in
`herdr-plugin.toml`; `package.json` stays unversioned.

Every change that alters what an installed plugin does is released under a new version:

- **Patch** (`0.11.0` to `0.11.1`): a bug fix that keeps titles, config, and hooks working as before.
- **Minor** (`0.11.0` to `0.12.0`): a new feature or a visible behavior change, such as a different default
  model, prompt, or title format. While the version is `0.x`, a breaking change is also a minor bump.
- **Major** (from `1.0.0` on): a breaking change, such as a removed or renamed config key, action, or event,
  a hook contract change that needs reinstalling, or a higher `min_herdr_version` or Node.js requirement.

Changes to tests, the eval, or docs alone do not need a release.

To release:

1. Bump `version` in `herdr-plugin.toml` in the commit that makes the change. When one push carries several
   changes, bump once for the highest level among them.
2. After the commit lands on `main`, tag it with an annotated tag that summarizes the changes since the last
   release, then push the branch and the tag:

   ```sh
   git tag -a v0.12.0 -m "v0.12.0" -m "Short summary of the changes"
   git push origin main v0.12.0
   ```

3. Update the local install to that tag, and check that `source.resolved_commit` matches the tagged commit:

   ```sh
   herdr plugin install kewah/herdr-tab-titles --ref v0.12.0 --yes
   herdr plugin list --plugin tab-titles --json
   ```

Never move or delete a pushed tag. Fix a bad release with a new patch version.
