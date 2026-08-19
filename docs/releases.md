# Releases

Sandlot publishes stable versions as immutable GitHub Releases. A stable installation is always pinned to an exact reviewed tag such as `v0.2.0`; Sandlot does not publish the unrelated `sandlot` package on npmjs.org.

## Release contract

Release versions use exact `MAJOR.MINOR.PATCH` syntax. A version PR must update all of these reviewed sources together:

- `package.json` (`version`);
- `package-lock.json` (the top-level `version` and `packages[""].version`);
- `CHANGELOG.md` (one dated, nonempty `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD` section).

Before `1.0.0`, apply SemVer conservatively: increment the minor version for any backward-incompatible change to behavior, policy, configuration, requirements, or the supported security boundary. Use a patch increment only for backward-compatible fixes and documentation. Never reuse a released version to avoid an increment.

The release ref must also contain the clean generated `dist` tree. Pi 0.84.2 clones Git sources and runs `npm install --omit=dev`; it does not run a TypeScript release build. Pi supplies its extension APIs through its loader, so it remains a host prerequisite and development dependency rather than an install-time dependency. The package manifest declares `dist/index.js`, and Sandlot activates automatically in every new trusted Pi session without an `-e` flag or manual import.

The manual release workflow accepts only a version merged into `main`. Its read-only macOS job validates the version sources, runs the complete `npm run release:verify` gate, proves the generated tree is clean, and builds the tarball and checksum. A separate job receives only that verified handoff, rechecks remote state with `contents: write`, atomically claims the version tag at the verified commit, creates and fills a draft, publishes it, and requires GitHub to report the resulting release as immutable. The write-authorized job neither checks out nor executes repository code.

The supported release boundary is macOS x64 and arm64. Linux/Bubblewrap release verification remains deferred and Windows is unsupported.

## One-time repository setup

Before the first release, a maintainer with repository Administration authority must enable immutable releases. The normal workflow token intentionally does not have this permission:

```bash
gh api --method PUT -H "X-GitHub-Api-Version: 2026-03-10" repos/Liquescent-Development/sandlot/immutable-releases
gh api -H "X-GitHub-Api-Version: 2026-03-10" repos/Liquescent-Development/sandlot/immutable-releases --jq '.enabled'
```

The second command must print `true`. Do not dispatch a release until it does.

## Publish a stable version

1. Open a version PR containing only the intended release changes, the synchronized version fields above, curated changelog notes, and the clean generated `dist` tree. Run the full [development verification](development.md#verification), and require review and green macOS CI.
2. Merge the PR and require the `main` Security integration run to pass at the exact merge commit.
3. Confirm immutable releases are still enabled with the setup check above.
4. Dispatch the workflow from `main`, substituting the reviewed version without a leading `v`:

   ```bash
   gh workflow run release.yml --repo Liquescent-Development/sandlot --ref main -f version=0.2.0
   ```

5. Resolve the new run and watch both `verify` and `publish` to completion:

   ```bash
   gh run list --repo Liquescent-Development/sandlot --workflow release.yml --limit 5
   gh run watch RUN_ID --repo Liquescent-Development/sandlot --exit-status
   ```

The workflow refuses to move a tag, replace a release, overwrite assets, or continue from ambiguous remote state. `vX.Y.Z` is never moved.

## Failure recovery

A verification-job failure creates no tag or release. Correct the source in a new reviewed PR; do not change the merged release commit in place.

A publication failure may leave the atomically claimed tag, a draft, or both. The workflow reports its release ID and intended tag, deliberately leaves remote state for inspection, and will not delete, move, or overwrite it. Before any retry, inspect the failed run and all matching remote state:

```bash
gh run view RUN_ID --repo Liquescent-Development/sandlot --log-failed
gh api -H "X-GitHub-Api-Version: 2026-03-10" --paginate repos/Liquescent-Development/sandlot/releases --jq '.[] | select(.tag_name == "v0.2.0") | {id,tag_name,draft,immutable,assets:[.assets[].name]}'
gh api -H "X-GitHub-Api-Version: 2026-03-10" repos/Liquescent-Development/sandlot/git/ref/tags/v0.2.0
```

A missing tag returns `404`. If the tag exists, its object SHA must equal the exact verified green `main` commit; a different SHA is a collision and must not be changed by this recovery process. If a draft exists, compare its recorded ID, target, notes, and assets with the verified run.

Only when no published release exists for the tag, the recorded release is still a draft, and the claimed tag points to the verified commit may a maintainer deliberately remove the orphaned pre-publication state. Delete the confirmed draft first, if present, then delete only the confirmed orphan tag:

```bash
gh api --method DELETE -H "X-GitHub-Api-Version: 2026-03-10" repos/Liquescent-Development/sandlot/releases/RELEASE_ID
gh api --method DELETE -H "X-GitHub-Api-Version: 2026-03-10" repos/Liquescent-Development/sandlot/git/refs/tags/v0.2.0
```

Omit the draft deletion command when no draft was created. Never move any tag. Never delete a published release or its tag; published immutable tags remain permanent release identities. Never retry blindly when a published release exists or when remote state differs from the failed run. If publication succeeded but the final immutable assertion failed, stop and investigate the repository setting and returned release state rather than modifying remote state.

## Verify a published release

Require the release to be public, non-prerelease, immutable, and targeted at the green `main` commit:

```bash
gh api -H "X-GitHub-Api-Version: 2026-03-10" repos/Liquescent-Development/sandlot/releases/tags/v0.2.0 --jq '{tag_name,target_commitish,draft,prerelease,immutable,assets:[.assets[]|{name,state,size,digest}]}'
gh api -H "X-GitHub-Api-Version: 2026-03-10" repos/Liquescent-Development/sandlot/git/ref/tags/v0.2.0 --jq '.object.sha'
gh release verify v0.2.0 --repo Liquescent-Development/sandlot
```

Download the two assets to a new empty directory and verify the checksum:

```bash
gh release download v0.2.0 --repo Liquescent-Development/sandlot --pattern 'sandlot-0.2.0.tgz*' --dir ./sandlot-release-check
cd ./sandlot-release-check
shasum -a 256 -c sandlot-0.2.0.tgz.sha256
gh release verify-asset v0.2.0 sandlot-0.2.0.tgz --repo Liquescent-Development/sandlot
gh release verify-asset v0.2.0 sandlot-0.2.0.tgz.sha256 --repo Liquescent-Development/sandlot
```

An immutable release automatically carries GitHub's release attestation. `gh release verify` verifies the immutable release, and `gh release verify-asset` cryptographically verifies each downloaded asset against that attestation. The release notes must exactly match the curated `CHANGELOG.md` section for that version. Both assets must report `state: uploaded`; their names, sizes, and exact GitHub `sha256:` digests must agree with the downloaded files.

## Install or update

Install a reviewed stable tag explicitly:

```bash
pi install git:github.com/Liquescent-Development/sandlot@v0.2.0
pi list
```

Pi records the pinned source in `~/.pi/agent/settings.json`. A pinned installation does not advance merely because a newer release exists: update only after reviewing the newer release, by explicitly installing its exact tag, for example:

```bash
pi install git:github.com/Liquescent-Development/sandlot@v0.2.0
```

Use `pi update --extensions` only for intentionally unpinned development sources; it does not change the reviewed tag named above.
