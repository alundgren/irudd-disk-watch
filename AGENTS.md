# GitHub Actions policy

Keep GitHub Actions release-only. Do not add CI workflows for pull requests, branch pushes, or scheduled validation. Run all tests, linting, type checks, smoke tests, GUI verification and compatibility validation in the development environment, following its desktop isolation rules. Never add, enable, trigger or rerun CI validation jobs, including in release workflows.

Remove existing CI validation steps and any jobs or workflows left empty before pushing. Release workflows may build and package artifacts, generate checksums and publish releases. Keep supporting build jobs in the release workflow and keep development validation commands available outside Actions.
