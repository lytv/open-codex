Copy-Item -Recurse -Force "\\wsl$\Ubuntu\home\lyvtruong\.codex" "D:\saas\open-codex\.codex"

Copy-Item -Recurse -Force "D:\saas\open-codex\.codex\config.json" "\\wsl$\Ubuntu\home\lyvtruong\.codex"

rm -rf ~/.codex/backup