# GitHub Actions policy

Keep GitHub Actions release-only. Do not add CI workflows for pull requests, branch pushes, or scheduled validation. Do not run tests, smoke tests, GUI verification, or standalone typecheck/lint jobs in Actions, including release workflows.

Release workflows may build and package artifacts, verify artifact integrity and compatibility, generate checksums, and publish releases. Keep any supporting build jobs in the release workflow. Run development checks locally or in an isolated test environment, following the applicable desktop isolation rules.
