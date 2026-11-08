#!/usr/bin/env bash
# Generated offline installer. Raw fixed-length payloads follow the final exit.
set -eu
umask 077
export LC_ALL=C
title=@@linuxTitle@@
welcome=@@linuxWelcome@@
install_label=@@linuxInstall@@
cancel_label=@@linuxCancel@@
destination_label=@@linuxDestination@@
finish=@@linuxFinish@@
launch_label=@@linuxLaunch@@
confirm_label=@@linuxCliConfirm@@
launch_prompt=@@linuxCliLaunch@@
help_text=@@linuxHelp@@
failed=@@linuxFailed@@
corrupt=@@linuxCorrupt@@
unsafe=@@linuxUnsafe@@
root_error=@@linuxRoot@@
no_dialog=@@linuxNoDialog@@
cancelled=@@linuxCancelled@@
busy=@@linuxBusy@@
running=@@linuxRunning@@
comment=@@linuxDesktopComment@@
version=@@VERSION@@
app_size=@@APP_SIZE@@
icon_size=@@ICON_SIZE@@
app_hash=@@APP_HASH@@
icon_hash=@@ICON_HASH@@
app_offset=$((10#@@APP_OFFSET@@))
icon_offset=$((10#@@ICON_OFFSET@@))
total_size=$((10#@@TOTAL_SIZE@@))
cli=0; yes=0; ui=terminal
prefix="${XDG_DATA_HOME:-${HOME:?}/.local/share}/extalia"
data="${XDG_DATA_HOME:-${HOME}/.local/share}"
desktop="$data/applications/extalia.desktop"
die() { printf '%s\n' "$1" >&2; exit 1; }
cancel() { printf '%s\n' "$cancelled"; exit 0; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) printf '%s\n' "$help_text"; exit 0 ;;
    --cli) cli=1 ;;
    --yes) yes=1 ;;
    --prefix) [ "$#" -ge 2 ] || die "$help_text"; prefix=$2; shift ;;
    *) die "$help_text" ;;
  esac
  shift
done
[ "$EUID" -ne 0 ] || die "$root_error"
if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 | cut -d ' ' -f 1; }
else die "$failed"; fi
payload() { tail -c "+$1" -- "$0" | head -c "$2"; }
[ "$(wc -c < "$0" | tr -d ' ')" = "$total_size" ] || die "$corrupt"
[ "$(payload "$app_offset" "$app_size" | digest)" = "$app_hash" ] || die "$corrupt"
if [ "$icon_size" -gt 0 ]; then
  [ "$(payload "$icon_offset" "$icon_size" | digest)" = "$icon_hash" ] || die "$corrupt"
fi
# Reject links at every existing component, including a dangling final link.
safe_path() {
  local target=$1 part current= rest
  case "$target" in /*) ;; *) return 1 ;; esac
  case "$target" in *$'\n'*|*$'\r'*|*$'\t'*|*/../*|*/./*|*/..|*/.|*//*) return 1 ;; esac
  rest=${target#/}
  while [ -n "$rest" ]; do
    part=${rest%%/*}; current="$current/$part"
    [ ! -L "$current" ] || return 1
    [ ! -e "$current" ] || { [ -d "$current" ] || [ "$current" = "$target" ]; } || return 1
    if [ "$rest" = "$part" ]; then break; fi
    rest=${rest#*/}
  done
}
if [ "$yes" -eq 0 ]; then
  if [ "$cli" -eq 0 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    if command -v zenity >/dev/null 2>&1; then ui=zenity
    elif command -v kdialog >/dev/null 2>&1; then ui=kdialog; fi
  fi
  case "$ui" in
    zenity)
      prefix=$(zenity --entry --title="$title" --text="$destination_label" --entry-text="$prefix") || cancel
      zenity --question --no-markup --title="$title" --text="$welcome\n\n$prefix" --ok-label="$install_label" --cancel-label="$cancel_label" || cancel ;;
    kdialog)
      prefix=$(kdialog --title "$title" --inputbox "$destination_label" "$prefix") || cancel
      kdialog --title "$title" --yesno "$welcome\n\n$prefix" || cancel ;;
    terminal)
      [ -t 0 ] || die "$no_dialog"
      printf '%s\n%s\n%s %s\n' "$title" "$welcome" "$destination_label:" "$prefix"
      printf '%s ' "$confirm_label"; IFS= read -r answer || cancel
      case "$answer" in y|Y|yes|YES) ;; *) cancel ;; esac ;;
  esac
fi
safe_path "$prefix" && safe_path "$desktop" || die "$unsafe"
[ "$prefix" != / ] && [ "${prefix%/}" = "$prefix" ] || die "$unsafe"
# An app folder and its external launcher must have disjoint path components.
case "$prefix" in "$desktop"|"$desktop"/*) die "$unsafe" ;; esac
case "$desktop" in "$prefix"/*) die "$unsafe" ;; esac
manifest="$prefix/.extalia-installer"
file_digest() { digest < "$1"; }
owned_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; }
old=0
validate_existing() {
  local marker old_app old_icon old_desktop entry current_app pending_marker pending_base pending_current pending_next pending_size pending_count=0 count=0
  if [ -e "$prefix" ]; then
    [ -d "$prefix" ] && [ -O "$prefix" ] && owned_file "$manifest" || return 1
    [ "$(wc -l < "$manifest" | tr -d ' ')" = 4 ] || return 1
    { IFS= read -r marker; IFS= read -r old_app; IFS= read -r old_icon; IFS= read -r old_desktop; } < "$manifest"
    [ "$marker" = extalia-linux-installer-v1 ] || return 1
    [ "$(wc -c < "$manifest" | tr -d ' ')" -eq "$(( ${#marker} + ${#old_app} + ${#old_icon} + ${#old_desktop} + 4 ))" ] || return 1
    [[ "$old_app" =~ ^[a-f0-9]{64}$ ]] && [[ "$old_desktop" =~ ^[a-f0-9]{64}$ ]] || return 1
    [ "$old_icon" = - ] || [[ "$old_icon" =~ ^[a-f0-9]{64}$ ]] || return 1
    owned_file "$prefix/app.AppImage" || return 1
    current_app=$(file_digest "$prefix/app.AppImage")
    if [ -e "$prefix/.extalia-update" ] || [ -L "$prefix/.extalia-update" ]; then
      owned_file "$prefix/.extalia-update" || return 1
      # v2 retains the verified current image if a later download never installs.
      IFS= read -r pending_marker < "$prefix/.extalia-update"
      case "$pending_marker" in
        extalia-linux-update-v1)
          [ "$(wc -l < "$prefix/.extalia-update" | tr -d ' ')" = 3 ] || return 1
          { IFS= read -r pending_marker; IFS= read -r pending_base; IFS= read -r pending_next; } < "$prefix/.extalia-update"
          pending_current=$pending_base; pending_size=$(( ${#pending_marker} + 131 )) ;;
        extalia-linux-update-v2)
          [ "$(wc -l < "$prefix/.extalia-update" | tr -d ' ')" = 4 ] || return 1
          { IFS= read -r pending_marker; IFS= read -r pending_base; IFS= read -r pending_current; IFS= read -r pending_next; } < "$prefix/.extalia-update"
          pending_size=$(( ${#pending_marker} + 196 )) ;;
        *) return 1 ;;
      esac
      [ "$pending_base" = "$old_app" ] && [[ "$pending_current" =~ ^[a-f0-9]{64}$ ]] && [[ "$pending_next" =~ ^[a-f0-9]{64}$ ]] || return 1
      [ "$(wc -c < "$prefix/.extalia-update" | tr -d ' ')" -eq "$pending_size" ] || return 1
      local pending_mode pending_links
      if [ "$(uname -s)" = Linux ]; then pending_mode=$(stat -c '%a' -- "$prefix/.extalia-update"); pending_links=$(stat -c '%h' -- "$prefix/.extalia-update"); else pending_mode=$(stat -f '%Lp' -- "$prefix/.extalia-update"); pending_links=$(stat -f '%l' -- "$prefix/.extalia-update"); fi
      [ "$pending_mode" = 600 ] && [ "$pending_links" = 1 ] || return 1
      [ "$current_app" = "$old_app" ] || [ "$current_app" = "$pending_current" ] || [ "$current_app" = "$pending_next" ] || return 1
      pending_count=1
    else [ "$current_app" = "$old_app" ] || return 1; fi
    owned_file "$desktop" && [ "$(file_digest "$desktop")" = "$old_desktop" ] || return 1
    if [ "$old_icon" != - ]; then
      owned_file "$prefix/icon.png" && [ "$(file_digest "$prefix/icon.png")" = "$old_icon" ] || return 1
    else [ ! -e "$prefix/icon.png" ] || return 1; fi
    shopt -s nullglob dotglob
    for entry in "$prefix"/*; do
      case "${entry##*/}" in app.AppImage|.extalia-installer|.extalia-update|icon.png) ;; *) return 1 ;; esac
      count=$((count + 1))
    done
    shopt -u nullglob dotglob
    count=$((count - pending_count))
    [ "$count" -eq 2 ] || { [ "$count" -eq 3 ] && [ "$old_icon" != - ]; } || return 1
    old=1
  else [ ! -e "$desktop" ] || return 1; fi
}
validate_existing || die "$unsafe"
check_running() {
  [ "$old" -eq 1 ] && [ -d /proc ] || return 0
  # AppImage's mounted executable can differ from its original file: check both.
  for process in /proc/[0-9]*; do
    # Redirect stderr before opening procfs: permissions and process lifetime
    # can change between the readability check and the open itself.
    if [ -r "$process/environ" ] && tr '\0' '\n' 2>/dev/null < "$process/environ" | grep -Fxq "APPIMAGE=$prefix/app.AppImage"; then die "$running"; fi
    if [ "$(readlink "$process/exe" 2>/dev/null || :)" = "$prefix/app.AppImage" ]; then die "$running"; fi
  done
}
check_running
kernel=$(uname -s)
file_identity() {
  if [ "$kernel" = Linux ]; then stat -c '%d:%i' -- "$1"; else stat -f '%d:%i' -- "$1"; fi
}
move_exact() {
  local source=$1 target=$2 identity
  safe_path "$target" && [ ! -e "$target" ] && [ ! -L "$target" ] || return 1
  identity=$(file_identity "$source") || return 1
  # GNU -T prevents interpreting an unexpected directory as a container. The
  # guarded BSD fallback supports macOS shell tests and verifies the same inode.
  if [ "$kernel" = Linux ]; then mv -nT -- "$source" "$target" || return 1
  else mv -n -- "$source" "$target" || return 1; fi
  [ ! -e "$source" ] && [ ! -L "$source" ] && [ "$(file_identity "$target")" = "$identity" ]
}
stage=; previous=; desktop_stage=; desktop_previous=; lock=; installed=0; desktop_installed=0; committed=0
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ "$committed" -eq 0 ]; then
    if [ "$desktop_installed" -eq 1 ]; then rm -f -- "$desktop"; fi
    if [ -n "$desktop_previous" ] && [ -f "$desktop_previous" ]; then move_exact "$desktop_previous" "$desktop" || status=1; fi
    if [ "$installed" -eq 1 ]; then rm -rf -- "$prefix"; fi
    if [ -n "$previous" ] && [ -d "$previous" ]; then move_exact "$previous" "$prefix" || status=1; fi
  fi
  [ -z "$stage" ] || rm -rf -- "$stage"
  [ -z "$desktop_stage" ] || rm -f -- "$desktop_stage"
  [ -z "$lock" ] || rmdir -- "$lock"
  if [ "$status" -ne 0 ]; then printf '%s\n' "$failed" >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
mkdir -p -- "${prefix%/*}" "${desktop%/*}"
safe_path "$prefix" && safe_path "$desktop" || die "$unsafe"
mkdir -- "$prefix.install-lock" || die "$busy"
lock="$prefix.install-lock"
validate_existing || die "$unsafe"
stage=$(mktemp -d "${prefix%/*}/.extalia-stage.XXXXXXXX")
payload "$app_offset" "$app_size" > "$stage/app.AppImage"
[ "$(file_digest "$stage/app.AppImage")" = "$app_hash" ] || die "$corrupt"
chmod 755 "$stage/app.AppImage"
if [ "$icon_size" -gt 0 ]; then
  payload "$icon_offset" "$icon_size" > "$stage/icon.png"
  [ "$(file_digest "$stage/icon.png")" = "$icon_hash" ] || die "$corrupt"
  chmod 644 "$stage/icon.png"
fi
# Desktop Entry's string decoding precedes Exec argument decoding.
desktop_string() { local value=$1; value=${value//\\/\\\\}; printf '%s' "$value"; }
exec_string() {
  local value=$1
  value=${value//\\/\\\\}; value=${value//\"/\\\"}; value=${value//\$/\\\$}; value=${value//\`/\\\`}; value=${value//%/%%}
  desktop_string "$value"
}
desktop_stage=$(mktemp "${desktop%/*}/.extalia-desktop.XXXXXXXX")
{
  printf '[Desktop Entry]\nType=Application\nName=Extalia\nComment=%s\n' "$comment"
  printf 'Exec="%s"\n' "$(exec_string "$prefix/app.AppImage")"
  if [ "$icon_size" -gt 0 ]; then printf 'Icon=%s\n' "$(desktop_string "$prefix/icon.png")"; else printf 'Icon=extalia\n'; fi
  printf 'Terminal=false\nCategories=Development;Utility;\nX-Extalia-Installer=true\nX-Extalia-Version=%s\n' "$version"
} > "$desktop_stage"
chmod 644 "$desktop_stage"
printf 'extalia-linux-installer-v1\n%s\n%s\n%s\n' "$app_hash" "$icon_hash" "$(file_digest "$desktop_stage")" > "$stage/.extalia-installer"
safe_path "$prefix" && safe_path "$desktop" && validate_existing || die "$unsafe"
check_running
if [ "$old" -eq 1 ]; then
  previous="$stage.previous"; move_exact "$prefix" "$previous"
  desktop_previous="$desktop_stage.previous"; move_exact "$desktop" "$desktop_previous"
fi
move_exact "$stage" "$prefix"; installed=1; stage=
move_exact "$desktop_stage" "$desktop"; desktop_installed=1; desktop_stage=
safe_path "$prefix" && safe_path "$desktop" && validate_existing || die "$unsafe"
committed=1
[ -z "$previous" ] || rm -rf -- "$previous"
[ -z "$desktop_previous" ] || rm -f -- "$desktop_previous"
printf '%s\n' "$finish"
launch=0
if [ "$yes" -eq 0 ]; then
  case "$ui" in
    zenity)
      selection=$(zenity --list --checklist --hide-header --title="$title" --text="$finish" --column=Select --column=Action FALSE "$launch_label") || selection=
      [ "$selection" != "$launch_label" ] || launch=1 ;;
    kdialog)
      selection=$(kdialog --title "$title" --separate-output --checklist "$finish" launch "$launch_label" off) || selection=
      [ "$selection" != launch ] || launch=1 ;;
    terminal)
      printf '%s ' "$launch_prompt"; IFS= read -r answer || answer=
      case "$answer" in y|Y|yes|YES) launch=1 ;; esac ;;
  esac
fi
if [ "$launch" -eq 1 ] && [ "$EUID" -ne 0 ]; then
  safe_path "$prefix/app.AppImage" && owned_file "$prefix/app.AppImage" || die "$unsafe"
  [ "$(file_digest "$prefix/app.AppImage")" = "$app_hash" ] || die "$corrupt"
  "$prefix/app.AppImage" >/dev/null 2>&1 &
fi
exit 0
