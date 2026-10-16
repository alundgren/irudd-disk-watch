#!/usr/bin/env bash
# Runs the Linux cleanup fixtures on a disposable Linux machine over SSH.
#
#   scripts/linux-delete-fixtures.sh SSH_DESTINATION
#
# The remote account needs passwordless sudo, cargo (on PATH or in ~/.cargo/bin), python3,
# mkfs.ext4 and chattr. Work happens in ~/$DW_FIXTURE_DIR on the remote machine (default
# dw-scratch/linux-delete-fixtures; it must stay below dw-scratch/). The scanner crate is
# copied there, tested with cargo, and built; the fixture worker uses its own state directory
# there, never the installed worker's state. sudo is used only for the loop-mounted ext4
# image, mounts inside it, chattr flags and the throwaway dwtest user and dwtestshare group,
# all removed afterwards.
set -euo pipefail

destination=${1:?usage: scripts/linux-delete-fixtures.sh SSH_DESTINATION}
remote_dir=${DW_FIXTURE_DIR:-dw-scratch/linux-delete-fixtures}
# rsync --delete and the cleanup step remove files here, so only accept a plain path below
# dw-scratch/ made of simple names. A name may not start with a dot, which rules out . and ..
if ! [[ $remote_dir =~ ^dw-scratch(/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$ ]]; then
  echo "DW_FIXTURE_DIR must look like dw-scratch/NAME[/NAME...] using letters, digits, '.', '_' and '-'" >&2
  exit 2
fi
repo=$(cd "$(dirname "$0")/.." && pwd)

# A marker file shows the directory belongs to this harness. An existing directory without
# it is refused, so a mistyped path cannot point the deletes at other files.
ssh "$destination" bash -s -- "$remote_dir" <<'PREPARE'
set -euo pipefail
dir=~/"$1"
if [ -e "$dir" ] && [ ! -f "$dir/.dw-fixture-scratch" ]; then
  if [ -n "$(ls -A "$dir")" ]; then
    echo "Refusing to use $dir: it exists and was not created by this harness" >&2
    exit 2
  fi
fi
mkdir -p "$dir"
touch "$dir/.dw-fixture-scratch"
PREPARE
rsync -a --delete --exclude target "$repo/scanner/" "$destination:$remote_dir/scanner/"
rsync -a "$repo/scripts/linux-delete-fixtures.py" "$destination:$remote_dir/fixtures.py"

# The remote trap removes mounts, the image and test accounts even if the driver is killed.
ssh "$destination" bash -s -- "$remote_dir" <<'REMOTE'
set -euo pipefail
cd ~/"$1"
scratch=$(pwd)
export PATH="$HOME/.cargo/bin:$PATH"
sudo -n true
trap 'python3 -I fixtures.py --cleanup "$scratch"' EXIT
(cd scanner && cargo test --release 2>&1 | grep -E '^test result|FAILED|panicked' && test "${PIPESTATUS[0]}" -eq 0)
(cd scanner && cargo build --release --quiet)
python3 -I fixtures.py "$scratch/scanner/target/release/dw-scan" "$scratch"
REMOTE
